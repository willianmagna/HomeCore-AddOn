// Listener mDNS contínuo: decripta TXT records dos devices incluídos e dispara updates.
// Subscribers (SSE clients, MQTT bridge) recebem state em tempo real.
const { Bonjour } = require('bonjour-service');
const sonoffCrypto = require('./crypto');
const scanner = require('./scanner');
const storage = require('./storage');

class StateBus {
  constructor() {
    this.states = new Map();    // deviceid -> { ip, seq, state, is_on, ts, optimistic }
    this.subscribers = new Set();
    this.bonjour = null;
    this.browser = null;
  }

  start() {
    this.bonjour = new Bonjour();
    this.browser = this.bonjour.find({ type: 'ewelink', protocol: 'tcp' });
    const handler = (svc) => this._handle(svc);
    this.browser.on('up', handler);
    this.browser.on('update', handler);
  }

  async stop() {
    try { this.browser?.stop(); } catch {}
    try { this.bonjour?.destroy(); } catch {}
  }

  _decryptTxt(props, devicekey) {
    const raw = ['data1', 'data2', 'data3', 'data4'].map((k) => props[k] || '').join('');
    if (!raw || !props.iv || props.encrypt !== 'true') return null;
    try { return sonoffCrypto.decrypt(raw, props.iv, devicekey); }
    catch { return null; }
  }

  _isOn(state) {
    if (!state) return null;
    if (typeof state.switch === 'string') return state.switch === 'on';
    if (Array.isArray(state.switches) && state.switches.length) {
      return state.switches[0].switch === 'on';
    }
    return null;
  }

  _handle(svc) {
    const deviceid = scanner.extractDeviceid(svc.fqdn || svc.name);
    if (!deviceid) return;
    const dev = storage.getDevice(deviceid);
    if (!dev) return;
    const props = {};
    for (const [k, v] of Object.entries(svc.txt || {})) {
      props[k] = typeof v === 'string' ? v : (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
    }
    const decoded = this._decryptTxt(props, dev.devicekey);
    const ip = (svc.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || dev.ip;
    const update = {
      deviceid, ip, seq: props.seq || null,
      state: decoded, is_on: this._isOn(decoded),
      ts: Date.now() / 1000,
    };
    this.states.set(deviceid, update);
    if (ip && ip !== dev.ip) storage.updateIp(deviceid, ip);
    this._broadcast(update);
  }

  _broadcast(update) {
    for (const sub of this.subscribers) {
      try { sub(update); } catch {}
    }
  }

  subscribe(handler) {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  get(deviceid) {
    return this.states.get(deviceid) || null;
  }

  /**
   * Optimistic update após confirmação do AES POST. mDNS posterior reconcilia.
   */
  injectOptimistic(deviceid, isOn) {
    const prev = this.states.get(deviceid) || {};
    const fullPrev = prev.state || {};
    const full = { ...fullPrev };
    if (Array.isArray(full.switches) && full.switches.length) {
      full.switches = full.switches.map((s, i) =>
        i === 0 ? { ...s, switch: isOn ? 'on' : 'off' } : s
      );
    } else {
      full.switch = isOn ? 'on' : 'off';
    }
    const update = {
      deviceid,
      ip: prev.ip,
      seq: prev.seq,
      state: full,
      is_on: isOn,
      ts: Date.now() / 1000,
      optimistic: true,
    };
    this.states.set(deviceid, update);
    this._broadcast(update);
  }

  /**
   * Espera o seq mDNS avançar (usado pra detecção de cmd_format na inclusão).
   */
  waitForSeqChange(deviceid, baselineSeq, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const cur = this.states.get(deviceid)?.seq;
        if (cur && cur !== baselineSeq) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 150);
      };
      tick();
    });
  }
}

const bus = new StateBus();
module.exports = bus;

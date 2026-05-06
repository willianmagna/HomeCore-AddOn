// State bus do Tuya. Mantém um TuyaLanClient persistente por device incluído,
// recebe os pushes de DPs e dispara updates pra subscribers (MQTT bridge / SSE).
const { TuyaLanClient } = require('./lan');
const storage = require('./storage');
const udp = require('./udp-discover');

const PRIVATE_IP_RX = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/;
function isPrivateIp(ip) { return !!ip && PRIVATE_IP_RX.test(ip); }

class TuyaStateBus {
  constructor() {
    this.states = new Map();         // deviceid -> { ip, dps, last_seen, online, optimistic }
    this.subscribers = new Set();
    this.clients = new Map();        // deviceid -> TuyaLanClient
    this._unsubUdp = null;
  }

  start() {
    udp.start();
    this._unsubUdp = udp.subscribe((evt) => this._onUdpAnnounce(evt));
    for (const dev of storage.listDevices()) this.connectDevice(dev);
  }

  async stop() {
    try { this._unsubUdp?.(); } catch {}
    udp.stop();
    for (const c of this.clients.values()) {
      try { c.disconnect(); } catch {}
    }
    this.clients.clear();
  }

  /** Recebe anúncio UDP — atualiza IP/protocolo e (re)conecta se necessário. */
  _onUdpAnnounce(evt) {
    const dev = storage.getDevice(evt.deviceid);
    if (!dev) return; // não é um device incluído
    let updatedFields = false;
    if (dev.ip !== evt.ip) {
      storage.updateIp(evt.deviceid, evt.ip);
      updatedFields = true;
    }
    if (evt.version && dev.protocol !== evt.version) {
      // upsert preservando todos os outros campos
      storage.upsertDevice({
        deviceid: dev.deviceid,
        local_key: dev.local_key,
        protocol: evt.version,
      });
      updatedFields = true;
    }
    const existing = this.clients.get(evt.deviceid);
    const needsReconnect = !existing || existing.ip !== evt.ip || existing.protocolVersion !== (evt.version || dev.protocol);
    if (existing && needsReconnect) {
      existing.disconnect();
      this.clients.delete(evt.deviceid);
    }
    if (!this.clients.has(evt.deviceid)) {
      const fresh = storage.getDevice(evt.deviceid);
      this.connectDevice(fresh);
    }
  }

  connectDevice(dev) {
    if (!dev || !dev.deviceid || !dev.local_key) return;
    if (!isPrivateIp(dev.ip)) return;     // espera UDP descobrir LAN IP
    if (this.clients.has(dev.deviceid)) return;
    const client = new TuyaLanClient({
      ip: dev.ip,
      port: 6668,
      deviceid: dev.deviceid,
      localKey: dev.local_key,
      protocolVersion: dev.protocol || '3.3',
      onStatus: (json) => this._handleStatus(dev.deviceid, json),
      onConnected: () => this._handleConnect(dev.deviceid, client),
      onDisconnected: () => this._handleDisconnect(dev.deviceid),
    });
    this.clients.set(dev.deviceid, client);
    client.connect().catch(() => {});
  }

  disconnectDevice(deviceid) {
    const c = this.clients.get(deviceid);
    if (c) { try { c.disconnect(); } catch {} ; this.clients.delete(deviceid); }
    this.states.delete(deviceid);
  }

  _handleConnect(deviceid, client) {
    // Pede estado inicial
    client.queryState().then((json) => {
      if (json) this._handleStatus(deviceid, json);
    }).catch(() => {});
    this._broadcast({ deviceid, event: 'online' });
  }

  _handleDisconnect(deviceid) {
    const prev = this.states.get(deviceid) || {};
    this.states.set(deviceid, { ...prev, online: false, ts: Date.now() / 1000 });
    this._broadcast({ deviceid, event: 'offline' });
  }

  _handleStatus(deviceid, json) {
    // v3.3 push: {dps: {...}}
    // v3.4 push: {data: {dps: {...}}, protocol: 5/15, t}
    const dps = (json && json.dps) || (json && json.data && json.data.dps) || {};
    if (Object.keys(dps).length) {
      console.log(`[tuya] ← ${deviceid} STATUS ${JSON.stringify(dps)}`);
    }
    const prev = this.states.get(deviceid) || {};
    const merged = {
      deviceid,
      ip: prev.ip || (storage.getDevice(deviceid)?.ip),
      dps: { ...(prev.dps || {}), ...dps },
      online: true,
      ts: Date.now() / 1000,
    };
    this.states.set(deviceid, merged);
    this._broadcast(merged);
  }

  /** Optimistic update após confirmação de comando (mesmo padrão Sonoff). */
  injectOptimistic(deviceid, dps) {
    const prev = this.states.get(deviceid) || {};
    const merged = {
      deviceid,
      ip: prev.ip,
      dps: { ...(prev.dps || {}), ...dps },
      online: true,
      ts: Date.now() / 1000,
      optimistic: true,
    };
    this.states.set(deviceid, merged);
    this._broadcast(merged);
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

  get(deviceid) { return this.states.get(deviceid) || null; }
  getClient(deviceid) { return this.clients.get(deviceid) || null; }
}

const bus = new TuyaStateBus();
module.exports = bus;

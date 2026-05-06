// Coordenador do subsistema Sonoff Wi-Fi: inicializa storage, state-bus e bridge MQTT.
// Expõe uma API plana usada pelo server.js pra montar rotas.
const ewelink = require('./ewelink');
const lan = require('./lan');
const scanner = require('./scanner');
const storage = require('./storage');
const bus = require('./state-bus');
const bridge = require('./mqtt-bridge');

const identifyTasks = new Map(); // deviceid -> { stop: () => void }

function init() {
  storage.init();
  bus.start();
  bridge.start(async (deviceid, payload) => {
    const state = (payload?.state || '').toLowerCase();
    if (state !== 'on' && state !== 'off') return;
    try { await sendSwitch(deviceid, state); } catch {}
  });
}

async function sendSwitch(deviceid, state, channel = 0) {
  const dev = storage.getDevice(deviceid);
  if (!dev) throw Object.assign(new Error('device não incluído'), { status: 404 });
  if (!dev.ip) throw Object.assign(new Error('IP desconhecido — rode uma busca'), { status: 409 });
  const fmt = dev.cmd_format || 'switches';
  const params = fmt === 'switch'
    ? { switch: state }
    : { switches: [{ outlet: channel, switch: state }] };
  const cmd = fmt === 'switch' ? 'switch' : 'switches';
  const result = await lan.sendCommand({
    ip: dev.ip, deviceid: dev.deviceid, devicekey: dev.devicekey, cmd, params,
  });
  // Optimistic update
  bus.injectOptimistic(deviceid, state === 'on');
  return result;
}

async function detectCmdFormat(deviceid, ip, devicekey) {
  // Aguarda ate 5s pra ver um seq via mDNS
  let seenSeq = null;
  for (let i = 0; i < 20; i++) {
    const st = bus.get(deviceid);
    if (st?.seq && st.state) { seenSeq = st.seq; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!seenSeq) return 'switches';

  const isOn = bus.get(deviceid)?.is_on;
  const stateStr = isOn ? 'on' : 'off';

  // Tenta switches primeiro
  let baseline = bus.get(deviceid)?.seq;
  try {
    await lan.sendCommand({
      ip, deviceid, devicekey, cmd: 'switches',
      params: { switches: [{ outlet: 0, switch: stateStr }] },
    });
    if (await bus.waitForSeqChange(deviceid, baseline)) return 'switches';
  } catch {}

  baseline = bus.get(deviceid)?.seq;
  try {
    await lan.sendCommand({ ip, deviceid, devicekey, cmd: 'switch', params: { switch: stateStr } });
    if (await bus.waitForSeqChange(deviceid, baseline)) return 'switch';
  } catch {}

  return 'switches';
}

async function include({ email, password, region = 'us', countryCode = '+55', devices }) {
  if (!devices || !devices.length) {
    throw Object.assign(new Error('nada selecionado'), { status: 400 });
  }
  let allDevices;
  try {
    allDevices = await ewelink.fetchDevices({ email, password, region, countryCode });
  } catch (e) {
    throw Object.assign(new Error(`eWeLink: ${e.message}`), { status: 401 });
  }
  const saved = [];
  const missing = [];
  const unmatchedIps = [];
  const usedIds = new Set();

  // Pass 1: deviceids vindos do mDNS
  for (const incoming of devices) {
    if (!incoming.deviceid) continue;
    const info = allDevices[incoming.deviceid];
    if (!info) { missing.push(incoming.deviceid); continue; }
    storage.upsertDevice({
      deviceid: incoming.deviceid, vendor: 'sonoff',
      devicekey: info.devicekey, name: info.name,
      model: info.model ? String(info.model) : null,
      ip: incoming.ip || null, mac: incoming.mac || null,
    });
    usedIds.add(incoming.deviceid);
    saved.push({ deviceid: incoming.deviceid, name: info.name, ip: incoming.ip, matched_by: 'mdns' });
  }

  // Pass 2: probe-match dos que não tinham deviceid
  const noId = devices.filter((d) => !d.deviceid && d.ip);
  for (const incoming of noId) {
    let matched = null;
    for (const [did, info] of Object.entries(allDevices)) {
      if (usedIds.has(did)) continue;
      if (await lan.probeMatch(incoming.ip, did, info.devicekey)) {
        matched = [did, info]; break;
      }
    }
    if (!matched) { unmatchedIps.push(incoming.ip); continue; }
    const [did, info] = matched;
    storage.upsertDevice({
      deviceid: did, vendor: 'sonoff',
      devicekey: info.devicekey, name: info.name,
      model: info.model ? String(info.model) : null,
      ip: incoming.ip, mac: incoming.mac || null,
    });
    usedIds.add(did);
    saved.push({ deviceid: did, name: info.name, ip: incoming.ip, matched_by: 'probe' });
  }

  // Auto-detect cmd_format pra cada incluído (best-effort)
  for (const s of saved) {
    const dev = storage.getDevice(s.deviceid);
    if (!dev?.ip) continue;
    try {
      const fmt = await detectCmdFormat(s.deviceid, dev.ip, dev.devicekey);
      storage.updateCmdFormat(s.deviceid, fmt);
      s.cmd_format = fmt;
    } catch { s.cmd_format = 'switches'; }
  }

  return { saved, missing, unmatched_ips: unmatchedIps };
}

function startIdentify(deviceid, intervalMs = 1200) {
  if (identifyTasks.has(deviceid)) return false;
  let stopped = false;
  let state = 'on';
  const loop = async () => {
    while (!stopped) {
      try { await sendSwitch(deviceid, state); } catch {}
      await new Promise((r) => setTimeout(r, intervalMs));
      state = state === 'on' ? 'off' : 'on';
    }
  };
  loop();
  identifyTasks.set(deviceid, { stop: () => { stopped = true; } });
  return true;
}

function stopIdentify(deviceid) {
  const t = identifyTasks.get(deviceid);
  if (t) { t.stop(); identifyTasks.delete(deviceid); return true; }
  return false;
}

function isIdentifying(deviceid) { return identifyTasks.has(deviceid); }

function listDevicesWithLive() {
  return storage.listDevices().map((r) => {
    const { devicekey, ...safe } = r;
    safe.mqtt_active = !!r.mqtt_active;
    const live = bus.get(r.deviceid);
    if (live) {
      safe.is_on = live.is_on;
      safe.seq = live.seq;
      safe.last_seen_ts = live.ts;
    }
    return safe;
  });
}

module.exports = {
  init,
  scanner, storage, bus, bridge, lan, ewelink,
  sendSwitch,
  include,
  startIdentify, stopIdentify, isIdentifying,
  listDevicesWithLive,
};

// Coordenador do subsistema Tuya. Inicializa storage, state-bus (TCP clients persistentes)
// e bridge MQTT. Expõe API plana usada pelas rotas.
const storage = require('./storage');
const bus = require('./state-bus');
const bridge = require('./mqtt-bridge');

function init() {
  storage.init();
  bus.start();
  bridge.start(async (deviceid, payload) => {
    // payload pode vir do HA como {state: "on"|"off"} (mais simples) ou {dp:N, value:V}
    const dev = storage.getDevice(deviceid);
    if (!dev) return;
    if (typeof payload?.state === 'string') {
      const isOn = payload.state.toLowerCase() === 'on' || payload.state === 'true';
      await sendDP(deviceid, 1, isOn);
      return;
    }
    if (payload?.dp !== undefined && payload?.value !== undefined) {
      await sendDP(deviceid, payload.dp, payload.value);
      return;
    }
    if (payload?.dps && typeof payload.dps === 'object') {
      await sendDPs(deviceid, payload.dps);
    }
  });
}

async function sendDP(deviceid, dp, value) {
  return sendDPs(deviceid, { [dp]: value });
}

async function sendDPs(deviceid, dps) {
  const client = bus.getClient(deviceid);
  if (!client || !client.connected) {
    throw Object.assign(new Error('device offline'), { status: 503 });
  }
  console.log(`[tuya] → ${deviceid} DPs ${JSON.stringify(dps)} (v${client.protocolVersion})`);
  await client.setDPs(dps);
  bus.injectOptimistic(deviceid, dps);
  return { ok: true };
}

function listDevicesWithLive() {
  return storage.listDevices().map((r) => {
    const { local_key, ...safe } = r;
    safe.mqtt_active = !!r.mqtt_active;
    safe.channels_config = r.channels_config ? safeParse(r.channels_config, {}) : {};
    const live = bus.get(r.deviceid);
    if (live) {
      safe.dps = live.dps;
      safe.online = live.online;
      safe.last_seen_ts = live.ts;
    }
    return safe;
  });
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Inclui devices a partir de um payload trazido pela camada cloud (a ser implementada).
 * Cada device deve vir como: { deviceid, local_key, ip, name, product_id, category }.
 * Conecta o TCP client logo após o upsert.
 */
function includeDevicesFromCloud(devices) {
  const saved = [];
  for (const d of devices) {
    if (!d.deviceid || !d.local_key) continue;
    storage.upsertDevice(d);
    const dev = storage.getDevice(d.deviceid);
    bus.connectDevice(dev);
    saved.push({ deviceid: d.deviceid, name: d.name, ip: d.ip });
  }
  return saved;
}

function removeDevice(deviceid) {
  // Para qualquer identify rodando neste device antes de remover
  for (const key of [...identifyTasks.keys()]) {
    if (key.startsWith(deviceid + ':')) {
      identifyTasks.get(key).stop();
      identifyTasks.delete(key);
    }
  }
  bus.disconnectDevice(deviceid);
  try { if (bridge.connected) bridge.deactivate(deviceid); } catch {}
  storage.removeDevice(deviceid);
}

// ── Identify circuit (blink loop por DP) ──────────────────────────────
const identifyTasks = new Map();   // `${deviceid}:${dp}` -> { stop }

function startIdentify(deviceid, dp = 1, intervalMs = 1200) {
  const key = `${deviceid}:${dp}`;
  if (identifyTasks.has(key)) return false;
  let stopped = false;
  let value = true;
  const loop = async () => {
    while (!stopped) {
      try { await sendDP(deviceid, dp, value); } catch {}
      await new Promise((r) => setTimeout(r, intervalMs));
      value = !value;
    }
  };
  loop();
  identifyTasks.set(key, { stop: () => { stopped = true; } });
  return true;
}

function stopIdentify(deviceid, dp = 1) {
  const key = `${deviceid}:${dp}`;
  const t = identifyTasks.get(key);
  if (t) { t.stop(); identifyTasks.delete(key); return true; }
  return false;
}

function isIdentifying(deviceid, dp = 1) {
  return identifyTasks.has(`${deviceid}:${dp}`);
}

function listIdentifyingDps(deviceid) {
  const out = [];
  for (const key of identifyTasks.keys()) {
    if (key.startsWith(deviceid + ':')) {
      out.push(parseInt(key.split(':')[1], 10));
    }
  }
  return out;
}

module.exports = {
  init,
  storage, bus, bridge,
  sendDP, sendDPs,
  listDevicesWithLive,
  includeDevicesFromCloud,
  removeDevice,
  startIdentify, stopIdentify, isIdentifying, listIdentifyingDps,
};

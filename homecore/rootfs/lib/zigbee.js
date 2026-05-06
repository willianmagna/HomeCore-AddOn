const mqtt = require('mqtt');
const fs = require('fs');
const { EventEmitter } = require('events');

const pairEvents = new EventEmitter();
pairEvents.setMaxListeners(50);
const recentPairEvents = []; // ring buffer dos últimos 50 eventos
const PAIR_BUFFER_SIZE = 50;

const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
const HA_REGISTRY = process.env.HA_REGISTRY || '/home/wmagna/homeassistant/config/.storage/core.device_registry';
const HA_ENTITY_REGISTRY = process.env.HA_ENTITY_REGISTRY || '/home/wmagna/homeassistant/config/.storage/core.entity_registry';
const HA_AREA_REGISTRY = process.env.HA_AREA_REGISTRY || '/home/wmagna/homeassistant/config/.storage/core.area_registry';

const state = {
  devices: [],
  networkmap: null,
  bridgeState: 'unknown',
  bridgeInfo: null,
  permitJoin: false,
  lastStateByDevice: {},
};

const pendingRequests = new Map();
let client = null;

function humanize(slug) {
  return String(slug || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseUniqueId(uid) {
  if (!uid || !uid.endsWith('_zigbee2mqtt')) return null;
  const core = uid.slice(0, -'_zigbee2mqtt'.length);
  const parts = core.split('_');
  if (parts.length < 2) return null;
  return {
    ieee: parts[0],
    kind: parts[1],
    endpoint: parts.slice(2).join('_') || null,
  };
}

function readHARegistries() {
  const out = { devices: {}, entities: {} };
  const areas = {};
  try {
    if (fs.existsSync(HA_AREA_REGISTRY)) {
      const a = JSON.parse(fs.readFileSync(HA_AREA_REGISTRY, 'utf-8'));
      for (const area of a.data.areas || []) areas[area.id] = area.name;
    }
    if (fs.existsSync(HA_REGISTRY)) {
      const d = JSON.parse(fs.readFileSync(HA_REGISTRY, 'utf-8'));
      for (const dev of d.data.devices || []) {
        for (const ident of dev.identifiers || []) {
          const [domain, id] = ident;
          if (domain === 'mqtt' && id && id.startsWith('zigbee2mqtt_') && !id.includes('bridge')) {
            const ieee = id.replace(/^zigbee2mqtt_/, '');
            out.devices[ieee] = {
              name: dev.name_by_user || dev.name,
              area: dev.area_id ? areas[dev.area_id] : null,
            };
          }
        }
      }
    }
    if (fs.existsSync(HA_ENTITY_REGISTRY)) {
      const e = JSON.parse(fs.readFileSync(HA_ENTITY_REGISTRY, 'utf-8'));
      const all = e.data.entities || [];

      // Pass 1: switch_as_x wrappers — mapeia entity_id original → { display_name, wrapper_entity_id }
      const wrappers = {};
      for (const ent of all) {
        if (ent.platform !== 'switch_as_x') continue;
        const wrapped = ent.options?.switch_as_x?.entity_id;
        if (!wrapped) continue;
        const wrapperKind = (ent.entity_id || '').split('.')[0];
        // Preferimos 'light' sobre 'switch'/'siren' pra iluminação
        if (wrappers[wrapped] && wrappers[wrapped].kind === 'light' && wrapperKind !== 'light') continue;
        wrappers[wrapped] = {
          kind: wrapperKind,
          entity_id: ent.entity_id,
          display_name: ent.name_by_user || ent.name || null,
        };
      }

      // Pass 2: entidades MQTT zigbee2mqtt
      for (const ent of all) {
        if (ent.platform !== 'mqtt') continue;
        const eid = ent.entity_id || '';
        if (!eid.startsWith('light.') && !eid.startsWith('switch.')) continue;
        const parsed = parseUniqueId(ent.unique_id);
        if (!parsed) continue;
        const key = `${parsed.ieee}::${parsed.endpoint || ''}`;

        const wrapper = wrappers[eid];
        let displayName = wrapper?.display_name || ent.name_by_user || ent.name;
        if (!displayName) {
          const slug = eid.split('.')[1] || '';
          const isDefaultId = !slug.startsWith('0x');
          if (isDefaultId) displayName = humanize(slug.replace(/_l[1-4]$/, ''));
        }
        if (!displayName) displayName = ent.original_name || null;

        const kind = wrapper?.kind || eid.split('.')[0];
        out.entities[key] = {
          entity_id: wrapper?.entity_id || eid,
          display_name: displayName,
          original_name: ent.original_name,
          kind, // 'light' | 'switch' | 'siren' | ...
        };
      }
    }
  } catch (e) {
    console.error('[zigbee] erro lendo registry HA:', e.message);
  }
  return out;
}

function detectControls(exposes) {
  const controls = [];
  const walk = (list, prefix) => {
    for (const e of list || []) {
      if (e.type === 'light' || e.type === 'switch') {
        const stateFeat = (e.features || []).find((f) => f.name === 'state');
        const brightFeat = (e.features || []).find((f) => f.name === 'brightness');
        const ep = e.endpoint;
        controls.push({
          kind: e.type,
          endpoint: ep || null,
          state_property: stateFeat?.property || (ep ? `state_${ep}` : 'state'),
          brightness_property: brightFeat?.property || (ep ? `brightness_${ep}` : 'brightness'),
          has_brightness: !!brightFeat,
          label: prefix ? `${prefix} ${ep || ''}`.trim() : ep || null,
        });
      }
      if (e.features) walk(e.features, e.name);
    }
  };
  walk(exposes, '');
  return controls;
}

// Extrai valores possíveis do enum 'action' (ex: ["single","double","triple","hold","release"])
function detectActionValues(exposes) {
  const seen = new Set();
  const walk = (list) => {
    for (const e of list || []) {
      if (e?.name === 'action' && e.type === 'enum' && Array.isArray(e.values)) {
        for (const v of e.values) seen.add(v);
      }
      if (e?.features) walk(e.features);
    }
  };
  walk(exposes);
  return [...seen];
}

function enrichDevices(rawDevices) {
  const reg = readHARegistries();
  return rawDevices.map((d) => {
    const ha = reg.devices[d.ieee_address] || {};
    const exposes = d.definition?.exposes || [];
    const action_values = detectActionValues(exposes);
    const controls = detectControls(exposes).map((c) => {
      const entKey = `${d.ieee_address}::${c.endpoint || ''}`;
      const ent = reg.entities[entKey] || {};
      return {
        ...c,
        entity_id: ent.entity_id || null,
        entity_name: ent.display_name || null,
        entity_kind: ent.kind || null,
      };
    });
    return {
      ieee_address: d.ieee_address,
      friendly_name: d.friendly_name,
      display_name: ha.name || d.friendly_name || d.ieee_address,
      area: ha.area || null,
      type: d.type,
      power_source: d.power_source,
      manufacturer: d.manufacturer,
      model: d.definition?.model,
      description: d.definition?.description,
      vendor: d.definition?.vendor,
      supported: d.supported,
      disabled: d.disabled,
      interview_completed: d.interview_completed,
      network_address: d.network_address,
      software_build_id: d.software_build_id,
      last_seen: d.last_seen,
      controls,
      action_values, // ações reconhecidas (botões/sensores enum)
      is_lightable: controls.length > 0,
      state: state.lastStateByDevice[d.friendly_name] || null,
    };
  });
}

function onMessage(topic, payload) {
  const str = payload.toString();
  let data;
  try { data = JSON.parse(str); } catch { data = str; }

  if (topic === 'zigbee2mqtt/bridge/state') {
    state.bridgeState = data.state || data;
  } else if (topic === 'zigbee2mqtt/bridge/devices') {
    state.devices = enrichDevices(data);
  } else if (topic === 'zigbee2mqtt/bridge/event') {
    // device_joined / device_leave / device_interview / device_announce
    if (data && typeof data === 'object' && data.type) {
      const evt = {
        ts: Date.now(),
        type: data.type,
        ieee: data.data?.ieee_address || null,
        friendly_name: data.data?.friendly_name || null,
        status: data.data?.status || null, // started/successful/failed (device_interview)
        definition: data.data?.definition || null,
        supported: data.data?.supported,
      };
      recentPairEvents.push(evt);
      while (recentPairEvents.length > PAIR_BUFFER_SIZE) recentPairEvents.shift();
      pairEvents.emit('event', evt);
    }
  } else if (topic === 'zigbee2mqtt/bridge/info') {
    state.bridgeInfo = data;
    state.permitJoin = !!data.permit_join;
  } else if (topic.startsWith('zigbee2mqtt/bridge/response/')) {
    const rid = data.transaction;
    if (rid && pendingRequests.has(rid)) {
      const { resolve } = pendingRequests.get(rid);
      pendingRequests.delete(rid);
      resolve(data);
    }
    if (topic === 'zigbee2mqtt/bridge/response/networkmap' && data.status === 'ok') {
      state.networkmap = data.data?.value || data.data;
    }
  } else if (topic.startsWith('zigbee2mqtt/') && !topic.includes('/bridge/')) {
    const fn = topic.replace(/^zigbee2mqtt\//, '').split('/')[0];
    if (fn && typeof data === 'object') {
      const prev = state.lastStateByDevice[fn] || {};
      // Merge em vez de overwrite: z2m publica updates parciais (ex: só {action:"single"}
      // e depois {action:""} pra limpar). Sem merge perdemos battery/temp/etc.
      const merged = { ...prev, ...data };
      // action vazio é um "clear" emitido pelo z2m logo após o evento — preservamos a última
      // ação válida (com seu próprio timestamp), pra UI mostrar "single há Xs".
      if (data.action !== undefined) {
        if (data.action) {
          merged.action = data.action;
          merged._action_ts = Date.now();
        } else {
          merged.action = prev.action || '';
          merged._action_ts = prev._action_ts || null;
        }
      }
      merged._ts = Date.now();
      state.lastStateByDevice[fn] = merged;
    }
  }
}

function request(endpoint, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) return reject(new Error('MQTT offline'));
    const transaction = `hc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingRequests.set(transaction, { resolve, reject });
    setTimeout(() => {
      if (pendingRequests.has(transaction)) {
        pendingRequests.delete(transaction);
        reject(new Error('timeout'));
      }
    }, 30000);
    client.publish(`zigbee2mqtt/bridge/request/${endpoint}`, JSON.stringify({ ...payload, transaction }));
  });
}

function start() {
  client = mqtt.connect(MQTT_URL, { reconnectPeriod: 5000 });
  client.on('connect', () => {
    console.log('[zigbee] MQTT conectado em', MQTT_URL);
    client.subscribe([
      'zigbee2mqtt/bridge/state',
      'zigbee2mqtt/bridge/devices',
      'zigbee2mqtt/bridge/info',
      'zigbee2mqtt/bridge/event',
      'zigbee2mqtt/bridge/response/#',
      'zigbee2mqtt/+',
    ]);
  });
  client.on('message', onMessage);
  client.on('error', (e) => console.error('[zigbee] MQTT erro:', e.message));
}

async function refreshNetworkmap() {
  return request('networkmap', { type: 'raw', routes: false });
}

async function permitJoin(seconds = 254) {
  return request('permit_join', { time: seconds });
}

async function stopJoin() {
  return request('permit_join', { time: 0 });
}

async function renameDevice(from, to) {
  return request('device/rename', { from, to });
}

async function removeDevice(id, force = false) {
  return request('device/remove', { id, force });
}

async function reinterview(id) {
  return request('device/interview', { id });
}

function setDevice(friendlyName, payload) {
  if (!client || !client.connected) throw new Error('MQTT offline');
  client.publish(`zigbee2mqtt/${friendlyName}/set`, JSON.stringify(payload));
  return { ok: true };
}

function devicesWithFreshState() {
  return state.devices.map((d) => ({
    ...d,
    state: state.lastStateByDevice[d.friendly_name] || null,
  }));
}

function getDevices() {
  return devicesWithFreshState();
}

function getSnapshot() {
  return {
    bridgeState: state.bridgeState,
    bridgeInfo: state.bridgeInfo
      ? { version: state.bridgeInfo.version, permit_join: state.bridgeInfo.permit_join, coordinator: state.bridgeInfo.coordinator }
      : null,
    permitJoin: state.permitJoin,
    devices: devicesWithFreshState(),
  };
}

function getNetworkmap() {
  return state.networkmap;
}

function getRecentPairEvents(sinceTs = 0) {
  return recentPairEvents.filter((e) => e.ts > sinceTs);
}

function subscribePairEvents(cb) {
  pairEvents.on('event', cb);
  return () => pairEvents.off('event', cb);
}

module.exports = {
  start,
  getDevices,
  getSnapshot,
  getNetworkmap,
  refreshNetworkmap,
  permitJoin,
  stopJoin,
  renameDevice,
  removeDevice,
  reinterview,
  setDevice,
  getRecentPairEvents,
  subscribePairEvents,
};

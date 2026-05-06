// MQTT Discovery bridge: publica devices Sonoff (single-channel) ativos pra HA.
// Mesma topologia simples do Tuya per-channel: state/cmd com payload "ON"/"OFF",
// `suggested_area` no discovery + sync de area_id e entity_id via HA WS API.
const mqtt = require('mqtt');
const storage = require('./storage');
const bus = require('./state-bus');
const ha = require('../ha');

const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_USER = process.env.MQTT_USERNAME || undefined;
const MQTT_PASS = process.env.MQTT_PASSWORD || undefined;
const DISCOVERY_PREFIX = process.env.MQTT_DISCOVERY_PREFIX || 'homeassistant';

const CATEGORY_TO_COMPONENT = {
  switch: 'switch', light: 'light', fan: 'fan',
  outlet: 'switch', cover: 'cover', valve: 'valve',
  siren: 'switch', other: 'switch',
};
const ALL_COMPONENTS = [...new Set(Object.values(CATEGORY_TO_COMPONENT))];

function topicState(did) { return `homecore/wifi/${did}/state`; }
function topicCmd(did)   { return `homecore/wifi/${did}/cmd`; }
function topicAvail(did) { return `homecore/wifi/${did}/availability`; }
function topicDiscovery(category, did) {
  const comp = CATEGORY_TO_COMPONENT[category] || 'switch';
  return `${DISCOVERY_PREFIX}/${comp}/homecore_${did}/config`;
}

function getRooms() {
  try { return require('../areas').getAll().rooms || []; } catch { return []; }
}

function discoveryPayload(dev, fullState) {
  const did = dev.deviceid;
  const category = dev.ha_category || 'switch';
  const name = dev.name || did;
  const objectId = dev.object_id || `homecore_${did}`;

  let suggestedArea;
  if (dev.room_id) {
    const room = getRooms().find((r) => r.id === dev.room_id);
    if (room) suggestedArea = room.name;
  }
  const deviceName = suggestedArea ? `[${suggestedArea}] ${name}` : name;

  return {
    name,
    unique_id: `homecore_${did}`,
    object_id: objectId,
    state_topic: topicState(did),
    command_topic: topicCmd(did),
    availability_topic: topicAvail(did),
    payload_available: 'online',
    payload_not_available: 'offline',
    payload_on: 'ON',
    payload_off: 'OFF',
    optimistic: false,
    device: {
      identifiers: [`homecore_${did}`],
      name: deviceName,
      manufacturer: 'Sonoff (HomeCore)',
      model: dev.model || 'unknown',
      sw_version: fullState?.fwVersion,
      configuration_url: 'https://homecore.atlas.local/dispositivos.html',
      ...(suggestedArea ? { suggested_area: suggestedArea } : {}),
    },
  };
}

class Bridge {
  constructor() {
    this.client = null;
    this.cmdHandler = null;
    this.connected = false;
    this._unsubBus = null;
  }

  start(cmdHandler) {
    this.cmdHandler = cmdHandler;
    const opts = {
      host: MQTT_HOST, port: MQTT_PORT,
      username: MQTT_USER, password: MQTT_PASS,
      clientId: `homecore-${process.pid}`,
      reconnectPeriod: 2000,
    };
    this.client = mqtt.connect(opts);
    this.client.on('connect', () => this._onConnect());
    this.client.on('close', () => { this.connected = false; });
    this.client.on('error', () => {});
    this.client.on('message', (topic, payload) => this._onMessage(topic, payload));
    this._unsubBus = bus.subscribe((evt) => this._onStateEvent(evt));
  }

  async stop() {
    try { this._unsubBus?.(); } catch {}
    try { this.client?.end(true); } catch {}
  }

  _onConnect() {
    this.connected = true;
    for (const dev of storage.listDevices()) {
      if (dev.mqtt_active) this._publishFull(dev);
    }
    this.client.subscribe('homecore/wifi/+/cmd');
  }

  _onMessage(topic, payload) {
    const m = /^homecore\/wifi\/([^/]+)\/cmd$/.exec(topic);
    if (!m) return;
    const deviceid = m[1];
    // Aceita formato HA ('ON'/'OFF' string) e legado (JSON {state:'on'})
    const raw = payload.toString('utf8').trim();
    let state = null;
    if (raw.toUpperCase() === 'ON') state = 'on';
    else if (raw.toUpperCase() === 'OFF') state = 'off';
    else {
      try {
        const j = JSON.parse(raw);
        if (j.state) state = String(j.state).toLowerCase();
      } catch {}
    }
    if (state && this.cmdHandler) {
      Promise.resolve(this.cmdHandler(deviceid, { state })).catch(() => {});
    }
  }

  _onStateEvent(evt) {
    const dev = storage.getDevice(evt.deviceid);
    if (!dev || !dev.mqtt_active) return;
    if (evt.is_on === true) {
      this._pub(topicState(evt.deviceid), 'ON', true);
    } else if (evt.is_on === false) {
      this._pub(topicState(evt.deviceid), 'OFF', true);
    }
    this._pub(topicAvail(evt.deviceid), 'online', true);
  }

  _pub(topic, payload, retain = false) {
    if (!this.client || !this.connected) return;
    this.client.publish(topic, payload, { qos: 1, retain });
  }

  _clearAllDiscoveriesFor(deviceid) {
    for (const cat of ALL_COMPONENTS) {
      this._pub(`${DISCOVERY_PREFIX}/${cat}/homecore_${deviceid}/config`, '', true);
    }
  }

  _publishFull(dev) {
    const did = dev.deviceid;
    const category = dev.ha_category || 'switch';
    const live = bus.get(did);
    const fullState = live?.state || null;

    // Limpa retained antigos (categoria pode ter mudado)
    this._clearAllDiscoveriesFor(did);

    const config = discoveryPayload(dev, fullState);
    this._pub(topicDiscovery(category, did), JSON.stringify(config), true);

    if (live?.is_on !== undefined && live?.is_on !== null) {
      this._pub(topicState(did), live.is_on ? 'ON' : 'OFF', true);
    }
    const isFresh = live?.ts && (Date.now() / 1000 - live.ts < 300);
    this._pub(topicAvail(did), isFresh ? 'online' : 'offline', true);

    setTimeout(() => this._syncToHA(dev).catch(() => {}), 1500);
  }

  async _syncToHA(dev) {
    if (!ha.hasToken()) return;
    if (!dev.room_id && !dev.object_id) return;
    try {
      const uid = `homecore_${dev.deviceid}`;
      const entity = await ha.findEntityByUniqueId(uid);
      if (!entity) return;

      const updates = {};
      const component = (entity.entity_id || '').split('.')[0];
      if (dev.object_id && component) {
        const desired = `${component}.${dev.object_id}`;
        if (entity.entity_id !== desired) updates.new_entity_id = desired;
      }
      if (dev.room_id) {
        const room = getRooms().find((r) => r.id === dev.room_id);
        if (room) {
          const area = await ha.ensureArea(room.name);
          if (area && area.area_id && entity.area_id !== area.area_id) {
            updates.area_id = area.area_id;
          }
        }
      }
      if (Object.keys(updates).length) {
        await ha.updateEntity(entity.entity_id, updates);
        const parts = [];
        if (updates.new_entity_id) parts.push(`renamed → ${updates.new_entity_id}`);
        if (updates.area_id) parts.push(`area atualizada`);
        console.log(`[sonoff] HA sync ${entity.entity_id}: ${parts.join(', ')}`);
      }
    } catch {}
  }

  activate(deviceid) {
    storage.updateSettings(deviceid, { mqtt_active: 1 });
    const dev = storage.getDevice(deviceid);
    if (dev) this._publishFull(dev);
  }

  deactivate(deviceid) {
    this._clearAllDiscoveriesFor(deviceid);
    this._pub(topicAvail(deviceid), 'offline', true);
    storage.updateSettings(deviceid, { mqtt_active: 0 });
  }

  republish(deviceid) {
    const dev = storage.getDevice(deviceid);
    if (!dev || !dev.mqtt_active) return;
    this._publishFull(dev);
  }
}

const bridge = new Bridge();
module.exports = bridge;

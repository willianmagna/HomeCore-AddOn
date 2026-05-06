// MQTT Discovery bridge pro Tuya. Publica UMA ENTIDADE HA POR CANAL configurado em
// `channels_config`. Topologia per-channel (cmd/state separados por DP) — necessário
// pra que componentes HA distintos (switch, light, fan, valve) funcionem todos como
// toggle, já que cada um tem expectativa diferente de payload_on/off.
//
//   homeassistant/<channel.ha_category>/homecore_tuya_<deviceid>_dp<N>/config   (retained, JSON discovery)
//   homecore/tuya/<deviceid>/state/dp<N>                                        (retained, "ON"/"OFF")
//   homecore/tuya/<deviceid>/cmd/dp<N>                                          (recebe "ON"/"OFF")
//   homecore/tuya/<deviceid>/availability                                       (online/offline retained)
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
const MAX_DP_TO_CLEAN = 6;

const topicState        = (id, dp) => `homecore/tuya/${id}/state/dp${dp}`;
const topicCmd          = (id, dp) => `homecore/tuya/${id}/cmd/dp${dp}`;
const topicAvail        = (id)     => `homecore/tuya/${id}/availability`;

function topicDiscoveryFor(category, did, dp) {
  const c = CATEGORY_TO_COMPONENT[category] || 'switch';
  return `${DISCOVERY_PREFIX}/${c}/homecore_tuya_${did}_dp${dp}/config`;
}

function getRooms() {
  try { return require('../areas').getAll().rooms || []; } catch { return []; }
}

function discoveryPayloadForChannel(dev, dp, cfg) {
  const did = dev.deviceid;
  const category = cfg.ha_category || 'switch';
  const name = cfg.name || `${dev.name || did} S${dp}`;
  const objectId = cfg.object_id || `homecore_tuya_${did}_dp${dp}`;

  let suggestedArea;
  if (cfg.room_id) {
    const room = getRooms().find((r) => r.id === cfg.room_id);
    if (room) suggestedArea = room.name;
  }
  const deviceName = suggestedArea
    ? `[${suggestedArea}] ${dev.name || did}`
    : (dev.name || did);

  // Topologia per-canal: cmd e state isolados por DP, payloads simples ON/OFF.
  // Compatível com TODOS os componentes HA (switch/light/fan/valve/cover) sem template.
  return {
    name,
    unique_id: `homecore_tuya_${did}_dp${dp}`,
    object_id: objectId,
    state_topic:        topicState(did, dp),
    command_topic:      topicCmd(did, dp),
    availability_topic: topicAvail(did),
    payload_available:     'online',
    payload_not_available: 'offline',
    payload_on:  'ON',
    payload_off: 'OFF',
    optimistic: false,
    device: {
      identifiers: [`homecore_tuya_${did}`],
      name: deviceName,
      manufacturer: 'Tuya (HomeCore)',
      model: dev.product_id || 'unknown',
      configuration_url: 'https://homecore.atlas.local/tuya.html',
      ...(suggestedArea ? { suggested_area: suggestedArea } : {}),
    },
  };
}

function parseChannelsConfig(dev) {
  if (!dev) return {};
  if (typeof dev.channels_config === 'string') {
    try { return JSON.parse(dev.channels_config); } catch { return {}; }
  }
  return dev.channels_config || {};
}

class TuyaBridge {
  constructor() {
    this.client = null;
    this.connected = false;
    this._unsubBus = null;
    this._cmdHandler = null;
  }

  start(cmdHandler) {
    this._cmdHandler = cmdHandler;
    const opts = {
      host: MQTT_HOST, port: MQTT_PORT,
      username: MQTT_USER, password: MQTT_PASS,
      clientId: `homecore-tuya-${process.pid}`,
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
    this.client.subscribe('homecore/tuya/+/cmd/+');
    // Backward compat (legado device-level cmd)
    this.client.subscribe('homecore/tuya/+/cmd');
  }

  _onMessage(topic, payload) {
    // Per-channel cmd: homecore/tuya/<deviceid>/cmd/dp<N>
    let m = /^homecore\/tuya\/([^/]+)\/cmd\/dp(\d+)$/.exec(topic);
    if (m) {
      const [, deviceid, dpStr] = m;
      const dp = parseInt(dpStr, 10);
      const value = String(payload).trim().toUpperCase() === 'ON';
      if (this._cmdHandler) {
        Promise.resolve(this._cmdHandler(deviceid, { dp, value })).catch(() => {});
      }
      return;
    }
    // Legacy device-level cmd: homecore/tuya/<deviceid>/cmd  (compat)
    m = /^homecore\/tuya\/([^/]+)\/cmd$/.exec(topic);
    if (m) {
      const deviceid = m[1];
      let body;
      try { body = JSON.parse(payload.toString('utf8')); }
      catch { body = { state: payload.toString('utf8').trim().toLowerCase() }; }
      if (this._cmdHandler) {
        Promise.resolve(this._cmdHandler(deviceid, body)).catch(() => {});
      }
    }
  }

  _onStateEvent(evt) {
    const dev = storage.getDevice(evt.deviceid);
    if (!dev || !dev.mqtt_active) return;
    const channels = parseChannelsConfig(dev);
    const dps = evt.dps || {};
    // Publica estado per-canal pra cada DP que tem config — mas SÓ se o valor é boolean.
    for (const [dpStr, cfg] of Object.entries(channels)) {
      if (!cfg.name || !cfg.ha_category) continue;
      const v = dps[dpStr];
      if (typeof v !== 'boolean') continue;
      this._pub(topicState(evt.deviceid, dpStr), v ? 'ON' : 'OFF', true);
    }
    this._pub(topicAvail(evt.deviceid), evt.online === false ? 'offline' : 'online', true);
  }

  _pub(topic, payload, retain = false) {
    if (!this.client || !this.connected) return;
    this.client.publish(topic, payload, { qos: 1, retain });
  }

  _clearAllChannelsFor(deviceid) {
    // Sweep de retained antigos (todas combinações component × dp)
    for (const comp of ALL_COMPONENTS) {
      for (let dp = 1; dp <= MAX_DP_TO_CLEAN; dp++) {
        this._pub(`${DISCOVERY_PREFIX}/${comp}/homecore_tuya_${deviceid}_dp${dp}/config`, '', true);
        // Estado por canal
        this._pub(topicState(deviceid, dp), '', true);
      }
      // Discovery legado de quando publicávamos um único entity por device (sem _dp<N>)
      this._pub(`${DISCOVERY_PREFIX}/${comp}/homecore_tuya_${deviceid}/config`, '', true);
    }
    // State legado device-level
    this._pub(`homecore/tuya/${deviceid}/state`, '', true);
  }

  _publishFull(dev) {
    const id = dev.deviceid;
    const channels = parseChannelsConfig(dev);
    const live = bus.get(id);

    this._clearAllChannelsFor(id);

    let publishedCount = 0;
    for (const [dp, cfg] of Object.entries(channels)) {
      if (!cfg.name || !cfg.ha_category) continue;
      const topic = topicDiscoveryFor(cfg.ha_category, id, dp);
      this._pub(topic, JSON.stringify(discoveryPayloadForChannel(dev, dp, cfg)), true);
      // Estado inicial per-canal a partir do live
      const v = (live?.dps || {})[dp];
      if (typeof v === 'boolean') {
        this._pub(topicState(id, dp), v ? 'ON' : 'OFF', true);
      }
      publishedCount++;
    }

    const isFresh = live?.ts && (Date.now() / 1000 - live.ts < 300);
    this._pub(topicAvail(id), live?.online || isFresh ? 'online' : 'offline', true);

    // Pós-publish: força area_id no HA via WS (suggested_area só vale na 1ª criação).
    // Roda em background com delay pra HA processar a discovery primeiro.
    setTimeout(() => this._syncAreasToHA(dev).catch(() => {}), 1500);

    return publishedCount;
  }

  async _syncAreasToHA(dev) {
    if (!ha.hasToken()) return;
    const channels = parseChannelsConfig(dev);
    const localRooms = (() => {
      try { return require('../areas').getAll().rooms || []; } catch { return []; }
    })();
    for (const [dp, cfg] of Object.entries(channels)) {
      if (!cfg.name || !cfg.ha_category) continue;
      try {
        const uid = `homecore_tuya_${dev.deviceid}_dp${dp}`;
        const entity = await ha.findEntityByUniqueId(uid);
        if (!entity) continue;

        const updates = {};

        // 1) Renomeia entity_id se o object_id mudou
        const component = (() => {
          // domain do entity_id atual ('light.x' → 'light')
          return (entity.entity_id || '').split('.')[0];
        })();
        if (cfg.object_id && component) {
          const desiredEntityId = `${component}.${cfg.object_id}`;
          if (entity.entity_id !== desiredEntityId) {
            updates.new_entity_id = desiredEntityId;
          }
        }

        // 2) Sincroniza area se room foi setado
        if (cfg.room_id) {
          const room = localRooms.find((r) => r.id === cfg.room_id);
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
          if (updates.area_id) parts.push(`area → ${(localRooms.find(r=>r.id===cfg.room_id)||{}).name}`);
          console.log(`[tuya] HA sync ${entity.entity_id}: ${parts.join(', ')}`);
        }
      } catch (e) {
        // Ignora erros pontuais (HA reiniciando / entity_id colidiu / etc)
      }
    }
  }

  activate(deviceid) {
    storage.updateSettings(deviceid, { mqtt_active: 1 });
    const dev = storage.getDevice(deviceid);
    if (dev) this._publishFull(dev);
  }

  deactivate(deviceid) {
    this._clearAllChannelsFor(deviceid);
    this._pub(topicAvail(deviceid), 'offline', true);
    storage.updateSettings(deviceid, { mqtt_active: 0 });
  }

  republish(deviceid) {
    const dev = storage.getDevice(deviceid);
    if (!dev || !dev.mqtt_active) return;
    this._publishFull(dev);
  }
}

const bridge = new TuyaBridge();
module.exports = bridge;

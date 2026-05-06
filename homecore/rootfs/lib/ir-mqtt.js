const mqtt = require('mqtt');
const ir = require('./ir');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
const BASE = 'homecore_ir';
const DISCOVERY_PREFIX = 'homeassistant';

let client = null;

function topics(dev) {
  const base = `${BASE}/${dev.id}`;
  return {
    state: `${base}/state`,
    availability: `${base}/availability`,
    cmd_power: `${base}/set/power`,         // climate on/off, media on/off
    cmd_mode: `${base}/set/mode`,           // climate hvac_mode
    cmd_temp: `${base}/set/temperature`,
    cmd_fan: `${base}/set/fan_mode`,
    cmd_swing: `${base}/set/swing_mode`,
    cmd_volume: `${base}/set/volume_level`,
    cmd_source: `${base}/set/source`,
    cmd_mute: `${base}/set/mute`,
    cmd_button: `${base}/remote/send`,      // generic remote
  };
}

function discoveryPayload(dev) {
  const t = topics(dev);
  const devInfo = {
    identifiers: [`homecore_ir_${dev.id}`],
    manufacturer: dev.code_meta?.manufacturer || 'HomeCore IR',
    model: (dev.code_meta?.models || []).join(', ') || dev.code_file,
    name: dev.name,
    suggested_area: dev.area || undefined,
    via_device: 'homecore',
  };
  const base = {
    availability_topic: t.availability,
    payload_available: 'online',
    payload_not_available: 'offline',
    unique_id: `homecore_ir_${dev.id}`,
    device: devInfo,
  };

  if (dev.type === 'climate') {
    const cm = dev.code_meta || {};
    const tempSensorTopic = dev.temp_sensor ? `zigbee2mqtt/${dev.temp_sensor}` : null;
    return {
      domain: 'climate',
      object_id: dev.id,
      cfg: {
        ...base,
        name: dev.name,
        modes: ['off', ...(cm.operationModes || [])],
        fan_modes: cm.fanModes,
        swing_modes: cm.swingModes,
        min_temp: cm.minTemperature,
        max_temp: cm.maxTemperature,
        temp_step: cm.precision || 1,
        temperature_unit: 'C',
        mode_state_topic: t.state,
        mode_state_template: '{{ value_json.hvac_mode }}',
        mode_command_topic: t.cmd_mode,
        temperature_state_topic: t.state,
        temperature_state_template: '{{ value_json.temperature }}',
        temperature_command_topic: t.cmd_temp,
        fan_mode_state_topic: t.state,
        fan_mode_state_template: '{{ value_json.fan_mode }}',
        fan_mode_command_topic: t.cmd_fan,
        swing_mode_state_topic: cm.swingModes ? t.state : undefined,
        swing_mode_state_template: cm.swingModes ? '{{ value_json.swing_mode }}' : undefined,
        swing_mode_command_topic: cm.swingModes ? t.cmd_swing : undefined,
        // Sensor de temperatura ambiente (opcional). HA assina o tópico do z2m e
        // mostra a leitura no card de clima.
        current_temperature_topic: tempSensorTopic || undefined,
        current_temperature_template: tempSensorTopic ? '{{ value_json.temperature }}' : undefined,
      },
    };
  }
  if (dev.type === 'media_player') {
    return {
      domain: 'switch', // fallback: HA não tem media_player via MQTT discovery simples
      object_id: dev.id,
      cfg: {
        ...base,
        name: dev.name,
        state_topic: t.state,
        value_template: '{{ value_json.power }}',
        payload_on: 'on',
        payload_off: 'off',
        command_topic: t.cmd_power,
      },
    };
  }
  // remote genérico: expõe como button por comando? v1 simples: switch que só toca "last_command"
  return {
    domain: 'button',
    object_id: dev.id,
    cfg: {
      ...base,
      name: dev.name,
      command_topic: t.cmd_button,
    },
  };
}

function publishDiscovery(dev) {
  const { domain, object_id, cfg } = discoveryPayload(dev);
  const topic = `${DISCOVERY_PREFIX}/${domain}/${object_id}/config`;
  client.publish(topic, JSON.stringify(cfg), { retain: true });
}

function publishState(dev) {
  client.publish(topics(dev).availability, 'online', { retain: true });
  const payload = { ...dev.state };
  client.publish(topics(dev).state, JSON.stringify(payload), { retain: true });
}

function unpublish(devId) {
  // remove discovery retained
  for (const domain of ['climate', 'switch', 'button']) {
    client.publish(`${DISCOVERY_PREFIX}/${domain}/${devId}/config`, '', { retain: true });
  }
  client.publish(`${BASE}/${devId}/availability`, 'offline', { retain: true });
  client.publish(`${BASE}/${devId}/state`, '', { retain: true });
}

function subscribeCommands() {
  client.subscribe(`${BASE}/+/set/+`);
  client.subscribe(`${BASE}/+/remote/send`);
}

async function onMessage(topic, buf) {
  // homecore_ir/<id>/set/<attr>   ou  homecore_ir/<id>/remote/send
  const parts = topic.split('/');
  if (parts[0] !== BASE) return;
  const deviceId = parts[1];
  const payload = buf.toString();

  try {
    if (parts[2] === 'set') {
      const attr = parts[3];
      const map = {
        power: () => ir.sendCommand(deviceId, payload.toLowerCase()),
        mode: () => ir.applyState(deviceId, { hvac_mode: payload }),
        temperature: () => ir.applyState(deviceId, { temperature: parseFloat(payload) }),
        fan_mode: () => ir.applyState(deviceId, { fan_mode: payload }),
        swing_mode: () => ir.applyState(deviceId, { swing_mode: payload }),
        volume_level: () => ir.applyState(deviceId, { volume_level: parseFloat(payload) }),
        source: () => ir.sendCommand(deviceId, `source_${payload}`),
        mute: () => ir.sendCommand(deviceId, 'mute'),
      };
      if (map[attr]) await map[attr]();
    } else if (parts[2] === 'remote' && parts[3] === 'send') {
      await ir.sendCommand(deviceId, payload);
    }
  } catch (e) {
    console.error(`[ir-mqtt] erro em ${topic}:`, e.message);
  }
}

function republishAll() {
  for (const d of ir.getDevices()) {
    publishDiscovery(d);
    publishState(d);
  }
}

function start() {
  client = mqtt.connect(MQTT_URL, { reconnectPeriod: 5000 });
  client.on('connect', () => {
    console.log('[ir-mqtt] MQTT conectado');
    subscribeCommands();
    republishAll();
  });
  client.on('message', onMessage);
  client.on('error', (e) => console.error('[ir-mqtt] erro:', e.message));

  ir.onDeviceChange((dev) => {
    try {
      // garante que code_meta está presente (listeners recebem dev "cru")
      const enriched = ir.getDevices().find((d) => d.id === dev.id) || dev;
      publishDiscovery(enriched);
      publishState(enriched);
    } catch (e) { console.error('[ir-mqtt] publish falhou:', e.message); }
  });
}

module.exports = { start, republishAll, unpublish, publishDiscovery, publishState };

const WebSocket = require('ws');
const fs = require('fs');

const HA_URL = process.env.HA_URL || 'ws://127.0.0.1:8123/api/websocket';
const HA_TOKEN = process.env.HA_TOKEN || '';

let ws = null;
let nextId = 1;
let authed = false;
const pending = new Map();
const queue = [];

function connect() {
  if (!HA_TOKEN) {
    console.warn('[ha] HA_TOKEN não configurado — writes no HA desabilitados');
    return;
  }
  ws = new WebSocket(HA_URL);
  ws.on('open', () => console.log('[ha] WS conectado'));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
    } else if (msg.type === 'auth_ok') {
      authed = true;
      console.log('[ha] autenticado');
      while (queue.length) {
        const { payload, resolve, reject } = queue.shift();
        sendInternal(payload, resolve, reject);
      }
    } else if (msg.type === 'auth_invalid') {
      console.error('[ha] token HA inválido');
      authed = false;
    } else if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.success === false) reject(new Error(msg.error?.message || 'HA call failed'));
      else resolve(msg.result);
    }
  });
  ws.on('close', () => {
    authed = false;
    console.warn('[ha] WS desconectado, tentando reconectar em 5s...');
    setTimeout(connect, 5000);
  });
  ws.on('error', (e) => console.error('[ha] WS erro:', e.message));
}

function sendInternal(payload, resolve, reject) {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, ...payload }));
  setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      reject(new Error('HA call timeout'));
    }
  }, 10000);
}

function call(payload) {
  return new Promise((resolve, reject) => {
    if (!HA_TOKEN) return reject(new Error('HA_TOKEN não configurado no HomeCore'));
    if (!authed || !ws || ws.readyState !== WebSocket.OPEN) {
      queue.push({ payload, resolve, reject });
      return;
    }
    sendInternal(payload, resolve, reject);
  });
}

// ── high-level helpers ──

async function listAreas() {
  return call({ type: 'config/area_registry/list' });
}

async function updateEntity(entity_id, changes) {
  // changes: { name, area_id, icon, ... }
  return call({ type: 'config/entity_registry/update', entity_id, ...changes });
}

async function updateDevice(device_id, changes) {
  return call({ type: 'config/device_registry/update', device_id, ...changes });
}

async function listDevices() {
  return call({ type: 'config/device_registry/list' });
}

async function listEntities() {
  return call({ type: 'config/entity_registry/list' });
}

async function findDeviceByIeee(ieee) {
  const devices = await listDevices();
  return devices.find((d) =>
    (d.identifiers || []).some((i) => i[0] === 'mqtt' && i[1] === `zigbee2mqtt_${ieee}`)
  );
}

async function findDeviceByMqttIdentifier(identifier) {
  const devices = await listDevices();
  return devices.find((d) =>
    (d.identifiers || []).some((i) => i[0] === 'mqtt' && i[1] === identifier)
  );
}

async function findEntityByUniqueId(unique_id) {
  const entities = await listEntities();
  return entities.find((e) => e.unique_id === unique_id);
}

async function findAreaByName(name) {
  const areas = await listAreas();
  const lower = (name || '').toLowerCase();
  return areas.find((a) => (a.name || '').toLowerCase() === lower);
}

async function createArea(name) {
  return call({ type: 'config/area_registry/create', name });
}

async function ensureArea(name) {
  let area = await findAreaByName(name);
  if (!area) area = await createArea(name);
  return area;
}

module.exports = {
  connect,
  call,
  listAreas,
  updateEntity,
  updateDevice,
  listDevices,
  listEntities,
  findDeviceByIeee,
  findDeviceByMqttIdentifier,
  findEntityByUniqueId,
  findAreaByName,
  createArea,
  ensureArea,
  hasToken: () => !!HA_TOKEN,
};

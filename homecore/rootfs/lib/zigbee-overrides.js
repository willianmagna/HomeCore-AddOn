// Overrides locais por device Zigbee.
// Schema:
//   {
//     "<ieee>": {
//       "device_name": "Módulo X",
//       "entities": {
//         "light.x_l1": { "room_id": "sala", "name": "Luz 1" },
//         "light.x_l2": { "room_id": "cozinha", "name": "Luz 2" }
//       }
//     }
//   }
// O cômodo do homecore é per-saída (igual Tuya). HA usa area_id por entity.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'zigbee-overrides.json');

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
      return j && typeof j === 'object' ? j : {};
    }
  } catch {}
  return {};
}

function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function getAll() { return load(); }
function get(ieee) { return load()[ieee] || null; }

function setDeviceName(ieee, deviceName) {
  const s = load();
  const prev = s[ieee] || {};
  s[ieee] = { ...prev, device_name: deviceName || null };
  save(s);
  return s[ieee];
}

function setDeviceRoom(ieee, roomId) {
  const s = load();
  const prev = s[ieee] || {};
  s[ieee] = { ...prev, device_room_id: roomId || null };
  save(s);
  return s[ieee];
}

function setEntity(ieee, entityId, patch) {
  const s = load();
  const prev = s[ieee] || {};
  const entities = { ...(prev.entities || {}) };
  const existing = entities[entityId] || {};
  const next = { ...existing, ...patch };
  // Limpa entradas vazias
  if (next.room_id == null && (next.name == null || next.name === '')) {
    delete entities[entityId];
  } else {
    entities[entityId] = next;
  }
  s[ieee] = { ...prev, entities };
  save(s);
  return s[ieee];
}

function remove(ieee) {
  const s = load();
  delete s[ieee];
  save(s);
}

module.exports = { getAll, get, setDeviceName, setDeviceRoom, setEntity, remove };

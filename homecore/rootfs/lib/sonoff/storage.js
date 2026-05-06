// SQLite store de devices Sonoff incluídos. Persiste devicekey + config (HA category, MQTT toggle, etc).
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.WIFI_DB_PATH || path.join(__dirname, '..', '..', 'data', 'wifi.db');

let db;

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceid    TEXT PRIMARY KEY,
      vendor      TEXT NOT NULL,
      devicekey   TEXT NOT NULL,
      name        TEXT,
      model       TEXT,
      ip          TEXT,
      mac         TEXT,
      cmd_format  TEXT DEFAULT 'switches',
      ha_category TEXT DEFAULT 'switch',
      mqtt_active INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (strftime('%s','now')),
      updated_at  INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
  // Migração additiva (se vier de versão antiga sem alguma coluna)
  const cols = new Set(db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name));
  if (!cols.has('cmd_format')) db.exec("ALTER TABLE devices ADD COLUMN cmd_format TEXT DEFAULT 'switches'");
  if (!cols.has('ha_category')) db.exec("ALTER TABLE devices ADD COLUMN ha_category TEXT DEFAULT 'switch'");
  if (!cols.has('mqtt_active')) db.exec('ALTER TABLE devices ADD COLUMN mqtt_active INTEGER DEFAULT 0');
  if (!cols.has('room_id')) db.exec("ALTER TABLE devices ADD COLUMN room_id TEXT");
  if (!cols.has('object_id')) db.exec("ALTER TABLE devices ADD COLUMN object_id TEXT");
}

function upsertDevice(d) {
  const stmt = db.prepare(`
    INSERT INTO devices (deviceid, vendor, devicekey, name, model, ip, mac)
    VALUES (@deviceid, @vendor, @devicekey, @name, @model, @ip, @mac)
    ON CONFLICT(deviceid) DO UPDATE SET
      devicekey  = excluded.devicekey,
      name       = COALESCE(excluded.name, devices.name),
      model      = COALESCE(excluded.model, devices.model),
      ip         = COALESCE(excluded.ip, devices.ip),
      mac        = COALESCE(excluded.mac, devices.mac),
      updated_at = strftime('%s','now')
  `);
  stmt.run({
    deviceid: d.deviceid, vendor: d.vendor || 'sonoff',
    devicekey: d.devicekey, name: d.name || null,
    model: d.model || null, ip: d.ip || null, mac: d.mac || null,
  });
}

function listDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY name, deviceid').all();
}

function getDevice(deviceid) {
  return db.prepare('SELECT * FROM devices WHERE deviceid = ?').get(deviceid) || null;
}

function updateIp(deviceid, ip) {
  db.prepare("UPDATE devices SET ip = ?, updated_at = strftime('%s','now') WHERE deviceid = ?").run(ip, deviceid);
}

function updateCmdFormat(deviceid, cmdFormat) {
  db.prepare("UPDATE devices SET cmd_format = ?, updated_at = strftime('%s','now') WHERE deviceid = ?")
    .run(cmdFormat, deviceid);
}

function updateSettings(deviceid, { name, ha_category, mqtt_active, room_id, object_id }) {
  const sets = [];
  const args = [];
  if (name !== undefined && name !== null) { sets.push('name = ?'); args.push(name); }
  if (ha_category !== undefined && ha_category !== null) { sets.push('ha_category = ?'); args.push(ha_category); }
  if (mqtt_active !== undefined && mqtt_active !== null) { sets.push('mqtt_active = ?'); args.push(mqtt_active ? 1 : 0); }
  if (room_id !== undefined) { sets.push('room_id = ?'); args.push(room_id || null); }
  if (object_id !== undefined) { sets.push('object_id = ?'); args.push(object_id || null); }
  if (!sets.length) return;
  sets.push("updated_at = strftime('%s','now')");
  args.push(deviceid);
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE deviceid = ?`).run(...args);
}

function removeDevice(deviceid) {
  db.prepare('DELETE FROM devices WHERE deviceid = ?').run(deviceid);
}

module.exports = {
  init, upsertDevice, listDevices, getDevice, updateIp,
  updateCmdFormat, updateSettings, removeDevice,
  get DB_PATH() { return DB_PATH; },
};

// SQLite store de devices Tuya (espelho do Sonoff). Cada device guarda
// localKey (cifra AES) + DPs conhecidos + categoria HA + flag de publicação MQTT.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.TUYA_DB_PATH || path.join(__dirname, '..', '..', 'data', 'tuya.db');

let db;

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      deviceid    TEXT PRIMARY KEY,
      local_key   TEXT NOT NULL,
      protocol    TEXT DEFAULT '3.3',
      product_id  TEXT,
      product_key TEXT,
      category    TEXT,           -- "switch", "light", etc, vindo da Tuya
      name        TEXT,
      ip          TEXT,
      mac         TEXT,
      dps_schema  TEXT,           -- JSON com DPs conhecidos do produto (mode/range)
      ha_category TEXT DEFAULT 'switch',
      mqtt_active INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (strftime('%s','now')),
      updated_at  INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
  // Migração additiva
  const cols = new Set(db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name));
  if (!cols.has('channels_config')) {
    db.exec("ALTER TABLE devices ADD COLUMN channels_config TEXT");
  }
}

function upsertDevice(d) {
  db.prepare(`
    INSERT INTO devices (deviceid, local_key, protocol, product_id, product_key, category, name, ip, mac, dps_schema)
    VALUES (@deviceid, @local_key, @protocol, @product_id, @product_key, @category, @name, @ip, @mac, @dps_schema)
    ON CONFLICT(deviceid) DO UPDATE SET
      local_key   = excluded.local_key,
      protocol    = COALESCE(excluded.protocol, devices.protocol),
      product_id  = COALESCE(excluded.product_id, devices.product_id),
      product_key = COALESCE(excluded.product_key, devices.product_key),
      category    = COALESCE(excluded.category, devices.category),
      name        = COALESCE(excluded.name, devices.name),
      ip          = COALESCE(excluded.ip, devices.ip),
      mac         = COALESCE(excluded.mac, devices.mac),
      dps_schema  = COALESCE(excluded.dps_schema, devices.dps_schema),
      updated_at  = strftime('%s','now')
  `).run({
    deviceid: d.deviceid,
    local_key: d.localKey || d.local_key,
    protocol: d.protocol || '3.3',
    product_id: d.product_id || null,
    product_key: d.product_key || null,
    category: d.category || null,
    name: d.name || null,
    ip: d.ip || null,
    mac: d.mac || null,
    dps_schema: d.dps_schema ? JSON.stringify(d.dps_schema) : null,
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

function updateSettings(deviceid, { name, ha_category, mqtt_active }) {
  const sets = [];
  const args = [];
  if (name !== undefined && name !== null) { sets.push('name = ?'); args.push(name); }
  if (ha_category !== undefined && ha_category !== null) { sets.push('ha_category = ?'); args.push(ha_category); }
  if (mqtt_active !== undefined && mqtt_active !== null) { sets.push('mqtt_active = ?'); args.push(mqtt_active ? 1 : 0); }
  if (!sets.length) return;
  sets.push("updated_at = strftime('%s','now')");
  args.push(deviceid);
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE deviceid = ?`).run(...args);
}

function removeDevice(deviceid) {
  db.prepare('DELETE FROM devices WHERE deviceid = ?').run(deviceid);
}

function updateChannelsConfig(deviceid, channelsConfig) {
  db.prepare("UPDATE devices SET channels_config=?, updated_at=strftime('%s','now') WHERE deviceid=?")
    .run(JSON.stringify(channelsConfig || {}), deviceid);
}

module.exports = {
  init, upsertDevice, listDevices, getDevice,
  updateIp, updateSettings, removeDevice, updateChannelsConfig,
  get DB_PATH() { return DB_PATH; },
};

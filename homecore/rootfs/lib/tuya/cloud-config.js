// Persistência das credenciais Tuya Cloud em data/tuya-cloud.json.
// Permite o cliente HomeCore guardar Access ID/Secret/Region uma vez
// e reusar em todas as inclusões — sem expor as credenciais nas requests.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.TUYA_CLOUD_CONFIG || path.join(__dirname, '..', '..', 'data', 'tuya-cloud.json');

function get() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data.access_id || !data.access_secret) return null;
    return data;
  } catch { return null; }
}

function set({ access_id, access_secret, region }) {
  if (!access_id || !access_secret) throw new Error('access_id e access_secret obrigatórios');
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ access_id, access_secret, region: region || 'us', saved_at: Date.now() }, null, 2),
    { mode: 0o600 },
  );
  return true;
}

function clear() {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
}

function configured() {
  return !!get();
}

module.exports = { get, set, clear, configured, get CONFIG_PATH() { return CONFIG_PATH; } };

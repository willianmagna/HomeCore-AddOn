const fs = require('fs');
const path = require('path');
const { BroadlinkDevice, discover: broadlinkDiscover } = require('./broadlink');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CODES_DIR = path.join(DATA_DIR, 'smartir');
const LIBRARY_MANIFEST_FILE = path.join(CODES_DIR, '.library_manifest.json');
const DEVICES_FILE = path.join(DATA_DIR, 'ir-devices.json');
const EMITTERS_FILE = path.join(DATA_DIR, 'devices.json');

// IDs 1000-8999 = sincronizados do GitHub (HomeCoreIR), 9000+ = capturados localmente
const GITHUB_REPO = 'willianmagna/HomeCoreIR';
const LIBRARY_ID_BASE = 1000;
const LIBRARY_ID_MAX = 8999;
const LOCAL_ID_BASE = 9000;

// ── storage ──

function loadJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  return fallback;
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function loadDevices() {
  return loadJSON(DEVICES_FILE, { devices: [] }).devices;
}
function saveDevices(devices) {
  saveJSON(DEVICES_FILE, { devices });
}

function loadEmitters() {
  return loadJSON(EMITTERS_FILE, { devices: [] }).devices;
}

function loadLibraryManifest() {
  return loadJSON(LIBRARY_MANIFEST_FILE, {});
}
function saveLibraryManifest(map) {
  fs.mkdirSync(CODES_DIR, { recursive: true });
  saveJSON(LIBRARY_MANIFEST_FILE, map);
}

function listCodeFiles() {
  const manifest = loadLibraryManifest();
  try {
    return fs.readdirSync(CODES_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => {
        const full = path.join(CODES_DIR, f);
        const id = f.replace(/\.json$/, '');
        const num = parseInt(id, 10);
        const isLocal = !isNaN(num) && num >= LOCAL_ID_BASE;
        try {
          const d = JSON.parse(fs.readFileSync(full, 'utf-8'));
          return {
            id,
            source: isLocal ? 'local' : 'github',
            github_filename: manifest[id] || null,
            device_type: inferDeviceType(d),
            manufacturer: d.manufacturer || '',
            models: d.supportedModels || [],
            encoding: d.commandsEncoding || 'Base64',
            operationModes: d.operationModes,
            fanModes: d.fanModes,
            swingModes: d.swingModes,
            minTemperature: d.minTemperature,
            maxTemperature: d.maxTemperature,
            precision: d.precision,
          };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

function inferDeviceType(codeJson) {
  if (codeJson.operationModes && codeJson.minTemperature != null) return 'climate';
  if (codeJson.sources || codeJson.commands?.volumeUp) return 'media_player';
  return 'remote';
}

function loadCodeFile(id) {
  const file = path.join(CODES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// ── broadlink emitter pool (reuse connections) ──

const emitterPool = new Map();

function macKey(mac) {
  return String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
}

async function getEmitter(mac) {
  const key = macKey(mac);
  if (emitterPool.has(key)) return emitterPool.get(key);
  const info = loadEmitters().find((e) => macKey(e.mac) === key);
  if (!info) throw new Error(`Emissor Broadlink ${mac} não encontrado em devices.json`);
  const dev = new BroadlinkDevice({
    host: info.host,
    mac: info.mac,
    devType: info.devType,
    port: 80,
  });
  emitterPool.set(key, dev);
  return dev;
}

async function transmit(mac, base64Code) {
  if (!base64Code) throw new Error('Código IR vazio');
  const dev = await getEmitter(mac);
  if (!dev.authenticated) await dev.auth();
  const buf = Buffer.from(base64Code, 'base64');
  await dev.sendData(buf);
}

// ── state resolution (climate) ──

function resolveClimateCode(codeJson, state) {
  const { commands } = codeJson;
  if (!commands) return null;
  if (state.power === 'off' || state.hvac_mode === 'off') return commands.off;

  const mode = state.hvac_mode;
  const fan = state.fan_mode || 'auto';
  const temp = String(state.temperature ?? codeJson.minTemperature);
  const swing = state.swing_mode;

  const modeBlock = commands[mode];
  if (!modeBlock) return commands.on || null;
  if (typeof modeBlock === 'string') return modeBlock;

  // climate com fan + temp: commands[mode][fan][temp]
  // ou com swing: commands[mode][fan][swing][temp]
  // ou só mode: commands[mode]
  let node = modeBlock[fan] ?? modeBlock;
  if (node && typeof node === 'object' && swing && node[swing]) node = node[swing];
  if (node && typeof node === 'object' && node[temp]) return node[temp];
  if (typeof node === 'string') return node;
  return null;
}

function resolveMediaPlayerCode(codeJson, command) {
  // command: 'on' | 'off' | 'volume_up' | 'mute' | source_name | etc.
  const { commands, sources } = codeJson;
  if (!commands) return null;
  if (commands[command]) return commands[command];
  if (sources && sources[command]) return sources[command];
  return null;
}

function resolveRemoteCode(codeJson, button) {
  const { commands } = codeJson;
  return commands?.[button] || null;
}

// ── public API ──

function getLibrary() { return listCodeFiles(); }

function getCodeDetails(id) {
  const raw = loadCodeFile(id);
  if (!raw) return null;
  return { id, ...raw };
}

function getCodeRaw(id) {
  const file = path.join(CODES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function saveCodeRaw(id, rawText, opts = {}) {
  // valida JSON antes
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (e) { throw new Error('JSON inválido: ' + e.message); }
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('ID inválido (use só letras/números/_/-)');
  // campos mínimos: só exige existência das chaves (aceita valores vazios em template)
  if (!('manufacturer' in parsed)) throw new Error('Campo "manufacturer" ausente');
  if (!parsed.commands || typeof parsed.commands !== 'object') throw new Error('Campo "commands" ausente (objeto)');
  // bloqueio extra só se explicitamente strict (uso externo, não template):
  if (opts.strict) {
    if (!parsed.manufacturer) throw new Error('Campo "manufacturer" não pode ser vazio');
  }
  const file = path.join(CODES_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf-8');
  return parsed;
}

function deleteCode(id) {
  // bloqueia se algum device usa
  const inUse = loadDevices().filter((d) => d.code_file === id);
  if (inUse.length) {
    throw new Error(`Em uso por: ${inUse.map((d) => d.name).join(', ')}. Remova os dispositivos primeiro.`);
  }
  const file = path.join(CODES_DIR, `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function nextCodeId() {
  // Captura/import local sempre aloca a partir de 9000.
  const existing = listCodeFiles()
    .map((c) => parseInt(c.id, 10))
    .filter((n) => !isNaN(n) && n >= LOCAL_ID_BASE);
  const max = existing.length ? Math.max(...existing) : LOCAL_ID_BASE - 1;
  return String(max + 1);
}

async function syncLibraryFromGitHub() {
  // Lista arquivos .json na raiz do repo, baixa cada um e regrava em CODES_DIR
  // com IDs sequenciais 1000+. Substitui o conteudo anterior do range 1000-8999.
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/`;
  const r = await fetch(apiUrl, { headers: { 'User-Agent': 'HomeCore' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${r.statusText}`);
  const entries = await r.json();
  const files = entries
    .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(CODES_DIR, { recursive: true });

  // Wipe range 1000-8999
  for (const f of fs.readdirSync(CODES_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const n = parseInt(f.replace(/\.json$/, ''), 10);
    if (!isNaN(n) && n >= LIBRARY_ID_BASE && n <= LIBRARY_ID_MAX) {
      fs.unlinkSync(path.join(CODES_DIR, f));
    }
  }

  const manifest = {};
  let id = LIBRARY_ID_BASE;
  let imported = 0;
  const errors = [];
  for (const f of files) {
    if (id > LIBRARY_ID_MAX) { errors.push(`limite ${LIBRARY_ID_MAX} atingido`); break; }
    try {
      const raw = await fetch(f.download_url, { headers: { 'User-Agent': 'HomeCore' } });
      if (!raw.ok) throw new Error(`HTTP ${raw.status}`);
      const text = await raw.text();
      JSON.parse(text); // valida
      fs.writeFileSync(path.join(CODES_DIR, `${id}.json`), text, 'utf-8');
      manifest[String(id)] = f.name;
      imported++;
      id++;
    } catch (e) {
      errors.push(`${f.name}: ${e.message}`);
    }
  }
  saveLibraryManifest(manifest);
  return { imported, total: files.length, errors, repo: GITHUB_REPO };
}

function importCodeFromText(rawText, suggestedId) {
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (e) { throw new Error('JSON inválido: ' + e.message); }
  if (!parsed.manufacturer) throw new Error('Campo "manufacturer" obrigatório no arquivo');
  if (!parsed.commands) throw new Error('Campo "commands" obrigatório no arquivo');

  let id = String(suggestedId || '').replace(/[^a-z0-9_-]/gi, '');
  if (!id) id = nextCodeId();
  // evita sobrescrever existente
  while (fs.existsSync(path.join(CODES_DIR, `${id}.json`))) {
    id = nextCodeId();
  }
  saveCodeRaw(id, JSON.stringify(parsed, null, 2));
  return id;
}

function createEmptyCode(deviceType = 'climate') {
  const id = nextCodeId();
  const template = deviceType === 'climate' ? {
    manufacturer: '',
    supportedModels: [''],
    supportedController: 'Broadlink',
    commandsEncoding: 'Base64',
    minTemperature: 16,
    maxTemperature: 30,
    precision: 1,
    operationModes: ['cool', 'heat', 'fan_only', 'auto'],
    fanModes: ['low', 'mid', 'high', 'auto'],
    commands: {
      off: '',
      cool: { auto: { '22': '' } },
    },
  } : deviceType === 'media_player' ? {
    manufacturer: '',
    supportedModels: [''],
    supportedController: 'Broadlink',
    commandsEncoding: 'Base64',
    sources: {},
    commands: { on: '', off: '', volume_up: '', volume_down: '', mute: '' },
  } : {
    manufacturer: '',
    supportedModels: [''],
    supportedController: 'Broadlink',
    commandsEncoding: 'Base64',
    commands: {},
  };
  saveCodeRaw(id, JSON.stringify(template, null, 2));
  return id;
}

function getEmitters() {
  return loadEmitters().map((e) => ({ name: e.name, mac: e.mac, host: e.host, live: !!e.live, last_seen: e.last_seen }));
}

function normalizeMac(hex) {
  // recebe 'aabbccddeeff' e devolve 'aa:bb:cc:dd:ee:ff'
  const clean = String(hex).replace(/[^0-9a-f]/gi, '').toLowerCase();
  return clean.match(/.{2}/g)?.join(':') || hex;
}

async function arpScanBroadlinks() {
  const { execSync } = require('child_process');
  const BROADLINK_OUIS = ['24:df:a7', '34:ea:34', 'a0:43:b0', 'ec:0b:ae', '78:0f:77', '34:ea:e7', 'b4:e6:2d'];
  let arpOut = '';
  try { arpOut = execSync('ip neigh', { timeout: 3000 }).toString(); } catch { return []; }
  const candidates = [];
  for (const line of arpOut.split('\n')) {
    const m = line.match(/^(\S+)\s+.*lladdr\s+(\S+)/);
    if (!m) continue;
    const [, ip, mac] = m;
    if (!BROADLINK_OUIS.some((oui) => mac.toLowerCase().startsWith(oui))) continue;
    candidates.push({ host: ip, mac: mac.toLowerCase() });
  }

  // tenta auth em cada com devTypes comuns (RM4 Pro / RM Mini / etc.)
  const COMMON_DEV_TYPES = [24374, 0x649b, 0x520b, 0x648d, 0x61a2, 0x62bc, 0x6284];
  const results = [];
  for (const c of candidates) {
    for (const devType of COMMON_DEV_TYPES) {
      const dev = new BroadlinkDevice({ host: c.host, mac: c.mac, devType, port: 80 });
      try {
        await dev.auth();
        results.push({ host: c.host, mac: c.mac, devType });
        break;
      } catch { /* tenta próximo devType */ }
    }
  }
  return results;
}

async function discoverEmitters(timeoutMs = 4000) {
  let found = await broadlinkDiscover(timeoutMs);
  if (!found.length) {
    // Fallback: ARP + auth probe
    found = await arpScanBroadlinks();
  }
  const now = Date.now();
  const discovered = found.map((d) => ({
    mac: normalizeMac(d.mac),
    host: d.host,
    devType: d.devType,
    live: true,
    last_seen: now,
  }));

  // merge into devices.json (keep names, update host, flag live)
  const current = loadEmitters();
  const byMac = new Map(current.map((e) => [normalizeMac(e.mac), e]));
  for (const d of discovered) {
    const existing = byMac.get(d.mac);
    if (existing) {
      existing.host = d.host;
      existing.devType = d.devType;
      existing.live = true;
      existing.last_seen = now;
    } else {
      byMac.set(d.mac, { name: `Broadlink ${d.host}`, mac: d.mac, host: d.host, devType: d.devType, live: true, last_seen: now });
    }
  }
  // stale: existed but não apareceu → live: false (mantém no file)
  const discoveredMacs = new Set(discovered.map((d) => d.mac));
  for (const [mac, e] of byMac.entries()) {
    if (!discoveredMacs.has(mac)) {
      e.live = false;
    }
  }
  const merged = Array.from(byMac.values());
  saveJSON(EMITTERS_FILE, { devices: merged });

  // limpa pool de conexões pra devices cujo IP mudou
  emitterPool.clear();

  return merged.map((e) => ({ name: e.name, mac: e.mac, host: e.host, live: !!e.live, last_seen: e.last_seen }));
}

function removeEmitter(mac) {
  const key = normalizeMac(mac);
  const list = loadEmitters().filter((e) => normalizeMac(e.mac) !== key);
  saveJSON(EMITTERS_FILE, { devices: list });
  emitterPool.delete(macKey(mac));
}

function getDevices() {
  const devices = loadDevices();
  return devices.map((d) => ({ ...d, code_meta: listCodeFiles().find((c) => c.id === d.code_file) }));
}

function getDevice(id) {
  return loadDevices().find((d) => d.id === id);
}

function upsertDevice(device) {
  const devices = loadDevices();
  const idx = devices.findIndex((d) => d.id === device.id);
  const code = loadCodeFile(device.code_file);
  if (!code) throw new Error(`Code file ${device.code_file} não encontrado`);
  const device_type = inferDeviceType(code);
  const existing = idx >= 0 ? devices[idx] : null;
  const normalized = {
    id: device.id,
    type: device_type,
    name: device.name,
    area: device.area || null,
    code_file: device.code_file,
    emitter_mac: device.emitter_mac,
    // temp_sensor: friendly_name do device Zigbee (ex: "ar_quarto_sensor"). Só aplica a climate.
    temp_sensor: device_type === 'climate'
      ? (device.temp_sensor !== undefined ? (device.temp_sensor || null) : (existing?.temp_sensor || null))
      : null,
    state: device.state || defaultState(device_type, code),
  };
  if (idx >= 0) devices[idx] = normalized;
  else devices.push(normalized);
  saveDevices(devices);
  // anexa code_meta pra quem publica discovery já ter tudo
  const meta = listCodeFiles().find((c) => c.id === normalized.code_file);
  const result = { ...normalized, code_meta: meta };
  notify(result);
  return result;
}

function removeDevice(id) {
  const devices = loadDevices().filter((d) => d.id !== id);
  saveDevices(devices);
  notify({ id, removed: true });
}

function defaultState(type, codeJson) {
  if (type === 'climate') {
    return {
      hvac_mode: 'off',
      temperature: codeJson.minTemperature || 22,
      fan_mode: (codeJson.fanModes || ['auto'])[0],
      swing_mode: (codeJson.swingModes || [])[0] || null,
    };
  }
  if (type === 'media_player') {
    return { power: 'off', volume_level: 0.5, source: null, muted: false };
  }
  return { last_command: null };
}

async function applyState(deviceId, newState) {
  const devices = loadDevices();
  const d = devices.find((x) => x.id === deviceId);
  if (!d) throw new Error(`Device IR ${deviceId} não encontrado`);
  const code = loadCodeFile(d.code_file);
  if (!code) throw new Error(`Code ${d.code_file} não encontrado`);

  d.state = { ...d.state, ...newState };

  let b64 = null;
  if (d.type === 'climate') b64 = resolveClimateCode(code, d.state);
  if (!b64) throw new Error('Não encontrei código para esse estado');

  await transmit(d.emitter_mac, b64);
  saveDevices(devices);
  return d;
}

async function sendCommand(deviceId, command) {
  const devices = loadDevices();
  const d = devices.find((x) => x.id === deviceId);
  if (!d) throw new Error(`Device IR ${deviceId} não encontrado`);
  const code = loadCodeFile(d.code_file);
  if (!code) throw new Error(`Code ${d.code_file} não encontrado`);

  let b64 = null;
  if (d.type === 'media_player') b64 = resolveMediaPlayerCode(code, command);
  else if (d.type === 'remote') b64 = resolveRemoteCode(code, command);
  else if (d.type === 'climate') {
    // comandos diretos do climate ('off' / 'on')
    b64 = code.commands?.[command];
  }
  if (!b64) throw new Error(`Comando "${command}" não tem código`);

  await transmit(d.emitter_mac, b64);

  // state update for simple commands
  if (d.type === 'media_player') {
    if (command === 'on' || command === 'off') d.state.power = command;
    if (command === 'mute') d.state.muted = !d.state.muted;
    if (command.startsWith('source_')) d.state.source = command.replace('source_', '');
  } else if (d.type === 'remote') {
    d.state.last_command = command;
  } else if (d.type === 'climate') {
    if (command === 'off') d.state.hvac_mode = 'off';
  }
  saveDevices(devices);
  return d;
}

// Hook pra ir-mqtt notificar mudanças
const listeners = new Set();
function onDeviceChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify(d) { for (const fn of listeners) { try { fn(d); } catch {} } }
const origApply = applyState;
async function applyStateNotify(id, s) { const r = await origApply(id, s); notify(r); return r; }
const origCmd = sendCommand;
async function sendCommandNotify(id, c) { const r = await origCmd(id, c); notify(r); return r; }

module.exports = {
  getLibrary,
  getCodeDetails,
  getCodeRaw,
  saveCodeRaw,
  deleteCode,
  createEmptyCode,
  importCodeFromText,
  getEmitters,
  discoverEmitters,
  removeEmitter,
  getDevices,
  getDevice,
  upsertDevice,
  removeDevice,
  applyState: applyStateNotify,
  sendCommand: sendCommandNotify,
  onDeviceChange,
  syncLibraryFromGitHub,
  nextCodeId,
};

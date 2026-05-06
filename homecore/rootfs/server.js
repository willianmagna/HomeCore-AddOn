/**
 * HomeCore Server
 *
 * Servidor Express + WebSocket para automação residencial.
 * Roda na rede local, comunica com Broadlink RM via UDP.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { BroadlinkDevice, discover, broadlinkToSendir } = require('./lib/broadlink');
const zigbee = require('./lib/zigbee');
const zigbeeOverrides = require('./lib/zigbee-overrides');
const ha = require('./lib/ha');
const ir = require('./lib/ir');
const irMqtt = require('./lib/ir-mqtt');
const sonoffWifi = require('./lib/sonoff');
const sonoffRoutes = require('./lib/sonoff/routes');
const tuyaWifi = require('./lib/tuya');
const tuyaRoutes = require('./lib/tuya/routes');
const areas = require('./lib/areas');

// ─── Config ───
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CODES_FILE = path.join(DATA_DIR, 'codes.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const SMARTIR_DIR = path.join(DATA_DIR, 'smartir');

// Garante que os diretórios existem
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SMARTIR_DIR)) fs.mkdirSync(SMARTIR_DIR, { recursive: true });

// ─── Dados persistidos ───

function loadJSON(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return fallback;
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Configurações de dispositivos salvos (IP, MAC, tipo)
let savedDevices = loadJSON(DEVICES_FILE, { devices: [] });

// Códigos IR salvos: { "dispositivo_id": { "botoes": { "nome": { b64, sendir } } } }
let savedCodes = loadJSON(CODES_FILE, {});

// Favoritos: { "mac_normalizado": { name, mac, devType, host, model, savedAt } }
let favorites = loadJSON(FAVORITES_FILE, {});

// Cache de dispositivos Broadlink conectados
const connectedDevices = new Map();

// ─── Express App ───
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Zigbee (Z2M) routes ───
zigbee.start();
ha.connect();

// ─── Wi-Fi (Sonoff) ───
sonoffWifi.init();
sonoffRoutes.mount(app);

// ─── Wi-Fi (Tuya) ───
tuyaWifi.init();
tuyaRoutes.mount(app);

// ─── Áreas locais (andares + cômodos) ───
app.get('/api/areas', (req, res) => res.json(areas.getAll()));
app.post('/api/areas/floors', (req, res) => {
  try { res.json({ floors: areas.upsertFloor(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/areas/floors/:id', (req, res) => {
  try { areas.deleteFloor(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/areas/rooms', (req, res) => {
  try { res.json({ rooms: areas.upsertRoom(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/areas/rooms/:id', (req, res) => {
  try { areas.deleteRoom(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/zigbee/temp-sensors', (req, res) => {
  const devs = zigbee.getDevices() || [];
  const sensors = devs
    .filter((d) => d.state && 'temperature' in d.state)
    .map((d) => ({
      friendly_name: d.friendly_name,
      ieee_address: d.ieee_address,
      display_name: d.display_name,
      area: d.area,
      temperature: d.state?.temperature,
      humidity: d.state?.humidity,
      battery: d.state?.battery,
    }));
  res.json({ sensors });
});

app.get('/api/zigbee/areas', async (req, res) => {
  try {
    const areas = await ha.listAreas();
    res.json({ areas: areas.map((a) => ({ id: a.area_id, name: a.name })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── IR routes ───
irMqtt.start();

app.get('/api/ir/library', (req, res) => res.json({ codes: ir.getLibrary() }));
app.get('/api/ir/library/:id', (req, res) => {
  const d = ir.getCodeDetails(req.params.id);
  if (!d) return res.status(404).json({ error: 'não encontrado' });
  res.json(d);
});
app.get('/api/ir/library/:id/raw', (req, res) => {
  const raw = ir.getCodeRaw(req.params.id);
  if (raw == null) return res.status(404).json({ error: 'não encontrado' });
  res.type('application/json').send(raw);
});
app.put('/api/ir/library/:id', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsed = ir.saveCodeRaw(req.params.id, body);
    res.json({ ok: true, id: req.params.id, parsed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ir/library', (req, res) => {
  try {
    if (req.body?.content) {
      // Upload: conteúdo JSON enviado direto
      const id = ir.importCodeFromText(req.body.content, req.body.suggested_id);
      return res.json({ id, imported: true });
    }
    const id = ir.createEmptyCode(req.body?.device_type || 'climate');
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/ir/library/:id', (req, res) => {
  try { ir.deleteCode(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ir/library/sync', async (req, res) => {
  try {
    const result = await ir.syncLibraryFromGitHub();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Sobrescreve o nome auto-descoberto pelo nome dado no incorporamento (favorites)
function withFavoriteNames(emitters) {
  return emitters.map((e) => {
    const id = (e.mac || '').replace(/[: ]/g, '').toLowerCase();
    const fav = favorites[id];
    return fav ? { ...e, name: fav.name } : e;
  });
}
app.get('/api/ir/emitters', (req, res) => res.json({ emitters: withFavoriteNames(ir.getEmitters()) }));
app.post('/api/ir/emitters/discover', async (req, res) => {
  try {
    const emitters = await ir.discoverEmitters(req.body?.timeout || 4000);
    res.json({ emitters: withFavoriteNames(emitters) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/ir/emitters/:mac', (req, res) => {
  try { ir.removeEmitter(req.params.mac); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ir/devices', (req, res) => res.json({ devices: ir.getDevices() }));

app.post('/api/ir/devices', (req, res) => {
  try {
    const d = ir.upsertDevice(req.body);
    irMqtt.publishDiscovery(d);
    irMqtt.publishState(d);
    res.json(d);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/ir/devices/:id', (req, res) => {
  try {
    ir.removeDevice(req.params.id);
    irMqtt.unpublish(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ir/devices/:id/state', async (req, res) => {
  try { res.json(await ir.applyState(req.params.id, req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ir/devices/:id/command', async (req, res) => {
  try { res.json(await ir.sendCommand(req.params.id, req.body?.command)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/zigbee/update', async (req, res) => {
  try {
    const { ieee_address, device_name, room_id, entities } = req.body || {};
    if (!ieee_address) return res.status(400).json({ error: 'ieee_address obrigatório' });
    if (!ha.hasToken()) return res.status(400).json({ error: 'HA_TOKEN não configurado. Gere um Long-Lived Token no HA e configure no .env do HomeCore.' });

    const device = await ha.findDeviceByIeee(ieee_address);
    if (!device) return res.status(404).json({ error: 'Device não encontrado no HA' });

    if (device_name !== undefined) zigbeeOverrides.setDeviceName(ieee_address, device_name);
    if (room_id !== undefined) zigbeeOverrides.setDeviceRoom(ieee_address, room_id || null);

    // Se o friendly_name do z2m ainda é o próprio IEEE (nunca renomeado),
    // renomeia pra um slug do device_name. Mexer só nesse caso evita quebrar
    // automações que já referenciam um friendly_name custom.
    if (device_name) {
      const cur = (zigbee.getDevices() || []).find((x) => x.ieee_address === ieee_address);
      if (cur && cur.friendly_name === ieee_address) {
        const slug = String(device_name)
          .normalize('NFD').replace(/\p{Diacritic}/gu, '')
          .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (slug && slug !== ieee_address) {
          try { await zigbee.renameDevice(ieee_address, slug); }
          catch (e) { console.warn('[zigbee] rename z2m falhou:', e.message); }
        }
      }
    }

    const roomById = Object.fromEntries(areas.listRooms().map((r) => [r.id, r]));
    const results = { entities: [] };
    const entityRooms = []; // pra decidir prefixo no device.name_by_user

    if (Array.isArray(entities)) {
      for (const ent of entities) {
        const eid = ent?.entity_id;
        if (!eid) continue;
        const patch = {};
        if (ent.room_id !== undefined) patch.room_id = ent.room_id || null;
        if (ent.name !== undefined) patch.name = ent.name || null;
        zigbeeOverrides.setEntity(ieee_address, eid, patch);

        const haUpdates = {};
        if (ent.name !== undefined) haUpdates.name = ent.name || null;
        if (ent.room_id !== undefined) {
          let areaId = null;
          if (ent.room_id) {
            const room = roomById[ent.room_id];
            if (room) {
              const ensured = await ha.ensureArea(room.name);
              areaId = ensured?.area_id || null;
            }
          }
          haUpdates.area_id = areaId;
          entityRooms.push(ent.room_id || null);
        }
        if (Object.keys(haUpdates).length) {
          const r = await ha.updateEntity(eid, haUpdates);
          results.entities.push({ entity_id: eid, ...haUpdates, ha: r });
        }
      }
    }

    // Device name_by_user + area_id:
    // - Se todas as saídas estão no MESMO cômodo, usa esse pra prefixo + area_id do device.
    // - Senão, se há room_id device-level (ex: sensor sem saídas), usa esse.
    // - Senão, sem prefixo e area_id null.
    const ovrAfter = zigbeeOverrides.get(ieee_address) || {};
    const baseName = ovrAfter.device_name || null;
    const ents = Object.values(ovrAfter.entities || {});
    const entRooms = ents.map((e) => e.room_id || null).filter((x) => x);
    let resolvedRoomId = null;
    if (entRooms.length && new Set(entRooms).size === 1) {
      resolvedRoomId = entRooms[0];
    } else if (!entRooms.length && ovrAfter.device_room_id) {
      resolvedRoomId = ovrAfter.device_room_id;
    }
    let resolvedRoomName = null;
    let resolvedAreaId = null;
    if (resolvedRoomId) {
      const r = roomById[resolvedRoomId];
      if (r) {
        resolvedRoomName = r.name;
        const ensured = await ha.ensureArea(r.name);
        resolvedAreaId = ensured?.area_id || null;
      }
    }

    const deviceUpdates = { device_id: device.id };
    if (baseName != null) {
      deviceUpdates.name_by_user = resolvedRoomName ? `[${resolvedRoomName}] ${baseName}` : baseName;
    }
    if (room_id !== undefined) {
      // Mexeu no room device-level ou indireto via entidades — sempre alinha area_id.
      deviceUpdates.area_id = resolvedAreaId;
    }
    if (Object.keys(deviceUpdates).length > 1) {
      results.device = await ha.updateDevice(device.id, deviceUpdates);
    }

    res.json({ ok: true, ...results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/zigbee/state', (req, res) => {
  const snap = zigbee.getSnapshot();
  const ovr = zigbeeOverrides.getAll();
  const roomById = Object.fromEntries(areas.listRooms().map((r) => [r.id, r]));
  snap.devices = (snap.devices || []).map((d) => {
    const o = ovr[d.ieee_address] || {};
    const entOvr = o.entities || {};
    const controls = (d.controls || []).map((c) => {
      const eo = c.entity_id ? entOvr[c.entity_id] : null;
      return {
        ...c,
        room_id: eo?.room_id || null,
        entity_name: eo?.name || c.entity_name || null,
      };
    });
    // Resolve room_id device-level:
    //  1) se há saídas e todas concordam → usa essa
    //  2) senão usa o room_id device-level salvo no override (ex: sensores sem saídas)
    const rids = controls.map((c) => c.room_id).filter((x) => x);
    const entitiesWithEid = controls.filter((c) => c.entity_id);
    let resolvedRoom = null;
    if (rids.length && entitiesWithEid.length && rids.length === entitiesWithEid.length
        && new Set(rids).size === 1) {
      resolvedRoom = rids[0];
    } else if (o.device_room_id) {
      resolvedRoom = o.device_room_id;
    }
    const room = resolvedRoom ? roomById[resolvedRoom] : null;
    return {
      ...d,
      controls,
      room_id: resolvedRoom || null,
      base_name: o.device_name || d.display_name,
      area: room ? room.name : d.area,
    };
  });
  res.json(snap);
});

app.get('/api/zigbee/mesh', async (req, res) => {
  try {
    if (req.query.refresh === '1' || !zigbee.getNetworkmap()) {
      await zigbee.refreshNetworkmap();
    }
    res.json({ networkmap: zigbee.getNetworkmap(), devices: zigbee.getDevices() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/zigbee/pair-stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Histórico recente (últimos 5 min)
  const since = Date.now() - 5 * 60 * 1000;
  for (const evt of zigbee.getRecentPairEvents(since)) {
    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  }

  const unsub = zigbee.subscribePairEvents((evt) => {
    try {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    } catch {}
  });

  // Keepalive
  const ka = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ka);
    try { unsub(); } catch {}
    try { res.end(); } catch {}
  });
});

app.post('/api/zigbee/permit-join', async (req, res) => {
  try {
    const seconds = req.body?.seconds ?? 254;
    const r = seconds > 0 ? await zigbee.permitJoin(seconds) : await zigbee.stopJoin();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/zigbee/rename', async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });
    res.json(await zigbee.renameDevice(from, to));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/zigbee/remove', async (req, res) => {
  try {
    const { id, force } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    res.json(await zigbee.removeDevice(id, !!force));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/zigbee/reinterview', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id obrigatório' });
    res.json(await zigbee.reinterview(id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/zigbee/set', (req, res) => {
  try {
    const { friendly_name, payload } = req.body || {};
    if (!friendly_name || !payload) return res.status(400).json({ error: 'friendly_name e payload obrigatórios' });
    res.json(zigbee.setDevice(friendly_name, payload));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API Routes ───

/**
 * GET /api/discover
 * Descobre dispositivos Broadlink na rede local.
 */
app.get('/api/discover', async (req, res) => {
  try {
    const fresh = await discover(5000);

    // Dedupa por MAC (broadcasts duplicam respostas) e substitui cache.
    // Preserva customName por MAC.
    const oldByMac = {};
    for (const d of (savedDevices.devices || [])) {
      if (d.mac) oldByMac[d.mac.toLowerCase()] = d.customName;
    }
    const seen = new Set();
    savedDevices.devices = fresh
      .filter(d => {
        const key = (d.mac || '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(d => ({
        host: d.host,
        mac: d.mac,
        devType: d.devType,
        name: d.name,
        customName: oldByMac[d.mac.toLowerCase()] || undefined,
        live: true,
        last_seen: Date.now(),
      }));
    saveJSON(DEVICES_FILE, savedDevices);

    res.json({ ok: true, devices: savedDevices.devices });
  } catch (err) {
    res.json({ ok: false, erro: err.message });
  }
});

/**
 * GET /api/devices
 * Retorna dispositivos salvos.
 */
app.get('/api/devices', (req, res) => {
  res.json({ ok: true, devices: savedDevices.devices || [] });
});

/**
 * GET /api/codes
 * Retorna todos os códigos IR salvos.
 */
app.get('/api/codes', (req, res) => {
  res.json({ ok: true, codes: savedCodes });
});

/**
 * GET /api/codes/:deviceId
 * Retorna códigos de um dispositivo específico.
 */
app.get('/api/codes/:deviceId', (req, res) => {
  const codes = savedCodes[req.params.deviceId] || { botoes: {} };
  res.json({ ok: true, codes });
});

/**
 * POST /api/send
 * Envia um código IR pelo Broadlink.
 * Body: { deviceId, botao } ou { deviceId, b64 }
 */
app.post('/api/send', async (req, res) => {
  try {
    const { deviceId, botao, b64 } = req.body;

    // Resolve o código base64
    let codeB64 = b64;
    if (!codeB64 && botao && deviceId) {
      const deviceCodes = savedCodes[deviceId];
      if (deviceCodes && deviceCodes.botoes && deviceCodes.botoes[botao]) {
        codeB64 = deviceCodes.botoes[botao].b64;
      }
    }

    if (!codeB64) {
      return res.json({ ok: false, erro: 'Código IR não encontrado' });
    }

    // Conecta ao dispositivo
    const dev = await getDevice(deviceId);
    if (!dev) {
      return res.json({ ok: false, erro: 'Dispositivo não encontrado' });
    }

    const irData = Buffer.from(codeB64, 'base64');
    await dev.sendData(irData);

    res.json({ ok: true, mensagem: 'Comando enviado' });
  } catch (err) {
    res.json({ ok: false, erro: err.message });
  }
});

/**
 * POST /api/identify/:deviceId  body: { action: 'start' | 'stop' }
 * Pisca o LED do Broadlink em loop até receber action=stop.
 */
const identifyTasks = new Map(); // deviceId -> { stop: fn }
const IDENTIFY_DURATION_MS = 5000;

app.post('/api/identify/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const action = req.body?.action;
  if (action === 'stop') {
    const t = identifyTasks.get(deviceId);
    if (t) { t.stop(); identifyTasks.delete(deviceId); }
    return res.json({ ok: true, running: false });
  }
  if (action !== 'start') return res.json({ ok: false, erro: "action deve ser 'start' ou 'stop'" });
  if (identifyTasks.has(deviceId)) return res.json({ ok: true, running: true, already: true, durationMs: IDENTIFY_DURATION_MS });

  let dev;
  try {
    dev = await getDevice(deviceId);
  } catch (err) {
    console.error('[identify] auth falhou', deviceId, err.message);
    return res.json({ ok: false, erro: 'Falha de autenticação: ' + err.message });
  }
  if (!dev) return res.json({ ok: false, erro: 'Dispositivo não encontrado' });

  try {
    await dev.enterLearning();
  } catch (err) {
    console.error('[identify] enterLearning falhou', deviceId, err.message);
    return res.json({ ok: false, erro: 'Comando rejeitado: ' + err.message });
  }

  // Auto-stop após IDENTIFY_DURATION_MS — tenta cancelar o learning pra apagar o LED rápido.
  // Cmd 0x1e cancela learning de RF; em IR muitos firmwares também aceitam. Se rejeitar,
  // o LED apaga no timeout natural do firmware (~30s).
  const timer = setTimeout(async () => {
    identifyTasks.delete(deviceId);
    try { await dev._sendRm(0x1e); }
    catch (err) { console.error('[identify] cancel falhou', deviceId, err.message); }
  }, IDENTIFY_DURATION_MS);

  identifyTasks.set(deviceId, { stop: () => clearTimeout(timer) });
  res.json({ ok: true, running: true, durationMs: IDENTIFY_DURATION_MS });
});

/**
 * POST /api/ir/capture/:deviceId  body: { timeout? }
 * Aprende um único código IR e devolve o base64. Sem efeitos colaterais (não persiste).
 */
app.post('/api/ir/capture/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const timeout = Math.min(Math.max(+req.body?.timeout || 12, 3), 30);
  try {
    const dev = await getDevice(deviceId);
    if (!dev) return res.status(404).json({ ok: false, erro: 'Emissor não encontrado' });
    const irData = await dev.learnCode(timeout);
    if (!irData) return res.json({ ok: false, erro: 'Tempo esgotado, nenhum código recebido' });
    res.json({ ok: true, b64: irData.toString('base64') });
  } catch (err) {
    console.error('[capture]', deviceId, err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/api/identify/:deviceId', (req, res) => {
  res.json({ running: identifyTasks.has(req.params.deviceId) });
});

/**
 * DELETE /api/codes/:deviceId/:botao
 * Remove um botão de um dispositivo.
 */
app.delete('/api/codes/:deviceId/:botao', (req, res) => {
  const { deviceId, botao } = req.params;
  if (savedCodes[deviceId] && savedCodes[deviceId].botoes) {
    delete savedCodes[deviceId].botoes[botao];
    saveJSON(CODES_FILE, savedCodes);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, erro: 'Não encontrado' });
  }
});

/**
 * PUT /api/devices/:deviceId/name
 * Renomeia um dispositivo.
 */
app.put('/api/devices/:deviceId/name', (req, res) => {
  const { deviceId } = req.params;
  const { name } = req.body;

  const device = (savedDevices.devices || []).find(d => makeDeviceId(d) === deviceId);
  if (device) {
    device.customName = name;
    saveJSON(DEVICES_FILE, savedDevices);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, erro: 'Dispositivo não encontrado' });
  }
});

// ─── Favoritos ───

/**
 * GET /api/favorites
 * Retorna todos os favoritos.
 */
app.get('/api/favorites', (req, res) => {
  res.json({ ok: true, favorites });
});

/**
 * POST /api/favorites
 * Salva um dispositivo como favorito.
 * Body: { mac, name, devType, host, model }
 */
app.post('/api/favorites', (req, res) => {
  const { mac, name, devType, host, model } = req.body;
  if (!mac || !name) {
    return res.json({ ok: false, erro: 'MAC e nome sao obrigatorios' });
  }
  const id = mac.replace(/[: ]/g, '').toLowerCase();
  favorites[id] = {
    name,
    mac,
    devType: devType || 0,
    host: host || '',
    model: model || '',
    savedAt: new Date().toISOString(),
  };
  saveJSON(FAVORITES_FILE, favorites);
  res.json({ ok: true, id });
});

/**
 * PUT /api/favorites/:id
 * Atualiza o nome de um favorito.
 */
app.put('/api/favorites/:id', (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (favorites[id]) {
    favorites[id].name = name;
    saveJSON(FAVORITES_FILE, favorites);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, erro: 'Favorito nao encontrado' });
  }
});

/**
 * DELETE /api/favorites/:id
 * Remove um favorito.
 */
app.delete('/api/favorites/:id', (req, res) => {
  const { id } = req.params;
  if (favorites[id]) {
    delete favorites[id];
    saveJSON(FAVORITES_FILE, favorites);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, erro: 'Favorito nao encontrado' });
  }
});

// ─── SmartIR ───

/**
 * GET /api/smartir
 * Lista todos os arquivos SmartIR salvos.
 */
app.get('/api/smartir', (req, res) => {
  try {
    const files = fs.readdirSync(SMARTIR_DIR).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
      const data = loadJSON(path.join(SMARTIR_DIR, f), {});
      return {
        filename: f,
        type: data.operationModes ? 'climate' : 'media_player',
        manufacturer: data.manufacturer || '',
        supportedModels: data.supportedModels || [],
        commandCount: countSmartIRCommands(data),
      };
    });
    res.json({ ok: true, files: list });
  } catch (err) {
    res.json({ ok: false, erro: err.message });
  }
});

/**
 * GET /api/smartir/:filename
 * Retorna um arquivo SmartIR específico.
 */
app.get('/api/smartir/:filename', (req, res) => {
  const filePath = path.join(SMARTIR_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.json({ ok: false, erro: 'Arquivo nao encontrado' });
  }
  res.json({ ok: true, data: loadJSON(filePath, {}) });
});

/**
 * POST /api/smartir
 * Cria um novo arquivo SmartIR (metadados iniciais).
 * Body: { type, manufacturer, supportedModels, ... }
 */
app.post('/api/smartir', (req, res) => {
  try {
    const { type } = req.body;

    // Gera filename incremental
    const existing = fs.readdirSync(SMARTIR_DIR).filter(f => f.endsWith('.json'));
    const nums = existing.map(f => parseInt(f.replace('.json', ''), 10)).filter(n => !isNaN(n));
    const nextNum = nums.length ? Math.max(...nums) + 1 : 1000;
    const filename = nextNum + '.json';

    let data;
    if (type === 'climate') {
      data = {
        manufacturer: req.body.manufacturer || '',
        supportedModels: req.body.supportedModels || [],
        supportedController: 'Broadlink',
        commandsEncoding: 'Base64',
        minTemperature: req.body.minTemperature || 16,
        maxTemperature: req.body.maxTemperature || 30,
        precision: req.body.precision || 1,
        operationModes: req.body.operationModes || [],
        fanModes: req.body.fanModes || [],
        swingModes: req.body.swingModes || [],
        commands: {},
      };
      // Remove swingModes se vazio
      if (!data.swingModes.length) delete data.swingModes;
    } else {
      data = {
        manufacturer: req.body.manufacturer || '',
        supportedModels: req.body.supportedModels || [],
        supportedController: 'Broadlink',
        commandsEncoding: 'Base64',
        commands: {},
      };
    }

    saveJSON(path.join(SMARTIR_DIR, filename), data);
    res.json({ ok: true, filename, data });
  } catch (err) {
    res.json({ ok: false, erro: err.message });
  }
});

/**
 * PUT /api/smartir/:filename/command
 * Adiciona/atualiza um comando IR em um arquivo SmartIR.
 * Body: { path: ["cool","low","18"], code: "base64..." }
 *    ou { path: ["off"], code: "base64..." }
 *    ou { path: ["on"], code: "base64..." } (media_player)
 *    ou { path: ["sources","HDMI"], code: "base64..." } (media_player)
 */
app.put('/api/smartir/:filename/command', (req, res) => {
  try {
    const filePath = path.join(SMARTIR_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) {
      return res.json({ ok: false, erro: 'Arquivo nao encontrado' });
    }

    const data = loadJSON(filePath, {});
    const { path: cmdPath, code } = req.body;

    if (!cmdPath || !cmdPath.length || !code) {
      return res.json({ ok: false, erro: 'Path e code sao obrigatorios' });
    }

    if (!data.commands) data.commands = {};

    // Para comandos de nível único (off, on, mute, etc.)
    if (cmdPath.length === 1) {
      data.commands[cmdPath[0]] = code;
    } else {
      // Navegação profunda: commands.cool.low.18 etc.
      let obj = data.commands;
      for (let i = 0; i < cmdPath.length - 1; i++) {
        if (!obj[cmdPath[i]] || typeof obj[cmdPath[i]] === 'string') {
          obj[cmdPath[i]] = {};
        }
        obj = obj[cmdPath[i]];
      }
      obj[cmdPath[cmdPath.length - 1]] = code;
    }

    saveJSON(filePath, data);
    res.json({ ok: true, commandCount: countSmartIRCommands(data) });
  } catch (err) {
    res.json({ ok: false, erro: err.message });
  }
});

/**
 * DELETE /api/smartir/:filename
 * Remove um arquivo SmartIR.
 */
app.delete('/api/smartir/:filename', (req, res) => {
  const filePath = path.join(SMARTIR_DIR, req.params.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, erro: 'Arquivo nao encontrado' });
  }
});

/**
 * GET /api/smartir/:filename/download
 * Download do arquivo SmartIR.
 */
app.get('/api/smartir/:filename/download', (req, res) => {
  const filePath = path.join(SMARTIR_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Not found');
  }
  res.download(filePath);
});

function countSmartIRCommands(data) {
  let count = 0;
  function walk(obj) {
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.length > 0) count++;
      else if (typeof val === 'object' && val !== null && !Array.isArray(val)) walk(val);
      else if (Array.isArray(val)) count++;
    }
  }
  if (data.commands) walk(data.commands);
  return count;
}

// ─── Helpers ───

function makeDeviceId(device) {
  return device.mac.replace(/[: ]/g, '').toLowerCase();
}

async function getDevice(deviceId) {
  // Verifica cache
  if (connectedDevices.has(deviceId)) {
    const cached = connectedDevices.get(deviceId);
    if (cached.authenticated) return cached;
  }

  // Busca na lista salva
  const info = (savedDevices.devices || []).find(d => makeDeviceId(d) === deviceId);
  if (!info) return null;

  const dev = new BroadlinkDevice({
    host: info.host,
    mac: info.mac,
    devType: info.devType,
    name: info.customName || info.name,
  });

  await dev.auth();
  connectedDevices.set(deviceId, dev);
  return dev;
}

// ─── WebSocket (para aprendizado em tempo real) ───
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', erro: 'JSON inválido' }));
      return;
    }

    // ── Captura genérica (controle remoto) ──
    if (msg.type === 'learn') {
      // msg: { type: 'learn', deviceId, nome, grupo, timeout }
      try {
        const dev = await getDevice(msg.deviceId);
        if (!dev) {
          ws.send(JSON.stringify({ type: 'error', erro: 'Dispositivo não encontrado' }));
          return;
        }

        ws.send(JSON.stringify({ type: 'status', status: 'learning', mensagem: 'Aponte o controle para o Broadlink e pressione o botão...' }));

        const timeout = msg.timeout || 10;
        const irData = await dev.learnCode(timeout, (status) => {
          ws.send(JSON.stringify({ type: 'status', status }));
        });

        if (irData) {
          const b64 = irData.toString('base64');
          const sendir = broadlinkToSendir(irData);
          const nome = msg.nome || 'botao_' + Date.now();
          const deviceId = msg.deviceId;

          if (!savedCodes[deviceId]) {
            savedCodes[deviceId] = { botoes: {} };
          }
          savedCodes[deviceId].botoes[nome] = {
            b64,
            sendir,
            grupo: msg.grupo || '',
            criadoEm: new Date().toISOString(),
          };
          saveJSON(CODES_FILE, savedCodes);

          ws.send(JSON.stringify({
            type: 'learned',
            nome,
            b64,
            sendir,
            mensagem: `Código "${nome}" capturado e salvo!`,
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'timeout',
            mensagem: 'Nenhum código recebido. Tente novamente.',
          }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', erro: err.message }));
      }
    }

    // ── Captura SmartIR ──
    if (msg.type === 'learn_smartir') {
      // msg: { type: 'learn_smartir', deviceId, filename, path: [...], label, timeout }
      try {
        const dev = await getDevice(msg.deviceId);
        if (!dev) {
          ws.send(JSON.stringify({ type: 'error', erro: 'Dispositivo não encontrado' }));
          return;
        }

        const label = msg.label || msg.path.join(' > ');
        ws.send(JSON.stringify({ type: 'status', status: 'learning', mensagem: `Aguardando sinal: ${label}` }));

        const timeout = msg.timeout || 12;
        const irData = await dev.learnCode(timeout, (status) => {
          ws.send(JSON.stringify({ type: 'status', status }));
        });

        if (irData) {
          const b64 = irData.toString('base64');

          // Salva direto no arquivo SmartIR
          const filePath = path.join(SMARTIR_DIR, msg.filename);
          const data = loadJSON(filePath, {});
          if (!data.commands) data.commands = {};

          const cmdPath = msg.path;
          if (cmdPath.length === 1) {
            data.commands[cmdPath[0]] = b64;
          } else {
            let obj = data.commands;
            for (let i = 0; i < cmdPath.length - 1; i++) {
              if (!obj[cmdPath[i]] || typeof obj[cmdPath[i]] === 'string') {
                obj[cmdPath[i]] = {};
              }
              obj = obj[cmdPath[i]];
            }
            obj[cmdPath[cmdPath.length - 1]] = b64;
          }

          saveJSON(filePath, data);

          ws.send(JSON.stringify({
            type: 'learned_smartir',
            path: cmdPath,
            label,
            b64,
            commandCount: countSmartIRCommands(data),
            mensagem: `Capturado: ${label}`,
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'timeout',
            mensagem: `Timeout: ${msg.label || 'comando'}. Tente novamente.`,
          }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', erro: err.message }));
      }
    }
  });
});

// ─── Start ───
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        localIp = addr.address;
        break;
      }
    }
    if (localIp !== 'localhost') break;
  }

  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║           HomeCore está rodando!         ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:  http://localhost:${PORT}            ║`);
  console.log(`  ║  Rede:   http://${localIp}:${PORT}       ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});

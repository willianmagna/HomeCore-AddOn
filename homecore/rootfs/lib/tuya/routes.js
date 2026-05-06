// Rotas Express do Tuya.
const tuya = require('./index');
const bus = require('./state-bus');
const bridge = require('./mqtt-bridge');
const storage = require('./storage');
const cloudConfig = require('./cloud-config');
const { TuyaCloudClient, TuyaCloudError, normalizeDevice, REGION_HOSTS } = require('./cloud');

const VALID_HA_CATEGORIES = new Set(['switch', 'light', 'fan', 'outlet', 'cover', 'valve', 'siren', 'other']);

function sseHeaders(res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}
function sseSend(res, ev, data) {
  res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
}

function mount(app) {
  // ── Listing ──────────────────────────────────────────────────────────
  app.get('/api/tuya/devices', (req, res) => {
    res.json({
      devices: tuya.listDevicesWithLive(),
      mqtt_connected: bridge.connected,
    });
  });

  // ── State stream (SSE, mesmo padrão do Sonoff) ──────────────────────
  app.get('/api/tuya/devices/state/stream', (req, res) => {
    sseHeaders(res);
    for (const [did, st] of bus.states.entries()) {
      sseSend(res, 'state', { deviceid: did, dps: st.dps, online: st.online });
    }
    const unsub = bus.subscribe((u) => {
      sseSend(res, 'state', {
        deviceid: u.deviceid, dps: u.dps, online: u.online, event: u.event,
      });
    });
    req.on('close', () => { try { unsub(); } catch {} });
  });

  // ── Cloud config (Access ID/Secret/Region — usado pela inclusão) ────
  app.get('/api/tuya/cloud/status', (req, res) => {
    const cfg = cloudConfig.get();
    res.json({
      configured: !!cfg,
      region: cfg?.region || null,
      access_id_preview: cfg ? cfg.access_id.slice(0, 6) + '…' : null,
      saved_at: cfg?.saved_at || null,
    });
  });

  app.post('/api/tuya/cloud/setup', async (req, res) => {
    const { access_id, access_secret, region } = req.body || {};
    if (!access_id || !access_secret) {
      return res.status(400).json({ detail: 'access_id e access_secret obrigatórios' });
    }
    if (region && !REGION_HOSTS[region]) {
      return res.status(400).json({ detail: `region inválida; use ${Object.keys(REGION_HOSTS).join('|')}` });
    }
    // Valida fazendo um login pra confirmar que credenciais funcionam
    try {
      const client = new TuyaCloudClient({ accessId: access_id, accessSecret: access_secret, region: region || 'us' });
      await client.fetchToken();
    } catch (e) {
      return res.status(401).json({ detail: `validação falhou: ${e.message}` });
    }
    cloudConfig.set({ access_id, access_secret, region });
    res.json({ ok: true });
  });

  app.delete('/api/tuya/cloud/setup', (req, res) => {
    cloudConfig.clear();
    res.json({ ok: true });
  });

  // ── Listar devices da cloud (preview, sem incluir) ──────────────────
  app.get('/api/tuya/cloud/devices', async (req, res) => {
    const cfg = cloudConfig.get();
    if (!cfg) return res.status(409).json({ detail: 'Tuya Cloud não configurada — POST /api/tuya/cloud/setup primeiro' });
    try {
      const client = new TuyaCloudClient({ accessId: cfg.access_id, accessSecret: cfg.access_secret, region: cfg.region });
      const devices = await client.listAssociatedDevices();
      res.json({
        count: devices.length,
        devices: devices.map((d) => ({
          deviceid: d.id, name: d.name, ip: d.ip, online: d.online,
          product_id: d.product_id, category: d.category, has_local_key: !!d.local_key,
        })),
      });
    } catch (e) {
      res.status(e instanceof TuyaCloudError ? 502 : 500).json({ detail: e.message });
    }
  });

  // ── Inclusão real ───────────────────────────────────────────────────
  app.post('/api/tuya/include', async (req, res) => {
    const cfg = cloudConfig.get();
    if (!cfg) return res.status(409).json({ detail: 'Tuya Cloud não configurada' });
    try {
      const client = new TuyaCloudClient({ accessId: cfg.access_id, accessSecret: cfg.access_secret, region: cfg.region });
      const all = await client.listAssociatedDevices();
      // Aceita filter opcional — se vier `deviceids: [...]`, só esses entram.
      // Se não vier, importa todos os que têm local_key.
      const wanted = Array.isArray(req.body?.deviceids) && req.body.deviceids.length
        ? new Set(req.body.deviceids)
        : null;
      const normalized = all
        .filter((d) => d.local_key && (!wanted || wanted.has(d.id)))
        .map(normalizeDevice);
      const saved = tuya.includeDevicesFromCloud(normalized);
      const skipped = all.length - normalized.length;
      res.json({ saved, skipped, total: all.length });
    } catch (e) {
      res.status(e instanceof TuyaCloudError ? 502 : 500).json({ detail: e.message });
    }
  });

  // ── Switch (DP control) ─────────────────────────────────────────────
  app.post('/api/tuya/devices/:deviceid/switch', async (req, res) => {
    const state = String(req.body?.state || '').toLowerCase();
    if (!['on', 'off'].includes(state)) {
      return res.status(400).json({ detail: "state deve ser 'on' ou 'off'" });
    }
    if (!storage.getDevice(req.params.deviceid)) {
      return res.status(404).json({ detail: 'device não incluído' });
    }
    try {
      await tuya.sendDP(req.params.deviceid, 1, state === 'on');
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 502).json({ detail: e.message });
    }
  });

  // ── DP control genérico (lights, dimmer, etc) ───────────────────────
  app.post('/api/tuya/devices/:deviceid/dp', async (req, res) => {
    if (!storage.getDevice(req.params.deviceid)) {
      return res.status(404).json({ detail: 'device não incluído' });
    }
    const { dp, value, dps } = req.body || {};
    try {
      if (dps && typeof dps === 'object') {
        await tuya.sendDPs(req.params.deviceid, dps);
      } else if (dp !== undefined && value !== undefined) {
        await tuya.sendDP(req.params.deviceid, dp, value);
      } else {
        return res.status(400).json({ detail: 'forneça {dp,value} ou {dps:{...}}' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 502).json({ detail: e.message });
    }
  });

  // ── Settings ─────────────────────────────────────────────────────────
  app.patch('/api/tuya/devices/:deviceid', (req, res) => {
    const dev = storage.getDevice(req.params.deviceid);
    if (!dev) return res.status(404).json({ detail: 'device não incluído' });
    if (req.body.ha_category && !VALID_HA_CATEGORIES.has(req.body.ha_category)) {
      return res.status(400).json({ detail: 'ha_category inválida' });
    }
    storage.updateSettings(req.params.deviceid, {
      name: req.body.name,
      ha_category: req.body.ha_category,
    });
    // channels_config: { "1": { name, ha_category, room_id, object_id }, ... }
    if (req.body.channels_config && typeof req.body.channels_config === 'object') {
      const validated = {};
      for (const [dp, cfg] of Object.entries(req.body.channels_config)) {
        if (!cfg || typeof cfg !== 'object') continue;
        if (cfg.ha_category && !VALID_HA_CATEGORIES.has(cfg.ha_category)) {
          return res.status(400).json({ detail: `dp ${dp}: ha_category inválida (use uma de [${[...VALID_HA_CATEGORIES].join(', ')}])` });
        }
        validated[String(dp)] = {
          name: cfg.name || null,
          ha_category: cfg.ha_category || null,
          room_id: cfg.room_id || null,
          object_id: cfg.object_id || null,
        };
      }
      storage.updateChannelsConfig(req.params.deviceid, validated);
    }
    if (dev.mqtt_active) { try { bridge.republish(req.params.deviceid); } catch {} }
    res.json({ ok: true });
  });

  // ── MQTT toggle ─────────────────────────────────────────────────────
  app.post('/api/tuya/devices/:deviceid/mqtt', (req, res) => {
    if (!storage.getDevice(req.params.deviceid)) {
      return res.status(404).json({ detail: 'device não incluído' });
    }
    if (!bridge.connected) {
      return res.status(503).json({ detail: 'MQTT não conectado' });
    }
    if (req.body.active) bridge.activate(req.params.deviceid);
    else bridge.deactivate(req.params.deviceid);
    res.json({ ok: true, mqtt_active: !!req.body.active });
  });

  // ── Identify (blink) por canal ─────────────────────────────────────
  app.post('/api/tuya/devices/:deviceid/identify', (req, res) => {
    const { deviceid } = req.params;
    if (!storage.getDevice(deviceid)) {
      return res.status(404).json({ detail: 'device não incluído' });
    }
    const action = req.body?.action;
    const dp = parseInt(req.body?.dp ?? 1, 10);
    if (action === 'stop') {
      tuya.stopIdentify(deviceid, dp);
      return res.json({ ok: true, running: false, dp });
    }
    if (action !== 'start') {
      return res.status(400).json({ detail: "action deve ser 'start' ou 'stop'" });
    }
    const interval = Math.max(400, Math.min((req.body?.interval || 1.2) * 1000, 5000));
    const started = tuya.startIdentify(deviceid, dp, interval);
    res.json({ ok: true, running: true, dp, already: !started });
  });

  app.get('/api/tuya/devices/:deviceid/identify', (req, res) => {
    res.json({ running_dps: tuya.listIdentifyingDps(req.params.deviceid) });
  });

  // ── Remove ──────────────────────────────────────────────────────────
  app.delete('/api/tuya/devices/:deviceid', (req, res) => {
    tuya.removeDevice(req.params.deviceid);
    res.json({ ok: true });
  });
}

module.exports = { mount };

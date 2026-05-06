// Express routes para o subsistema Wi-Fi (Sonoff). Monta tudo sob /api/wifi.
const sonoff = require('./index');
const bus = require('./state-bus');
const bridge = require('./mqtt-bridge');
const storage = require('./storage');

const VALID_HA_CATEGORIES = new Set(['switch', 'light', 'fan', 'outlet', 'cover', 'valve', 'siren', 'other']);

function sseHeaders(res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function sseSend(res, eventName, data) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function mount(app) {
  // ── Discover (SSE) ────────────────────────────────────────────────────
  app.get('/api/wifi/discover/stream', async (req, res) => {
    sseHeaders(res);
    let closed = false;
    req.on('close', () => { closed = true; });
    try {
      for await (const evt of sonoff.scanner.discoverStream()) {
        if (closed) break;
        sseSend(res, evt.type || 'message', evt);
      }
    } catch (e) {
      if (!closed) sseSend(res, 'error', { message: e.message });
    } finally {
      try { res.end(); } catch {}
    }
  });

  // ── Inclusão ──────────────────────────────────────────────────────────
  app.post('/api/wifi/include', async (req, res) => {
    try {
      const result = await sonoff.include({
        email: req.body.email,
        password: req.body.password,
        region: req.body.region || 'us',
        countryCode: req.body.country_code || '+55',
        devices: req.body.devices || [],
      });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ detail: e.message });
    }
  });

  // ── Devices listing ───────────────────────────────────────────────────
  app.get('/api/wifi/devices', (req, res) => {
    res.json({
      devices: sonoff.listDevicesWithLive(),
      mqtt_connected: bridge.connected,
    });
  });

  // ── State stream (SSE) ────────────────────────────────────────────────
  app.get('/api/wifi/devices/state/stream', (req, res) => {
    sseHeaders(res);
    // snapshot inicial
    for (const [did, st] of bus.states.entries()) {
      sseSend(res, 'state', {
        deviceid: did, is_on: st.is_on, seq: st.seq, ip: st.ip, state: st.state,
      });
    }
    const unsub = bus.subscribe((update) => {
      sseSend(res, 'state', {
        deviceid: update.deviceid,
        is_on: update.is_on, seq: update.seq, ip: update.ip,
        state: update.state,
      });
    });
    req.on('close', () => { try { unsub(); } catch {} });
  });

  // ── Switch ────────────────────────────────────────────────────────────
  app.post('/api/wifi/devices/:deviceid/switch', async (req, res) => {
    const { deviceid } = req.params;
    const state = (req.body.state || '').toLowerCase();
    if (!['on', 'off'].includes(state)) {
      return res.status(400).json({ detail: "state deve ser 'on' ou 'off'" });
    }
    if (sonoff.isIdentifying(deviceid)) {
      return res.status(409).json({ detail: 'identify ativo — pare antes de comutar manualmente' });
    }
    try {
      const result = await sonoff.sendSwitch(deviceid, state, req.body.channel || 0);
      res.json({ ok: true, device_response: result });
    } catch (e) {
      res.status(e.status || 502).json({ detail: e.message });
    }
  });

  // ── Identify ──────────────────────────────────────────────────────────
  app.post('/api/wifi/devices/:deviceid/identify', (req, res) => {
    const { deviceid } = req.params;
    if (!storage.getDevice(deviceid)) {
      return res.status(404).json({ detail: 'device não incluído' });
    }
    const action = req.body.action;
    if (action === 'stop') {
      sonoff.stopIdentify(deviceid);
      return res.json({ ok: true, running: false });
    }
    if (action !== 'start') {
      return res.status(400).json({ detail: "action deve ser 'start' ou 'stop'" });
    }
    const interval = Math.max(400, Math.min((req.body.interval || 1.2) * 1000, 5000));
    const started = sonoff.startIdentify(deviceid, interval);
    res.json({ ok: true, running: true, already: !started });
  });

  app.get('/api/wifi/devices/:deviceid/identify', (req, res) => {
    res.json({ running: sonoff.isIdentifying(req.params.deviceid) });
  });

  // ── Patch (rename / change category) ──────────────────────────────────
  app.patch('/api/wifi/devices/:deviceid', (req, res) => {
    const { deviceid } = req.params;
    const dev = storage.getDevice(deviceid);
    if (!dev) return res.status(404).json({ detail: 'device não incluído' });
    if (req.body.ha_category && !VALID_HA_CATEGORIES.has(req.body.ha_category)) {
      return res.status(400).json({
        detail: `ha_category inválida; use uma de [${[...VALID_HA_CATEGORIES].join(', ')}]`,
      });
    }
    storage.updateSettings(deviceid, {
      name: req.body.name,
      ha_category: req.body.ha_category,
      room_id: req.body.room_id,
      object_id: req.body.object_id,
    });
    if (dev.mqtt_active) {
      try { bridge.republish(deviceid); } catch {}
    }
    res.json({ ok: true });
  });

  // ── MQTT toggle ───────────────────────────────────────────────────────
  app.post('/api/wifi/devices/:deviceid/mqtt', (req, res) => {
    const { deviceid } = req.params;
    if (!storage.getDevice(deviceid)) {
      return res.status(404).json({ detail: 'device não incluído' });
    }
    if (!bridge.connected) {
      return res.status(503).json({ detail: 'MQTT não conectado' });
    }
    if (req.body.active) bridge.activate(deviceid);
    else bridge.deactivate(deviceid);
    res.json({ ok: true, mqtt_active: !!req.body.active });
  });

  // ── Remove ────────────────────────────────────────────────────────────
  app.delete('/api/wifi/devices/:deviceid', (req, res) => {
    const { deviceid } = req.params;
    sonoff.stopIdentify(deviceid);
    try {
      if (bridge.connected) bridge.deactivate(deviceid);
    } catch {}
    storage.removeDevice(deviceid);
    res.json({ ok: true });
  });
}

module.exports = { mount };

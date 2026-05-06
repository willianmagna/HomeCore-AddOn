// Cliente TCP persistente pra device Tuya. Suporta protocolos v3.3 (legado) e v3.4 (HMAC).
//
// v3.3:
//   - AES-128-ECB com localKey (16 bytes ASCII)
//   - Frame com CRC32 antes do suffix
//   - CONTROL = cmd 0x07, payload prefixado com VERSION_HEADER_33 (15 bytes "3.3" + zeros)
//   - DP_QUERY = cmd 0x0a, payload sem version header
//
// v3.4:
//   - Handshake 3-way ao conectar:
//     1) cliente → device cmd 0x03 (SESS_KEY_NEG_START): localNonce(16) cifrado com localKey
//     2) device → cliente cmd 0x04: remoteNonce(16) + HMAC-SHA256(localNonce, localKey)(32)
//     3) cliente verifica HMAC e responde cmd 0x05: HMAC-SHA256(remoteNonce, localKey)(32)
//     4) sessionKey = AES-ECB-encrypt(localKey, localNonce XOR remoteNonce)[0..16]
//   - Daí pra frente, frames usam HMAC-SHA256(sessionKey) em vez de CRC32, payload cifrado com sessionKey
//   - CONTROL_NEW = cmd 0x0d, sem version header
const net = require('node:net');
const crypto = require('node:crypto');
const { CMD, VERSION_HEADER_33, VERSION_HEADER_34, pack, unpack, pack34, unpack34 } = require('./protocol');
const tuyaCrypto = require('./crypto');

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS  = 30_000;
const RECONNECT_BASE_MS     = 2_000;
const RECONNECT_MAX_MS      = 30_000;
const RESPONSE_TIMEOUT_MS   = 5_000;
const HANDSHAKE_TIMEOUT_MS  = 5_000;

class TuyaLanClient {
  constructor(opts) {
    if (!opts.ip) throw new Error('ip obrigatório');
    if (!opts.deviceid) throw new Error('deviceid obrigatório');
    if (!opts.localKey) throw new Error('localKey obrigatório');
    this.ip = opts.ip;
    this.port = opts.port || 6668;
    this.deviceid = opts.deviceid;
    this.localKey = opts.localKey;
    this.protocolVersion = opts.protocolVersion || '3.3';
    this.onStatus = opts.onStatus || null;
    this.onConnected = opts.onConnected || null;
    this.onDisconnected = opts.onDisconnected || null;

    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._seq = 0;
    this._pendingByCmd = new Map();
    this._handshakePromise = null;
    this._handshakeResolvers = null;
    this._sessionKey = null;       // 16 bytes (só v3.4)
    this._heartbeatTimer = null;
    this._heartbeatWatchdog = null;
    this._reconnectTimer = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._stopped = false;
    this._connected = false;
  }

  // ── Public ────────────────────────────────────────────────────────────
  connect() {
    return new Promise((resolve) => {
      this._stopped = false;
      this._connectInternal(resolve);
    });
  }

  disconnect() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._heartbeatTimer);
    clearTimeout(this._heartbeatWatchdog);
    if (this._socket) {
      try { this._socket.destroy(); } catch {}
      this._socket = null;
    }
    this._connected = false;
  }

  get connected() { return this._connected; }

  async setDP(dp, value) { return this.setDPs({ [dp]: value }); }

  async setDPs(dps) {
    if (this.protocolVersion === '3.4') {
      // v3.4: payload format diferente — { data:{dps,cid}, protocol:5, t }.
      // Fire-and-forget (device só responde via STATUS push).
      const payloadJson = {
        data: { dps, cid: this.deviceid },
        protocol: 5,
        t: Math.floor(Date.now() / 1000),
      };
      return this._sendCommandFireAndForget(CMD.CONTROL_NEW, payloadJson);
    }
    const payloadJson = {
      devId: this.deviceid,
      uid: this.deviceid,
      t: Math.floor(Date.now() / 1000),
      dps,
    };
    return this._sendCommand(CMD.CONTROL, payloadJson, /*withVersionHeader*/ true);
  }

  _sendCommandFireAndForget(cmd, payloadJson) {
    if (!this._connected) throw new Error('not connected');
    if (this.protocolVersion === '3.4' && !this._sessionKey) throw new Error('no session key');
    const json = JSON.stringify(payloadJson);
    const isV34 = this.protocolVersion === '3.4';
    let payload;
    if (isV34) {
      const needsHeader = cmd === CMD.CONTROL_NEW;
      const plain = needsHeader
        ? Buffer.concat([VERSION_HEADER_34, Buffer.from(json, 'utf8')])
        : Buffer.from(json, 'utf8');
      const cipher = crypto.createCipheriv('aes-128-ecb', this._sessionKey, null);
      payload = Buffer.concat([cipher.update(plain), cipher.final()]);
    } else {
      const ct = tuyaCrypto.encrypt(Buffer.from(json, 'utf8'), this.localKey);
      payload = Buffer.concat([VERSION_HEADER_33, ct]);
    }
    this._sendRaw(cmd, payload);
    return { ok: true, async: true };
  }

  async queryState() {
    if (this.protocolVersion === '3.4') {
      const payloadJson = {
        data: { cid: this.deviceid },
        protocol: 4,
        t: Math.floor(Date.now() / 1000),
      };
      return this._sendCommand(CMD.DP_QUERY_NEW, payloadJson, false);
    }
    const payloadJson = {
      devId: this.deviceid,
      uid: this.deviceid,
      t: Math.floor(Date.now() / 1000),
      dps: {},
    };
    return this._sendCommand(CMD.DP_QUERY, payloadJson, false);
  }

  // ── Internal ──────────────────────────────────────────────────────────
  _connectInternal(onceResolve) {
    if (this._stopped) return;
    if (this._socket) { try { this._socket.destroy(); } catch {} }
    this._buffer = Buffer.alloc(0);
    this._sessionKey = null;
    this._socket = net.createConnection({ host: this.ip, port: this.port });
    this._socket.setKeepAlive(true, 5000);
    this._socket.setNoDelay(true);

    this._socket.once('connect', async () => {
      this._connected = true;
      this._reconnectDelay = RECONNECT_BASE_MS;
      try {
        if (this.protocolVersion === '3.4') {
          await this._handshakeV34();
        }
        this._startHeartbeat();
        if (this.onConnected) { try { this.onConnected(); } catch {} }
        if (onceResolve) { onceResolve(true); onceResolve = null; }
      } catch (e) {
        // handshake falhou — força reconnect
        try { this._socket?.destroy(); } catch {}
      }
    });

    this._socket.on('data', (chunk) => this._onData(chunk));

    const handleEnd = (reason) => {
      const wasConnected = this._connected;
      this._connected = false;
      clearInterval(this._heartbeatTimer);
      clearTimeout(this._heartbeatWatchdog);
      this._sessionKey = null;
      if (wasConnected && this.onDisconnected) {
        try { this.onDisconnected(reason); } catch {}
      }
      for (const [cmd, queue] of this._pendingByCmd.entries()) {
        for (const p of queue) {
          clearTimeout(p.timer);
          p.reject(new Error(`disconnected (${reason})`));
        }
      }
      this._pendingByCmd.clear();
      if (this._handshakeResolvers) {
        this._handshakeResolvers.reject(new Error('disconnect during handshake'));
        this._handshakeResolvers = null;
      }
      if (!this._stopped) this._scheduleReconnect();
      if (onceResolve) { onceResolve(false); onceResolve = null; }
    };

    this._socket.on('close', () => handleEnd('close'));
    this._socket.on('error', (e) => handleEnd(`err: ${e.message}`));
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
    this._reconnectTimer = setTimeout(() => this._connectInternal(null), delay);
  }

  _startHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      this._sendRaw(CMD.HEART_BEAT, Buffer.alloc(0));
      clearTimeout(this._heartbeatWatchdog);
      this._heartbeatWatchdog = setTimeout(() => {
        try { this._socket?.destroy(); } catch {}
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ── v3.4 handshake ───────────────────────────────────────────────────
  async _handshakeV34() {
    return new Promise((resolve, reject) => {
      const localNonce = crypto.randomBytes(16);
      this._handshakeResolvers = {
        localNonce, resolve, reject, stage: 'awaiting-resp',
      };
      const timer = setTimeout(() => {
        if (this._handshakeResolvers === thisRef) {
          this._handshakeResolvers = null;
          reject(new Error('handshake timeout'));
        }
      }, HANDSHAKE_TIMEOUT_MS);
      const thisRef = this._handshakeResolvers;
      thisRef.timer = timer;

      // Step 1: enviar localNonce cifrado com localKey
      const enc = tuyaCrypto.encrypt(localNonce, this.localKey);
      this._seq = (this._seq + 1) >>> 0;
      const frame = pack34(this._seq, CMD.SESS_KEY_NEG_START, enc, this._hmacKey());
      try { this._socket.write(frame); }
      catch (e) { reject(e); return; }
    });
  }

  _hmacKey() {
    // Pré-handshake: chave HMAC = localKey (primeiros 16 bytes)
    // Pós-handshake: chave HMAC = sessionKey
    return this._sessionKey || Buffer.from(this.localKey, 'utf8').slice(0, 16);
  }

  _handleHandshakeResp(frame) {
    const r = this._handshakeResolvers;
    if (!r) return;
    try {
      // Tenta decifrar com o payload "com retCode" (variante mais comum).
      // Se falhar, tenta sem retCode (firmwares antigos).
      let decrypted;
      try {
        decrypted = tuyaCrypto.decrypt(frame.payload, this.localKey);
      } catch {
        decrypted = tuyaCrypto.decrypt(frame.payloadFull, this.localKey);
      }
      // Esperado: 16 bytes remoteNonce + 32 bytes HMAC(localNonce, localKey)
      if (decrypted.length < 48) throw new Error('handshake-resp short');
      const remoteNonce = decrypted.slice(0, 16);
      const recvHmac = decrypted.slice(16, 48);
      const expectHmac = crypto.createHmac('sha256',
        Buffer.from(this.localKey, 'utf8').slice(0, 16)
      ).update(r.localNonce).digest();
      if (!recvHmac.equals(expectHmac)) {
        throw new Error('handshake hmac mismatch (local key wrong?)');
      }
      // Step 3: enviar HMAC-SHA256(remoteNonce, localKey) cifrado
      const finishHmac = crypto.createHmac('sha256',
        Buffer.from(this.localKey, 'utf8').slice(0, 16)
      ).update(remoteNonce).digest();
      const enc = tuyaCrypto.encrypt(finishHmac, this.localKey);
      this._seq = (this._seq + 1) >>> 0;
      const reply = pack34(this._seq, CMD.SESS_KEY_NEG_FINISH, enc, this._hmacKey());
      this._socket.write(reply);

      // Calcula sessionKey: AES-ECB-encrypt(localKey, localNonce XOR remoteNonce)[0..16]
      const xored = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) xored[i] = r.localNonce[i] ^ remoteNonce[i];
      const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(this.localKey, 'utf8').slice(0, 16), null);
      cipher.setAutoPadding(false);
      this._sessionKey = Buffer.concat([cipher.update(xored), cipher.final()]).slice(0, 16);
      clearTimeout(r.timer);
      this._handshakeResolvers = null;
      r.resolve();
    } catch (e) {
      clearTimeout(r.timer);
      this._handshakeResolvers = null;
      r.reject(e);
    }
  }

  // ── Data dispatch ─────────────────────────────────────────────────────
  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    const isV34 = this.protocolVersion === '3.4';
    while (true) {
      const r = isV34 ? unpack34(this._buffer) : unpack(this._buffer);
      if (!r) break;
      this._buffer = r.rest;
      if (r.error) continue;
      this._handleFrame(r.frame);
    }
  }

  _handleFrame(frame) {
    if (frame.cmd === CMD.HEART_BEAT) {
      clearTimeout(this._heartbeatWatchdog);
      return;
    }
    if (frame.cmd === CMD.SESS_KEY_NEG_RESP) {
      this._handleHandshakeResp(frame);
      return;
    }
    if (frame.cmd === CMD.STATUS || (this.protocolVersion === '3.4' && frame.cmd === CMD.DP_QUERY_NEW)) {
      const json = this._decodePayload(frame);
      if (json && this.onStatus) {
        try { this.onStatus(json); } catch {}
      }
      // Responde também handlers pendentes desse cmd (ex: query em v3.4)
    }
    const queue = this._pendingByCmd.get(frame.cmd);
    if (queue && queue.length) {
      const p = queue.shift();
      clearTimeout(p.timer);
      const json = this._decodePayload(frame);
      if (frame.retCode && frame.retCode !== 0) {
        p.reject(new Error(`device error code ${frame.retCode}`));
      } else {
        p.resolve(json);
      }
    }
  }

  _decodePayload(frame) {
    const data = frame.payload;
    if (!data || !data.length) return null;
    const isV34 = this.protocolVersion === '3.4';
    const key = isV34 ? this._sessionKey : Buffer.from(this.localKey, 'utf8').slice(0, 16);
    if (!key) return null;
    // Tenta decifrar; se falhar, tenta payloadFull (sem skip de retCode)
    let plain;
    const tryDecrypt = (buf) => {
      try {
        const dec = crypto.createDecipheriv('aes-128-ecb', key, null);
        return Buffer.concat([dec.update(buf), dec.final()]);
      } catch { return null; }
    };
    plain = tryDecrypt(data);
    if (!plain && frame.payloadFull) plain = tryDecrypt(frame.payloadFull);
    if (!plain) {
      try { return JSON.parse(data.toString('utf8')); } catch { return null; }
    }
    // Strip do header de versão presente em alguns responses ("3.3"/"3.4" + 12 zeros = 15 bytes)
    if (plain.length > 15 && (plain.slice(0, 3).toString() === '3.3' || plain.slice(0, 3).toString() === '3.4')) {
      plain = plain.slice(15);
    }
    try { return JSON.parse(plain.toString('utf8')); }
    catch { return null; }
  }

  _sendRaw(cmd, payload) {
    if (!this._socket || this._socket.destroyed) return;
    this._seq = (this._seq + 1) >>> 0;
    const frame = this.protocolVersion === '3.4'
      ? pack34(this._seq, cmd, payload, this._hmacKey())
      : pack(this._seq, cmd, payload);
    try { this._socket.write(frame); } catch {}
  }

  _sendCommand(cmd, payloadJson, withVersionHeader33) {
    return new Promise((resolve, reject) => {
      if (!this._connected) return reject(new Error('not connected'));
      const json = JSON.stringify(payloadJson);
      const isV34 = this.protocolVersion === '3.4';
      let payload;
      if (isV34) {
        if (!this._sessionKey) return reject(new Error('no session key (handshake incomplete)'));
        // CONTROL_NEW (0x0d) requer header "3.4" + 12 zeros antes da cifra. DP_QUERY_NEW não.
        const needsHeader = cmd === CMD.CONTROL_NEW;
        const plain = needsHeader
          ? Buffer.concat([VERSION_HEADER_34, Buffer.from(json, 'utf8')])
          : Buffer.from(json, 'utf8');
        const cipher = crypto.createCipheriv('aes-128-ecb', this._sessionKey, null);
        payload = Buffer.concat([cipher.update(plain), cipher.final()]);
      } else {
        const ct = tuyaCrypto.encrypt(Buffer.from(json, 'utf8'), this.localKey);
        payload = withVersionHeader33 ? Buffer.concat([VERSION_HEADER_33, ct]) : ct;
      }
      const queue = this._pendingByCmd.get(cmd) || [];
      const timer = setTimeout(() => {
        const idx = queue.indexOf(p);
        if (idx >= 0) queue.splice(idx, 1);
        reject(new Error('response timeout'));
      }, RESPONSE_TIMEOUT_MS);
      const p = { resolve, reject, timer };
      queue.push(p);
      this._pendingByCmd.set(cmd, queue);
      this._sendRaw(cmd, payload);
    });
  }
}

module.exports = { TuyaLanClient };

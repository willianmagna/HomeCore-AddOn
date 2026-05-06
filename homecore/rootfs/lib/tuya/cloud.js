// Cliente da Tuya IoT Cloud OpenAPI v1.0/v2.0.
//
// Auth flow (HMAC-SHA256 v2):
//   1. GET /v1.0/token?grant_type=1   → access_token + uid + expire_time
//   2. próximas chamadas incluem access_token + sign HMAC com base no token
//   3. assinatura v2: sign = HEX(HMAC_SHA256(secret, client_id + access_token + t + nonce + stringToSign)).upper()
//      stringToSign = METHOD + "\n" + sha256(body) + "\n" + headers + "\n" + url
//
// Endpoints relevantes:
//   GET /v1.0/iot-01/associated-users/devices  → todos os devices das contas linkadas via QR.
//                                                Resposta inclui local_key (que é o que precisamos).
const crypto = require('node:crypto');

const REGION_HOSTS = {
  cn: 'https://openapi.tuyacn.com',
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  in: 'https://openapi.tuyain.com',
};

class TuyaCloudError extends Error {
  constructor(msg, code) { super(msg); this.name = 'TuyaCloudError'; this.code = code; }
}

class TuyaCloudClient {
  constructor({ accessId, accessSecret, region = 'us' }) {
    if (!accessId || !accessSecret) throw new Error('accessId e accessSecret obrigatórios');
    this.accessId = accessId;
    this.accessSecret = accessSecret;
    this.region = region;
    this.host = REGION_HOSTS[region] || REGION_HOSTS.us;
    this._token = null;
    this._tokenExpiresAt = 0;
    this._uid = null;
  }

  _sha256Hex(input) {
    return crypto.createHash('sha256').update(input || '').digest('hex');
  }

  _sign(method, urlPath, body, withToken) {
    const t = Date.now();
    const nonce = '';
    const contentSha = this._sha256Hex(body || '');
    const headersStr = '';
    const stringToSign = `${method.toUpperCase()}\n${contentSha}\n${headersStr}\n${urlPath}`;
    const tokenPart = withToken ? (this._token || '') : '';
    const signStr = this.accessId + tokenPart + t + nonce + stringToSign;
    const sign = crypto
      .createHmac('sha256', this.accessSecret)
      .update(signStr)
      .digest('hex')
      .toUpperCase();
    return { sign, t, nonce };
  }

  async _request(method, urlPath, opts = {}) {
    const { body = null, withToken = true } = opts;
    if (withToken && (!this._token || Date.now() >= this._tokenExpiresAt)) {
      await this.fetchToken();
    }
    const bodyStr = body ? JSON.stringify(body) : '';
    const { sign, t, nonce } = this._sign(method, urlPath, bodyStr, withToken);
    const headers = {
      client_id: this.accessId,
      t: String(t),
      sign_method: 'HMAC-SHA256',
      nonce,
      sign,
      'Content-Type': 'application/json',
    };
    if (withToken) headers.access_token = this._token;
    const r = await fetch(this.host + urlPath, {
      method, headers,
      body: bodyStr || undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!data || data.success !== true) {
      const msg = data?.msg || `HTTP ${r.status}`;
      throw new TuyaCloudError(`Tuya cloud: ${msg}`, data?.code);
    }
    return data.result;
  }

  async fetchToken() {
    const result = await this._request('GET', '/v1.0/token?grant_type=1', { withToken: false });
    this._token = result.access_token;
    this._uid = result.uid;
    // expire_time vem em segundos; renova 60s antes
    this._tokenExpiresAt = Date.now() + Math.max(60, (result.expire_time || 7200) - 60) * 1000;
    return result;
  }

  /**
   * Lista TODOS os devices das contas Tuya app linkadas ao projeto via QR.
   * Pagina automaticamente.
   */
  async listAssociatedDevices() {
    const all = [];
    let lastRowKey = '';
    for (let i = 0; i < 50; i++) { // safety cap
      const path = lastRowKey
        ? `/v1.0/iot-01/associated-users/devices?last_row_key=${encodeURIComponent(lastRowKey)}`
        : '/v1.0/iot-01/associated-users/devices';
      const result = await this._request('GET', path);
      const devices = result?.devices || [];
      all.push(...devices);
      if (!result?.has_more) break;
      lastRowKey = result.last_row_key || '';
      if (!lastRowKey) break;
    }
    return all;
  }
}

/**
 * Normaliza um device retornado pela cloud no formato que `tuya.includeDevicesFromCloud` espera.
 */
function normalizeDevice(d) {
  return {
    deviceid: d.id,
    local_key: d.local_key,
    protocol: d.sub ? '3.4' : '3.3',
    name: d.name,
    ip: d.ip || null,
    mac: d.mac || null,
    product_id: d.product_id,
    product_key: d.uuid,
    category: d.category,
  };
}

module.exports = { TuyaCloudClient, TuyaCloudError, normalizeDevice, REGION_HOSTS };

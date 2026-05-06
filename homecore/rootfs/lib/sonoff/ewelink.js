// eWeLink cloud client: login (HMAC-signed) + listar devices.
// Uso one-shot: roda só na inclusão pra baixar devicekey de cada deviceid.
// Os mesmos bytes assinados precisam ir no POST — ver project_homecore_sonoff_protocol.md.
const crypto = require('crypto');

const APP_ID = process.env.EWELINK_APP_ID || 'R8Oq3y0eSZSYdKccHlrQzT1ACCOUT9Gv';
const APP_SECRET = process.env.EWELINK_APP_SECRET || '1ve5Qk9GXfUhKAn1svnKwpAlxXkMarru';

const REGION_HOSTS = {
  us: 'https://us-apia.coolkit.cc',
  eu: 'https://eu-apia.coolkit.cc',
  as: 'https://as-apia.coolkit.cc',
  cn: 'https://cn-apia.coolkit.cn',
};

class EweLinkError extends Error {
  constructor(msg) { super(msg); this.name = 'EweLinkError'; }
}

function sign(rawBuffer) {
  return crypto.createHmac('sha256', APP_SECRET).update(rawBuffer).digest('base64');
}

async function loginOnce(host, email, password, countryCode) {
  const body = { email, password, countryCode };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    'Authorization': `Sign ${sign(raw)}`,
    'X-CK-Appid': APP_ID,
    'Content-Type': 'application/json',
  };
  const r = await fetch(`${host}/v2/user/login`, { method: 'POST', headers, body: raw });
  const data = await r.json();
  if (data.error === 10004 && data.data?.region) {
    const newHost = REGION_HOSTS[data.data.region];
    return loginOnce(newHost, email, password, countryCode);
  }
  if (data.error) throw new EweLinkError(`login failed: ${JSON.stringify(data)}`);
  return { token: data.data.at, host };
}

async function listDevices(host, token) {
  const headers = { 'Authorization': `Bearer ${token}`, 'X-CK-Appid': APP_ID };
  const r = await fetch(`${host}/v2/device/thing`, { headers });
  const data = await r.json();
  if (data.error) throw new EweLinkError(`list devices failed: ${JSON.stringify(data)}`);
  return data.data.thingList || [];
}

/**
 * Retorna { [deviceid]: { devicekey, name, model, online } }
 */
async function fetchDevices({ email, password, region = 'us', countryCode = '+55' }) {
  const host = REGION_HOSTS[region] || REGION_HOSTS.us;
  const session = await loginOnce(host, email, password, countryCode);
  const things = await listDevices(session.host, session.token);
  const out = {};
  for (const thing of things) {
    const item = thing.itemData || {};
    if (!item.deviceid || !item.devicekey) continue;
    const extra = item.extra || {};
    out[item.deviceid] = {
      devicekey: item.devicekey,
      name: item.name,
      model: extra.model || item.productModel || extra.uiid,
      online: item.online,
    };
  }
  return out;
}

module.exports = { fetchDevices, EweLinkError };

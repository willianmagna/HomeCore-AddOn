// Comando AES-CBC pro device Sonoff via :8081/zeroconf/<cmd>.
// MINI R4 e firmwares modernos só processam `/zeroconf/switches` com array.
const crypto = require('./crypto');

class SonoffLANError extends Error {
  constructor(msg) { super(msg); this.name = 'SonoffLANError'; }
}

async function sendCommand({ ip, deviceid, devicekey, cmd, params, port = 8081, timeoutMs = 5000 }) {
  const enc = crypto.encrypt(params, devicekey);
  const body = {
    sequence: String(Date.now()),
    deviceid,
    selfApikey: '123',
    encrypt: true,
    iv: enc.iv,
    data: enc.data,
  };
  const url = `http://${ip}:${port}/zeroconf/${cmd}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new SonoffLANError(`non-json response: ${text.slice(0, 200)}`); }
    if (data.error && data.error !== 0) throw new SonoffLANError(`device error: ${JSON.stringify(data)}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function probeMatch(ip, deviceid, devicekey, timeoutMs = 1800) {
  try {
    await sendCommand({ ip, deviceid, devicekey, cmd: 'info', params: {}, timeoutMs });
    return true;
  } catch {
    return false;
  }
}

module.exports = { sendCommand, probeMatch, SonoffLANError };

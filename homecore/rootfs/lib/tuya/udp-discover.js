// Listener UDP do broadcast Tuya — devices anunciam presença na LAN periodicamente
// (a cada ~10s) com gwId + IP local. Sem isso, só temos o IP público vindo da cloud
// e não dá pra abrir TCP local.
//
// Portas/protocolo:
//   6666: payload em texto claro (firmwares antigos)
//   6667: payload AES-128-ECB com chave = MD5("yGAdlopoPVldABfn")
//
// Frame igual ao do protocol.js (prefix 0x55AA, suffix 0xAA55), cmd = 0x14.
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { unpack } = require('./protocol');

const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn', 'utf8').digest();

function decryptBroadcast(buf) {
  try {
    const dec = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
    return Buffer.concat([dec.update(buf), dec.final()]);
  } catch { return null; }
}

function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)
    || /^169\.254\./.test(ip);
}

class UdpDiscover {
  constructor() {
    this.handlers = new Set();
    this.sockets = [];
  }

  start() {
    if (this.sockets.length) return;
    for (const port of [6666, 6667]) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', () => {});
      sock.on('message', (msg, rinfo) => this._onMessage(port, msg, rinfo));
      sock.bind(port, () => {
        try { sock.setBroadcast(true); } catch {}
      });
      this.sockets.push(sock);
    }
  }

  stop() {
    for (const s of this.sockets) { try { s.close(); } catch {} }
    this.sockets = [];
  }

  subscribe(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  _onMessage(port, msg, rinfo) {
    let result = unpack(msg);
    if (!result || !result.frame) return;
    let payload = result.frame.payload;
    if (port === 6667) {
      const dec = decryptBroadcast(payload);
      if (!dec) return;
      payload = dec;
    }
    let json;
    try { json = JSON.parse(payload.toString('utf8').replace(/\0+$/, '')); }
    catch { return; }
    const deviceid = json.gwId || json.devId;
    if (!deviceid) return;
    // Prefere o IP do anúncio (campo "ip"), senão o do remetente; só aceita se for privado.
    const ip = isPrivateIp(json.ip) ? json.ip
             : (isPrivateIp(rinfo.address) ? rinfo.address : null);
    if (!ip) return;
    const evt = {
      deviceid,
      ip,
      version: json.version || null,
      productKey: json.productKey || null,
      active: json.active,
    };
    for (const h of this.handlers) {
      try { h(evt); } catch {}
    }
  }
}

const udp = new UdpDiscover();
module.exports = udp;

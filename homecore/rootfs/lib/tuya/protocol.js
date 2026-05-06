// Tuya LAN frame protocol (v3.3).
//
// Frame outgoing:
//   [prefix 0x000055AA][seq u32][cmd u32][length u32][payload N][crc32 u32][suffix 0x0000AA55]
//   length = payload + 8 (crc + suffix)
// Frame incoming acrescenta um return_code (4 bytes) entre length e payload.
//   length incoming = 4 + payload + 8 = payload + 12
//
// CRC32 cobre prefix..endOfPayload (tudo antes do CRC).
//
// Comandos relevantes:
//   0x07 CONTROL    — envia DPs (com header de versão "3.3" + 12 zeros prepended antes da cifra)
//   0x09 HEART_BEAT — keepalive, payload vazio
//   0x0a DP_QUERY   — solicita estado atual (sem header de versão)
//   0x0d DP_QUERY_NEW — alternativa em alguns firmwares
//   0x12 CONTROL_NEW — protocolo v3.4+
const crypto = require('node:crypto');

const PREFIX = 0x000055aa;
const SUFFIX = 0x0000aa55;

const CMD = Object.freeze({
  HEART_BEAT:        0x09,
  CONTROL:           0x07,
  STATUS:            0x08,   // push de estado vindo do device
  DP_QUERY:          0x0a,
  CONTROL_NEW:       0x0d,   // v3.4 controle
  DP_QUERY_NEW:      0x10,   // v3.4 query de DPs
  // v3.4 handshake
  SESS_KEY_NEG_START:  0x03,
  SESS_KEY_NEG_RESP:   0x04,
  SESS_KEY_NEG_FINISH: 0x05,
  PREFIX:        PREFIX,
  SUFFIX:        SUFFIX,
});

const VERSION_HEADER_33 = Buffer.concat([Buffer.from('3.3'), Buffer.alloc(12, 0)]);
const VERSION_HEADER_34 = Buffer.concat([Buffer.from('3.4'), Buffer.alloc(12, 0)]);

// CRC32 Tuya (polinômio padrão IEEE 0xEDB88320, init 0xFFFFFFFF, xorOut 0xFFFFFFFF, refIn/refOut)
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Empacota um frame outgoing. payload: Buffer.
 */
function pack(seq, cmd, payload) {
  const length = payload.length + 8; // crc(4) + suffix(4)
  const head = Buffer.alloc(16);
  head.writeUInt32BE(PREFIX, 0);
  head.writeUInt32BE(seq >>> 0, 4);
  head.writeUInt32BE(cmd >>> 0, 8);
  head.writeUInt32BE(length, 12);
  const headPlusPayload = Buffer.concat([head, payload]);
  const crc = crc32(headPlusPayload);
  const tail = Buffer.alloc(8);
  tail.writeUInt32BE(crc, 0);
  tail.writeUInt32BE(SUFFIX, 4);
  return Buffer.concat([headPlusPayload, tail]);
}

/**
 * Empacota frame v3.4: HMAC-SHA256 trunc 32 bytes em vez de CRC32.
 * length = payload.length + 32 (hmac) + 4 (suffix). Sem return_code.
 */
function pack34(seq, cmd, payload, hmacKey) {
  const crypto = require('node:crypto');
  const length = payload.length + 32 + 4;
  const head = Buffer.alloc(16);
  head.writeUInt32BE(PREFIX, 0);
  head.writeUInt32BE(seq >>> 0, 4);
  head.writeUInt32BE(cmd >>> 0, 8);
  head.writeUInt32BE(length, 12);
  const headPlusPayload = Buffer.concat([head, payload]);
  const hmac = crypto.createHmac('sha256', hmacKey).update(headPlusPayload).digest();
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(SUFFIX, 0);
  return Buffer.concat([headPlusPayload, hmac, suffix]);
}

/**
 * Unpack v3.4: frame contém HMAC-SHA256 (32 bytes) em vez do CRC32 (4 bytes).
 * Difere de v3.3 apenas no offset do suffix.
 */
function unpack34(buffer) {
  if (buffer.length < 52) return null;
  let i = 0;
  while (i + 4 <= buffer.length && buffer.readUInt32BE(i) !== PREFIX) i++;
  if (i + 16 > buffer.length) return null;
  const seq = buffer.readUInt32BE(i + 4);
  const cmd = buffer.readUInt32BE(i + 8);
  const length = buffer.readUInt32BE(i + 12);
  const totalLen = 16 + length;
  if (i + totalLen > buffer.length) return null;
  const retCode = buffer.readUInt32BE(i + 16);
  const payloadStart = i + 20;
  const payloadEnd = i + 16 + length - 36;  // hmac(32) + suffix(4)
  // Para handshake (sem return_code), payload começa em i+16 e payloadEnd = i+16+length-36
  // Mas algumas mensagens têm retCode, outras não. Vamos tentar ambos:
  const payloadNoRet = buffer.slice(i + 16, payloadEnd);
  const payloadWithRet = buffer.slice(payloadStart, payloadEnd);
  const hmacRead = buffer.slice(payloadEnd, payloadEnd + 32);
  const suffix = buffer.readUInt32BE(payloadEnd + 32);
  if (suffix !== SUFFIX) return { error: 'bad-suffix-v34', rest: buffer.slice(i + 4) };
  return {
    frame: { seq, cmd, retCode, payload: payloadWithRet, payloadFull: payloadNoRet, hmac: hmacRead },
    rest: buffer.slice(i + totalLen),
  };
}

/**
 * Tenta extrair o próximo frame de `buffer`. Retorna { frame, rest } ou null se incompleto.
 * frame = { seq, cmd, retCode, payload }
 */
function unpack(buffer) {
  if (buffer.length < 20) return null; // header(16) + crc/suffix mínimo
  // procura prefix
  let i = 0;
  while (i + 4 <= buffer.length && buffer.readUInt32BE(i) !== PREFIX) i++;
  if (i + 16 > buffer.length) return null;
  const seq = buffer.readUInt32BE(i + 4);
  const cmd = buffer.readUInt32BE(i + 8);
  const length = buffer.readUInt32BE(i + 12);
  const totalLen = 16 + length;
  if (i + totalLen > buffer.length) return null; // frame incompleto

  const retCode = buffer.readUInt32BE(i + 16);
  const payloadStart = i + 20;
  const payloadEnd = i + 16 + length - 8; // length cobre retCode + payload + crc + suffix; retCode já foi lido
  const payload = buffer.slice(payloadStart, payloadEnd);
  const crcRead = buffer.readUInt32BE(payloadEnd);
  const suffix = buffer.readUInt32BE(payloadEnd + 4);

  if (suffix !== SUFFIX) {
    // frame corrompido — pula o prefix achado pra tentar resyncar
    return { error: 'bad-suffix', rest: buffer.slice(i + 4) };
  }

  return {
    frame: { seq, cmd, retCode, payload, crc: crcRead },
    rest: buffer.slice(i + totalLen),
  };
}

module.exports = { CMD, VERSION_HEADER_33, VERSION_HEADER_34, pack, unpack, pack34, unpack34, crc32 };

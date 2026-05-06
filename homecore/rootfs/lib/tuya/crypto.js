// Tuya LAN crypto: AES-128-ECB com PKCS7. Chave = localKey (16 bytes ASCII).
// Diferente do Sonoff (que usa CBC com MD5(devicekey) + IV); Tuya v3.3 e v3.4 usam ECB
// com a localKey diretamente como chave.
const crypto = require('crypto');

function _key(localKey) {
  return Buffer.from(localKey, 'utf8').slice(0, 16);
}

/** Encrypta um Buffer ou string usando AES-128-ECB + PKCS7. Retorna Buffer. */
function encrypt(plaintext, localKey) {
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-ecb', _key(localKey), null);
  // padding default = PKCS7
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

/** Decripta Buffer usando AES-128-ECB + PKCS7. Retorna Buffer (texto plano). */
function decrypt(ciphertext, localKey) {
  const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-ecb', _key(localKey), null);
  return Buffer.concat([decipher.update(buf), decipher.final()]);
}

/** Variante usada no protocolo v3.4: HMAC-SHA256 do payload com localKey. */
function hmac(payload, localKey) {
  return crypto.createHmac('sha256', _key(localKey)).update(payload).digest();
}

module.exports = { encrypt, decrypt, hmac };

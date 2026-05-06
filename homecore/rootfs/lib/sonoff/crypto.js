// Sonoff eWeLink LAN AES-128-CBC com chave derivada de MD5(devicekey).
const crypto = require('crypto');

function md5Key(devicekey) {
  return crypto.createHash('md5').update(devicekey, 'utf8').digest();
}

function encrypt(data, devicekey) {
  const iv = crypto.randomBytes(16);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', md5Key(devicekey), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { data: ct.toString('base64'), iv: iv.toString('base64') };
}

function decrypt(dataB64, ivB64, devicekey) {
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', md5Key(devicekey), iv);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { encrypt, decrypt };

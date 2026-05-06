/**
 * HomeCore — Broadlink RM3 Protocol Implementation
 *
 * Implementação direta do protocolo UDP do Broadlink RM Mini 3.
 * Baseado na documentação aberta do protocolo.
 * Usa apenas módulos nativos do Node.js (dgram, crypto).
 */

const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');

// ─── Constantes do Protocolo ───
const DEFAULT_KEY = Buffer.from([
  0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23,
  0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02
]);

const DEFAULT_IV = Buffer.from([
  0x56, 0x2e, 0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28,
  0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58
]);

const KNOWN_DEVICES = {
  0x2737: 'RM Mini',
  0x27c7: 'RM Mini 3 A',
  0x27c2: 'RM Mini 3 B',
  0x27de: 'RM Mini 3 C',
  0x5f36: 'RM Mini 3 D',
  0x6026: 'RM4 Mini',
  0x610e: 'RM4 Mini',
  0x610f: 'RM4 Mini',
  0x62bc: 'RM4 Mini',
  0x62be: 'RM4 Mini',
  0x6070: 'RM4 Pro',
  0x649b: 'RM4 Pro',
  0x653a: 'RM4 Pro',
};

// ─── Helpers ───

function checksum(buf) {
  let sum = 0xbeaf;
  for (let i = 0; i < buf.length; i++) {
    sum = (sum + buf[i]) & 0xffff;
  }
  return sum;
}

function encrypt(data, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, DEFAULT_IV);
  cipher.setAutoPadding(false);
  // Pad to 16-byte boundary
  const padLen = 16 - (data.length % 16);
  const padded = padLen === 16 ? data : Buffer.concat([data, Buffer.alloc(padLen)]);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function decrypt(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, DEFAULT_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function parseMac(macStr) {
  // MAC is stored in display order (e.g. 24:df:a7:7a:f8:59)
  // Protocol needs it in reversed (wire) order
  const bytes = Buffer.from(macStr.replace(/[:\-_ ]/g, ''), 'hex');
  return Buffer.from([...bytes].reverse());
}

// ─── Classe BroadlinkDevice ───

class BroadlinkDevice extends EventEmitter {
  constructor({ host, mac, devType, name }) {
    super();
    this.host = host;
    this.port = 80;
    this.mac = typeof mac === 'string' ? parseMac(mac) : mac;
    this.devType = devType;
    this.name = name || KNOWN_DEVICES[devType] || 'Desconhecido';
    this.key = Buffer.from(DEFAULT_KEY);
    this.id = Buffer.alloc(4);
    this.count = 0x8000 + Math.floor(Math.random() * 0x7fff);
    this.authenticated = false;
    this.socket = null;
  }

  /**
   * Monta um pacote de comando para enviar ao dispositivo.
   */
  _buildPacket(command, payload) {
    this.count = ((this.count + 1) | 0x8000) & 0xffff;

    // Header: 0x38 bytes
    const packet = Buffer.alloc(0x38);

    // Magic
    packet[0x00] = 0x5a;
    packet[0x01] = 0xa5;
    packet[0x02] = 0xaa;
    packet[0x03] = 0x55;
    packet[0x04] = 0x5a;
    packet[0x05] = 0xa5;
    packet[0x06] = 0xaa;
    packet[0x07] = 0x55;

    // Device type
    packet[0x24] = this.devType & 0xff;
    packet[0x25] = (this.devType >> 8) & 0xff;

    // Command
    packet[0x26] = command & 0xff;
    packet[0x27] = (command >> 8) & 0xff;

    // Counter
    packet[0x28] = this.count & 0xff;
    packet[0x29] = (this.count >> 8) & 0xff;

    // MAC
    this.mac.copy(packet, 0x2a);

    // Device ID
    this.id.copy(packet, 0x30);

    // Encrypt payload
    let encPayload = Buffer.alloc(0);
    if (payload && payload.length > 0) {
      // Payload checksum
      const payloadCs = checksum(payload);
      packet[0x34] = payloadCs & 0xff;
      packet[0x35] = (payloadCs >> 8) & 0xff;

      encPayload = encrypt(payload, this.key);
    }

    // Build full packet
    const full = Buffer.concat([packet, encPayload]);

    // Header checksum
    const cs = checksum(full);
    full[0x20] = cs & 0xff;
    full[0x21] = (cs >> 8) & 0xff;

    return full;
  }

  /**
   * Envia um pacote e aguarda resposta.
   */
  _sendPacket(command, payload, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const packet = this._buildPacket(command, payload);
      const expectedCount = this.count;

      // Always create a fresh socket to avoid stale responses
      if (this.socket) {
        try { this.socket.close(); } catch (e) {}
        this.socket = null;
      }

      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', (err) => {
        try { this.socket.close(); } catch (e) {}
        this.socket = null;
      });

      const timer = setTimeout(() => {
        this.socket.removeAllListeners('message');
        reject(new Error('Timeout aguardando resposta do dispositivo'));
      }, timeoutMs);

      const onMessage = (msg) => {
        // Verify this is a response to our packet (match counter at 0x28-0x29)
        if (msg.length >= 0x38) {
          const respCount = msg[0x28] | (msg[0x29] << 8);
          if (respCount !== expectedCount) {
            // Not our response, keep waiting
            return;
          }
        }
        clearTimeout(timer);
        this.socket.removeListener('message', onMessage);
        resolve(msg);
      };

      this.socket.on('message', onMessage);

      this.socket.send(packet, 0, packet.length, this.port, this.host, (err) => {
        if (err) {
          clearTimeout(timer);
          this.socket.removeListener('message', onMessage);
          reject(err);
        }
      });
    });
  }

  /**
   * Autentica com o dispositivo. Necessário antes de qualquer comando.
   */
  async auth() {
    // Reset state before auth
    this.id = Buffer.alloc(4);
    this.key = Buffer.from(DEFAULT_KEY);

    const payload = Buffer.alloc(0x50);

    // Bytes 0x04-0x13: fill with 0x31 (matches python-broadlink)
    for (let i = 0x04; i <= 0x13; i++) payload[i] = 0x31;
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    // Device name "Test 1" at offset 0x30
    Buffer.from('Test 1').copy(payload, 0x30);

    const response = await this._sendPacket(0x65, payload, 5000);

    // Check error code
    const errCode = response[0x22] | (response[0x23] << 8);
    const errSigned = errCode > 0x7fff ? errCode - 0x10000 : errCode;
    if (errSigned !== 0) {
      throw new Error(`Erro de autenticação do dispositivo (código: ${errSigned})`);
    }

    const encPayload = response.slice(0x38);
    if (encPayload.length === 0) {
      throw new Error('Resposta de autenticação vazia');
    }

    const decPayload = decrypt(encPayload, this.key);

    // Extract device ID (bytes 0x00 to 0x04)
    this.id = Buffer.from(decPayload.slice(0x00, 0x04));

    // Extract new key (bytes 0x04 to 0x14)
    this.key = Buffer.from(decPayload.slice(0x04, 0x14));

    this.authenticated = true;
    return true;
  }

  /**
   * Coloca o dispositivo em modo de aprendizado IR.
   */
  /**
   * Monta o payload RM no formato correto: [len (2 LE)] [cmd (4 LE)] [data]
   */
  _buildRmPayload(command, data) {
    const dataLen = data ? data.length : 0;
    const payload = Buffer.alloc(6 + dataLen);
    // Length field: data length + 4 (includes the 4-byte command)
    payload.writeUInt16LE(dataLen + 4, 0);
    // Command (4 bytes LE)
    payload.writeUInt32LE(command, 2);
    // Data
    if (data && dataLen > 0) {
      data.copy(payload, 6);
    }
    return payload;
  }

  /**
   * Envia comando RM e retorna os dados da resposta.
   */
  async _sendRm(command, data, timeoutMs = 5000) {
    if (!this.authenticated) await this.auth();
    const payload = this._buildRmPayload(command, data);
    const response = await this._sendPacket(0x6a, payload, timeoutMs);

    // Check error code
    const errCode = response[0x22] | (response[0x23] << 8);
    const errSigned = errCode > 0x7fff ? errCode - 0x10000 : errCode;
    if (errSigned !== 0) {
      throw new Error(`Erro do dispositivo RM (código: ${errSigned})`);
    }

    const encPayload = response.slice(0x38);
    if (encPayload.length === 0) return null;

    const decPayload = decrypt(encPayload, this.key);
    // Response format: [len (2 LE)] [???] [???] [???] [data...]
    const pLen = decPayload.readUInt16LE(0);
    return decPayload.slice(0x06, pLen + 2);
  }

  async enterLearning() {
    await this._sendRm(0x03);
    return true;
  }

  /**
   * Verifica se há dados IR capturados.
   */
  async checkData() {
    try {
      const data = await this._sendRm(0x04, null, 3000);
      if (!data || data.length === 0) return null;
      // Verify it's not empty/zeroed
      const hasData = data.some(b => b !== 0);
      if (!hasData) return null;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Envia um pacote de dados IR.
   */
  async sendData(irData) {
    await this._sendRm(0x02, irData);
    return true;
  }

  /**
   * Captura um código IR com polling.
   * Retorna o código ou null se timeout.
   */
  async learnCode(timeoutSec = 10, onStatus) {
    await this.enterLearning();
    if (onStatus) onStatus('waiting');

    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutSec * 1000) {
      const data = await this.checkData();
      if (data) {
        if (onStatus) onStatus('captured');
        return data;
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    if (onStatus) onStatus('timeout');
    return null;
  }

  /**
   * Fecha a conexão UDP.
   */
  close() {
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
  }
}

// ─── Descoberta de Dispositivos ───

function discover(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const devices = [];
    const socket = dgram.createSocket('udp4');

    // Build discovery packet
    const now = new Date();
    const tzOffset = new Date().getTimezoneOffset() / -60;

    const packet = Buffer.alloc(0x30);

    // Timezone
    packet[0x08] = tzOffset < 0 ? (0xff + tzOffset + 1) : tzOffset;
    if (tzOffset < 0) packet[0x09] = 0xff;

    // Date/time
    packet[0x0c] = now.getFullYear() & 0xff;
    packet[0x0d] = (now.getFullYear() >> 8) & 0xff;
    packet[0x0e] = now.getMinutes();
    packet[0x0f] = now.getHours();
    packet[0x10] = now.getFullYear() % 100;
    packet[0x11] = now.getDay();
    packet[0x12] = now.getDate();
    packet[0x13] = now.getMonth() + 1;

    // Local IP
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let localIp = '0.0.0.0';
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          localIp = addr.address;
          break;
        }
      }
      if (localIp !== '0.0.0.0') break;
    }

    const ipParts = localIp.split('.').map(Number);
    packet[0x18] = ipParts[0] || 0;
    packet[0x19] = ipParts[1] || 0;
    packet[0x1a] = ipParts[2] || 0;
    packet[0x1b] = ipParts[3] || 0;

    // Source port (will be set after bind)
    // Command: 0x06 (discover)
    packet[0x26] = 0x06;

    // Checksum
    const cs = checksum(packet);
    packet[0x20] = cs & 0xff;
    packet[0x21] = (cs >> 8) & 0xff;

    socket.on('message', (msg, rinfo) => {
      if (msg.length < 0x40) return;

      const devType = msg[0x34] | (msg[0x35] << 8);
      const mac = Buffer.from(msg.slice(0x3a, 0x40));
      // MAC vem em ordem reversa
      const macHex = [...mac].reverse()
        .map(b => b.toString(16).padStart(2, '0'))
        .join(':');

      const modelName = KNOWN_DEVICES[devType] || `Dispositivo 0x${devType.toString(16)}`;

      // Hostname configurado no dispositivo (offset 0x40+)
      let deviceName = '';
      if (msg.length > 0x40) {
        const nameBytes = msg.slice(0x40);
        const nullIdx = nameBytes.indexOf(0x00);
        deviceName = nameBytes.slice(0, nullIdx > 0 ? nullIdx : nameBytes.length)
          .toString('utf-8')
          .trim();
      }

      devices.push({
        host: rinfo.address,
        port: rinfo.port,
        mac: macHex,
        macBuffer: mac,
        devType: devType,
        model: modelName,
        name: deviceName || modelName,
      });
    });

    socket.on('error', () => {
      socket.close();
      resolve(devices);
    });

    socket.bind(() => {
      const port = socket.address().port;
      packet[0x1c] = port & 0xff;
      packet[0x1d] = (port >> 8) & 0xff;

      // Recalc checksum with port
      packet[0x20] = 0;
      packet[0x21] = 0;
      const cs2 = checksum(packet);
      packet[0x20] = cs2 & 0xff;
      packet[0x21] = (cs2 >> 8) & 0xff;

      socket.setBroadcast(true);

      // Compute subnet broadcast(s) for all non-internal IPv4 interfaces and also use limited broadcast.
      // Firmwares modernos de Broadlink respondem melhor ao broadcast da subnet específica.
      const destinations = new Set(['255.255.255.255']);
      for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
          if (addr.family !== 'IPv4' || addr.internal) continue;
          try {
            // calcula broadcast: (ip | ~netmask)
            const ipInt = addr.address.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
            const maskInt = (addr.netmask || '255.255.255.0').split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
            const bcastInt = (ipInt | (~maskInt >>> 0)) >>> 0;
            const bcast = [24, 16, 8, 0].map((s) => (bcastInt >>> s) & 0xff).join('.');
            if (bcast && bcast !== '0.0.0.0') destinations.add(bcast);
          } catch {}
        }
      }
      for (const dest of destinations) {
        try { socket.send(packet, 0, packet.length, 80, dest); } catch {}
      }
    });

    setTimeout(() => {
      try { socket.close(); } catch {}
      resolve(devices);
    }, timeoutMs);
  });
}

// ─── Conversor Broadlink → SendIR/GC ───

function broadlinkToSendir(irPacket, freqHz = 38000) {
  if (!irPacket || irPacket.length < 6) return null;

  const durations = [];
  const payload = irPacket.slice(4);
  let i = 0;

  while (i < payload.length) {
    if (payload[i] === 0x00 && i + 2 < payload.length) {
      durations.push(payload.readUInt16BE(i + 1));
      i += 3;
    } else {
      durations.push(payload[i]);
      i += 1;
    }
  }

  const usPerUnit = 1000000 / 32768;
  const periodUs = 1000000 / freqHz;
  const cycles = durations.map(d => Math.max(1, Math.round((d * usPerUnit) / periodUs)));

  return `${freqHz},${cycles.join(',')}`;
}

module.exports = {
  BroadlinkDevice,
  discover,
  broadlinkToSendir,
  KNOWN_DEVICES,
};

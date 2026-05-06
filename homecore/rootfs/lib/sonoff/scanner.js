// Descoberta de dispositivos LAN: mDNS (_ewelink._tcp) + sweep TCP do /24 (Sonoff 8081 / Tuya 6668).
// Stream de eventos: subnet, progress, device, done.
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { Bonjour } = require('bonjour-service');

const SONOFF_PORT = 8081;
const TUYA_PORT = 6668;
const PROBE_TIMEOUT_MS = 700;
const MDNS_DURATION_MS = 6000;
const SCAN_CONCURRENCY = 64;

// Tabela OUI mínima (ITEAD/Tuya conhecidos)
const OUI = {
  'D8:F1:5B': 'sonoff','BC:DD:C2': 'sonoff','BC:FF:4D': 'sonoff','4C:EB:D6': 'sonoff',
  '60:01:94': 'sonoff','EC:FA:BC': 'sonoff','7C:B9:4C': 'sonoff','84:0D:8E': 'sonoff',
  'A4:CF:12': 'sonoff','C4:5B:BE': 'sonoff','DC:4F:22': 'sonoff','B4:E6:2D': 'sonoff',
  'D4:A6:51': 'tuya','84:E3:42': 'tuya','50:02:91': 'tuya','68:57:2D': 'tuya','70:5A:0F': 'tuya',
};

function detectLocalSubnet() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const it of list) {
      if (it.family === 'IPv4' && !it.internal && it.address && !it.address.startsWith('169.254.')) {
        // Deriva /24 do IP
        const parts = it.address.split('.').map(Number);
        return { network: `${parts[0]}.${parts[1]}.${parts[2]}.0/24`, base: parts.slice(0, 3) };
      }
    }
  }
  return null;
}

function readArpTable() {
  const out = {};
  try {
    const text = fs.readFileSync('/proc/net/arp', 'utf8');
    const lines = text.split('\n').slice(1); // header
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const ip = parts[0], mac = parts[3];
      if (!mac || mac === '00:00:00:00:00:00' || mac === '<incomplete>') continue;
      out[ip] = mac.toUpperCase();
    }
  } catch { /* ignore */ }
  return out;
}

function ouiLookup(mac) {
  if (!mac) return null;
  const prefix = mac.toUpperCase().split(':').slice(0, 3).join(':');
  return OUI[prefix] || null;
}

function extractDeviceid(serviceName) {
  const m = /eWeLink_([0-9a-fA-F]+)/i.exec(serviceName || '');
  return m ? m[1] : null;
}

function checkPort(ip, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.connect(port, ip);
  });
}

async function probeHost(ip) {
  const [sonoff, tuya] = await Promise.all([
    checkPort(ip, SONOFF_PORT),
    checkPort(ip, TUYA_PORT),
  ]);
  if (!sonoff && !tuya) return null;
  const ports = [];
  let vendor = 'unknown';
  if (sonoff) { ports.push(SONOFF_PORT); vendor = 'sonoff'; }
  if (tuya) { ports.push(TUYA_PORT); if (vendor === 'unknown') vendor = 'tuya'; }
  return { ip, vendor, source: 'scan', open_ports: ports, properties: {} };
}

function mergeInto(map, dev) {
  const existing = map.get(dev.ip);
  if (!existing) {
    if (dev.mac && !dev.oui_vendor) dev.oui_vendor = ouiLookup(dev.mac);
    map.set(dev.ip, dev);
    return dev;
  }
  if (!existing.source.includes(dev.source)) {
    const sources = [...new Set((existing.source + '+' + dev.source).split('+').filter(Boolean))].sort();
    existing.source = sources.join('+');
  }
  existing.open_ports = [...new Set([...(existing.open_ports || []), ...(dev.open_ports || [])])].sort();
  if (existing.vendor === 'unknown' && dev.vendor !== 'unknown') existing.vendor = dev.vendor;
  if (!existing.hostname && dev.hostname) existing.hostname = dev.hostname;
  if (!existing.deviceid && dev.deviceid) existing.deviceid = dev.deviceid;
  if (!existing.mac && dev.mac) {
    existing.mac = dev.mac;
    existing.oui_vendor = ouiLookup(dev.mac);
  }
  if (dev.properties) existing.properties = { ...existing.properties, ...dev.properties };
  return existing;
}

/**
 * Async generator que emite { type, ... } eventos.
 */
async function* discoverStream() {
  const start = Date.now();
  const subnet = detectLocalSubnet();
  yield { type: 'subnet', value: subnet ? subnet.network : null };

  const devices = new Map();
  const events = [];
  const eventResolvers = [];

  function emit(evt) {
    if (eventResolvers.length) eventResolvers.shift()(evt);
    else events.push(evt);
  }

  // ── mDNS ────────────────────────────────────────────────
  const bonjour = new Bonjour();
  const browser = bonjour.find({ type: 'ewelink', protocol: 'tcp' });
  browser.on('up', (svc) => {
    const props = {};
    for (const [k, v] of Object.entries(svc.txt || {})) {
      props[k] = typeof v === 'string' ? v : (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
    }
    const deviceid = extractDeviceid(svc.fqdn || svc.name) || props.id;
    const addresses = (svc.addresses || []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    for (const ip of addresses) {
      const merged = mergeInto(devices, {
        ip, vendor: 'sonoff', source: 'mdns',
        hostname: svc.fqdn || svc.name, deviceid, properties: props, open_ports: [],
      });
      emit({ type: 'device', data: merged });
    }
  });

  // ── Active scan ─────────────────────────────────────────
  let scanResolve;
  const scanDone = new Promise((r) => { scanResolve = r; });
  (async () => {
    if (!subnet) { scanResolve(); return; }
    const hosts = [];
    for (let i = 1; i <= 254; i++) hosts.push(`${subnet.base.join('.')}.${i}`);
    const total = hosts.length;
    emit({ type: 'progress', scanned: 0, total });
    let scanned = 0;
    const queue = [...hosts];
    const workers = Array.from({ length: SCAN_CONCURRENCY }, async () => {
      while (queue.length) {
        const ip = queue.shift();
        if (!ip) return;
        const d = await probeHost(ip);
        scanned++;
        if (scanned % 8 === 0 || scanned === total) {
          emit({ type: 'progress', scanned, total });
        }
        if (d) {
          const merged = mergeInto(devices, d);
          emit({ type: 'device', data: merged });
        }
      }
    });
    await Promise.all(workers);
    // Segunda passada nos hosts vistos só por mDNS (sem ports) pra confirmar
    const retry = [...devices.values()].filter((d) => !d.open_ports?.length);
    for (const d of retry) {
      const r = await probeHost(d.ip);
      if (r) {
        const merged = mergeInto(devices, r);
        emit({ type: 'device', data: merged });
      }
    }
    scanResolve();
  })();

  const mdnsDone = new Promise((r) => setTimeout(r, MDNS_DURATION_MS));

  let finished = false;
  Promise.all([mdnsDone, scanDone]).then(() => {
    // ARP enrichment
    const arp = readArpTable();
    for (const [ip, mac] of Object.entries(arp)) {
      const d = devices.get(ip);
      if (d && !d.mac) {
        d.mac = mac;
        d.oui_vendor = ouiLookup(mac);
        if (d.vendor === 'unknown' && d.oui_vendor) d.vendor = d.oui_vendor;
        emit({ type: 'device', data: d });
      }
    }
    emit({ type: '__end__' });
  });

  // Stream events to consumer
  while (true) {
    let evt;
    if (events.length) evt = events.shift();
    else evt = await new Promise((r) => eventResolvers.push(r));
    if (evt.type === '__end__') break;
    yield evt;
  }

  try { browser.stop(); } catch {}
  try { bonjour.destroy(); } catch {}

  const sortedDevices = [...devices.values()].sort((a, b) => {
    const ta = a.ip.split('.').map(Number);
    const tb = b.ip.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (ta[i] !== tb[i]) return ta[i] - tb[i];
    return 0;
  });
  yield {
    type: 'done',
    elapsed: ((Date.now() - start) / 1000).toFixed(2),
    count: sortedDevices.length,
    devices: sortedDevices,
  };
}

module.exports = { discoverStream, extractDeviceid, ouiLookup, detectLocalSubnet };

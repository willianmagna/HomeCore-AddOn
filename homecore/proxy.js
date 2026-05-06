// Mini proxy que faz o HomeCore funcionar atras do ingress do HA sem patcha-lo.
// Escuta em INGRESS_PORT, encaminha pra TARGET_PORT, e injeta um <script> no
// <head> de toda resposta HTML pra reescrever URLs absolutas (/api/...) em runtime.
const http = require('http');
const net = require('net');

const INGRESS_PORT = Number(process.env.INGRESS_PORT || 8099);
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.TARGET_PORT || 3010);

const SHIM = `<script>(function(){
  var m = location.pathname.match(/^(\\/api\\/hassio_ingress\\/[^\\/]+)/);
  if (!m) return;
  var P = m[1];
  function fix(u){ return (typeof u==='string' && u[0]==='/' && u.indexOf(P)!==0) ? (P+u) : u; }
  var of = window.fetch;
  window.fetch = function(u,o){ return of.call(this, fix(u), o); };
  var OWS = window.WebSocket;
  function WS(u,p){
    if (typeof u==='string') {
      try {
        var url = new URL(u, location.href);
        if (url.pathname[0]==='/' && url.pathname.indexOf(P)!==0) {
          url.pathname = P + url.pathname;
          u = url.toString();
        }
      } catch(e){}
    }
    return new OWS(u,p);
  }
  WS.prototype = OWS.prototype;
  for (var k in OWS) WS[k] = OWS[k];
  window.WebSocket = WS;
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, u){
    arguments[1] = fix(u);
    return oo.apply(this, arguments);
  };
})();</script>`;

function copyHeaders(src) {
  const out = {};
  for (const k of Object.keys(src)) out[k] = src[k];
  return out;
}

const server = http.createServer((req, res) => {
  const reqHeaders = copyHeaders(req.headers);
  // Forca resposta sem compressao pra podermos reescrever HTML facil
  reqHeaders['accept-encoding'] = 'identity';

  const proxyReq = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: reqHeaders,
  }, (pres) => {
    const ct = String(pres.headers['content-type'] || '').toLowerCase();
    const isHtml = ct.includes('text/html');

    if (!isHtml) {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
      return;
    }

    const chunks = [];
    pres.on('data', (c) => chunks.push(c));
    pres.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      // Injeta o shim logo apos a primeira <head>
      if (/<head[^>]*>/i.test(body)) {
        body = body.replace(/<head[^>]*>/i, (m) => m + SHIM);
      } else {
        body = SHIM + body;
      }
      const outHeaders = copyHeaders(pres.headers);
      delete outHeaders['content-length'];
      delete outHeaders['content-encoding'];
      res.writeHead(pres.statusCode || 200, outHeaders);
      res.end(body);
    });
    pres.on('error', () => {
      try { res.end(); } catch(e){}
    });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Ingress proxy: backend indisponivel — ' + err.message);
  });
  req.pipe(proxyReq);
});

// WebSocket upgrade — encaminha o handshake e faz pipe bidirecional dos sockets.
server.on('upgrade', (req, clientSock, clientHead) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(req.headers)) {
      const arr = Array.isArray(v) ? v : [v];
      for (const val of arr) headerLines.push(`${k}: ${val}`);
    }
    upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
    if (clientHead && clientHead.length) upstream.write(clientHead);
    upstream.pipe(clientSock);
    clientSock.pipe(upstream);
  });
  const onErr = () => { try { clientSock.destroy(); } catch(e){} try { upstream.destroy(); } catch(e){} };
  upstream.on('error', onErr);
  clientSock.on('error', onErr);
});

server.listen(INGRESS_PORT, '0.0.0.0', () => {
  console.log(`[ingress-proxy] listening on ${INGRESS_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});

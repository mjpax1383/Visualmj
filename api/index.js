// Vercel serverless function – stealth streaming proxy
// Equivalent to original Vercel‑XHTTP but with lower detection profile

// The single backend variable – name is deliberately generic
const REMOTE_HOST = process.env.REMOTE_HOST;
if (!REMOTE_HOST) {
  throw new Error('REMOTE_HOST environment variable is not set');
}
// Remove trailing slash
const BASE = REMOTE_HOST.replace(/\/$/, '');

// A realistic‑looking homepage served when someone visits the root
const HOMEPAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome — CloudSync</title>
  <meta name="description" content="CloudSync — your reliable document organiser">
  <style>
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #333; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .box { background: white; padding: 2.5rem; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.05); text-align: center; max-width: 400px; }
    h1 { font-weight: 600; margin-bottom: 0.5rem; }
    p { color: #666; }
    .dot { display: inline-block; width: 8px; height: 8px; background: #4caf50; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  </style>
</head>
<body>
  <div class="box">
    <h1><span class="dot"></span>CloudSync</h1>
    <p>Your documents are synchronised and safe.<br>The service is operational.</p>
    <small style="color:#aaa;">© 2026 CloudSync</small>
  </div>
</body>
</html>`;

// Helper to decide if a method can have a body
const WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export default async function handler(req, res) {
  try {
    const url = new URL(req.url);

    // --- Serve the decoy homepage on the root path ---
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HOMEPAGE_HTML);
      return;
    }

    // --- For any other path, act as a transparent proxy ---
    const target = BASE + url.pathname + url.search;

    // Clone and clean up the headers – strip everything that shouts “proxy”
    const headers = new Headers(req.headers);

    // Remove problematic headers (same as original Vercel‑XHTTP)
    const STRIP = [
      'host', 'connection', 'keep-alive',
      'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'upgrade',
      'forwarded',
      'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
    ];
    STRIP.forEach(h => headers.delete(h));

    // Delete Vercel‑specific headers to avoid leaking the platform
    for (const [key] of headers) {
      if (key.startsWith('x-vercel') || key.startsWith('vercel')) {
        headers.delete(key);
      }
    }

    // Ensure the backend receives its own Host header
    try {
      const backendHost = new URL(BASE).host;
      headers.set('host', backendHost);
    } catch (_) {}

    // Add a realistic IP forwarding header (preserve the original client IP)
    if (!headers.has('x-forwarded-for')) {
      const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
      if (ip) headers.set('x-forwarded-for', ip);
    }

    // Forward the request, streaming the body directly
    const method = req.method;
    const fetchOpts = {
      method,
      headers,
      redirect: 'manual',
    };
    if (WITH_BODY.has(method)) {
      fetchOpts.body = req;        // req is a readable stream (Node.js IncomingMessage)
    }

    const upstream = await fetch(target, fetchOpts);

    // Copy back the response headers (skip hop‑by‑hop ones)
    for (const [key, value] of upstream.headers.entries()) {
      const lower = key.toLowerCase();
      if (!['transfer-encoding', 'connection', 'keep-alive'].includes(lower)) {
        res.setHeader(key, value);
      }
    }
    res.writeHead(upstream.status);

    // Pipe the upstream body directly to the client (streaming)
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return;
          }
          res.write(value);
        }
      };
      pump().catch(err => {
        console.error('Stream pump error:', err);
        res.end();
      });
    } else {
      res.end();
    }
  } catch (err) {
    console.error('Proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  }
}

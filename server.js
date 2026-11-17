const http = require('http');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((part) => {
    const [rawKey, ...rest] = part.split('=');
    const key = rawKey && rawKey.trim();
    if (!key) return;
    cookies[key] = decodeURIComponent(rest.join('=')).trim();
  });
  return cookies;
}

async function readJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      return {};
    }
  }

  return {};
}

function createResponse(res) {
  return {
    status(code) {
      res.statusCode = code;
      return this;
    },
    json(payload) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    },
    send(payload) {
      const type = typeof payload;
      if (type === 'string') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(payload);
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    },
    setHeader(name, value) {
      res.setHeader(name, value);
    }
  };
}

async function routeRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  req.query = Object.fromEntries(url.searchParams.entries());
  req.cookies = parseCookies(req.headers.cookie || '');
  req.body = await readJsonBody(req);

  const routeMap = {
    '/api/session': require('./api/session.js'),
    '/api/me': require('./api/me.js'),
    '/api/video/usage': require('./api/video/usage.js'),
    '/api/payments/stk': require('./api/payments/stk.js')
  };

  if (routeMap[pathname]) {
    const routeHandler = routeMap[pathname];
    return routeHandler(req, createResponse(res));
  }

  const paymentMatch = pathname.match(/^\/api\/payments\/([^/]+)$/);
  if (paymentMatch) {
    req.params = { id: paymentMatch[1] };
    req.query = { ...req.query, id: paymentMatch[1] };
    return require('./api/payments/[id].js')(req, createResponse(res));
  }

  if (pathname === '/api/payments/callback') {
    return require('./api/payments/callback.js')(req, createResponse(res));
  }

  const safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      const fallback = path.join(publicDir, 'index.html');
      const fallbackType = mimeTypes['.html'];
      res.statusCode = 200;
      res.setHeader('Content-Type', fallbackType);
      fs.createReadStream(fallback).pipe(res);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    await routeRequest(req, res);
  } catch (error) {
    console.error('Unhandled server error:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`VelvetPlay is running at http://localhost:${port}`);
});

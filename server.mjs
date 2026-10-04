import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { normalizeBusSnapshot, readGzipJson, ROUTE_URL, SHAPE_URL, VEHICLE_URL } from './src/bus-data.mjs';
import { applyRouteMotion, buildShapeIndex, createRouteMotionModel } from './src/route-motion.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || '127.0.0.1';
const CACHE_MS = 1_000;
const ROUTE_CACHE_MS = 6 * 60 * 60 * 1000;
let cache = null;
let inflight = null;
let routeCache = null;
let routeInflight = null;
let shapeCache = null;
let shapeInflight = null;
let motionModels = new Map();
let modeledSnapshotAt = null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

async function currentRoutes() {
  if (routeCache && Date.now() - routeCache.cachedAt < ROUTE_CACHE_MS) return routeCache.data;
  if (routeInflight) return routeInflight;
  routeInflight = (async () => {
    const response = await fetch(ROUTE_URL, { headers: { accept: 'application/gzip, application/json' } });
    const data = await readGzipJson(response);
    routeCache = { cachedAt: Date.now(), data };
    return data;
  })().finally(() => { routeInflight = null; });
  return routeInflight;
}

async function currentShapeIndex() {
  if (shapeCache && Date.now() - shapeCache.cachedAt < ROUTE_CACHE_MS) return shapeCache.data;
  if (shapeInflight) return shapeInflight;
  shapeInflight = (async () => {
    const response = await fetch(SHAPE_URL, { headers: { accept: 'application/gzip, application/json' } });
    const rows = await readGzipJson(response);
    const data = buildShapeIndex(rows);
    shapeCache = { cachedAt: Date.now(), data };
    return data;
  })().finally(() => { shapeInflight = null; });
  return shapeInflight;
}

async function currentBuses() {
  if (cache && Date.now() - cache.cachedAt < CACHE_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const [vehicleResponse, routes, shapeIndex] = await Promise.all([
      fetch(VEHICLE_URL, { cache: 'no-store', headers: { accept: 'application/gzip, application/json' } }),
      currentRoutes(),
      currentShapeIndex().catch(error => {
        console.warn('路線軌跡暫時無法取得，改用方位推估：', error.message);
        return null;
      }),
    ]);
    const vehicles = await readGzipJson(vehicleResponse);
    const data = normalizeBusSnapshot(vehicles, routes);
    if (shapeIndex && data.snapshotAt !== modeledSnapshotAt) {
      const previousModels = motionModels;
      motionModels = new Map(data.buses.map(bus => [bus.id, createRouteMotionModel(bus, shapeIndex, {
        previousModel: previousModels.get(bus.id),
      })]));
      modeledSnapshotAt = data.snapshotAt;
    }
    cache = { cachedAt: Date.now(), data };
    return data;
  })().finally(() => { inflight = null; });
  return inflight;
}

function sendJson(response, body, status = 200, acceptEncoding = '') {
  const json = Buffer.from(JSON.stringify(body));
  const compress = json.length >= 1_024 && /(?:^|,)\s*gzip(?:\s*;|\s*,|$)/i.test(acceptEncoding);
  const payload = compress ? gzipSync(json, { level: 1 }) : json;
  response.writeHead(status, {
    'content-type': MIME['.json'],
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'vary': 'accept-encoding',
    ...(compress ? { 'content-encoding': 'gzip' } : {}),
  });
  response.end(payload);
}

async function staticFile(pathname, response) {
  const aliases = {
    '/vendor/maplibre-gl.mjs': 'node_modules/maplibre-gl/dist/maplibre-gl.mjs',
    '/vendor/maplibre-gl-shared.mjs': 'node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs',
    '/vendor/maplibre-gl-worker.mjs': 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs',
    '/vendor/maplibre-gl.css': 'node_modules/maplibre-gl/dist/maplibre-gl.css',
  };
  const relative = aliases[pathname] || (pathname === '/' ? 'public/index.html' : `public${pathname}`);
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT + path.sep)) return false;
  try {
    const data = await readFile(target);
    response.writeHead(200, {
      'content-type': path.extname(target) === '.mjs' ? MIME['.js'] : MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': aliases[pathname] ? 'public, max-age=86400' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    response.end(data);
    return true;
  } catch { return false; }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return;
    }
    if (url.pathname === '/api/buses') {
      const data = await currentBuses();
      const checkedAtMs = Date.now();
      sendJson(response, {
        ...data,
        buses: applyRouteMotion(data.buses, motionModels, checkedAtMs),
        checkedAt: new Date(checkedAtMs).toISOString(),
      }, 200, request.headers['accept-encoding']);
      return;
    }
    if (url.pathname === '/api/health') {
      sendJson(response, { ok: true, cached: !!cache, ageMs: cache ? Date.now() - cache.cachedAt : null }, 200, request.headers['accept-encoding']);
      return;
    }
    if (await staticFile(decodeURIComponent(url.pathname), response)) return;
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found');
  } catch (error) {
    console.error(error);
    sendJson(response, { error: '公車資料暫時無法取得，請稍後再試。' }, 502, request.headers['accept-encoding']);
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`無法啟動：連接埠 ${PORT} 已被其他程式使用。可先關閉舊伺服器，或使用 PORT=5181 npm start。`);
  } else {
    console.error('伺服器啟動失敗：', error.message);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`Taipei Bus Live: http://${HOST}:${PORT}`);
});

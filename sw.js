// sw.js – Service Worker: spielt zwei Rollen.
// 1) "Fake-Server": fängt alle fetch('/api/...')-Aufrufe ab und beantwortet sie
//    lokal (sql.js + IndexedDB) statt über einen echten Server. Dadurch bleibt
//    index.html praktisch unverändert.
// 2) PWA-Grundlage: cached die App-Dateien, damit "Zum Home-Bildschirm hinzufügen"
//    auf iPad/iPhone/Android funktioniert und die App auch offline startet
//    (Live-Preise brauchen natürlich weiterhin Internet).

const CACHE_VERSION = 'ttt-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './db-browser.js',
  './adapters-browser.js',
  './server-logic.js',
  './pokemon-i18n.json',
  './manifest.json',
  './lib/sql-wasm.js',
  './lib/sql-wasm.wasm',
  './lib/xlsx.full.min.js',
];

importScripts('./lib/sql-wasm.js');
importScripts('./lib/xlsx.full.min.js');
importScripts('./db-browser.js');
importScripts('./adapters-browser.js');
importScripts('./server-logic.js');

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((e) => console.warn('SW: App-Shell-Cache fehlgeschlagen', e))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )),
    ])
  );
});

let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = self.DB.init({ locateFile: (f) => './lib/' + f }).then(() => {
      // Automatische Sicherung wie früher beim Server-Start
      return self.DB.backupDatabase().catch(() => {});
    });
  }
  return readyPromise;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) {
    event.respondWith((async () => {
      await ensureReady();
      let result;
      try {
        result = await self.ServerLogic.handle(event.request);
      } catch (e) {
        return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (!result) {
        return new Response(JSON.stringify({ error: 'Unbekannte Route' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      const headers = Object.assign({}, result.headers || {});
      if (result.buffer) {
        headers['Content-Type'] = result.contentType || 'application/octet-stream';
        return new Response(result.buffer, { status: result.status || 200, headers });
      }
      headers['Content-Type'] = 'application/json; charset=utf-8';
      const bodyText = result.json === null ? '' : JSON.stringify(result.json);
      return new Response(bodyText, { status: result.status || 200, headers });
    })());
    return;
  }

  // App-Shell: erst aus dem Netz versuchen (damit Updates ankommen), sonst aus dem Cache.
  event.respondWith(
    fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(event.request))
  );
});

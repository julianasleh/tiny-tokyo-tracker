// sw.js – nur noch fuer die PWA-App-Huelle (Offline-Start, "Zum Home-Bildschirm").
// Die api/...-Aufrufe werden seit der Supabase-Umstellung direkt von der Seite
// selbst beantwortet (siehe window.fetch-Override in index.html) -- der Service
// Worker muss dafuer nichts mehr tun.

const CACHE_VERSION = 'ttt-shell-v42';
const APP_SHELL = [
  './',
  './index.html',
  './config.js',
  './content.js',
  './db-supabase.js',
  './adapters-browser.js',
  './server-logic.js',
  './pokemon-i18n.json',
  './manifest.json',
  './lib/supabase.js',
  './lib/xlsx.full.min.js',
  './legal.html',
  './lib/fonts/inter-latin-400-normal.woff2',
  './lib/fonts/inter-latin-500-normal.woff2',
  './lib/fonts/inter-latin-600-normal.woff2',
  './lib/fonts/inter-latin-700-normal.woff2',
  './lib/fonts/space-grotesk-latin-500-normal.woff2',
  './lib/fonts/space-grotesk-latin-600-normal.woff2',
  './lib/fonts/space-grotesk-latin-700-normal.woff2',
];

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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // api/-Aufrufe NICHT anfassen -- die werden schon von der Seite selbst
  // (window.fetch-Override) beantwortet, bevor sie hier ankommen wuerden.
  if (url.pathname.includes('/api/')) return;

  event.respondWith(
    // 'no-cache': immer kurz beim Server nachfragen (ETag-Abgleich), damit
    // nach einem Update nie eine veraltete Datei aus dem HTTP-Cache kommt.
    fetch(event.request, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(event.request))
  );
});

/* COME LUPI - service worker
   - Salva una copia dell'app sul dispositivo (funziona offline).
   - Con rete: usa sempre la versione online (controllo leggero via ETag, senza
     riscaricare i 17 MB se non sono cambiati).
   - Rete lenta o assente: apre subito la copia salvata e, se nel frattempo
     online c'e' una versione nuova, la scarica e avvisa la pagina.
   - Non legge e non invia mai i dati personali (localStorage resta com'e'). */
'use strict';
const CACHE = 'comelupi-app-v1';
const APP_URL = new URL('./', self.registration.scope).href;
const ASSETS = ['./manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];
const NET_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.add(new Request(APP_URL, { cache: 'reload' }));
    await Promise.all(ASSETS.map(a => cache.add(a).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const fingerprint = r => r ? (r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length') || '') : '';

async function notify(msg) {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage(msg);
}

/* Scarica la pagina online (revalidazione HTTP: 304 se invariata) e aggiorna la copia.
   Restituisce la risposta e se la versione e' cambiata rispetto a quella salvata. */
async function refreshApp() {
  const cache = await caches.open(CACHE);
  const old = await cache.match(APP_URL);
  const fresh = await fetch(APP_URL, { cache: 'no-cache' });
  if (!fresh.ok) throw new Error('HTTP ' + fresh.status);
  const changed = !!old && fingerprint(old) !== fingerprint(fresh);
  await cache.put(APP_URL, fresh.clone());
  return { fresh, changed };
}

async function handleNavigation() {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(APP_URL);
  const network = refreshApp();
  if (!cached) return (await network).fresh;               // prima visita: serve la rete
  const timeout = new Promise(res => setTimeout(() => res(null), NET_TIMEOUT_MS));
  const winner = await Promise.race([network.catch(() => null), timeout]);
  if (winner) return winner.fresh;                          // rete ok: versione online
  // rete lenta/assente: copia salvata subito, aggiornamento in background
  network.then(r => { if (r.changed) notify({ type: 'comelupi-update-ready' }); }).catch(() => {});
  return cached;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // link esterni: nessun intervento
  if (req.mode === 'navigate' && (url.href.split(/[?#]/)[0] === APP_URL || url.pathname.endsWith('/index.html'))) {
    event.respondWith(handleNavigation());
    return;
  }
  // icone e manifest: copia salvata, aggiornata in background
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const net = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; });
    return cached || net;
  })());
});

/* La pagina chiede un controllo (al ritorno della rete o quando torna in primo piano). */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'comelupi-check-update') {
    event.waitUntil(refreshApp().then(r => { if (r.changed) return notify({ type: 'comelupi-update-ready' }); }).catch(() => {}));
  }
});

// Service worker QuestLog.
// Strategia: cache dell'APP-SHELL (HTML/CSS/JS/icone) per installabilità e
// avvio veloce/offline del guscio. I DATI dell'agenda NON sono mai messi in
// cache (scelta di progetto: app sempre online; le chiamate al Web App GAS
// passano sempre dalla rete).

var CACHE = 'questlog-shell-v22';
var SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './cover.png',
  './circle.png',
  './circle-day.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var url = e.request.url;
  // Le chiamate al backend GAS vanno SEMPRE in rete, mai in cache.
  if (url.indexOf('script.google.com') !== -1) return;
  if (e.request.method !== 'GET') return;
  // App-shell: cache-first, con fallback rete.
  e.respondWith(
    caches.match(e.request).then(function(hit){ return hit || fetch(e.request); })
  );
});

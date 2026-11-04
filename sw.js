// 小帳本 service worker：把 APP 本身存起來，沒網路也能打開記帳
const CACHE = "xzb-v1";
const SHELL = ["./", "index.html", "app.js", "manifest.json", "icon-192.png", "icon-512.png", "icon-180.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // 股價資料一律走網路，不快取
  if (/twse\.com\.tw|tpex\.org\.tw/.test(url.hostname)) return;
  // APP 檔案：先用網路取得最新版，離線時用快取
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
    return;
  }
  // 字型：有快取就用快取
  if (/fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })));
  }
});

// YB-PDF 서비스 워커 — 인터넷이 없어도 앱이 열리도록 화면 파일을 기기에 보관
// PDF 파일 자체는 다루지 않음 (모든 처리는 이 기기 안에서만)
const VERSION = 'v0.3.0';
const SHELL = `ybpdf-shell-${VERSION}`;
const ASSETS = 'ybpdf-assets-pdfjs6.5'; // pdf.js 판이 바뀌면 이름을 바꿔 보조 파일을 새로 받음 // 글꼴·pdf.js 보조 파일·이름에 해시가 붙은 빌드 파일 (내용이 바뀌지 않음)
const SCOPE = self.registration.scope;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll([SCOPE, `${SCOPE}manifest.webmanifest`, `${SCOPE}icons/icon.svg`, `${SCOPE}icons/icon-192.png`])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ybpdf-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

const isFont = (url) => url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('pretendard');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const cacheFirst = (name) => e.respondWith(
    caches.open(name).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone()).catch(() => {});
      return res;
    })
  );

  if (isFont(url)) return cacheFirst(ASSETS);
  if (url.origin !== self.location.origin || !req.url.startsWith(SCOPE)) return;

  // 앱 첫 화면: 최신본 우선, 오프라인이면 보관본
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(SCOPE, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(SCOPE))
    );
    return;
  }
  const p = url.pathname.slice(new URL(SCOPE).pathname.length);
  if (p.startsWith('assets/') || p.startsWith('fonts/') || p.startsWith('pdfjs/') || p.startsWith('wasm/')) return cacheFirst(ASSETS);
  // 그 밖(아이콘·manifest): 보관본 먼저, 뒤에서 갱신
  e.respondWith(
    caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => hit);
      return hit || net;
    })
  );
});

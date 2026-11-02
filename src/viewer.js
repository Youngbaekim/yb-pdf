// 보기 화면: 쪽 배치(1쪽·2쪽·표지 단독), 확대, 그리기(지연), 글자 층, 쪽 이동
import { pdfjs } from './pdfjs.js';
import { S, emit, on, setPref } from './state.js';

const viewer = () => document.getElementById('viewer');
const pagesEl = () => document.getElementById('pages');
const GAP = 14; // 쪽 사이 간격(px)
const PAD = 22; // 바깥 여백(px)
const MAX_PIXELS = 16_000_000; // 캔버스 한 장 최대 화소 (메모리 보호)

let els = []; // 쪽 요소
let rows = []; // [[i, j?], ...]
let rowTops = [];
let renderState = []; // { scale, task, text }
let io = null;
let rerenderTimer = 0;

/* ───────── 문서 준비 ───────── */
export async function setupPages() {
  const n = S.pdf.numPages;
  S.pages = new Array(n);
  // 쪽 크기 읽기 (여러 쪽을 함께 요청)
  const B = 24;
  for (let s = 0; s < n; s += B) {
    const batch = [];
    for (let i = s; i < Math.min(n, s + B); i++) {
      batch.push(S.pdf.getPage(i + 1).then((p) => {
        const vp = p.getViewport({ scale: 1 });
        S.pages[i] = { w: vp.width, h: vp.height, rotate: p.rotate, view: p.view, vp };
      }));
    }
    await Promise.all(batch);
  }
}

export function clearPages() {
  io?.disconnect();
  for (const st of renderState) st?.task?.cancel?.();
  els = [];
  rows = [];
  renderState = [];
  const pe = pagesEl();
  if (pe) pe.innerHTML = '';
}

function buildRows() {
  const n = S.pages.length;
  rows = [];
  if (S.spread === 2) {
    let i = 0;
    if (S.coverAlone && n > 0) { rows.push([null, 0]); i = 1; }
    for (; i < n; i += 2) rows.push(i + 1 < n ? [i, i + 1] : [i, null]);
  } else {
    for (let i = 0; i < n; i++) rows.push([i]);
  }
}

/** 쪽 요소를 새로 만듦 (보기 방식이 바뀔 때) */
export function buildDom() {
  clearPagesKeepState();
  document.getElementById('app').classList.add('has-doc'); // 쪽 영역이 보여야 크기를 잴 수 있음
  buildRows();
  const pe = pagesEl();
  pe.classList.toggle('spread', S.spread === 2);
  const frag = document.createDocumentFragment();
  els = new Array(S.pages.length);
  renderState = new Array(S.pages.length);
  rows.forEach((r, ri) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.r = ri;
    for (const i of r) {
      if (i == null) {
        const sp = document.createElement('div');
        sp.className = 'page-spacer';
        row.appendChild(sp);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.i = i;
      el.innerHTML = `<canvas class="pg"></canvas><div class="textLayer"></div><svg class="ov" xmlns="http://www.w3.org/2000/svg"></svg><div class="ui"></div><span class="pno">${i + 1}</span>`;
      els[i] = el;
      row.appendChild(el);
    }
    frag.appendChild(row);
  });
  pe.appendChild(frag);
  io = new IntersectionObserver(onIntersect, { root: viewer(), rootMargin: '120% 0px' });
  els.forEach((el) => io.observe(el));
  applySizes();
}
function clearPagesKeepState() {
  io?.disconnect();
  for (const st of renderState) st?.task?.cancel?.();
  pagesEl().innerHTML = '';
}

export const pageEl = (i) => els[i];
export const pageCount = () => S.pages.length;

/* ───────── 배율 ───────── */
function rowWidth1(r) {
  // 배율 1일 때 줄 너비 (2쪽 보기에서 빈 칸은 맞은편 쪽 너비)
  if (r.length === 1) return S.pages[r[0]].w;
  const [a, b] = r;
  const wa = a != null ? S.pages[a].w : S.pages[b].w;
  const wb = b != null ? S.pages[b].w : S.pages[a].w;
  return wa + wb + GAP;
}
export function fitScale(mode) {
  const v = viewer();
  const availW = Math.max(120, v.clientWidth - PAD * 2);
  const availH = Math.max(120, v.clientHeight - PAD * 2);
  // 대표 너비: 줄 너비의 최빈값에 가까운 값(중앙값) → 유난히 큰 한 쪽 때문에 전체가 작아지지 않게
  const ws = rows.map(rowWidth1).sort((a, b) => a - b);
  const wMed = ws[Math.floor(ws.length / 2)] || 600;
  if (mode === 'width') return availW / wMed;
  const hs = S.pages.map((p) => p.h).sort((a, b) => a - b);
  const hMed = hs[Math.floor(hs.length / 2)] || 800;
  return Math.min(availW / wMed, availH / hMed);
}

export function targetScale() {
  if (typeof S.zoomMode === 'number') return S.zoomMode;
  return fitScale(S.zoomMode);
}

/** 쪽 요소 크기 다시 계산 (+ 이미 그린 캔버스는 늘이거나 줄여 즉시 보여 줌) */
function applySizes() {
  const sc = S.scale;
  const pe = pagesEl();
  pe.style.setProperty('--gap', `${GAP}px`);
  pe.style.setProperty('--pad', `${PAD}px`);
  S.pages.forEach((p, i) => {
    p.vp = p.vp.clone({ scale: sc });
    const el = els[i];
    if (!el) return;
    const w = Math.floor(p.w * sc), h = Math.floor(p.h * sc);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.setProperty('--scale-factor', sc);
    el.style.setProperty('--total-scale-factor', sc);
    el.style.setProperty('--scale-round-x', '1px');
    el.style.setProperty('--scale-round-y', '1px');
    const cv = el.querySelector('canvas');
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
  });
  // 2쪽 보기의 빈 칸 = 맞은편 쪽 크기
  pe.querySelectorAll('.page-spacer').forEach((sp) => {
    const other = sp.parentElement.querySelector('.page');
    if (other) { sp.style.width = other.style.width; sp.style.height = other.style.height; }
  });
  // 가로로 가장 넓은 줄 + 여백 = 내용 너비 (화면보다 넓으면 가로 스크롤)
  const maxRow = rows.reduce((m, r) => Math.max(m, Math.floor(rowWidth1(r) * sc)), 0);
  pe.style.setProperty('--content-w', `${maxRow + PAD * 2}px`);
  measureRows();
  emit('layout');
}
function measureRows() {
  rowTops = [...pagesEl().children].map((r) => r.offsetTop);
}

/** 배율 바꾸기. anchor: {x,y} 화면 좌표(이 점이 그대로 머물도록) */
export function setScale(sc, anchor) {
  sc = Math.max(0.1, Math.min(8, sc));
  if (!S.pdf) { S.scale = sc; return; }
  const v = viewer();
  const old = S.scale;
  const rect = v.getBoundingClientRect();
  const ax = anchor ? anchor.x - rect.left : v.clientWidth / 2;
  const ay = anchor ? anchor.y - rect.top : 0;
  const cx = v.scrollLeft + ax, cy = v.scrollTop + ay;
  // 지금 보는 쪽 기준 위치 (간격 때문에 생기는 오차를 줄이기 위해)
  const cur = S.current;
  const el = els[cur];
  const frac = el ? (cy - el.offsetTop) / el.offsetHeight : 0;
  S.scale = sc;
  applySizes();
  const r = sc / old;
  // 기준점이 없으면 가로 가운데 (폭이 넓은 가로 쪽이 섞인 문서에서 세로 쪽이 가운데 보이도록)
  v.scrollLeft = anchor ? cx * r - ax : (v.scrollWidth - v.clientWidth) / 2;
  if (el && !anchor) v.scrollTop = el.offsetTop + frac * el.offsetHeight - ay;
  else v.scrollTop = cy * r - ay;
  invalidateAll();
  emit('scale');
}
export function zoomBy(f, anchor) {
  S.zoomMode = Math.round(S.scale * f * 100) / 100;
  setPref('zoom', S.zoomMode);
  setScale(S.zoomMode, anchor);
}
export function setZoomMode(mode) {
  S.zoomMode = mode;
  setPref('zoom', mode);
  setScale(targetScale());
}
export function refit() {
  if (!S.pdf) return;
  if (typeof S.zoomMode !== 'number') setScale(targetScale());
  else measureRows();
}

/* ───────── 그리기 ───────── */
function invalidateAll() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    renderState.forEach((st, i) => { if (st) st.stale = true; });
    visibleNow().forEach((i) => renderPage(i));
  }, 160);
}
function visibleNow() {
  const v = viewer();
  const top = v.scrollTop - v.clientHeight, bot = v.scrollTop + v.clientHeight * 2;
  const out = [];
  els.forEach((el, i) => {
    if (!el) return;
    const t = el.offsetTop, b = t + el.offsetHeight;
    if (b >= top && t <= bot) out.push(i);
  });
  return out;
}
function onIntersect(entries) {
  for (const e of entries) {
    const i = Number(e.target.dataset.i);
    if (e.isIntersecting) renderPage(i);
    else releasePage(i);
  }
}

function releasePage(i) {
  const st = renderState[i];
  if (!st) return;
  st.task?.cancel?.();
  st.textLayer?.cancel?.();
  const el = els[i];
  if (el) {
    const cv = el.querySelector('canvas');
    cv.width = 0; cv.height = 0;
    el.querySelector('.textLayer').replaceChildren();
    el.classList.remove('ready');
  }
  renderState[i] = null;
}

export async function renderPage(i) {
  const el = els[i];
  if (!el || !S.pdf) return;
  const st = renderState[i];
  if (st && !st.stale && st.scale === S.scale) return;
  if (st?.busy) { st.again = true; return; }
  const me = { scale: S.scale, busy: true, stale: false };
  renderState[i] = me;
  try {
    const page = await S.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: S.scale });
    let dpr = window.devicePixelRatio || 1;
    if (vp.width * vp.height * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (vp.width * vp.height));
    // 새 캔버스에 그린 뒤 바꿔 끼움 (그리는 동안 깜빡임 방지)
    const cv = document.createElement('canvas');
    cv.className = 'pg';
    cv.width = Math.floor(vp.width * dpr);
    cv.height = Math.floor(vp.height * dpr);
    cv.style.width = `${Math.floor(vp.width)}px`;
    cv.style.height = `${Math.floor(vp.height)}px`;
    me.task = page.render({
      canvas: cv,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    });
    await me.task.promise;
    if (renderState[i] !== me) return;
    el.querySelector('canvas').replaceWith(cv);
    // 글자 층 (선택·형광펜·텍스트 수정에 사용)
    const tl = el.querySelector('.textLayer');
    tl.replaceChildren();
    me.textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
    await me.textLayer.render().catch(() => {});
    if (renderState[i] !== me) return;
    el.classList.add('ready');
    el.classList.toggle('no-text', !tl.querySelector('span'));
    emit('page-rendered', i);
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.warn('쪽 그리기 실패', i + 1, e);
  } finally {
    me.busy = false;
    if (me.again && renderState[i] === me) { me.again = false; me.stale = true; renderPage(i); }
  }
}

/** 지금 그려진 캔버스 (색 추출용) */
export const canvasOf = (i) => els[i]?.querySelector('canvas');

/* ───────── 좌표 변환 ───────── */
/** 화면 좌표 → 쪽 PDF 좌표 */
export function toPdf(i, clientX, clientY) {
  const r = els[i].getBoundingClientRect();
  return S.pages[i].vp.convertToPdfPoint(clientX - r.left, clientY - r.top);
}
/** PDF 좌표 → 쪽 안의 CSS 좌표 */
export function toCss(i, x, y) {
  return S.pages[i].vp.convertToViewportPoint(x, y);
}
/** PDF 사각형 → 쪽 안의 CSS 사각형 {left, top, width, height} */
export function rectCss(i, b) {
  const p = [toCss(i, b[0], b[1]), toCss(i, b[2], b[3]), toCss(i, b[0], b[3]), toCss(i, b[2], b[1])];
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const l = Math.min(...xs), t = Math.min(...ys);
  return { left: l, top: t, width: Math.max(...xs) - l, height: Math.max(...ys) - t };
}
/** 화면 좌표가 있는 쪽 번호 */
export function pageAt(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY)?.closest?.('.page');
  return el ? Number(el.dataset.i) : -1;
}

/* ───────── 쪽 이동 ───────── */
export function updateCurrent() {
  const v = viewer();
  if (!rows.length) return;
  const y = v.scrollTop + v.clientHeight * 0.3;
  let lo = 0, hi = rowTops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rowTops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  const r = rows[lo];
  const i = r.find((x) => x != null) ?? 0;
  if (i !== S.current) { S.current = i; emit('current'); }
}
export function goTo(i, opts = {}) {
  i = Math.max(0, Math.min(S.pages.length - 1, i));
  const el = els[i];
  if (!el) return;
  const v = viewer();
  const row = el.parentElement;
  if (opts.y != null) {
    // 쪽 안의 특정 높이로 (PDF y 좌표)
    const [, cy] = toCss(i, opts.x ?? 0, opts.y);
    v.scrollTop = row.offsetTop + cy - v.clientHeight * 0.3;
  } else {
    v.scrollTop = row.offsetTop - 10;
  }
  S.current = i;
  emit('current');
}
export function step(d) {
  if (S.spread === 2) {
    const ri = rows.findIndex((r) => r.includes(S.current));
    const nr = rows[Math.max(0, Math.min(rows.length - 1, ri + d))];
    goTo(nr.find((x) => x != null));
  } else goTo(S.current + d);
}

on('scroll', updateCurrent);

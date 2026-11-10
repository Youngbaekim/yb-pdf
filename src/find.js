// 찾기 (Ctrl+F): 오른쪽 찾기 창, 띄어쓰기·대소문자 무시, 결과마다 앞뒤 문맥 3줄 미리보기
// - 쪽마다 글자를 한 번만 읽어 색인(문서별 보관) → 입력하는 즉시 결과 갱신
// - 결과를 누르면 그 쪽으로 이동하고 찾은 글자를 주황색으로 표시 (다른 결과는 연노랑)
import { S, on, emit } from './state.js';
import { goTo } from './viewer.js';
import { redrawPage, setFindMarks } from './overlay.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MAX_RESULTS = 1000;
const WS = /[\s ​　]/;

/** @type {WeakMap<object, {pages: Array<{text:string, norm:string, map:number[], items:Array<{s:number,e:number,tr:number[],w:number,h:number}>}>, done:number, loading:Promise|null}>} */
const cache = new WeakMap();
let open = false;
let query = '';
let results = []; // {page, s, e (원문 위치), rects}
let current = -1;
let runId = 0;

/* ───────── 글자 색인 ───────── */
function normChar(c) {
  if (WS.test(c)) return '';
  return c.normalize('NFKC').toLowerCase().replace(/\s/g, '');
}
async function pageIndex(pdf, i) {
  const page = await pdf.getPage(i + 1);
  const tc = await page.getTextContent();
  let text = '';
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const s = text.length;
    text += it.str;
    items.push({ s, e: text.length, tr: it.transform, w: it.width, h: it.height });
    if (it.hasEOL) text += '\n';
  }
  // 공백을 뺀 글자열 + 원문 위치 대응표
  let norm = '';
  const map = [];
  for (let k = 0; k < text.length; k++) {
    const n = normChar(text[k]);
    for (const ch of n) { norm += ch; map.push(k); }
  }
  return { text, norm, map, items };
}
function indexOf(pdf) {
  let c = cache.get(pdf);
  if (!c) { c = { pages: [], done: 0, loading: null }; cache.set(pdf, c); }
  return c;
}
/** 색인을 차례로 만들며 진행 상황을 알림 */
function ensureIndex(pdf, onProgress) {
  const c = indexOf(pdf);
  if (c.done >= pdf.numPages) return Promise.resolve(c);
  if (!c.loading) {
    c.loading = (async () => {
      for (let i = c.done; i < pdf.numPages; i++) {
        try { c.pages[i] = await pageIndex(pdf, i); } catch { c.pages[i] = { text: '', norm: '', map: [], items: [] }; }
        c.done = i + 1;
        if (i % 10 === 9) { emit('find-progress', pdf); await new Promise((r) => setTimeout(r, 0)); }
      }
      emit('find-progress', pdf);
      return c;
    })();
  }
  if (onProgress) {
    const off = on('find-progress', (p) => { if (p === pdf) onProgress(c); });
    c.loading.finally(off);
  }
  return c.loading;
}

/* ───────── 찾기 ───────── */
function search(c, q) {
  const nq = [...q].map(normChar).join('');
  const out = [];
  if (!nq) return out;
  for (let i = 0; i < c.done; i++) {
    const pg = c.pages[i];
    let from = 0;
    while (out.length < MAX_RESULTS) {
      const k = pg.norm.indexOf(nq, from);
      if (k < 0) break;
      out.push({ page: i, s: pg.map[k], e: pg.map[k + nq.length - 1] + 1 });
      from = k + 1;
    }
  }
  return out;
}

/** 글자 항목 안에서의 위치 비율 — 한글·영문·숫자 폭 차이를 반영하려고 글자 폭을 재어 나눔 */
const mctx = document.createElement('canvas').getContext('2d');
mctx.font = '100px sans-serif';
const wOf = (t) => mctx.measureText(t).width;

/** 찾은 위치의 사각형들(PDF 좌표) */
function rectsOf(pg, s, e) {
  const rects = [];
  for (const it of pg.items) {
    if (it.e <= s || it.s >= e) continue;
    const str = pg.text.slice(it.s, it.e);
    const full = wOf(str) || 1;
    const a = wOf(str.slice(0, Math.max(s, it.s) - it.s)) / full;
    const b = wOf(str.slice(0, Math.min(e, it.e) - it.s)) / full;
    const [m0, m1, m2, m3, x, y] = it.tr;
    const fs = Math.hypot(m2, m3) || it.h || 10;
    const vertical = Math.abs(m1) > Math.abs(m0); // 세로쓰기·회전 글자
    if (vertical) {
      const h = it.h || it.w;
      rects.push([x - fs * 0.2, y + h * a - fs * 0.1, x + fs * 1.0, y + h * b + fs * 0.1]);
    } else {
      rects.push([x + it.w * a, y - fs * 0.22, x + it.w * b, y + fs * 0.9]);
    }
  }
  return rects;
}

function snippet(pg, s, e) {
  const before = 34, after = 110;
  let a = Math.max(0, s - before), b = Math.min(pg.text.length, e + after);
  const flat = (t) => t.replace(/\s+/g, ' ');
  return `${a > 0 ? '…' : ''}${esc(flat(pg.text.slice(a, s)))}<mark>${esc(flat(pg.text.slice(s, e)))}</mark>${esc(flat(pg.text.slice(e, b)))}${b < pg.text.length ? '…' : ''}`;
}

async function run() {
  const my = ++runId;
  const pdf = S.pdf;
  const list = $('#find-list');
  const stat = $('#find-stat');
  results = [];
  current = -1;
  marksChanged();
  if (!pdf) { stat.textContent = '문서를 먼저 여세요.'; list.innerHTML = ''; return; }
  if (!query.replace(/\s/g, '')) { stat.textContent = ''; list.innerHTML = ''; return; }
  const c = indexOf(pdf);
  const show = () => {
    if (my !== runId) return;
    results = search(c, query);
    const reading = c.done < pdf.numPages ? ` · 글자 읽는 중 ${c.done}/${pdf.numPages}쪽` : '';
    const noText = c.done >= pdf.numPages && c.pages.every((p) => !p.norm);
    stat.textContent = noText ? '이 문서에는 글자 정보가 없습니다(스캔 이미지 등).'
      : `${results.length >= MAX_RESULTS ? `${MAX_RESULTS}건 이상` : `${results.length}건`}${reading}`;
    renderList();
    marksChanged();
  };
  show();
  if (c.done < pdf.numPages) {
    await ensureIndex(pdf, show);
    show();
  }
}

function renderList() {
  const c = indexOf(S.pdf);
  let html = '';
  let pg = -1;
  results.forEach((r, k) => {
    if (r.page !== pg) {
      pg = r.page;
      const n = results.filter((x) => x.page === pg).length;
      html += `<div class="fr-page">${pg + 1}쪽 <span>${n}건</span></div>`;
    }
    html += `<button class="fr-item${k === current ? ' on' : ''}" data-k="${k}"><span class="fr-tx">${snippet(c.pages[r.page], r.s, r.e)}</span></button>`;
  });
  $('#find-list').innerHTML = html || (query.trim() ? '<p class="fr-none">찾는 내용이 없습니다.</p>' : '');
}

/* ───────── 쪽 위 표시 ───────── */
const touched = new Set();
function marksChanged() {
  const pages = new Set(results.map((r) => r.page));
  for (const i of new Set([...pages, ...touched])) redrawPage(i);
  touched.clear();
  pages.forEach((i) => touched.add(i));
}
setFindMarks((i) => {
  if (!open || !results.length || !S.pdf) return '';
  const c = indexOf(S.pdf);
  const pg = c.pages[i];
  if (!pg) return '';
  let out = '';
  results.forEach((r, k) => {
    if (r.page !== i) return;
    r.rects ||= rectsOf(pg, r.s, r.e);
    const cur = k === current;
    out += r.rects.map((q) => `<rect class="find-hit${cur ? ' cur' : ''}" x="${q[0]}" y="${q[1]}" width="${q[2] - q[0]}" height="${q[3] - q[1]}" rx="1" fill="${cur ? '#ff8a1f' : '#ffd84d'}" fill-opacity="${cur ? 0.75 : 0.45}"/>`).join('');
  });
  return out;
});

function select(k) {
  if (!results.length) return;
  current = (k + results.length) % results.length;
  const r = results[current];
  const pg = indexOf(S.pdf).pages[r.page];
  r.rects ||= rectsOf(pg, r.s, r.e);
  const top = r.rects.length ? Math.max(...r.rects.map((q) => q[3])) : undefined;
  goTo(r.page, top != null ? { x: r.rects[0][0], y: top } : {});
  marksChanged();
  document.querySelectorAll('.fr-item').forEach((b) => b.classList.toggle('on', Number(b.dataset.k) === current));
  document.querySelector('.fr-item.on')?.scrollIntoView({ block: 'nearest' });
  $('#find-pos').textContent = `${current + 1}/${results.length}`;
}

/* ───────── 열고 닫기 ───────── */
export function openFind() {
  open = true;
  document.getElementById('app').dataset.find = 'open';
  const inp = $('#find-input');
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length < 80 && !sel.includes('\n')) { inp.value = sel; query = sel; run(); }
  inp.focus();
  inp.select();
  if (S.pdf) ensureIndex(S.pdf); // 미리 읽기 시작
  emit('find-toggle');
}
export function closeFind() {
  open = false;
  document.getElementById('app').dataset.find = 'closed';
  marksChanged();
  results.forEach((r) => touched.add(r.page));
  for (const i of touched) redrawPage(i);
  touched.clear();
  emit('find-toggle');
}
export const findOpen = () => open;

export function initFind() {
  const inp = $('#find-input');
  let t = 0;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { query = inp.value; $('#find-pos').textContent = ''; run(); }, 160);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (query !== inp.value) { query = inp.value; run().then(() => select(0)); } else select(current + (e.shiftKey ? -1 : 1)); }
  });
  $('#find-list').addEventListener('click', (e) => {
    const b = e.target.closest('.fr-item');
    if (!b) return;
    select(Number(b.dataset.k));
    inp.focus({ preventScroll: true }); // 이어서 Enter로 다음 결과
  });
  $('#find').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFind(); } });
  $('#find-prev').addEventListener('click', () => select(current - 1));
  $('#find-next').addEventListener('click', () => select(current + 1));
  $('#find-close').addEventListener('click', closeFind);
  // 탭(문서)이 바뀌면 같은 말로 다시 찾기
  on('doc', () => { if (open) { $('#find-pos').textContent = ''; run(); } });
}
// 단축키용
export function findNext(back) { if (open && results.length) select(current + (back ? -1 : 1)); else openFind(); }

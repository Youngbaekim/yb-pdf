// 찾기 (Ctrl+F): 오른쪽 찾기 창, 띄어쓰기·대소문자 무시, 결과마다 앞뒤 문맥 3줄 미리보기
// - 쪽마다 글자를 한 번만 읽어 색인(문서별 보관) → 입력하는 즉시 결과 갱신
// - 결과를 누르면 그 쪽으로 이동하고 찾은 글자를 주황색으로 표시 (다른 결과는 연노랑)
import { S, on, emit, pref, setPref } from './state.js';
import { goTo } from './viewer.js';
import { redrawPage, setFindMarks } from './overlay.js';
import { pdfjs } from './pdfjs.js';
import { ocrPage, pageHasImage, stopOcr } from './ocr.js';

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
// 찾기 선택 사항 (체크박스, 기기에 기억)
// ocr: 그림 속 글자 찾기 — 'off' 안 함 · 'blank' 그림만 있는 쪽 · 'all' 모든 그림
const opt = { space: pref('find-space', true), cs: pref('find-case', true), ocr: pref('find-ocr', 'off') };

/** 글자 하나를 비교용으로 바꿈 (공백은 ' ' 하나로 — 띄어쓰기 무시이면 버림) */
function normChar(c) {
  if (WS.test(c)) return opt.space ? '' : ' ';
  let n = c.normalize('NFKC');
  if (opt.cs) n = n.toLowerCase();
  return n.replace(/\s/g, opt.space ? '' : ' ');
}
/** 비교용 글자열 + 원문 위치 대응표 (연속 공백은 하나로) */
function normalize(text) {
  let norm = '';
  const map = [];
  for (let k = 0; k < text.length; k++) {
    for (const ch of normChar(text[k])) {
      if (ch === ' ' && (norm.endsWith(' ') || norm === '')) continue;
      norm += ch;
      map.push(k);
    }
  }
  return { norm, map };
}
const optKey = () => `${opt.space ? 1 : 0}${opt.cs ? 1 : 0}`;
/** 쪽의 비교용 글자열 (선택 사항별로 한 번만 만듦) */
function normOf(pg) {
  pg.norms ||= {};
  return (pg.norms[optKey()] ||= normalize(pg.text));
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
  return { text, items, hasText: /\S/.test(text) };
}
function indexOf(pdf) {
  let c = cache.get(pdf);
  if (!c) { c = { pages: [], done: 0, loading: null, ocr: [], img: [] }; cache.set(pdf, c); }
  return c;
}
/** 색인을 차례로 만들며 진행 상황을 알림 */
function ensureIndex(pdf, onProgress) {
  const c = indexOf(pdf);
  if (c.done >= pdf.numPages) return Promise.resolve(c);
  if (!c.loading) {
    c.loading = (async () => {
      for (let i = c.done; i < pdf.numPages; i++) {
        try { c.pages[i] = await pageIndex(pdf, i); } catch { c.pages[i] = { text: '', items: [], hasText: false }; }
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
  const nq = normalize(q.trim()).norm.trim();
  const out = [];
  if (!nq) return out;
  for (let i = 0; i < c.done; i++) {
    const srcs = [[c.pages[i], false]];
    if (ocrUsable(c, i)) srcs.push([c.ocr[i], true]); // 그림에서 인식한 글자
    for (const [src, ocr] of srcs) {
      const { norm, map } = normOf(src);
      let from = 0;
      while (out.length < MAX_RESULTS) {
        const k = norm.indexOf(nq, from);
        if (k < 0) break;
        out.push({ page: i, s: map[k], e: map[k + nq.length - 1] + 1, ocr });
        from = k + 1;
      }
    }
  }
  return out;
}
const srcOf = (c, r) => (r.ocr ? c.ocr[r.page] : c.pages[r.page]);
/** 이 쪽의 인식 결과를 찾기에 쓸지 */
function ocrUsable(c, i) {
  if (opt.ocr === 'off' || !c.ocr[i]) return false;
  return opt.ocr === 'all' || !c.pages[i]?.hasText;
}
/** 인식이 필요한 쪽인지 (그림만 있는 쪽 / 모든 그림 모드에서는 그림이 든 쪽) */
function needsOcr(c, i) {
  if (opt.ocr === 'off' || c.ocr[i]) return false;
  const pg = c.pages[i];
  if (!pg) return false;
  if (!pg.hasText) return true;
  return opt.ocr === 'all' && c.img[i] !== false;
}

/* ───────── 그림 속 글자 인식 (찾기 창에서 켤 때만) ───────── */
let ocrBusy = false;
let ocrNote = '';
/** 인식한 낱말 → 찾기용 글자열(줄 단위) + 낱말 위치. 원래 글자와 겹치는 낱말은 뺌(같은 말이 두 번 찾아지지 않게) */
function ocrSource(words, pg) {
  let boxes = [];
  if (pg.hasText) boxes = pg.items.flatMap((it) => rectsOf(pg, it.s, it.e));
  const keep = words.filter((w) => {
    const [x1, y1, x2, y2] = w.rect;
    const area = Math.max(1, (x2 - x1) * (y2 - y1));
    return !boxes.some((b) => Math.max(0, Math.min(x2, b[2]) - Math.max(x1, b[0])) * Math.max(0, Math.min(y2, b[3]) - Math.max(y1, b[1])) > area * 0.4);
  });
  let text = '';
  const items = [];
  let line = -1;
  let prev = null;
  for (const w of keep) {
    if (w.line !== line) { if (text) text += '\n'; line = w.line; } else {
      // 한글이 글자마다 끊겨 인식되는 경우가 많아, 낱말 사이 간격이 좁으면 붙여 씀
      const h = Math.max(1, w.rect[3] - w.rect[1]);
      if (w.rect[0] - prev.rect[2] > h * 0.28) text += ' ';
    }
    prev = w;
    const s = text.length;
    text += w.t;
    items.push({ s, e: text.length, rect: w.rect });
  }
  return { text, items, hasText: !!text };
}
async function kickOcr() {
  if (ocrBusy) return;
  ocrBusy = true;
  try {
    for (;;) {
      const pdf = S.pdf;
      if (!open || !pdf || opt.ocr === 'off') break;
      const c = indexOf(pdf);
      if (c.done < pdf.numPages) await ensureIndex(pdf);
      // 모든 그림 모드: 그림이 든 쪽인지 먼저 확인
      if (opt.ocr === 'all') {
        for (let i = 0; i < pdf.numPages; i++) {
          if (c.img[i] === undefined && c.pages[i]?.hasText) { try { c.img[i] = await pageHasImage(pdf, i, pdfjs.OPS); } catch { c.img[i] = false; } }
        }
      }
      const todo = [];
      for (let i = 0; i < pdf.numPages; i++) if (needsOcr(c, i)) todo.push(i);
      if (!todo.length) break;
      const total = todo.length;
      let n = 0;
      for (const i of todo) {
        if (!open || S.pdf !== pdf || opt.ocr === 'off') break;
        n++;
        ocrNote = ` · 그림 속 글자 인식 중 ${n}/${total}쪽`;
        refresh();
        try {
          const words = await ocrPage(pdf, i, (m) => {
            if (m.status === 'recognizing text') { ocrNote = ` · 그림 속 글자 인식 중 ${n}/${total}쪽 (${Math.round(m.progress * 100)}%)`; $('#find-stat').textContent = statText(); }
            else if (/load/.test(m.status || '')) { ocrNote = ' · 글자 인식 준비 중…'; $('#find-stat').textContent = statText(); }
          });
          c.ocr[i] = ocrSource(words, c.pages[i]);
        } catch (e) {
          console.warn('글자 인식 실패', i + 1, e);
          c.ocr[i] = { text: '', items: [], hasText: false };
        }
        refresh();
      }
    }
  } finally {
    ocrBusy = false;
    ocrNote = '';
    refresh();
  }
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
    if (it.rect) { // 인식한 낱말: 낱말 상자를 글자 폭 비율로 나눔
      const [x1, y1, x2, y2] = it.rect;
      rects.push([x1 + (x2 - x1) * a, y1 - 1, x1 + (x2 - x1) * b, y2 + 1]);
      continue;
    }
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
    const keep = current >= 0 ? results[current] : null;
    results = search(c, query);
    if (keep) current = results.findIndex((r) => r.page === keep.page && r.s === keep.s && r.ocr === keep.ocr);
    stat.textContent = statText();
    renderList();
    marksChanged();
  };
  refresh = show;
  show();
  if (c.done < pdf.numPages) {
    await ensureIndex(pdf, show);
    show();
  }
  if (opt.ocr !== 'off') kickOcr();
}
let refresh = () => {};
function statText() {
  const pdf = S.pdf;
  if (!pdf) return '';
  const c = indexOf(pdf);
  const reading = c.done < pdf.numPages ? ` · 글자 읽는 중 ${c.done}/${pdf.numPages}쪽` : '';
  const noText = c.done >= pdf.numPages && c.pages.every((p) => !p.hasText) && opt.ocr === 'off';
  if (noText) return '이 문서에는 글자 정보가 없습니다(그림·스캔).';
  if (!query.replace(/\s/g, '')) return ocrNote.replace(/^ · /, '');
  return `${results.length >= MAX_RESULTS ? `${MAX_RESULTS}건 이상` : `${results.length}건`}${reading}${ocrNote}`;
}
/** 그림만 있는 쪽 수 */
function blankPages(c) { let n = 0; for (let i = 0; i < c.done; i++) if (!c.pages[i]?.hasText) n++; return n; }

function renderList() {
  const c = indexOf(S.pdf);
  let html = '';
  // 인식을 끈 상태에서 그림만 있는 쪽이 있으면 알려 줌
  const blanks = blankPages(c);
  if (opt.ocr === 'off' && blanks && query.trim()) html += `<button class="fr-ocr-hint" data-ocr="blank">그림만 있는 쪽 ${blanks}개는 찾지 못했습니다 · <b>그림 속 글자도 찾기</b></button>`;
  let pg = -1;
  results.forEach((r, k) => {
    if (r.page !== pg) {
      pg = r.page;
      const n = results.filter((x) => x.page === pg).length;
      html += `<div class="fr-page">${pg + 1}쪽 <span>${n}건</span></div>`;
    }
    html += `<button class="fr-item${k === current ? ' on' : ''}" data-k="${k}"><span class="fr-tx">${r.ocr ? '<span class="fr-ocr" title="그림에서 인식한 글자 (틀릴 수 있음)">인식</span>' : ''}${snippet(srcOf(c, r), r.s, r.e)}</span></button>`;
  });
  if (!results.length && query.trim()) html += '<p class="fr-none">찾는 내용이 없습니다.</p>';
  $('#find-list').innerHTML = html;
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
  if (!c.pages[i]) return '';
  let out = '';
  results.forEach((r, k) => {
    if (r.page !== i) return;
    r.rects ||= rectsOf(srcOf(c, r), r.s, r.e);
    const cur = k === current;
    out += r.rects.map((q) => `<rect class="find-hit${cur ? ' cur' : ''}" x="${q[0]}" y="${q[1]}" width="${q[2] - q[0]}" height="${q[3] - q[1]}" rx="1" fill="${cur ? '#ff8a1f' : '#ffd84d'}" fill-opacity="${cur ? 0.75 : 0.45}"/>`).join('');
  });
  return out;
});

function select(k) {
  if (!results.length) return;
  current = (k + results.length) % results.length;
  const r = results[current];
  r.rects ||= rectsOf(srcOf(indexOf(S.pdf), r), r.s, r.e);
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
  stopOcr(); // 인식 엔진 정리 (메모리)
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
  // 체크박스: 띄어쓰기 무시 · 대소문자 무시 → 바로 다시 찾기
  const chk = { 'find-opt-space': 'space', 'find-opt-case': 'cs' };
  for (const [id, k] of Object.entries(chk)) {
    const el = document.getElementById(id);
    el.checked = opt[k];
    el.addEventListener('change', () => {
      opt[k] = el.checked;
      setPref(k === 'space' ? 'find-space' : 'find-case', el.checked);
      $('#find-pos').textContent = '';
      query = inp.value;
      run();
      inp.focus({ preventScroll: true });
    });
  }
  // 그림 속 글자(OCR) 찾기
  const sel = document.getElementById('find-ocr');
  const setOcr = (v) => {
    opt.ocr = v;
    sel.value = v;
    setPref('find-ocr', v);
    query = inp.value;
    run();
  };
  sel.value = opt.ocr;
  sel.addEventListener('change', () => setOcr(sel.value));
  $('#find-list').addEventListener('click', (e) => {
    const h = e.target.closest('.fr-ocr-hint');
    if (h) setOcr(h.dataset.ocr);
  });
  $('#find-prev').addEventListener('click', () => select(current - 1));
  $('#find-next').addEventListener('click', () => select(current + 1));
  $('#find-close').addEventListener('click', closeFind);
  // 탭(문서)이 바뀌면 같은 말로 다시 찾기
  on('doc', () => { if (open) { $('#find-pos').textContent = ''; run(); } });
}
// 단축키용
export function findNext(back) { if (open && results.length) select(current + (back ? -1 : 1)); else openFind(); }

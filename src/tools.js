// 도구별 마우스·펜·손가락 동작
import { S, emit, uid } from './state.js';
import { pageEl, toPdf, rectCss, canvasOf, zoomBy } from './viewer.js';
import * as A from './annots.js';
import { setLive, pathFromOutline } from './overlay.js';
import { strokeOutline } from './pdfwrite.js';
import { openTextDialog, openNoteDialog, openSignPad, toast, pickColor } from './dialogs.js';

const viewer = () => document.getElementById('viewer');
let drag = null; // 진행 중인 동작

export function setTool(t) {
  if (S.readOnly && !['select', 'hand'].includes(t)) {
    toast(S.readOnlyReason || '이 문서는 보기만 할 수 있습니다.');
    t = 'select';
  }
  S.tool = t;
  document.getElementById('pages').dataset.tool = t;
  if (t !== 'select') select(null);
  emit('tool');
}

export function select(id) {
  if (S.selected === id) return;
  S.selected = id;
  emit('select');
}

const pageOf = (e) => {
  const el = e.target.closest?.('.page');
  return el ? Number(el.dataset.i) : -1;
};
const tolerance = () => 4 / S.scale; // 화면에서 4px

export function initTools() {
  const pages = document.getElementById('pages');
  pages.dataset.tool = S.tool;
  pages.addEventListener('pointerdown', onDown);
  pages.addEventListener('dblclick', onDblClick);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  pages.addEventListener('click', onUiClick);
  initPinch();
  // Ctrl + 휠 = 확대·축소
  viewer().addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !S.pdf) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX, y: e.clientY });
  }, { passive: false });
}

/* ───────── 누름 ───────── */
function onDown(e) {
  if (!S.pdf || e.button > 0) return;
  // 선택 상자의 단추·손잡이
  if (e.target.closest('.sel-bar')) return;
  const handle = e.target.closest('.handle');
  const i = pageOf(e);
  if (i < 0) return;
  const [x, y] = toPdf(i, e.clientX, e.clientY);
  const t = S.tool;
  const isTouch = e.pointerType === 'touch';

  if (handle) return startResize(e, i);
  if (e.target.closest('.sel-box')) return startMove(e, i, x, y, A.find(S.selected));

  if (t === 'hand' || (isTouch && ['pen', 'highlight', 'eraser'].includes(t) && !S.opts.fingerDraw)) return startPan(e);

  if (t === 'select') {
    const a = A.topHit(i, x, y, tolerance());
    if (a) { select(a.id); return startMove(e, i, x, y, a); }
    select(null);
    return; // 글자 선택은 브라우저에 맡김
  }
  if (t === 'pen') return startInk(e, i, x, y, false);
  if (t === 'highlight') {
    if (e.target.closest('.textLayer span')) { drag = { kind: 'textsel', i }; return; } // 글자 위 → 글자 선택으로 칠함
    return startInk(e, i, x, y, true); // 빈 곳 → 자유 형광펜
  }
  if (t === 'replace') {
    const a = A.topHit(i, x, y, tolerance());
    if (a && (a.type === 'replace' || a.type === 'text')) { e.preventDefault(); return editAnnot(a); }
    drag = { kind: 'textsel', i };
    return;
  }
  if (t === 'eraser') {
    e.preventDefault();
    drag = { kind: 'erase', i, prev: S.annots, removed: new Set(), pid: e.pointerId };
    eraseAt(i, x, y);
    return;
  }
  if (t === 'note') {
    e.preventDefault();
    const a = A.topHit(i, x, y, tolerance());
    if (a?.type === 'note') return editAnnot(a);
    createNote(i, x, y + 11);
    return;
  }
  if (t === 'text') {
    e.preventDefault();
    const a = A.topHit(i, x, y, tolerance());
    if (a && (a.type === 'text' || a.type === 'replace')) return editAnnot(a);
    createText(i, x, y + S.opts.textSize * 0.6);
    return;
  }
  if (t === 'sign') {
    e.preventDefault();
    placeSign(i, x, y);
  }
}

/* ───────── 움직임 ───────── */
function onMove(e) {
  if (!drag || (drag.pid != null && e.pointerId !== drag.pid)) return;
  if (drag.kind === 'pan') {
    viewer().scrollLeft = drag.sl - (e.clientX - drag.x0);
    viewer().scrollTop = drag.st - (e.clientY - drag.y0);
    return;
  }
  if (drag.kind === 'ink') {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const [x, y] = toPdf(drag.i, ev.clientX, ev.clientY);
      drag.pts.push([x, y, pressureOf(ev)]);
    }
    drawLiveInk();
    return;
  }
  if (drag.kind === 'move') {
    const [x, y] = toPdf(drag.i, e.clientX, e.clientY);
    const dx = x - drag.x0, dy = y - drag.y0;
    if (!drag.moved && Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) < 3) return;
    drag.moved = true;
    A.replaceSilently(drag.orig.id, A.translate(drag.orig, dx, dy));
    return;
  }
  if (drag.kind === 'resize') {
    const [x, y] = toPdf(drag.i, e.clientX, e.clientY);
    const o = drag.orig;
    const b = drag.b0;
    // 오른쪽 아래 손잡이: 왼쪽 위 모서리를 고정하고 비율 유지
    const f = Math.max(0.1, Math.max((x - b[0]) / (b[2] - b[0]), (b[3] - y) / (b[3] - b[1])));
    drag.moved = true;
    if (o.type === 'sign') A.replaceSilently(o.id, { ...o, w: o.w * f, h: o.h * f });
    else A.replaceSilently(o.id, { ...o, size: Math.max(4, Math.round(o.size * f * 10) / 10) });
    return;
  }
  if (drag.kind === 'erase') {
    const [x, y] = toPdf(drag.i, e.clientX, e.clientY);
    eraseAt(drag.i, x, y);
  }
}

/* ───────── 뗌 ───────── */
function onUp(e) {
  if (!drag || (drag.pid != null && e.pointerId !== drag.pid)) return;
  const d = drag;
  drag = null;
  if (d.kind === 'ink') return finishInk(d);
  if (d.kind === 'move' || d.kind === 'resize') {
    if (d.moved) A.commitFrom(d.prev);
    return;
  }
  if (d.kind === 'erase') {
    if (d.removed.size) A.commitFrom(d.prev);
    return;
  }
  if (d.kind === 'textsel') setTimeout(() => finishTextSelection(d), 0);
  if (d.kind === 'pan') viewer().classList.remove('panning');
}
function onCancel(e) {
  if (!drag || (drag.pid != null && e.pointerId !== drag.pid)) return;
  if (drag.kind === 'ink') setLive(drag.i, '');
  if ((drag.kind === 'move' || drag.kind === 'resize') && drag.moved) A.commitFrom(drag.prev);
  if (drag.kind === 'erase' && drag.removed.size) A.commitFrom(drag.prev);
  drag = null;
}

function onDblClick(e) {
  if (S.tool !== 'select' && S.tool !== 'replace') return;
  const i = pageOf(e);
  if (i < 0) return;
  const [x, y] = toPdf(i, e.clientX, e.clientY);
  const a = A.topHit(i, x, y, tolerance());
  if (a && ['note', 'text', 'replace'].includes(a.type)) { e.preventDefault(); editAnnot(a); return; }
  if (S.tool === 'replace') setTimeout(() => finishTextSelection({ i }), 0);
}

/* ───────── 선택 상자 단추 ───────── */
async function onUiClick(e) {
  const b = e.target.closest('.sel-bar button');
  if (!b) return;
  const a = A.find(S.selected);
  if (!a) return;
  const act = b.dataset.act;
  if (act === 'del') A.remove(a.id);
  if (act === 'edit') editAnnot(a);
  if (act === 'dup') {
    const off = 12;
    const c = { ...A.translate(a, off, -off), id: uid() };
    A.add(c);
    select(c.id);
  }
  if (act === 'color') {
    const c = await pickColor(a.color, a.type);
    if (c) A.update(a.id, { color: c });
  }
}

/* ───────── 이동·크기 ───────── */
function startMove(e, i, x, y, a) {
  if (!a) return;
  e.preventDefault();
  drag = { kind: 'move', i, x0: x, y0: y, cx: e.clientX, cy: e.clientY, orig: a, prev: S.annots, moved: false, pid: e.pointerId };
}
function startResize(e, i) {
  const a = A.find(S.selected);
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  drag = { kind: 'resize', i, orig: a, b0: A.bbox(a), prev: S.annots, moved: false, pid: e.pointerId };
}
function startPan(e) {
  e.preventDefault();
  const v = viewer();
  v.classList.add('panning');
  drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, sl: v.scrollLeft, st: v.scrollTop, pid: e.pointerId };
}

/* ───────── 펜·자유 형광펜 ───────── */
const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5);
function startInk(e, i, x, y, marker) {
  e.preventDefault();
  window.getSelection()?.removeAllRanges();
  const o = S.opts;
  drag = {
    kind: 'ink', i, marker, pid: e.pointerId,
    pts: [[x, y, pressureOf(e)]],
    color: marker ? o.hlColor : o.penColor,
    width: marker ? Math.max(8, o.penWidth * 4) : o.penWidth,
    opacity: marker ? o.hlOpacity : o.penOpacity,
  };
  drawLiveInk();
}
function drawLiveInk() {
  const d = drag;
  const poly = strokeOutline(d.pts, d.width, d.marker);
  const blend = d.marker ? 'mix-blend-mode:multiply' : '';
  setLive(d.i, `<path d="${pathFromOutline(poly)}" fill="${d.color}" fill-opacity="${d.opacity}" style="${blend}"/>`);
}
function finishInk(d) {
  setLive(d.i, '');
  if (d.pts.length === 1) d.pts.push([d.pts[0][0] + 0.01, d.pts[0][1], d.pts[0][2]]); // 점 하나도 찍히게
  const round = (p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100];
  const pts = d.pts.map(round);
  // 같은 도구로 바로 이어 그린 획은 하나의 주석으로 묶음 (2초 이내, 같은 쪽·색·굵기)
  const last = S.annots[S.annots.length - 1];
  const now = Date.now();
  if (last && last.type === 'ink' && last.page === d.i && !!last.marker === d.marker && last.color === d.color &&
      last.width === d.width && now - (last.t || 0) < 2000 && last.strokes.length < 40) {
    A.update(last.id, { strokes: [...last.strokes, pts], t: now });
    return;
  }
  A.add({ id: uid(), type: 'ink', page: d.i, strokes: [pts], color: d.color, width: d.width, opacity: d.opacity, marker: d.marker || undefined, t: now });
}

/* ───────── 지우개 ───────── */
function eraseAt(i, x, y) {
  const a = A.topHit(i, x, y, tolerance() * 2);
  if (!a || drag.removed.has(a.id)) return;
  drag.removed.add(a.id);
  S.annots = S.annots.filter((q) => q.id !== a.id);
  emit('annots');
}

/* ───────── 글자 선택 → 형광펜·텍스트 수정 ───────── */
function selectionRects() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const byPage = new Map();
  for (let k = 0; k < sel.rangeCount; k++) {
    const range = sel.getRangeAt(k);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const el = document.elementsFromPoint(cx, cy).find((n) => n.classList?.contains('page'));
      if (!el) continue;
      const i = Number(el.dataset.i);
      const p1 = toPdf(i, r.left, r.top), p2 = toPdf(i, r.right, r.bottom);
      const q = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])];
      if (!byPage.has(i)) byPage.set(i, []);
      byPage.get(i).push(q);
    }
  }
  const text = sel.toString();
  return { byPage, text };
}
/** 같은 줄의 사각형을 합침 */
function mergeRects(rects) {
  const rs = rects.slice().sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const out = [];
  for (const r of rs) {
    const prev = out[out.length - 1];
    if (prev) {
      const ov = Math.min(prev[3], r[3]) - Math.max(prev[1], r[1]);
      const hMin = Math.min(prev[3] - prev[1], r[3] - r[1]);
      if (ov > hMin * 0.5 && r[0] <= prev[2] + hMin * 1.2) {
        prev[0] = Math.min(prev[0], r[0]); prev[1] = Math.min(prev[1], r[1]);
        prev[2] = Math.max(prev[2], r[2]); prev[3] = Math.max(prev[3], r[3]);
        continue;
      }
    }
    out.push(r.slice());
  }
  return out.map((r) => r.map((v) => Math.round(v * 100) / 100));
}

function finishTextSelection(d) {
  const got = selectionRects();
  if (!got || !got.byPage.size) return;
  if (S.tool === 'highlight') {
    const prev = S.annots;
    let next = S.annots;
    for (const [i, rects] of got.byPage) {
      next = [...next, { id: uid(), type: 'highlight', page: i, rects: mergeRects(rects), color: S.opts.hlColor, opacity: S.opts.hlOpacity, text: got.text.slice(0, 300) }];
    }
    S.annots = next;
    A.commitFrom(prev);
    window.getSelection().removeAllRanges();
    return;
  }
  if (S.tool === 'replace') {
    const [i, rects] = [...got.byPage][0];
    const cover = mergeRects(rects);
    window.getSelection().removeAllRanges();
    startReplace(i, cover, got.text.replace(/\s*\n\s*/g, '\n').trim());
  }
}

/** 칠할 바탕색과 글자색 추정 (그려진 캔버스에서) */
function sampleColors(i, cover) {
  const cv = canvasOf(i);
  const out = { bg: '#ffffff', fg: '#111111' };
  if (!cv || !cv.width) return out;
  try {
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const k = cv.width / parseFloat(cv.style.width);
    const r = rectCss(i, cover[0]);
    const x = Math.max(0, Math.floor(r.left * k)), y = Math.max(0, Math.floor(r.top * k));
    const w = Math.max(1, Math.min(cv.width - x, Math.ceil(r.width * k))), h = Math.max(1, Math.min(cv.height - y, Math.ceil(r.height * k)));
    const data = ctx.getImageData(x, y, w, h).data;
    // 가장 흔한 색 = 바탕 (같은 무리의 실제 평균값), 가장 어두운 색 = 글자
    const counts = new Map();
    let dark = null, darkL = 999;
    for (let p = 0; p < data.length; p += 16) {
      const R = data[p], G = data[p + 1], B = data[p + 2];
      const L = 0.299 * R + 0.587 * G + 0.114 * B;
      const key = ((R >> 3) << 10) | ((G >> 3) << 5) | (B >> 3);
      const c = counts.get(key) || [0, 0, 0, 0];
      c[0]++; c[1] += R; c[2] += G; c[3] += B;
      counts.set(key, c);
      if (L < darkL) { darkL = L; dark = [R, G, B]; }
    }
    let best = null;
    for (const c of counts.values()) if (!best || c[0] > best[0]) best = c;
    if (best) {
      const [R, G, B] = [best[1] / best[0], best[2] / best[0], best[3] / best[0]].map(Math.round);
      out.bg = R > 246 && G > 246 && B > 246 ? '#ffffff' : hex(R, G, B);
    }
    if (dark && darkL < 140) out.fg = hex(...dark);
  } catch { /* 무시 */ }
  return out;
}
const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;

async function startReplace(i, cover, text) {
  const top = cover[0];
  const h = top[3] - top[1];
  const size = Math.max(5, Math.round(h * 0.86 * 2) / 2);
  const col = sampleColors(i, cover);
  const draft = {
    type: 'replace', page: i, cover, x: top[0], y: top[3] - (h - size) * 0.35,
    text, font: S.opts.textFont, size, color: col.fg, bg: col.bg,
  };
  const res = await openTextDialog(draft, { title: '텍스트 수정', original: text });
  if (!res) return;
  const a = { id: uid(), ...draft, ...res };
  A.add(a);
  select(null);
}

/* ───────── 메모·텍스트 상자·서명 만들기 ───────── */
async function createNote(i, x, y) {
  const res = await openNoteDialog({ text: '', color: S.opts.noteColor });
  if (!res || !res.text.trim()) return;
  A.add({ id: uid(), type: 'note', page: i, x: x - 11, y, text: res.text, color: res.color });
}
async function createText(i, x, y) {
  const o = S.opts;
  const draft = { type: 'text', page: i, x, y, text: '', font: o.textFont, size: o.textSize, color: o.textColor, bg: o.textBg || undefined };
  const res = await openTextDialog(draft, { title: '텍스트 상자' });
  if (!res || !res.text.trim()) return;
  const a = { id: uid(), ...draft, ...res };
  A.add(a);
  setTool('select');
  select(a.id);
}
async function placeSign(i, x, y) {
  let src = S.signArmed;
  if (!src) {
    src = await openSignPad();
    if (!src) return;
    S.signArmed = src;
    emit('sign-armed');
  }
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => {});
  const ratio = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 0.4;
  const w = S.opts.signWidth, h = w * ratio;
  const a = { id: uid(), type: 'sign', page: i, x: x - w / 2, y: y + h / 2, w, h, src };
  A.add(a);
  setTool('select');
  select(a.id);
}

export async function editAnnot(a) {
  if (a.type === 'note') {
    const res = await openNoteDialog({ text: a.text, color: a.color }, true);
    if (res === 'delete') return A.remove(a.id);
    if (res) A.update(a.id, res);
    return;
  }
  if (a.type === 'text' || a.type === 'replace') {
    const res = await openTextDialog(a, { title: a.type === 'replace' ? '텍스트 수정' : '텍스트 상자', editing: true });
    if (res === 'delete') return A.remove(a.id);
    if (res) {
      if (!res.text.trim() && a.type === 'text') return A.remove(a.id);
      A.update(a.id, res);
    }
  }
}

/* ───────── 두 손가락 확대 (휴대폰·태블릿) ───────── */
function initPinch() {
  const v = viewer();
  let start = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  v.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && S.pdf) {
      drag = null;
      start = { d: dist(e.touches), x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2, f: 1 };
    }
  }, { passive: true });
  v.addEventListener('touchmove', (e) => {
    if (!start || e.touches.length !== 2) return;
    e.preventDefault();
    start.f = Math.max(0.25, Math.min(4, dist(e.touches) / start.d));
    const pe = document.getElementById('pages');
    const r = v.getBoundingClientRect();
    pe.style.transformOrigin = `${start.x - r.left + v.scrollLeft}px ${start.y - r.top + v.scrollTop}px`;
    pe.style.transform = `scale(${start.f})`;
  }, { passive: false });
  const end = () => {
    if (!start) return;
    const f = start.f, at = { x: start.x, y: start.y };
    start = null;
    const pe = document.getElementById('pages');
    pe.style.transform = '';
    if (Math.abs(f - 1) > 0.03) zoomBy(f, at);
  };
  v.addEventListener('touchend', end);
  v.addEventListener('touchcancel', end);
}

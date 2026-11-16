// 책갈피(목차): 왼쪽 메뉴 '책갈피' 탭 — 보기 + 직접 만들기·고치기
// - 문서의 책갈피를 읽어 편집 가능한 모델(S.outline)로 보관, 처음에는 1단계만 펼침
// - 추가(Ctrl+B: 지금 보는 위치, 글자를 골라 두면 그 글자가 제목) · 이름 바꾸기(F2·두 번 누르기)
//   · 위치를 지금 쪽으로 · 하위 추가 · 단계 올리기/내리기(Alt+←/→) · 순서(Alt+↑/↓·끌어 놓기) · 삭제(Delete)
// - 고치면 저장할 때 문서의 책갈피를 이 모델로 바꿔 씀 (Acrobat·엣지 등에서도 보임), Ctrl+Z로 되돌리기
import { S, on, uid } from './state.js';
import { goTo, pageEl, toPdf } from './viewer.js';
import { commitOutline, outlineSnapshot } from './annots.js';
import { toast } from './dialogs.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let visible = () => false;
let selId = null;
let renaming = null; // 이름 바꾸는 중인 id

/* ───────── 문서에서 읽기 ───────── */
/** 목적지 → { page, x, y } */
async function resolveDest(pdf, dest) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await pdf.getDestination(d);
    if (!Array.isArray(d) || !d.length) return null;
    const ref = d[0];
    const page = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
    const mode = d[1]?.name;
    let x = null, y = null;
    if (mode === 'XYZ') { x = d[2]; y = d[3]; } else if (mode === 'FitH' || mode === 'FitBH') { y = d[2]; } else if (mode === 'FitR') { x = d[2]; y = d[5]; }
    return { page, x, y };
  } catch { return null; }
}
const loading = new WeakMap(); // pdf → Promise
async function readFrom(pdf) {
  const raw = (await pdf.getOutline().catch(() => null)) || [];
  const walk = async (items) => Promise.all(items.map(async (it) => {
    const d = it.dest ? await resolveDest(pdf, it.dest) : null;
    const c = it.color && (it.color[0] || it.color[1] || it.color[2]) ? [it.color[0], it.color[1], it.color[2]] : null;
    return {
      id: uid(), title: (it.title || '').trim() || '(제목 없음)', page: d ? d.page : null, x: d?.x ?? null, y: d?.y ?? null,
      bold: !!it.bold, italic: !!it.italic, color: c, open: false, kids: it.items?.length ? await walk(it.items) : [],
    };
  }));
  return walk(raw);
}
/** 지금 문서의 책갈피 모델 준비 (한 번만 읽음) */
export async function ensureOutline() {
  const pdf = S.pdf;
  if (!pdf) return [];
  if (S.outline && (S.outlineFor === pdf || S.outlineFor === 'pending')) return S.outline;
  if (!loading.has(pdf)) loading.set(pdf, readFrom(pdf));
  const nodes = await loading.get(pdf);
  if (S.pdf === pdf && !(S.outline && S.outlineFor === pdf)) { S.outline = nodes; S.outlineFor = pdf; }
  return S.outline;
}

/* ───────── 모델 도우미 ───────── */
function flatten(nodes = S.outline || []) {
  const out = [];
  const visit = (list, depth, parent) => list.forEach((n, i) => { out.push({ n, depth, parent, list, i }); visit(n.kids, depth + 1, n); });
  visit(nodes, 0, null);
  return out;
}
const find = (id) => flatten().find((x) => x.n.id === id) || null;
const countAll = (list) => list.reduce((s, n) => s + 1 + countAll(n.kids), 0);
const isInside = (node, id) => node.id === id || node.kids.some((k) => isInside(k, id));

/** 쪽 편집 뒤 쪽 번호 옮기기. map(p) → 새 쪽 또는 { gone, to } (지운 쪽: 하위가 없으면 책갈피도 지움) */
export function remapOutline(nodes, map) {
  const walk = (list) => list.flatMap((n) => {
    const kids = walk(n.kids);
    if (n.page == null) return [{ ...n, kids }];
    const m = map(n.page);
    if (m && typeof m === 'object') {
      if (!kids.length) return [];
      return [{ ...n, page: Math.max(0, m.to), y: null, x: null, kids }];
    }
    return [{ ...n, page: m, kids }];
  });
  return walk(structuredClone(nodes));
}

/** 고치기: 바꾸기 전 상태를 기록한 뒤 fn 실행 */
function edit(fn) {
  if (!S.pdf || !S.outline) return false;
  if (S.readOnly) { toast(S.readOnlyReason || '보기 전용 문서는 책갈피를 고칠 수 없습니다.', 3500); return false; }
  const prev = outlineSnapshot();
  if (fn() === false) return false;
  commitOutline(prev);
  render();
  return true;
}

/** 지금 보이는 위치 (쪽, 그 쪽 안의 위쪽 PDF 좌표) */
function viewPos() {
  const i = S.current;
  const el = pageEl(i);
  const v = document.getElementById('viewer');
  let y = null;
  if (el && v && !S.pages[i]?.rotate) {
    const r = el.getBoundingClientRect(), vr = v.getBoundingClientRect();
    const cy = Math.min(Math.max(r.top, vr.top + 4), r.bottom - 4);
    y = Math.round(toPdf(i, r.left, cy)[1]);
  }
  return { page: i, x: null, y };
}
/** 화면에서 고른 글자(있으면) → 새 책갈피 제목 */
function selectedText() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed) return '';
  const node = sel.anchorNode?.parentElement;
  if (!node?.closest?.('#pages')) return '';
  return sel.toString().replace(/\s+/g, ' ').trim().slice(0, 120);
}

/* ───────── 동작 ───────── */
/** 새 책갈피 (지금 보는 위치). child = 고른 항목의 하위로 */
export async function addBookmark({ child = false } = {}) {
  if (!S.pdf) return;
  await ensureOutline();
  const pos = viewPos();
  const title = selectedText() || `${pos.page + 1}쪽`;
  const n = { id: uid(), title, ...pos, bold: false, italic: false, color: null, open: false, kids: [] };
  const ok = edit(() => {
    const cur = selId && find(selId);
    let list, at;
    if (cur && child) { list = cur.n.kids; cur.n.open = true; at = list.length; } else {
      list = cur ? cur.list : S.outline;
      // 같은 단계 안에서 쪽 순서에 맞는 자리
      at = list.length;
      for (let k = 0; k < list.length; k++) if (list[k].page != null && list[k].page > pos.page) { at = k; break; }
      if (cur && !child && at <= cur.i && cur.n.page != null && cur.n.page <= pos.page) at = cur.i + 1;
    }
    list.splice(at, 0, n);
  });
  if (!ok) return;
  selId = n.id;
  render();
  startRename(n.id);
  window.getSelection?.()?.removeAllRanges?.();
}
function rename(id, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const x = find(id);
  if (!x || !t || t === x.n.title) { render(); return; }
  edit(() => { find(id).n.title = t; });
}
function setHere(id) {
  const pos = viewPos();
  edit(() => { Object.assign(find(id).n, pos); });
  toast(`책갈피 위치를 ${pos.page + 1}쪽으로 바꿨습니다.`);
}
function remove(id) {
  const x = find(id);
  if (!x) return;
  const n = countAll([x.n]);
  edit(() => { const y = find(id); y.list.splice(y.i, 1); });
  selId = null;
  render();
  toast(`${n > 1 ? `책갈피 ${n}개(하위 포함)를` : '책갈피를'}지웠습니다 · 되돌리기 Ctrl+Z`, 3000);
}
function move(id, d) {
  edit(() => {
    const x = find(id);
    const j = x.i + d;
    if (j < 0 || j >= x.list.length) return false;
    [x.list[x.i], x.list[j]] = [x.list[j], x.list[x.i]];
  });
}
function indent(id) { // 바로 위 항목의 하위로
  edit(() => {
    const x = find(id);
    if (x.i === 0) return false;
    const prev = x.list[x.i - 1];
    x.list.splice(x.i, 1);
    prev.kids.push(x.n);
    prev.open = true;
  });
}
function outdent(id) { // 상위 항목 바로 뒤로
  edit(() => {
    const x = find(id);
    if (!x.parent) return false;
    const p = find(x.parent.id);
    x.list.splice(x.i, 1);
    p.list.splice(p.i + 1, 0, x.n);
  });
}
/** 끌어 놓기: where = 'before' | 'after' | 'child' */
function drop(id, targetId, where) {
  if (id === targetId) return;
  const src = find(id);
  if (!src || isInside(src.n, targetId)) return; // 자기 하위로는 못 옮김
  edit(() => {
    const s = find(id);
    s.list.splice(s.i, 1);
    const t = find(targetId);
    if (where === 'child') { t.n.kids.push(s.n); t.n.open = true; } else t.list.splice(t.i + (where === 'after' ? 1 : 0), 0, s.n);
  });
}

/* ───────── 화면 ───────── */
function rowHtml(x, ro) {
  const n = x.n;
  const has = n.kids.length > 0;
  const page = n.page != null ? n.page + 1 : '';
  const col = n.color ? ` style="color:rgb(${n.color.join(',')})"` : '';
  const title = renaming === n.id
    ? `<input class="ol-in" data-in="${n.id}" value="${esc(n.title)}" maxlength="200" spellcheck="false">`
    : `<span class="ol-t${n.bold ? ' b' : ''}${n.italic ? ' i' : ''}"${col}>${esc(n.title)}</span>`;
  return `<div class="ol-node">
    <div class="ol-row${selId === n.id ? ' sel' : ''}" style="--d:${x.depth}" data-id="${n.id}" ${ro ? '' : 'draggable="true"'} title="${esc(n.title)}${page ? ` (${page}쪽)` : ''}">
      <button class="ol-tw${has ? '' : ' leaf'}" data-tw="${n.id}" tabindex="-1" aria-label="펼치기">${has ? (n.open ? '▾' : '▸') : ''}</button>
      ${title}
      <span class="ol-p">${page}</span>
    </div>
    ${has && n.open ? `<div class="ol-kids">${n.kids.map((k, i) => rowHtml({ n: k, depth: x.depth + 1 }, ro)).join('')}</div>` : ''}
  </div>`;
}

/** 고른 항목용 도구 줄 */
function toolsHtml() {
  const s = selId && find(selId);
  const ro = S.readOnly;
  const dis = (c) => (ro || !s || c ? ' disabled' : '');
  if (!S.outline?.length) return ''; // 책갈피가 없으면 도구 줄 없음
  // 고른 항목이 없어도 자리를 지켜 목록이 위아래로 흔들리지 않게 (모두 흐리게)
  return `<div class="ol-tools">
      <button data-ol="rename" title="이름 바꾸기 (F2 · 두 번 누르기)"${dis()}>✎</button>
      <button data-ol="here" title="위치를 지금 보는 곳으로"${dis()}>⌖</button>
      <button data-ol="child" title="하위 책갈피 추가"${dis()}>↳＋</button>
      <span class="sep"></span>
      <button data-ol="out" title="한 단계 위로 (Alt+←)"${dis(!s?.parent)}>⇤</button>
      <button data-ol="in" title="한 단계 아래로 — 위 항목의 하위로 (Alt+→)"${dis(s?.i === 0)}>⇥</button>
      <button data-ol="up" title="위로 (Alt+↑)"${dis(s?.i === 0)}>↑</button>
      <button data-ol="down" title="아래로 (Alt+↓)"${dis(s && s.i >= s.list.length - 1)}>↓</button>
      <span class="sp"></span>
      <button data-ol="del" class="danger" title="삭제 (Delete) — 하위 포함"${dis()}>🗑</button></div>`;
}
/** 선택만 바뀔 때: 다시 그리지 않고 표시만 (두 번 누르기가 끊기지 않게) */
function paintSel() {
  const box = document.getElementById('outline');
  box.querySelectorAll('.ol-row').forEach((r) => r.classList.toggle('sel', r.dataset.id === selId));
  const slot = box.querySelector('.ol-slot');
  if (slot) slot.innerHTML = toolsHtml();
}

let renderSeq = 0;
async function render() {
  const box = document.getElementById('outline');
  if (!box) return;
  if (!S.pdf) { box.innerHTML = '<p class="muted">문서를 열면 책갈피가 여기에 표시됩니다.</p>'; return; }
  const seq = ++renderSeq;
  if (!S.outline || (S.outlineFor !== S.pdf && S.outlineFor !== 'pending')) box.innerHTML = '<p class="muted">책갈피를 읽는 중…</p>';
  const pdf = S.pdf;
  const nodes = await ensureOutline();
  if (pdf !== S.pdf || seq !== renderSeq) return;
  const ro = S.readOnly;
  const all = countAll(nodes);
  if (selId && !find(selId)) selId = null;
  box.innerHTML = `<div class="ol-bar">
      <button class="ol-add" data-ol="add" title="지금 보는 위치에 책갈피 추가 (Ctrl+B) — 글자를 골라 두면 그 글자가 제목"${ro ? ' disabled' : ''}>＋ 추가</button>
      <span class="ol-cnt">${all ? `${all}개` : ''}</span><span class="sp"></span>
      ${all ? '<button data-ol="open">모두 펼치기</button><button data-ol="close">1단계만</button>' : ''}</div>
    <div class="ol-slot">${toolsHtml()}</div>
    ${all ? flatten(nodes).filter((x) => x.depth === 0).map((x) => rowHtml(x, ro)).join('') : `<p class="muted">이 문서에는 책갈피가 없습니다.${ro ? '' : '<br>보고 있는 쪽에서 <b>＋ 추가</b>(Ctrl+B)를 누르면<br>그 위치에 책갈피가 생깁니다.'}</p>`}`;
  if (renaming) {
    const inp = box.querySelector('.ol-in');
    if (inp) { inp.focus(); inp.select(); } else renaming = null;
  } else markCurrent();
}

function startRename(id) {
  if (S.readOnly) return;
  renaming = id;
  render();
}

/** 지금 보는 쪽의 항목 강조 (접혀 있으면 보이는 가장 가까운 상위 항목) */
function markCurrent() {
  const box = document.getElementById('outline');
  if (!S.outline || !box) return;
  let cur = null;
  for (const x of flatten()) if (x.n.page != null && x.n.page <= S.current) cur = x;
  const map = new Map(flatten().map((x) => [x.n.id, x]));
  while (cur && !box.querySelector(`.ol-row[data-id="${cur.n.id}"]`)) cur = cur.parent ? map.get(cur.parent.id) : null;
  box.querySelectorAll('.ol-row.on').forEach((r) => r.classList.remove('on'));
  const row = cur && box.querySelector(`.ol-row[data-id="${cur.n.id}"]`);
  if (row) { row.classList.add('on'); if (!box.contains(document.activeElement) || document.activeElement === box) row.scrollIntoView({ block: 'nearest' }); }
}

function menu(x, y, id) {
  document.querySelector('.tab-menu')?.remove();
  const s = find(id);
  if (!s) return;
  const ro = S.readOnly;
  const m = document.createElement('div');
  m.className = 'tab-menu';
  const it = (a, label, key = '', off = false) => `<button data-a="${a}"${off || ro ? ' disabled' : ''}><span class="mi">${label}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`;
  m.innerHTML = `${it('rename', '✎ 이름 바꾸기', 'F2')}${it('here', '⌖ 위치를 지금 보는 곳으로')}
    <hr>${it('add', '＋ 아래에 책갈피 추가', 'Ctrl+B')}${it('child', '↳ 하위 책갈피 추가')}
    <hr>${it('out', '⇤ 한 단계 위로', 'Alt+←', !s.parent)}${it('in', '⇥ 한 단계 아래로', 'Alt+→', s.i === 0)}${it('up', '↑ 위로', 'Alt+↑', s.i === 0)}${it('down', '↓ 아래로', 'Alt+↓', s.i >= s.list.length - 1)}
    <hr>${it('del', `🗑 삭제${s.n.kids.length ? ' (하위 포함)' : ''}`, 'Delete')}`;
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  const close = () => { m.remove(); window.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    close();
    act(b.dataset.a, id);
  });
}

function act(a, id = selId) {
  if (a === 'add') return addBookmark();
  if (a === 'open' || a === 'close') { flatten().forEach((x) => { x.n.open = a === 'open' && x.n.kids.length > 0; }); render(); return; }
  if (!id || !find(id)) return;
  if (a === 'rename') startRename(id);
  if (a === 'here') setHere(id);
  if (a === 'child') { selId = id; addBookmark({ child: true }); }
  if (a === 'out') outdent(id);
  if (a === 'in') indent(id);
  if (a === 'up') move(id, -1);
  if (a === 'down') move(id, 1);
  if (a === 'del') remove(id);
}

export function initOutline(isVisible) {
  visible = isVisible;
  const box = document.getElementById('outline');
  box.tabIndex = -1;
  box.addEventListener('click', (e) => {
    if (!S.outline || e.target.closest('.ol-in')) return;
    const bar = e.target.closest('[data-ol]');
    if (bar) { if (!bar.disabled) act(bar.dataset.ol); return; }
    const row = e.target.closest('.ol-row');
    const x = row && find(row.dataset.id);
    if (!x) return;
    const n = x.n;
    if (e.target.closest('[data-tw]') && n.kids.length) { n.open = !n.open; selId = n.id; render(); return; }
    selId = n.id;
    if (n.page != null) {
      goTo(n.page, n.y != null ? { x: n.x ?? 0, y: n.y } : {});
      paintSel();
    } else if (n.kids.length) { n.open = !n.open; render(); } else paintSel();
    box.focus({ preventScroll: true });
  });
  // 두 번 누르기 = 이름 바꾸기 (▸는 펼치기)
  box.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.ol-row');
    if (!row || e.target.closest('[data-tw]') || e.target.closest('.ol-in')) return;
    startRename(row.dataset.id);
  });
  box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.ol-row');
    if (!row || !S.outline) return;
    e.preventDefault();
    selId = row.dataset.id;
    paintSel();
    menu(e.clientX, e.clientY, selId);
  });
  // 이름 바꾸기 입력
  box.addEventListener('keydown', (e) => {
    const inp = e.target.closest('.ol-in');
    if (inp) {
      e.stopPropagation(); // 단축키(V·H 등)로 새지 않게
      if (e.key === 'Enter') { e.preventDefault(); const id = inp.dataset.in; renaming = null; rename(id, inp.value); box.focus({ preventScroll: true }); }
      if (e.key === 'Escape') { e.preventDefault(); renaming = null; render(); box.focus({ preventScroll: true }); }
      return;
    }
    if (!selId || !S.outline) return;
    const k = e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'F2') { stop(); startRename(selId); return; }
    if (k === 'Delete' || k === 'Backspace') { stop(); if (!S.readOnly) remove(selId); return; }
    if (e.altKey && k === 'ArrowUp') { stop(); move(selId, -1); return; }
    if (e.altKey && k === 'ArrowDown') { stop(); move(selId, 1); return; }
    if (e.altKey && k === 'ArrowLeft') { stop(); outdent(selId); return; }
    if (e.altKey && k === 'ArrowRight') { stop(); indent(selId); return; }
    if (!e.altKey && !e.ctrlKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
      stop();
      const rows = [...box.querySelectorAll('.ol-row')];
      const i = rows.findIndex((r) => r.dataset.id === selId);
      const r = rows[Math.max(0, Math.min(rows.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))];
      if (r) { const x = find(r.dataset.id); selId = x.n.id; if (x.n.page != null) goTo(x.n.page, x.n.y != null ? { x: x.n.x ?? 0, y: x.n.y } : {}); paintSel(); r.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (!e.altKey && (k === 'ArrowRight' || k === 'ArrowLeft')) {
      const x = find(selId);
      if (x?.n.kids.length && x.n.open !== (k === 'ArrowRight')) { stop(); x.n.open = k === 'ArrowRight'; render(); }
    }
  });
  box.addEventListener('focusout', (e) => {
    const inp = e.target.closest?.('.ol-in');
    if (inp && renaming) { const id = inp.dataset.in; renaming = null; rename(id, inp.value); }
  });

  // 끌어 놓기: 위쪽 1/4 = 앞, 아래쪽 1/4 = 뒤, 가운데 = 하위로
  let dragId = null;
  const zone = (row, e) => { const r = row.getBoundingClientRect(); const f = (e.clientY - r.top) / r.height; return f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'child'; };
  const clear = () => box.querySelectorAll('.drop-before, .drop-after, .drop-child').forEach((r) => r.classList.remove('drop-before', 'drop-after', 'drop-child'));
  box.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.ol-row');
    if (!row || S.readOnly || renaming) { e.preventDefault(); return; }
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.textContent.trim());
    row.classList.add('dragging');
  });
  box.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const row = e.target.closest('.ol-row');
    clear();
    if (!row || row.dataset.id === dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add(`drop-${zone(row, e)}`);
  });
  box.addEventListener('drop', (e) => {
    const row = e.target.closest('.ol-row');
    const id = dragId;
    clear();
    dragId = null;
    if (!row || !id) return;
    e.preventDefault();
    e.stopPropagation(); // 창 전체의 'PDF 끌어 놓기'로 가지 않게
    selId = id;
    drop(id, row.dataset.id, zone(row, e));
  });
  box.addEventListener('dragend', () => { dragId = null; clear(); box.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging')); });

  on('current', () => { if (visible() && !renaming) markCurrent(); });
  on('doc', () => { selId = null; renaming = null; if (visible()) render(); });
  on('outline', () => { if (visible()) render(); });
}
export const showOutline = () => render();
/** 책갈피 개수 (탭 표시용) */
export async function outlineCount(pdf) {
  if (!pdf || pdf !== S.pdf) return 0;
  return countAll((await ensureOutline()) || []);
}

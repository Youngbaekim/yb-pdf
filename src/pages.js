// 쪽 편집: 쪽 미리보기에서 여러 쪽 선택(Ctrl+클릭·Shift+클릭·Shift+끌기) → 삭제·복사·잘라내기·붙여넣기·복제·새 탭으로 꺼내기
// - 파일 자체를 바꾸므로 실행 취소는 '파일+주석' 통째로 기록 (Ctrl+Z)
// - 복사한 쪽은 이 창의 다른 탭에도 붙여넣을 수 있음 (주석 포함)
import { S, emit, on, uid } from './state.js';
import { loadPdf } from './pdfjs.js';
import { removePages, extractPages, insertPages } from './pdfwrite.js';
import { setupPages, buildDom, clearPages, setScale, targetScale, goTo } from './viewer.js';
import { commitPages, pageSnapshot } from './annots.js';
import { toast } from './dialogs.js';
import { ICONS } from './icons.js';
import { openBytes } from './fileio.js';
import { dbp } from './db.js';

const $ = (q) => document.querySelector(q);

/* ───────── 선택 상태 ───────── */
let sel = new Set();
let anchor = null;
let selFor = null; // 선택이 속한 문서 (문서가 바뀌면 비움)
let clip = null; // { bytes, annots, n, label, at }
let ins = null; // 쪽 사이 선택: 끼울 자리(0 = 1쪽 앞, n = 마지막 쪽 뒤)
let busy = false;

/* 복사한 쪽은 기기 안 저장소에도 맡겨 두어 다른 창(분리한 탭)에서도 붙여넣기 */
const CLIP_KEY = 'pageclip';
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('ybpdf-pageclip') : null;
async function storeClip(c) {
  try { const db = await dbp; await db?.put('handoff', c, CLIP_KEY); bc?.postMessage(c.at); } catch { /* 이 창 안에서만 사용 */ }
}
async function syncClip() {
  try {
    const db = await dbp;
    const v = await db?.get('handoff', CLIP_KEY);
    if (v && (!clip || v.at > clip.at)) { clip = v; paintSel(); }
  } catch { /* 무시 */ }
}
bc?.addEventListener('message', syncClip);
window.addEventListener('focus', syncClip);

const sorted = () => [...sel].sort((a, b) => a - b);
function ensureFor() {
  if (selFor !== S.pdf) { sel = new Set(); anchor = null; ins = null; selFor = S.pdf; }
}
const range = (a, b) => { const out = []; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i); return out; };

/** 쪽 번호 묶음 표기: [0,1,2,4] → '1-3, 5' */
export function rangeLabel(list) {
  const out = [];
  for (let k = 0; k < list.length; k++) {
    let j = k;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(j > k ? `${list[k] + 1}-${list[j] + 1}` : `${list[k] + 1}`);
    k = j;
  }
  return out.join(', ');
}

/** 미리보기 화면에 선택 표시 + 위쪽 막대 갱신 */
export function paintSel() {
  ensureFor();
  const total = S.pages.length;
  document.querySelectorAll('#thumbs .thumb').forEach((t) => {
    const i = Number(t.dataset.i);
    t.classList.toggle('sel', sel.has(i));
    t.classList.toggle('ins-before', ins === i);
    t.classList.toggle('ins-after', ins === total && i === total - 1);
  });
  const bar = $('#pg-bar');
  if (!bar) return;
  bar.hidden = !S.pdf;
  const n = sel.size;
  $('#pg-sel').textContent = ins != null ? `끼울 자리: ${insLabel(ins)}` : n ? `${n}개 쪽 선택 (${rangeLabel(sorted())}쪽)` : '선택한 쪽 없음';
  const ro = S.readOnly;
  bar.querySelectorAll('[data-pg]').forEach((b) => {
    const a = b.dataset.pg;
    b.disabled = ro || (a === 'paste' ? !clip : !n) || (a === 'del' && n >= S.pages.length);
  });
}

/** 끼울 자리 표기: 0 → '1쪽 앞', n → 'n쪽 뒤', 그 밖 → '3쪽과 4쪽 사이' */
function insLabel(k) {
  const n = S.pages.length;
  return k <= 0 ? '1쪽 앞' : k >= n ? `${n}쪽 뒤` : `${k}쪽과 ${k + 1}쪽 사이`;
}
function setIns(k) {
  ensureFor();
  sel = new Set();
  ins = k;
  paintSel();
}

function setSel(list, anc = list.at(-1) ?? null) {
  ensureFor();
  ins = null;
  sel = new Set(list);
  anchor = anc;
  paintSel();
}

/* ───────── 문서 다시 읽기 ───────── */
let chain = Promise.resolve();
/** 바뀐 파일·주석을 화면에 반영 (S.cleanBytes·S.annots는 즉시 바꿔 두어 실행 취소 기록과 어긋나지 않게 함) */
function apply(bytes, annots, current, selAfter = []) {
  S.cleanBytes = bytes;
  S.annots = annots;
  S.selected = null;
  chain = chain.then(async () => {
    emit('loading', true);
    try {
      const pdf = await loadPdf(bytes);
      const old = S.pdf;
      clearPages();
      S.pdf = pdf;
      S.current = Math.max(0, Math.min(current, pdf.numPages - 1));
      await setupPages();
      buildDom();
      setScale(targetScale());
      selFor = pdf;
      ins = null;
      sel = new Set(selAfter.filter((i) => i < pdf.numPages));
      anchor = selAfter.at(-1) ?? null;
      goTo(S.current);
      emit('doc');
      emit('annots');
      emit('tabs');
      old?.destroy?.();
    } catch (e) {
      console.error(e);
      toast('쪽을 고치지 못했습니다.', 3500);
    } finally {
      emit('loading', false);
    }
  });
  return chain;
}
on('pages-restore', (s) => apply(s.bytes, s.annots, s.current));

function editable() {
  if (!S.pdf) return false;
  if (S.readOnly) { toast(S.readOnlyReason || '보기 전용 문서는 쪽을 고칠 수 없습니다.', 3500); return false; }
  if (busy) return false;
  return true;
}
async function run(fn) {
  busy = true;
  emit('loading', true);
  try { await fn(); } catch (e) { console.error(e); toast(`쪽을 고치지 못했습니다: ${e?.message || e}`, 4000); } finally { busy = false; emit('loading', false); }
}

/* ───────── 동작 ───────── */
export function deletePages(list = sorted()) {
  if (!editable() || !list.length) return;
  if (list.length >= S.pages.length) { toast('모든 쪽을 지울 수는 없습니다. 한 쪽 이상 남겨 주세요.', 3000); return; }
  return run(async () => {
    const prev = pageSnapshot();
    const del = new Set(list);
    const bytes = await removePages(S.cleanBytes, list);
    const shift = (p) => p - list.filter((i) => i < p).length;
    const annots = S.annots.filter((a) => !del.has(a.page)).map((a) => ({ ...a, page: shift(a.page) }));
    commitPages(prev);
    const first = Math.min(list[0], S.pages.length - list.length - 1);
    const cur = del.has(S.current) ? first : shift(S.current);
    await apply(bytes, annots, cur, [first]);
    toast(`${list.length}개 쪽을 삭제했습니다 (${rangeLabel(list)}쪽) · 되돌리기 Ctrl+Z`, 3500);
  });
}

async function makeClip(list) {
  const bytes = await extractPages(S.cleanBytes, list);
  const annots = S.annots.filter((a) => list.includes(a.page)).map((a) => ({ ...a, page: list.indexOf(a.page) }));
  return { bytes, annots, n: list.length, label: `${S.fileName.replace(/\.pdf$/i, '')} ${rangeLabel(list)}쪽` };
}

export function copyPages(list = sorted(), { cut = false } = {}) {
  if (!S.pdf || !list.length) return;
  if (S.readOnly) { toast(S.readOnlyReason || '보기 전용 문서는 쪽을 복사할 수 없습니다.', 3500); return; }
  if (busy) return;
  let ok = false;
  return run(async () => {
    clip = { ...(await makeClip(list)), at: Date.now() };
    ok = true;
    storeClip(clip);
    paintSel();
    if (!cut) toast(`${list.length}개 쪽을 복사했습니다 · 끼울 쪽 사이(또는 앞 쪽)를 누르고 Ctrl+V — 다른 탭에도 가능`, 3500);
  }).then(() => {
    if (!cut || !ok) return;
    if (list.length >= S.pages.length) { toast(`${list.length}개 쪽을 복사했습니다 (모든 쪽은 지울 수 없어 잘라내지 않음)`, 3000); return; }
    return deletePages(list);
  });
}

/** at: 끼울 자리(0부터). 기본은 선택한 마지막 쪽 뒤 */
export async function pastePages(at) {
  if (!editable()) return;
  await syncClip();
  if (!clip) { toast('먼저 쪽을 복사(Ctrl+C)하세요.'); return; }
  const c = clip;
  if (at == null) at = ins ?? (sel.size ? Math.max(...sel) : S.current) + 1;
  at = Math.max(0, Math.min(at, S.pages.length));
  return run(async () => {
    const prev = pageSnapshot();
    const bytes = await insertPages(S.cleanBytes, c.bytes, at);
    const moved = S.annots.map((a) => (a.page >= at ? { ...a, page: a.page + c.n } : a));
    const added = c.annots.map((a) => ({ ...a, id: uid(), page: a.page + at }));
    commitPages(prev);
    const pasted = range(at, at + c.n - 1);
    await apply(bytes, [...moved, ...added], at, pasted);
    toast(`${c.n}개 쪽을 ${at + 1}쪽 자리에 붙여넣었습니다 · 되돌리기 Ctrl+Z`, 3000);
  });
}

/** 복제: 선택한 쪽을 마지막 선택 쪽 뒤에 한 벌 더 (복사해 둔 내용은 그대로) */
export function duplicatePages(list = sorted()) {
  if (!editable() || !list.length) return;
  return run(async () => {
    const c = await makeClip(list);
    const at = list.at(-1) + 1;
    const prev = pageSnapshot();
    const bytes = await insertPages(S.cleanBytes, c.bytes, at);
    const moved = S.annots.map((a) => (a.page >= at ? { ...a, page: a.page + c.n } : a));
    const added = c.annots.map((a) => ({ ...a, id: uid(), page: a.page + at }));
    commitPages(prev);
    await apply(bytes, [...moved, ...added], at, range(at, at + c.n - 1));
    toast(`${c.n}개 쪽을 복제했습니다 · 되돌리기 Ctrl+Z`, 3000);
  });
}

/** 선택한 쪽만 새 탭(저장 안 된 새 PDF)으로 */
export function extractToTab(list = sorted()) {
  if (!S.pdf || !list.length || busy) return;
  if (S.readOnly) { toast(S.readOnlyReason || '보기 전용 문서는 쪽을 꺼낼 수 없습니다.', 3500); return; }
  return run(async () => {
    const c = await makeClip(list);
    const name = `${S.fileName.replace(/\.pdf$/i, '')}_${rangeLabel(list).replace(/, /g, ',')}쪽.pdf`;
    busy = false;
    await openBytes(c.bytes, name, null, { dirty: true, annots: c.annots, here: true });
    toast('선택한 쪽을 새 탭으로 열었습니다 · 저장하려면 Ctrl+S', 3000);
  });
}

/* ───────── 화면 연결 ───────── */
function menu(x, y, i, gap = null) {
  document.querySelector('.tab-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'tab-menu';
  const n = sel.size;
  const ro = S.readOnly;
  const item = (a, icon, label, key = '', off = false) => `<button data-a="${a}"${off ? ' disabled' : ''}>${ICONS[icon]} <span class="mi">${label}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`;
  m.innerHTML = gap != null ? item('here', 'paste', `${insLabel(gap)}에 붙여넣기${clip ? ` (${clip.n}개 쪽)` : ''}`, 'Ctrl+V', ro || !clip) : `${item('copy', 'copy', `${n}개 쪽 복사`, 'Ctrl+C', ro)}
    ${item('cut', 'cut', `${n}개 쪽 잘라내기`, 'Ctrl+X', ro)}
    ${item('dup', 'dup', `${n}개 쪽 복제`, 'Ctrl+D', ro)}
    <hr>${item('before', 'paste', `${i + 1}쪽 앞에 붙여넣기${clip ? ` (${clip.n}개 쪽)` : ''}`, '', ro || !clip)}
    ${item('after', 'paste', `${i + 1}쪽 뒤에 붙여넣기${clip ? ` (${clip.n}개 쪽)` : ''}`, 'Ctrl+V', ro || !clip)}
    <hr>${item('extract', 'extract', `${n}개 쪽을 새 탭으로 꺼내기`, '', ro)}
    ${item('del', 'trash', `${n}개 쪽 삭제`, 'Delete', ro || n >= S.pages.length)}`;
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
    const a = b.dataset.a;
    if (a === 'copy') copyPages();
    if (a === 'cut') copyPages(undefined, { cut: true });
    if (a === 'dup') duplicatePages();
    if (a === 'here') pastePages(gap);
    if (a === 'before') pastePages(i);
    if (a === 'after') pastePages(i + 1);
    if (a === 'extract') extractToTab();
    if (a === 'del') deletePages();
  });
}

export function initPages(goToPage) {
  const box = $('#thumbs');
  const body = $('#tab-pages');
  // 위쪽 막대
  const bar = document.createElement('div');
  bar.className = 'pg-bar';
  bar.id = 'pg-bar';
  bar.hidden = true;
  bar.innerHTML = `<div class="pg-row"><span id="pg-sel" class="pg-sel"></span>
      <button class="icon-btn" data-pg="copy" title="복사 (Ctrl+C)">${ICONS.copy}</button>
      <button class="icon-btn" data-pg="paste" title="붙여넣기 — 선택한 쪽 뒤에 (Ctrl+V)">${ICONS.paste}</button>
      <button class="icon-btn" data-pg="dup" title="복제 (Ctrl+D)">${ICONS.dup}</button>
      <button class="icon-btn" data-pg="extract" title="새 탭으로 꺼내기">${ICONS.extract}</button>
      <button class="icon-btn danger" data-pg="del" title="삭제 (Delete)">${ICONS.trash}</button></div>
    <div class="pg-hint" title="오른쪽 클릭: 복사·붙여넣기·삭제 메뉴 · Ctrl+A 모두 선택"><kbd>Ctrl</kbd> 하나씩 · <kbd>Shift</kbd> 범위 · 쪽 <b>사이</b> 누르면 끼울 자리</div>`;
  body.insertBefore(bar, body.firstChild);
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pg]');
    if (!b || b.disabled) return;
    const a = b.dataset.pg;
    if (a === 'copy') copyPages();
    if (a === 'paste') pastePages();
    if (a === 'dup') duplicatePages();
    if (a === 'extract') extractToTab();
    if (a === 'del') deletePages();
  });

  const idxOf = (el) => { const t = el?.closest?.('.thumb'); return t ? Number(t.dataset.i) : null; };
  /** 누른 곳이 쪽 사이(미리보기 가장자리·빈 칸)이면 끼울 자리, 아니면 null */
  const EDGE = 14;
  const gapAt = (e) => {
    const t = e.target.closest?.('.thumb');
    const thumbs = [...box.querySelectorAll('.thumb')];
    if (!thumbs.length) return null;
    if (t) {
      const r = t.querySelector('.tw').getBoundingClientRect();
      const i = Number(t.dataset.i);
      if (e.clientX < r.left + EDGE * 0.3) return i;
      if (e.clientX > r.right - EDGE * 0.3) return i + 1;
      return null;
    }
    if (e.target !== box) return null;
    // 빈 칸: 같은 줄에서 가장 가까운 쪽의 왼쪽·오른쪽
    let best = null;
    for (const el of thumbs) {
      const r = el.getBoundingClientRect();
      const dy = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
      const cx = (r.left + r.right) / 2;
      const d = dy * 4 + Math.abs(e.clientX - cx);
      if (!best || d < best.d) best = { d, i: Number(el.dataset.i), after: e.clientX > cx };
    }
    return best ? best.i + (best.after ? 1 : 0) : null;
  };
  // 마우스를 쪽 사이에 올리면 끼울 자리를 미리 보여 줌
  let hoverGap = null;
  const showHover = (k) => {
    if (k === hoverGap) return;
    hoverGap = k;
    const total = S.pages.length;
    box.querySelectorAll('.gap-before, .gap-after').forEach((x) => x.classList.remove('gap-before', 'gap-after'));
    if (k == null) return;
    if (k < total) box.querySelector(`.thumb[data-i="${k}"]`)?.classList.add('gap-before');
    else box.querySelector(`.thumb[data-i="${total - 1}"]`)?.classList.add('gap-after');
  };
  box.addEventListener('pointerleave', () => showHover(null));

  // 누르기: 그냥 = 한 쪽 선택+이동 / Ctrl = 하나씩 더하기·빼기 / Shift = 범위 (Shift를 누른 채 끌면 범위가 따라 늘어남)
  let drag = null;
  let cursor = null; // 키보드로 옮겨 다니는 자리
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const g = gapAt(e);
    if (g != null && !e.shiftKey) { e.preventDefault(); setIns(g); box.focus({ preventScroll: true }); return; }
    const i = idxOf(e.target);
    if (i == null) return;
    ensureFor();
    cursor = i;
    const mod = e.ctrlKey || e.metaKey;
    if (e.shiftKey) {
      e.preventDefault();
      const a = anchor ?? S.current;
      const base = mod ? new Set(sel) : new Set();
      const apply1 = (j) => { sel = new Set([...base, ...range(a, j)]); paintSel(); };
      apply1(i);
      drag = { apply1, last: i, x: e.clientX, y: e.clientY };
      box.setPointerCapture(e.pointerId);
    } else if (mod) {
      e.preventDefault();
      if (sel.has(i)) sel.delete(i); else sel.add(i);
      anchor = i;
      paintSel();
    } else {
      setSel([i], i);
      goToPage(i);
    }
    e.target.closest('.thumb')?.focus({ preventScroll: true });
  });
  let scrollTimer = 0;
  const autoScroll = () => {
    if (!drag) return;
    const r = body.getBoundingClientRect();
    const d = drag.y < r.top + 40 ? -12 : drag.y > r.bottom - 40 ? 12 : 0;
    if (d) { body.scrollTop += d; pick(); }
    scrollTimer = requestAnimationFrame(autoScroll);
  };
  const pick = () => {
    const el = document.elementFromPoint(drag.x, drag.y);
    const j = idxOf(el);
    if (j != null && j !== drag.last) { drag.last = j; cursor = j; drag.apply1(j); }
  };
  box.addEventListener('pointermove', (e) => {
    if (!drag) { if (e.pointerType === 'mouse') showHover(gapAt(e)); return; }
    drag.x = e.clientX; drag.y = e.clientY;
    pick();
    if (!scrollTimer) scrollTimer = requestAnimationFrame(autoScroll);
  });
  const end = () => { drag = null; cancelAnimationFrame(scrollTimer); scrollTimer = 0; };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  // 클릭은 pointerdown에서 처리
  box.addEventListener('click', (e) => { if (idxOf(e.target) != null) e.stopPropagation(); }, true);

  box.addEventListener('contextmenu', (e) => {
    if (!S.pdf) return;
    const g = gapAt(e);
    if (g != null) { e.preventDefault(); setIns(g); syncClip().then(() => menu(e.clientX, e.clientY, g, g)); return; }
    const i = idxOf(e.target);
    if (i == null) return;
    e.preventDefault();
    ensureFor();
    if (!sel.has(i)) setSel([i], i);
    menu(e.clientX, e.clientY, i);
  });

  // 단축키 (쪽 미리보기에 초점이 있을 때)
  body.addEventListener('keydown', (e) => {
    if (!S.pdf || e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && k === 'a') { stop(); setSel(range(0, S.pages.length - 1), 0); return; }
    if (mod && k === 'c') { stop(); copyPages(); return; }
    if (mod && k === 'x') { stop(); copyPages(undefined, { cut: true }); return; }
    if (mod && k === 'v') { stop(); pastePages(); return; }
    if (mod && k === 'd') { stop(); duplicatePages(); return; }
    if (!mod && (k === 'delete' || k === 'backspace')) { stop(); deletePages(); return; }
    if (k === 'escape' && (sel.size > 1 || ins != null)) { stop(); setSel([S.current], S.current); return; }
    // 화살표: 선택 이동 (Shift = 범위 넓히기)
    if (!mod && (k === 'arrowdown' || k === 'arrowup' || k === 'arrowleft' || k === 'arrowright')) {
      ensureFor();
      const tw = box.querySelector('.thumb');
      const cols = tw ? Math.max(1, Math.floor((box.clientWidth + 8) / (tw.offsetWidth + 8))) : 1;
      const d = k === 'arrowdown' ? cols : k === 'arrowup' ? -cols : k === 'arrowright' ? 1 : -1;
      const from = cursor ?? anchor ?? S.current;
      const j = Math.max(0, Math.min(S.pages.length - 1, from + d));
      stop();
      cursor = j;
      if (e.shiftKey) { sel = new Set(range(anchor ?? from, j)); paintSel(); } else { setSel([j], j); goToPage(j); }
      box.querySelector(`.thumb[data-i="${j}"]`)?.focus();
    }
  });

  on('doc', () => { ensureFor(); if (!sel.size && S.pdf) { sel.add(S.current); anchor = S.current; } paintSel(); });
  on('tabs', paintSel);
  box.tabIndex = -1;
  syncClip();
}

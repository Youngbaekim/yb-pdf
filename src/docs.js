// 여러 문서를 탭으로 열기 (크롬 방식)
// - 탭마다 문서·주석·실행 취소 기록·보던 위치를 따로 보관하고, 바꿀 때 화면을 다시 그림
// - 탭을 끌어 순서 변경, 창 밖으로 끌어 놓으면 새 창으로 분리, 다른 YB-PDF 창의 탭 줄로 끌면 그 창으로 이동
import { S, emit, on, uid, pref, setPref, BASE } from './state.js';
import { clearPages, buildDom, setScale, targetScale, goTo } from './viewer.js';
import { getHistory, setHistory } from './annots.js';
import { dbp } from './db.js';
import { toast, confirmBox } from './dialogs.js';
import { ICONS } from './icons.js';
import { storable, revive } from './native.js';

const KEYS = ['pdf', 'pages', 'fileName', 'fileHandle', 'fileSize', 'cleanBytes', 'readOnly', 'readOnlyReason', 'dirty', 'annots', 'selected', 'current'];
const TAB_MIME = 'application/x-ybpdf-tab';
export const WIN = uid(); // 이 창의 고유 번호
const OPENED_BY_APP = new URLSearchParams(location.search).has('handoff');
const chan = 'BroadcastChannel' in window ? new BroadcastChannel('ybpdf-tabs') : null;

/** @type {{id:string, doc:object}[]} */
export const tabs = [];
let activeId = null;

const blank = () => ({
  pdf: null, pages: [], fileName: '', fileHandle: null, fileSize: 0, cleanBytes: null,
  readOnly: false, readOnlyReason: '', dirty: false, annots: [], selected: null, current: 0,
  hist: { undo: [], redo: [] }, view: null,
});
const viewer = () => document.getElementById('viewer');
export const active = () => tabs.find((t) => t.id === activeId) || null;
/** 탭의 현재 상태 (보고 있는 탭은 S에 살아 있음) */
export const docOf = (t) => (t.id === activeId ? S : t.doc);
export const anyDirty = () => tabs.some((t) => docOf(t).dirty);
/** 지금 탭이 비어 있으면(문서 없음) 그 탭을 그대로 씀 */
export const activeIsEmpty = () => !active() || !S.pdf;

function stash() {
  const t = active();
  if (!t) return;
  for (const k of KEYS) t.doc[k] = S[k];
  t.doc.hist = getHistory();
  const v = viewer();
  t.doc.view = { top: v.scrollTop, left: v.scrollLeft, scale: S.scale };
}
function load(t) {
  const d = t ? t.doc : blank();
  for (const k of KEYS) S[k] = d[k];
  setHistory(d.hist);
}

/** 새 탭을 만들어 보이게 함 (화면은 부르는 쪽에서 채움) */
export function newTab() {
  if (S.pdf) emit('before-switch');
  stash();
  const t = { id: uid(), doc: blank() };
  const i = tabs.findIndex((x) => x.id === activeId);
  tabs.splice(i < 0 ? tabs.length : i + 1, 0, t); // 지금 탭 바로 오른쪽
  activeId = t.id;
  load(t);
  emit('tabs');
  return t;
}

/** 화면을 지금 S의 문서로 다시 그림 */
function showDoc(view) {
  clearPages();
  const app = document.getElementById('app');
  if (S.pdf) {
    buildDom();
    setScale(targetScale());
    const v = viewer();
    if (view && Math.abs(view.scale - S.scale) < 1e-6) { v.scrollTop = view.top; v.scrollLeft = view.left; } else goTo(S.current);
  } else {
    app.classList.remove('has-doc');
  }
  emit('doc');
  emit('dirty');
  emit('annots');
  emit('select');
  emit('tabs');
}

export function activate(id) {
  if (id === activeId) return;
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  emit('before-switch');
  stash();
  activeId = id;
  load(t);
  showDoc(t.doc.view);
}

/** @returns {Promise<boolean>} 닫았는지 */
export async function closeTab(id, { force = false } = {}) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return false;
  if (!force && docOf(t).dirty) {
    activate(id);
    const r = await confirmBox(`'${S.fileName}'의 변경 내용을 저장하지 않았습니다.\n저장할까요?`, { ok: '저장', cancel: '취소', third: '저장 안 함' });
    if (!r) return false;
    if (r === 'ok') {
      const { save } = await import('./fileio.js');
      if (!(await save())) return false;
    }
  }
  if (t.id === activeId) emit('before-switch');
  const d = docOf(t);
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  try { await d.pdf?.destroy(); } catch { /* 무시 */ }
  if (t.id === activeId) {
    activeId = null;
    const next = tabs[i] || tabs[i - 1];
    if (next) { activeId = next.id; load(next); showDoc(next.doc.view); } else { load(null); showDoc(null); }
  } else emit('tabs');
  return true;
}

export function moveTab(id, to) {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return;
  const [t] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, to > from ? to - 1 : to)), 0, t);
  emit('tabs');
}

/** 이미 열려 있는 같은 파일의 탭 */
export async function findTab(handle) {
  if (!handle) return null;
  for (const t of tabs) {
    const h = docOf(t).fileHandle;
    try { if (h && (await h.isSameEntry(handle))) return t; } catch { /* 무시 */ }
  }
  return null;
}

/* ───────── 창 사이 이동 ───────── */
async function putHandoff(payload) {
  const db = await dbp;
  if (!db) throw new Error('저장소를 쓸 수 없습니다');
  const key = uid();
  await db.put('handoff', { ...payload, handle: storable(payload.handle), at: Date.now() }, key);
  return key;
}
export async function takeHandoff(key) {
  const db = await dbp;
  const v = await db?.get('handoff', key);
  if (v) { await db.delete('handoff', key); v.handle = revive(v.handle); }
  // 오래된 맡김 정리 (하루 지난 것)
  try {
    const keys = await db.getAllKeys('handoff');
    for (const k of keys) { const x = await db.get('handoff', k); if (x && Date.now() - x.at > 86_400_000) db.delete('handoff', k); }
  } catch { /* 무시 */ }
  return v;
}
function payloadOf(t) {
  const d = docOf(t);
  return { name: d.fileName, handle: d.fileHandle, bytes: d.cleanBytes, annots: d.annots, dirty: d.dirty, current: d.current, prepared: true };
}

function openWindow(key, at) {
  const w = Math.min(screen.availWidth, Math.max(900, window.outerWidth));
  const h = Math.min(screen.availHeight, Math.max(700, window.outerHeight));
  const left = at ? Math.max(0, Math.round(at.x - 120)) : window.screenX + 40;
  const top = at ? Math.max(0, Math.round(at.y - 20)) : window.screenY + 40;
  return window.open(`${BASE}?handoff=${key}`, '_blank', `popup,width=${w},height=${h},left=${left},top=${top}`);
}

/** 탭을 새 창으로 분리 */
export async function detach(id, at) {
  const t = tabs.find((x) => x.id === id);
  if (!t || !docOf(t).pdf) return;
  const key = await putHandoff(payloadOf(t));
  const w = openWindow(key, at);
  if (!w) { await takeHandoff(key); toast('팝업이 차단되어 새 창을 열지 못했습니다. 주소창 오른쪽에서 팝업을 허용해 주세요.', 5000); return; }
  closeTab(id, { force: true });
}

/** 파일을 새 창에서 열기 (설정: 'PDF를 새 창으로 열기') */
export async function openInNewWindow(payload) {
  const key = await putHandoff(payload);
  if (!openWindow(key)) { await takeHandoff(key); return false; }
  return true;
}

// 다른 창이 이 창의 탭을 가져가겠다고 할 때
chan?.addEventListener('message', async (e) => {
  const m = e.data || {};
  if (m.type === 'take' && m.src === WIN) {
    const t = tabs.find((x) => x.id === m.tab);
    if (!t) return;
    const key = await putHandoff(payloadOf(t));
    chan.postMessage({ type: 'given', to: m.to, key, index: m.index });
    await closeTab(t.id, { force: true });
    if (!tabs.length && OPENED_BY_APP) window.close(); // 앱이 띄운 창이 비면 닫음 (크롬처럼)
  }
  if (m.type === 'given' && m.to === WIN) {
    const v = await takeHandoff(m.key);
    if (v) emit('handoff', { ...v, index: m.index });
  }
});

/* ───────── 탭 줄 그리기 ───────── */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function renderTabs() {
  const bar = document.getElementById('doc-tabs');
  bar.innerHTML = tabs.map((t) => {
    const d = docOf(t);
    const name = d.pdf ? d.fileName : '새 탭';
    return `<div class="dtab${t.id === activeId ? ' on' : ''}" role="tab" aria-selected="${t.id === activeId}" draggable="true" data-id="${t.id}" title="${esc(name)}">
      ${d.dirty ? '<span class="t-dot" title="저장하지 않음">●</span>' : ''}<span class="t-name">${esc(name)}</span>
      <button class="t-x" title="탭 닫기" data-close>${ICONS.close}</button></div>`;
  }).join('');
  bar.querySelector('.dtab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
on('tabs', renderTabs);
on('dirty', renderTabs);
on('doc-name', renderTabs);

export function initTabs() {
  const bar = document.getElementById('doc-tabs');
  bar.addEventListener('click', (e) => {
    const tab = e.target.closest('.dtab');
    if (!tab) return;
    if (e.target.closest('[data-close]')) { closeTab(tab.dataset.id); return; }
    activate(tab.dataset.id);
  });
  bar.addEventListener('auxclick', (e) => { // 가운데 단추 = 닫기
    const tab = e.target.closest('.dtab');
    if (tab && e.button === 1) { e.preventDefault(); closeTab(tab.dataset.id); }
  });
  bar.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  bar.addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('.dtab');
    if (!tab) return;
    e.preventDefault();
    showMenu(tab.dataset.id, e.clientX, e.clientY);
  });

  /* 끌기 */
  let dragId = null;
  bar.addEventListener('dragstart', (e) => {
    const tab = e.target.closest('.dtab');
    if (!tab) return;
    dragId = tab.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(TAB_MIME, JSON.stringify({ win: WIN, tab: dragId }));
    tab.classList.add('dragging');
  });
  bar.addEventListener('dragend', (e) => {
    const id = dragId;
    dragId = null;
    bar.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
    clearMarks();
    if (!id || e.dataTransfer.dropEffect !== 'none') return; // 어딘가(다른 YB-PDF 창 포함)에 놓였음
    // 창 밖에 놓음 → 새 창으로 분리 (탭이 하나뿐이면 그대로)
    const out = e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth || e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
    if (out && tabs.length > 1) detach(id, { x: e.screenX, y: e.screenY });
  });

  const isTabDrag = (e) => [...(e.dataTransfer?.types || [])].includes(TAB_MIME);
  const clearMarks = () => {
    bar.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    bar.classList.remove('drop-end');
  };
  /** 놓을 자리(탭 번호) */
  const indexAt = (x) => {
    const els = [...bar.querySelectorAll('.dtab')];
    for (let k = 0; k < els.length; k++) {
      const r = els[k].getBoundingClientRect();
      if (x < r.left + r.width / 2) return k;
    }
    return els.length;
  };
  const mark = (idx) => {
    clearMarks();
    const els = [...bar.querySelectorAll('.dtab')];
    if (idx < els.length) els[idx].classList.add('drop-before');
    else if (els.length) els[els.length - 1].classList.add('drop-after');
  };
  const app = document.getElementById('app');
  app.addEventListener('dragover', (e) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (bar.contains(e.target) || e.target.closest?.('.topbar')) mark(indexAt(e.clientX)); else clearMarks();
  });
  app.addEventListener('dragleave', (e) => { if (!app.contains(e.relatedTarget)) clearMarks(); });
  app.addEventListener('drop', (e) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const onBar = !!e.target.closest?.('.topbar');
    const idx = onBar ? indexAt(e.clientX) : tabs.length;
    clearMarks();
    let info;
    try { info = JSON.parse(e.dataTransfer.getData(TAB_MIME)); } catch { return; }
    if (info.win === WIN) { if (onBar) moveTab(info.tab, idx); return; }
    // 다른 창의 탭 → 이 창으로 가져오기
    if (!chan) return toast('이 브라우저는 창 사이 탭 이동을 지원하지 않습니다.');
    chan.postMessage({ type: 'take', src: info.win, tab: info.tab, to: WIN, index: idx });
  }, true);
}

/* 탭 오른쪽 클릭 메뉴 */
function showMenu(id, x, y) {
  document.querySelector('.tab-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'tab-menu';
  const has = !!docOf(tabs.find((t) => t.id === id)).pdf;
  m.innerHTML = `${has ? `<button data-a="win">${ICONS.window} 새 창으로 옮기기</button>` : ''}
    <button data-a="close">${ICONS.close} 탭 닫기</button>
    ${tabs.length > 1 ? `<button data-a="others">${ICONS.close} 다른 탭 모두 닫기</button>` : ''}
    <hr><label class="chk" style="margin:4px 10px"><input type="checkbox" data-a="mode" ${pref('newWindow', false) ? 'checked' : ''}> 새 PDF는 새 창으로 열기</label>`;
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  const close = () => { m.remove(); window.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'mode') { setPref('newWindow', b.checked); emit('open-mode'); return; }
    close();
    if (a === 'win') detach(id);
    if (a === 'close') closeTab(id);
    if (a === 'others') { for (const t of tabs.filter((x) => x.id !== id)) if (!(await closeTab(t.id))) break; }
  });
}

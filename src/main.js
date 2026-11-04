// YB-PDF — 개인용 PDF 읽기·편집 앱 (서버 없이 브라우저에서만 동작)
import './style.css';
import { applyTheme, getTheme, setTheme } from './theme.js';
import { S, on, emit, pref, setPref, saveOpts, BASE } from './state.js';
import { applyIcons, ICONS } from './icons.js';
import * as V from './viewer.js';
import * as A from './annots.js';
import { initTools, setTool, select, editAnnot } from './tools.js';
import { pickAndOpen, openHandle, openBytes, save, initDrop, recentList, forget, printDoc, rememberPage, canPick } from './fileio.js';
import * as D from './docs.js';
import { initTabs, anyDirty, active, closeTab, takeHandoff } from './docs.js';
import { openMerge } from './merge.js';
import { PALETTE, swatches, bindSwatches, toast, openSignPad, getSigns, deleteSign } from './dialogs.js';
import { FONT_LABEL } from './pdfwrite.js';
import './overlay.js';

const VERSION = 'v0.3.0';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const app = $('#app');
const viewer = $('#viewer');

applyIcons();
applyTheme();

/* ───────── 왼쪽 메뉴: 펼치기·접기(머리줄 왼쪽 스위치)·너비 ───────── */
const PANEL_DEF = 300;
const narrow = () => window.innerWidth <= 760; // 휴대폰: 메뉴가 문서 위에 겹쳐 열림
let panelOpen = narrow() ? false : pref('panel', true);
let panelW = pref('panel-w', PANEL_DEF);
function applyPanel() {
  app.dataset.panel = panelOpen ? 'open' : 'closed';
  app.style.setProperty('--panel-w', `${panelW}px`);
  const b = $('#btn-panel');
  b.innerHTML = panelOpen ? ICONS.panelOpen : ICONS.panel;
  b.title = panelOpen ? '메뉴 접기 (Ctrl+\\)' : '메뉴 펼치기 (Ctrl+\\)';
  b.setAttribute('aria-pressed', String(panelOpen));
}
function togglePanel(v = !panelOpen) {
  panelOpen = v;
  if (!narrow()) setPref('panel', v);
  applyPanel();
  requestAnimationFrame(() => V.refit());
}
applyPanel();
$('#btn-panel').addEventListener('click', () => togglePanel());
(() => {
  const rz = $('#panel-resizer');
  let x0 = 0, w0 = 0;
  const move = (e) => {
    panelW = Math.max(220, Math.min(560, w0 + (e.clientX - x0)));
    app.style.setProperty('--panel-w', `${panelW}px`);
  };
  const up = () => {
    rz.classList.remove('on');
    window.removeEventListener('pointermove', move);
    setPref('panel-w', panelW);
    V.refit();
  };
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    x0 = e.clientX; w0 = panelW;
    rz.classList.add('on');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  });
  rz.addEventListener('dblclick', () => { panelW = PANEL_DEF; setPref('panel-w', panelW); applyPanel(); V.refit(); });
})();

/* ───────── 탭 ───────── */
let tab = 'tool';
function showTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.id !== `tab-${t}`; });
  if (t === 'pages') buildThumbs();
  if (t === 'list') renderList();
  if (t === 'file') renderFileTab();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  if (!panelOpen) togglePanel(true);
  showTab(b.dataset.tab);
}));

/* ───────── 도구 탭 ───────── */
const TOOL_INFO = {
  select: ['선택', '주석을 누르면 선택됩니다. 끌어서 옮기고, 두 번 누르면 내용을 고칩니다. <kbd>Delete</kbd>로 삭제. 글자를 끌어 선택하면 복사(<kbd>Ctrl+C</kbd>)할 수 있습니다.'],
  hand: ['손', '문서를 끌어서 움직입니다. <kbd>Space</kbd>를 누른 채 끌어도 됩니다.'],
  highlight: ['형광펜', '글자 위를 끌면 그 글자에 칠합니다. 글자가 없는 곳(스캔 문서 등)은 자유롭게 칠합니다.'],
  pen: ['펜', '마우스·펜으로 자유롭게 씁니다. 펜의 필압을 반영합니다. 2초 안에 이어 쓴 획은 한 묶음이 됩니다.'],
  note: ['메모', '쪽의 원하는 곳을 누르면 메모를 붙입니다. 다른 PDF 뷰어에서도 메모(주석)로 보입니다.'],
  text: ['텍스트 상자', '쪽의 원하는 곳을 누르고 글자를 입력합니다. 서식·빈칸 채우기에 씁니다.'],
  replace: ['텍스트 수정', '고칠 낱말이나 문장을 끌어 선택(또는 두 번 눌러 낱말 선택)한 뒤 새 내용을 입력합니다. 원래 글자를 바탕색으로 덮고 새 글자를 씁니다.'],
  sign: ['서명', '서명을 고른 뒤 쪽을 누르면 그 자리에 넣습니다. 넣은 뒤 끌어서 옮기고 모서리로 크기를 조절합니다.'],
  eraser: ['지우개', '주석을 누르거나 문질러 지웁니다. (원래 PDF 내용은 지워지지 않습니다)'],
};

function renderToolTab() {
  const t = S.tool;
  const o = S.opts;
  const [name, help] = TOOL_INFO[t];
  let body = '';
  if (t === 'highlight') {
    body = `<div class="opt"><span class="lbl">색</span>${swatches(PALETTE.highlight, o.hlColor, 'hlColor')}</div>
      <div class="opt"><span class="lbl">진하기</span><input type="range" min="0.15" max="0.8" step="0.05" data-opt="hlOpacity" value="${o.hlOpacity}"><output>${Math.round(o.hlOpacity * 100)}%</output></div>`;
  } else if (t === 'pen') {
    body = `<div class="opt"><span class="lbl">색</span>${swatches(PALETTE.ink, o.penColor, 'penColor')}</div>
      <div class="opt"><span class="lbl">굵기</span><input type="range" min="0.6" max="12" step="0.2" data-opt="penWidth" value="${o.penWidth}"><output>${o.penWidth}pt</output></div>
      <div class="opt"><span class="lbl">불투명도</span><input type="range" min="0.2" max="1" step="0.05" data-opt="penOpacity" value="${o.penOpacity}"><output>${Math.round(o.penOpacity * 100)}%</output></div>`;
  } else if (t === 'note') {
    body = `<div class="opt"><span class="lbl">색</span>${swatches(PALETTE.note, o.noteColor, 'noteColor')}</div>`;
  } else if (t === 'text') {
    body = `<div class="opt"><span class="lbl">글꼴</span><select data-opt="textFont">${Object.entries(FONT_LABEL).map(([k, v]) => `<option value="${k}"${o.textFont === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="opt"><span class="lbl">크기</span><input type="number" min="4" max="200" step="0.5" data-opt="textSize" value="${o.textSize}"><span class="unit">pt</span></div>
      <div class="opt"><span class="lbl">글자색</span>${swatches(PALETTE.text, o.textColor, 'textColor')}</div>`;
  } else if (t === 'sign') {
    const signs = getSigns();
    body = `<div class="sign-list">${signs.map((src, k) => `<div class="sign-item${S.signArmed === src ? ' on' : ''}" data-k="${k}"><img src="${src}" alt="서명 ${k + 1}"><button class="x" data-del="${k}" title="목록에서 삭제">✕</button></div>`).join('')}
      <button class="sign-new" id="btn-sign-new">＋ 새 서명</button></div>
      <div class="opt"><span class="lbl">넣을 너비</span><input type="range" min="50" max="300" step="5" data-opt="signWidth" value="${o.signWidth}"><output>${o.signWidth}pt</output></div>`;
  }
  const draw = ['pen', 'highlight', 'eraser'].includes(t);
  $('#tab-tool').innerHTML = `
    <section class="sec"><h4>${name}</h4><p class="help">${help}</p>${body}
      ${draw ? `<label class="chk"><input type="checkbox" data-opt="fingerDraw" ${o.fingerDraw ? 'checked' : ''}> 손가락으로도 그리기 <span class="hint">(끄면 손가락은 화면 이동)</span></label>` : ''}
    </section>
    <section class="sec"><h4>보기</h4>
      <div class="seg" role="group"><button data-spread="1" class="${S.spread === 1 ? 'on' : ''}">${ICONS.spread1} 1쪽</button><button data-spread="2" class="${S.spread === 2 ? 'on' : ''}">${ICONS.spread2} 2쪽</button></div>
      <label class="chk"><input type="checkbox" id="chk-cover" ${S.coverAlone ? 'checked' : ''} ${S.spread === 2 ? '' : 'disabled'}> 표지(첫 쪽) 단독 표시 <span class="hint">(책처럼 펼침면 맞춤)</span></label>
      <div class="opt"><span class="lbl">화면 모드</span><select id="sel-theme"><option value="system">🌓 시스템 설정 사용</option><option value="dark">🌙 다크모드 켜기</option><option value="light">☀ 다크모드 끄기</option></select></div>
    </section>`;
  $('#sel-theme').value = getTheme();
  bindSwatches($('#tab-tool'), (name, c) => { S.opts[name] = c; saveOpts(); });
}
$('#tab-tool').addEventListener('input', (e) => {
  const k = e.target.dataset.opt;
  if (!k) return;
  if (e.target.type === 'checkbox') S.opts[k] = e.target.checked;
  else if (e.target.type === 'range' || e.target.type === 'number') {
    S.opts[k] = Number(e.target.value);
    const out = e.target.nextElementSibling;
    if (out?.tagName === 'OUTPUT') out.textContent = k.includes('Opacity') ? `${Math.round(S.opts[k] * 100)}%` : `${S.opts[k]}pt`;
  } else S.opts[k] = e.target.value;
  saveOpts();
});
$('#tab-tool').addEventListener('change', (e) => {
  if (e.target.id === 'sel-theme') setTheme(e.target.value);
  if (e.target.id === 'chk-cover') { S.coverAlone = e.target.checked; setPref('cover', S.coverAlone); relayout(); }
});
$('#tab-tool').addEventListener('click', async (e) => {
  const sp = e.target.closest('[data-spread]');
  if (sp) return setSpread(Number(sp.dataset.spread));
  const del = e.target.closest('[data-del]');
  if (del) {
    const src = getSigns()[Number(del.dataset.del)];
    if (S.signArmed === src) S.signArmed = null;
    deleteSign(src);
    return renderToolTab();
  }
  const item = e.target.closest('.sign-item');
  if (item) { S.signArmed = getSigns()[Number(item.dataset.k)]; return renderToolTab(); }
  if (e.target.closest('#btn-sign-new')) {
    const src = await openSignPad();
    if (src) { S.signArmed = src; renderToolTab(); toast('쪽을 누르면 서명이 들어갑니다.'); }
  }
});

/* ───────── 보기 방식 ───────── */
function relayout() {
  if (!S.pdf) return;
  const cur = S.current;
  V.buildDom();
  V.setScale(V.targetScale());
  V.goTo(cur);
  buildThumbsLater();
}
function setSpread(n) {
  S.spread = n;
  setPref('spread', n);
  if (typeof S.zoomMode === 'number') { S.zoomMode = n === 2 ? 'page' : 'width'; setPref('zoom', S.zoomMode); } // 보기 방식을 바꾸면 화면에 맞춤
  $('#btn-spread').innerHTML = n === 2 ? ICONS.spread2 : ICONS.spread1;
  relayout();
  renderToolTab();
}
$('#btn-spread').innerHTML = S.spread === 2 ? ICONS.spread2 : ICONS.spread1;

/* ───────── 줄 단추(rail) ───────── */
$('#rail').addEventListener('click', (e) => {
  const b = e.target.closest('.rail-btn');
  if (!b) return;
  if (b.dataset.tool) {
    setTool(b.dataset.tool);
    if (panelOpen) showTab('tool');
    return;
  }
  if (narrow() && panelOpen && b.dataset.cmd !== 'panel') togglePanel(false);
  runCmd(b.dataset.cmd);
});
function runCmd(c) {
  if (c === 'open') return pickAndOpen();
  if (c === 'save') return save();
  if (c === 'saveas') return save({ as: true });
  if (c === 'undo') return A.undo();
  if (c === 'redo') return A.redo();
  if (c === 'spread') return setSpread(S.spread === 2 ? 1 : 2);
  if (c === 'panel') return togglePanel();
  if (c === 'merge') return openMerge();
  if (c === 'print') return printDoc();
}
on('tool', () => {
  document.querySelectorAll('.rail-btn.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
  renderToolTab();
});

/* ───────── 머리줄 ───────── */
function updateTitle() {
  document.title = S.pdf ? `${S.dirty ? '● ' : ''}${S.fileName} — YB-PDF` : 'YB-PDF';
  $('[data-cmd=save]').classList.toggle('attn', S.dirty);
}
on('dirty', updateTitle);
on('doc-name', updateTitle);
function updatePager() {
  $('#page-input').value = S.pdf ? S.current + 1 : '';
  $('#page-total').textContent = S.pdf ? `/ ${S.pages.length}` : '';
  document.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('on', Number(t.dataset.i) === S.current));
}
on('current', () => { updatePager(); rememberPageLater(); });
let rpTimer = 0;
const rememberPageLater = () => { clearTimeout(rpTimer); rpTimer = setTimeout(rememberPage, 800); };
$('#page-input').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (n > 0) V.goTo(n - 1);
  e.target.blur();
});
$('#page-input').addEventListener('focus', (e) => e.target.select());
$('#btn-prev').addEventListener('click', () => V.step(-1));
$('#btn-next').addEventListener('click', () => V.step(1));
$('#btn-zoom-in').addEventListener('click', () => V.zoomBy(1.2));
$('#btn-zoom-out').addEventListener('click', () => V.zoomBy(1 / 1.2));
$('#sel-zoom').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'width' || v === 'page') V.setZoomMode(v);
  else if (v !== 'custom') V.setZoomMode(Number(v));
  e.target.blur();
});
function updateZoomSel() {
  const sel = $('#sel-zoom');
  const custom = sel.querySelector('[value=custom]');
  if (typeof S.zoomMode === 'string') { sel.value = S.zoomMode; custom.hidden = true; return; }
  const match = [...sel.options].find((o) => Number(o.value) === S.zoomMode);
  if (match) { sel.value = match.value; custom.hidden = true; } else {
    custom.hidden = false;
    custom.textContent = `${Math.round(S.scale * 100)}%`;
    sel.value = 'custom';
  }
}
on('scale', updateZoomSel);

/* ───────── 문서 열림 ───────── */
on('doc', () => {
  app.classList.toggle('has-doc', !!S.pdf);
  $('#pager').hidden = !S.pdf;
  $('#zoom').hidden = !S.pdf;
  updateUndo();
  updateTitle();
  updatePager();
  updateZoomSel();
  if (S.readOnly) setTool('select');
  thumbsBuiltFor = null;
  if (tab === 'pages') buildThumbs();
  if (tab === 'list') renderList();
  if (tab === 'file') renderFileTab();
});
on('loading', (v) => { $('#loading').hidden = !v; });
on('saving', (v) => { $('#loading').hidden = !v; $('#loading-msg').textContent = v ? '저장하는 중…' : '여는 중…'; });

/* ───────── 쪽 미리보기 ───────── */
let thumbsBuiltFor = null;
let thumbIO = null;
let thumbTimer = 0;
const buildThumbsLater = () => { thumbsBuiltFor = null; if (tab === 'pages') { clearTimeout(thumbTimer); thumbTimer = setTimeout(buildThumbs, 50); } };
function buildThumbs() {
  if (!S.pdf) { $('#thumbs').innerHTML = ''; thumbsBuiltFor = null; return; }
  if (thumbsBuiltFor === S.pdf) return;
  thumbsBuiltFor = S.pdf;
  const box = $('#thumbs');
  thumbIO?.disconnect();
  box.innerHTML = S.pages.map((p, i) => {
    const w = 104, h = Math.round((p.h / p.w) * w);
    return `<button class="thumb${i === S.current ? ' on' : ''}" data-i="${i}" title="${i + 1}쪽"><span class="tw" style="width:${w}px;height:${h}px"><canvas></canvas></span><span class="tn">${i + 1}</span></button>`;
  }).join('');
  thumbIO = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { drawThumb(e.target); thumbIO.unobserve(e.target); } }), { root: box.parentElement, rootMargin: '300px 0px' });
  box.querySelectorAll('.thumb').forEach((t) => thumbIO.observe(t));
  box.querySelector('.thumb.on')?.scrollIntoView({ block: 'center' });
}
async function drawThumb(btn) {
  const i = Number(btn.dataset.i);
  const doc = S.pdf;
  try {
    const page = await doc.getPage(i + 1);
    if (doc !== S.pdf) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (104 / vp0.width) * dpr });
    const cv = btn.querySelector('canvas');
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    await page.render({ canvas: cv, viewport: vp }).promise;
  } catch { /* 무시 */ }
}
$('#thumbs').addEventListener('click', (e) => {
  const t = e.target.closest('.thumb');
  if (t) V.goTo(Number(t.dataset.i));
});

/* ───────── 주석 목록 ───────── */
const TYPE_ICON = { highlight: 'highlight', ink: 'pen', note: 'note', text: 'text', replace: 'replace', sign: 'sign' };
function renderList() {
  const box = $('#annot-list');
  if (!S.pdf) { box.innerHTML = '<p class="muted">문서를 열면 주석이 여기에 표시됩니다.</p>'; return; }
  const list = S.annots.slice().sort((a, b) => a.page - b.page || A.bbox(b)[3] - A.bbox(a)[3]);
  if (!list.length) { box.innerHTML = '<p class="muted">아직 주석이 없습니다.<br>오른쪽 도구로 형광펜·펜·메모 등을 추가하세요.</p>'; return; }
  let html = '';
  let pg = -1;
  for (const a of list) {
    if (a.page !== pg) { pg = a.page; html += `<div class="al-page">${pg + 1}쪽</div>`; }
    const desc = a.type === 'ink' ? `${a.marker ? '자유 형광펜' : '펜'} ${a.strokes.length}획` : a.type === 'sign' ? '서명' : (a.text || '').replace(/\s+/g, ' ').slice(0, 60) || A.TYPE_LABEL[a.type];
    const sw = a.color ? `<i class="al-sw" style="background:${a.color}"></i>` : '';
    html += `<div class="al-item${S.selected === a.id ? ' on' : ''}" data-id="${a.id}"><span class="al-ic">${ICONS[TYPE_ICON[a.type]]}</span>
      <span class="al-tx"><b>${A.TYPE_LABEL[a.type]}</b>${sw}<span>${esc(desc)}</span></span><button class="al-del" title="삭제">✕</button></div>`;
  }
  box.innerHTML = html;
}
$('#annot-list').addEventListener('click', (e) => {
  const it = e.target.closest('.al-item');
  if (!it) return;
  const a = A.find(it.dataset.id);
  if (!a) return;
  if (e.target.closest('.al-del')) { A.remove(a.id); return; }
  const b = A.bbox(a);
  V.goTo(a.page, { x: b[0], y: b[3] });
  setTool('select');
  select(a.id);
});
$('#annot-list').addEventListener('dblclick', (e) => {
  const it = e.target.closest('.al-item');
  const a = it && A.find(it.dataset.id);
  if (a) editAnnot(a);
});
function updateCount() {
  const n = S.annots.length;
  $('#annot-count').textContent = n ? n : '';
}
on('annots', () => { updateCount(); if (tab === 'list') renderList(); updateUndo(); });
on('select', () => { if (tab === 'list') renderList(); });
function updateUndo() {
  $('[data-cmd=undo]').disabled = !A.canUndo();
  $('[data-cmd=redo]').disabled = !A.canRedo();
}

/* ───────── 파일 탭 ───────── */
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
async function renderFileTab() {
  const recent = await recentList();
  $('#tab-file').innerHTML = `
    <section class="sec"><div class="file-btns">
      <button class="fbtn" data-cmd="open">${ICONS.open}<span>열기</span><kbd>Ctrl+O</kbd></button>
      <button class="fbtn" data-cmd="save" ${S.pdf ? '' : 'disabled'}>${ICONS.save}<span>저장 (덮어쓰기)</span><kbd>Ctrl+S</kbd></button>
      <button class="fbtn" data-cmd="saveas" ${S.pdf ? '' : 'disabled'}>${ICONS.save}<span>다른 이름으로 저장</span><kbd>Ctrl+Shift+S</kbd></button>
      <button class="fbtn" data-cmd="merge">${ICONS.spread2}<span>PDF 병합</span></button>
      <button class="fbtn" data-cmd="print" ${S.pdf ? '' : 'disabled'}>${ICONS.text}<span>인쇄 (브라우저 PDF 창)</span><kbd>Ctrl+P</kbd></button>
    </div>
    <label class="chk"><input type="checkbox" id="chk-newwin" ${pref('newWindow', false) ? 'checked' : ''}> 새 PDF는 새 창으로 열기 <span class="hint">(끄면 위쪽 탭으로 열림)</span></label>
    ${canPick ? '' : '<p class="hint warn">이 브라우저는 파일 덮어쓰기를 지원하지 않아 저장하면 내려받기로 저장됩니다. (PC의 크롬·엣지 권장)</p>'}</section>
    ${S.pdf ? `<section class="sec"><h4>문서 정보</h4><table class="info"><tr><th>파일</th><td>${esc(S.fileName)}</td></tr><tr><th>쪽 수</th><td>${S.pages.length}쪽</td></tr>
      <tr><th>크기</th><td>${kb(S.fileSize)}</td></tr><tr><th>주석</th><td>${S.annots.length}개</td></tr>${S.readOnly ? `<tr><th>상태</th><td class="warn">${esc(S.readOnlyReason)}</td></tr>` : ''}</table></section>` : ''}
    ${recent.length ? `<section class="sec"><h4>최근 파일</h4><div class="recent-list">${recent.map((r) => `<div class="rc" data-name="${esc(r.name)}"><button class="rc-open">${esc(r.name)}<small>${new Date(r.at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}</small></button><button class="rc-x" title="목록에서 빼기">✕</button></div>`).join('')}</div></section>` : ''}
    <section class="sec"><h4>단축키</h4><table class="keys">
      <tr><td><kbd>Ctrl+O</kbd> / <kbd>Ctrl+S</kbd></td><td>열기 / 저장</td></tr>
      <tr><td><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd></td><td>실행 취소 / 다시 실행</td></tr>
      <tr><td><kbd>V H M P N T E S X</kbd></td><td>선택·손·형광펜·펜·메모·텍스트·수정·서명·지우개</td></tr>
      <tr><td><kbd>Ctrl</kbd>+휠, <kbd>Ctrl +/−/0</kbd></td><td>확대·축소 / 폭 맞춤</td></tr>
      <tr><td><kbd>Ctrl+2</kbd></td><td>1쪽 / 2쪽 보기</td></tr>
      <tr><td><kbd>PageUp/Down</kbd>, <kbd>Home/End</kbd></td><td>쪽 이동</td></tr>
      <tr><td><kbd>Ctrl+\\</kbd></td><td>메뉴 접기·펼치기</td></tr>
      <tr><td>탭 끌기</td><td>순서 변경 · 창 밖에 놓으면 새 창</td></tr>
      <tr><td>탭 가운데 단추·<kbd>Ctrl+W</kbd></td><td>탭 닫기 (Ctrl+W는 설치한 앱에서)</td></tr>
    </table></section>
    <section class="sec about"><p>YB-PDF ${VERSION}${window.ybpdfNative ? ' (Windows 앱)' : ''} · 개인용(비상업) · 서버 없이 이 기기에서만 처리</p>
    <p class="hint">한글 글꼴: 나눔고딕·나눔명조·나눔손글씨 펜 (SIL OFL) · PDF 처리: pdf.js, pdf-lib, HarfBuzz</p></section>`;
}
$('#tab-file').addEventListener('change', (e) => {
  if (e.target.id === 'chk-newwin') setPref('newWindow', e.target.checked);
});
on('open-mode', () => { if (tab === 'file') renderFileTab(); });
$('#tab-file').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b) return runCmd(b.dataset.cmd);
  const rc = e.target.closest('.rc');
  if (!rc) return;
  const name = rc.dataset.name;
  if (e.target.closest('.rc-x')) { await forget(name); return renderFileTab(); }
  const r = (await recentList()).find((x) => x.name === name);
  if (r) openHandle(r.handle);
});
on('recent', () => { if (tab === 'file') renderFileTab(); renderRecentEmpty(); });

/* 첫 화면의 최근 파일 */
async function renderRecentEmpty() {
  const list = await recentList();
  $('#recent-empty').innerHTML = list.length ? `<h4>최근 파일</h4>${list.slice(0, 6).map((r) => `<button class="rc-open" data-name="${esc(r.name)}">📄 ${esc(r.name)}</button>`).join('')}` : '';
}
$('#recent-empty').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-name]');
  if (!b) return;
  const r = (await recentList()).find((x) => x.name === b.dataset.name);
  if (r) openHandle(r.handle);
});
$('#btn-open-big').addEventListener('click', () => pickAndOpen());

/* ───────── 단축키 ───────── */
const TOOL_KEYS = { v: 'select', h: 'hand', m: 'highlight', p: 'pen', n: 'note', t: 'text', e: 'replace', s: 'sign', x: 'eraser' };
let spaceHand = null;
window.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable], dialog');
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 's') { e.preventDefault(); save({ as: e.shiftKey }); return; }
  if (mod && k === 'o') { e.preventDefault(); pickAndOpen(); return; }
  if (mod && k === 'p' && S.pdf) { e.preventDefault(); printDoc(); return; }
  if (mod && k === 'w' && active()) { e.preventDefault(); closeTab(active().id); return; } // 설치한 앱 창에서 동작
  if (typing) return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); A.undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); A.redo(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); V.zoomBy(1.2); return; }
  if (mod && k === '-') { e.preventDefault(); V.zoomBy(1 / 1.2); return; }
  if (mod && k === '0') { e.preventDefault(); V.setZoomMode('width'); return; }
  if (mod && k === '2') { e.preventDefault(); setSpread(S.spread === 2 ? 1 : 2); return; }
  if (mod && k === '\\') { e.preventDefault(); togglePanel(); return; }
  if (mod) return;
  if ((k === 'delete' || k === 'backspace') && S.selected) { e.preventDefault(); A.remove(S.selected); return; }
  if (k === 'escape') { if (S.selected) select(null); else setTool('select'); return; }
  if (k === ' ' && S.pdf && S.tool !== 'hand' && !spaceHand) { e.preventDefault(); spaceHand = S.tool; setTool('hand'); return; }
  if (!S.pdf) return;
  if (TOOL_KEYS[k] && !e.altKey) { setTool(TOOL_KEYS[k]); if (panelOpen) showTab('tool'); return; }
  if (k === 'pagedown' || (k === 'arrowright' && !viewerScrollsX())) { e.preventDefault(); V.step(1); return; }
  if (k === 'pageup' || (k === 'arrowleft' && !viewerScrollsX())) { e.preventDefault(); V.step(-1); return; }
  if (k === 'home') { e.preventDefault(); V.goTo(0); return; }
  if (k === 'end') { e.preventDefault(); V.goTo(S.pages.length - 1); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && spaceHand) { setTool(spaceHand); spaceHand = null; }
});
const viewerScrollsX = () => viewer.scrollWidth > viewer.clientWidth + 2;

/* ───────── 화면 이벤트 ───────── */
viewer.addEventListener('pointerdown', () => { if (narrow() && panelOpen) togglePanel(false); }, true);
let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; emit('scroll'); });
}, { passive: true });
let resizeTimer = 0;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => V.refit(), 120); }).observe(viewer);

window.addEventListener('beforeunload', (e) => {
  rememberPage();
  if (anyDirty()) { e.preventDefault(); e.returnValue = ''; }
});

/* ───────── 문서 탭 ───────── */
on('before-switch', rememberPage);
$('#btn-new-tab').addEventListener('click', () => pickAndOpen());
// 다른 창에서 옮겨 온 탭 (끌어 놓기·새 창으로 옮기기)
on('handoff', (v) => openBytes(v.bytes, v.name, v.handle || null, { dirty: v.dirty, annots: v.prepared ? v.annots : undefined, current: v.current, index: v.index, here: true }));
async function startHandoff() {
  const key = new URLSearchParams(location.search).get('handoff');
  if (!key) return;
  history.replaceState(null, '', location.pathname);
  const v = await takeHandoff(key);
  if (v) emit('handoff', v);
}

/* ───────── 시작 ───────── */
initTools();
initTabs();
initDrop();
startHandoff();
setTool('select');
renderRecentEmpty();
updateUndo();
showTab('tool');

// 서비스 워커 (오프라인 실행·설치) — 개발 서버에서는 쓰지 않음
if ('serviceWorker' in navigator && import.meta.env.PROD && !window.ybpdfNative) { // 데스크톱 앱은 파일이 이미 설치되어 있어 필요 없음
  navigator.serviceWorker.register(`${BASE}sw.js`).then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(nw);
      });
    });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
  }).catch(() => {});
  // 처음 설치될 때(이전 서비스 워커 없음)는 새로고침하지 않음 — '새로고침' 단추를 눌렀을 때만
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
}
function showUpdate(worker) {
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.innerHTML = '새 버전이 있습니다. <button>새로고침</button>';
  bar.querySelector('button').addEventListener('click', async () => {
    if (S.dirty && !(await save())) return;
    worker.postMessage('skipWaiting');
  });
  document.body.appendChild(bar);
}

// 개발·점검용
window.__ybpdf = { S, A, V, D };

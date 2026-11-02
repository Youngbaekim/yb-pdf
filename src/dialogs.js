// 대화상자: 텍스트·메모 편집, 서명 패드, 색 고르기, 안내
import { S, pref, setPref, saveOpts } from './state.js';
import { FAMILY, ensureFace } from './fonts.js';
import { FONT_LABEL } from './pdfwrite.js';
import { getStroke } from 'perfect-freehand';
import { pathFromOutline } from './overlay.js';

export const PALETTE = {
  highlight: ['#ffe14d', '#8be36b', '#6fd3ff', '#ff9ad5', '#ffb050'],
  ink: ['#111111', '#d32f2f', '#1e5bd8', '#1b8a3a', '#7b3fbf', '#f57c00'],
  note: ['#ffd54a', '#a5e887', '#8fd3ff', '#ffb3d9'],
  text: ['#111111', '#d32f2f', '#1e5bd8', '#1b8a3a', '#555555'],
};

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function makeDialog(cls, html) {
  const d = document.createElement('dialog');
  d.className = `dlg ${cls}`;
  d.innerHTML = html;
  document.body.appendChild(d);
  return d;
}
/** 대화상자를 열고 결과를 기다림 */
function run(d, setup) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    d.addEventListener('mousedown', (e) => { if (e.target === d) finish(null); }); // 바깥을 누르면 닫기
    setup(finish);
    d.showModal();
  });
}

/* ───────── 안내 ───────── */
let toastTimer = 0;
export function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

export function confirmBox(msg, { ok = '확인', cancel = '취소', third } = {}) {
  const d = makeDialog('dlg-confirm', `<form method="dialog"><p class="msg">${esc(msg).replace(/\n/g, '<br>')}</p>
    <div class="dlg-foot">${third ? `<button type="button" class="btn" data-v="third">${esc(third)}</button><span class="sp"></span>` : '<span class="sp"></span>'}
    <button type="button" class="btn" data-v="cancel">${esc(cancel)}</button><button type="button" class="btn btn-primary" data-v="ok">${esc(ok)}</button></div></form>`);
  return run(d, (finish) => {
    d.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => finish(b.dataset.v === 'cancel' ? null : b.dataset.v)));
    setTimeout(() => d.querySelector('[data-v="ok"]').focus(), 0);
  });
}

/* ───────── 색 고르기 ───────── */
function swatches(list, cur, name) {
  return `<div class="swatches" data-name="${name}">${list.map((c) => `<button type="button" class="sw${c.toLowerCase() === String(cur).toLowerCase() ? ' on' : ''}" data-c="${c}" style="--c:${c}" title="${c}"></button>`).join('')}
    <label class="sw sw-custom" title="다른 색"><input type="color" value="${/^#[0-9a-f]{6}$/i.test(cur) ? cur : '#000000'}"></label></div>`;
}
function bindSwatches(root, onPick) {
  root.querySelectorAll('.swatches').forEach((box) => {
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.sw[data-c]');
      if (!b) return;
      box.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b));
      onPick(box.dataset.name, b.dataset.c);
    });
    box.querySelector('input[type=color]').addEventListener('input', (e) => {
      box.querySelectorAll('.sw').forEach((x) => x.classList.remove('on'));
      e.target.parentElement.classList.add('on');
      onPick(box.dataset.name, e.target.value);
    });
  });
}
export { swatches, bindSwatches };

export function pickColor(cur, type) {
  const list = PALETTE[type === 'highlight' ? 'highlight' : type === 'note' ? 'note' : 'ink'];
  const d = makeDialog('dlg-color', `<h3>색 바꾸기</h3>${swatches(list, cur, 'c')}<div class="dlg-foot"><span class="sp"></span><button class="btn" data-v="cancel" type="button">닫기</button></div>`);
  return run(d, (finish) => {
    bindSwatches(d, (_, c) => finish(c));
    d.querySelector('[data-v=cancel]').addEventListener('click', () => finish(null));
  });
}

/* ───────── 텍스트 상자·텍스트 수정 ───────── */
export function openTextDialog(a, { title, original, editing } = {}) {
  const isReplace = a.type === 'replace';
  const fonts = Object.entries(FONT_LABEL).map(([k, v]) => `<option value="${k}"${(a.font || 'gothic') === k ? ' selected' : ''}>${v}</option>`).join('');
  const d = makeDialog('dlg-text', `<form method="dialog">
    <h3>${esc(title)}</h3>
    ${isReplace && original != null ? `<div class="orig"><span>원래 글자</span><div>${esc(original)}</div></div>` : ''}
    <textarea rows="${isReplace ? 3 : 5}" placeholder="내용 (Enter = 줄바꿈, Ctrl+Enter = 확인)">${esc(a.text)}</textarea>
    <div class="row-opts"><span class="lbl">글꼴</span><select name="font">${fonts}</select>
      <label>크기 <input name="size" type="number" min="4" max="200" step="0.5" value="${a.size}"> pt</label>
    </div>
    <div class="row-opts"><span class="lbl">글자색</span>${swatches(PALETTE.text, a.color || '#111111', 'color')}</div>
    <div class="row-opts"><span class="lbl">${isReplace ? '덮을 바탕색' : '바탕'}</span>
      ${isReplace ? `<label class="sw sw-custom bgpick" title="원래 글자를 가릴 색 (자동 추출)"><input type="color" name="bg" value="${a.bg || '#ffffff'}"></label><span class="hint">원래 글자를 이 색으로 덮고 새 글자를 씁니다</span>`
        : `<select name="bg"><option value="">없음(투명)</option><option value="#ffffff"${a.bg === '#ffffff' ? ' selected' : ''}>흰색</option><option value="#fff6b0"${a.bg === '#fff6b0' ? ' selected' : ''}>연노랑</option></select>`}
    </div>
    <div class="preview"><span></span></div>
    <div class="dlg-foot">${editing ? '<button type="button" class="btn danger" data-v="delete">삭제</button>' : ''}<span class="sp"></span>
      <button type="button" class="btn" data-v="cancel">취소</button><button type="button" class="btn btn-primary" data-v="ok">확인</button></div>
  </form>`);
  let color = a.color || '#111111';
  const ta = d.querySelector('textarea');
  const prev = d.querySelector('.preview span');
  const sync = () => {
    const font = d.querySelector('[name=font]').value;
    ensureFace(font).catch(() => {});
    prev.style.fontFamily = `'${FAMILY[font]}', sans-serif`;
    prev.style.color = color;
    const bg = d.querySelector('[name=bg]').value;
    prev.parentElement.style.background = bg || 'transparent';
    prev.textContent = ta.value || ' ';
  };
  return run(d, (finish) => {
    const collect = () => {
      const size = Math.max(4, Math.min(200, Number(d.querySelector('[name=size]').value) || a.size));
      const font = d.querySelector('[name=font]').value;
      const bg = d.querySelector('[name=bg]').value || undefined;
      if (!isReplace) { S.opts.textFont = font; S.opts.textSize = size; S.opts.textColor = color; S.opts.textBg = bg || ''; saveOpts(); }
      return { text: ta.value.replace(/\r/g, ''), font, size, color, bg };
    };
    d.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', async () => {
      const v = b.dataset.v;
      if (v === 'cancel') return finish(null);
      if (v === 'delete') return finish('delete');
      const r = collect();
      await ensureFace(r.font).catch(() => {});
      finish(r);
    }));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); d.querySelector('[data-v=ok]').click(); }
    });
    bindSwatches(d, (_, c) => { color = c; sync(); });
    d.addEventListener('input', sync);
    d.addEventListener('change', sync);
    sync();
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
  });
}

/* ───────── 메모 ───────── */
export function openNoteDialog(n, editing) {
  const d = makeDialog('dlg-note', `<form method="dialog"><h3>메모</h3>
    <textarea rows="6" placeholder="메모 내용 (Ctrl+Enter = 확인)">${esc(n.text)}</textarea>
    <div class="row-opts"><span class="lbl">색</span>${swatches(PALETTE.note, n.color, 'color')}</div>
    <div class="dlg-foot">${editing ? '<button type="button" class="btn danger" data-v="delete">삭제</button>' : ''}<span class="sp"></span>
    <button type="button" class="btn" data-v="cancel">취소</button><button type="button" class="btn btn-primary" data-v="ok">확인</button></div></form>`);
  let color = n.color;
  const ta = d.querySelector('textarea');
  return run(d, (finish) => {
    d.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.v;
      if (v === 'cancel') return finish(null);
      if (v === 'delete') return finish('delete');
      S.opts.noteColor = color; saveOpts();
      finish({ text: ta.value, color });
    }));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); d.querySelector('[data-v=ok]').click(); }
    });
    bindSwatches(d, (_, c) => { color = c; });
    setTimeout(() => ta.focus(), 0);
  });
}

/* ───────── 서명 ───────── */
export const getSigns = () => pref('signs', []);
export function saveSign(src) {
  const list = getSigns().filter((s) => s !== src);
  list.unshift(src);
  setPref('signs', list.slice(0, 8));
}
export function deleteSign(src) {
  setPref('signs', getSigns().filter((s) => s !== src));
}

/** 서명 그리기 → 투명 배경 PNG(dataUrl) */
export function openSignPad() {
  const d = makeDialog('dlg-sign', `<form method="dialog"><h3>서명 만들기</h3>
    <div class="pad-wrap"><canvas class="pad" width="1200" height="440"></canvas><div class="pad-line"></div><span class="pad-hint">여기에 서명하세요</span></div>
    <div class="row-opts"><span class="lbl">색</span>${swatches(['#111111', '#1e3fa8', '#c62828'], '#111111', 'color')}
      <label class="file-btn">🖼 이미지로 불러오기<input type="file" accept="image/*" hidden></label></div>
    <label class="chk"><input type="checkbox" name="keep" checked> 서명 목록에 저장</label>
    <div class="dlg-foot"><button type="button" class="btn" data-v="clear">지우기</button><span class="sp"></span>
    <button type="button" class="btn" data-v="cancel">취소</button><button type="button" class="btn btn-primary" data-v="ok">사용</button></div></form>`);
  const cv = d.querySelector('canvas');
  const ctx = cv.getContext('2d');
  let color = '#111111';
  let strokes = [];
  let cur = null;
  let image = null; // 불러온 이미지 (배경 제거 후)
  const redraw = () => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (image) {
      const k = Math.min(cv.width / image.width, cv.height / image.height) * 0.9;
      ctx.drawImage(image, (cv.width - image.width * k) / 2, (cv.height - image.height * k) / 2, image.width * k, image.height * k);
    }
    ctx.fillStyle = color;
    for (const s of [...strokes, ...(cur ? [cur] : [])]) {
      const outline = getStroke(s, { size: 9, thinning: 0.6, smoothing: 0.5, streamline: 0.5, simulatePressure: !s.some((p) => p[2] !== 0.5), last: s !== cur });
      ctx.fill(new Path2D(pathFromOutline(outline)));
    }
    d.querySelector('.pad-hint').hidden = strokes.length > 0 || !!cur || !!image;
  };
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height), e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5];
  };
  cv.addEventListener('pointerdown', (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); cur = [pos(e)]; redraw(); });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) return;
    for (const ev of e.getCoalescedEvents?.() || [e]) cur.push(pos(ev));
    redraw();
  });
  const up = () => { if (cur) { strokes.push(cur); cur = null; redraw(); } };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  d.querySelector('input[type=file]').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    image = await removeWhite(f);
    strokes = [];
    redraw();
  });
  return run(d, (finish) => {
    bindSwatches(d, (_, c) => { color = c; redraw(); });
    d.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.v;
      if (v === 'cancel') return finish(null);
      if (v === 'clear') { strokes = []; image = null; redraw(); return; }
      const src = trimCanvas(cv);
      if (!src) return toast('서명을 먼저 그려 주세요.');
      if (d.querySelector('[name=keep]').checked) saveSign(src);
      finish(src);
    }));
    redraw();
  });
}

/** 그린 부분만 잘라 PNG로 (최대 너비 640px) */
function trimCanvas(cv) {
  const ctx = cv.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height);
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return null;
  const pad = 6;
  x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad); x2 = Math.min(width - 1, x2 + pad); y2 = Math.min(height - 1, y2 + pad);
  const w = x2 - x1 + 1, h = y2 - y1 + 1;
  const k = Math.min(1, 640 / w);
  const out = document.createElement('canvas');
  out.width = Math.round(w * k); out.height = Math.round(h * k);
  out.getContext('2d').drawImage(cv, x1, y1, w, h, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** 사진 속 흰 바탕을 투명하게 */
async function removeWhite(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const p = img.data;
  for (let i = 0; i < p.length; i += 4) {
    const L = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    if (L > 200) p[i + 3] = 0;
    else if (L > 150) p[i + 3] = Math.round(p[i + 3] * (200 - L) / 50);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

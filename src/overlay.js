// 주석을 쪽 위에 그림 (SVG, PDF 좌표 그대로 → viewport.transform으로 화면에 맞춤)
import { S, on } from './state.js';
import { pageEl, rectCss } from './viewer.js';
import { bbox } from './annots.js';
import { strokeOutline, smoothSegments, lines, LINE_GAP } from './pdfwrite.js';
import { FAMILY, ensureFace, faceReady } from './fonts.js';

const NS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function pathFromOutline(poly) {
  if (poly.length < 3) return '';
  const [st, ...segs] = smoothSegments(poly);
  let d = `M${st[0].toFixed(2)} ${st[1].toFixed(2)}`;
  for (const s of segs) d += `C${s.map((v) => v.toFixed(2)).join(' ')}`;
  return `${d}Z`;
}

export function annotSvg(a) {
  switch (a.type) {
    case 'highlight':
      return `<g data-id="${a.id}" class="a-hl" style="mix-blend-mode:multiply" fill="${a.color}" fill-opacity="${a.opacity ?? 0.4}">${a.rects
        .map((r) => `<rect x="${r[0]}" y="${r[1]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}"/>`).join('')}</g>`;
    case 'ink': {
      const d = a.strokes.map((s) => pathFromOutline(strokeOutline(s, a.width, a.marker))).join('');
      const blend = a.marker ? 'mix-blend-mode:multiply' : '';
      return `<path data-id="${a.id}" d="${d}" fill="${a.color}" fill-opacity="${a.opacity ?? 1}" style="${blend}"/>`;
    }
    case 'note': {
      const x = a.x, y = a.y - 22;
      return `<g data-id="${a.id}" class="a-note"><title>${esc(a.text)}</title>
        <rect x="${x + 1}" y="${y + 1}" width="20" height="20" fill="${a.color || '#ffd54a'}" stroke="#5a4d1a" stroke-width="0.8"/>
        <path d="M${x + 5} ${y + 15}H${x + 17}M${x + 5} ${y + 11}H${x + 17}M${x + 5} ${y + 7}H${x + 13}" stroke="#5a4d1a" stroke-width="1.2" stroke-linecap="round"/></g>`;
    }
    case 'text':
    case 'replace': {
      if (!faceReady(a.font || 'gothic')) ensureFace(a.font || 'gothic').then(() => redrawPage(a.page)).catch(() => {});
      let cover = '';
      if (a.type === 'replace') {
        cover = (a.cover || []).map((r) => `<rect x="${r[0] - 0.5}" y="${r[1] - 0.5}" width="${r[2] - r[0] + 1}" height="${r[3] - r[1] + 1}" fill="${a.bg || '#ffffff'}"/>`).join('');
      } else if (a.bg) {
        const b = bbox(a);
        cover = `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="${a.bg}"/>`;
      }
      const asc = a.size * 0.88;
      const ts = lines(a.text).map((l, i) => `<tspan x="0" y="${asc + i * a.size * LINE_GAP}">${esc(l) || ' '}</tspan>`).join('');
      return `<g data-id="${a.id}">${cover}<g transform="translate(${a.x} ${a.y}) scale(1 -1)"><text font-family="'${FAMILY[a.font || 'gothic']}', sans-serif" font-size="${a.size}" fill="${a.color || '#111'}" style="white-space:pre;font-kerning:none">${ts}</text></g></g>`;
    }
    case 'sign':
      return `<g data-id="${a.id}" transform="translate(${a.x} ${a.y}) scale(1 -1)"><image href="${a.src}" x="0" y="0" width="${a.w}" height="${a.h}" preserveAspectRatio="none"/></g>`;
    default:
      return '';
  }
}

export function redrawPage(i) {
  const el = pageEl(i);
  if (!el) return;
  const p = S.pages[i];
  const svg = el.querySelector('svg.ov');
  const w = p.vp.width, h = p.vp.height;
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const t = p.vp.transform;
  const body = S.annots.filter((a) => a.page === i).map(annotSvg).join('');
  svg.innerHTML = `<g transform="matrix(${t.join(' ')})">${body}<g class="live"></g></g>`;
  drawSelection(i);
}

export function redrawAll() {
  S.pages.forEach((_, i) => redrawPage(i));
}

/** 그리는 중인 획 미리 보기 */
export function liveLayer(i) {
  return pageEl(i)?.querySelector('svg.ov g.live');
}
export function setLive(i, html) {
  const g = liveLayer(i);
  if (g) g.innerHTML = html;
}

/* ───────── 선택 표시 ───────── */
function drawSelection(i) {
  const ui = pageEl(i)?.querySelector('.ui');
  if (!ui) return;
  ui.replaceChildren();
  const a = S.selected && S.annots.find((x) => x.id === S.selected);
  if (!a || a.page !== i) return;
  const r = rectCss(i, bbox(a));
  const box = document.createElement('div');
  box.className = 'sel-box';
  Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  box.dataset.id = a.id;
  const resizable = a.type === 'sign' || a.type === 'text' || a.type === 'replace';
  const editable = a.type === 'note' || a.type === 'text' || a.type === 'replace';
  box.innerHTML = `${resizable ? '<span class="handle" data-h="se"></span>' : ''}
    <div class="sel-bar">${editable ? '<button data-act="edit" title="내용 고치기">✎ 편집</button>' : ''}${a.type === 'highlight' || a.type === 'ink' || a.type === 'note' ? '<button data-act="color" title="색 바꾸기">● 색</button>' : ''}<button data-act="dup" title="복제">⧉</button><button data-act="del" title="삭제 (Delete)">🗑</button></div>`;
  ui.appendChild(box);
}

on('annots', redrawAll);
on('annot-live', (id) => { const a = S.annots.find((x) => x.id === id); if (a) redrawPage(a.page); });
on('select', redrawAll);
on('layout', redrawAll);

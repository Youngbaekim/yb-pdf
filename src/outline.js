// 책갈피(목차): 왼쪽 메뉴 '책갈피' 탭에 나무 모양으로 표시
// - 처음에는 1단계만 펼침, ▸ 를 눌러 하위 항목 펼치기
// - 항목을 누르면 그 위치로 이동, 지금 보는 쪽에 해당하는 항목을 강조
import { S, on } from './state.js';
import { goTo } from './viewer.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cache = new WeakMap(); // pdf → { nodes, flat }
let builtFor = null;
let visible = () => false;

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

async function load(pdf) {
  if (cache.has(pdf)) return cache.get(pdf);
  const raw = (await pdf.getOutline().catch(() => null)) || [];
  const flat = [];
  let id = 0;
  const walk = async (items, depth, parent) => Promise.all(items.map(async (it) => {
    const n = { id: id++, title: (it.title || '').trim() || '(제목 없음)', depth, parent, bold: it.bold, italic: it.italic, color: it.color, url: it.url, kids: [], open: false };
    n.dest = it.dest ? await resolveDest(pdf, it.dest) : null;
    n.kids = it.items?.length ? await walk(it.items, depth + 1, n) : [];
    return n;
  }));
  const nodes = await walk(raw, 0, null);
  const visit = (list) => list.forEach((n) => { flat.push(n); visit(n.kids); });
  visit(nodes);
  const byId = new Map(flat.map((n) => [n.id, n]));
  const data = { nodes, flat, byId };
  cache.set(pdf, data);
  return data;
}

function rowHtml(n) {
  const has = n.kids.length > 0;
  const page = n.dest ? n.dest.page + 1 : '';
  const col = n.color && (n.color[0] || n.color[1] || n.color[2]) ? ` style="color:rgb(${n.color.join(',')})"` : '';
  return `<div class="ol-node" data-id="${n.id}">
    <div class="ol-row" style="--d:${n.depth}" data-id="${n.id}" title="${esc(n.title)}${page ? ` (${page}쪽)` : ''}">
      <button class="ol-tw${has ? '' : ' leaf'}" data-tw="${n.id}" tabindex="-1" aria-label="펼치기">${has ? (n.open ? '▾' : '▸') : ''}</button>
      <span class="ol-t${n.bold ? ' b' : ''}${n.italic ? ' i' : ''}"${col}>${esc(n.title)}</span>
      <span class="ol-p">${page}</span>
    </div>
    ${has && n.open ? `<div class="ol-kids">${n.kids.map(rowHtml).join('')}</div>` : ''}
  </div>`;
}

async function render() {
  const box = document.getElementById('outline');
  if (!S.pdf) { box.innerHTML = '<p class="muted">문서를 열면 책갈피가 여기에 표시됩니다.</p>'; builtFor = null; return; }
  const pdf = S.pdf;
  if (builtFor !== pdf) box.innerHTML = '<p class="muted">책갈피를 읽는 중…</p>';
  const data = await load(pdf);
  if (pdf !== S.pdf) return;
  builtFor = pdf;
  if (!data.nodes.length) { box.innerHTML = '<p class="muted">이 문서에는 책갈피가 없습니다.</p>'; return; }
  const all = data.flat.length;
  box.innerHTML = `<div class="ol-bar"><span>${all}개</span><span class="sp"></span><button data-ol="open">모두 펼치기</button><button data-ol="close">1단계만</button></div>${data.nodes.map(rowHtml).join('')}`;
  markCurrent();
}

/** 지금 보는 쪽의 항목 강조 (접혀 있으면 보이는 가장 가까운 상위 항목) */
function markCurrent() {
  const box = document.getElementById('outline');
  const data = S.pdf && cache.get(S.pdf);
  if (!data || !box) return;
  let cur = null;
  for (const n of data.flat) if (n.dest && n.dest.page <= S.current) cur = n; // 문서 순서상 지금 쪽 이전의 마지막 항목
  while (cur && !box.querySelector(`.ol-row[data-id="${cur.id}"]`)) cur = cur.parent;
  box.querySelectorAll('.ol-row.on').forEach((r) => r.classList.remove('on'));
  const row = cur && box.querySelector(`.ol-row[data-id="${cur.id}"]`);
  if (row) { row.classList.add('on'); row.scrollIntoView({ block: 'nearest' }); }
}

export function initOutline(isVisible) {
  visible = isVisible;
  const box = document.getElementById('outline');
  box.addEventListener('click', (e) => {
    const data = S.pdf && cache.get(S.pdf);
    if (!data) return;
    const bar = e.target.closest('[data-ol]');
    if (bar) { const open = bar.dataset.ol === 'open'; data.flat.forEach((n) => { n.open = open && n.kids.length > 0; }); render(); return; }
    const tw = e.target.closest('[data-tw]');
    const row = e.target.closest('.ol-row');
    const n = row && data.byId.get(Number(row.dataset.id));
    if (!n) return;
    if (tw && n.kids.length) { n.open = !n.open; render(); return; }
    if (n.dest) {
      goTo(n.dest.page, n.dest.y != null ? { x: n.dest.x ?? 0, y: n.dest.y } : {});
      box.querySelectorAll('.ol-row.on').forEach((r) => r.classList.remove('on'));
      e.target.closest('.ol-row')?.classList.add('on');
    } else if (n.kids.length) { n.open = !n.open; render(); }
  });
  box.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.ol-row');
    const data = S.pdf && cache.get(S.pdf);
    const n = row && data?.byId.get(Number(row.dataset.id));
    if (n?.kids.length) { n.open = !n.open; render(); }
  });
  on('current', () => { if (visible()) markCurrent(); });
  on('doc', () => { builtFor = null; if (visible()) render(); });
}
export const showOutline = () => render();
/** 책갈피가 있는지 (탭 표시용) */
export async function outlineCount(pdf) { return pdf ? (await load(pdf)).flat.length : 0; }

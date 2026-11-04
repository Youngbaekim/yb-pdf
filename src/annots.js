// 주석 모델: 추가·수정·삭제·실행 취소
import { S, emit } from './state.js';
import { bbox as rawBBox } from './pdfwrite.js';
import { measure } from './fonts.js';

let undoStack = [];
let redoStack = [];
const LIMIT = 200;

export const bbox = (a) => rawBBox(a, measure);

function commit(next) {
  undoStack.push(S.annots);
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack = [];
  S.annots = next;
  markDirty();
  emit('annots');
}

export function markDirty() {
  if (!S.dirty) { S.dirty = true; emit('dirty'); }
}

export function resetHistory(list) {
  undoStack = [];
  redoStack = [];
  S.annots = list;
  S.selected = null;
  emit('annots');
}

/** 탭을 바꿀 때 문서별 실행 취소 기록을 보관·복원 */
export const getHistory = () => ({ undo: undoStack, redo: redoStack });
export function setHistory(h) {
  undoStack = h?.undo || [];
  redoStack = h?.redo || [];
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(S.annots);
  S.annots = undoStack.pop();
  if (S.selected && !S.annots.some((a) => a.id === S.selected)) S.selected = null;
  markDirty();
  emit('annots');
}
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(S.annots);
  S.annots = redoStack.pop();
  if (S.selected && !S.annots.some((a) => a.id === S.selected)) S.selected = null;
  markDirty();
  emit('annots');
}

export const find = (id) => S.annots.find((a) => a.id === id);

export function add(a) { commit([...S.annots, a]); }
export function update(id, patch) {
  commit(S.annots.map((a) => (a.id === id ? { ...a, ...patch } : a)));
}
export function remove(ids) {
  const set = new Set([].concat(ids));
  if (S.selected && set.has(S.selected)) S.selected = null;
  commit(S.annots.filter((a) => !set.has(a.id)));
}
/** 끌어서 옮기는 동안에는 기록 없이 바꾸고, 끝날 때 한 번에 기록 */
export function replaceSilently(id, next) {
  S.annots = S.annots.map((a) => (a.id === id ? next : a));
  emit('annot-live', id);
}
export function commitFrom(prevList) {
  undoStack.push(prevList);
  redoStack = [];
  markDirty();
  emit('annots');
}

/** 주석을 (dx, dy)만큼 옮긴 새 객체 */
export function translate(a, dx, dy) {
  const mv = (r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
  switch (a.type) {
    case 'highlight': return { ...a, rects: a.rects.map(mv) };
    case 'ink': return { ...a, strokes: a.strokes.map((s) => s.map((p) => [p[0] + dx, p[1] + dy, p[2]])) };
    case 'replace': return { ...a, x: a.x + dx, y: a.y + dy, cover: (a.cover || []).map(mv) };
    default: return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

/** 점(pdf 좌표)이 주석 위에 있는지 */
export function hit(a, x, y, tol) {
  if (a.type === 'highlight') return a.rects.some((r) => x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol);
  if (a.type === 'ink') {
    const lim = a.width / 2 + tol;
    for (const s of a.strokes) {
      if (s.length === 1 && Math.hypot(s[0][0] - x, s[0][1] - y) <= lim) return true;
      for (let i = 1; i < s.length; i++) if (distSeg(x, y, s[i - 1], s[i]) <= lim) return true;
    }
    return false;
  }
  const b = bbox(a);
  return x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol;
}
function distSeg(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  let t = l2 ? ((px - a[0]) * vx + (py - a[1]) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

/** 쪽 위의 맨 위 주석 */
export function topHit(page, x, y, tol) {
  for (let i = S.annots.length - 1; i >= 0; i--) {
    const a = S.annots[i];
    if (a.page === page && hit(a, x, y, tol)) return a;
  }
  return null;
}

export const TYPE_LABEL = { highlight: '형광펜', ink: '펜', note: '메모', text: '텍스트 상자', replace: '텍스트 수정', sign: '서명' };

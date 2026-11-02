// 앱 전체가 함께 쓰는 상태와 간단한 알림(구독) 장치
export const BASE = import.meta.env.BASE_URL; // '/yb-pdf/'

const subs = new Map();
export function on(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt).delete(fn);
}
export function emit(evt, data) {
  for (const fn of subs.get(evt) || []) {
    try { fn(data); } catch (e) { console.error(e); }
  }
}

/** 기기에 기억하는 설정 */
export function pref(key, def) {
  try {
    const v = localStorage.getItem(`ybpdf-${key}`);
    return v == null ? def : JSON.parse(v);
  } catch { return def; }
}
export function setPref(key, val) {
  try { localStorage.setItem(`ybpdf-${key}`, JSON.stringify(val)); } catch { /* 무시 */ }
}

export const S = {
  // 문서
  pdf: null, // pdf.js 문서
  pages: [], // [{ w, h, rotate, view:[x1,y1,x2,y2], vp: 현재 배율의 viewport }]
  fileName: '',
  fileHandle: null,
  fileSize: 0,
  cleanBytes: null, // YB 주석을 떼어 낸 원본
  readOnly: false,
  readOnlyReason: '',
  dirty: false,
  // 주석
  annots: [], // 불변 객체 배열 (고칠 때는 새 객체로 바꿔 넣음)
  selected: null, // 선택한 주석 id
  // 보기
  scale: 1,
  zoomMode: pref('zoom', 'width'), // 'width' | 'page' | 숫자(배율)
  spread: pref('spread', 1), // 1 | 2
  coverAlone: pref('cover', true), // 2쪽 보기에서 첫 쪽(표지) 단독
  current: 0, // 지금 보는 쪽 (0부터)
  // 도구
  tool: 'select',
  opts: pref('opts', {
    hlColor: '#ffe14d', hlOpacity: 0.4,
    penColor: '#d32f2f', penWidth: 2.4, penOpacity: 1,
    noteColor: '#ffd54a',
    textFont: 'gothic', textSize: 12, textColor: '#111111', textBg: '',
    fingerDraw: false,
    signWidth: 140,
  }),
  signArmed: null, // 서명 도구에서 고른 서명 (dataUrl)
};

export function saveOpts() { setPref('opts', S.opts); }

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

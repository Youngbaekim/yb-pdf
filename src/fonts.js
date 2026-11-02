// 글자 상자용 한글 글꼴 (나눔 글꼴, SIL OFL)
// - 화면: FontFace로 같은 파일을 불러와 표시 → PDF에 넣었을 때와 모양·폭이 같음
// - PDF: 쓰인 글자만 추출한 작은 글꼴을 넣음 (subset.js)
import { BASE } from './state.js';
import { FONT_FILES } from './pdfwrite.js';
import { subsetFont } from './subset.js';

export const FAMILY = { gothic: 'YBPDF Gothic', myeongjo: 'YBPDF Myeongjo', pen: 'YBPDF Pen' };
const bytesCache = {};
const faceCache = {};

export function fontBytes(key) {
  if (!bytesCache[key]) {
    bytesCache[key] = fetch(`${BASE}fonts/${FONT_FILES[key]}`).then((r) => {
      if (!r.ok) throw new Error(`글꼴을 불러오지 못했습니다 (${FONT_FILES[key]})`);
      return r.arrayBuffer();
    }).then((b) => new Uint8Array(b));
  }
  return bytesCache[key];
}

/** 화면 표시용 글꼴 준비 (처음 한 번만 내려받음) */
export function ensureFace(key) {
  if (!faceCache[key]) {
    faceCache[key] = fontBytes(key).then(async (b) => {
      const face = new FontFace(FAMILY[key], b.buffer.slice(0));
      await face.load();
      document.fonts.add(face);
      return face;
    }).catch((e) => { delete faceCache[key]; throw e; });
  }
  return faceCache[key];
}
export const faceReady = (key) => !!faceCache[key];

const cv = document.createElement('canvas').getContext('2d');
/** 글자 폭(pt). 글꼴이 아직 없으면 대략 계산 */
export function measure(text, key, size) {
  cv.font = `${size}px "${FAMILY[key] || FAMILY.gothic}", sans-serif`;
  return cv.measureText(text).width;
}

let wasm = null;
const loadWasm = () => (wasm ||= fetch(`${BASE}wasm/harfbuzz-subset.wasm`).then((r) => r.arrayBuffer()));

/** 저장할 때: 쓰인 글자만 남긴 글꼴 */
export async function subsetFor(key, text) {
  const full = await fontBytes(key);
  try {
    return await subsetFont(full, text, loadWasm);
  } catch (e) {
    console.warn('글꼴 부분 추출 실패 → 전체 글꼴 사용', e);
    return full;
  }
}

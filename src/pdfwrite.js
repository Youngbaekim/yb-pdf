// PDF 읽기·쓰기 (pdf-lib)
// 저장 방식: YB-PDF의 주석은 표준 PDF 주석(Highlight·Ink·Text·FreeText·Stamp)으로 기록
//  - 각 주석에 외형(Appearance Stream)을 직접 그려 넣으므로 Acrobat·Edge·크롬 등 다른 뷰어에서도 같은 모양으로 보임
//  - 주석마다 /YBPDF 키에 원본 데이터(JSON)를 함께 넣어, YB-PDF로 다시 열면 그대로 고치거나 지울 수 있음
//  - 열 때는 YB 주석을 문서에서 떼어 내어(관련 객체까지 삭제) '깨끗한 원본'으로 보관 → 저장할 때마다 다시 붙임
import {
  PDFDocument, PDFName, PDFHexString, PDFString, PDFArray, PDFDict, PDFRef, PDFStream, PDFNumber,
  pushGraphicsState, popGraphicsState, setFillingRgbColor, rectangle, fill, moveTo, lineTo, closePath,
  appendBezierCurve, beginText, endText, setFontAndSize, moveText, showText, setGraphicsState,
  concatTransformationMatrix, drawObject, setStrokingRgbColor, setLineWidth, stroke, setLineCap, setLineJoin,
  LineCapStyle, LineJoinStyle,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getStroke } from 'perfect-freehand';

export const YB_KEY = 'YBPDF';
const N = (s) => PDFName.of(s);

/* ───────── 색 ───────── */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}

/* ───────── 펜 획 외곽선 (화면·PDF 공용) ───────── */
export function strokeOutline(points, width, isMarker) {
  return getStroke(points, {
    size: width,
    thinning: isMarker ? 0 : 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !points.some((p) => p[2] && p[2] !== 0.5),
    last: true,
    start: { cap: true },
    end: { cap: true },
  });
}

/** 외곽선 점 → 부드러운 닫힌 곡선 (중점을 잇고 점을 제어점으로 하는 2차 곡선을 3차로 변환) */
export function smoothSegments(poly) {
  const n = poly.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(poly[0], poly[1]);
  const out = [start];
  let cur = start;
  for (let i = 1; i <= n; i++) {
    const c = poly[i % n];
    const e = mid(c, poly[(i + 1) % n]);
    out.push([cur[0] + (2 / 3) * (c[0] - cur[0]), cur[1] + (2 / 3) * (c[1] - cur[1]), e[0] + (2 / 3) * (c[0] - e[0]), e[1] + (2 / 3) * (c[1] - e[1]), e[0], e[1]]);
    cur = e;
  }
  return out;
}

/* ───────── 글자 상자 줄 나누기 (사용자가 넣은 줄바꿈만 사용) ───────── */
export const lines = (text) => String(text ?? '').replace(/\r/g, '').split('\n');
export const LINE_GAP = 1.25; // 줄 간격 = 글자 크기 × 1.25

/* ───────── 주석의 사각 범위 [x1,y1,x2,y2] (PDF 좌표) ───────── */
export function bbox(a, measure) {
  switch (a.type) {
    case 'highlight': {
      const xs = a.rects.flatMap((r) => [r[0], r[2]]);
      const ys = a.rects.flatMap((r) => [r[1], r[3]]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    case 'ink': {
      const pts = a.strokes.flat();
      const pad = a.width;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    }
    case 'note':
      return [a.x, a.y - 22, a.x + 22, a.y];
    case 'text':
    case 'replace': {
      const ls = lines(a.text);
      const w = Math.max(4, ...ls.map((l) => measure(l, a.font, a.size)));
      const h = ls.length * a.size * LINE_GAP;
      const tb = [a.x - 2, a.y - h - 2, a.x + w + 2, a.y + 2];
      if (a.type === 'replace' && a.cover?.length) {
        const c = bbox({ type: 'highlight', rects: a.cover });
        return [Math.min(tb[0], c[0]), Math.min(tb[1], c[1]), Math.max(tb[2], c[2]), Math.max(tb[3], c[3])];
      }
      return tb;
    }
    case 'sign':
      return [a.x, a.y - a.h, a.x + a.w, a.y];
    default:
      return [0, 0, 0, 0];
  }
}

/* ───────── 열기: YB 주석 떼어 내기 ───────── */
function collectRefs(ctx, obj, out) {
  if (obj instanceof PDFRef) {
    if (out.has(obj.tag)) return;
    out.set(obj.tag, obj);
    collectRefs(ctx, ctx.lookup(obj), out);
  } else if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      const key = k.asString();
      if (key === '/P' || key === '/Parent' || key === '/Popup') continue; // 쪽·부모는 건드리지 않음
      collectRefs(ctx, v, out);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) collectRefs(ctx, obj.get(i), out);
  } else if (obj instanceof PDFStream) {
    collectRefs(ctx, obj.dict, out);
  }
}

/** 어디에서도 가리키지 않는 객체 정리 (저장을 거듭해도 파일이 불어나지 않도록) */
function collectGarbage(ctx) {
  const seen = new Set();
  const walk = (o) => {
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) return;
      seen.add(o.tag);
      walk(ctx.lookup(o));
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) walk(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) walk(o.get(i));
    } else if (o instanceof PDFStream) {
      walk(o.dict);
    }
  };
  const t = ctx.trailerInfo;
  [t.Root, t.Info, t.Encrypt, t.ID].forEach((x) => x && walk(x));
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

/**
 * @returns {{ annots: object[], cleanBytes: Uint8Array, encrypted: boolean, pageCount: number }}
 */
export async function importPdf(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) return { annots: [], cleanBytes: bytes, encrypted: true, pageCount: doc.getPageCount() };
  const ctx = doc.context;
  const annots = [];
  const kill = new Map();
  doc.getPages().forEach((page, pi) => {
    const arr = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (!arr) return;
    for (let i = arr.size() - 1; i >= 0; i--) {
      const ref = arr.get(i);
      const dict = ctx.lookupMaybe(ref, PDFDict);
      const raw = dict?.get(N(YB_KEY));
      if (!raw) continue;
      try {
        const a = JSON.parse(raw.decodeText());
        a.page = pi;
        annots.push(a);
      } catch { /* 손상된 데이터는 건너뜀 */ }
      arr.remove(i);
      if (ref instanceof PDFRef) collectRefs(ctx, ref, kill);
    }
    if (arr.size() === 0) page.node.delete(N('Annots'));
  });
  if (!annots.length) return { annots, cleanBytes: bytes, encrypted: false, pageCount: doc.getPageCount() };
  for (const ref of kill.values()) ctx.delete(ref);
  collectGarbage(ctx);
  annots.sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const cleanBytes = await doc.save({ updateFieldAppearances: false });
  return { annots, cleanBytes, encrypted: false, pageCount: doc.getPageCount() };
}

/* ───────── 저장: 주석을 PDF에 기록 ───────── */
const FONT_FILES = { gothic: 'NanumGothic-Regular.ttf', myeongjo: 'NanumMyeongjo-Regular.ttf', pen: 'NanumPenScript-Regular.ttf' };
export const FONT_LABEL = { gothic: '나눔고딕', myeongjo: '나눔명조', pen: '나눔손글씨 펜' };
export { FONT_FILES };

function dataUrlToBytes(url) {
  const b64 = url.split(',')[1];
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/**
 * @param {Uint8Array} cleanBytes  YB 주석이 없는 원본
 * @param {object[]} annots        모델
 * @param {(key:string, text:string)=>Promise<Uint8Array>} loadFont  쓰인 글자(text)만 남긴 글꼴 바이트를 돌려줌
 */
export async function exportPdf(cleanBytes, annots, loadFont) {
  const doc = await PDFDocument.load(cleanBytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const ctx = doc.context;
  const pages = doc.getPages();
  const fonts = {};
  const used = {};
  for (const a of annots) if (a.type === 'text' || a.type === 'replace') used[a.font || 'gothic'] = (used[a.font || 'gothic'] || '') + a.text;
  const getFont = async (key) => {
    if (!fonts[key]) fonts[key] = await doc.embedFont(await loadFont(key, used[key] || ''), { subset: false });
    return fonts[key];
  };
  const gsCache = {};
  const gs = (opacity, multiply) => {
    const k = `${opacity}|${multiply}`;
    if (!gsCache[k]) {
      const d = { Type: 'ExtGState', ca: opacity, CA: opacity };
      if (multiply) d.BM = 'Multiply';
      gsCache[k] = ctx.register(ctx.obj(d));
    }
    return gsCache[k];
  };

  let z = 0;
  for (const a of annots) {
    const page = pages[a.page];
    if (!page) continue;
    z++;
    let ops = [];
    const res = {};
    let subtype = 'Square';
    const extra = {};
    let rect;

    if (a.type === 'highlight') {
      subtype = 'Highlight';
      const [r, g, b] = hexToRgb(a.color);
      res.ExtGState = { G0: gs(a.opacity ?? 0.4, true) };
      ops.push(pushGraphicsState(), setGraphicsState('G0'), setFillingRgbColor(r, g, b));
      for (const q of a.rects) ops.push(rectangle(q[0], q[1], q[2] - q[0], q[3] - q[1]));
      ops.push(fill(), popGraphicsState());
      extra.QuadPoints = a.rects.flatMap((q) => [q[0], q[3], q[2], q[3], q[0], q[1], q[2], q[1]]);
      extra.C = [r, g, b];
      extra.CA = a.opacity ?? 0.4;
      rect = bbox(a);
    } else if (a.type === 'ink') {
      subtype = 'Ink';
      const [r, g, b] = hexToRgb(a.color);
      res.ExtGState = { G0: gs(a.opacity ?? 1, !!a.marker) };
      ops.push(pushGraphicsState(), setGraphicsState('G0'), setFillingRgbColor(r, g, b));
      for (const s of a.strokes) {
        const poly = strokeOutline(s, a.width, a.marker);
        if (poly.length < 3) continue;
        const [st, ...segs] = smoothSegments(poly);
        ops.push(moveTo(st[0], st[1]));
        for (const [c1x, c1y, c2x, c2y, ex, ey] of segs) ops.push(appendBezierCurve(c1x, c1y, c2x, c2y, ex, ey));
        ops.push(closePath());
      }
      ops.push(fill(), popGraphicsState());
      extra.InkList = a.strokes.map((s) => s.flatMap((p) => [p[0], p[1]]));
      extra.C = [r, g, b];
      extra.CA = a.opacity ?? 1;
      extra.BS = { W: a.width, S: 'S' };
      rect = bbox(a);
    } else if (a.type === 'note') {
      subtype = 'Text';
      const [r, g, b] = hexToRgb(a.color || '#ffd54a');
      const x = a.x, y = a.y - 22;
      ops.push(
        pushGraphicsState(), setFillingRgbColor(r, g, b), setStrokingRgbColor(0.35, 0.3, 0.1), setLineWidth(0.8),
        rectangle(x + 1, y + 1, 20, 20), fill(),
        rectangle(x + 1, y + 1, 20, 20), stroke(),
        setStrokingRgbColor(0.35, 0.3, 0.1), setLineWidth(1.2), setLineCap(LineCapStyle.Round),
        moveTo(x + 5, y + 15), lineTo(x + 17, y + 15), stroke(),
        moveTo(x + 5, y + 11), lineTo(x + 17, y + 11), stroke(),
        moveTo(x + 5, y + 7), lineTo(x + 13, y + 7), stroke(),
        popGraphicsState(),
      );
      extra.Name = 'Comment';
      extra.C = [r, g, b];
      extra.Open = false;
      rect = [x, y, x + 22, y + 22];
    } else if (a.type === 'text' || a.type === 'replace') {
      subtype = 'FreeText';
      const font = await getFont(a.font || 'gothic');
      const measure = (l, _f, size) => font.widthOfTextAtSize(l, size);
      rect = bbox(a, measure);
      res.Font = { F1: font.ref };
      if (a.type === 'replace' && a.cover?.length) {
        const [r, g, b] = hexToRgb(a.bg || '#ffffff');
        ops.push(pushGraphicsState(), setFillingRgbColor(r, g, b));
        for (const q of a.cover) ops.push(rectangle(q[0] - 0.5, q[1] - 0.5, q[2] - q[0] + 1, q[3] - q[1] + 1));
        ops.push(fill(), popGraphicsState());
      } else if (a.bg) {
        const [r, g, b] = hexToRgb(a.bg);
        ops.push(pushGraphicsState(), setFillingRgbColor(r, g, b), rectangle(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]), fill(), popGraphicsState());
      }
      const [r, g, b] = hexToRgb(a.color || '#000000');
      ops.push(pushGraphicsState(), beginText(), setFontAndSize('F1', a.size), setFillingRgbColor(r, g, b));
      const ls = lines(a.text);
      const asc = a.size * 0.88; // 첫 줄 기준선 = 위쪽에서 글자 크기의 약 0.88
      let px = 0, py = 0;
      ls.forEach((l, i) => {
        const tx = a.x, ty = a.y - asc - i * a.size * LINE_GAP;
        ops.push(moveText(tx - px, ty - py));
        px = tx; py = ty;
        if (l) ops.push(showText(font.encodeText(l)));
      });
      ops.push(endText(), popGraphicsState());
      extra.DA = PDFString.of(`/Helv ${a.size} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      extra.IT = a.type === 'replace' ? 'FreeTextTypeWriter' : 'FreeText';
    } else if (a.type === 'sign') {
      subtype = 'Stamp';
      const img = await doc.embedPng(dataUrlToBytes(a.src));
      res.XObject = { Im0: img.ref };
      ops.push(pushGraphicsState(), concatTransformationMatrix(a.w, 0, 0, a.h, a.x, a.y - a.h), drawObject('Im0'), popGraphicsState());
      extra.Name = 'YBSignature';
      rect = bbox(a);
    } else continue;

    const ap = ctx.formXObject(ops, { BBox: rect, Matrix: [1, 0, 0, 1, 0, 0], Resources: res });
    const apRef = ctx.register(ap);
    const data = { ...a };
    delete data.page;
    data.z = z;
    const contents = a.type === 'note' || a.type === 'text' || a.type === 'replace' ? a.text : '';
    const dict = ctx.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: rect,
      F: 4,
      NM: PDFString.of(`ybpdf-${a.id}`),
      M: PDFString.of(pdfDate(new Date())),
      T: PDFHexString.fromText('YB-PDF'),
      ...extra,
      AP: { N: apRef },
    });
    if (contents) dict.set(N('Contents'), PDFHexString.fromText(contents));
    dict.set(N(YB_KEY), PDFHexString.fromText(JSON.stringify(data)));
    // page.node.addAnnot()은 쪽 내용을 q/Q로 감싸 저장할 때마다 중첩되므로 /Annots 배열을 직접 다룸
    let arr = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (!arr) { arr = ctx.obj([]); page.node.set(N('Annots'), arr); }
    arr.push(ctx.register(dict));
  }
  return doc.save({ updateFieldAppearances: false });
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ───────── 병합 ───────── */
/** @param {Uint8Array[]} list */
export async function mergePdfs(list) {
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    if (src.isEncrypted) throw new Error('암호가 걸린 PDF는 병합할 수 없습니다.');
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

export { PDFNumber, LineJoinStyle, setLineJoin };

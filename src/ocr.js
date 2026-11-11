// 글자 인식(OCR) — 그림으로 된 글자를 읽어 찾기에 쓰도록 (tesseract.js, 한글+영문, 인터넷 없이 동작)
// 필요할 때(찾기 창에서 켤 때)만 불러오고, 찾기 창을 닫으면 정리
import { BASE } from './state.js';

const abs = (p) => new URL(`${BASE}${p}`, location.href).href;
let workerP = null;

function getWorker(onProgress) {
  if (!workerP) {
    workerP = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker(['kor', 'eng'], 1 /* LSTM */, {
        workerPath: abs('ocr/worker.min.js'),
        corePath: abs('ocr/'),
        langPath: abs('ocr/'),
        gzip: true,
        logger: (m) => onProgress?.(m),
      });
    })().catch((e) => { workerP = null; throw e; });
  }
  return workerP;
}

export async function stopOcr() {
  const w = workerP;
  workerP = null;
  if (w) { try { (await w).terminate(); } catch { /* 무시 */ } }
}

/**
 * 쪽을 그림으로 그려 글자를 인식
 * @returns {Promise<Array<{t:string, rect:number[], line:number}>>} 낱말과 위치(PDF 좌표)
 */
export async function ocrPage(pdf, i, onProgress) {
  const page = await pdf.getPage(i + 1);
  const v1 = page.getViewport({ scale: 1 });
  // 긴 변 약 2400px로 그려 인식 (시험 결과: 더 키워도 정확도 이득이 적고 시간만 늘어남)
  const scale = Math.min(4, Math.max(1.5, 2400 / Math.max(v1.width, v1.height)));
  const vp = page.getViewport({ scale });
  const cv = document.createElement('canvas');
  cv.width = Math.floor(vp.width);
  cv.height = Math.floor(vp.height);
  await page.render({ canvas: cv, viewport: vp, background: '#ffffff' }).promise;
  const w = await getWorker(onProgress);
  // 쪽 배치 분석: 11(흩어진 글자) — 마인드맵·도표처럼 글자가 여기저기 흩어진 그림에서 더 많이 찾음
  await w.setParameters({ tessedit_pageseg_mode: '11' });
  const { data } = await w.recognize(cv, {}, { blocks: true });
  const words = [];
  let line = 0;
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        line++;
        for (const wd of l.words || []) {
          const t = (wd.text || '').trim();
          if (!t || wd.confidence < 35) continue; // 믿기 어려운 인식은 버림
          const { x0, y0, x1, y1 } = wd.bbox;
          const [ax, ay] = vp.convertToPdfPoint(x0, y0);
          const [bx, by] = vp.convertToPdfPoint(x1, y1);
          words.push({ t, line, rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] });
        }
      }
    }
  }
  cv.width = 0; cv.height = 0;
  return words;
}

/** 쪽에 그림(이미지)이 들어 있는지 */
export async function pageHasImage(pdf, i, OPS) {
  const page = await pdf.getPage(i + 1);
  const ops = await page.getOperatorList();
  const img = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup].filter((x) => x != null));
  return ops.fnArray.some((f) => img.has(f));
}

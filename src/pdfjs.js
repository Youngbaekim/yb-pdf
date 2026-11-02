// pdf.js 준비
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { BASE } from './state.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export { pdfjs };

/** @param {Uint8Array} bytes  (pdf.js가 작업자에게 넘기며 비우므로 사본을 넘김) */
export function loadPdf(bytes, onPassword) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: `${BASE}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
    wasmUrl: `${BASE}pdfjs/wasm/`,
    iccUrl: `${BASE}pdfjs/iccs/`,
    enableXfa: false,
  });
  if (onPassword) task.onPassword = onPassword;
  return task.promise;
}

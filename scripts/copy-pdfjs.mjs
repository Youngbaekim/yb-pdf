// pdf.js가 필요로 하는 보조 파일(CMap·표준 글꼴·wasm·ICC)과 글꼴 부분 추출용 wasm을 public 폴더로 복사
// npm install 할 때 자동 실행 (package.json의 postinstall)
import { cpSync, mkdirSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const from = (p) => new URL(`node_modules/${p}`, root);
const to = (p) => new URL(`public/${p}`, root);
mkdirSync(to('pdfjs'), { recursive: true });
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = from(`pdfjs-dist/${d}`);
  if (existsSync(src)) cpSync(src, to(`pdfjs/${d}`), { recursive: true });
}
mkdirSync(to('wasm'), { recursive: true });
cpSync(from('harfbuzzjs/dist/harfbuzz-subset.wasm'), to('wasm/harfbuzz-subset.wasm'));
// 글자 인식(OCR, tesseract.js): 작업자·엔진(wasm)·한글/영문 인식 데이터 — 인터넷 없이 쓰도록 앱에 포함
mkdirSync(to('ocr'), { recursive: true });
cpSync(from('tesseract.js/dist/worker.min.js'), to('ocr/worker.min.js'));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  cpSync(from(`tesseract.js-core/${f}`), to(`ocr/${f}`));
}
cpSync(from('@tesseract.js-data/kor/4.0.0_best_int/kor.traineddata.gz'), to('ocr/kor.traineddata.gz'));
cpSync(from('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), to('ocr/eng.traineddata.gz'));
console.log('pdf.js·OCR 보조 파일 복사 완료');

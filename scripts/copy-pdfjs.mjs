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
console.log('pdf.js 보조 파일 복사 완료');

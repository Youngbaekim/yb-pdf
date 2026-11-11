// 설치 파일 만든 뒤: 배포 폴더(C:\DEV_Release)에 새 설치 파일을 넣고, 같은 앱의 이전 버전 설치 파일은 지움
// 다른 폴더를 쓰려면 환경 변수 YBPDF_RELEASE_DIR 지정
import { readFileSync, readdirSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const { version, build } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const name = build.nsis.artifactName.replace('${version}', version); // YB_C_YB-PDF_Setup_0.0.0.exe
const prefix = name.slice(0, name.indexOf(version)); // YB_C_YB-PDF_Setup_
const src = new URL(`release/${name}`, root);
const dir = process.env.YBPDF_RELEASE_DIR || 'C:\\DEV_Release';

if (!existsSync(src)) { console.error(`설치 파일이 없습니다: release/${name}`); process.exit(1); }
if (!existsSync(dir)) { console.log(`배포 폴더가 없어 건너뜀: ${dir}`); process.exit(0); }
for (const f of readdirSync(dir)) {
  if (f !== name && f.startsWith(prefix) && /\.exe$/i.test(f)) { unlinkSync(path.join(dir, f)); console.log(`이전 버전 삭제: ${f}`); }
}
copyFileSync(src, path.join(dir, name));
console.log(`배포 폴더에 넣음: ${path.join(dir, name)}`);

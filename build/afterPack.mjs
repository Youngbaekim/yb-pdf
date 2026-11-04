// 묶은 뒤(설치 파일 만들기 전) YB-PDF.exe에 아이콘·버전 정보를 넣음
// (원래는 Windows 전용 도구 rcedit가 하는 일 — 리눅스·맥에서도 만들 수 있도록 순수 JS 도구 resedit 사용)
import fs from 'node:fs';
import path from 'node:path';
import * as ResEdit from 'resedit';

export default async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const version = ctx.packager.appInfo.version;
  const data = fs.readFileSync(exe);
  const pe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ctx.packager.info.projectDir, 'build', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons.map((i) => i.data));
  const vers = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = vers[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'YB-PDF', ProductName: 'YB-PDF', CompanyName: 'YB', LegalCopyright: 'YB (personal, non-commercial)',
    OriginalFilename: 'YB-PDF.exe', InternalName: 'YB-PDF', FileVersion: version, ProductVersion: version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log('  • 아이콘·버전 정보 적용:', path.basename(exe), version);
}

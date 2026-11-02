// 파일 열기·저장 (File System Access API: 같은 파일에 바로 덮어쓰기)
// - 크롬·엣지(PC)·설치한 앱: 열었던 파일에 Ctrl+S로 그대로 저장
// - 그 밖의 환경(휴대폰 등): 저장하면 내려받기로 대체
import { openDB } from 'idb';
import { S, emit } from './state.js';
import { loadPdf } from './pdfjs.js';
import { importPdf, exportPdf } from './pdfwrite.js';
import { subsetFor } from './fonts.js';
import { setupPages, buildDom, clearPages, setScale, targetScale, goTo } from './viewer.js';
import { resetHistory } from './annots.js';
import { toast, confirmBox } from './dialogs.js';

export const canPick = 'showOpenFilePicker' in window;
const PDF_TYPE = [{ description: 'PDF 문서', accept: { 'application/pdf': ['.pdf'] } }];

/* ───────── 최근 파일 (파일 위치 기억) ───────── */
const dbp = openDB('ybpdf', 1, {
  upgrade(db) { db.createObjectStore('recent', { keyPath: 'name' }); },
}).catch(() => null);

export async function recentList() {
  const db = await dbp;
  if (!db) return [];
  const all = await db.getAll('recent').catch(() => []);
  return all.sort((a, b) => b.at - a.at).slice(0, 12);
}
async function remember(handle) {
  const db = await dbp;
  if (!db || !handle) return;
  try {
    // 같은 이름의 다른 파일은 isSameEntry로 구분하지 않고 이름 기준으로 최신 것만 보관
    await db.put('recent', { name: handle.name, handle, at: Date.now() });
    const all = await db.getAll('recent');
    if (all.length > 12) {
      all.sort((a, b) => b.at - a.at).slice(12).forEach((r) => db.delete('recent', r.name));
    }
  } catch { /* 무시 */ }
  emit('recent');
}
export async function forget(name) {
  const db = await dbp;
  await db?.delete('recent', name);
  emit('recent');
}

async function permitted(handle, mode = 'readwrite') {
  try {
    if ((await handle.queryPermission({ mode })) === 'granted') return true;
    return (await handle.requestPermission({ mode })) === 'granted';
  } catch { return false; }
}

/* ───────── 열기 ───────── */
async function guardDirty() {
  if (!S.dirty) return true;
  const r = await confirmBox(`'${S.fileName}'의 변경 내용을 저장하지 않았습니다.\n저장할까요?`, { ok: '저장', cancel: '취소', third: '저장 안 함' });
  if (!r) return false;
  if (r === 'ok') return save();
  return true;
}

export async function pickAndOpen() {
  if (!(await guardDirty())) return;
  if (canPick) {
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({ types: PDF_TYPE, id: 'ybpdf-open' });
    } catch { return; }
    return openHandle(handle, true);
  }
  // 대체: 파일 입력
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/pdf,.pdf';
  inp.onchange = () => inp.files[0] && openFile(inp.files[0], null, true);
  inp.click();
}

export async function openHandle(handle, skipGuard = false) {
  if (!skipGuard && !(await guardDirty())) return;
  try {
    if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
      if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return;
    }
    const file = await handle.getFile();
    await openFile(file, handle, true);
  } catch (e) {
    console.error(e);
    toast('파일을 열 수 없습니다. 옮겨지거나 지워졌을 수 있습니다.');
  }
}

/** @param {File|Blob} file */
export async function openFile(file, handle = null, skipGuard = false, name) {
  if (!skipGuard && !(await guardDirty())) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(bytes, name || file.name || '새 문서.pdf', handle);
}

export async function openBytes(bytes, name, handle = null, { dirty = false } = {}) {
  emit('loading', true);
  try {
    // 1) YB 주석 떼어 내기
    let imp;
    try {
      imp = await importPdf(bytes);
    } catch (e) {
      console.warn('pdf-lib 읽기 실패 → 보기 전용', e);
      const dec = (a, b) => new TextDecoder('latin1').decode(bytes.subarray(a, b));
      const encrypted = /\/Encrypt\b/.test(dec(0, 4096) + dec(Math.max(0, bytes.length - 4096), bytes.length)); // 문서 끝(또는 첫머리)의 trailer
      imp = { annots: [], cleanBytes: bytes, encrypted, broken: !encrypted };
    }
    // 2) 화면에 표시
    const pdf = await loadPdf(imp.cleanBytes, (updatePassword, reason) => {
      const pw = window.prompt(reason === 2 ? '암호가 틀렸습니다. 다시 입력하세요.' : '암호가 걸린 PDF입니다. 암호를 입력하세요.');
      if (pw == null) updatePassword(new Error('취소'));
      else updatePassword(pw);
    });
    if (S.pdf) { try { await S.pdf.destroy(); } catch { /* 무시 */ } }
    clearPages();
    S.pdf = pdf;
    S.fileName = name;
    S.fileHandle = handle;
    S.fileSize = bytes.length;
    S.cleanBytes = imp.cleanBytes;
    S.readOnly = !!(imp.encrypted || imp.broken);
    S.readOnlyReason = imp.encrypted ? '보안(암호화)이 설정된 PDF는 보기만 할 수 있습니다.' : imp.broken ? '이 PDF는 구조가 특이하여 편집 저장을 지원하지 않습니다(보기 전용).' : '';
    S.dirty = dirty;
    S.current = 0;
    resetHistory(imp.annots);
    await setupPages();
    buildDom();
    setScale(targetScale());
    const last = lastPage(name, bytes.length);
    if (last > 0 && last < S.pages.length) goTo(last); else document.getElementById('viewer').scrollTop = 0;
    if (handle) remember(handle);
    emit('doc');
    emit('dirty');
    if (S.readOnly) toast(S.readOnlyReason, 4000);
    else if (imp.annots.length) toast(`YB-PDF 주석 ${imp.annots.length}개를 불러왔습니다.`);
  } catch (e) {
    console.error(e);
    toast(e?.name === 'PasswordException' ? '암호를 입력하지 않아 열지 않았습니다.' : 'PDF를 열 수 없습니다. 손상되었거나 PDF가 아닌 파일입니다.', 4000);
  } finally {
    emit('loading', false);
  }
}

/* 문서별 마지막으로 보던 쪽 */
const posKey = (name, size) => `ybpdf-pos:${name}:${size}`;
function lastPage(name, size) {
  try { return Number(localStorage.getItem(posKey(name, size))) || 0; } catch { return 0; }
}
export function rememberPage() {
  if (!S.pdf) return;
  try { localStorage.setItem(posKey(S.fileName, S.fileSize), String(S.current)); } catch { /* 무시 */ }
}

/* ───────── 저장 ───────── */
export async function buildBytes() {
  return exportPdf(S.cleanBytes, S.annots, subsetFor);
}

let saving = false;
/** @returns {Promise<boolean>} 저장했는지 */
export async function save({ as = false } = {}) {
  if (!S.pdf || saving) return false;
  if (S.readOnly) { toast(S.readOnlyReason); return false; }
  saving = true;
  emit('saving', true);
  try {
    const bytes = await buildBytes();
    let handle = as ? null : S.fileHandle;
    if (handle && !(await permitted(handle))) handle = null;
    if (!handle && canPick && 'showSaveFilePicker' in window) {
      try {
        handle = await window.showSaveFilePicker({ suggestedName: S.fileName || '문서.pdf', types: PDF_TYPE, id: 'ybpdf-save' });
      } catch { return false; } // 취소
    }
    if (handle) {
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      S.fileHandle = handle;
      S.fileName = handle.name;
      remember(handle);
    } else {
      download(bytes, S.fileName || '문서.pdf');
    }
    S.fileSize = bytes.length;
    S.dirty = false;
    emit('dirty');
    emit('doc-name');
    toast(handle ? `저장했습니다 · ${S.fileName}` : `내려받기로 저장했습니다 · ${S.fileName}`);
    return true;
  } catch (e) {
    console.error(e);
    toast(`저장하지 못했습니다: ${e?.message || e}`, 5000);
    return false;
  } finally {
    saving = false;
    emit('saving', false);
  }
}

export function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 인쇄: 주석을 넣은 PDF를 브라우저 PDF 보기 화면으로 열어 인쇄 */
export async function printDoc() {
  if (!S.pdf) return;
  const w = window.open('', '_blank');
  try {
    const bytes = S.readOnly ? S.cleanBytes : await buildBytes();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (w) w.location.href = url; else window.open(url, '_blank');
  } catch (e) {
    w?.close();
    toast(`인쇄 준비 실패: ${e?.message || e}`);
  }
}

/* ───────── 끌어다 놓기·탐색기 '연결 프로그램' ───────── */
export function initDrop() {
  const v = document.getElementById('app');
  v.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); v.classList.add('drop'); }
  });
  v.addEventListener('dragleave', (e) => { if (e.target === v || !v.contains(e.relatedTarget)) v.classList.remove('drop'); });
  v.addEventListener('drop', async (e) => {
    e.preventDefault();
    v.classList.remove('drop');
    const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
    if (!item) return;
    // 핸들을 먼저 받아 두어야 함 (이벤트가 끝나면 사라짐)
    const hp = item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
    const file = item.getAsFile();
    let handle = null;
    try { handle = hp ? await hp : null; } catch { handle = null; }
    if (!/\.pdf$/i.test(file?.name || '') && file?.type !== 'application/pdf') return toast('PDF 파일만 열 수 있습니다.');
    if (!(await guardDirty())) return;
    if (handle?.kind === 'file') openHandle(handle, true);
    else openFile(file, null, true);
  });
  // 설치한 앱(PWA)에서 PDF 파일을 이 앱으로 열었을 때
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const h = params.files?.[0];
      if (h) openHandle(h);
    });
  }
}

export { guardDirty };

// 파일 열기·저장 (File System Access API: 같은 파일에 바로 덮어쓰기)
// - 크롬·엣지(PC)·설치한 앱: 열었던 파일에 Ctrl+S로 그대로 저장
// - 그 밖의 환경(휴대폰 등): 저장하면 내려받기로 대체
// - 두 번째 PDF부터는 새 탭으로 엶 (설정에 따라 새 창)
import { S, emit, pref } from './state.js';
import { loadPdf } from './pdfjs.js';
import { importPdf, exportPdf } from './pdfwrite.js';
import { subsetFor } from './fonts.js';
import { setupPages, buildDom, clearPages, setScale, targetScale, goTo } from './viewer.js';
import { resetHistory } from './annots.js';
import { toast } from './dialogs.js';
import { dbp } from './db.js';
import { native, pathHandle, storable, revive, nativeOpenDialog, nativeSaveDialog } from './native.js';
import { newTab, activeIsEmpty, findTab, activate, openInNewWindow, tabs, moveTab, active } from './docs.js';

export const canPick = !!native || 'showOpenFilePicker' in window; // 같은 파일 덮어쓰기 가능 여부
const PDF_TYPE = [{ description: 'PDF 문서', accept: { 'application/pdf': ['.pdf'] } }];

/* ───────── 최근 파일 (파일 위치 기억) ───────── */
export async function recentList() {
  const db = await dbp;
  if (!db) return [];
  const all = await db.getAll('recent').catch(() => []);
  return all.sort((a, b) => b.at - a.at).slice(0, 12).map((r) => ({ ...r, handle: revive(r.handle) }));
}
async function remember(handle) {
  const db = await dbp;
  if (!db || !handle) return;
  try {
    // 같은 이름의 다른 파일은 구분하지 않고 이름 기준으로 최신 것만 보관
    await db.put('recent', { name: handle.name, handle: storable(handle), at: Date.now() });
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
export async function pickAndOpen() {
  if (native) {
    for (const h of await nativeOpenDialog()) await openHandle(h);
    return;
  }
  if (canPick) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({ types: PDF_TYPE, id: 'ybpdf-open', multiple: true });
    } catch { return; }
    for (const h of handles) await openHandle(h);
    return;
  }
  // 대체: 파일 입력
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/pdf,.pdf';
  inp.multiple = true;
  inp.onchange = async () => { for (const f of inp.files) await openFile(f); };
  inp.click();
}

export async function openHandle(handle) {
  // 이미 열려 있으면 그 탭으로
  const same = await findTab(handle);
  if (same) { activate(same.id); return; }
  try {
    if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
      if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return;
    }
    const file = await handle.getFile();
    await openFile(file, handle);
  } catch (e) {
    console.error(e);
    toast('파일을 열 수 없습니다. 옮겨지거나 지워졌을 수 있습니다.');
  }
}

/** @param {File|Blob} file */
export async function openFile(file, handle = null, name) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openBytes(bytes, name || file.name || '새 문서.pdf', handle);
}

/**
 * @param {object} o
 * @param {boolean} [o.dirty]
 * @param {object[]} [o.annots]  다른 창에서 옮겨 온 주석 (있으면 이것을 씀)
 * @param {number} [o.current]   보던 쪽
 * @param {number} [o.index]     탭을 끼울 자리
 * @param {boolean} [o.here]     설정과 관계없이 이 창에서 열기
 */
export async function openBytes(bytes, name, handle = null, o = {}) {
  // 설정: 새 PDF는 새 창으로 (이 창에 이미 문서가 있을 때)
  if (!o.here && pref('newWindow', false) && !activeIsEmpty()) {
    if (await openInNewWindow({ name, handle, bytes, dirty: !!o.dirty })) return;
  }
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
    // 2) 화면에 표시할 문서 준비
    const pdf = await loadPdf(imp.cleanBytes, (updatePassword, reason) => {
      const pw = window.prompt(reason === 2 ? '암호가 틀렸습니다. 다시 입력하세요.' : '암호가 걸린 PDF입니다. 암호를 입력하세요.');
      if (pw == null) updatePassword(new Error('취소'));
      else updatePassword(pw);
    });
    // 3) 탭: 지금 탭이 비어 있으면 그 탭, 아니면 새 탭
    if (!activeIsEmpty() || !active()) newTab();
    if (o.index != null) moveTab(active().id, o.index);
    clearPages();
    S.pdf = pdf;
    S.fileName = name;
    S.fileHandle = handle;
    S.fileSize = bytes.length;
    S.cleanBytes = imp.cleanBytes;
    S.readOnly = !!(imp.encrypted || imp.broken);
    S.readOnlyReason = imp.encrypted ? '보안(암호화)이 설정된 PDF는 보기만 할 수 있습니다.' : imp.broken ? '이 PDF는 구조가 특이하여 편집 저장을 지원하지 않습니다(보기 전용).' : '';
    S.dirty = !!o.dirty;
    S.current = 0;
    resetHistory(o.annots || imp.annots);
    await setupPages();
    buildDom();
    setScale(targetScale());
    const last = o.current ?? lastPage(name, bytes.length);
    if (last > 0 && last < S.pages.length) goTo(last); else document.getElementById('viewer').scrollTop = 0;
    if (handle) remember(handle);
    emit('doc');
    emit('dirty');
    emit('tabs');
    if (S.readOnly) toast(S.readOnlyReason, 4000);
    else if (!o.annots && imp.annots.length) toast(`YB-PDF 주석 ${imp.annots.length}개를 불러왔습니다.`);
  } catch (e) {
    console.error(e);
    toast(e?.name === 'PasswordException' ? '암호를 입력하지 않아 열지 않았습니다.' : `PDF를 열 수 없습니다 (${name}). 손상되었거나 PDF가 아닌 파일입니다.`, 4000);
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
    if (!handle && native) {
      handle = await nativeSaveDialog(S.fileName || '문서.pdf', S.fileHandle);
      if (!handle) return false; // 취소
    } else if (!handle && canPick && 'showSaveFilePicker' in window) {
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
    const items = [...(e.dataTransfer?.items || [])].filter((i) => i.kind === 'file');
    if (!items.length) return;
    e.preventDefault();
    v.classList.remove('drop');
    // 핸들을 먼저 받아 두어야 함 (이벤트가 끝나면 사라짐)
    const got = items.map((item) => ({ hp: item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null, file: item.getAsFile() }));
    let skipped = 0;
    for (const { hp, file } of got) {
      if (!/\.pdf$/i.test(file?.name || '') && file?.type !== 'application/pdf') { skipped++; continue; }
      const p = native?.pathOf(file);
      if (p) { await openHandle(pathHandle(p)); continue; } // 데스크톱 앱: 파일 경로로 열어 그대로 덮어쓰기
      let handle = null;
      try { handle = hp ? await hp : null; } catch { handle = null; }
      if (handle?.kind === 'file') await openHandle(handle);
      else await openFile(file);
    }
    if (skipped) toast('PDF가 아닌 파일은 열지 않았습니다.');
  });
  // 데스크톱 앱: 탐색기에서 PDF를 더블클릭(또는 '연결 프로그램')했을 때
  if (native) {
    const openPaths = async (paths) => { for (const p of paths) await openHandle(pathHandle(p)); };
    native.onOpen(openPaths);
    native.pending().then(openPaths);
  }
  // 설치한 앱(PWA)에서 PDF 파일을 이 앱으로 열었을 때
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      for (const h of params.files || []) await openHandle(h);
    });
  }
}


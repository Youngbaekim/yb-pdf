// PDF 합치기: 여러 PDF를 고르거나 끌어다 놓고 → 순서 조정 → [완료] 누르면 저장 위치·이름을 정해 저장
import { S } from './state.js';
import { mergePdfs, exportPdf } from './pdfwrite.js';
import { saveBytesAs, openBytes } from './fileio.js';
import { subsetFor } from './fonts.js';
import { toast } from './dialogs.js';
import { tabs, docOf } from './docs.js';
import { PDFDocument } from 'pdf-lib';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

export async function openMerge() {
  /** @type {{key:string, name:string, size:number, pages:number, get:()=>Promise<Uint8Array>}[]} */
  let items = [];
  const d = document.createElement('dialog');
  d.className = 'dlg dlg-merge';
  const openDocs = tabs.filter((t) => docOf(t).pdf);
  d.innerHTML = `<form method="dialog"><h3>PDF 합치기</h3>
    <div class="merge-drop" tabindex="0">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/></svg>
      <span>합칠 PDF를 여기로 끌어다 놓거나</span>
      <label class="btn">파일 선택<input type="file" accept="application/pdf,.pdf" multiple hidden></label>
      ${openDocs.length ? `<select class="add-open" title="지금 열려 있는 문서를 넣기 (주석 포함)"><option value="">열린 문서에서 넣기…</option>${openDocs.map((t) => `<option value="${t.id}">${esc(docOf(t).fileName)}</option>`).join('')}</select>` : ''}
    </div>
    <ol class="merge-list"></ol>
    <p class="hint">위에서부터 차례로 합칩니다. 항목을 끌어서 순서를 바꾸세요.</p>
    <label class="chk"><input type="checkbox" name="openAfter"> 저장한 뒤 새 탭에서 열기</label>
    <div class="dlg-foot"><span class="sum"></span><span class="sp"></span>
      <button type="button" class="btn" data-v="reset" title="목록을 비우고 처음부터">다시하기</button>
      <button type="button" class="btn" data-v="cancel">취소</button>
      <button type="button" class="btn btn-primary" data-v="ok">완료</button></div></form>`;
  document.body.appendChild(d);
  const list = d.querySelector('.merge-list');
  const drop = d.querySelector('.merge-drop');

  const render = () => {
    list.innerHTML = items.map((it, k) => `<li draggable="true" data-k="${k}"><span class="grip" title="끌어서 순서 변경">⋮⋮</span><b class="no">${k + 1}</b><span class="nm" title="${esc(it.name)}">${esc(it.name)}</span>
      <span class="meta">${it.pages}쪽 · ${kb(it.size)}</span>
      <button type="button" data-a="up" title="위로" ${k === 0 ? 'disabled' : ''}>↑</button><button type="button" data-a="down" title="아래로" ${k === items.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-a="del" title="빼기">✕</button></li>`).join('');
    list.hidden = !items.length;
    const total = items.reduce((s, it) => s + it.pages, 0);
    d.querySelector('.sum').textContent = items.length ? `${items.length}개 파일 · 모두 ${total}쪽` : '두 개 이상 넣으세요';
    d.querySelector('[data-v=ok]').disabled = items.length < 2;
    d.querySelector('[data-v=reset]').disabled = !items.length;
  };

  const addFiles = async (files) => {
    let bad = 0;
    for (const f of files) {
      if (!isPdf(f)) { bad++; continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      let pages;
      try {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        if (doc.isEncrypted) { toast(`${f.name}: 보안(암호화)이 설정된 PDF는 합칠 수 없습니다.`); continue; }
        pages = doc.getPageCount();
      } catch { toast(`${f.name}: PDF를 읽을 수 없습니다.`); continue; }
      items.push({ key: Math.random().toString(36).slice(2), name: f.name, size: f.size, pages, get: async () => bytes });
    }
    if (bad) toast('PDF가 아닌 파일은 넣지 않았습니다.');
    render();
  };

  // 파일 선택
  d.querySelector('input[type=file]').addEventListener('change', async (e) => { await addFiles([...e.target.files]); e.target.value = ''; });
  // 열린 문서 넣기 (저장하지 않은 주석까지 포함)
  d.querySelector('.add-open')?.addEventListener('change', (e) => {
    const t = tabs.find((x) => x.id === e.target.value);
    e.target.value = '';
    if (!t) return;
    const doc = docOf(t);
    items.push({
      key: t.id + Math.random(), name: doc.fileName, size: doc.fileSize, pages: doc.pages.length,
      get: () => (doc.readOnly ? Promise.resolve(doc.cleanBytes) : exportPdf(doc.cleanBytes, doc.annots, subsetFor, doc.outlineEdited ? doc.outline : null)),
    });
    render();
  });
  // 탐색기에서 끌어다 놓기 (대화상자 어디든)
  d.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    drop.classList.add('over');
  });
  d.addEventListener('dragleave', (e) => { if (!d.contains(e.relatedTarget)) drop.classList.remove('over'); });
  d.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('over');
    addFiles([...e.dataTransfer.files]);
  });

  // 순서 바꾸기: 단추 · 끌기
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const k = Number(b.closest('li').dataset.k);
    if (b.dataset.a === 'del') items.splice(k, 1);
    if (b.dataset.a === 'up') [items[k - 1], items[k]] = [items[k], items[k - 1]];
    if (b.dataset.a === 'down') [items[k + 1], items[k]] = [items[k], items[k + 1]];
    render();
  });
  let from = -1;
  const clearMarks = () => list.querySelectorAll('.before, .after').forEach((x) => x.classList.remove('before', 'after'));
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    from = Number(li?.dataset.k);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-ybpdf-merge', String(from));
    li?.classList.add('dragging');
  });
  list.addEventListener('dragend', () => { from = -1; clearMarks(); list.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging')); });
  const targetIndex = (e) => {
    const lis = [...list.children];
    for (let k = 0; k < lis.length; k++) {
      const r = lis[k].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return k;
    }
    return lis.length;
  };
  list.addEventListener('dragover', (e) => {
    if (from < 0) return;
    e.preventDefault();
    clearMarks();
    const to = targetIndex(e);
    const lis = list.children;
    if (to < lis.length) lis[to].classList.add('before'); else lis[lis.length - 1]?.classList.add('after');
  });
  list.addEventListener('drop', (e) => {
    if (from < 0) return;
    e.preventDefault();
    e.stopPropagation();
    let to = targetIndex(e);
    const [m] = items.splice(from, 1);
    if (to > from) to--;
    items.splice(to, 0, m);
    from = -1;
    render();
  });

  render();
  d.showModal();
  await new Promise((resolve) => {
    const close = () => { d.close(); resolve(); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    d.querySelector('[data-v=cancel]').addEventListener('click', close);
    d.querySelector('[data-v=reset]').addEventListener('click', () => { items = []; render(); });
    d.querySelector('[data-v=ok]').addEventListener('click', async () => {
      const ok = d.querySelector('[data-v=ok]');
      ok.disabled = true;
      ok.textContent = '합치는 중…';
      try {
        const parts = [];
        for (const it of items) parts.push(await it.get());
        const merged = await mergePdfs(parts);
        const base = items[0].name.replace(/\.pdf$/i, '') || '합본';
        ok.textContent = '저장 위치 선택…';
        const res = await saveBytesAs(merged, `${base}_합본.pdf`);
        if (!res) { ok.disabled = false; ok.textContent = '완료'; return; } // 저장 취소 → 대화상자 유지
        const openAfter = d.querySelector('[name=openAfter]').checked;
        close();
        toast(`${items.length}개 파일을 합쳐 저장했습니다 · ${res.name}`, 4000);
        if (openAfter) await openBytes(merged, res.name, res.handle, { here: true });
      } catch (err) {
        console.error(err);
        toast(`합치기 실패: ${err?.message || err}`, 5000);
        ok.disabled = false;
        ok.textContent = '완료';
      }
    });
  });
  d.remove();
}

// PDF 병합: 여러 파일을 순서대로 합쳐 새 문서로 열기
import { S } from './state.js';
import { mergePdfs } from './pdfwrite.js';
import { buildBytes, openBytes, guardDirty } from './fileio.js';
import { toast } from './dialogs.js';
import { PDFDocument } from 'pdf-lib';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export async function openMerge() {
  /** @type {{name:string, size:number, pages:number|null, get:()=>Promise<Uint8Array>}[]} */
  const items = [];
  if (S.pdf) {
    items.push({ name: `${S.fileName} (지금 문서·주석 포함)`, size: S.fileSize, pages: S.pages.length, get: () => (S.readOnly ? Promise.resolve(S.cleanBytes) : buildBytes()) });
  }
  const d = document.createElement('dialog');
  d.className = 'dlg dlg-merge';
  d.innerHTML = `<form method="dialog"><h3>PDF 병합</h3>
    <p class="hint">위에서부터 차례로 합칩니다. 끌거나 ↑↓ 단추로 순서를 바꾸세요.</p>
    <ol class="merge-list"></ol>
    <label class="btn add-files">＋ 파일 추가<input type="file" accept="application/pdf,.pdf" multiple hidden></label>
    <div class="dlg-foot"><span class="sum"></span><span class="sp"></span>
      <button type="button" class="btn" data-v="cancel">취소</button><button type="button" class="btn btn-primary" data-v="ok">병합하여 열기</button></div></form>`;
  document.body.appendChild(d);
  const list = d.querySelector('.merge-list');
  let dragFrom = -1;
  const render = () => {
    list.innerHTML = items.map((it, k) => `<li draggable="true" data-k="${k}"><span class="grip">⋮⋮</span><span class="nm">${esc(it.name)}</span>
      <span class="meta">${it.pages ?? '?'}쪽 · ${kb(it.size)}</span>
      <button type="button" data-a="up" ${k === 0 ? 'disabled' : ''}>↑</button><button type="button" data-a="down" ${k === items.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-a="del">✕</button></li>`).join('')
      || '<li class="empty">합칠 파일을 추가하세요</li>';
    const total = items.reduce((s, it) => s + (it.pages || 0), 0);
    d.querySelector('.sum').textContent = items.length ? `${items.length}개 파일 · 모두 ${total}쪽` : '';
    d.querySelector('[data-v=ok]').disabled = items.length < 2;
  };
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const k = Number(b.closest('li').dataset.k);
    if (b.dataset.a === 'del') items.splice(k, 1);
    if (b.dataset.a === 'up') [items[k - 1], items[k]] = [items[k], items[k - 1]];
    if (b.dataset.a === 'down') [items[k + 1], items[k]] = [items[k], items[k + 1]];
    render();
  });
  list.addEventListener('dragstart', (e) => { dragFrom = Number(e.target.closest('li')?.dataset.k); });
  list.addEventListener('dragover', (e) => e.preventDefault());
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const to = Number(e.target.closest('li')?.dataset.k);
    if (dragFrom < 0 || Number.isNaN(to) || to === dragFrom) return;
    const [m] = items.splice(dragFrom, 1);
    items.splice(to, 0, m);
    dragFrom = -1;
    render();
  });
  d.querySelector('input[type=file]').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let pages = null;
      try { pages = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount(); } catch { toast(`${f.name}: PDF를 읽을 수 없습니다.`); continue; }
      items.push({ name: f.name, size: f.size, pages, get: async () => bytes });
    }
    e.target.value = '';
    render();
  });
  render();
  d.showModal();
  await new Promise((resolve) => {
    d.addEventListener('close', resolve);
    d.addEventListener('cancel', () => resolve());
    d.querySelector('[data-v=cancel]').addEventListener('click', () => d.close());
    d.querySelector('[data-v=ok]').addEventListener('click', async () => {
      const ok = d.querySelector('[data-v=ok]');
      ok.disabled = true;
      ok.textContent = '합치는 중…';
      try {
        const parts = [];
        for (const it of items) parts.push(await it.get());
        const merged = await mergePdfs(parts);
        d.close();
        if (!(await guardDirty())) return;
        const base = (items[0].name.replace(/ \(지금 문서.*\)$/, '').replace(/\.pdf$/i, '')) || '병합';
        await openBytes(merged, `${base}_병합.pdf`, null, { dirty: true });
        toast(`${items.length}개 파일을 합쳤습니다. Ctrl+S로 저장할 위치를 정하세요.`, 4000);
      } catch (err) {
        console.error(err);
        toast(`병합 실패: ${err?.message || err}`, 5000);
        ok.disabled = false;
        ok.textContent = '병합하여 열기';
      }
    });
  });
  d.remove();
}

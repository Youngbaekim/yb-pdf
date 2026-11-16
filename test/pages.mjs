import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
await p.goto('http://localhost:4173/yb-pdf/'); await p.waitForLoadState('networkidle');
const drop = (file, name) => p.evaluate(async ({ b64, name }) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bin], name, { type: 'application/pdf' })); document.getElementById('app').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, { b64: fs.readFileSync(file).toString('base64'), name });
await drop('test/outline.pdf', 'outline.pdf');
await p.waitForSelector('.page.ready'); await p.waitForTimeout(400);
// 각 쪽 첫 글자(쪽 식별)
const sig = () => p.evaluate(async () => { const { S } = window.__ybpdf; const out = []; for (let i = 1; i <= S.pdf.numPages; i++) { const t = await (await S.pdf.getPage(i)).getTextContent(); out.push(t.items.map((x) => x.str).join('').slice(0, 6)); } return out.join(' | '); });
const state = () => p.evaluate(() => { const { S } = window.__ybpdf; return { n: S.pdf.numPages, annots: S.annots.map((a) => `${a.text}@${a.page + 1}`).join(','), dirty: S.dirty }; });
console.log('orig', await sig());
// 3쪽·8쪽에 메모 주석
await p.evaluate(() => { const { A } = window.__ybpdf; A.add({ id: 'n3', type: 'note', page: 2, x: 100, y: 500, text: 'P3', color: '#ffd54a' }); A.add({ id: 'n8', type: 'note', page: 7, x: 100, y: 500, text: 'P8', color: '#ffd54a' }); });
await p.click('.tab[data-tab=pages]'); await p.waitForTimeout(600);
await p.click('.thumb[data-i="1"]');
await p.click('.thumb[data-i="3"]', { modifiers: ['Shift'] });
await p.click('.thumb[data-i="6"]', { modifiers: ['Control'] });
console.log('sel label:', await p.textContent('#pg-sel'), 'sel count', await p.locator('.thumb.sel').count());
await p.screenshot({ path: 'test/pages-sel.png' });
await p.keyboard.press('Delete'); await p.waitForTimeout(1200);
console.log('after delete', await sig(), await state());
await p.keyboard.press('Control+z'); await p.waitForTimeout(1200);
console.log('after undo', await sig(), await state());
await p.keyboard.press('Control+y'); await p.waitForTimeout(1200);
console.log('after redo', (await state()).n);
await p.keyboard.press('Control+z'); await p.waitForTimeout(1200);
// Shift+끌기: 3쪽에서 시작해 5쪽까지
await p.click('.thumb[data-i="2"]');
const r5 = await p.locator('.thumb[data-i="4"]').boundingBox();
const r3 = await p.locator('.thumb[data-i="2"]').boundingBox();
await p.keyboard.down('Shift');
await p.mouse.move(r3.x + 20, r3.y + 20); await p.mouse.down();
await p.mouse.move(r5.x + 20, r5.y + 30, { steps: 8 }); await p.mouse.up();
await p.keyboard.up('Shift');
console.log('shift-drag sel:', await p.textContent('#pg-sel'));
// 복사 → 1쪽 고르고 붙여넣기 (1쪽 뒤로)
await p.keyboard.press('Control+c'); await p.waitForTimeout(600);
await p.click('.thumb[data-i="0"]');
await p.keyboard.press('Control+v'); await p.waitForTimeout(1500);
console.log('after paste', await sig(), await state(), 'sel', await p.textContent('#pg-sel'));
// 복제
await p.click('.thumb[data-i="0"]');
await p.keyboard.press('Control+d'); await p.waitForTimeout(1500);
console.log('after dup', (await state()).n, 'sel', await p.textContent('#pg-sel'));
// 오른쪽 클릭 메뉴
await p.click('.thumb[data-i="5"]', { button: 'right' }); await p.waitForTimeout(200);
console.log('menu:', (await p.textContent('.tab-menu')).replace(/\s+/g, ' '));
await p.screenshot({ path: 'test/pages-menu.png' });
await p.keyboard.press('Escape'); await p.mouse.click(700, 400);
// 저장 결과 검사: 내려받기로 저장

// 새 탭으로 꺼내기
await p.click('.thumb[data-i="2"]'); await p.click('.thumb[data-i="3"]', { modifiers: ['Shift'] });
await p.click('[data-pg=extract]'); await p.waitForTimeout(1500);
console.log('tabs', await p.locator('.dtab').count(), 'new tab', await p.evaluate(() => window.__ybpdf.S.fileName), await state());
await b.close();

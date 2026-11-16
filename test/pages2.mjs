import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1400, height: 860 } })).newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:4173/yb-pdf/'); await p.waitForLoadState('networkidle');
const drop = (buf, name) => p.evaluate(async ({ b64, name }) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bin], name, { type: 'application/pdf' })); document.getElementById('app').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, { b64: Buffer.from(buf).toString('base64'), name });
await drop(fs.readFileSync('test/outline.pdf'), 'outline.pdf');
await p.waitForSelector('.page.ready'); await p.waitForTimeout(400);
await p.evaluate(() => window.__ybpdf.A.add({ id: 'n3', type: 'note', page: 2, x: 100, y: 500, text: 'P3', color: '#ffd54a' }));
await p.click('.tab[data-tab=pages]'); await p.waitForTimeout(500);
// 잘라내기 3쪽 → 끝(11쪽→10쪽 기준 마지막) 뒤에 붙여넣기
await p.click('.thumb[data-i="2"]'); await p.keyboard.press('Control+x'); await p.waitForTimeout(1500);
console.log('after cut n', await p.evaluate(() => window.__ybpdf.S.pdf.numPages));
await p.click('.thumb[data-i="9"]'); await p.keyboard.press('Control+v'); await p.waitForTimeout(1500);
// Ctrl+A → 메뉴 삭제 불가 확인
await p.click('.thumb[data-i="0"]'); await p.keyboard.press('Control+a'); console.log('ctrl+a', await p.textContent('#pg-sel'), 'del disabled', await p.$eval('[data-pg=del]', (x) => x.disabled));
await p.keyboard.press('Delete'); await p.waitForTimeout(300);
const out = await p.evaluate(async () => Array.from(await window.__ybpdf.buildBytes()));
fs.writeFileSync('test/pages-out.pdf', Buffer.from(out));
console.log('saved bytes', out.length);
// 다시 열기
await drop(out, 'pages-out.pdf'); await p.waitForTimeout(1500);
console.log('reopen', await p.evaluate(async () => { const { S } = window.__ybpdf; const o = []; for (let i = 1; i <= S.pdf.numPages; i++) o.push((await (await S.pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join('').slice(0, 5)); return o.join('|') + ' annots ' + S.annots.map((a) => a.text + '@' + (a.page + 1)); }));
await b.close();

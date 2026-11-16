import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 860 } });
const mk = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => console.log('[pageerror]', e.message)); await p.goto('http://localhost:4173/yb-pdf/'); await p.waitForLoadState('networkidle'); return p; };
const p = await mk();
const drop = (p, file, name) => p.evaluate(async ({ b64, name }) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bin], name, { type: 'application/pdf' })); document.getElementById('app').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, { b64: fs.readFileSync(file).toString('base64'), name });
const sig = (p) => p.evaluate(async () => { const { S } = window.__ybpdf; const o = []; for (let i = 1; i <= S.pdf.numPages; i++) o.push((await (await S.pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join('').slice(0, 5)); return S.fileName + ': ' + o.join('|') + ' annots ' + S.annots.map((a) => a.text + '@' + (a.page + 1)); });
await drop(p, 'test/outline.pdf', 'A.pdf'); await p.waitForSelector('.page.ready'); await p.waitForTimeout(400);
await p.evaluate(() => window.__ybpdf.A.add({ id: 'n', type: 'note', page: 7, x: 100, y: 500, text: 'P8', color: '#ffd54a' }));
await drop(p, 'test/find.pdf', 'B.pdf'); await p.waitForTimeout(1500);
console.log('B before', await sig(p));
// 탭 A로 가서 7-8쪽 복사
await p.click('.dtab >> nth=0'); await p.waitForTimeout(800);
await p.click('.tab[data-tab=pages]'); await p.waitForTimeout(600);
await p.click('.thumb[data-i="6"]'); await p.click('.thumb[data-i="7"]', { modifiers: ['Shift'] });
await p.keyboard.press('Control+c'); await p.waitForTimeout(800);
// 탭 B로 가서 1쪽과 2쪽 사이 선택(1쪽 오른쪽 가장자리 누르기)
await p.click('.dtab >> nth=1'); await p.waitForTimeout(1000);
const r = await p.locator('.thumb[data-i="1"] .tw').boundingBox();
await p.mouse.move(r.x - 3, r.y + 40); await p.waitForTimeout(100);
console.log('hover class', await p.locator('.thumb.gap-before').count());
await p.mouse.down(); await p.mouse.up();
console.log('label', await p.textContent('#pg-sel'), 'ins marks', await p.locator('.thumb.ins-before').count());
await p.screenshot({ path: 'test/pages-gap.png' });
await p.keyboard.press('Control+v'); await p.waitForTimeout(1500);
console.log('B after', await sig(p), '|', await p.textContent('#pg-sel'));
// 다른 창: 같은 복사본을 붙여넣기 (마지막 쪽 뒤 빈 칸 오른쪽 클릭 메뉴)
const q = await mk();
await drop(q, 'test/sample.pdf', 'C.pdf'); await q.waitForSelector('.page.ready'); await q.waitForTimeout(500);
await q.click('.tab[data-tab=pages]'); await q.waitForTimeout(600);
const n = await q.evaluate(() => window.__ybpdf.S.pdf.numPages);
const rl = await q.locator(`.thumb[data-i="${n - 1}"] .tw`).boundingBox();
await q.mouse.click(rl.x + rl.width + 6, rl.y + 30, { button: 'right' }); await q.waitForTimeout(300);
console.log('win2 menu', (await q.textContent('.tab-menu')).replace(/\s+/g, ' '));
await q.click('.tab-menu [data-a=here]'); await q.waitForTimeout(1500);
console.log('C after', await sig(q));
await b.close();

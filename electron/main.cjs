// YB-PDF 데스크톱(Windows) 앱 — 웹 앱(dist)을 그대로 띄우는 얇은 껍데기 (Electron)
// - 인터넷 없이 동작, 탐색기에서 PDF를 더블클릭하면 이 앱의 새 탭으로 열림
// - 이미 실행 중이면 새로 띄우지 않고 기존 창에 탭으로 추가 (한 번만 실행)
const { app, BrowserWindow, protocol, net, ipcMain, dialog, Menu, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const START = 'app://yb-pdf/yb-pdf/';
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

/* ───────── 실행 인수의 PDF 경로 ───────── */
const pdfArgs = (argv) => argv.slice(1).filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a)).map((a) => path.resolve(a));
let pending = pdfArgs(process.argv);
let lastFocused = null;

function sendPaths(paths) {
  if (!paths.length) return;
  const win = (lastFocused && !lastFocused.isDestroyed() && lastFocused) || BrowserWindow.getAllWindows()[0];
  if (!win) { pending.push(...paths); return; }
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('open-paths', paths);
}
app.on('second-instance', (_e, argv) => sendPaths(pdfArgs(argv)));

/* ───────── 창 ───────── */
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { width: 1360, height: 900 }; }
}
function saveBounds(win) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* 무시 */ }
}

const webPreferences = {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  sandbox: true,
  plugins: true, // 인쇄용 PDF 보기 창
  spellcheck: false,
};

function setupWindow(win, { remember } = {}) {
  win.on('focus', () => { lastFocused = win; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 탭을 새 창으로 분리(app://), 인쇄용 PDF 보기(about:blank → blob:)는 앱 안에서
    if (url.startsWith('app://') || url === 'about:blank' || url.startsWith('blob:')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#16202B', icon: iconPath(), webPreferences } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => setupWindow(child));
  // 저장하지 않은 문서가 있을 때 닫기 확인 (웹의 beforeunload를 대신 처리)
  win.webContents.on('will-prevent-unload', (e) => {
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['닫기', '취소'], defaultId: 1, cancelId: 1, title: 'YB-PDF',
      message: '저장하지 않은 변경 내용이 있습니다.', detail: '저장하지 않고 창을 닫을까요?',
    });
    if (r === 0) e.preventDefault();
  });
  if (remember) win.on('close', () => saveBounds(win));
}
const iconPath = () => path.join(__dirname, 'icon.png');

function createMain() {
  const b = loadBounds();
  const win = new BrowserWindow({
    width: b.width || 1360, height: b.height || 900, x: b.x, y: b.y,
    minWidth: 480, minHeight: 360, show: false, autoHideMenuBar: true,
    backgroundColor: '#16202B', title: 'YB-PDF', icon: iconPath(), webPreferences,
  });
  if (b.maximized) win.maximize();
  setupWindow(win, { remember: true });
  win.once('ready-to-show', () => win.show());
  win.loadURL(START);
  lastFocused = win;
  return win;
}

/* ───────── 화면이 부르는 기능 ───────── */
ipcMain.handle('pending', () => { const p = pending; pending = []; return p; });
ipcMain.handle('read', async (_e, p) => {
  const bytes = await fs.promises.readFile(p);
  return { name: path.basename(p), bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), path: p };
});
ipcMain.handle('write', async (_e, p, bytes) => {
  // 임시 파일에 먼저 쓴 뒤 바꿔치기 (쓰는 중 오류가 나도 원본이 깨지지 않도록)
  const tmp = `${p}.ybpdf-${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, Buffer.from(bytes));
  try { await fs.promises.rename(tmp, p); } catch {
    await fs.promises.copyFile(tmp, p); // 다른 프로그램이 파일을 잡고 있으면 덮어쓰기
    await fs.promises.unlink(tmp).catch(() => {});
  }
  return true;
});
ipcMain.handle('open-dialog', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'PDF 열기', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF 문서', extensions: ['pdf'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('save-dialog', async (e, name, dir) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    title: '다른 이름으로 저장', defaultPath: dir ? path.join(dir, name) : name, filters: [{ name: 'PDF 문서', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  return /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
});
ipcMain.handle('exists', (_e, p) => fs.existsSync(p));
ipcMain.handle('version', () => app.getVersion());

/* ───────── 시작 ───────── */
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname).replace(/^\/yb-pdf\/?/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // 외부 글꼴(Pretendard) 외의 웹 요청 권한은 필요 없음
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen'].includes(perm)));
  createMain();
});
app.on('window-all-closed', () => app.quit());

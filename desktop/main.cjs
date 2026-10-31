// PlanMark desktop shell (Electron). Serves the bundled web app from app:// and adds native
// File > Open, Open With / dock drop for PDFs and a native Save dialog that writes straight to disk.
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const APP_DIR = path.join(__dirname, 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf', '.icc': 'application/octet-stream',
};
const OPENABLE = /\.(pdf|png|jpe?g|tiff?|gif|bmp|webp)$/i;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let rendererReady = false;
const pendingPaths = [];
let lastDir = null;

if (!app.requestSingleInstanceLock()) app.quit();

async function sendPaths(paths) {
  const files = [];
  for (const p of paths) {
    if (!OPENABLE.test(p)) continue;
    try {
      files.push({ name: path.basename(p), bytes: new Uint8Array(await fs.readFile(p)) });
      lastDir = path.dirname(p);
      app.addRecentDocument(p);
    } catch (e) {
      dialog.showErrorBox('Could not open file', `${p}\n${e.message}`);
    }
  }
  if (files.length && win) {
    win.webContents.send('open-files', files);
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}
function openPaths(paths) {
  if (rendererReady && win) sendPaths(paths);
  else pendingPaths.push(...paths);
}

// macOS: Finder "Open With", double-click (if default) and dropping files on the dock icon
app.on('open-file', (e, p) => { e.preventDefault(); openPaths([p]); });
// Windows/Linux: files passed on the command line
app.on('second-instance', (_e, argv) => {
  openPaths(argv.slice(1).filter((a) => OPENABLE.test(a)));
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

const cmd = (c) => () => win && win.webContents.send('command', c);

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…', accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const r = await dialog.showOpenDialog(win, {
              properties: ['openFile', 'multiSelections'], defaultPath: lastDir || app.getPath('documents'),
              filters: [{ name: 'PDFs and images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'gif', 'bmp', 'webp'] }],
            });
            if (!r.canceled) openPaths(r.filePaths);
          },
        },
        { role: 'recentDocuments', visible: isMac, submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'Save As / Flatten…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('save-as') },
        { type: 'separator' },
        { label: 'Combine PDFs…', click: cmd('combine') },
        { label: 'Reduce File Size…', click: cmd('reduce') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: cmd('redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: cmd('cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: cmd('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: cmd('paste') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: cmd('select-all') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoom-out') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+1', click: cmd('fit-width') },
        { label: 'Fit Page', accelerator: 'CmdOrCtrl+0', click: cmd('fit-page') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('save-file', async (_e, name, bytes) => {
  const ext = path.extname(name).slice(1).toLowerCase() || 'pdf';
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(lastDir || app.getPath('documents'), name),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, Buffer.from(bytes));
  lastDir = path.dirname(r.filePath);
  if (ext === 'pdf') app.addRecentDocument(r.filePath);
  return r.filePath;
});
ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  if (pendingPaths.length) sendPaths(pendingPaths.splice(0));
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'PlanMark',
    // match the first paint of the Studio Pro theme (dark unless the system is in light mode)
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0C0F' : '#ECEDF1',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.on('closed', () => { win = null; rendererReady = false; });
  win.loadURL('app://planmark/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(APP_DIR, rel));
    if (!file.startsWith(APP_DIR)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.readFile(file);
      return new Response(data, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  buildMenu();
  createWindow();
  const argvFiles = process.argv.slice(1).filter((a) => OPENABLE.test(a));
  if (argvFiles.length) openPaths(argvFiles);
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

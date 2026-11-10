// SheetScale desktop shell (Electron). Serves the bundled web app from app:// and adds native
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

// Mac App Store build (Electron's "mas" flavour, App Sandbox). No auto-update exists in any build;
// the MAS build also hides developer tools.
const IS_MAS = process.mas === true;
const SITE = 'https://somethingaboutandrew-svg.github.io/sheetscale/';

let win = null;
let infoWin = null;
let rendererReady = false;
const pendingPaths = [];
let lastDir = null;

// v1.2 rename (PlanMark -> SheetScale): Electron keeps autosave, recent files and settings in
// <appData>/<productName>. Copy the old PlanMark folder across once so nothing is lost. The old folder
// stays as it was (so an older build still works). The page origin stays app://planmark on purpose,
// because IndexedDB and localStorage are keyed by origin. The Mac App Store build is sandboxed in its
// own container and has never shipped under the old name, so it needs no migration.
function migrateFromPlanMark() {
  if (IS_MAS) return;
  const fsSync = require('node:fs');
  const dest = app.getPath('userData');
  const src = path.join(app.getPath('appData'), 'PlanMark');
  if (src === dest || !fsSync.existsSync(src)) return;
  const has = (d) => ['IndexedDB', 'Local Storage'].some((x) => fsSync.existsSync(path.join(d, x)));
  if (has(dest) || !has(src)) return;
  const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage']);
  try {
    fsSync.mkdirSync(dest, { recursive: true });
    for (const name of fsSync.readdirSync(src)) {
      if (skip.has(name) || name.startsWith('Singleton') || name === 'lockfile') continue;
      fsSync.cpSync(path.join(src, name), path.join(dest, name), { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
    }
  } catch (e) { console.error('PlanMark data migration failed', e); }
}
migrateFromPlanMark();

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
  else {
    pendingPaths.push(...paths);
    if (!win && app.isReady()) createWindow();
  }
}

// Bring the main window back (recreating it if the user closed it). App Review 4.0: closing the
// main window must not leave the app without a way to reopen it.
function showMainWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
        ...(IS_MAS ? [] : [{ role: 'toggleDevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' }]),
      ],
    },
    {
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom', visible: isMac },
        { type: 'separator' },
        { label: 'SheetScale Main Window', accelerator: 'CmdOrCtrl+Shift+0', click: showMainWindow },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'SheetScale Support', click: () => shell.openExternal(SITE + 'support.html') },
        { label: 'Privacy Policy', click: () => shell.openExternal(SITE + 'privacy.html') },
        { type: 'separator' },
        { label: 'Acknowledgements', click: () => showInfo('app://planmark/licenses.html', 'Acknowledgements') },
        { label: 'Chromium Licenses', click: () => showInfo(chromiumLicenses(), 'Chromium Licenses') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Electron puts LICENSES.chromium.html in Contents/Resources on macOS and next to the executable elsewhere.
function chromiumLicenses() {
  const inRes = path.join(process.resourcesPath, 'LICENSES.chromium.html');
  return require('node:fs').existsSync(inRes) ? inRes : path.join(path.dirname(process.execPath), 'LICENSES.chromium.html');
}

// Read-only window for the bundled license pages (no preload, no Node, sandboxed).
function showInfo(target, title) {
  if (infoWin) { infoWin.close(); infoWin = null; }
  infoWin = new BrowserWindow({
    width: 900, height: 760, title, parent: win || undefined, backgroundColor: '#F2F3F5',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  infoWin.setMenuBarVisibility(false);
  infoWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  infoWin.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); });
  infoWin.on('closed', () => { infoWin = null; });
  if (target.startsWith('app://')) infoWin.loadURL(target); else infoWin.loadFile(target);
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
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'SheetScale',
    // match the first paint of the Graphite theme (dark unless the system is in light mode)
    backgroundColor: '#F2F3F5', // light glass is the default theme
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    else if (url === 'app://planmark/licenses.html') showInfo(url, 'Acknowledgements');
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
  app.on('activate', () => showMainWindow());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

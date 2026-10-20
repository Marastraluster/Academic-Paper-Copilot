'use strict';

/**
 * Desktop shell for Academic PDF Copilot.
 *
 * The app is a local web application: a FastAPI backend and a Vite frontend.
 * The shell's whole job is to make that feel like one program:
 *
 * 1. pick an ephemeral loopback port (never a fixed 8000 — another instance, or
 *    someone's dev server, may already own it),
 * 2. start the backend as a child process, pointed at the bundled frontend, so
 *    the window and the API share one origin,
 * 3. open a window once `/api/health` answers, and
 * 4. stop the backend when the last window closes — by asking it to shut down
 *    through its own lifespan, then killing it only if it will not.
 *
 * Running from source (`npm start` in desktop/) uses `backend/.venv` and the
 * already-built `frontend/dist`; the packaged app uses the frozen backend and
 * the resources electron-builder copied next to it.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const APP_TITLE = 'Academic PDF Copilot';
const APP_ID = 'com.sciprograms.academicpdfcopilot';

/** Health polls: 300 ms apart, 90 s ceiling (a cold frozen start is not instant). */
const HEALTH_INTERVAL_MS = 300;
const HEALTH_TIMEOUT_MS = 90_000;

const IS_DEV = !app.isPackaged;
const SMOKE = process.env.APC_SMOKE === '1';

const repoRoot = path.resolve(__dirname, '..', '..');

/** @type {import('node:child_process').ChildProcess | null} */
let backend = null;
/** @type {BrowserWindow | null} */
let window = null;
let backendPort = 0;
let shutdownToken = '';
let logPath = '';
let quitting = false;
let smokeDone = false;

app.setName(APP_TITLE);
app.setAppUserModelId(APP_ID);

// ---------------------------------------------------------------- diagnostics

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (IS_DEV) process.stdout.write(line);
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // A log that cannot be written must never take the app down with it.
  }
}

function tail(file, lines = 25) {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    return text.slice(-lines).join('\n');
  } catch {
    return '(no backend log)';
  }
}

// ------------------------------------------------------------------- paths

function userDataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where the built frontend lives: bundled resources, or the source tree. */
function frontendDir() {
  const bundled = path.join(process.resourcesPath, 'web');
  if (fs.existsSync(path.join(bundled, 'index.html'))) return bundled;
  return path.join(repoRoot, 'frontend', 'dist');
}

/** The pre-seeded babeldoc model/font cache shipped by the installer. */
function bundledCacheDir() {
  if (IS_DEV) return '';
  const dir = path.join(process.resourcesPath, 'babeldoc_cache');
  return fs.existsSync(dir) ? dir : '';
}

function backendCommand() {
  if (IS_DEV) {
    const python = path.join(repoRoot, 'backend', '.venv', 'Scripts', 'python.exe');
    return {
      command: fs.existsSync(python) ? python : 'python',
      args: [path.join(repoRoot, 'backend', 'desktop_entry.py')],
      cwd: path.join(repoRoot, 'backend'),
    };
  }
  const exe = path.join(
    process.resourcesPath,
    'backend',
    process.platform === 'win32' ? 'apc-backend.exe' : 'apc-backend',
  );
  return { command: exe, args: [], cwd: path.dirname(exe) };
}

// -------------------------------------------------------------------- port

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ------------------------------------------------------------------ backend

function startBackend(port) {
  const { command, args, cwd } = backendCommand();
  if (!fs.existsSync(command)) {
    throw new Error(
      `Backend executable not found: ${command}\n` +
        'Build it with scripts/build-desktop.ps1, or run from source with `npm start`.',
    );
  }

  const env = {
    ...process.env,
    APC_PORT: String(port),
    APC_SHUTDOWN_TOKEN: shutdownToken,
    FRONTEND_DIR: frontendDir(),
    APC_BABELDOC_CACHE: bundledCacheDir(),
    // A frozen Windows build would otherwise emit cp936 and die on a non-ASCII
    // log line; uvicorn's reloader must stay off because there is one process.
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
  };

  log(`starting backend: ${command} ${args.join(' ')} (port ${port})`);
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const forward = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) log(`backend| ${line}`);
      }
    });
  };
  forward(child.stdout);
  forward(child.stderr);

  child.on('error', (error) => log(`backend spawn error: ${error.message}`));
  child.on('exit', (code, signal) => {
    log(`backend exited (code ${code}, signal ${signal})`);
    backend = null;
    if (quitting || smokeDone) return;
    dialog.showErrorBox(
      `${APP_TITLE} stopped`,
      `The local backend process exited unexpectedly (code ${code}).\n\n` +
        `Log: ${logPath}\n\n${tail(logPath)}`,
    );
    app.quit();
  });

  return child;
}

function pingHealth(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!backend) throw new Error('The backend process exited before it was ready.');
    if (await pingHealth(port)) return;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
  }
  throw new Error(`The backend did not answer /api/health within 90 seconds.\n\n${tail(logPath)}`);
}

async function stopBackend() {
  if (!backend) return;
  const child = backend;

  const exited = new Promise((resolve) => child.once('exit', resolve));

  // Ask first: the app's lifespan closes the SQLite connection and cancels
  // in-flight jobs. Killing outright would leave a WAL for the next start to
  // recover — survivable, but not clean.
  await postShutdown();
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (graceful) return;

  log('backend ignored the shutdown request; terminating');
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

function postShutdown() {
  return new Promise((resolve) => {
    if (!backendPort || !shutdownToken) return resolve();
    const request = http.request(
      {
        host: '127.0.0.1',
        port: backendPort,
        path: '/api/desktop/shutdown',
        method: 'POST',
        headers: { 'X-Desktop-Token': shutdownToken },
        timeout: 2000,
      },
      (response) => {
        response.resume();
        resolve();
      },
    );
    request.on('error', () => resolve());
    request.on('timeout', () => {
      request.destroy();
      resolve();
    });
    request.end();
  });
}

// ------------------------------------------------------------------- window

function windowStatePath() {
  return path.join(userDataDir(), 'window-state.json');
}

function readWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (Number.isFinite(state.width) && Number.isFinite(state.height)) return state;
  } catch {
    // First run, or a corrupt file: fall through to the defaults.
  }
  return { width: 1440, height: 920 };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const { width, height, x, y } = win.getNormalBounds();
  try {
    fs.writeFileSync(
      windowStatePath(),
      JSON.stringify({ width, height, x, y, maximized: win.isMaximized() }),
      'utf8',
    );
  } catch {
    // Best-effort: losing window geometry is not a failure worth reporting.
  }
}

/**
 * The window is frameless: its title bar is the application's own top bar, so
 * minimise / maximise / close arrive here from the renderer rather than from the
 * OS. Each handler acts on the window that sent the message, never on a captured
 * global — a second window would otherwise be unclosable.
 */
function registerWindowIpc() {
  const sender = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.on('window:minimize', (event) => sender(event)?.minimize());
  ipcMain.on('window:toggle-maximize', (event) => {
    const win = sender(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', (event) => sender(event)?.close());
  ipcMain.handle('window:is-maximized', (event) => Boolean(sender(event)?.isMaximized()));
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(IS_DEV ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开日志文件夹',
          click: () => shell.showItemInFolder(logPath),
        },
        {
          label: `关于 ${APP_TITLE}`,
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: `关于 ${APP_TITLE}`,
              message: APP_TITLE,
              detail:
                `版本 ${app.getVersion()}\n` +
                `本地后端: http://127.0.0.1:${backendPort}\n` +
                `数据目录: ${app.getPath('userData')}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const state = readWindowState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(Number.isFinite(state.x) && Number.isFinite(state.y)
      ? { x: state.x, y: state.y }
      : {}),
    minWidth: 1080,
    minHeight: 700,
    title: APP_TITLE,
    backgroundColor: '#0b0d12',
    show: false,
    // Frameless on purpose. The application's own top bar is the title bar: its
    // buttons are drawn by the app, in the app's own language, so the window does
    // not look like a browser wrapped around a web page. Drag/double-click come
    // from `-webkit-app-region` in `src/index.css`; the three controls talk to
    // the shell through the preload bridge.
    frame: false,
    roundedCorners: true,
    thickFrame: true,
    webPreferences: {
      // The renderer is an ordinary web app talking to loopback over HTTP. It
      // gets no Node and no generic IPC: the preload exposes three window verbs
      // and nothing else.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (state.maximized) win.maximize();

  const notifyMaximized = () => {
    if (win.isDestroyed()) return;
    win.webContents.send('window:maximized-changed', win.isMaximized());
  };
  win.on('maximize', notifyMaximized);
  win.on('unmaximize', notifyMaximized);

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE) runSmoke(win);
  });

  win.on('close', () => saveWindowState(win));
  win.on('closed', () => {
    window = null;
  });

  // Downloads and external links leave the app rather than replacing it: the
  // window is one origin, and a stray link must not navigate it away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${backendPort}`)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(`http://127.0.0.1:${backendPort}/`);
  return win;
}

// -------------------------------------------------------------------- smoke

/**
 * Headless check used by the build script: prove the packaged window renders the
 * real application (not an error page) and write a screenshot for review.
 */
function runSmoke(win) {
  const out = process.env.APC_SMOKE_OUT || path.join(os.tmpdir(), 'apc-smoke.png');

  // Renderer errors are invisible in a packaged build otherwise: no console, no
  // DevTools. Anything the page logs goes into the same log file as the backend.
  win.webContents.on('console-message', (_event, level, message) => {
    log(`renderer[${level}] ${message}`);
  });

  setTimeout(async () => {
    let code = 2;
    try {
      const title = await win.webContents.executeJavaScript('document.title');
      const root = await win.webContents.executeJavaScript(
        'document.querySelector("#root")?.childElementCount ?? 0',
      );
      // The window is frameless: if the app's own controls did not render, the
      // window has no way to be closed except the task manager. Worth asserting.
      const controls = await win.webContents.executeJavaScript(
        'Boolean(document.querySelector("[data-testid=window-controls]"))',
      );

      const image = await win.webContents.capturePage();
      fs.writeFileSync(out, image.toPNG());

      // Not just "the button is in the DOM": press it and look at the window.
      // This is the only check that proves the preload bridge, the IPC handler
      // and the app's own title bar are actually connected.
      const before = win.isMaximized();
      await win.webContents.executeJavaScript(
        'document.querySelector("[data-testid=window-maximize]").click()',
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      const after = win.isMaximized();
      const toggled = before !== after;
      if (after) {
        win.unmaximize();
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      // Minimise and restore, for the same reason: a title-bar button that only
      // looks like a button is the failure this catches.
      await win.webContents.executeJavaScript(
        'document.querySelector("[data-testid=window-minimize]").click()',
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      const minimised = win.isMinimized();
      if (minimised) {
        win.restore();
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      log(
        `smoke: title=${JSON.stringify(title)} rootChildren=${root} ` +
          `windowControls=${controls} maximizeToggled=${toggled} ` +
          `minimizeWorked=${minimised} screenshot=${out}`,
      );
      console.log(
        `SMOKE_OK title=${JSON.stringify(title)} rootChildren=${root} ` +
          `windowControls=${controls} maximizeToggled=${toggled} ` +
          `minimizeWorked=${minimised} out=${out}`,
      );
      code = root > 0 && controls && toggled && minimised ? 0 : 3;
    } catch (error) {
      log(`smoke failed: ${error.message}`);
      console.error(`SMOKE_FAIL ${error.message}`);
    }

    smokeDone = true;
    // A smoke run is a build-time check, not a session: stop the backend now and
    // leave the process hard rather than waiting on window/menu teardown.
    await stopBackend().catch(() => {});
    process.exit(code);
  }, Number(process.env.APC_SMOKE_DELAY_MS || 4000));
}

// --------------------------------------------------------------------- boot

async function boot() {
  logPath = path.join(userDataDir(), 'backend.log');
  shutdownToken = crypto.randomBytes(24).toString('hex');

  backendPort = await findFreePort();
  backend = startBackend(backendPort);
  await waitForBackend(backendPort);
  log(`backend ready on port ${backendPort}`);

  if (!SMOKE) buildMenu();
  registerWindowIpc();
  window = createWindow();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    try {
      await boot();
    } catch (error) {
      log(`boot failed: ${error.stack || error.message}`);
      dialog.showErrorBox(`${APP_TITLE} failed to start`, String(error.message || error));
      quitting = true;
      await stopBackend();
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => {
    // One window is the whole app: closing it quits, on every platform.
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopBackend()
      .catch((error) => log(`shutdown error: ${error.message}`))
      .finally(() => app.quit());
  });
}

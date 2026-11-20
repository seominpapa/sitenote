const { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const { randomBytes } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { origin, port, ownedPage, configureSession, secureContents, bindLocalServer, providerKeysFile } = require('./runtime.cjs');
const { createUpdater } = require('./updater.cjs');
const { registerUpdateIpc } = require('./update-ipc.cjs');

const runtimeRoot = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(__dirname, '..');
let server;
let window;
let partition;
let shuttingDown = false;

function focusWindow() {
  if (!window || window.isDestroyed() || !window.isVisible()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

function stopWithError(error) {
  if (shuttingDown) return;
  shuttingDown = true;
  const message = error?.code === 'EADDRINUSE'
    ? '로컬 연결 포트 ' + port + '을 이미 사용하고 있습니다. 해당 프로그램을 종료한 뒤 Sitenote를 다시 실행하세요.'
    : 'Sitenote를 시작하지 못했습니다. 앱을 다시 실행하거나 설치 파일을 확인하세요.';
  dialog.showErrorBox('Sitenote', message);
  app.quit();
}

function microphoneGranted() {
  return process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted';
}

function requestMicrophone() {
  if (microphoneGranted()) return true;
  if (systemPreferences.getMediaAccessStatus('microphone') !== 'not-determined') return false;
  return systemPreferences.askForMediaAccess('microphone');
}

async function createWindow() {
  const next = new BrowserWindow({
    width: 1200, height: 820, minWidth: 420, minHeight: 620, title: 'Sitenote', show: false,
    backgroundColor: '#f6f6f2',
    webPreferences: {
      session: partition, preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, devTools: !app.isPackaged,
    },
  });
  window = next;
  secureContents(next.webContents);
  next.on('closed', () => { if (window === next) window = undefined; });
  let loadedApp = false;
  next.webContents.once('did-navigate', (event, legacyUrl, legacyCode) => {
    loadedApp = ownedPage(event.url ?? legacyUrl) && (event.httpResponseCode ?? legacyCode) === 200;
  });
  await next.loadURL(origin + '/');
  if (!loadedApp) throw new Error('로컬 앱 화면을 열지 못했습니다.');
  if (!next.isDestroyed()) next.show();
}

async function start() {
  const { createApp } = await import(pathToFileURL(join(runtimeRoot, 'server', 'app.mjs')).href);
  const desktopToken = randomBytes(32).toString('hex');
  server = createApp({
    accessToken: randomBytes(32).toString('hex'),
    desktopToken,
    webRoot: join(runtimeRoot, 'dist', 'web'),
    webKeysFile: providerKeysFile(),
    openaiKey: process.env.OPENAI_API_KEY,
    sonioxKey: process.env.SONIOX_API_KEY,
    textModel: process.env.OPENAI_TEXT_MODEL,
  });
  await bindLocalServer(server);
  server.on('error', stopWithError);
  partition = session.fromPartition('persist:sitenote-desktop');
  const version = app.getVersion();
  registerUpdateIpc(ipcMain, () => window?.webContents, version,
    createUpdater({currentVersion:version, userData:app.getPath('userData'), platform:process.platform, arch:process.arch}),
    async path => {
      if (process.platform === 'darwin') {
        if (await shell.openPath(path)) throw new Error('업데이트 디스크 이미지를 열지 못했습니다.');
      } else {
        shell.showItemInFolder(path);
      }
    });
  await configureSession(partition, desktopToken, () => window?.webContents, requestMicrophone, microphoneGranted);
  await createWindow();
}

const explicitProfile = app.commandLine.getSwitchValue('user-data-dir');
const profile = explicitProfile && isAbsolute(explicitProfile) ? explicitProfile : join(app.getPath('appData'), 'Sitenote Desktop');
try {
  mkdirSync(profile, {recursive: true, mode: 0o700});
  app.setPath('userData', profile);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', focusWindow);
    app.on('window-all-closed', () => app.quit());
    app.on('will-quit', () => {
      shuttingDown = true;
      if (server?.listening) {
        server.close();
        server.closeAllConnections();
      }
    });
    app.whenReady().then(start).catch(stopWithError);
  }
} catch (error) {
  stopWithError(error);
}

// Run with the local Electron executable; uses software-generated media only.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { configureSession, secureContents, bindLocalServer, origin } = require('../runtime.cjs');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.on('window-all-closed', () => {});
const guard = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 20_000);

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'sitenote-electron-smoke-'));
  let server;
  let window;
  try {
    app.setPath('userData', dir);
    await app.whenReady();
    const { createApp } = await import(pathToFileURL(join(__dirname, '..', '..', 'server', 'app.mjs')).href);
    await writeFile(join(dir, 'index.html'), '<title>Sitenote desktop test</title>');
    const token = randomBytes(32).toString('hex');
    server = createApp({webRoot:dir, desktopToken:token, accessToken:randomBytes(32).toString('hex')});
    await bindLocalServer(server);
    const partition = session.fromPartition('sitenote-desktop-smoke');
    await configureSession(partition, token, () => window?.webContents, () => true);
    window = new BrowserWindow({
      show:false,
      webPreferences:{session:partition, nodeIntegration:false, contextIsolation:true, sandbox:true},
    });
    secureContents(window.webContents);
    assert.equal((await fetch(origin + '/')).status, 403);
    assert.equal((await fetch(origin + '/health')).status, 403);
    await window.loadURL(origin + '/');
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        const health = await fetch('/health').then(r => r.json());
        const audioTracks = await navigator.mediaDevices.getUserMedia({audio:true}).then(audio => {
          const count = audio.getAudioTracks().length;
          audio.getTracks().forEach(track => track.stop());
          return count;
        }, error => error.name + ': ' + error.message);
        const cameraDenied = await navigator.mediaDevices.getUserMedia({video:true}).then(
          video => { video.getTracks().forEach(track => track.stop()); return false }, () => true);
        const ws = new WebSocket('ws://' + location.host + '/stream');
        await new Promise((resolve, reject) => {
          ws.onerror = () => reject(new Error('Desktop socket did not open'));
          ws.onopen = () => ws.close();
          ws.onclose = resolve;
        });
        return {title:document.title, health, audioTracks, cameraDenied};
      })().catch(error => ({pageError:error.name + ': ' + error.message}));
    `);
    assert.equal(result.pageError, undefined);
    assert.equal(result.title, 'Sitenote desktop test');
    assert.deepEqual(result.health, {ok:true,providers:{live:false,soniox:false,text:false}});
    assert.equal(result.audioTracks, 1);
    assert.equal(result.cameraDenied, true);
    console.log('Desktop Chromium: scoped HTTP and WebSocket connected, audio accepted, camera and outside HTTP denied');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (server?.listening) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    await rm(dir, {recursive:true,force:true});
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); }).finally(() => clearTimeout(guard));

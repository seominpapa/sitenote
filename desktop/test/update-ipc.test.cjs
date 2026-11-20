const test = require('node:test');
const assert = require('node:assert/strict');
const { origin } = require('../runtime.cjs');
const { registerUpdateIpc } = require('../update-ipc.cjs');

test('update IPC accepts only the owned main frame and opens only the verified path', async () => {
  const callbacks = new Map();
  const contents = {mainFrame:{url:origin + '/'}};
  const event = {sender:contents, senderFrame:contents.mainFrame};
  let opened;
  const verified = '/private/verified.dmg';
  registerUpdateIpc({handle:(name, fn) => callbacks.set(name, fn)}, () => contents, '0.1.1',
    {verifiedFile:async () => ({path:verified})}, path => {opened = path;});
  const open = callbacks.get('sitenote:update-open');
  assert.throws(() => open({...event, sender:{}}), /허용되지/);
  assert.throws(() => open({...event, senderFrame:{url:origin + '/'}}), /허용되지/);
  assert.throws(() => open(event, '/untrusted.exe'), /허용되지/);
  assert.equal(opened, undefined);
  assert.equal(await open(event), true);
  assert.equal(opened, verified);
  assert.equal(callbacks.get('sitenote:version')(event), '0.1.1');
});

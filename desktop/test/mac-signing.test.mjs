import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMacSigningReady, notarizeMacDmg } from '../mac-signing.mjs';

test('Mac packaging stops before notarization if there is no Developer ID Application identity', async () => {
  const run = async command => {
    assert.equal(command, 'security');
    return { stdout: '1) ABC "Apple Development: Example"\n 1 valid identities found' };
  };
  await assert.rejects(assertMacSigningReady(run), /Developer ID Application/);
});

test('an untrusted DMG is never sent to Apple', async () => {
  const run = async (command, args) => {
    assert.equal(command, 'codesign');
    assert.match(args[3], /anchor apple generic.*1\.2\.840\.113635\.100\.6\.1\.13/);
    throw new Error('code failed to satisfy specified code requirement');
  };
  await assert.rejects(notarizeMacDmg('/tmp/Sitenote.dmg', 'Sitenote', run), /failed to satisfy/);
});

test('a rejected Apple submission is never stapled', async () => {
  const run = async (command, args) => {
    if (command === 'codesign') return {};
    assert.equal(args[1], 'submit');
    return { stdout: '{"status":"Invalid","id":"example-id"}' };
  };
  await assert.rejects(notarizeMacDmg('/tmp/Sitenote.dmg', 'Sitenote', run), /Invalid.*example-id/);
});

test('a signed and accepted DMG is stapled and verified before it can be published', async () => {
  const operations = [];
  const run = async (command, args) => {
    operations.push([command, ...args.slice(0, 2)].join(' '));
    return {
      stdout: '{"status":"Accepted","id":"example-id"}',
    };
  };
  await notarizeMacDmg('/tmp/Sitenote.dmg', 'Sitenote', run);
  assert.deepEqual(operations, [
    'codesign --verify --strict',
    'xcrun notarytool submit',
    'xcrun stapler staple',
    'codesign --verify --strict',
    'xcrun stapler validate',
  ]);
});

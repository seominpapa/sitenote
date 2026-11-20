import assert from 'node:assert/strict';
import test from 'node:test';
import { citationParts, compactParts, draftContext, splitContext, validateConnection } from '../src/workflow.ts';

test('the app token cannot be placed in URL credentials or query strings', () => {
  for (const url of ['http://192.168.0.5:8787', 'https://a:b@site.local', 'https://site.local?key=secret', 'https://site.local/#secret', 'https://site.local/base']) {
    assert.throws(() => validateConnection(url, 'a'.repeat(36)));
  }
  assert.throws(() => validateConnection('https://site.local', 'short'));
  assert.deepEqual(validateConnection('https://site.local/', 'a'.repeat(36)), { url: 'https://site.local', token: 'a'.repeat(36) });
  assert.equal(validateConnection('http://10.0.2.2:8787', 'a'.repeat(36)).url, 'http://10.0.2.2:8787');
});

test('only available, in-scope record references become navigable', () => {
  const refs = new Set(['[record:r-1#t-1]', '[record:r-1#summary]']);
  assert.deepEqual(citationParts('결정 [record:r-1#t-1] [record:private#t-4]', refs),
    [{text:'결정 '}, {text:'[record:r-1#t-1]', reference:'[record:r-1#t-1]'}, {text:' [record:private#t-4]'}]);
});

test('long input is split without dropping evidence or cutting Unicode characters', () => {
  const source = '처음\n' + '🙂'.repeat(16) + '\n마지막';
  const parts = splitContext(source, 11);
  assert.equal(parts.join(''), source);
  assert.ok(parts.every(part => part.length <= 11 && !/[\uD800-\uDBFF]$/u.test(part)));
  const grouped = compactParts(['one', 'two', 'four'], 8);
  assert.deepEqual(grouped, ['one\ntwo', 'four']);
});

test('multi-stage summary retains authorized source labels for the next stage', () => {
  const draft = '결정 [record:r-1#t-1]과 제안 [record:r-2#t-2]은 별개다.';
  const context = '[record:r-1#t-1]\n{"text":"결정"}\n\n{"text":"[record:r-2#t-2]"}';
  assert.equal(draftContext(draft, ['누가 맡지?'], context),
    '[record:r-1#t-1]\n{"markdown":"결정 [record:r-1#t-1]과 제안 은 별개다.","questions":["누가 맡지?"]}');
});

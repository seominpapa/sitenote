import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotedReferences } from '../voice-quotes.mjs';

const first = '[record:past#turn-1]';
const second = '[record:past#turn-2]';
const excerpts = [
  { reference:first, excerpt:'현장 출입은 \n오전 여덟 시부터 가능합니다. 공통 점검표가 준비되었습니다.' },
  { reference:second, excerpt:'공통 점검표가 준비되었습니다. 오전 열 시에 안전 교육을 합니다. ................' },
];

test('verifies only uniquely identifiable verbatim quotations, normalizing whitespace', () => {
  assert.deepEqual(quotedReferences(
    '“공통 점검표가 준비되었습니다.” "공통 점검표" 「현장 출입은 오전 여덟 시부터 가능합니다.」 “오전 열 시에 안전 교육을 합니다.”',
    excerpts,
  ), [first, second]);
  assert.deepEqual(quotedReferences('"현장 출입은   오전 여덟 시부터 가능합니다."', excerpts), [first]);
  for (const response of [
    '공통 점검표가 준비되었습니다.',
    '“공통 점검표가 준비되었습니다.”',
    '“오전 8시부터 출입할 수 있습니다.”',
    '「오전 열 시에 안전 교육을',
    '"................"',
  ]) assert.deepEqual(quotedReferences(response, excerpts), [], response);
});

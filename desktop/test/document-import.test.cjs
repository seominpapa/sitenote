const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const CFB = require('cfb');
const { deflateRawSync } = require('node:zlib');
const { test } = require('node:test');

const {
  convertDocument,
  documentExtensions,
  maxDocumentBytes,
  maxDocumentTextLength,
} = require('../../src/records/document-converter.cjs');

const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, method = 8) {
  const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
  const files = [];
  const directory = [];
  let offset = 0;

  for (const [name, source] of pairs) {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(source);
    const compressed = method === 0 ? bytes : deflateRawSync(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    files.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(pairs.length, 8);
  end.writeUInt16LE(pairs.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, centralBytes, end]);
}

function hwp({text = '한글 회의록', flags = 1} = {}) {
  const fileHeader = Buffer.alloc(256);
  fileHeader.write('HWP Document File', 0, 'ascii');
  fileHeader.writeUInt32LE(0x05000000, 32);
  fileHeader.writeUInt32LE(flags, 36);
  const payload = Buffer.from(text, 'utf16le');
  const extended = payload.length >= 0xfff;
  const record = Buffer.alloc((extended ? 8 : 4) + payload.length);
  record.writeUInt32LE((67 | ((extended ? 0xfff : payload.length) << 20)) >>> 0, 0);
  if (extended) record.writeUInt32LE(payload.length, 4);
  payload.copy(record, extended ? 8 : 4);
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, 'FileHeader', fileHeader);
  CFB.utils.cfb_add(cfb, 'BodyText/Section0', flags & 1 ? deflateRawSync(record) : record);
  return CFB.write(cfb, {type: 'buffer'});
}

function utf16be(text) {
  const bytes = Buffer.from(text, 'utf16le');
  for (let index = 0; index < bytes.length; index += 2) {
    [bytes[index], bytes[index + 1]] = [bytes[index + 1], bytes[index]];
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bytes]);
}

test('exports the local document types exposed by the desktop picker', () => {
  assert.deepEqual(documentExtensions, ['txt', 'md', 'markdown', 'docx', 'hwpx', 'hwp', 'doc']);
  assert.ok(maxDocumentBytes >= 1024 * 1024);
  assert.equal(maxDocumentTextLength, 250_000);
});

test('loads and converts Uint8Array without a global Buffer', () => {
  const modulePath = require.resolve('../../src/records/document-converter.cjs');
  const hwpBase64 = hwp({text: 'Hermes 한글'}).toString('base64');
  const script = `global.Buffer=undefined;global.process=undefined;const c=require(${JSON.stringify(modulePath)});`
    + `const h=Uint8Array.from(atob(${JSON.stringify(hwpBase64)}),x=>x.charCodeAt(0));`
    + `Promise.all([c.convertDocument('note.md',Uint8Array.from([35,32,111,107])),c.convertDocument('note.hwp',h)])`
    + `.then(v=>{if(v[0]!=='# ok'||v[1]!=='Hermes 한글')throw Error('wrong conversion')});`;
  execFileSync(process.execPath, ['-e', script]);
});

test('converts UTF-8 and Korean UTF-16 text without changing Markdown', async () => {
  assert.equal(await convertDocument('meeting.md', Buffer.from('# 회의\n\n- 결정')), '# 회의\n\n- 결정');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('현장 회의', 'utf16le')]);
  assert.equal(await convertDocument('meeting.txt', utf16), '현장 회의');
  assert.equal(await convertDocument('meeting.txt', utf16be('본사 회의')), '본사 회의');
  assert.equal(await convertDocument('meeting.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b])), 'ok');
  await assert.rejects(convertDocument('bad.txt', Buffer.from([0xff])), /UTF-8/i);
});

test('converts DOCX paragraphs, tabs, breaks and XML entities to plain Markdown text', async () => {
  const document = '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>'
    + '<w:p><w:r><w:t>안전 &amp; 품질</w:t></w:r><w:tab/><w:r><w:t>점검</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>둘째 줄</w:t><w:br/><w:t>계속</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  assert.equal(await convertDocument('회의.DOCX', zip({'word/document.xml': document})),
    '안전 & 품질\t점검\n\n둘째 줄\n계속');
  const numeric = '<w:document><w:p><w:t>&#54620;&#xAE00; &quot;회의&quot; &apos;록&apos;</w:t></w:p></w:document>';
  assert.equal(await convertDocument('entities.docx', zip({'word/document.xml': numeric})), '한글 "회의" \'록\'');
  assert.equal(await convertDocument('stored.docx', zip({'word/document.xml': numeric}, 0)), '한글 "회의" \'록\'');
  const invalidEntity = '<w:document><w:p><w:t>&#xD800;</w:t></w:p></w:document>';
  assert.equal(await convertDocument('invalid-entity.docx', zip({'word/document.xml': invalidEntity})), '\ufffd');
});

test('converts ordered HWPX sections and rejects image-only documents', async () => {
  const hwpx = zip({
    'Contents/section1.xml': '<hs:sec><hp:p><hp:run><hp:t>두 번째</hp:t></hp:run></hp:p></hs:sec>',
    'Contents/section0.xml': '<hs:sec><hp:p><hp:run><hp:t>첫 번째</hp:t></hp:run></hp:p></hs:sec>',
  });
  assert.equal(await convertDocument('회의.hwpx', hwpx), '첫 번째\n\n두 번째');
  await assert.rejects(convertDocument('scan.hwpx', zip({
    'Contents/section0.xml': '<hs:sec><hp:p><hp:run><hp:pic/></hp:run></hp:p></hs:sec>',
  })), /image-only|텍스트/i);
});

test('converts compressed HWP v5 paragraph records and rejects protected files', async () => {
  assert.equal(await convertDocument('현장회의.hwp', hwp()), '한글 회의록');
  assert.equal(await convertDocument('plain.hwp', hwp({text: '압축 없음', flags: 0})), '압축 없음');
  assert.equal(await convertDocument('controls.hwp', hwp({text: 'A\t1234567B\nC\u0001abcdefgD'})), 'A\tB\nCD');
  assert.equal((await convertDocument('long.hwp', hwp({text: '가'.repeat(2500)}))).length, 2500);
  await assert.rejects(convertDocument('protected.hwp', hwp({flags: 2})), /protected|encrypted|암호/i);
});

test('rejects oversized, encrypted, malformed and unsupported documents explicitly', async () => {
  await assert.rejects(convertDocument('large.txt', Buffer.alloc(maxDocumentBytes + 1)), /too large|크기/i);

  const encrypted = zip({'word/document.xml': '<w:document><w:p><w:t>secret</w:t></w:p></w:document>'});
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(encrypted.indexOf(Buffer.from('PK\x01\x02')) + 8) | 1,
    encrypted.indexOf(Buffer.from('PK\x01\x02')) + 8);
  await assert.rejects(convertDocument('encrypted.docx', encrypted), /encrypted|암호/i);
  await assert.rejects(convertDocument('bad.docx', Buffer.from('not a zip')), /invalid|올바른/i);
  await assert.rejects(convertDocument('legacy.doc', Buffer.from('legacy')), /unsupported|지원하지/i);
  await assert.rejects(convertDocument('notes.pdf', Buffer.from('pdf')), /unsupported|지원하지/i);
  await assert.rejects(convertDocument('', Buffer.from('text')), /filename/i);
  await assert.rejects(convertDocument('notes.txt', 'not bytes'), /bytes/i);
  await assert.rejects(convertDocument('empty.txt', Buffer.alloc(0)), /image-only|텍스트/i);
  await assert.rejects(convertDocument('missing.docx', zip({'other.xml': '<x/>'})), /document\.xml/i);
  await assert.rejects(convertDocument('missing.hwpx', zip({'Contents/content.hpf': '<x/>'})), /section XML/i);
  await assert.rejects(convertDocument('entity.docx', zip({
    'word/document.xml': '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><w:p><w:t>&leak;</w:t></w:p>',
  })), /entities/i);
  await assert.rejects(convertDocument('bad.hwp', Buffer.alloc(512)), /invalid HWP/i);
  await assert.rejects(convertDocument('long.txt', Buffer.alloc(maxDocumentTextLength + 1, 0x61)), (error) => {
    assert.equal(error.code, 'DOCUMENT_IMPORT_ERROR');
    return /converted text is too large/i.test(error.message);
  });
  await assert.rejects(convertDocument('long.docx', zip({
    'word/document.xml': `<w:p><w:t>${'a'.repeat(maxDocumentTextLength + 1)}</w:t></w:p>`,
  })), /converted text is too large/i);
  await assert.rejects(convertDocument('long.hwp', hwp({text: '가'.repeat(maxDocumentTextLength + 1)})),
    /converted text is too large/i);
});

test('rejects ambiguous ZIP headers, duplicate names, bad CRC and invalid XML UTF-8', async () => {
  const xml = '<w:document><w:p><w:t>회의</w:t></w:p></w:document>';
  await assert.rejects(convertDocument('duplicate.docx', zip([
    ['word/document.xml', xml], ['word/document.xml', xml],
  ])), /duplicate/i);

  const mismatch = zip({'word/document.xml': xml});
  mismatch.writeUInt16LE(0, 8);
  await assert.rejects(convertDocument('method.docx', mismatch), /header|method/i);

  const localEncrypted = zip({'word/document.xml': xml});
  localEncrypted.writeUInt16LE(1, 6);
  await assert.rejects(convertDocument('local-encrypted.docx', localEncrypted), /encrypted|header/i);

  const wrongName = zip({'word/document.xml': xml});
  wrongName[30] ^= 1;
  await assert.rejects(convertDocument('name.docx', wrongName), /filename|header/i);

  const badCrc = zip({'word/document.xml': xml});
  const central = badCrc.indexOf(Buffer.from('PK\x01\x02'));
  badCrc.writeUInt32LE(0x12345678, central + 16);
  await assert.rejects(convertDocument('crc.docx', badCrc), /CRC/i);

  const prefix = Buffer.from('<w:document><w:p><w:t>');
  const suffix = Buffer.from('</w:t></w:p></w:document>');
  await assert.rejects(convertDocument('utf8.docx', zip({
    'word/document.xml': Buffer.concat([prefix, Buffer.from([0xff]), suffix]),
  })), /UTF-8/i);

  const bomb = zip({'word/document.xml': 'a'.repeat(2 * 1024 * 1024)});
  const bombCentral = bomb.indexOf(Buffer.from('PK\x01\x02'));
  bomb.writeUInt32LE(crc32(Buffer.from('a')), bombCentral + 16);
  bomb.writeUInt32LE(1, bombCentral + 24);
  bomb.writeUInt32LE(crc32(Buffer.from('a')), 14);
  bomb.writeUInt32LE(1, 22);
  await assert.rejects(convertDocument('bomb.docx', bomb), /expanded document is too large/i);

  const section = '가'.repeat(150_000);
  await assert.rejects(convertDocument('aggregate.hwpx', zip({
    'Contents/section0.xml': `<hp:p><hp:t>${section}</hp:t></hp:p>`,
    'Contents/section1.xml': `<hp:p><hp:t>${section}</hp:t></hp:p>`,
  })), /converted text is too large/i);
});

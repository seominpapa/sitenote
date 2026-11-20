// ZIP STORE works on both the browser and native without a compression runtime.
const maxSize = 0xffff_ffff;

const crcTable = Uint32Array.from({length: 256}, (_, index) => {
  let crc = index;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  return crc;
});

function crc32(bytes: Uint8Array) {
  let crc = maxSize;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ maxSize) >>> 0;
}

export function zipTextFiles(files: readonly (readonly [string, string])[]) {
  const encoder = new TextEncoder();
  const entries = files.map(([name, text]) => ({name: encoder.encode(name), data: encoder.encode(text)}));
  const locals = entries.reduce((size, {name, data}) => size + 30 + name.length + data.length, 0);
  const directory = entries.reduce((size, {name}) => size + 46 + name.length, 0);
  if (locals + directory + 22 >= maxSize || entries.length >= 0xffff || entries.some(({name}) => name.length > 0xffff)) {
    throw Error('내보낼 파일이 너무 큽니다.');
  }

  const archive = new Uint8Array(locals + directory + 22);
  const view = new DataView(archive.buffer);
  let local = 0;
  let central = locals;
  for (const {name, data} of entries) {
    view.setUint32(local, 0x04034b50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint16(local + 6, 0x0800, true); // UTF-8 names.
    view.setUint16(local + 12, 0x21, true); // Fixed date: 1980-01-01.
    view.setUint32(local + 14, crc32(data), true);
    view.setUint32(local + 18, data.length, true);
    view.setUint32(local + 22, data.length, true);
    view.setUint16(local + 26, name.length, true);
    archive.set(name, local + 30);
    archive.set(data, local + 30 + name.length);

    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    archive.copyWithin(central + 6, local + 4, local + 28);
    view.setUint32(central + 42, local, true);
    archive.set(name, central + 46);
    local += 30 + name.length + data.length;
    central += 46 + name.length;
  }

  view.setUint32(central, 0x06054b50, true);
  view.setUint16(central + 8, entries.length, true);
  view.setUint16(central + 10, entries.length, true);
  view.setUint32(central + 12, directory, true);
  view.setUint32(central + 16, locals, true);
  return archive;
}

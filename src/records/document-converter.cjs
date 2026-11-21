/// <reference path="./document-converter.d.cts" />

const CFB = require('cfb');
const { Inflate } = require('fflate');

const maxDocumentBytes = 20 * 1024 * 1024;
const maxExpandedBytes = 64 * 1024 * 1024;
const maxDocumentTextLength = 250_000;
const maxZipEntries = 2048;
const documentExtensions = ['txt', 'md', 'markdown', 'docx', 'hwpx', 'hwp', 'pdf', 'doc'];

class DocumentImportError extends Error {
  constructor(message) {
    super(`Document import failed: ${message}`);
    this.code = 'DOCUMENT_IMPORT_ERROR';
  }
}

function documentError(message) {
  return new DocumentImportError(message);
}

const u16 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
const u32 = (bytes, offset) => (bytes[offset] | (bytes[offset + 1] << 8)
  | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
const i32 = (bytes, offset) => u32(bytes, offset) | 0;

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function inputBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw documentError('document data must be Uint8Array bytes');
  if (bytes.byteLength > maxDocumentBytes) throw documentError('document is too large');
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function nonEmpty(text) {
  const result = text.replace(/\r\n?/g, '\n')
    .split('\n').map((line) => line.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!result) throw documentError('document is image-only or contains no readable text');
  if (result.length > maxDocumentTextLength) throw documentError('converted text is too large');
  return result;
}

function decodeUtf8(bytes) {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let codePoint;
    let remaining;
    if (first <= 0x7f) { codePoint = first; remaining = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { codePoint = first & 0x1f; remaining = 1; }
    else if (first >= 0xe0 && first <= 0xef) { codePoint = first & 0x0f; remaining = 2; }
    else if (first >= 0xf0 && first <= 0xf4) { codePoint = first & 0x07; remaining = 3; }
    else throw documentError('invalid UTF-8 text');
    if (index + remaining > bytes.length) throw documentError('invalid UTF-8 text');
    for (let part = 0; part < remaining; part += 1) {
      const next = bytes[index++];
      if ((next & 0xc0) !== 0x80) throw documentError('invalid UTF-8 text');
      if (part === 0 && ((first === 0xe0 && next < 0xa0) || (first === 0xed && next >= 0xa0)
        || (first === 0xf0 && next < 0x90) || (first === 0xf4 && next >= 0x90))) {
        throw documentError('invalid UTF-8 text');
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    result += String.fromCodePoint(codePoint);
  }
  return result;
}

function decodeUtf16(bytes, bigEndian = false) {
  if (bytes.length % 2) throw documentError('invalid UTF-16 text');
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const end = Math.min(offset + 4096, bytes.length);
    const units = new Array((end - offset) / 2);
    for (let index = offset; index < end; index += 2) {
      units[(index - offset) / 2] = bigEndian ? (bytes[index] << 8) | bytes[index + 1] : u16(bytes, index);
    }
    parts.push(String.fromCharCode.apply(null, units));
  }
  return parts.join('');
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes.subarray(2), true);
  return decodeUtf8(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes);
}

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

function inflateBounded(compressed, limit, expectedSize) {
  const output = expectedSize === undefined ? undefined : new Uint8Array(expectedSize);
  const chunks = [];
  let length = 0;
  const inflater = new Inflate((chunk) => {
    if (length + chunk.length > limit) throw documentError('expanded document is too large');
    if (output) output.set(chunk, length);
    else chunks.push(chunk.slice());
    length += chunk.length;
  });
  for (let offset = 0; offset < compressed.length; offset += 4096) {
    const end = Math.min(offset + 4096, compressed.length);
    inflater.push(compressed.subarray(offset, end), end === compressed.length);
  }
  if (!compressed.length) inflater.push(new Uint8Array(), true);
  if (expectedSize !== undefined) {
    if (length !== expectedSize) throw documentError('invalid expanded document size');
    return output;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function findEndRecord(bytes) {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50) return offset;
  }
  throw documentError('invalid ZIP document');
}

function readZip(bytes) {
  const end = findEndRecord(bytes);
  const entryCount = u16(bytes, end + 10);
  const directorySize = u32(bytes, end + 12);
  const directoryOffset = u32(bytes, end + 16);
  if (u16(bytes, end + 4) || u16(bytes, end + 6) || u16(bytes, end + 8) !== entryCount
    || end + 22 + u16(bytes, end + 20) !== bytes.length) {
    throw documentError('multi-disk or trailing ZIP data is unsupported');
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw documentError('ZIP64 documents are unsupported');
  }
  if (entryCount > maxZipEntries || directoryOffset + directorySize > end) {
    throw documentError('invalid or excessively complex ZIP document');
  }

  const entries = new Map();
  let offset = directoryOffset;
  let expanded = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || u32(bytes, offset) !== 0x02014b50) {
      throw documentError('invalid ZIP directory');
    }
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const checksum = u32(bytes, offset + 16);
    const compressedSize = u32(bytes, offset + 20);
    const size = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw documentError('invalid ZIP directory entry');
    if (flags & 1) throw documentError('encrypted documents are unsupported');
    if (method !== 0 && method !== 8) throw documentError('unsupported ZIP compression');
    expanded += size;
    if (size > maxExpandedBytes || expanded > maxExpandedBytes) {
      throw documentError('expanded document is too large');
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeUtf8(nameBytes).replace(/\\/g, '/');
    if (entries.has(name)) throw documentError('duplicate ZIP filename');
    if (localOffset + 30 > directoryOffset || u32(bytes, localOffset) !== 0x04034b50) {
      throw documentError('invalid ZIP local header');
    }
    const localFlags = u16(bytes, localOffset + 6);
    const localMethod = u16(bytes, localOffset + 8);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localFlags !== flags || localMethod !== method || !sameBytes(localName, nameBytes)) {
      throw documentError('ZIP local header filename, flags, or method mismatch');
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > directoryOffset) throw documentError('invalid ZIP entry size');
    entries.set(name, {method, size, checksum, compressed: bytes.subarray(dataOffset, dataOffset + compressedSize)});
    offset = next;
  }
  if (offset !== directoryOffset + directorySize) throw documentError('invalid ZIP directory size');
  return entries;
}

function unzipEntry(entry) {
  let content;
  try {
    content = entry.method === 0 ? entry.compressed.slice()
      : inflateBounded(entry.compressed, entry.size, entry.size);
  } catch (error) {
    throw error instanceof DocumentImportError ? error : documentError('invalid compressed document data');
  }
  if (content.length !== entry.size) throw documentError('invalid expanded document size');
  if (crc32(content) !== entry.checksum) throw documentError('document ZIP CRC check failed');
  return content;
}

function decodeXml(value) {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hex) => {
    if (decimal || hex) {
      const codePoint = Number.parseInt(decimal || hex, decimal ? 10 : 16);
      return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint) : '\ufffd';
    }
    return ({'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"})[entity.toLowerCase()];
  });
}

function xmlText(xml, paragraphName) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw documentError('XML declarations with entities are unsupported');
  const token = /<([\w.-]+:)?(t|tab|br|lineBreak|p)\b[^>]*>|<\/([\w.-]+:)?(t|p)\s*>|([^<]+)/gi;
  let inText = false;
  let output = '';
  for (const match of xml.matchAll(token)) {
    const open = match[2];
    const close = match[4];
    if (open === 't') inText = true;
    else if (open === 'tab') output += '\t';
    else if (open === 'br' || open === 'lineBreak') output += '\n';
    else if (close === 't') inText = false;
    else if (close === paragraphName) output += '\n\n';
    else if (inText && match[5]) output += decodeXml(match[5]);
    if (output.length > maxDocumentTextLength) throw documentError('converted text is too large');
  }
  return output;
}

function convertDocx(bytes) {
  const entry = readZip(bytes).get('word/document.xml');
  if (!entry) throw documentError('invalid DOCX: word/document.xml is missing');
  return nonEmpty(xmlText(decodeUtf8(unzipEntry(entry)), 'p'));
}

function convertHwpx(bytes) {
  const sections = [...readZip(bytes)].filter(([name]) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort(([left], [right]) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]));
  if (!sections.length) throw documentError('invalid HWPX: section XML is missing');
  let output = '';
  for (const [, entry] of sections) {
    output += (output ? '\n\n' : '') + xmlText(decodeUtf8(unzipEntry(entry)), 'p');
    if (output.length > maxDocumentTextLength) throw documentError('converted text is too large');
  }
  return nonEmpty(output);
}

function preflightCfb(bytes) {
  const signature = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (bytes.length < 512 || !sameBytes(bytes.subarray(0, 8), signature)) throw documentError('invalid HWP v5 document');
  const major = u16(bytes, 26);
  const sectorSize = 2 ** u16(bytes, 30);
  if (!((major === 3 && sectorSize === 512) || (major === 4 && sectorSize === 4096))
    || bytes.length % sectorSize) {
    throw documentError('invalid CFB sector format');
  }
  const physicalSectors = Math.floor(bytes.length / sectorSize) - 1;
  const validSector = (id) => Number.isInteger(id) && id >= 0 && id < physicalSectors;
  const sector = (id) => bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  const fatSectors = [];
  for (let offset = 76; offset < 512; offset += 4) {
    const id = i32(bytes, offset);
    if (id < 0) break;
    if (!validSector(id)) throw documentError('invalid CFB FAT sector');
    fatSectors.push(id);
  }
  let difat = i32(bytes, 68);
  const difatCount = u32(bytes, 72);
  if (difatCount > physicalSectors) throw documentError('invalid CFB DIFAT count');
  const seenDifat = new Set();
  for (let count = 0; count < difatCount; count += 1) {
    if (!validSector(difat) || seenDifat.has(difat)) throw documentError('invalid CFB DIFAT chain');
    seenDifat.add(difat);
    const data = sector(difat);
    for (let offset = 0; offset < sectorSize - 4; offset += 4) {
      const id = i32(data, offset);
      if (id < 0) break;
      if (!validSector(id)) throw documentError('invalid CFB FAT sector');
      fatSectors.push(id);
    }
    difat = i32(data, sectorSize - 4);
  }
  if (!fatSectors.length || fatSectors.length > physicalSectors) throw documentError('invalid CFB FAT');
  const nextSector = (id) => {
    if (!validSector(id)) throw documentError('invalid CFB chain');
    const fat = fatSectors[Math.floor(id / (sectorSize / 4))];
    if (!validSector(fat)) throw documentError('invalid CFB FAT chain');
    return i32(sector(fat), (id % (sectorSize / 4)) * 4);
  };
  let directory = i32(bytes, 48);
  const seen = new Set();
  let totalStreamBytes = 0;
  while (directory >= 0) {
    if (!validSector(directory) || seen.has(directory)) throw documentError('invalid CFB directory chain');
    seen.add(directory);
    const data = sector(directory);
    for (let offset = 0; offset + 128 <= data.length; offset += 128) {
      if (data[offset + 66] !== 2) continue;
      const low = u32(data, offset + 120);
      const high = major === 3 ? 0 : u32(data, offset + 124);
      const size = high * 0x100000000 + low;
      if (!Number.isSafeInteger(size) || size > maxExpandedBytes) throw documentError('CFB stream is too large');
      totalStreamBytes += size;
      if (totalStreamBytes > maxExpandedBytes) throw documentError('expanded HWP document is too large');
    }
    directory = nextSector(directory);
    if (seen.size > physicalSectors) throw documentError('invalid CFB directory size');
  }
}

function hwpParagraphText(bytes) {
  let offset = 0;
  let output = '';
  while (offset + 4 <= bytes.length) {
    const header = u32(bytes, offset);
    const tag = header & 0x3ff;
    let size = header >>> 20;
    offset += 4;
    if (size === 0xfff) {
      if (offset + 4 > bytes.length) throw documentError('invalid HWP record');
      size = u32(bytes, offset);
      offset += 4;
    }
    if (size > maxExpandedBytes || offset + size > bytes.length) throw documentError('invalid HWP record size');
    if (tag === 67) {
      if (size % 2) throw documentError('invalid HWP paragraph text');
      const text = decodeUtf16(bytes.subarray(offset, offset + size));
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code >= 32) output += text[index];
        else if (code === 9) { output += '\t'; index += 7; }
        else if (code === 10) output += '\n';
        else if (![0, 13, 24, 25, 30, 31].includes(code)) index += 7;
        if (output.length > maxDocumentTextLength) throw documentError('converted text is too large');
      }
      output += '\n\n';
    }
    offset += size;
  }
  return output;
}

function convertHwp(bytes) {
  preflightCfb(bytes);
  let cfb;
  try { cfb = CFB.parse(bytes); }
  catch { throw documentError('invalid HWP v5 compound document'); }
  const headerSource = CFB.find(cfb, 'FileHeader')?.content;
  const header = headerSource ? Uint8Array.from(headerSource) : undefined;
  if (!header || header.length < 40 || !decodeUtf8(header.subarray(0, 17)).startsWith('HWP Document File')) {
    throw documentError('invalid HWP v5 FileHeader');
  }
  const flags = u32(header, 36);
  if (flags & (2 | 4 | 16 | 0x100 | 0x400 | 0x2000)) {
    throw documentError('protected or encrypted HWP documents are unsupported');
  }
  const compressed = Boolean(flags & 1);
  const sections = cfb.FullPaths.map((path, index) => [path, cfb.FileIndex[index]])
    .filter(([path, entry]) => entry?.type === 2 && /\/BodyText\/Section\d+$/i.test(path))
    .sort(([left], [right]) => Number(left.match(/Section(\d+)$/i)[1]) - Number(right.match(/Section(\d+)$/i)[1]));
  if (!sections.length) throw documentError('HWP BodyText sections are missing');
  let text = '';
  let expandedBytes = 0;
  for (const [, entry] of sections) {
    let content = Uint8Array.from(entry.content);
    if (compressed) {
      try { content = inflateBounded(content, maxExpandedBytes - expandedBytes); }
      catch (error) {
        throw error instanceof DocumentImportError ? error : documentError('invalid compressed HWP body');
      }
    }
    expandedBytes += content.length;
    if (expandedBytes > maxExpandedBytes) throw documentError('expanded HWP body is too large');
    text += hwpParagraphText(content);
    if (text.length > maxDocumentTextLength) throw documentError('converted text is too large');
  }
  return nonEmpty(text);
}

async function convertPdf(bytes) {
  if (!sameBytes(bytes.subarray(0, 5), [37, 80, 68, 70, 45])) throw documentError('invalid PDF header');
  const {getDocument} = await import('unpdf/pdfjs');
  // shortcut: use embedded font mappings only, package CMaps if legacy PDFs need them.
  const task = getDocument({data:bytes.slice(), verbosity:0, maxImageSize:0, useSystemFonts:false, disableFontFace:true,
    isOffscreenCanvasSupported:false, isImageDecoderSupported:false, useWasm:false, useWorkerFetch:false});
  try {
    const document = await task.promise;
    if (document.numPages > 500) throw documentError('PDF is too large: more than 500 pages');
    const pages = [];
    let length = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      let text = '';
      const reader = page.streamTextContent().getReader();
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!('str' in item)) continue;
            text += item.str + (item.hasEOL ? '\n' : '');
            if (length + text.length > maxDocumentTextLength) throw documentError('converted text is too large');
          }
        }
      } finally {
        await reader.cancel();
        page.cleanup();
      }
      if (text.trim()) {
        pages.push(text.trim());
        length += text.length + 2;
      }
    }
    if (!pages.length) throw documentError('image-only PDF; OCR is required');
    return nonEmpty(pages.join('\n\n'));
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    if (error?.name === 'PasswordException') throw documentError('protected PDF');
    throw documentError('invalid PDF or text could not be read safely');
  } finally {
    await task.destroy();
  }
}

async function convertDocument(filename, source) {
  try {
    if (typeof filename !== 'string' || !filename.trim()) throw documentError('filename is required');
    const bytes = inputBytes(source);
    const dot = filename.lastIndexOf('.');
    const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
    if (extension === 'txt' || extension === 'md' || extension === 'markdown') return nonEmpty(decodeText(bytes));
    if (extension === 'docx') return convertDocx(bytes);
    if (extension === 'hwpx') return convertHwpx(bytes);
    if (extension === 'hwp') return convertHwp(bytes);
    if (extension === 'pdf') return await convertPdf(bytes);
    if (extension === 'doc') throw documentError('legacy DOC is unsupported; save it as DOCX first');
    throw documentError(`unsupported document type: ${extension || 'none'}`);
  } catch (error) {
    throw error instanceof DocumentImportError ? error : documentError('document could not be parsed safely');
  }
}

module.exports = {
  convertDocument,
  documentExtensions,
  maxDocumentBytes,
  maxDocumentTextLength,
  DocumentImportError,
};

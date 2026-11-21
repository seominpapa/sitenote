const {deflateSync} = require('node:zlib');

function pdf(content, unicode = false, compressed = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    compressed ? stream(deflateSync(Buffer.from(content)).toString('latin1'), '/Filter /FlateDecode') : stream(content),
    unicode ? '<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  if (unicode) objects.push(
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>',
    stream('/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n4 beginbfchar\n<0001> <D68C>\n<0002> <C758>\n<0003> <B85D>\n<0004> <D55C>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop end end'),
  );
  let body = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  const size = objects.length + 1;
  return Buffer.from(`${body}xref\n0 ${size}\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`, 'latin1');
}

const stream = (content, format = '') => `<< /Length ${content.length} ${format} >>\nstream\n${content}\nendstream`;
const scanPdf = () => pdf('q 80 0 0 80 20 30 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID 000000> EI Q');

module.exports = {pdf, scanPdf};

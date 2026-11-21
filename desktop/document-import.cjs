module.exports = require(__dirname.includes('app.asar')
  ? './document-converter.bundle.cjs'
  : '../src/records/document-converter.cjs');

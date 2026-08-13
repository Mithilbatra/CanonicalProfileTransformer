'use strict';

const zlib = require('zlib');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// Turns an uploaded file (Buffer) into plain text so the pipeline only ever
// deals with strings. Detection is by file signature first (magic bytes),
// falling back to the file extension — uploads are often misnamed.
//
// For PDFs we also recover hyperlink annotations: resumes typically render
// "LinkedIn" / "GitHub" as clickable words whose URLs never appear in the
// extracted text. The link targets live in /URI entries inside the PDF's
// (usually Flate-compressed) object streams, so we inflate every stream with
// zlib and scan — best-effort, no extra dependency, and a miss just means
// fewer links, never a failure.

const PDF_MAGIC = Buffer.from('%PDF');
const ZIP_MAGIC = Buffer.from('PK\x03\x04'); // .docx is a zip archive
const IMAGE_MAGICS = [
  { magic: Buffer.from([0xff, 0xd8, 0xff]), kind: 'image' }, // jpeg
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), kind: 'image' }, // png
];

function sniffKind(buffer, name = '') {
  if (buffer.subarray(0, 4).equals(PDF_MAGIC)) return 'pdf';
  if (buffer.subarray(0, 4).equals(ZIP_MAGIC) && /\.docx$/i.test(name)) return 'docx';
  for (const { magic, kind } of IMAGE_MAGICS) {
    if (buffer.subarray(0, magic.length).equals(magic)) return kind;
  }
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.docx$/i.test(name)) return 'docx';
  if (/\.(jpe?g|png)$/i.test(name)) return 'image';
  return 'text';
}

function extractPdfLinks(buffer) {
  const found = new Set();
  const scan = (str) => {
    for (const m of str.matchAll(/\/URI\s*\(([^)]*)\)/g)) {
      const uri = m[1].replace(/\\([()\\])/g, '$1').trim();
      if (uri) found.add(uri);
    }
  };
  const raw = buffer.toString('latin1');
  scan(raw);
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      scan(zlib.inflateSync(buffer.subarray(start, end)).toString('latin1'));
    } catch {
      /* not Flate-compressed or corrupt — skip */
    }
  }
  return [...found];
}

async function bufferToText(buffer, name = '') {
  const kind = sniffKind(buffer, name);
  if (kind === 'pdf') {
    const parsed = await pdfParse(buffer);
    const text = parsed.text || '';
    const links = extractPdfLinks(buffer);
    if (!text.trim() && !links.length) {
      // no embedded text at all: almost certainly a scanned/photographed PDF
      const err = new Error('PDF has no embedded text (scanned image?) — upload the resume as a JPG/PNG to run OCR, or use a text-based PDF');
      err.code = 'PDF_NO_TEXT';
      throw err;
    }
    return { text, kind, links };
  }
  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value || '', kind, links: [] };
  }
  if (kind === 'image') {
    const { text } = await ocrImage(buffer);
    return { text, kind, links: [] };
  }
  return { text: buffer.toString('utf8'), kind, links: [] };
}

// OCR for photographed/scanned resumes uploaded as images. tesseract.js is
// loaded lazily — it is a heavy module and most uploads never need it.
// The first run downloads the English model (~10MB) into data/ocr-cache.
async function ocrImage(buffer) {
  // OCR is by far the heaviest extraction path; cap the input so a huge image
  // can't tie up the (single) process. MAX_OCR_MB tunes it for a deployment.
  const maxMb = Number(process.env.MAX_OCR_MB || 6);
  if (buffer.length > maxMb * 1024 * 1024) {
    throw new Error(`image is too large to OCR (over ${maxMb} MB) — upload a smaller photo, or a text-based PDF/DOCX`);
  }
  let createWorker;
  try {
    ({ createWorker } = require('tesseract.js'));
  } catch {
    throw new Error('image upload needs OCR support — run: npm install tesseract.js');
  }
  const path = require('path');
  const cache = process.env.OCR_CACHE || path.join(__dirname, '..', '..', 'data', 'ocr-cache');
  const worker = await createWorker('eng', 1, { cachePath: cache });
  try {
    const { data } = await worker.recognize(buffer);
    return { text: data.text || '' };
  } finally {
    await worker.terminate();
  }
}

function isBinaryName(name = '') {
  return /\.(pdf|docx|jpe?g|png)$/i.test(name);
}

module.exports = { bufferToText, isBinaryName, sniffKind, extractPdfLinks };

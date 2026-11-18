import chardet from 'chardet';

export const MAX_BOOK_BYTES = 16 * 1024 * 1024;
export const MAX_BOOK_CHARS = 2_000_000;
export const encodings = { auto: '自动识别', 'utf-8': 'UTF-8', gb18030: 'GBK／GB18030', big5: 'Big5', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE' };
export type Encoding = keyof typeof encodings;

export function bookFormat(bytes: Uint8Array, name: string) {
  const header = String.fromCharCode(...bytes.subarray(0, 1024));
  if (/^\s*%PDF-\d\.\d/.test(header)) return 'pdf';
  if (/^(PK[\x03\x05\x07][\x04\x06\x08]|MZ|GIF8|SQLite format 3|\x89PNG|\xff\xd8\xff|\x7fELF|\x1f\x8b)/.test(header) || /BOOKMOBI|TEXtREAd/.test(header.slice(60, 68)) || /^(?:\._|\.DS_Store$)/i.test(name)) {
    throw new Error('这是压缩包、电子书容器或二进制文件。请选择 TXT、Markdown 或带文字层的 PDF。');
  }
  if (name.includes('.') && !/\.(txt|text|md|markdown)$/i.test(name)) throw new Error('支持 TXT、Markdown 和带文字层的 PDF。');
  return 'text';
}

export function decodeBookText(bytes: Uint8Array, encoding: Encoding = 'auto') {
  if (bytes.length > MAX_BOOK_BYTES) throw new Error('文件超过 16 MiB，请分卷后导入。');
  const sample = bytes.subarray(0, 65_536);
  let candidates: string[];
  if (encoding !== 'auto') candidates = [encoding];
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) candidates = ['utf-16le'];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) candidates = ['utf-16be'];
  else {
    let evenZeros = 0, oddZeros = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) oddZeros++; else evenZeros++; }
    const utf16: string[] = [];
    // An isolated zero in an index file is insufficient evidence for BOM-less UTF-16.
    const alignedZeros = Math.max(evenZeros, oddZeros);
    if (sample.length % 2 === 0 && alignedZeros >= 3 && alignedZeros > sample.length / 50 && alignedZeros > 4 * Math.min(evenZeros, oddZeros)) {
      utf16.push(oddZeros > evenZeros ? 'utf-16le' : 'utf-16be');
    }
    const probable = chardet.analyse(sample).map(item => item.name.toLowerCase()).filter(name => name === 'big5' || name === 'gb18030');
    candidates = [...new Set([...utf16, 'utf-8', ...probable, 'gb18030', 'big5'])];
  }
  for (const charset of candidates) {
    let text: string;
    try { text = new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { continue; }
    if (!text.trim() || /[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/.test(text)) continue;
    if (text.length > MAX_BOOK_CHARS) throw new Error('正文超过 200 万字，请分卷后导入。');
    return { text: text.replace(/\r\n?/g, '\n'), encoding: encodings[charset as Encoding] };
  }
  throw new Error('无法识别为可读正文。请检查文件，或选定原文件编码再导入。');
}

export function paginateBook(text: string): string[] {
  const pages: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1400, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > start + 700) end = newline + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const page = text.slice(start, end).trim();
    if (page) pages.push(page);
    start = end;
  }
  return pages;
}

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { MAX_BOOK_CHARS, paginateBook } from './reader-format';

GlobalWorkerOptions.workerSrc = workerUrl;
const maps = import.meta.glob<string>('../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default', eager: true });
const fonts = import.meta.glob<string>('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url', import: 'default', eager: true });

class BundledPdfData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const source = kind === 'cMapUrl' ? maps['../../node_modules/pdfjs-dist/cmaps/' + filename]
      : kind === 'standardFontDataUrl' ? fonts['../../node_modules/pdfjs-dist/standard_fonts/' + filename] : undefined;
    if (!source) throw new Error('缺少 PDF 字体资源。');
    const response = await fetch(source);
    if (!response.ok) throw new Error('PDF 字体资源读取失败。');
    return new Uint8Array(await response.arrayBuffer());
  }
}

export async function extractPdfPages(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  signal.throwIfAborted();
  const task = getDocument({ data: bytes, verbosity: 0, useWasm: false, disableFontFace: true, useWorkerFetch: false, BinaryDataFactory: BundledPdfData });
  const abort = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 1000) throw new Error('PDF 超过 1000 页，请分卷后导入。');
    const pages: string[] = [];
    let total = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const reader = page.streamTextContent().getReader();
      const parts: string[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (typeof item.str !== 'string') continue;
            total += item.str.length + 1;
            if (total > MAX_BOOK_CHARS) throw new Error('PDF 正文超过 200 万字，请分卷后导入。');
            parts.push(item.str, item.hasEOL ? '\n' : ' ');
          }
        }
      } finally { reader.releaseLock(); page.cleanup(); }
      pages.push(...paginateBook(parts.join('')));
    }
    if (!pages.length) throw new Error('这个 PDF 没有可提取的文字层，可能是扫描件。请提供含文字层的版本。');
    return pages;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!signal.aborted) await task.destroy();
  }
}

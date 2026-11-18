import { useEffect, useRef, useState, type FormEvent } from 'react';
import { bookFormat, decodeBookText, encodings, MAX_BOOK_BYTES, paginateBook, type Encoding } from '../lib/reader-format';
import { readerPages, readerShelf, writeReaderBook, type ReaderBook, type ReaderMark } from '../lib/reader-store';
import { Icon } from './Icon';
import { Dialog } from './Dialog';
import './context.css';
import './reader.css';

type Props = {
  storageId: string; onBack: () => void;
  onAsk: (kind: 'book', workId: string, title: string, context: string, question: string, isCurrentWork?: () => boolean) => Promise<void>;
};

export function ReaderWorkspace({ storageId, onBack, onAsk }: Props) {
  const [shelf, setShelf] = useState<ReaderBook[]>([]);
  const [book, setBook] = useState<ReaderBook>(), [pages, setPages] = useState<string[]>([]);
  const [encoding, setEncoding] = useState<Encoding>('auto');
  const [error, setError] = useState(''), [working, setWorking] = useState(false), [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState(''), [note, setNote] = useState<ReaderMark>();
  const importController = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => {
    let current = true;
    setBook(undefined); setPages([]); setQuestion(''); setShelf([]); setError('');
    void readerShelf(storageId).then(items => { if (current) setShelf(items); })
      .catch(() => { if (current) setError('书架读取失败，请检查当前设备的存储权限。'); });
    return () => { current = false; generation.current++; importController.current?.abort(); };
  }, [storageId]);

  function selectWork() {
    importController.current?.abort();
    setWorking(true); setAsking(false); setBook(undefined); setPages([]); setNote(undefined); setQuestion(''); setError('');
    return ++generation.current;
  }

  async function openBook(selected: ReaderBook) {
    const version = selectWork();
    try {
      const content = await readerPages(selected);
      if (version !== generation.current) return;
      setBook(selected); setPages(content);
    } catch { if (version === generation.current) setError('正文读取失败，请重新导入这本书。'); }
    finally { if (version === generation.current) setWorking(false); }
  }

  async function importFile(file: File) {
    const version = selectWork();
    const controller = new AbortController();
    importController.current = controller;
    try {
      if (!file.size) throw new Error('这个文件没有内容。');
      if (file.size > MAX_BOOK_BYTES) throw new Error('文件超过 16 MiB，请分卷后导入。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = bookFormat(bytes, file.name);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      controller.signal.throwIfAborted();
      let content: string[], format: string;
      if (kind === 'pdf') {
        const { extractPdfPages } = await import('../lib/reader-pdf');
        content = await extractPdfPages(bytes, controller.signal);
        format = 'PDF 文字层';
      } else {
        const result = decodeBookText(bytes, encoding);
        content = paginateBook(result.text); format = result.encoding;
      }
      controller.signal.throwIfAborted();
      const saved = await writeReaderBook(storageId, id, old => ({
        scope: storageId, id, title: file.name, format, count: content.length, updated: Date.now(),
        page: Math.min(old?.page ?? 0, content.length - 1), marks: (old?.marks || []).filter(mark => mark.page < content.length),
      }), content);
      if (version !== generation.current) return;
      setBook(saved); setPages(content);
      setShelf(items => [saved, ...items.filter(item => item.id !== id)]);
    } catch (reason) {
      if (version !== generation.current) return;
      const message = reason instanceof Error ? reason.message : '';
      if (reason instanceof Error && reason.name === 'PasswordException') setError('这个 PDF 已加密，请提供可直接阅读的版本。');
      else setError(/^(这个|这是|支持|正文超过|PDF 超过|PDF 正文超过|文件超过|无法识别|本机书架保存失败)/.test(message) ? message : '导入失败，请检查文件格式和本机存储空间。');
    } finally { if (version === generation.current) setWorking(false); }
  }

  async function update(change: (current: ReaderBook) => Partial<ReaderBook>) {
    if (!book || working) return;
    const version = generation.current;
    setWorking(true); setError('');
    try {
      const saved = await writeReaderBook(storageId, book.id, old => {
        if (!old) throw new Error();
        return { ...old, ...change(old), updated: Date.now() };
      });
      if (version !== generation.current) return;
      setBook(saved); setNote(undefined);
      setShelf(items => [saved, ...items.filter(item => item.id !== saved.id)]);
    } catch { if (version === generation.current) setError('书架保存失败，请检查设备存储空间后重试。'); }
    finally { if (version === generation.current) setWorking(false); }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!book || !question.trim() || asking || working) return;
    const version = generation.current;
    setAsking(true); setError('');
    try {
      await onAsk('book', book.id, book.title, '第 ' + (book.page + 1) + ' 页摘录\n' + pages[book.page], question.trim(), () => generation.current === version);
    } catch { if (generation.current === version) setError('共读问题发送失败，请检查连接后重试。'); }
    finally { if (generation.current === version) setAsking(false); }
  }

  const bookmarked = book?.marks.some(mark => mark.page === book.page && !mark.note);
  return <main className="settings-page context-workspace reader-workspace">
    <div className="page-heading"><div><button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />更多</button><h1>一起读书</h1></div></div>
    <div className="context-form-grid reader-import">
      <label className="dialog-field">导入书籍<input type="file" aria-label="导入书籍" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} /></label>
      <label className="dialog-field">文本编码<select value={encoding} onChange={event => setEncoding(event.target.value as Encoding)}>
        {(Object.keys(encodings) as Encoding[]).map(id => <option key={id} value={id}>{encodings[id]}</option>)}
      </select></label>
    </div>
    <p className="field-help">TXT、Markdown 或带文字层的 PDF，每份最多 16 MiB。正文和批注保存在这台设备。</p>
    {!!shelf.length && <label className="dialog-field">本机书架<select value={book?.id || ''} onChange={event => { const item = shelf.find(entry => entry.id === event.target.value); if (item) void openBook(item); }}>
      <option value="" disabled>选择一本书</option>{shelf.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label>}
    {error && <p className="context-notice" role="alert">{error}</p>}
    {working && !book && <p className="field-help" role="status">正在本机读取书籍…</p>}
    {book && <section aria-label="正文阅读">
      <article className="reader-paper">
        <header><h2>{book.title}</h2><small>{book.format} · 第 {book.page + 1} / {book.count} 页</small></header>
        <p className="reader-body">{pages[book.page]}</p>
      </article>
      <div className="context-toolbar reader-nav">
        <button className="secondary-button" type="button" disabled={book.page === 0 || working || asking} onClick={() => void update(() => ({ page: book.page - 1 }))}>上一页</button>
        <button className="secondary-button" type="button" disabled={book.page + 1 >= book.count || working || asking} onClick={() => void update(() => ({ page: book.page + 1 }))}>下一页</button>
      </div>
      <div className="context-actions"><button type="button" className="text-button" aria-pressed={!!bookmarked} disabled={working} onClick={() => void update(current => ({
        marks: bookmarked ? current.marks.filter(mark => mark.page !== book.page || mark.note) : current.marks.some(mark => mark.page === book.page && !mark.note) ? current.marks : [...current.marks, { id: crypto.randomUUID(), page: book.page, note: '' }],
      }))}><Icon name="bookmark" size={16} />{bookmarked ? '移除本页书签' : '添加书签'}</button>
        <button className="text-button" type="button" disabled={working} onClick={() => setNote({ id: crypto.randomUUID(), page: book.page, note: '' })}>写批注</button></div>
      {!!book.marks.length && <details className="reader-marks"><summary>书签与批注（{book.marks.length}）</summary>
        {[...book.marks].sort((a, b) => a.page - b.page).map(mark => <div key={mark.id}><button className="text-button" type="button" disabled={working || asking} onClick={() => void update(() => ({ page: mark.page }))}>第 {mark.page + 1} 页 · {mark.note ? '批注' : '书签'}</button>
          {mark.note && <><p>{mark.note}</p><button className="text-button" type="button" disabled={working} onClick={() => setNote(mark)}>编辑批注</button></>}
          <button className="text-button danger-text" type="button" disabled={working} onClick={() => void update(current => ({ marks: current.marks.filter(item => item.id !== mark.id) }))}>移除</button>
        </div>)}
      </details>}
      <form className="context-form reader-question" onSubmit={event => void ask(event)}>
        <label className="dialog-field">共读问题<textarea rows={2} maxLength={2000} required value={question} onChange={event => setQuestion(event.target.value)} /></label>
        <p className="field-help">提问会把书名、当前页摘录和问题发送到这本书的对话。</p>
        <button className="primary-button" disabled={working || asking || !question.trim()} type="submit">{asking ? '正在打开对话…' : '问这一页'}</button>
      </form>
    </section>}
    {note && <Dialog title="阅读批注" onClose={() => { if (!working) setNote(undefined); }}>
      <form className="context-form" onSubmit={event => { event.preventDefault(); if (note.note.trim()) void update(current => ({ marks: [...current.marks.filter(mark => mark.id !== note.id), { ...note, note: note.note.trim() }] })); }}>
        <label className="dialog-field">第 {note.page + 1} 页批注<textarea required rows={4} maxLength={2000} value={note.note} onChange={event => setNote({ ...note, note: event.target.value })} /></label>
        <div className="dialog-actions"><button className="secondary-button" type="button" disabled={working} onClick={() => setNote(undefined)}>取消</button><button type="submit" disabled={working || !note.note.trim()} className="primary-button">保存批注</button></div>
      </form></Dialog>}
  </main>;
}

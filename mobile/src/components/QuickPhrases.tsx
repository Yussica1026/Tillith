import { useEffect, useState, type FormEvent } from 'react';
import './chat-context.css';

type Phrase = { id: string; title: string; text: string };

export function QuickPhrases({ storageId, personaId, onInsert }: { storageId: string; personaId: string; onInsert?: (text: string) => void }) {
  const key = 'tillith.phrases:' + JSON.stringify([storageId, personaId]);
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [readable, setReadable] = useState(false);

  useEffect(() => {
    setEditing(null); setDeleting(null); setTitle(''); setText(''); setError(''); setReadable(false);
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(saved) || saved.length > 50 || saved.some((item) => !item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.text !== 'string') || new Set(saved.map((item) => item.id)).size !== saved.length) throw new Error();
      setPhrases(saved.map(({ id, title, text }) => ({ id, title, text }))); setReadable(true);
    } catch { setPhrases([]); setError('无法读取本机快捷短语，请保留应用数据后重试。'); }
  }, [key]);

  function store(next: Phrase[]) {
    try { localStorage.setItem(key, JSON.stringify(next)); setPhrases(next); setError(''); return true; }
    catch { setError('本机存储空间不足或不可用，短语未保存，请保留编辑内容。'); return false; }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!readable || !title.trim() || !text.trim()) return;
    const value = { id: editing || crypto.randomUUID(), title: title.trim(), text: text.trim() };
    if (!editing && phrases.length >= 50) { setError('每个人格最多保存 50 条快捷短语。'); return; }
    if (store(editing ? phrases.map((phrase) => phrase.id === editing ? value : phrase) : [...phrases, value])) { setEditing(null); setTitle(''); setText(''); }
  }

  return <section className="quick-phrases" aria-label="人格快捷短语">
    <p className="field-help">只保存在这台设备，按当前核心账号和人格分开。插入后可继续编辑，再手动发送。</p>
    {error && <p className="message-error" role="alert">{error}</p>}
    {readable && phrases.length === 0 && <p className="context-empty">还没有快捷短语，在下面保存第一条。</p>}
    <div className="phrase-list">{phrases.map((phrase) => <article key={phrase.id} className="phrase-card">
      <strong>{phrase.title}</strong><p>{phrase.text}</p>
      <div className="phrase-actions">
        {onInsert && <button type="button" className="secondary-button" onClick={() => onInsert(phrase.text)}>插入「{phrase.title}」</button>}
        <button type="button" className="text-button" onClick={() => { setEditing(phrase.id); setTitle(phrase.title); setText(phrase.text); setDeleting(null); }}>编辑「{phrase.title}」</button>
        <button type="button" className="text-button danger-text" onClick={() => setDeleting(phrase.id)}>删除「{phrase.title}」</button>
      </div>
      {deleting === phrase.id && <div className="phrase-actions" role="alert"><span>删除这条短语？</span><button type="button" className="text-button" onClick={() => setDeleting(null)}>取消</button><button type="button" className="text-button danger-text" onClick={() => { if (store(phrases.filter((item) => item.id !== phrase.id))) { setDeleting(null); if (editing === phrase.id) { setEditing(null); setTitle(''); setText(''); } } }}>确认删除短语</button></div>}
    </article>)}</div>
    <form className="phrase-form" onSubmit={save}>
      <h3>{editing ? '编辑快捷短语' : '新增快捷短语'}</h3>
      <label className="dialog-field">短语名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} required disabled={!readable} /></label>
      <label className="dialog-field">短语内容<textarea aria-label="短语内容" value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} rows={4} required disabled={!readable} /></label>
      <div className="dialog-actions">{editing && <button type="button" className="secondary-button" onClick={() => { setEditing(null); setTitle(''); setText(''); }}>取消编辑</button>}<button className="primary-button" type="submit" disabled={!readable || !title.trim() || !text.trim()}>保存短语</button></div>
    </form>
  </section>;
}

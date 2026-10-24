import { useEffect, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './message-content.css';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (feedback === 'idle') return;
    const timer = window.setTimeout(() => setFeedback('idle'), 3500);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  return <span className="message-copy-control">
    <button type="button" className="message-copy-button" disabled={copying} onClick={async () => {
      setCopying(true);
      setFeedback('idle');
      try {
        await navigator.clipboard.writeText(text);
        setFeedback('copied');
      } catch {
        setFeedback('failed');
      } finally {
        setCopying(false);
      }
    }}>{label}</button>
    <span className={`message-copy-feedback${feedback === 'failed' ? ' is-error' : ''}`} role="status">
      {feedback === 'copied' ? '已复制' : feedback === 'failed' ? '复制失败，请长按选择文字' : ''}
    </span>
  </span>;
}

const components: Components = {
  pre({ node, children }) {
    const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
    const text = code?.type === 'element' ? code.children.map((child) => child.type === 'text' ? child.value : '').join('') : '';
    const classes = code?.type === 'element' ? code.properties.className : undefined;
    const language = Array.isArray(classes) ? classes.find((value) => String(value).startsWith('language-'))?.toString().slice(9) : '';
    return <div className="message-code-block">
      <div className="message-code-heading"><span>{language || '代码'}</span><CopyButton text={text} label="复制代码" /></div>
      <pre tabIndex={0} aria-label="代码内容">{children}</pre>
    </div>;
  },
  table({ children }) {
    return <div className="message-table-scroll" tabIndex={0} role="region" aria-label="表格，可横向滚动"><table>{children}</table></div>;
  },
  a({ href, children }) {
    return href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>;
  },
  img({ src, alt }) {
    // Model-authored images never trigger a request until the user opens the link.
    return typeof src === 'string' && /^https?:\/\//i.test(src)
      ? <a className="message-image-source" href={src} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看图片来源{alt ? `：${alt}` : ''} ↗</a>
      : <span className="message-image-source">图片{alt ? `：${alt}` : ''}（来源不可用）</span>;
  },
};

export function MessageContent({ text }: { text: string }) {
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{text}</Markdown></div>;
}

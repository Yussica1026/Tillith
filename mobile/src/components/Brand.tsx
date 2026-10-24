import { useEffect, useId } from 'react';

export function Brand({ animated = false, compact = false }: { animated?: boolean; compact?: boolean }) {
  const mask = useId().replace(/:/g, '');
  return <span className={`brand ${animated ? 'brand--animated' : ''} ${compact ? 'brand--compact' : ''}`} aria-label="Tillith">
    <svg className="brand-mark" aria-hidden="true" viewBox="0 0 84 98" fill="currentColor">
      <defs><mask id={mask}><path className="brand-stroke brand-stroke--cross" d="M9 24Q42 9 77 18" stroke="white" strokeWidth="20" fill="none" pathLength="100" /><path className="brand-stroke brand-stroke--down" d="M47 13Q42 49 28 89" stroke="white" strokeWidth="20" fill="none" pathLength="100" /></mask></defs>
      <g mask={`url(#${mask})`}>
        <path d="M8 25C24 16 51 8 77 15L75 20C53 15 31 20 10 28L15 22Z" />
        <path d="M45 14L51 12C47 36 40 67 27 91L30 78C35 58 41 33 45 14Z" />
      </g>
    </svg>
    {!compact && <span className="brand-word" aria-hidden="true">illith</span>}
  </span>;
}

export function Splash({ onFinish }: { onFinish: () => void }) {
  useEffect(() => {
    const timeout = window.setTimeout(onFinish, 2300);
    return () => window.clearTimeout(timeout);
  }, [onFinish]);
  return <div className="splash" role="dialog" aria-modal="true" aria-label="Tillith 启动动画">
    <div className="splash-brand"><Brand animated /></div>
    <button type="button" className="splash-skip" onClick={onFinish}>跳过动画 <span aria-hidden="true">↗</span></button>
  </div>;
}

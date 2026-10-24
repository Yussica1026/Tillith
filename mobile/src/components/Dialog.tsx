import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const reference = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { reference.current?.showModal(); }, []);
  return <dialog className="dialog" ref={reference} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

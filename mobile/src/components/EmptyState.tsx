import { Brand } from './Brand';
import type { ReactNode } from 'react';

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark"><Brand compact /></div><h2>{title}</h2><div className="empty-description">{children}</div>{action && <div className="empty-action">{action}</div>}</div>;
}

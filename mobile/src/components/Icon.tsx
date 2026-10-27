import type { CSSProperties } from 'react';

export type IconName = 'arrow' | 'back' | 'bookmark' | 'chat' | 'check' | 'chevron' | 'cloud' | 'device' | 'close' | 'file' | 'image' | 'loader' | 'more' | 'plus' | 'refresh' | 'settings' | 'stop' | 'trash' | 'edit' | 'paperclip' | 'eye' | 'bolt';

const paths: Record<IconName, string> = {
  bolt: 'M13 2 4 14h7l-1 8 10-13h-7Z',
  bookmark: 'M6 3h12v18l-6-4-6 4Z',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  back: 'm14 6-6 6 6 6',
  chat: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3A7.5 7.5 0 0 1 20 11.5ZM7 10h8m-8 4h5',
  check: 'm5 12 4 4L19 6',
  chevron: 'm9 5 7 7-7 7',
  cloud: 'M7 18a5 5 0 0 1-1-9.9 6 6 0 0 1 11.5-1.3A5.7 5.7 0 0 1 18 18Z',
  device: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 14h2M10 6h4',
  close: 'm6 6 12 12M6 18 18 6',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Zm0 0v5h5M9 13h6m-6 4h6',
  image: 'M4 4h16v16H4Zm0 11 5-5 7 10m-2-5 3-3 3 3M15 8h.01',
  loader: 'M20 12a8 8 0 1 1-8-8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-2-5h4l.7 3 2 .9 2.7-.8 2 3.4-2.2 2.1v2.3l2.2 2.1-2 3.4-2.7-.8-2 .9L14 23h-4l-.7-3.5-2-.9-2.7.8-2-3.4 2.2-2.1v-2.3L2.6 9.5l2-3.4 2.7.8 2-.9Z',
  stop: 'M6 6h12v12H6Z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  edit: 'm14 5 5 5M4 20l5-1L21 7l-5-5L4 14Z',
  paperclip: 'm8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a7 7 0 0 1 10 10l-8 8',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
};

export function Icon({ name, size = 20, className = '', style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg aria-hidden="true" className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={style}><path d={paths[name]} /></svg>;
}

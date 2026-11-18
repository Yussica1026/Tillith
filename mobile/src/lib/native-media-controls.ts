import { Capacitor, registerPlugin } from '@capacitor/core';

const Native = registerPlugin<{
  update(state: { item: string; title: string; playing: boolean; duration: number; position: number; next: boolean; previous: boolean }): Promise<void>;
  clear(state: { item: string }): Promise<void>;
  addListener(name: 'control', callback: (event: { item: string; action: MediaSessionAction; position: number }) => void): Promise<{ remove(): Promise<void> }>;
}>('TillithMedia');

export function nativeMediaControls(element: HTMLMediaElement, id: string, title: string,
  handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>>,
  onAvailable: (ok: boolean) => void): (() => void) | undefined {
  if (Capacitor.getPlatform() !== 'android') return;
  let active = true;
  const update = () => {
    if (!active || !element.readyState) return;
    void Native.update({
      item: id, title, playing: !element.paused && !element.ended,
      position: Math.round(element.currentTime * 1000), duration: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : 0,
      next: !!handlers.nexttrack, previous: !!handlers.previoustrack,
    }).then(() => { if (active) onAvailable(true); }).catch(() => { if (active) onAvailable(false); });
  };
  const listener = Native.addListener('control', event => {
    if (active && event.item === id) handlers[event.action]?.({ action: event.action, seekTime: event.position / 1000 });
  });
  void listener.catch(() => { if (active) onAvailable(false); });
  const events = ['loadedmetadata', 'play', 'pause', 'seeked', 'ended'];
  for (const event of events) element.addEventListener(event, update);
  update();
  return () => {
    active = false;
    for (const event of events) element.removeEventListener(event, update);
    void listener.then(handle => handle.remove()).catch(() => {});
    void Native.clear({ item: id }).catch(() => {});
  };
}

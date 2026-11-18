import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { Connection, Settings } from '../lib/api';

type Account = { base: string; profile: string; owner: string };
type Status = { available: boolean; enabled: boolean; permission: boolean; pendingRevoke?: boolean; renewFailed?: boolean };
const Native = registerPlugin<{
  focus(account: Account): Promise<Status>;
  enable(account: Account & { fingerprint: string }): Promise<void>;
  disable(account: Account): Promise<void>;
  takeOpen(account: Account): Promise<{ session?: string }>;
  addListener(event: 'open', fn: () => void): Promise<PluginListenerHandle>;
}>('TillithPush');
const android = Capacitor.getPlatform() === 'android';

export function PushNotifications({ connection, settings, showControls, canOpen, onOpen }: {
  connection: Connection | null; settings: Settings; showControls: boolean;
  canOpen: boolean; onOpen: (id: string) => void;
}) {
  const account = useMemo<Account>(() => ({
    base: settings.serverUrl.trim().replace(/\/+$/, ''), profile: settings.profileId || '',
    owner: connection?.mode === 'cloud' ? connection.username : '',
  }), [settings.serverUrl, settings.profileId, connection]);
  const active = useRef(account);
  active.current = account;
  const opener = useRef(onOpen);
  opener.current = onOpen;
  const [status, setStatus] = useState<Status>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ account: Account; id: string }>();
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (android) setControlsHost(showControls ? document.getElementById('push-controls') : null);
  }, [showControls]);

  useEffect(() => {
    setStatus(undefined); setMessage(''); setBusy(false); setPending(undefined);
    if (!android) return;
    let live = true;
    const inspect = async () => {
      try {
        const result = await Native.focus(account);
        if (live) setStatus(result);
      } catch { if (live) setMessage('无法读取安卓通知状态。'); }
    };
    void inspect();
    const refresh = () => { if (document.visibilityState === 'visible') void inspect(); };
    document.addEventListener('visibilitychange', refresh);
    return () => { live = false; document.removeEventListener('visibilitychange', refresh); };
  }, [account]);

  useEffect(() => {
    if (!android || !status?.enabled) return;
    let live = true;
    const take = async () => {
      const { session } = await Native.takeOpen(account);
      if (live && session) setPending({ account, id: session });
    };
    const listener = Native.addListener('open', () => { void take().catch(() => {}); });
    void listener.then(() => { if (live) return take(); }).catch(() => {});
    return () => { live = false; void listener.then(handle => handle.remove()).catch(() => {}); };
  }, [account, status?.enabled]);

  useEffect(() => {
    if (pending?.account === account && canOpen) {
      setPending(undefined);
      opener.current(pending.id);
    }
  }, [pending, account, canOpen]);

  async function toggle() {
    setBusy(true); setMessage('');
    let notice = '';
    try {
      if (status?.enabled || status?.pendingRevoke) await Native.disable(account);
      else {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(settings.apiKey.trim()));
        const fingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
        if (active.current !== account) return;
        await Native.enable({ ...account, fingerprint });
      }
    } catch (error) {
      notice = error instanceof Error ? error.message : '通知设置未完成。';
    } finally {
      if (active.current === account) {
        const next = await Native.focus(account).catch(() => undefined);
        if (active.current === account) { setStatus(next); setMessage(notice); setBusy(false); }
      }
    }
  }

  if (!android || !showControls || !controlsHost) return null;
  return createPortal(<section className="settings-section" aria-label="安卓通知">
    <h2>锁屏通知</h2>
    <p>{!account.owner ? '连接云端核心后，可以登记这台手机接收对话通知。'
      : !status ? '正在读取通知状态…'
      : !status.available ? '这个安装包尚未配置 Firebase。'
      : status.pendingRevoke ? '本机已关闭通知，云端登记待撤销。'
      : status.enabled ? (status.permission ? (status.renewFailed ? '已登记，云端同步待重试。' : '已为当前账号开启。') : '已登记，请在系统设置中允许通知。')
      : '通知只显示新消息提醒，点击可打开对应会话。'}</p>
    {account.owner && status?.available && <button type="button" className="text-button" disabled={busy} onClick={() => void toggle()}>
      {busy ? '正在保存…' : status.pendingRevoke ? '重试撤销' : status.enabled ? '关闭并撤销登记' : '开启锁屏通知'}
    </button>}
    {message && <p role="status">{message}</p>}
  </section>, controlsHost);
}

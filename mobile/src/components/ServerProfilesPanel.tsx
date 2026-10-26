import { useEffect, useState } from 'react';
import * as profilesApi from '../lib/profiles';
import { safeError, type Settings } from '../lib/api';
import { Dialog } from './Dialog';

type Profile = Awaited<ReturnType<typeof profilesApi.loadProfiles>>['profiles'][number];

export function ServerProfilesPanel({ value, disabled, onChange, onConnect, onRemove }: { value: Settings; disabled: boolean; onChange: (settings: Settings) => void; onConnect: (settings: Settings) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<Profile>();
  const locked = disabled || busy;
  useEffect(() => { let active = true; void profilesApi.loadProfiles().then((data) => { if (active) setProfiles(data.profiles); }).catch((reason) => { if (active) setError(safeError(reason)); }); return () => { active = false; }; }, [value.profileId]);
  async function load(id: string) {
    setBusy(true); setError('');
    try { onChange(await profilesApi.profileSettings(id)); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(false); }
  }
  async function create() {
    if (!name.trim() || locked) return;
    setBusy(true); setError('');
    try { const profile = await profilesApi.createProfile({ name: name.trim(), mode: 'cloud', serverUrl: '' }); setProfiles((old) => [...old, profile]); onChange(await profilesApi.profileSettings(profile.id)); setCreating(false); setName(''); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!deleting || locked) return;
    setBusy(true); setError('');
    try { await onRemove(deleting.id); const result = await profilesApi.loadProfiles(); setProfiles(result.profiles); if (value.profileId === deleting.id) onChange(await profilesApi.profileSettings(result.activeProfileId)); setDeleting(undefined); }
    catch (reason) { setError(safeError(reason)); setDeleting(undefined); }
    finally { setBusy(false); }
  }
  return <section className="profile-panel" aria-label="服务器配置"><label className="dialog-field">已保存的配置<select aria-label="已保存的配置" value={value.profileId || ''} disabled={locked} onChange={(event) => void load(event.target.value)}>{!value.profileId && <option value="">当前连接</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.mode === 'device' ? '本机' : '云端'}</option>)}</select></label><div className="profile-actions"><button type="button" className="text-button" disabled={locked} onClick={() => { setCreating(true); setName(''); }}>新增配置</button><button type="button" className="text-button" disabled={locked || !value.profileId} onClick={() => void onConnect(value)}>切换并连接</button><button type="button" className="text-button danger-text" disabled={locked || profiles.length <= 1 || !value.profileId} onClick={() => setDeleting(profiles.find((profile) => profile.id === value.profileId))}>移除配置</button></div>{error && <p className="message-error" role="alert">{error}</p>}
    {creating && <Dialog title="新增服务器配置" onClose={() => { if (!busy) setCreating(false); }}><label className="dialog-field">配置名称<input aria-label="配置名称" autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setCreating(false)}>取消</button><button type="button" className="primary-button" disabled={busy || !name.trim()} onClick={() => void create()}>创建配置</button></div></Dialog>}
    {deleting && <Dialog title="移除服务器配置？" onClose={() => { if (!busy) setDeleting(undefined); }}><p className="dialog-description">移除这台设备保存的「{deleting.name}」和它的连接凭据。服务器上的会话不会删除。</p><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => void remove()}>移除配置</button></div></Dialog>}
  </section>;
}

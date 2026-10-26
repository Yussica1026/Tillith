import { Capacitor, registerPlugin } from '@capacitor/core';
import type { Mode, Settings } from './api';

export type ServerProfile = { id: string; name: string; mode: Mode; serverUrl: string };
export type ProfileCredentials = { chatKey?: string; managementKey?: string };
type ProfileStore = { version: 1; profiles: ServerProfile[]; activeProfileId: string; legacyMigrated?: boolean };
const storageKey = 'tillith.server-profiles';
const memoryKeys = new Map<string, { chatKey: string; managementKey: string }>();
const Vault = registerPlugin<{
  read(options?: { slot?: string }): Promise<{ value: string }>;
  write(options: { slot?: string; value: string }): Promise<void>;
  delete(options?: { slot?: string }): Promise<void>;
}>('TillithVault');
let initialization: Promise<void> | undefined;

function serverAddress(value: string): string {
  if (!value.trim()) return '';
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的 HTTPS 服务器地址。'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('服务器地址需要 HTTPS，且不能包含账号、密码或查询参数；本机地址可使用 HTTP。');
  return url.href.replace(/\/+$/, '');
}

function readStore(): ProfileStore | undefined {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return undefined;
  try {
    const value = JSON.parse(saved);
    if (value.version !== 1 || !Array.isArray(value.profiles) || !value.profiles.length) throw new Error();
    const profiles: ServerProfile[] = value.profiles.map((profile: any) => {
      if (typeof profile.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(profile.id) || typeof profile.name !== 'string' || !['cloud', 'device'].includes(profile.mode) || typeof profile.serverUrl !== 'string') throw new Error();
      return { id: profile.id, name: profile.name, mode: profile.mode, serverUrl: profile.mode === 'device' ? '' : profile.serverUrl };
    });
    return { version: 1, profiles, activeProfileId: profiles.some(profile => profile.id === value.activeProfileId) ? value.activeProfileId : profiles[0].id, legacyMigrated: value.legacyMigrated === true };
  } catch { throw new Error('服务器配置记录无法读取，请先保留本机数据，不要清除应用存储。'); }
}

async function initialize(): Promise<void> {
  if (!initialization) initialization = (async () => {
    let store = readStore();
    if (!store) {
      let previous: any = {};
      try { previous = JSON.parse(localStorage.getItem('tillith.preferences') || '{}'); } catch { /* An invalid legacy preference is not a credential. */ }
      const profile: ServerProfile = { id: crypto.randomUUID(), name: previous.mode === 'device' ? '手机内置核心' : '我的云端', mode: previous.mode === 'device' ? 'device' : 'cloud', serverUrl: typeof previous.serverUrl === 'string' && previous.mode !== 'device' ? serverAddress(previous.serverUrl) : '' };
      store = { version: 1, profiles: [profile], activeProfileId: profile.id };
      // Save the destination identity before touching secrets, so a retry uses the same slot.
      localStorage.setItem(storageKey, JSON.stringify(store));
    }
    if (!store.legacyMigrated) {
      if (Capacitor.isNativePlatform()) {
        const legacy = (await Vault.read()).value;
        const slot = `profile:${store.profiles[0].id}:chat`;
        if (legacy) {
          const destination = (await Vault.read({ slot })).value;
          if (destination && destination !== legacy) throw new Error('旧凭据与目标配置不同，已保留两份凭据，请先处理本机凭据迁移。');
          if (!destination) await Vault.write({ slot, value: legacy });
          await Vault.delete();
        }
      }
      store.legacyMigrated = true;
      localStorage.setItem(storageKey, JSON.stringify(store));
    }
  })().catch((error) => { initialization = undefined; throw error; });
  return initialization;
}

export async function loadProfiles(): Promise<{ profiles: ServerProfile[]; activeProfileId: string }> {
  await initialize();
  const store = readStore()!;
  return { profiles: store.profiles, activeProfileId: store.activeProfileId };
}

export async function createProfile(input: Pick<ServerProfile, 'name' | 'mode' | 'serverUrl'>): Promise<ServerProfile> {
  await initialize();
  const store = readStore()!;
  if (store.profiles.length >= 30) throw new Error('最多保存 30 套服务器配置，请先移除不再使用的配置。');
  const profile: ServerProfile = { id: crypto.randomUUID(), name: input.name.trim().slice(0, 80) || '新的服务器', mode: input.mode, serverUrl: input.mode === 'device' ? '' : serverAddress(input.serverUrl) };
  store.profiles.push(profile);
  localStorage.setItem(storageKey, JSON.stringify(store));
  return profile;
}

export async function saveProfile(profile: ServerProfile, credentials: ProfileCredentials = {}): Promise<void> {
  await initialize();
  const store = readStore()!;
  const index = store.profiles.findIndex(item => item.id === profile.id);
  if (index < 0) throw new Error('服务器配置不存在，请重新选择。');
  const metadata: ServerProfile = { id: profile.id, name: profile.name.trim().slice(0, 80) || '服务器', mode: profile.mode, serverUrl: profile.mode === 'device' ? '' : serverAddress(profile.serverUrl) };
  const previous = memoryKeys.get(profile.id) || { chatKey: '', managementKey: '' };
  if (Capacitor.isNativePlatform()) {
    if (credentials.chatKey !== undefined) await Vault.write({ slot: `profile:${profile.id}:chat`, value: credentials.chatKey.trim() });
    if (credentials.managementKey !== undefined) await Vault.write({ slot: `profile:${profile.id}:management`, value: credentials.managementKey.trim() });
  } else {
    memoryKeys.set(profile.id, { chatKey: credentials.chatKey === undefined ? previous.chatKey : credentials.chatKey.trim(), managementKey: credentials.managementKey === undefined ? previous.managementKey : credentials.managementKey.trim() });
  }
  // Build an allowlisted metadata object; never serialize credential-bearing Settings.
  store.profiles[index] = metadata;
  localStorage.setItem(storageKey, JSON.stringify(store));
}

export async function selectProfile(id: string): Promise<void> {
  await initialize();
  const store = readStore()!;
  if (!store.profiles.some(profile => profile.id === id)) throw new Error('服务器配置不存在，请重新选择。');
  store.activeProfileId = id;
  localStorage.setItem(storageKey, JSON.stringify(store));
}

export async function profileSettings(id: string): Promise<Settings> {
  await initialize();
  const profile = readStore()!.profiles.find(item => item.id === id);
  if (!profile) throw new Error('服务器配置不存在，请重新选择。');
  const credentials = Capacitor.isNativePlatform() ? {
    chatKey: (await Vault.read({ slot: `profile:${id}:chat` })).value,
    managementKey: (await Vault.read({ slot: `profile:${id}:management` })).value,
  } : memoryKeys.get(id) || { chatKey: '', managementKey: '' };
  return { profileId: id, mode: profile.mode, serverUrl: profile.serverUrl, apiKey: credentials.chatKey, managementKey: credentials.managementKey };
}

export async function deleteProfile(id: string): Promise<void> {
  await initialize();
  const store = readStore()!;
  if (!store.profiles.some(profile => profile.id === id)) throw new Error('服务器配置不存在。');
  if (store.profiles.length === 1) throw new Error('请至少保留一套服务器配置。');
  if (Capacitor.isNativePlatform()) {
    await Vault.delete({ slot: `profile:${id}:chat` });
    await Vault.delete({ slot: `profile:${id}:management` });
  }
  memoryKeys.delete(id);
  store.profiles = store.profiles.filter(profile => profile.id !== id);
  if (store.activeProfileId === id) store.activeProfileId = store.profiles[0].id;
  localStorage.setItem(storageKey, JSON.stringify(store));
}

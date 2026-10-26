import type { Attachment, ChatSelection, Connection } from './api';

export type SessionDraft = { text: string; attachments: Attachment[] };
export type Appearance = { theme: 'system' | 'light' | 'dark' | 'water' | 'mint' | 'lilac' | 'rose'; fontSize: number; density: 'compact' | 'comfortable' | 'spacious'; codeTheme: 'follow' | 'light' | 'dark' | 'contrast' };
export const defaultAppearance: Appearance = { theme: 'water', fontSize: 15, density: 'comfortable', codeTheme: 'follow' };

export function loadAppearance(): Appearance {
  try {
    const value = JSON.parse(localStorage.getItem('tillith.appearance') || '{}');
    return {
      theme: ['system', 'light', 'dark', 'water', 'mint', 'lilac', 'rose'].includes(value.theme) ? value.theme : 'water',
      fontSize: [14, 15, 16, 18, 20].includes(value.fontSize) ? value.fontSize : 15,
      density: ['compact', 'comfortable', 'spacious'].includes(value.density) ? value.density : 'comfortable',
      codeTheme: ['follow', 'light', 'dark', 'contrast'].includes(value.codeTheme) ? value.codeTheme : 'follow',
    };
  } catch { return defaultAppearance; }
}

export function loadChatPreferences(connection: Connection): { drafts: Record<string, SessionDraft>; selections: Record<string, ChatSelection> } {
  try {
    const data = JSON.parse(localStorage.getItem('tillith.chats:' + connection.storageId) || '{}');
    const drafts: Record<string, SessionDraft> = {};
    const selections: Record<string, ChatSelection> = {};
    for (const [id, value] of Object.entries(data.drafts || {})) {
      const draft = value as SessionDraft;
      if (draft && typeof draft.text === 'string' && Array.isArray(draft.attachments)) {
        drafts[id] = { text: draft.text, attachments: draft.attachments.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && ['image', 'record', 'file', 'video'].includes(item.type)).map(({ id, name, type }) => ({ id, name, type })) };
      }
    }
    for (const [id, value] of Object.entries(data.selections || {})) {
      const selection = value as ChatSelection;
      if (selection && typeof selection.configId === 'string' && typeof selection.providerId === 'string' && typeof selection.model === 'string') selections[id] = { configId: selection.configId, providerId: selection.providerId, model: selection.model, streaming: selection.streaming !== false };
    }
    return { drafts, selections };
  } catch { return { drafts: {}, selections: {} }; }
}

export function saveChatPreferences(connection: Connection, drafts: Record<string, SessionDraft>, selections: Record<string, ChatSelection>): boolean {
  const cleanDrafts = Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, { text: draft.text, attachments: draft.attachments.map(({ id, name, type }) => ({ id, name, type })) }]));
  try { localStorage.setItem('tillith.chats:' + connection.storageId, JSON.stringify({ drafts: cleanDrafts, selections })); return true; }
  catch { return false; }
}

export type MediaKind = 'film' | 'music';
export type Cue = { start: number; end: number | null; text: string };

function timecode(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function plainCaption(value: string): string {
  return value.replace(/<[^>\n]{1,100}>/g, '').replace(/&(amp|lt|gt|nbsp);/g,
    (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[entity] || '').trim();
}

export function parseCues(input: string, kind: MediaKind): Cue[] {
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues: Cue[] = [];
  if (kind === 'film') {
    const timing = /^(?:(?:\d{1,3}:)?[0-5]?\d:[0-5]\d[.,]\d{1,3})$/;
    for (const block of source.split(/\n[ \t]*\n/)) {
      const lines = block.trim().split('\n');
      if (/^(?:WEBVTT|NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0])) continue;
      const index = lines[0].includes('-->') ? 0 : 1;
      const times = lines[index]?.trim().match(/^(\S+)\s+-->\s+(\S+)(?:\s.*)?$/);
      if (!times || !timing.test(times[1]) || !timing.test(times[2])) continue;
      const start = timecode(times[1]), end = timecode(times[2]);
      const text = plainCaption(lines.slice(index + 1).join('\n'));
      if (text && end > start) cues.push({ start, end, text });
    }
  } else {
    const offset = Number(source.match(/^\s*\[offset:([+-]?\d+)\]/im)?.[1] || 0) / 1000;
    for (const line of source.split('\n')) {
      const stamps = [...line.matchAll(/\[(\d{1,4}:[0-5]\d(?:[.:]\d{1,3})?)\]/g)];
      if (!stamps.length) continue;
      const last = stamps[stamps.length - 1];
      const text = plainCaption(line.slice(last.index! + last[0].length));
      if (!text) continue;
      for (const stamp of stamps) {
        const start = Math.max(0, timecode(stamp[1].replace(/^(\d+:\d{2}):/, '$1.')) - offset);
        cues.push({ start, end: null, text });
      }
    }
  }
  if (!cues.length || cues.length > 30000) throw new Error('没有可用的时间轴，或条目超过 3 万行。');
  cues.sort((a, b) => a.start - b.start);
  if (kind === 'music') {
    let next: number | null = null;
    for (let i = cues.length - 1; i >= 0; i--) {
      if (i + 1 < cues.length && cues[i + 1].start !== cues[i].start) next = cues[i + 1].start;
      cues[i].end = next;
    }
  }
  return cues;
}

export async function readCues(file: File, kind: MediaKind): Promise<Cue[]> {
  if (file.size > 4 * 1024 * 1024) throw new Error('请选择 4 MB 以内的字幕或歌词文件。');
  const bytes = await file.arrayBuffer();
  let text: string;
  const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (header[0] === 255 && header[1] === 254) text = new TextDecoder('utf-16le').decode(bytes);
  else if (header[0] === 254 && header[1] === 255) text = new TextDecoder('utf-16be').decode(bytes);
  else try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('gb18030').decode(bytes); }
  return parseCues(text, kind);
}

export function clockLabel(value: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(seconds / 3600);
  return (hours ? hours + ':' : '') + String(Math.floor(seconds / 60) % 60).padStart(2, '0')
    + ':' + String(seconds % 60).padStart(2, '0');
}

export function appeared(cues: Cue[], position: number, limit: number): Cue[] {
  let low = 0, high = cues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle].start <= position) low = middle + 1;
    else high = middle;
  }
  return cues.slice(Math.max(0, low - limit), low);
}

export function mediaContext(kind: MediaKind, title: string, cues: Cue[], position: number): string {
  const evidence = appeared(cues, position, 15).map(cue => clockLabel(cue.start) + ' ' + cue.text.slice(0, 400)).join('\n').slice(-3500);
  return (kind === 'film' ? '【共影】' : '【一起听歌】') + title.slice(0, 160) + '\n播放点 ' + clockLabel(position)
    + (kind === 'film' ? '\n依据已出现的字幕回答，避免透露后续剧情。未提供画面或声音。' : '\n仅参考已经出现的歌词。未提供音频。')
    + '\n' + (evidence || '截至当前播放点没有已出现的字幕或歌词。');
}

export function playableUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('请输入完整的视频直链。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || [...url.searchParams.keys()].some(key => /token|signature|credential|api.?key|authorization|password/i.test(key))) {
    throw new Error('请选择无需凭据的 HTTP 或 HTTPS 视频直链。');
  }
  return url.href;
}

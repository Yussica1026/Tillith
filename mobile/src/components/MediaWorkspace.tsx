import { useEffect, useMemo, useRef, useState } from 'react';
import { appeared, clockLabel, mediaContext, playableUrl, readCues, type Cue, type MediaKind } from '../lib/media-cues';
import { addWorks, listWorks, loadWork, removeWork, saveCues, savePosition, type MediaWork } from '../lib/media-library';
import { nativeMediaControls } from '../lib/native-media-controls';
import { Icon } from './Icon';
import './media-workspace.css';

type Props = {
  kind: MediaKind; storageId: string; onBack: () => void;
  onAsk: (kind: MediaKind, workId: string, title: string, context: string, question: string, isCurrentWork?: () => boolean) => Promise<void>;
};
type Selection = { playlist: string; lists: string[]; id: string };
const defaultPlaylist = '我的歌单';

function restore(scope: string): Selection {
  try {
    const saved = JSON.parse(localStorage.getItem(scope) || '{}');
    const lists = Array.isArray(saved.lists) ? saved.lists.filter((name: unknown) => typeof name === 'string' && name) : [];
    return { lists: [...new Set<string>([defaultPlaylist, ...lists])], playlist: saved.playlist || defaultPlaylist, id: saved.id || '' };
  } catch { return { lists: [defaultPlaylist], playlist: defaultPlaylist, id: '' }; }
}

export function MediaWorkspace(props: Props) {
  return <Library key={JSON.stringify([props.storageId, props.kind])} {...props} />;
}

function Library({ storageId, kind, onBack, onAsk }: Props) {
  const scope = JSON.stringify(['tillith-media-v1', storageId, kind]);
  const film = kind === 'film';
  const [selection, setSelection] = useState(() => restore(scope));
  const [works, setWorks] = useState<MediaWork[]>([]);
  const [playlistName, setPlaylistName] = useState('');
  const [link, setLink] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [autoPlay, setAutoPlay] = useState('');
  const alive = useRef(false);
  const visible = works.filter(row => film || row.playlist === selection.playlist);
  const work = visible.find(row => row.id === selection.id) || visible[0];

  useEffect(() => {
    alive.current = true;
    let active = true;
    void listWorks(scope).then(rows => { if (active) { setWorks(rows); setReady(true); } })
      .catch(() => { if (active) setError('无法打开本机媒体库。请检查应用的本地存储权限。'); });
    return () => { active = false; alive.current = false; };
  }, [scope]);
  useEffect(() => {
    try { localStorage.setItem(scope, JSON.stringify(selection)); }
    catch { setError('无法保存当前选择，已导入的作品仍可在本机媒体库中打开。'); }
  }, [scope, selection]);

  function pick(id: string, play = false) {
    setError(''); setAutoPlay(play ? id : ''); setSelection(old => ({ ...old, id }));
  }
  async function importMedia(entries: { title: string; file?: File; url?: string }[]) {
    if (!entries.length || busy) return;
    setBusy(true); setError('');
    try {
      const rows = await addWorks(scope, kind, selection.playlist, entries);
      if (alive.current) {
        setWorks(old => [...old, ...rows]); pick(rows[0].id); setLink(''); setLinkTitle('');
      }
    } catch { if (alive.current) setError('导入未完成。请检查本机可用空间，或减少一次选择的文件数。'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function remove() {
    if (!work || !window.confirm('从本机媒体库移除这部作品及其播放进度和字幕？')) return;
    setBusy(true);
    try {
      await removeWork(work.id);
      if (alive.current) setWorks(old => old.filter(row => row.id !== work.id));
    } catch { if (alive.current) setError('本机移除失败。'); }
    finally { if (alive.current) setBusy(false); }
  }
  function step(direction: number, play: boolean) {
    const index = visible.findIndex(row => row.id === work?.id);
    const next = visible[index + direction];
    if (next) pick(next.id, play);
  }
  return <main className="settings-page media-workspace">
    <header className="page-heading"><div><button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />更多</button><h1>{film ? '一起看电影' : '一起听歌'}</h1></div></header>
    {error && <p role="alert" className="provider-notice">{error}</p>}
    {!film && <div className="media-playlists"><label>歌单<select aria-label="歌单" value={selection.playlist} onChange={event => {
      setAutoPlay(''); setSelection({ ...selection, playlist: event.target.value, id: '' });
    }}>{[...new Set([...selection.lists, ...works.map(row => row.playlist)])].map(name => <option key={name}>{name}</option>)}</select></label>
      <details><summary>新建歌单</summary><form onSubmit={event => {
        event.preventDefault(); const name = playlistName.trim(); if (!name) return;
        setSelection(old => ({ lists: [...new Set([...old.lists, name])], playlist: name, id: '' })); setPlaylistName('');
      }}><input aria-label="歌单名称" maxLength={80} value={playlistName} onChange={e => setPlaylistName(e.target.value)} />
        <button className="secondary-button" disabled={!playlistName.trim()}>创建歌单</button></form></details>
    </div>}
    <div className="media-imports">
      <label className="secondary-button media-file"><Icon name="plus" size={16} />{film ? '导入本地影片' : '添加本地歌曲'}
        <input type="file" multiple accept={film ? 'video/*,.mkv,.webm,.mp4,.mov,.m4v' : 'audio/*,.mp3,.m4a,.aac,.flac,.ogg,.wav,.opus'} disabled={busy || !ready}
          onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void importMedia(files.map(file => ({ file, title: file.name }))); }} />
      </label>
      {film && <details><summary>添加视频直链</summary><form onSubmit={event => {
        event.preventDefault();
        try { void importMedia([{ title: linkTitle.trim() || '在线影片', url: playableUrl(link.trim()) }]); }
        catch (reason) { setError((reason as Error).message); }
      }}><input aria-label="影片名称" placeholder="影片名称" value={linkTitle} maxLength={160} onChange={e => setLinkTitle(e.target.value)} />
        <input type="url" aria-label="视频直链" placeholder="https://…" required value={link} onChange={e => setLink(e.target.value)} />
        <button className="secondary-button" disabled={busy || !ready}>添加影片</button></form></details>}
    </div>
    {work && <><div className="media-select"><label>{film ? '影片' : '歌曲'}<select value={work.id} onChange={e => pick(e.target.value)}>
      {visible.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      <button type="button" className="text-button" disabled={busy} onClick={() => void remove()}>移除</button></div>
      <Player work={work} autoPlay={autoPlay === work.id} onAsk={onAsk}
        hasPrevious={visible[0]?.id !== work.id} hasNext={visible[visible.length - 1]?.id !== work.id} onStep={step} />
    </>}
    {ready && !work && <p className="media-hint">{film ? '选择一部影片，再添加 SRT 或 VTT 字幕。' : '先向这个歌单添加歌曲。每首歌可以配一份 LRC 歌词。'}</p>}
  </main>;
}

function Player({ work, autoPlay, onAsk, hasPrevious, hasNext, onStep }: {
  work: MediaWork; autoPlay: boolean; onAsk: Props['onAsk']; hasPrevious: boolean; hasNext: boolean;
  onStep: (direction: number, play: boolean) => void;
}) {
  const media = useRef<HTMLMediaElement | null>(null);
  const live = useRef('');
  const [loaded, setLoaded] = useState<{ id: string; url: string; position: number }>();
  const [cues, setCues] = useState<Cue[]>([]);
  const [position, setPosition] = useState(0);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const binding = useRef<{ id: string; position: number; saved: number; ready: boolean } | undefined>(undefined);
  const film = work.kind === 'film';
  const src = loaded?.id === work.id ? loaded.url : undefined;

  function remember(force: boolean) {
    const state = binding.current, player = media.current;
    if (!state?.ready || !player || state.id !== live.current) return;
    const seconds = player.ended ? 0 : player.currentTime;
    if (!Number.isFinite(seconds)) return;
    state.position = seconds;
    setPosition(player.currentTime);
    if (!force && Math.abs(seconds - state.saved) < 2) return;
    state.saved = seconds;
    void savePosition(state.id, seconds).catch(() => { if (live.current === state.id) setError('播放进度未能保存。'); });
  }

  useEffect(() => {
    const id = work.id;
    live.current = id;
    let active = true;
    let localUrl = '';
    setCues([]); setPosition(0); setQuestion(''); setError(''); setAsking(false);
    binding.current = { id, position: 0, saved: 0, ready: false };
    void loadWork(work).then(data => {
      if (!active) return;
      if (data.file) localUrl = URL.createObjectURL(data.file);
      setCues(data.cues); setPosition(data.position);
      setLoaded({ id, url: localUrl || work.url!, position: data.position });
    }).catch(() => { if (active) setError('无法读取这部作品，请重新导入本地媒体。'); });
    const hide = () => { if (document.hidden) remember(true); };
    const flush = () => remember(true);
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', flush);
    return () => {
      const state = binding.current;
      active = false;
      live.current = '';
      if (state?.id === id && state.ready && state.position !== state.saved) void savePosition(id, state.position).catch(() => {});
      if (localUrl) URL.revokeObjectURL(localUrl);
      document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', flush);
    };
  }, [work]);

  const step = useRef(onStep); step.current = onStep;
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    if (!src || !media.current) return;
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => { void media.current?.play().catch(() => setError('请在播放器中点击播放。')); },
      pause: () => media.current?.pause(),
      seekto: detail => { if (media.current && typeof detail.seekTime === 'number' && Number.isFinite(media.current.duration)) media.current.currentTime = Math.max(0, Math.min(media.current.duration, detail.seekTime)); },
    };
    if (!film && hasNext) handlers.nexttrack = () => step.current(1, true);
    if (!film && hasPrevious) handlers.previoustrack = () => step.current(-1, true);
    if (!film) {
      const release = nativeMediaControls(media.current, work.id, work.title, handlers, setSupported);
      if (release) return release;
    }
    if (!('mediaSession' in navigator)) { setSupported(false); return; }
    const session = navigator.mediaSession;
    if ('MediaMetadata' in window) session.metadata = new MediaMetadata({ title: work.title, album: film ? '' : work.playlist });
    const installed: MediaSessionAction[] = [];
    for (const [name, handler] of Object.entries(handlers)) {
      const action = name as MediaSessionAction;
      try { session.setActionHandler(action, handler!); installed.push(action); } catch { /* Unsupported OS action. */ }
    }
    setSupported(installed.includes('play') && installed.includes('pause'));
    return () => {
      for (const action of installed) session.setActionHandler(action, null);
      session.metadata = null; session.playbackState = 'none';
    };
  }, [src, work.id, work.title, work.playlist, film, hasNext, hasPrevious]);

  const ribbon = useMemo(() => appeared(cues, position, 5), [cues, position]);
  const attributes = {
    controls: true, preload: 'metadata', src,
    onLoadedMetadata: () => {
      const player = media.current, state = binding.current;
      if (!player || !state || !src || player.currentSrc !== src || loaded?.id !== state.id) return;
      state.ready = true;
      const resume = Number.isFinite(player.duration) ? Math.min(loaded.position, player.duration) : loaded.position;
      player.currentTime = resume; state.position = resume; state.saved = resume;
      if (autoPlay) void player.play().catch(() => setError('已切到下一首，请点击播放。'));
    },
    onTimeUpdate: () => remember(false), onSeeked: () => remember(true),
    onPlay: () => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; },
    onPause: () => { remember(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; },
    onEnded: () => { remember(true); if (!film && hasNext) onStep(1, true); },
    onError: () => { if (src) setError('当前编码或链接无法播放。请更换兼容文件，或检查视频直链。'); },
  };
  async function attach(file: File) {
    const id = work.id;
    try {
      const rows = await readCues(file, work.kind);
      if (live.current !== id) return;
      await saveCues(id, rows);
      if (live.current === id) { setCues(rows); setError(''); }
    } catch (reason) { if (live.current === id) setError(reason instanceof Error ? reason.message : '时间轴导入失败。'); }
  }
  return <section className="media-player">
    {film ? <video {...attributes} playsInline ref={el => { media.current = el; }} aria-label="影片播放器" />
      : <audio {...attributes} ref={el => { media.current = el; }} aria-label="歌曲播放器" />}
    {!film && <div className="media-transport"><button type="button" disabled={!hasPrevious} className="text-button" onClick={() => onStep(-1, true)}>上一首</button>
      <span>{supported ? '系统媒体键已接入' : '使用播放器控制'}</span>
      <button type="button" disabled={!hasNext} className="text-button" onClick={() => onStep(1, true)}>下一首</button></div>}
    <div className="media-script"><header><h2>{film ? '字幕纸带' : '同步歌词'}</h2>
      <label className="text-button media-file">{film ? '选择 SRT / VTT' : '选择 LRC'}
        <input type="file" accept={film ? '.srt,.vtt' : '.lrc'} disabled={!src} onChange={e => {
          const file = e.target.files?.[0]; e.target.value = ''; if (file) void attach(file);
        }} /></label></header>
      {ribbon.length ? <ol>{ribbon.map((cue, index) => <li key={index} className={cue.end === null || cue.end > position ? 'is-current' : ''}><time>{clockLabel(cue.start)}</time><span>{cue.text}</span></li>)}</ol>
        : <p className="media-hint">{cues.length ? '播放到第一行时，这里会同步显示。' : film ? '尚未添加字幕。' : '尚未添加歌词。'}</p>}
    </div>
    {error && <p className="provider-notice" role="alert">{error}</p>}
    <form className="media-ask" onSubmit={async event => {
      event.preventDefault(); if (!question.trim() || asking || !src) return;
      const id = work.id, attempt = binding.current;
      const isCurrentWork = () => live.current === id && binding.current === attempt;
      setAsking(true); setError(''); remember(true);
      const seconds = media.current?.currentTime ?? position;
      try { await onAsk(work.kind, id, work.title, mediaContext(work.kind, work.title, cues, seconds), question.trim(), isCurrentWork); }
      catch { if (isCurrentWork()) setError('这次提问未能完成，请检查会话连接。'); }
      finally { if (isCurrentWork()) setAsking(false); }
    }}>
      <label>{film ? '问这一幕' : '聊聊这首歌'}<textarea rows={2} maxLength={3000} value={question} onChange={e => setQuestion(e.target.value)} /></label>
      <p className="media-hint">{film ? '只发送片名、播放点和此刻之前的字幕。' : '只发送歌名、播放点和此刻之前的歌词。'}</p>
      <button className="primary-button" disabled={!src || !question.trim() || asking}>{asking ? '正在打开对话…' : '发送到作品对话'}</button>
    </form>
  </section>;
}

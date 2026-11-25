import React, {useEffect, useRef, useState} from 'react';
import {timeLabel} from '../src/records/core.ts';
import {meetingAudioDuration, meetingAudioWindowMs, readMeetingAudioWindow} from './meeting-archive.ts';

type Position = {start: number; end: number; at: number; node: AudioBufferSourceNode};
type Listening = {segments: Position[]; next: number; settled: number; reading: boolean};

/** Keep only the current and next window decoded, scheduling them on one audio clock. */
function createPlayer(id: string, duration: number, position: (ms: number) => void, playing: (active: boolean) => void,
  issue: (message: string) => void) {
  let context: AudioContext | undefined;
  let active: Listening | undefined;
  let updateTimer: ReturnType<typeof setInterval> | undefined;

  function currentPosition() {
    if (!context || !active) return undefined;
    const elapsed = context.currentTime;
    const segment = active.segments.findLast(window => elapsed >= window.at);
    return segment ? Math.min(segment.end, segment.start + (elapsed - segment.at) * 1000) : active.settled;
  }

  function pause() {
    const at = currentPosition();
    const session = active;
    active = undefined;
    clearInterval(updateTimer);
    for (const {node} of session?.segments ?? []) {
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    return at;
  }

  function failed(session: Listening) {
    if (session !== active) return;
    const at = pause();
    if (at !== undefined) position(at);
    playing(false);
    issue('회의 음성을 재생하지 못했습니다. 다시 시도해 주세요.');
  }

  async function schedule(session: Listening, audio: AudioContext): Promise<void> {
    if (active !== session || session.reading || session.segments.length >= 2 || session.next >= duration) return;
    const start = session.next;
    const end = Math.min(duration, start + meetingAudioWindowMs);
    session.reading = true;
    try {
      const clip = await readMeetingAudioWindow(id, start, end);
      if (active !== session) return;
      if (!clip) throw Error('저장한 음성 구간이 없습니다.');
      const pcm = await audio.decodeAudioData(await clip.arrayBuffer());
      if (active !== session) return;
      const node = audio.createBufferSource();
      const previous = session.segments.at(-1);
      const at = Math.max(audio.currentTime + 0.02, previous ? previous.at + (previous.node.buffer?.duration ?? 0) : 0);
      node.buffer = pcm;
      node.connect(audio.destination);
      node.onended = () => {
        node.disconnect();
        if (active !== session) return;
        session.segments = session.segments.filter(window => window.node !== node);
        session.settled = end;
        if (end >= duration) {
          pause();
          position(duration);
          playing(false);
        } else void schedule(session, audio);
      };
      node.start(at);
      session.segments.push({start,end,at,node});
      session.next = end;
      session.reading = false;
      void schedule(session, audio);
    } catch { failed(session); }
  }

  async function play(ms: number) {
    pause();
    const start = ms >= duration ? 0 : ms;
    const session = {segments:[],next:start,settled:start,reading:false};
    active = session;
    issue('');
    position(start);
    playing(true);
    try {
      context ??= new AudioContext();
      if (context.state !== 'running') await context.resume();
      if (active !== session) return;
      updateTimer = setInterval(() => {
        const at = currentPosition();
        if (at !== undefined) position(at);
      }, 150);
      await schedule(session, context);
    } catch { failed(session); }
  }

  return {play, pause, dispose() {pause(); if (context) void context.close().catch(() => {});}};
}

export function WholeMeetingPlayback({id, panelId, close}: {id: string; panelId: string; close(): void}) {
  const [duration, setDuration] = useState<number>();
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [issue, setIssue] = useState('');
  const transport = useRef<ReturnType<typeof createPlayer> | undefined>(undefined);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void meetingAudioDuration(id).then(end => {
      if (!live) return;
      if (end) {
        setDuration(end);
        transport.current = createPlayer(id, end, setPosition, setPlaying, setIssue);
      } else setIssue('저장한 회의 음성이 없습니다.');
    }).catch(() => { if (live) setIssue('저장한 회의 음성을 불러오지 못했습니다.'); });
    return () => {
      live = false;
      clearTimeout(seekTimer.current);
      transport.current?.dispose();
      transport.current = undefined;
    };
  }, [id]);

  function toggle() {
    clearTimeout(seekTimer.current);
    if (playing) {
      const at = transport.current?.pause();
      if (at !== undefined) setPosition(at);
      setPlaying(false);
    } else void transport.current?.play(position);
  }

  function seek(ms: number) {
    clearTimeout(seekTimer.current);
    transport.current?.pause();
    setPosition(ms);
    if (playing) {
      if (ms >= (duration ?? 0)) setPlaying(false);
      else seekTimer.current = setTimeout(() => { void transport.current?.play(ms); }, 120);
    }
  }

  return <aside id={panelId} className="summary meeting-player whole-meeting-player" aria-label="전체 회의 음성">
    <strong>전체 회의 음성</strong>
    <p className="muted">보관하지 않은 구간은 소리 없이 재생됩니다.</p>
    {duration ? <>
      <div className="actions">
        <button type="button" className="button primary" onClick={toggle}>{playing ? '일시정지' : '재생'}</button>
        <span>{timeLabel(position)} / {timeLabel(duration)}</span>
      </div>
      <input type="range" min={0} max={Math.ceil(duration)} step={1} value={Math.round(position)} aria-label="재생 위치"
        aria-valuetext={timeLabel(position)} onChange={event => seek(event.target.valueAsNumber)} />
    </> : !issue && <span role="status">음성을 불러오는 중…</span>}
    {issue && <p role="status">{issue}</p>}
    <button type="button" className="button quiet" onClick={close}>재생 닫기</button>
  </aside>;
}

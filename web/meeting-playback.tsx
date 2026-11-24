import React, {useEffect, useRef, useState} from 'react';
import {timeLabel, type RecordData, type Turn} from '../src/records/core.ts';
import {hasMeetingArchive, readMeetingAudio} from './meeting-archive.ts';

export function useMeetingPlayback(record: RecordData) {
  const [available, setAvailable] = useState(false);
  const [playing, setPlaying] = useState<Turn>();
  const [clipUrl, setClipUrl] = useState<string>();
  const [issue, setIssue] = useState('');
  const generation = useRef(0);
  const url = useRef<string | undefined>(undefined);
  function clearClip() {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = undefined;
  }
  const eligible = record.kind === 'meeting' && !record.originalFilename;
  const id = record.id;
  useEffect(() => {
    let live = true;
    setAvailable(false);
    setPlaying(undefined);
    setClipUrl(undefined);
    setIssue('');
    if (eligible) void hasMeetingArchive(id).then(exists => {
      if (live) setAvailable(exists);
    }).catch(() => {
      if (live) setIssue('저장한 회의 음성을 확인하지 못했습니다.');
    });
    return () => {live = false; generation.current++; clearClip();};
  }, [id, eligible]);
  function close() {
    generation.current++;
    clearClip();
    setClipUrl(undefined);
    setPlaying(undefined);
    setIssue('');
  }
  async function play(turn: Turn) {
    close();
    const request = generation.current;
    setPlaying(turn);
    try {
      const next = record.turns.find(other => other.section !== 'followup' && other.timeMs > turn.timeMs);
      const end = Math.min(next?.timeMs ?? turn.timeMs + 30_000, turn.timeMs + 30_000);
      const clip = await readMeetingAudio(id, turn.timeMs, end, {stopAtGap:true});
      if (request !== generation.current) return;
      if (!clip) {setIssue('이 시점에 보관된 회의 음성이 없습니다.'); return;}
      url.current = URL.createObjectURL(clip);
      setClipUrl(url.current);
    } catch {
      if (request === generation.current) setIssue('이 발언의 음성을 불러오지 못했습니다.');
    }
  }
  function playAt(turn: Turn) {
    return available && turn.section === 'meeting' && turn.role === 'speaker'
      ? <button type="button" className="button quiet turn-play" aria-label={`${timeLabel(turn.timeMs)} 음성 재생`} onClick={() => void play(turn)}>▶ 듣기</button>
      : null;
  }
  const player = playing ? <aside className="summary meeting-player" aria-label="회의 음성 재생">
    <strong>{timeLabel(playing.timeMs)} 발언 음성</strong>
    {clipUrl ? <audio aria-label="선택한 발언 음성" controls autoPlay src={clipUrl} /> :
      !issue && <span role="status">음성을 불러오는 중…</span>}
    {issue && <span role="status">{issue}</span>}
    <button type="button" className="button quiet" onClick={close}>재생 닫기</button>
  </aside> : issue ? <p role="status">{issue}</p> : null;
  return {available, playAt, player};
}

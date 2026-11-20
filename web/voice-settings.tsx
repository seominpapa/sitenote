import React, { useEffect, useRef, useState } from 'react';
import { AI_VOICES, DEFAULT_AI_VOICE, isAiVoice, type AiVoice } from '../server/voices.mjs';
import { fetchVoicePreview } from './api.ts';

const storageKey = 'sitenote:ai-voice';

export function loadAiVoice(): AiVoice {
  try {
    const stored = localStorage.getItem(storageKey);
    if (isAiVoice(stored)) return stored;
  } catch { /* No preference is available. */ }
  return DEFAULT_AI_VOICE;
}

export function saveAiVoice(voice: AiVoice) {
  localStorage.setItem(storageKey, voice);
}

export function VoiceSettings({ voice, change, disabled, canPreview }: {
  voice: AiVoice; change: (voice: AiVoice) => void; disabled: boolean; canPreview: boolean;
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState('');
  const active = useRef<{controller: AbortController; context: AudioContext} | undefined>(undefined);

  function dispose() {
    const preview = active.current;
    if (!preview) return;
    active.current = undefined;
    preview.controller.abort();
    if (preview.context.state !== 'closed') void preview.context.close().catch(() => undefined);
  }
  useEffect(() => {
    const hide = () => { dispose(); setStatus('idle'); };
    window.addEventListener('pagehide', hide);
    return () => { window.removeEventListener('pagehide', hide); dispose(); };
  }, []);

  async function play() {
    if (active.current) return;
    setError('');
    setStatus('loading');
    const controller = new AbortController();
    try {
      const context = new AudioContext();
      active.current = {context, controller};
      await context.resume();
      if (controller.signal.aborted) return;
      const wave = await fetchVoicePreview(voice, controller.signal);
      if (controller.signal.aborted) return;
      const buffer = await context.decodeAudioData(wave);
      if (controller.signal.aborted) return;
      const output = context.createBufferSource();
      output.buffer = buffer;
      output.connect(context.destination);
      output.onended = () => { if (!controller.signal.aborted) { dispose(); setStatus('idle'); } };
      output.start();
      setStatus('playing');
    } catch (cause) {
      if (controller.signal.aborted) return;
      dispose();
      setStatus('idle');
      setError(cause instanceof Error && !(cause instanceof DOMException) ? cause.message : '목소리를 미리 재생하지 못했습니다.');
    }
  }

  return <div className="summary">
    <h2>AI 목소리</h2>
    <p>녹음 중 AI 답변과 회의 후 보충질문에 선택한 목소리가 적용됩니다.</p>
    <div className="actions voice-setting">
      <select aria-label="AI 목소리" value={voice} disabled={disabled || status !== 'idle'} onChange={event => {
        if (isAiVoice(event.currentTarget.value)) { setError(''); change(event.currentTarget.value); }
      }}>
        {AI_VOICES.map(id => <option key={id} value={id}>{id[0].toUpperCase() + id.slice(1)}{id === DEFAULT_AI_VOICE ? ' (기본)' : ''}</option>)}
      </select>
      {status === 'idle' ? <button className="button quiet" disabled={disabled || !canPreview} onClick={() => void play()}>짧게 들어보기</button>
        : <button className="button quiet" onClick={() => { dispose(); setStatus('idle'); }}>미리듣기 중지</button>}
    </div>
    {!canPreview && <p className="muted">미리 듣기를 사용하려면 OpenAI API 키를 저장하세요.</p>}
    {status !== 'idle' && <p role="status">{status === 'loading' ? '목소리 미리듣기 준비 중…' : '미리듣기 재생 중'}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

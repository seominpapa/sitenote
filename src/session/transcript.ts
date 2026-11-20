import type { Turn } from '../records/core.ts';

type Section = Turn['section'];
type Piece = { key: string; text: string; start: number; end: number };
type Segment = { pieces: Piece[]; turn: Turn };
type Change = { partials: Turn[]; turns: Turn[] };

export type SonioxToken = { text?: unknown; is_final?: unknown; start_ms?: unknown; end_ms?: unknown; speaker?: unknown };
export type LiveEvent = { type?: unknown; event_id?: unknown; delta?: unknown; start_ms?: unknown; end_ms?: unknown };

const validTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function sonioxTranscript() {
  let stream = '';
  let groups: Segment[] = [];
  let sealed = false;
  let watermark = 0;

  return {
    receive(streamId: string, offsetMs: number, tokens: SonioxToken[], sectionAt: (time: number) => Section): Change {
      if (stream !== streamId) {
        stream = streamId;
        groups = [];
        sealed = false;
        watermark = 0;
      }
      const positions = new Map<number, number>();
      const changed = new Map<string, Turn>();
      let partials: Turn[] = [];
      const update = (index: number, group: Segment, pieces: Piece[]) => {
        const turn = { ...group.turn, text: pieces.map(piece => piece.text).join('') };
        groups = [...groups.slice(0, index), { pieces, turn }, ...groups.slice(index + 1)];
        if (turn.text !== group.turn.text && turn.text.trim()) changed.set(turn.id, turn);
      };

      for (const token of tokens) {
        if (!token || typeof token.text !== 'string') continue;
        if (token.text === '<end>' || token.text === '<fin>') {
          if (token.is_final === true) sealed = true;
          continue;
        }
        const start = validTime(token.start_ms) ? token.start_ms : watermark;
        const end = validTime(token.end_ms) ? Math.max(start, token.end_ms) : start;
        const timeMs = offsetMs + start;
        const section = sectionAt(timeMs);
        const speaker = typeof token.speaker === 'string' && token.speaker ? token.speaker : undefined;
        // Soniox diarization labels are local to a stream, not identities shared with the meeting.
        const speakerId = !speaker || section === 'personal' ? undefined :
          `${section === 'followup' ? 'followup' : 'meeting'}:${streamId}:${speaker}`;
        const base = { role: section === 'personal' ? 'user' as const : 'speaker' as const, section, timeMs, speakerId };
        if (token.is_final !== true) {
          const previous = partials.at(-1);
          if (previous?.speakerId === speakerId && previous?.section === section) {
            partials = [...partials.slice(0, -1), { ...previous, text: previous.text + token.text }];
          } else {
            partials = [...partials, { ...base, id: `preview-${stream}-${start}-${partials.length}`, text: token.text }];
          }
          continue;
        }
        const occurrence = positions.get(start) ?? 0;
        positions.set(start, occurrence + 1);
        const key = `${start}-${occurrence}`;
        const piece = { key, text: token.text, start, end };
        const priorIndex = groups.findIndex(group => group.pieces.some(existing => existing.key === key));
        if (priorIndex !== -1) {
          const group = groups[priorIndex];
          update(priorIndex, group, group.pieces.map(existing => existing.key === key ? piece : existing));
          continue;
        }
        // shortcut: final Soniox tokens are sent once in order; ignore late replays beyond the 30-second correction buffer.
        if (start < watermark - 30_000) continue;
        watermark = Math.max(watermark, end);
        const previous = groups.at(-1);
        const last = previous?.pieces.at(-1);
        if (!sealed && previous && last && previous.turn.section === section && previous.turn.speakerId === speakerId
          && start >= last.start && start - last.end < 1_500 && timeMs - previous.turn.timeMs < 15_000) {
          update(groups.length - 1, previous, [...previous.pieces, piece]);
        } else {
          const turn = { ...base, id: `soniox-${stream}-${key}`, text: token.text };
          groups = [...groups, { pieces: [piece], turn }];
          if (turn.text.trim()) changed.set(turn.id, turn);
        }
        sealed = false;
      }
      groups = groups.filter(group => (group.pieces.at(-1)?.end ?? 0) >= watermark - 30_000);
      return { turns: [...changed.values()], partials };
    },
  };
}

export function liveTranscript(section: Exclude<Section, 'meeting'>) {
  let stream = '';
  let current: { turn: Turn; end: number } | undefined;
  let lastAi: Turn | undefined;
  let captions: Array<{turn:Turn; audibleEnd:number}> = [];
  const seen = new Set<string>();
  const empty: Change = { turns: [], partials: [] };

  return {
    receive(streamId: string, offsetMs: number, event: LiveEvent, fallbackTime = offsetMs, sourceRefs?: string[], quotedRefs?: string[]): Change {
      const output = event.type === 'session.output_transcript.delta';
      const input = event.type === 'session.input_transcript.delta';
      if ((!output && (!input || section !== 'personal')) || typeof event.delta !== 'string' || !event.delta) {
        return empty;
      }
      if (stream !== streamId) {
        stream = streamId;
        current = undefined;
        lastAi = undefined;
        captions = [];
        seen.clear();
      }
      const role = output ? 'ai' : 'user';
      const start = validTime(event.start_ms) ? offsetMs + event.start_ms : fallbackTime;
      const end = validTime(event.end_ms) ? Math.max(start, offsetMs + event.end_ms) : start;
      const key = typeof event.event_id === 'string' && event.event_id ? event.event_id : `${role}-${start}-${end}-${event.delta}`;
      if (seen.has(key)) return empty;
      seen.add(key);
      const previous = current?.turn;
      // Realtime requests have an app-generated stream ID per ordinary answer.
      // GPT-Live followup may pause inside a question but opens a new stream for each prompt.
      const draft: Turn = previous?.role === role && current && (output || start - current.end < 1_500)
        ? { ...previous, text: previous.text + event.delta }
        : { id: `live-${stream}-${role}-${seen.size}`, role, section, timeMs: start, text: event.delta,
          ...(output && sourceRefs?.length ? { sourceRefs } : {}) };
      const verified = new Set([...(draft.quotedRefs ?? []), ...(quotedRefs ?? [])]);
      const quotes = draft.sourceRefs?.filter(ref => verified.has(ref));
      const turn = quotes?.length ? {...draft,quotedRefs:quotes} : draft;
      if (section === 'followup' && output) {
        if (captions.at(-1)?.turn.id !== turn.id) captions = [];
        captions.push({turn,audibleEnd:Math.max(end,captions.at(-1)?.audibleEnd ?? 0)});
      }
      current = { turn, end };
      if (output) lastAi = turn;
      return { turns: turn.text.trim() ? [turn] : [], partials: [] };
    },
    heard(milliseconds: number, interrupted = false): Turn[] {
      const first = captions[0]?.turn;
      if (!first || milliseconds <= 0) return [];
      // Only complete timed fragments can be claimed as heard. Never guess at
      // a character boundary inside a transcript delta.
      const confirmed = captions.findLast(fragment => fragment.audibleEnd <= first.timeMs + milliseconds);
      if (!confirmed?.turn.text.trim()) return [];
      return [{...confirmed.turn,...(interrupted && confirmed !== captions.at(-1) ? {interrupted:true} : {})}];
    },
    interrupt(): Change {
      if (!lastAi) return empty;
      const interrupted = { ...lastAi, interrupted: true };
      lastAi = undefined;
      current = undefined;
      return { turns: interrupted.text.trim() ? [interrupted] : [], partials: [] };
    },
    outputDrained() {
      lastAi = undefined;
      captions = [];
      if (section === 'followup' && current?.turn.role === 'ai') current = undefined;
    },
  };
}

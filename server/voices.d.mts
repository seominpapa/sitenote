export type AiVoice = 'marin' | 'ash' | 'alloy' | 'ballad' | 'cedar' | 'coral' | 'echo' | 'noeul' | 'sage' | 'shimmer' | 'verse';
export const DEFAULT_AI_VOICE: 'marin';
export const AI_VOICES: readonly AiVoice[];
export function isAiVoice(value: unknown): value is AiVoice;

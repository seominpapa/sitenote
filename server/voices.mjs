export const DEFAULT_AI_VOICE = 'marin';
export const AI_VOICES = Object.freeze([
  DEFAULT_AI_VOICE, 'ash', 'alloy', 'ballad', 'cedar', 'coral', 'echo', 'noeul', 'sage', 'shimmer', 'verse',
]);
export const isAiVoice = value => AI_VOICES.includes(value);

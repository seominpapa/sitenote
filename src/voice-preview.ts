type VoicePreviewResponse = Pick<Response, 'ok' | 'headers' | 'json' | 'arrayBuffer'>;

export async function readVoicePreview(response: VoicePreviewResponse) {
  const invalid = '미리듣기 음성을 받지 못했습니다.';
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw Error(typeof result?.error === 'string' ? result.error : invalid);
  }
  if (!/^audio\/wav(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw Error(invalid);
  const rate = 24_000;
  const maxBytes = 44 + 8 * rate * 2;
  if (Number(response.headers.get('content-length')) > maxBytes) throw Error(invalid);
  const wave = await response.arrayBuffer();
  if (wave.byteLength <= 44 || wave.byteLength > maxBytes) throw Error(invalid);
  const header = new DataView(wave);
  if (wave.byteLength % 2 || header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57415645 ||
      header.getUint32(12) !== 0x666d7420 || header.getUint32(36) !== 0x64617461 ||
      header.getUint32(4, true) !== wave.byteLength - 8 || header.getUint32(16, true) !== 16 ||
      header.getUint16(20, true) !== 1 || header.getUint16(22, true) !== 1 || header.getUint32(24, true) !== rate ||
      header.getUint32(28, true) !== rate * 2 || header.getUint16(32, true) !== 2 || header.getUint16(34, true) !== 16 ||
      header.getUint32(40, true) !== wave.byteLength - 44) throw Error(invalid);
  return wave;
}

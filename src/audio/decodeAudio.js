/**
 * Decode an audio URL or File into an AudioBuffer.
 */
export async function decodeAudioSource(source, { sampleRate } = {}) {
  const arrayBuffer =
    typeof source === 'string'
      ? await (await fetch(source)).arrayBuffer()
      : await source.arrayBuffer();

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx(sampleRate ? { sampleRate } : undefined);
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Mix down to mono Float32Array. */
export function audioBufferToMono(buffer) {
  const { numberOfChannels, length } = buffer;
  if (numberOfChannels === 1) {
    return buffer.getChannelData(0).slice(0);
  }

  const mono = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / numberOfChannels;
    }
  }
  return mono;
}

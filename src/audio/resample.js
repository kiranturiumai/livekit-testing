/**
 * Linear resample mono PCM to a target sample rate.
 */
export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) {
    return input instanceof Float32Array ? input : new Float32Array(input);
  }

  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const srcIndex = i / ratio;
    const left = Math.floor(srcIndex);
    const right = Math.min(left + 1, input.length - 1);
    const frac = srcIndex - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }

  return output;
}

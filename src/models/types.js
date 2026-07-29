/**
 * Pluggable noise-suppression model contract.
 *
 * Each model adapter exposes:
 * - id / label
 * - prepare()
 * - process(samples, sampleRate, { attenLimDb, onProgress }) -> { samples, sampleRate, stats }
 */

export const MODEL_SAMPLE_RATE = 48000;

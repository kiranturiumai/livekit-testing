/**
 * Choose between DeepFilterNet (primary) and RNNoise (fallback)
 * based on device capability heuristics.
 *
 * DeepFilterNet is heavier (ONNX Runtime + ~10MB model).
 * RNNoise is lightweight WASM (~110KB) and suitable for low-end / mobile.
 */

export const LIVE_NOISE_MODELS = {
  DEEPFILTERNET: 'deepfilternet-ort',
  RNNOISE: 'rnnoise-wasm',
};

/** Minimum capability score required to run DeepFilterNet in a live call. */
export const DFN_CAPABILITY_THRESHOLD = 70;

/**
 * Snapshot of the current browser / device for model selection.
 */
export function assessSystemCapability() {
  const cores = navigator.hardwareConcurrency || 2;
  const memoryGB =
    typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;
  const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry/i.test(ua);
  const hasWasm = typeof WebAssembly !== 'undefined';
  const hasSimd =
    typeof WebAssembly !== 'undefined' &&
    typeof WebAssembly.validate === 'function';

  // Weighted score (approx 0–150+). Higher = better suited for DeepFilterNet.
  let score = 0;
  score += Math.min(cores, 8) * 10; // 0–80
  if (memoryGB != null) {
    score += Math.min(memoryGB, 8) * 8; // 0–64
  } else {
    // Unknown memory: assume mid-range desktop, low on mobile.
    score += isMobile ? 16 : 32;
  }
  if (!isMobile) score += 25;
  if (hasWasm) score += 10;
  if (hasSimd) score += 5;

  return {
    cores,
    memoryGB,
    isMobile,
    hasWasm,
    score,
  };
}

/**
 * Decide which live noise model to use.
 *
 * @param {{ forceModel?: string, threshold?: number }} [options]
 * @returns {{
 *   modelId: string,
 *   modelLabel: string,
 *   reason: string,
 *   assessment: ReturnType<typeof assessSystemCapability>,
 * }}
 */
export function selectNoiseModel(options = {}) {
  const threshold = options.threshold ?? DFN_CAPABILITY_THRESHOLD;
  const assessment = assessSystemCapability();

  if (options.forceModel === LIVE_NOISE_MODELS.DEEPFILTERNET) {
    return {
      modelId: LIVE_NOISE_MODELS.DEEPFILTERNET,
      modelLabel: 'DeepFilterNet3',
      reason: 'Forced DeepFilterNet',
      assessment,
    };
  }
  if (options.forceModel === LIVE_NOISE_MODELS.RNNOISE) {
    return {
      modelId: LIVE_NOISE_MODELS.RNNOISE,
      modelLabel: 'RNNoise',
      reason: 'Forced RNNoise',
      assessment,
    };
  }

  const useDfn = assessment.score >= threshold && assessment.hasWasm;

  if (useDfn) {
    const memLabel =
      assessment.memoryGB != null ? `${assessment.memoryGB} GB RAM` : 'RAM unknown';
    return {
      modelId: LIVE_NOISE_MODELS.DEEPFILTERNET,
      modelLabel: 'DeepFilterNet3',
      reason: `Capable device (score ${assessment.score}, ${assessment.cores} cores, ${memLabel})`,
      assessment,
    };
  }

  const why = [];
  if (assessment.score < threshold) {
    why.push(`score ${assessment.score} < ${threshold}`);
  }
  if (assessment.isMobile) why.push('mobile');
  if (!assessment.hasWasm) why.push('no WebAssembly');
  if (assessment.cores < 4) why.push(`${assessment.cores} cores`);
  if (assessment.memoryGB != null && assessment.memoryGB < 4) {
    why.push(`${assessment.memoryGB} GB RAM`);
  }

  return {
    modelId: LIVE_NOISE_MODELS.RNNOISE,
    modelLabel: 'RNNoise',
    reason: `Fallback (${why.join(', ') || 'low capability'})`,
    assessment,
  };
}

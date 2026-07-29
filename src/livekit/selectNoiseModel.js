/**
 * Choose between DeepFilterNet (primary) and RNNoise (fallback)
 * based on user strategy selected at join time.
 *
 * DeepFilterNet is heavier (ONNX Runtime + ~10MB model).
 * RNNoise is lightweight WASM (~110KB) and suitable as fallback / low-end.
 */

export const LIVE_NOISE_MODELS = {
  DEEPFILTERNET: 'deepfilternet-ort',
  RNNOISE: 'rnnoise-wasm',
  NSNET2: 'nsnet2-dns',
};

/** User-selectable live-call noise strategies (join form dropdown). */
export const NS_STRATEGIES = {
  DFN_ONLY: 'dfn-only',
  RNNOISE_ONLY: 'rnnoise-only',
  DFN_WITH_FALLBACK: 'dfn-with-rnnoise-fallback',
  NSNET2_ONLY: 'nsnet2-only',
};

export const NS_STRATEGY_OPTIONS = [
  {
    id: NS_STRATEGIES.DFN_ONLY,
    label: 'DeepFilterNet only',
  },
  {
    id: NS_STRATEGIES.RNNOISE_ONLY,
    label: 'RNNoise only',
  },
  {
    id: NS_STRATEGIES.DFN_WITH_FALLBACK,
    label: 'DeepFilterNet + RNNoise fallback',
  },
  {
    id: NS_STRATEGIES.NSNET2_ONLY,
    label: 'NSNet2 (MS DNS Challenge) — ~0.5s latency',
  },
];

/**
 * Snapshot of the current browser / device (shown in room UI).
 */
export function assessSystemCapability() {
  const cores = navigator.hardwareConcurrency || 2;
  const memoryGB =
    typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;
  const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry/i.test(ua);
  const hasWasm = typeof WebAssembly !== 'undefined';

  let score = 0;
  score += Math.min(cores, 8) * 10;
  if (memoryGB != null) {
    score += Math.min(memoryGB, 8) * 8;
  } else {
    score += isMobile ? 16 : 32;
  }
  if (!isMobile) score += 25;
  if (hasWasm) score += 10;

  return {
    cores,
    memoryGB,
    isMobile,
    hasWasm,
    score,
  };
}

/**
 * Resolve which model to start with for a given join strategy.
 *
 * @param {{ strategy?: string }} [options]
 */
export function selectNoiseModel(options = {}) {
  const strategy = options.strategy || NS_STRATEGIES.DFN_WITH_FALLBACK;
  const assessment = assessSystemCapability();

  if (strategy === NS_STRATEGIES.RNNOISE_ONLY) {
    return {
      modelId: LIVE_NOISE_MODELS.RNNOISE,
      modelLabel: 'RNNoise',
      reason: 'User selected RNNoise only',
      allowRnnoiseFallback: false,
      strategy,
      assessment,
    };
  }

  if (strategy === NS_STRATEGIES.DFN_ONLY) {
    return {
      modelId: LIVE_NOISE_MODELS.DEEPFILTERNET,
      modelLabel: 'DeepFilterNet3',
      reason: 'User selected DeepFilterNet only',
      allowRnnoiseFallback: false,
      strategy,
      assessment,
    };
  }

  if (strategy === NS_STRATEGIES.NSNET2_ONLY) {
    return {
      modelId: LIVE_NOISE_MODELS.NSNET2,
      modelLabel: 'NSNet2',
      reason: 'User selected NSNet2 (~0.5s chunked)',
      allowRnnoiseFallback: false,
      strategy,
      assessment,
    };
  }

  return {
    modelId: LIVE_NOISE_MODELS.DEEPFILTERNET,
    modelLabel: 'DeepFilterNet3',
    reason: 'User selected DeepFilterNet with RNNoise fallback',
    allowRnnoiseFallback: true,
    strategy,
    assessment,
  };
}

/**
 * Compute audio quality metrics comparing original and enhanced signals.
 * All inputs should be mono Float32Array at the same sample rate.
 */

/** Root Mean Square level in dB */
export function rmsDb(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  return 20 * Math.log10(Math.max(rms, 1e-10));
}

/** Peak amplitude in dB */
export function peakDb(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  return 20 * Math.log10(Math.max(peak, 1e-10));
}

/** Signal energy (sum of squares) */
export function signalEnergy(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  return sum;
}

/**
 * Estimate noise reduction ratio in dB.
 * Compares the energy of (original - enhanced) to the original.
 * Higher = more noise removed.
 */
export function noiseReductionDb(original, enhanced) {
  const len = Math.min(original.length, enhanced.length);
  let origEnergy = 0;
  let diffEnergy = 0;
  for (let i = 0; i < len; i += 1) {
    origEnergy += original[i] * original[i];
    const d = original[i] - enhanced[i];
    diffEnergy += d * d;
  }
  if (origEnergy < 1e-12) return 0;
  return 10 * Math.log10(diffEnergy / origEnergy);
}

/**
 * Estimate signal-to-distortion ratio (SDR) in dB.
 * Treats the original as reference — higher SDR means less distortion introduced.
 */
export function sdrDb(original, enhanced) {
  const len = Math.min(original.length, enhanced.length);
  let sigEnergy = 0;
  let distEnergy = 0;
  for (let i = 0; i < len; i += 1) {
    sigEnergy += original[i] * original[i];
    const d = original[i] - enhanced[i];
    distEnergy += d * d;
  }
  if (distEnergy < 1e-12) return 60;
  return 10 * Math.log10(sigEnergy / distEnergy);
}

/**
 * Spectral flux — measures how much the spectral content changed.
 * Lower = more gentle processing, higher = more aggressive.
 */
export function spectralChangeRatio(original, enhanced) {
  const len = Math.min(original.length, enhanced.length);
  let origEnergy = 0;
  let enhEnergy = 0;
  for (let i = 0; i < len; i += 1) {
    origEnergy += original[i] * original[i];
    enhEnergy += enhanced[i] * enhanced[i];
  }
  if (origEnergy < 1e-12) return 0;
  return enhEnergy / origEnergy;
}

/**
 * Compute all audio quality metrics at once.
 */
export function computeAudioMetrics(originalMono, enhancedMono, sampleRate) {
  const len = Math.min(originalMono.length, enhancedMono.length);
  const orig = originalMono.subarray(0, len);
  const enh = enhancedMono.subarray(0, len);

  return {
    originalRmsDb: rmsDb(orig),
    enhancedRmsDb: rmsDb(enh),
    originalPeakDb: peakDb(orig),
    enhancedPeakDb: peakDb(enh),
    noiseReductionDb: noiseReductionDb(orig, enh),
    sdrDb: sdrDb(orig, enh),
    energyRatio: spectralChangeRatio(orig, enh),
    durationSec: len / sampleRate,
  };
}

/**
 * Score a model run on a 0-100 scale and predict live-call suitability.
 *
 * Scoring weights:
 *  - RTF (40%): Must be well under 1.0 for real-time
 *  - Latency per frame (25%): Low per-frame latency = less jitter
 *  - Memory efficiency (15%): Lower is better for mobile/constrained devices
 *  - Noise reduction (10%): More aggressive = higher score
 *  - Signal preservation (10%): Less distortion = higher score
 */
export function scoreModelRun(runStats, audioMetrics) {
  const scores = {};

  // RTF score: 1.0 → 50pts, 0.5 → 80pts, 0.1 → 98pts, >2.0 → 0pts
  const rtf = runStats.rtf || 1;
  scores.rtf = Math.max(0, Math.min(100, 100 * (1 - rtf / 2)));

  // Per-frame latency score: <5ms → 100, 10ms → 70, 20ms → 40, >50ms → 0
  const msPerFrame = runStats.frames > 0
    ? runStats.elapsedMs / runStats.frames
    : runStats.elapsedMs;
  scores.latency = Math.max(0, Math.min(100, 100 * Math.exp(-msPerFrame / 15)));

  // Memory score: <50MB → 100, 100MB → 70, 200MB → 40, >500MB → 0
  const mem = runStats.peakMemoryMB || 50;
  scores.memory = Math.max(0, Math.min(100, 100 * Math.exp(-mem / 200)));

  // Noise reduction score: based on energy ratio change
  const nr = audioMetrics ? Math.abs(audioMetrics.noiseReductionDb) : 5;
  scores.noiseReduction = Math.max(0, Math.min(100, nr * 5));

  // Signal preservation: SDR > 15dB → great, < 5dB → poor
  const sdr = audioMetrics ? audioMetrics.sdrDb : 10;
  scores.signalPreservation = Math.max(0, Math.min(100, sdr * 5));

  // Weighted composite
  const overall = Math.round(
    scores.rtf * 0.4 +
    scores.latency * 0.25 +
    scores.memory * 0.15 +
    scores.noiseReduction * 0.1 +
    scores.signalPreservation * 0.1
  );

  // LiveKit prediction
  const frameBudgetMs = 10; // 480 samples at 48kHz = 10ms
  const liveCallReady = rtf < 0.8;
  const estimatedLatencyMs = msPerFrame + frameBudgetMs;
  const cpuBudgetPct = Math.min(100, rtf * 100);

  let liveCallVerdict;
  let liveCallColor;
  if (rtf < 0.3) {
    liveCallVerdict = 'Excellent — plenty of CPU headroom for a live call';
    liveCallColor = '#4ecf73';
  } else if (rtf < 0.6) {
    liveCallVerdict = 'Good — should work well on most devices';
    liveCallColor = '#4ecf73';
  } else if (rtf < 0.85) {
    liveCallVerdict = 'Marginal — may cause glitches on slower devices';
    liveCallColor = '#f59e0b';
  } else if (rtf < 1.0) {
    liveCallVerdict = 'Risky — barely real-time, expect audio drops';
    liveCallColor = '#ff6b6b';
  } else {
    liveCallVerdict = 'Not viable — cannot keep up with real-time audio';
    liveCallColor = '#ff6b6b';
  }

  return {
    scores,
    overall,
    msPerFrame,
    liveCall: {
      ready: liveCallReady,
      verdict: liveCallVerdict,
      verdictColor: liveCallColor,
      estimatedLatencyMs,
      cpuBudgetPct,
      frameBudgetMs,
    },
  };
}

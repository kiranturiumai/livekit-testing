import * as ort from 'onnxruntime-web';
import { MODEL_SAMPLE_RATE } from './types';
import { resampleLinear } from '../audio/resample';

export const NSNET2_ID = 'nsnet2-dns';

const MODEL_URL = '/models/nsnet2-20ms-48k-baseline.onnx';
const WASM_PATH = '/ort/';

const N_FFT = 1024;
const N_WIN = 960; // 20ms at 48kHz
const N_HOP = 480;  // 50% of window
const N_FREQ = N_FFT / 2 + 1; // 513

let sessionPromise = null;

function getNsnet2Session() {
  if (!sessionPromise) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.wasm.wasmPaths = WASM_PATH;
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
    });
  }
  return sessionPromise;
}

/** Symmetric sqrt-Hann window */
function sqrtHann(length) {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    win[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / length)));
  }
  return win;
}

/** Compute analysis window for perfect reconstruction OLA */
function synthesisWindow(win, hopSize) {
  const L = win.length;
  const awin = new Float32Array(L);
  for (let k = 0; k < hopSize; k += 1) {
    let sum = 0;
    for (let idx = k; idx < L; idx += hopSize) {
      sum += win[idx] * win[idx];
    }
    for (let idx = k; idx < L; idx += hopSize) {
      awin[idx] = win[idx] / sum;
    }
  }
  return awin;
}

/** Radix-2 in-place FFT (N must be power of 2) */
function fftInPlace(re, im, invert) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = ((invert ? -1 : 1) * 2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < half; j += 1) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const tmp = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmp;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Real FFT: input is N real samples (N must be power of 2), returns N/2+1 complex bins */
function rfft(frame, nfft) {
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  for (let i = 0; i < frame.length && i < nfft; i += 1) {
    re[i] = frame[i];
  }
  fftInPlace(re, im, false);
  return {
    real: re.slice(0, nfft / 2 + 1),
    imag: im.slice(0, nfft / 2 + 1),
  };
}

/** Inverse real FFT: N/2+1 complex bins → N real samples */
function irfft(real, imag, nfft) {
  const re = new Float32Array(nfft);
  const im = new Float32Array(nfft);
  for (let k = 0; k <= nfft / 2; k += 1) {
    re[k] = real[k];
    im[k] = imag[k];
  }
  for (let k = 1; k < nfft / 2; k += 1) {
    re[nfft - k] = real[k];
    im[nfft - k] = -imag[k];
  }
  fftInPlace(re, im, true);
  return re;
}

/**
 * Microsoft DNS Challenge NSNet2 baseline (48 kHz ONNX).
 *
 * Architecture: FC-GRU-GRU-FC-FC-FC operating on 481-dim log-power spectra.
 * Outputs a per-frequency gain mask applied in the spectral domain.
 */
export const nsnet2Model = {
  id: NSNET2_ID,
  label: 'NSNet2 — MS DNS Challenge (ONNX)',

  async prepare() {
    await getNsnet2Session();
  },

  async process(input, inputSampleRate = MODEL_SAMPLE_RATE, options = {}) {
    const { onProgress } = options;
    const session = await getNsnet2Session();

    let mono;
    let sr = inputSampleRate;
    if (input && typeof input.getChannelData === 'function') {
      const channels = input.numberOfChannels;
      const length = input.length;
      mono = new Float32Array(length);
      for (let ch = 0; ch < channels; ch += 1) {
        const data = input.getChannelData(ch);
        for (let i = 0; i < length; i += 1) {
          mono[i] += data[i] / channels;
        }
      }
      sr = input.sampleRate;
    } else {
      mono = input instanceof Float32Array ? input : new Float32Array(input);
    }

    if (sr !== MODEL_SAMPLE_RATE) {
      mono = resampleLinear(mono, sr, MODEL_SAMPLE_RATE);
    }

    const win = sqrtHann(N_WIN);
    const awin = synthesisWindow(win, N_HOP);

    // Frame the signal
    const padded = new Float32Array(mono.length + N_WIN);
    padded.set(mono);
    const frameCount = Math.floor((padded.length - N_WIN) / N_HOP) + 1;

    if (onProgress) onProgress(0.05);

    // Compute STFT and log-power features for all frames
    const specReal = new Array(frameCount);
    const specImag = new Array(frameCount);
    const feat = new Float32Array(frameCount * N_FREQ);

    for (let f = 0; f < frameCount; f += 1) {
      const start = f * N_HOP;
      const windowed = new Float32Array(N_FFT);
      for (let i = 0; i < N_WIN; i += 1) {
        windowed[i] = padded[start + i] * win[i];
      }
      const { real, imag } = rfft(windowed, N_FFT);
      specReal[f] = real;
      specImag[f] = imag;

      for (let k = 0; k < N_FREQ; k += 1) {
        const power = real[k] * real[k] + imag[k] * imag[k];
        feat[f * N_FREQ + k] = Math.log10(Math.max(power, 1e-12));
      }
    }

    if (onProgress) onProgress(0.3);

    // Run model: input shape [1, frames, 481]
    const inputTensor = new ort.Tensor('float32', feat, [1, frameCount, N_FREQ]);
    const started = performance.now();
    const results = await session.run({
      [session.inputNames[0]]: inputTensor,
    });
    const gain = results[session.outputNames[0]].data;

    if (onProgress) onProgress(0.7);

    // Apply gain mask and ISTFT with overlap-add
    const outLen = (frameCount - 1) * N_HOP + N_WIN;
    const output = new Float32Array(outLen);

    for (let f = 0; f < frameCount; f += 1) {
      const gainOffset = f * N_FREQ;
      const maskedReal = new Float32Array(N_FREQ);
      const maskedImag = new Float32Array(N_FREQ);
      for (let k = 0; k < N_FREQ; k += 1) {
        const g = gain[gainOffset + k];
        maskedReal[k] = specReal[f][k] * g;
        maskedImag[k] = specImag[f][k] * g;
      }

      const frame = irfft(maskedReal, maskedImag, N_FFT);

      const start = f * N_HOP;
      for (let i = 0; i < N_WIN; i += 1) {
        output[start + i] += frame[i] * awin[i];
      }
    }

    const elapsedMs = performance.now() - started;
    const audioMs = (mono.length / MODEL_SAMPLE_RATE) * 1000;

    if (onProgress) onProgress(1);

    return {
      samples: output.subarray(0, mono.length),
      sampleRate: MODEL_SAMPLE_RATE,
      stats: {
        elapsedMs,
        audioMs,
        rtf: elapsedMs / audioMs,
        frames: frameCount,
      },
    };
  },
};

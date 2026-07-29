import * as ort from 'onnxruntime-web';
import { MODEL_SAMPLE_RATE } from './types';
import { resampleLinear } from '../audio/resample';
import {
  HOP_SIZE,
  FFT_SIZE,
  STATE_SIZE,
  getDeepFilterSession,
} from './deepfilternetOrt';

export const DFN_VAD_ID = 'deepfilternet-silero-vad';

const VAD_MODEL_URL = '/models/silero_vad.onnx';
const VAD_SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;
const DEFAULT_VAD_THRESHOLD = 0.5;

let vadSessionPromise = null;

function getVadSession() {
  if (!vadSessionPromise) {
    vadSessionPromise = ort.InferenceSession.create(VAD_MODEL_URL, {
      executionProviders: ['wasm'],
    });
  }
  return vadSessionPromise;
}

function resample48kTo16k(samples) {
  return resampleLinear(samples, MODEL_SAMPLE_RATE, VAD_SAMPLE_RATE);
}

/**
 * Run Silero VAD on a chunk of audio at 16 kHz and return per-window speech probabilities.
 */
async function runVad(mono16k) {
  const session = await getVadSession();

  const windowCount = Math.floor(mono16k.length / VAD_WINDOW_SIZE);
  const probs = new Float32Array(windowCount);

  let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  // eslint-disable-next-line no-undef
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [1]);
  let context = new Float32Array(64);

  for (let i = 0; i < windowCount; i += 1) {
    const chunk = mono16k.subarray(i * VAD_WINDOW_SIZE, (i + 1) * VAD_WINDOW_SIZE);
    const withContext = new Float32Array(64 + VAD_WINDOW_SIZE);
    withContext.set(context);
    withContext.set(chunk, 64);

    const input = new ort.Tensor('float32', withContext, [1, 64 + VAD_WINDOW_SIZE]);

    const results = await session.run({ input, state, sr });
    probs[i] = results.output.data[0];
    state = results.stateN;
    context = withContext.slice(-64);
  }

  return probs;
}

/**
 * Expand VAD probabilities (at 16 kHz / 512 window) to a per-hop mask at 48 kHz / 480 hop.
 */
function buildVadMask(probs, hopCount, threshold) {
  const samplesPerVadWindow = VAD_WINDOW_SIZE * (MODEL_SAMPLE_RATE / VAD_SAMPLE_RATE);
  const mask = new Float32Array(hopCount);

  for (let hop = 0; hop < hopCount; hop += 1) {
    const hopCenter = hop * HOP_SIZE + HOP_SIZE / 2;
    const vadIdx = Math.floor(hopCenter / samplesPerVadWindow);
    const prob = vadIdx < probs.length ? probs[vadIdx] : 0;
    mask[hop] = prob >= threshold ? 1.0 : 0.0;
  }
  return mask;
}

function padToHopMultiple(samples) {
  const remainder = samples.length % HOP_SIZE;
  const hopPad = remainder === 0 ? 0 : HOP_SIZE - remainder;
  const padded = new Float32Array(samples.length + FFT_SIZE + hopPad);
  padded.set(samples, 0);
  return { padded, origLen: samples.length + hopPad };
}

/**
 * DeepFilterNet3 + Silero VAD: only applies denoising to frames where speech is detected.
 * Non-speech frames are zeroed (gated) to suppress background noise entirely.
 */
export const dfnSileroVadModel = {
  id: DFN_VAD_ID,
  label: 'DeepFilterNet3 + Silero VAD',

  async prepare() {
    await Promise.all([getDeepFilterSession(), getVadSession()]);
  },

  async process(input, inputSampleRate = MODEL_SAMPLE_RATE, options = {}) {
    const { attenLimDb = 0, vadThreshold = DEFAULT_VAD_THRESHOLD, onProgress } = options;
    const session = await getDeepFilterSession();

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

    // --- VAD pass ---
    if (onProgress) onProgress(0);
    const mono16k = resample48kTo16k(mono);
    const vadProbs = await runVad(mono16k);

    const { padded, origLen } = padToHopMultiple(mono);
    const frameCount = padded.length / HOP_SIZE;
    const vadMask = buildVadMask(vadProbs, frameCount, vadThreshold);

    // --- DeepFilterNet pass (only on speech frames) ---
    const enhanced = new Float32Array(padded.length);
    let states = new ort.Tensor('float32', new Float32Array(STATE_SIZE), [STATE_SIZE]);
    const atten = new ort.Tensor('float32', Float32Array.from([attenLimDb]), []);

    const started = performance.now();
    let writeOffset = 0;
    let speechFrames = 0;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const start = frameIndex * HOP_SIZE;
      const frame = padded.subarray(start, start + HOP_SIZE);

      if (vadMask[frameIndex] > 0) {
        const inputFrame = new ort.Tensor('float32', frame, [HOP_SIZE]);
        const outputs = await session.run({
          input_frame: inputFrame,
          states,
          atten_lim_db: atten,
        });
        enhanced.set(outputs.enhanced_audio_frame.data, writeOffset);
        states = outputs.new_states;
        speechFrames += 1;
      }
      // Non-speech frames remain zero (gated silence)

      writeOffset += HOP_SIZE;

      if (onProgress && (frameIndex % 8 === 0 || frameIndex === frameCount - 1)) {
        onProgress(0.1 + 0.9 * ((frameIndex + 1) / frameCount));
      }
    }

    const delay = FFT_SIZE - HOP_SIZE;
    const trimmed = enhanced.subarray(delay, delay + origLen);
    const output = trimmed.slice(0, mono.length);
    const elapsedMs = performance.now() - started;
    const audioMs = (mono.length / MODEL_SAMPLE_RATE) * 1000;

    return {
      samples: output,
      sampleRate: MODEL_SAMPLE_RATE,
      stats: {
        elapsedMs,
        audioMs,
        rtf: elapsedMs / audioMs,
        frames: frameCount,
        speechFrames,
        silenceGated: frameCount - speechFrames,
        vadThreshold,
      },
    };
  },
};

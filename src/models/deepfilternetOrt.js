import * as ort from 'onnxruntime-web';
import { MODEL_SAMPLE_RATE } from './types';
import { resampleLinear } from '../audio/resample';

export const DEEPFILTERNET_ORT_ID = 'deepfilternet-ort';

export const HOP_SIZE = 480;
export const FFT_SIZE = 960;
export const STATE_SIZE = 45304;
const MODEL_URL = '/models/deepfilternet3/denoiser_model.onnx';
const WASM_PATH = '/ort/';

let sessionPromise = null;

function configureOrt() {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.wasmPaths = WASM_PATH;
}

export async function getDeepFilterSession() {
  if (!sessionPromise) {
    configureOrt();
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
    });
  }
  return sessionPromise;
}

function padToHopMultiple(samples) {
  const remainder = samples.length % HOP_SIZE;
  const hopPad = remainder === 0 ? 0 : HOP_SIZE - remainder;
  const padded = new Float32Array(samples.length + FFT_SIZE + hopPad);
  padded.set(samples, 0);
  return {
    padded,
    origLen: samples.length + hopPad,
  };
}

/**
 * DeepFilterNet3 fused ONNX (PCM-in / PCM-out) via onnxruntime-web.
 */
export const deepFilterNetOrtModel = {
  id: DEEPFILTERNET_ORT_ID,
  label: 'DeepFilterNet3 (ONNX Runtime Web)',

  async prepare() {
    await getDeepFilterSession();
  },

  /**
   * @param {Float32Array|AudioBuffer} input
   * @param {number} [inputSampleRate]
   * @param {{ attenLimDb?: number, onProgress?: (p: number) => void }} [options]
   */
  async process(input, inputSampleRate = MODEL_SAMPLE_RATE, options = {}) {
    const { attenLimDb = 0, onProgress } = options;
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

    const { padded, origLen } = padToHopMultiple(mono);
    const frameCount = padded.length / HOP_SIZE;
    const enhanced = new Float32Array(padded.length);

    let states = new ort.Tensor(
      'float32',
      new Float32Array(STATE_SIZE),
      [STATE_SIZE],
    );
    const atten = new ort.Tensor('float32', Float32Array.from([attenLimDb]), []);

    const started = performance.now();
    let writeOffset = 0;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const start = frameIndex * HOP_SIZE;
      const frame = padded.subarray(start, start + HOP_SIZE);
      const inputFrame = new ort.Tensor('float32', frame, [HOP_SIZE]);

      const outputs = await session.run({
        input_frame: inputFrame,
        states,
        atten_lim_db: atten,
      });

      const enhancedFrame = outputs.enhanced_audio_frame.data;
      enhanced.set(enhancedFrame, writeOffset);
      writeOffset += enhancedFrame.length;
      states = outputs.new_states;

      if (onProgress && (frameIndex % 8 === 0 || frameIndex === frameCount - 1)) {
        onProgress((frameIndex + 1) / frameCount);
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
      },
    };
  },
};

import { MODEL_SAMPLE_RATE } from './types';
import { resampleLinear } from '../audio/resample';

export const RNNOISE_WASM_ID = 'rnnoise-wasm';
export const RNNOISE_FRAME_SIZE = 480;

const FRAME_SIZE = RNNOISE_FRAME_SIZE;
const SHIFT_16_BIT = 32768;

let wasmModulePromise = null;

export async function getRnnoiseModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const { default: createModule } = await import(
        /* webpackChunkName: "rnnoise" */
        '@jitsi/rnnoise-wasm/dist/rnnoise.js'
      );
      const module = await createModule({
        locateFile: (file) => `${process.env.PUBLIC_URL || ''}/${file}`,
      });
      return module;
    })();
  }
  return wasmModulePromise;
}

export class RnnoiseFrameProcessor {
  constructor(wasmModule) {
    this._module = wasmModule;
    this._context = wasmModule._rnnoise_create();
    this._pcmInputPtr = wasmModule._malloc(FRAME_SIZE * 4);
    this._pcmInputF32Index = this._pcmInputPtr >> 2;
  }

  processFrame(pcmFrame) {
    const heap = this._module.HEAPF32;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      heap[this._pcmInputF32Index + i] = pcmFrame[i] * SHIFT_16_BIT;
    }

    const vad = this._module._rnnoise_process_frame(
      this._context,
      this._pcmInputPtr,
      this._pcmInputPtr,
    );

    for (let i = 0; i < FRAME_SIZE; i += 1) {
      pcmFrame[i] = heap[this._pcmInputF32Index + i] / SHIFT_16_BIT;
    }

    return vad;
  }

  destroy() {
    if (this._context) {
      this._module._rnnoise_destroy(this._context);
      this._module._free(this._pcmInputPtr);
      this._context = null;
    }
  }
}

/**
 * RNNoise (WASM) model adapter — same interface as DeepFilterNet for the Model lab.
 * Operates at 48 kHz, 480-sample frames. Lightweight and fast.
 */
export const rnnoiseWasmModel = {
  id: RNNOISE_WASM_ID,
  label: 'RNNoise (WASM)',

  async prepare() {
    await getRnnoiseModule();
  },

  async process(input, inputSampleRate = MODEL_SAMPLE_RATE, options = {}) {
    const { onProgress } = options;
    const wasmModule = await getRnnoiseModule();
    const processor = new RnnoiseFrameProcessor(wasmModule);

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

    const padRemainder = mono.length % FRAME_SIZE;
    const padAmount = padRemainder === 0 ? 0 : FRAME_SIZE - padRemainder;
    let samples;
    if (padAmount > 0) {
      samples = new Float32Array(mono.length + padAmount);
      samples.set(mono);
    } else {
      samples = mono.slice();
    }

    const frameCount = samples.length / FRAME_SIZE;
    const started = performance.now();

    for (let i = 0; i < frameCount; i += 1) {
      const frame = samples.subarray(i * FRAME_SIZE, (i + 1) * FRAME_SIZE);
      processor.processFrame(frame);

      if (onProgress && (i % 16 === 0 || i === frameCount - 1)) {
        onProgress((i + 1) / frameCount);
      }
    }

    processor.destroy();

    const output = samples.subarray(0, mono.length);
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

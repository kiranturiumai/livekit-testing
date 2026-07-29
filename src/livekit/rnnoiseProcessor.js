import {
  getRnnoiseModule,
  RnnoiseFrameProcessor,
  RNNOISE_FRAME_SIZE,
} from '../models/rnnoiseWasm';
import { MODEL_SAMPLE_RATE } from '../models/types';

/**
 * LiveKit audio TrackProcessor that runs RNNoise (WASM) on the mic track.
 * Processing is synchronous inside ScriptProcessor — suitable as a light fallback.
 */
export class RnnoiseLiveKitProcessor {
  name = 'rnnoise-wasm';

  /** @type {MediaStreamTrack | undefined} */
  processedTrack;

  /** @type {AudioContext | undefined} */
  #audioContext;

  /** @type {MediaStreamAudioSourceNode | undefined} */
  #source;

  /** @type {ScriptProcessorNode | undefined} */
  #scriptNode;

  /** @type {GainNode | undefined} */
  #silentGain;

  /** @type {MediaStreamAudioDestinationNode | undefined} */
  #destination;

  /** @type {RnnoiseFrameProcessor | undefined} */
  #processor;

  /** @type {Float32Array} */
  #inputFifo = new Float32Array(0);

  /** @type {Float32Array} */
  #outputFifo = new Float32Array(0);

  #enabled = true;

  #lastFrameMs = 0;

  #underruns = 0;

  constructor({ enabled = true } = {}) {
    this.#enabled = enabled;
  }

  setEnabled(enabled) {
    this.#enabled = Boolean(enabled);
  }

  isEnabled() {
    return this.#enabled;
  }

  getStats() {
    return {
      lastFrameMs: this.#lastFrameMs,
      underruns: this.#underruns,
      inputQueued: this.#inputFifo.length,
      outputQueued: this.#outputFifo.length,
      enabled: this.#enabled,
    };
  }

  async init(opts) {
    const { track, audioContext } = opts;
    if (!audioContext) {
      throw new Error('RNNoise processor requires an AudioContext');
    }

    this.#audioContext = audioContext;
    const wasmModule = await getRnnoiseModule();
    this.#processor = new RnnoiseFrameProcessor(wasmModule);
    this.#inputFifo = new Float32Array(0);
    this.#outputFifo = new Float32Array(0);
    this.#underruns = 0;

    this.#source = audioContext.createMediaStreamSource(
      new MediaStream([track]),
    );
    this.#destination = audioContext.createMediaStreamDestination();

    const bufferSize = 512;
    this.#scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.#scriptNode.onaudioprocess = (event) => {
      this.#onAudioProcess(event);
    };

    this.#silentGain = audioContext.createGain();
    this.#silentGain.gain.value = 0;

    this.#source.connect(this.#scriptNode);
    this.#scriptNode.connect(this.#destination);
    this.#scriptNode.connect(this.#silentGain);
    this.#silentGain.connect(audioContext.destination);

    this.processedTrack = this.#destination.stream.getAudioTracks()[0];
  }

  async restart(opts) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    try {
      this.#scriptNode?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.#silentGain?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.#source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.#destination?.disconnect();
    } catch {
      /* ignore */
    }

    this.#processor?.destroy();
    this.#processor = undefined;
    this.#scriptNode = undefined;
    this.#silentGain = undefined;
    this.#source = undefined;
    this.#destination = undefined;
    this.#audioContext = undefined;
    this.#inputFifo = new Float32Array(0);
    this.#outputFifo = new Float32Array(0);
    this.processedTrack = undefined;
  }

  #appendInput(samples) {
    const next = new Float32Array(this.#inputFifo.length + samples.length);
    next.set(this.#inputFifo, 0);
    next.set(samples, this.#inputFifo.length);
    this.#inputFifo = next;
  }

  #appendOutput(samples) {
    const next = new Float32Array(this.#outputFifo.length + samples.length);
    next.set(this.#outputFifo, 0);
    next.set(samples, this.#outputFifo.length);
    this.#outputFifo = next;
  }

  #takeOutput(count) {
    const out = new Float32Array(count);
    if (this.#outputFifo.length >= count) {
      out.set(this.#outputFifo.subarray(0, count));
      this.#outputFifo = this.#outputFifo.subarray(count).slice();
      return out;
    }
    this.#underruns += 1;
    out.set(this.#outputFifo);
    this.#outputFifo = new Float32Array(0);
    return out;
  }

  #resampleToModelRate(input, fromRate) {
    if (fromRate === MODEL_SAMPLE_RATE) {
      return input.slice();
    }
    const ratio = MODEL_SAMPLE_RATE / fromRate;
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

  #resampleFromModelRate(input, toRate) {
    if (toRate === MODEL_SAMPLE_RATE) {
      return input;
    }
    const ratio = toRate / MODEL_SAMPLE_RATE;
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

  #drainFrames() {
    if (!this.#processor) return;
    while (this.#inputFifo.length >= RNNOISE_FRAME_SIZE) {
      const frame = this.#inputFifo.subarray(0, RNNOISE_FRAME_SIZE).slice();
      this.#inputFifo = this.#inputFifo.subarray(RNNOISE_FRAME_SIZE).slice();
      const t0 = performance.now();
      this.#processor.processFrame(frame);
      this.#lastFrameMs = performance.now() - t0;
      this.#appendOutput(frame);
    }
  }

  #onAudioProcess(event) {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    const ctxRate = this.#audioContext?.sampleRate || MODEL_SAMPLE_RATE;

    if (!this.#enabled) {
      output.set(input);
      return;
    }

    const modelInput = this.#resampleToModelRate(input, ctxRate);
    this.#appendInput(modelInput);
    this.#drainFrames();

    const modelChunk = this.#takeOutput(
      Math.max(1, Math.round(input.length * (MODEL_SAMPLE_RATE / ctxRate))),
    );
    const ctxChunk = this.#resampleFromModelRate(modelChunk, ctxRate);

    if (ctxChunk.length >= output.length) {
      output.set(ctxChunk.subarray(0, output.length));
    } else {
      output.fill(0);
      output.set(ctxChunk);
    }
  }
}

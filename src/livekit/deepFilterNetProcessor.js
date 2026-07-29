import * as ort from 'onnxruntime-web';
import {
  FFT_SIZE,
  HOP_SIZE,
  STATE_SIZE,
  getDeepFilterSession,
} from '../models/deepfilternetOrt';
import { MODEL_SAMPLE_RATE } from '../models/types';

/**
 * LiveKit audio TrackProcessor that runs DeepFilterNet3 (ONNX Runtime Web)
 * on the published microphone track.
 *
 * ScriptProcessor feeds input/output FIFOs; an async loop runs ORT on 480-sample hops.
 */
export class DeepFilterNetLiveKitProcessor {
  name = 'deepfilternet-ort';

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

  /** @type {import('onnxruntime-web').InferenceSession | undefined} */
  #session;

  /** @type {import('onnxruntime-web').Tensor | undefined} */
  #states;

  /** @type {Float32Array} */
  #inputFifo = new Float32Array(0);

  /** @type {Float32Array} */
  #outputFifo = new Float32Array(0);

  #enabled = true;

  #attenLimDb = 0;

  #running = false;

  #processing = false;

  #lastFrameMs = 0;

  #underruns = 0;

  constructor({ enabled = true, attenLimDb = 0 } = {}) {
    this.#enabled = enabled;
    this.#attenLimDb = attenLimDb;
  }

  setEnabled(enabled) {
    this.#enabled = Boolean(enabled);
  }

  isEnabled() {
    return this.#enabled;
  }

  setAttenLimDb(value) {
    this.#attenLimDb = Number(value) || 0;
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
      throw new Error('DeepFilterNet processor requires an AudioContext');
    }

    this.#audioContext = audioContext;
    this.#session = await getDeepFilterSession();
    this.#states = new ort.Tensor(
      'float32',
      new Float32Array(STATE_SIZE),
      [STATE_SIZE],
    );
    this.#inputFifo = new Float32Array(0);
    // Priming delay matches offline delay trim (fft - hop).
    this.#outputFifo = new Float32Array(FFT_SIZE - HOP_SIZE);
    this.#underruns = 0;
    this.#running = true;

    this.#source = audioContext.createMediaStreamSource(
      new MediaStream([track]),
    );
    this.#destination = audioContext.createMediaStreamDestination();

    const bufferSize = 512;
    this.#scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.#scriptNode.onaudioprocess = (event) => {
      this.#onAudioProcess(event);
    };

    // Zero-gain tap to audioContext.destination keeps ScriptProcessor running
    // even before WebRTC pulls the processed track.
    this.#silentGain = audioContext.createGain();
    this.#silentGain.gain.value = 0;

    this.#source.connect(this.#scriptNode);
    this.#scriptNode.connect(this.#destination);
    this.#scriptNode.connect(this.#silentGain);
    this.#silentGain.connect(audioContext.destination);

    this.processedTrack = this.#destination.stream.getAudioTracks()[0];
    void this.#drainLoop();
  }

  async restart(opts) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.#running = false;
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

    this.#scriptNode = undefined;
    this.#silentGain = undefined;
    this.#source = undefined;
    this.#destination = undefined;
    this.#audioContext = undefined;
    this.#session = undefined;
    this.#states = undefined;
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

  #takeInputFrame() {
    if (this.#inputFifo.length < HOP_SIZE) return null;
    const frame = this.#inputFifo.subarray(0, HOP_SIZE).slice();
    this.#inputFifo = this.#inputFifo.subarray(HOP_SIZE).slice();
    return frame;
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

  async #drainLoop() {
    while (this.#running) {
      if (!this.#enabled || !this.#session || this.#processing) {
        await sleep(4);
        continue;
      }

      const frame = this.#takeInputFrame();
      if (!frame) {
        await sleep(2);
        continue;
      }

      this.#processing = true;
      try {
        const t0 = performance.now();
        const atten = new ort.Tensor(
          'float32',
          Float32Array.from([this.#attenLimDb]),
          [],
        );
        const outputs = await this.#session.run({
          input_frame: new ort.Tensor('float32', frame, [HOP_SIZE]),
          states: this.#states,
          atten_lim_db: atten,
        });
        this.#lastFrameMs = performance.now() - t0;
        this.#states = outputs.new_states;
        this.#appendOutput(outputs.enhanced_audio_frame.data);
      } catch (err) {
        console.error('[DeepFilterNetLiveKitProcessor] inference failed:', err);
        this.#appendOutput(frame);
      } finally {
        this.#processing = false;
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

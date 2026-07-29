import {
  FFT_SIZE,
  HOP_SIZE,
  getDeepFilterSession,
} from '../models/deepfilternetOrt';
import { MODEL_SAMPLE_RATE } from '../models/types';

/**
 * Extra output hops for jitter (~80 ms). Larger = fewer underruns, more latency.
 */
const OUTPUT_PRIME_HOPS = 8;

const STFT_DELAY = FFT_SIZE - HOP_SIZE;
const TOTAL_DELAY = STFT_DELAY + OUTPUT_PRIME_HOPS * HOP_SIZE;
const MAX_INPUT_HOPS = 16;

/**
 * LiveKit TrackProcessor for DeepFilterNet3.
 *
 * Why continuous "kir kir" happened:
 * - ORT WASM + ScriptProcessor both contended on the main thread
 * - When inference lagged, every audio quantum underran → rhythmic crackle
 * - Non-48k AudioContext also resampled every callback → more discontinuities
 *
 * Fix:
 * - Dedicated 48 kHz AudioContext (no resampling when browser honors it)
 * - ORT runs in a Web Worker (off the audio path)
 * - Larger output prime buffer
 * - Underruns filled with silence (not dry/hold hybrids that chirp)
 */
export class DeepFilterNetLiveKitProcessor {
  name = 'deepfilternet-ort';

  /** @type {MediaStreamTrack | undefined} */
  processedTrack;

  /** @type {AudioContext | undefined} */
  #audioContext;

  /** @type {boolean} */
  #ownsContext = false;

  /** @type {MediaStreamAudioSourceNode | undefined} */
  #source;

  /** @type {ScriptProcessorNode | undefined} */
  #scriptNode;

  /** @type {GainNode | undefined} */
  #silentGain;

  /** @type {MediaStreamAudioDestinationNode | undefined} */
  #destination;

  /** @type {Worker | undefined} */
  #worker;

  /** @type {Float32Array} */
  #inputFifo = new Float32Array(0);

  /** @type {Float32Array} */
  #outputFifo = new Float32Array(0);

  #enabled = true;

  #attenLimDb = 0;

  #running = false;

  #workerReady = false;

  #inflight = 0;

  #maxInflight = 2;

  #seq = 0;

  #lastFrameMs = 0;

  #underruns = 0;

  #callbacks = 0;

  constructor({ enabled = true, attenLimDb = 0 } = {}) {
    this.#enabled = enabled;
    this.#attenLimDb = Number.isFinite(attenLimDb) ? attenLimDb : 0;
  }

  setEnabled(enabled) {
    this.#enabled = Boolean(enabled);
  }

  isEnabled() {
    return this.#enabled;
  }

  setAttenLimDb(value) {
    this.#attenLimDb = Number(value) || 0;
    this.#worker?.postMessage({ type: 'setAtten', attenLimDb: this.#attenLimDb });
  }

  getStats() {
    return {
      lastFrameMs: this.#lastFrameMs,
      underruns: this.#underruns,
      inputQueued: this.#inputFifo.length,
      outputQueued: this.#outputFifo.length,
      enabled: this.#enabled,
      inflight: this.#inflight,
      underrunRate:
        this.#callbacks > 0 ? this.#underruns / this.#callbacks : 0,
    };
  }

  async init(opts) {
    const { track } = opts;

    // Warm the model in the main-thread cache first (shares HTTP cache with worker).
    await getDeepFilterSession();

    // Dedicated 48 kHz graph — DeepFilterNet is native 48k; avoids per-callback resample.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.#audioContext = new Ctx({ sampleRate: MODEL_SAMPLE_RATE });
    this.#ownsContext = true;
    if (this.#audioContext.state === 'suspended') {
      await this.#audioContext.resume();
    }

    this.#inputFifo = new Float32Array(0);
    this.#outputFifo = new Float32Array(TOTAL_DELAY);
    this.#underruns = 0;
    this.#callbacks = 0;
    this.#inflight = 0;
    this.#seq = 0;
    this.#running = true;

    await this.#startWorker();

    this.#source = this.#audioContext.createMediaStreamSource(
      new MediaStream([track]),
    );
    this.#destination = this.#audioContext.createMediaStreamDestination();

    // 960 samples @ 48k ≈ 20 ms — one hop pair; more stable than 512 with worker RTT.
    const bufferSize = 1024;
    this.#scriptNode = this.#audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.#scriptNode.onaudioprocess = (event) => {
      this.#onAudioProcess(event);
    };

    this.#silentGain = this.#audioContext.createGain();
    this.#silentGain.gain.value = 0;

    this.#source.connect(this.#scriptNode);
    this.#scriptNode.connect(this.#destination);
    this.#scriptNode.connect(this.#silentGain);
    this.#silentGain.connect(this.#audioContext.destination);

    this.processedTrack = this.#destination.stream.getAudioTracks()[0];
  }

  async #startWorker() {
    this.#worker = new Worker(
      new URL('./dfnInference.worker.js', import.meta.url),
    );

    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('DeepFilterNet worker init timed out'));
      }, 60000);

      this.#worker.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          this.#workerReady = true;
          resolve();
          return;
        }
        if (msg.type === 'result') {
          this.#inflight = Math.max(0, this.#inflight - 1);
          this.#lastFrameMs = msg.elapsedMs || 0;
          const enhanced = new Float32Array(msg.enhanced);
          this.#appendOutput(enhanced);
          this.#pumpWorker();
          return;
        }
        if (msg.type === 'error') {
          this.#inflight = Math.max(0, this.#inflight - 1);
          console.error('[DeepFilterNet worker]', msg.message);
          this.#pumpWorker();
        }
      };

      this.#worker.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });

    this.#worker.postMessage({ type: 'init', attenLimDb: this.#attenLimDb });
    await ready;
  }

  async restart(opts) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.#running = false;
    this.#workerReady = false;
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

    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = undefined;
    }

    if (this.#ownsContext && this.#audioContext) {
      try {
        await this.#audioContext.close();
      } catch {
        /* ignore */
      }
    }

    this.#scriptNode = undefined;
    this.#silentGain = undefined;
    this.#source = undefined;
    this.#destination = undefined;
    this.#audioContext = undefined;
    this.#ownsContext = false;
    this.#inputFifo = new Float32Array(0);
    this.#outputFifo = new Float32Array(0);
    this.processedTrack = undefined;
  }

  #appendInput(samples) {
    const next = new Float32Array(this.#inputFifo.length + samples.length);
    next.set(this.#inputFifo, 0);
    next.set(samples, this.#inputFifo.length);
    const maxInput = MAX_INPUT_HOPS * HOP_SIZE;
    this.#inputFifo =
      next.length > maxInput
        ? next.subarray(next.length - maxInput).slice()
        : next;
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
    const available = this.#outputFifo.length;
    if (available > 0) {
      out.set(this.#outputFifo);
      this.#outputFifo = new Float32Array(0);
    }
    // Remaining stays 0 (silence). Continuous dry/enhanced mixing caused chirps.
    return out;
  }

  #pumpWorker() {
    if (!this.#running || !this.#workerReady || !this.#enabled || !this.#worker) {
      return;
    }

    while (
      this.#inflight < this.#maxInflight &&
      this.#inputFifo.length >= HOP_SIZE &&
      this.#outputFifo.length < TOTAL_DELAY + HOP_SIZE * 4
    ) {
      const frame = this.#inputFifo.subarray(0, HOP_SIZE).slice();
      this.#inputFifo = this.#inputFifo.subarray(HOP_SIZE).slice();
      this.#seq += 1;
      this.#inflight += 1;
      this.#worker.postMessage(
        { type: 'process', frame: frame.buffer, seq: this.#seq },
        [frame.buffer],
      );
    }
  }

  #onAudioProcess(event) {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    this.#callbacks += 1;

    if (!this.#enabled) {
      output.set(input);
      return;
    }

    // Context is created at 48 kHz — copy directly, no resample.
    this.#appendInput(input);
    this.#pumpWorker();

    const chunk = this.#takeOutput(output.length);
    output.set(chunk);
  }
}

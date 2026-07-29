import {
  enhanceNsnet2Chunk,
  getNsnet2Session,
  NSNET2_N_HOP,
} from '../models/nsnet2Ort';
import { MODEL_SAMPLE_RATE } from '../models/types';

/**
 * ~0.5s chunks at 48 kHz (50 hops × 10 ms).
 * Good first balance for live calls; can be tuned down later.
 */
const CHUNK_HOPS = 50;
const CHUNK_SAMPLES = CHUNK_HOPS * NSNET2_N_HOP;

/**
 * LiveKit TrackProcessor for Microsoft DNS Challenge NSNet2.
 *
 * Processes rolling ~0.5s mono chunks via ONNX (spectral gain model).
 * Introduces ~0.5s algorithmic latency by design.
 */
export class Nsnet2LiveKitProcessor {
  name = 'nsnet2-dns';

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

  /** @type {import('onnxruntime-web').InferenceSession | undefined} */
  #session;

  /** @type {Float32Array} */
  #inputFifo = new Float32Array(0);

  /** @type {Float32Array} */
  #outputFifo = new Float32Array(0);

  #enabled = true;

  #running = false;

  #processing = false;

  #lastFrameMs = 0;

  #underruns = 0;

  #chunks = 0;

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
      chunks: this.#chunks,
      chunkLatencyMs: (CHUNK_SAMPLES / MODEL_SAMPLE_RATE) * 1000,
    };
  }

  async init(opts) {
    const { track } = opts;

    this.#session = await getNsnet2Session();

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.#audioContext = new Ctx({ sampleRate: MODEL_SAMPLE_RATE });
    this.#ownsContext = true;
    if (this.#audioContext.state === 'suspended') {
      await this.#audioContext.resume();
    }

    this.#inputFifo = new Float32Array(0);
    // Prime with one chunk of silence so the call starts without underruns
    // while the first 0.5s of audio is collected + enhanced.
    this.#outputFifo = new Float32Array(CHUNK_SAMPLES);
    this.#underruns = 0;
    this.#chunks = 0;
    this.#running = true;

    this.#source = this.#audioContext.createMediaStreamSource(
      new MediaStream([track]),
    );
    this.#destination = this.#audioContext.createMediaStreamDestination();

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
    this.#session = undefined;
    this.#inputFifo = new Float32Array(0);
    this.#outputFifo = new Float32Array(0);
    this.processedTrack = undefined;
  }

  #appendInput(samples) {
    const next = new Float32Array(this.#inputFifo.length + samples.length);
    next.set(this.#inputFifo, 0);
    next.set(samples, this.#inputFifo.length);
    // Cap backlog to ~2 chunks to bound latency after stalls.
    const max = CHUNK_SAMPLES * 2;
    this.#inputFifo =
      next.length > max ? next.subarray(next.length - max).slice() : next;
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
    return out;
  }

  #onAudioProcess(event) {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    if (!this.#enabled) {
      output.set(input);
      return;
    }

    this.#appendInput(input);
    output.set(this.#takeOutput(output.length));
  }

  async #drainLoop() {
    while (this.#running) {
      if (
        !this.#enabled ||
        !this.#session ||
        this.#processing ||
        this.#inputFifo.length < CHUNK_SAMPLES
      ) {
        await sleep(8);
        continue;
      }

      // Don't pile up more than ~1.5 chunks of enhanced audio.
      if (this.#outputFifo.length > CHUNK_SAMPLES * 1.5) {
        await sleep(8);
        continue;
      }

      const chunk = this.#inputFifo.subarray(0, CHUNK_SAMPLES).slice();
      this.#inputFifo = this.#inputFifo.subarray(CHUNK_SAMPLES).slice();

      this.#processing = true;
      try {
        const t0 = performance.now();
        const enhanced = await enhanceNsnet2Chunk(chunk, this.#session);
        this.#lastFrameMs = performance.now() - t0;
        this.#chunks += 1;
        this.#appendOutput(enhanced);
      } catch (err) {
        console.error('[Nsnet2LiveKitProcessor] chunk failed:', err);
        // Pass dry chunk through so the call continues.
        this.#appendOutput(chunk);
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

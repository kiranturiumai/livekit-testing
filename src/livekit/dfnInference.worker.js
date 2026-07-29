/* eslint-disable no-restricted-globals */
/**
 * DeepFilterNet ORT inference worker.
 * Keeps heavy WASM off the audio/main thread so ScriptProcessor does not underrun.
 */
import * as ort from 'onnxruntime-web';

const HOP_SIZE = 480;
const STATE_SIZE = 45304;
const MODEL_URL = '/models/deepfilternet3/denoiser_model.onnx';
const WASM_PATH = '/ort/';

let session = null;
let states = null;
let attenTensor = null;
let attenLimDb = 0;

async function ensureSession() {
  if (session) return;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.wasmPaths = WASM_PATH;
  session = await ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ['wasm'],
  });
  states = new ort.Tensor('float32', new Float32Array(STATE_SIZE), [STATE_SIZE]);
  attenTensor = new ort.Tensor('float32', Float32Array.from([attenLimDb]), []);
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      attenLimDb = Number(msg.attenLimDb) || 0;
      await ensureSession();
      states = new ort.Tensor('float32', new Float32Array(STATE_SIZE), [STATE_SIZE]);
      attenTensor = new ort.Tensor('float32', Float32Array.from([attenLimDb]), []);
      self.postMessage({ type: 'ready' });
      return;
    }

    if (msg.type === 'setAtten') {
      attenLimDb = Number(msg.attenLimDb) || 0;
      attenTensor = new ort.Tensor('float32', Float32Array.from([attenLimDb]), []);
      return;
    }

    if (msg.type === 'reset') {
      states = new ort.Tensor('float32', new Float32Array(STATE_SIZE), [STATE_SIZE]);
      return;
    }

    if (msg.type === 'process') {
      await ensureSession();
      const frame = new Float32Array(msg.frame);
      const t0 = performance.now();
      const outputs = await session.run({
        input_frame: new ort.Tensor('float32', frame, [HOP_SIZE]),
        states,
        atten_lim_db: attenTensor,
      });
      const elapsedMs = performance.now() - t0;
      states = outputs.new_states;
      const enhanced = outputs.enhanced_audio_frame.data;
      // Transfer buffer back to avoid copy when possible.
      const copy = enhanced instanceof Float32Array ? enhanced.slice() : new Float32Array(enhanced);
      self.postMessage(
        { type: 'result', enhanced: copy.buffer, elapsedMs, seq: msg.seq },
        [copy.buffer],
      );
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err?.message || String(err),
      seq: msg?.seq,
    });
  }
};

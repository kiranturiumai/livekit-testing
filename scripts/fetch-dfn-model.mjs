#!/usr/bin/env node
/**
 * Download model assets + copy onnxruntime-web WASM into public/.
 *
 * - DeepFilterNet3 fused ONNX
 * - Silero VAD ONNX
 * - NSNet2 (MS DNS Challenge) ONNX
 * - ORT WASM runtime files
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  unlinkSync,
  statSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const modelDir = join(root, 'public', 'models', 'deepfilternet3');
const ortDir = join(root, 'public', 'ort');
const modelPath = join(modelDir, 'denoiser_model.onnx');

const MODEL_URLS = [
  'https://cdn.kimtos.com/models/denoiser_model.onnx',
  'https://huggingface.co/kimtos-labs/denoiser-dfn3/resolve/main/denoiser_model.onnx',
];

const VAD_MODEL_URLS = [
  'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx',
  'https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx',
];
const vadModelPath = join(root, 'public', 'models', 'silero_vad.onnx');

// NSNet2 was removed from DNS-Challenge main; pin to last commit that still has it.
const NSNET2_MODEL_URLS = [
  'https://raw.githubusercontent.com/microsoft/DNS-Challenge/4b12c87cfc97eda28282257d4799f4de46f47bf9/NSNet2-baseline/nsnet2-20ms-48k-baseline.onnx',
  'https://github.com/microsoft/DNS-Challenge/raw/4b12c87cfc97eda28282257d4799f4de46f47bf9/NSNet2-baseline/nsnet2-20ms-48k-baseline.onnx',
];
const nsnet2ModelPath = join(root, 'public', 'models', 'nsnet2-20ms-48k-baseline.onnx');
const NSNET2_MIN_BYTES = 5_000_000; // real model is ~24MB; reject HTML stubs

function looksLikeHtml(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 64)).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('404:');
}

/**
 * ONNX files are protobuf. Reject empty/HTML/tiny stubs that GitHub raw sometimes returns.
 * @param {string} path
 * @param {{ minBytes?: number }} [opts]
 */
function assertValidOnnx(path, opts = {}) {
  const { minBytes = 10_000 } = opts;
  if (!existsSync(path)) {
    throw new Error(`Missing model file: ${path}`);
  }
  const size = statSync(path).size;
  if (size < minBytes) {
    throw new Error(`Model too small (${size} bytes) — likely HTML/error page: ${path}`);
  }
  const buf = Buffer.alloc(64);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, 64, 0);
  } finally {
    closeSync(fd);
  }
  if (looksLikeHtml(buf)) {
    throw new Error(`Model looks like HTML, not ONNX: ${path}`);
  }
}

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { Accept: 'application/octet-stream,*/*' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error(`Got HTML content-type for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`Saved ${dest}`);
}

async function downloadValidated(urls, dest, opts = {}) {
  mkdirSync(dirname(dest), { recursive: true });

  if (existsSync(dest)) {
    try {
      assertValidOnnx(dest, opts);
      console.log(`Model already present and valid: ${dest}`);
      return;
    } catch (err) {
      console.warn(`Removing corrupt model: ${err.message}`);
      unlinkSync(dest);
    }
  }

  let lastError;
  for (const url of urls) {
    try {
      await download(url, dest);
      assertValidOnnx(dest, opts);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Failed ${url}: ${err.message}`);
      if (existsSync(dest)) unlinkSync(dest);
    }
  }
  throw lastError || new Error(`Unable to download model to ${dest}`);
}

async function fetchModel() {
  await downloadValidated(MODEL_URLS, modelPath, { minBytes: 100_000 });
}

async function fetchVadModel() {
  await downloadValidated(VAD_MODEL_URLS, vadModelPath, { minBytes: 100_000 });
}

async function fetchNsnet2Model() {
  await downloadValidated(NSNET2_MODEL_URLS, nsnet2ModelPath, {
    minBytes: NSNET2_MIN_BYTES,
  });
}

function copyOrtWasm() {
  mkdirSync(ortDir, { recursive: true });
  const srcDir = join(root, 'node_modules', 'onnxruntime-web', 'dist');
  const files = readdirSync(srcDir).filter(
    (name) =>
      name.startsWith('ort-wasm') &&
      (name.endsWith('.wasm') || name.endsWith('.mjs') || name.endsWith('.js')),
  );

  if (files.length === 0) {
    throw new Error(`No ort-wasm assets found in ${srcDir}`);
  }

  for (const file of files) {
    const from = join(srcDir, file);
    const to = join(ortDir, file);
    copyFileSync(from, to);
    console.log(`Copied ${file} -> public/ort/`);
  }
}

await fetchModel();
await fetchVadModel();
await fetchNsnet2Model();
copyOrtWasm();
console.log('Done.');

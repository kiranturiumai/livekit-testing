#!/usr/bin/env node
/**
 * Download DeepFilterNet3 fused ONNX + copy onnxruntime-web WASM into public/.
 *
 * Model source (PCM-in / PCM-out, onnxruntime-web compatible):
 *   https://huggingface.co/kimtos-labs/denoiser-dfn3
 * Mirror:
 *   https://cdn.kimtos.com/models/denoiser_model.onnx
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
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

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`Saved ${dest}`);
}

async function fetchModel() {
  mkdirSync(modelDir, { recursive: true });
  if (existsSync(modelPath)) {
    console.log(`Model already present: ${modelPath}`);
    return;
  }

  let lastError;
  for (const url of MODEL_URLS) {
    try {
      await download(url, modelPath);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Failed ${url}: ${err.message}`);
    }
  }
  throw lastError || new Error('Unable to download DeepFilterNet model');
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

const VAD_MODEL_URL = 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx';
const vadModelPath = join(root, 'public', 'models', 'silero_vad.onnx');

async function fetchVadModel() {
  if (existsSync(vadModelPath)) {
    console.log(`Silero VAD model already present: ${vadModelPath}`);
    return;
  }
  await download(VAD_MODEL_URL, vadModelPath);
}

const NSNET2_MODEL_URL = 'https://github.com/microsoft/DNS-Challenge/raw/16a4b297dbc8e05aea4e048083fc4ad7a10e9a28/NSNet2-baseline/nsnet2-20ms-48k-baseline.onnx';
const NSNET2_FALLBACK = 'https://github.com/nicklasmoeller/nsnet2-denoiser/raw/main/nsnet2_denoiser/nsnet2-20ms-48k-baseline.onnx';
const nsnet2ModelPath = join(root, 'public', 'models', 'nsnet2-20ms-48k-baseline.onnx');

async function fetchNsnet2Model() {
  if (existsSync(nsnet2ModelPath)) {
    console.log(`NSNet2 model already present: ${nsnet2ModelPath}`);
    return;
  }
  for (const url of [NSNET2_MODEL_URL, NSNET2_FALLBACK]) {
    try {
      await download(url, nsnet2ModelPath);
      return;
    } catch (err) {
      console.warn(`Failed ${url}: ${err.message}`);
    }
  }
  console.warn('Could not download NSNet2 model — skipping (non-critical)');
}

await fetchModel();
await fetchVadModel();
await fetchNsnet2Model();
copyOrtWasm();
console.log('Done.');

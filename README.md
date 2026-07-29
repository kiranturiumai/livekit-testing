# livekit-testing

Local harness for:
- LiveKit room join + WebRTC capture A/B (AEC / NS / AGC / voiceIsolation)
- Offline **DeepFilterNet3** noise suppression via **ONNX Runtime Web**

## Run locally

```bash
npm install
cp .env.example .env
npm run fetch:dfn-model   # downloads denoiser_model.onnx + ORT WASM into public/
npm start
```

`prestart` / `prebuild` also run `fetch:dfn-model` automatically.

Defaults assume a LiveKit server at `ws://127.0.0.1:7880` with API key/secret `devkey` / `secret`.

### Model lab

Open **Model lab** in the UI, then **Process with DeepFilterNet** on `/krisp-original.mp3` (or pick your own file). Compare original vs enhanced and download the WAV.

### LiveKit + DeepFilterNet

On **LiveKit call**, enable **DeepFilterNet3 (ORT) on published mic** (default on). After joining, the model attaches as a LiveKit audio track processor so remotes hear denoised audio. Toggle it live in the room header; frame latency / underruns are shown next to the status.

Model asset: fused DeepFilterNet3 ONNX from [kimtos-labs/denoiser-dfn3](https://huggingface.co/kimtos-labs/denoiser-dfn3) (`public/models/deepfilternet3/denoiser_model.onnx`, gitignored — large).

## Deploy (Vercel / Netlify)

Build command: `npm run build`  
Publish directory: `build`

Ensure the build can download the model (network access during `prebuild`), or commit/vendor the ONNX + `public/ort` assets.

Set these environment variables in the host dashboard:

| Variable | Example |
|---|---|
| `REACT_APP_LIVEKIT_URL` | `wss://your-project.livekit.cloud` |
| `REACT_APP_LIVEKIT_API_KEY` | your API key |
| `REACT_APP_LIVEKIT_API_SECRET` | your API secret |
| `REACT_APP_LIVEKIT_TOKEN_TTL` | `24h` |
| `REACT_APP_LIVEKIT_ROOM` | `noise-test` |

Notes:

- A deployed site cannot reach `ws://127.0.0.1`. Point `REACT_APP_LIVEKIT_URL` at a public LiveKit URL (`wss://…`).
- Token minting runs in the browser for this test app, so the API secret is exposed in the frontend bundle. Use only with disposable/dev keys.

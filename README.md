# livekit-testing

Local LiveKit harness for comparing WebRTC audio capture settings (AEC / noise suppression / AGC / voiceIsolation).

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Defaults assume a LiveKit server at `ws://127.0.0.1:7880` with API key/secret `devkey` / `secret`.

## Deploy (Vercel / Netlify)

Build command: `npm run build`  
Publish directory: `build`

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

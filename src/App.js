import { useState } from 'react';
import { LiveKitRoom } from '@livekit/components-react';
import '@livekit/components-styles';
import { AudioPresets } from 'livekit-client';
import {
  RAW_AUDIO_CAPTURE,
  VOICE_AUDIO_CAPTURE,
  buildAudioCaptureOptions,
} from './audioCapture';
import { createJoinToken } from './createToken';
import { RoomView } from './components/RoomView';
import './App.css';

const DEFAULT_SERVER_URL =
  process.env.REACT_APP_LIVEKIT_URL || 'ws://127.0.0.1:7880';
const DEFAULT_ROOM_NAME =
  process.env.REACT_APP_LIVEKIT_ROOM || 'noise-test';

function isMediaCaptureError(err) {
  const name = err?.name || '';
  const message = err?.message || '';
  return (
    name === 'NotReadableError' ||
    name === 'NotAllowedError' ||
    name === 'NotFoundError' ||
    name === 'OverconstrainedError' ||
    /could not start (video|audio) source/i.test(message) ||
    /media permissions/i.test(message)
  );
}

function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [roomName, setRoomName] = useState(DEFAULT_ROOM_NAME);
  const [token, setToken] = useState('');
  const [generatedIdentity, setGeneratedIdentity] = useState('');
  const [generatingToken, setGeneratingToken] = useState(false);
  const [enableAudio, setEnableAudio] = useState(true);
  // Off by default: same-machine / multi-tab joins often cannot open one camera twice.
  const [enableVideo, setEnableVideo] = useState(false);
  const [recommendedAudioOnJoin, setRecommendedAudioOnJoin] = useState(true);
  const [joined, setJoined] = useState(false);
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [mediaWarning, setMediaWarning] = useState('');

  const handleGenerateToken = async () => {
    setError('');
    setGeneratingToken(true);
    try {
      const result = await createJoinToken({ roomName });
      setToken(result.token);
      setGeneratedIdentity(result.identity);
    } catch (err) {
      console.error('[App] token generation failed:', err);
      setError(err?.message || 'Failed to generate LiveKit token.');
    } finally {
      setGeneratingToken(false);
    }
  };

  const handleJoin = (event) => {
    event.preventDefault();
    setError('');
    setMediaWarning('');

    const trimmedToken = token.trim();
    const trimmedUrl = serverUrl.trim();

    if (!trimmedUrl) {
      setError('Server URL is required.');
      return;
    }
    if (!trimmedToken) {
      setError('LiveKit token is required.');
      return;
    }

    setSession({
      token: trimmedToken,
      serverUrl: trimmedUrl,
      audio: enableAudio,
      video: enableVideo,
      recommendedAudio: recommendedAudioOnJoin,
      options: {
        audioCaptureDefaults: buildAudioCaptureOptions({
          recommended: recommendedAudioOnJoin,
        }),
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: {
          dtx: true,
          audioPreset: AudioPresets.speech,
        },
      },
    });
    setJoined(true);
  };

  const handleLeave = () => {
    setJoined(false);
    setSession(null);
    setError('');
    setMediaWarning('');
  };

  if (joined && session) {
    return (
      <LiveKitRoom
        token={session.token}
        serverUrl={session.serverUrl}
        connect
        audio={session.audio}
        video={session.video}
        options={session.options}
        onError={(err) => {
          console.error('[LiveKitRoom] error:', err);
          if (isMediaCaptureError(err)) {
            setMediaWarning(
              err?.message ||
                'Could not start camera/mic. You are still in the room — enable devices from the control bar, or join with video off.',
            );
            return;
          }
          setError(err?.message || 'Failed to connect to LiveKit room.');
          setJoined(false);
          setSession(null);
        }}
        onDisconnected={() => {
          setJoined(false);
          setSession(null);
        }}
        className="livekit-room"
        data-lk-theme="default"
      >
        <RoomView
          onLeave={handleLeave}
          mediaWarning={mediaWarning}
          initialRecommendedAudio={session.recommendedAudio}
        />
      </LiveKitRoom>
    );
  }

  return (
    <div className="App">
      <main className="join-panel">
        <h1>LiveKit noise cancellation test</h1>
        <p className="subtitle">
          Generate a token with a random identity, or paste your own. Each
          participant needs a unique token.
        </p>

        <form className="join-form" onSubmit={handleJoin}>
          <label htmlFor="serverUrl">
            Server URL
            <input
              id="serverUrl"
              name="serverUrl"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://127.0.0.1:7880"
              autoComplete="off"
            />
          </label>

          <label htmlFor="roomName">
            Room name
            <input
              id="roomName"
              name="roomName"
              type="text"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="noise-test"
              autoComplete="off"
            />
          </label>

          <label htmlFor="token">
            Token
            <textarea
              id="token"
              name="token"
              rows={6}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setGeneratedIdentity('');
              }}
              placeholder="Paste LiveKit access token or generate one"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="token-actions">
            <button
              type="button"
              className="secondary-btn"
              onClick={handleGenerateToken}
              disabled={generatingToken || !roomName.trim()}
            >
              {generatingToken ? 'Generating…' : 'Generate token'}
            </button>
            {generatedIdentity ? (
              <p className="identity-hint">
                Identity: <code>{generatedIdentity}</code>
              </p>
            ) : null}
          </div>

          <div className="media-toggles">
            <label className="checkbox-label" htmlFor="enableAudio">
              <input
                id="enableAudio"
                type="checkbox"
                checked={enableAudio}
                onChange={(e) => setEnableAudio(e.target.checked)}
              />
              Publish mic on join
            </label>
            <label className="checkbox-label" htmlFor="enableVideo">
              <input
                id="enableVideo"
                type="checkbox"
                checked={enableVideo}
                onChange={(e) => setEnableVideo(e.target.checked)}
              />
              Publish camera on join
            </label>
            <label className="checkbox-label" htmlFor="recommendedAudio">
              <input
                id="recommendedAudio"
                type="checkbox"
                checked={recommendedAudioOnJoin}
                onChange={(e) => setRecommendedAudioOnJoin(e.target.checked)}
              />
              Recommended WebRTC audio on join
            </label>
          </div>

          <div className="capture-summary">
            <p className="capture-summary-title">
              {recommendedAudioOnJoin
                ? 'Recommended capture (on)'
                : 'Raw capture (off)'}
            </p>
            <ul>
              {Object.entries(
                recommendedAudioOnJoin
                  ? VOICE_AUDIO_CAPTURE
                  : RAW_AUDIO_CAPTURE,
              ).map(([key, value]) => (
                <li key={key}>
                  {key}: <code>{JSON.stringify(value)}</code>
                </li>
              ))}
              <li>
                publish: <code>AudioPresets.speech</code> + <code>dtx</code>
              </li>
            </ul>
            <p className="settings-hint">
              After joining, use the in-room toggle to A/B without leaving.
            </p>
          </div>

          {error ? <p className="error">{error}</p> : null}

          <button type="submit">Join room</button>
        </form>
      </main>
    </div>
  );
}

export default App;

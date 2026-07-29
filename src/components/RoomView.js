import { useCallback, useState } from 'react';
import {
  ControlBar,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
  useTracks,
} from '@livekit/components-react';
import { ConnectionState, Track } from 'livekit-client';
import { buildAudioCaptureOptions } from '../audioCapture';

export function RoomView({
  onLeave,
  mediaWarning,
  initialRecommendedAudio = true,
}) {
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const remoteParticipants = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();
  const [recommendedAudio, setRecommendedAudio] = useState(
    initialRecommendedAudio,
  );
  const [busy, setBusy] = useState(false);
  const [toggleError, setToggleError] = useState('');

  const audioCaptureDefaults = buildAudioCaptureOptions({
    recommended: recommendedAudio,
  });

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const applyCaptureSettings = useCallback(
    async (recommended) => {
      const nextOptions = buildAudioCaptureOptions({ recommended });
      room.options.audioCaptureDefaults = {
        ...room.options.audioCaptureDefaults,
        ...nextOptions,
      };

      const micPub = localParticipant.getTrackPublication(
        Track.Source.Microphone,
      );
      const micTrack = micPub?.track;

      if (micTrack && typeof micTrack.restartTrack === 'function') {
        await micTrack.restartTrack(nextOptions);
        return;
      }

      await localParticipant.setMicrophoneEnabled(true, nextOptions);
    },
    [localParticipant, room],
  );

  const handleToggleRecommended = async (event) => {
    const next = event.target.checked;
    setBusy(true);
    setToggleError('');
    try {
      await applyCaptureSettings(next);
      setRecommendedAudio(next);
    } catch (err) {
      console.error('[RoomView] failed to apply audio capture settings:', err);
      setToggleError(
        err?.message || 'Failed to restart microphone with new settings.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="room">
      <header className="room-header">
        <div>
          <h1>LiveKit room</h1>
          <p className="status">
            Status: <strong>{connectionState}</strong>
            {' · '}
            Remotes: <strong>{remoteParticipants.length}</strong>
            {' · '}
            Settings:{' '}
            <strong>{recommendedAudio ? 'recommended' : 'raw (off)'}</strong>
          </p>
        </div>
        <button type="button" className="leave-btn" onClick={onLeave}>
          Leave
        </button>
      </header>

      <div className="settings-toggle-bar">
        <label className="checkbox-label" htmlFor="recommendedAudioLive">
          <input
            id="recommendedAudioLive"
            type="checkbox"
            checked={recommendedAudio}
            disabled={busy || connectionState !== ConnectionState.Connected}
            onChange={handleToggleRecommended}
          />
          Recommended WebRTC audio (AEC + NS + AGC + voiceIsolation)
        </label>
        <span className="settings-hint">
          Toggle live — mic restarts so you can hear the difference.
        </span>
      </div>

      {busy ? <p className="connecting">Restarting microphone…</p> : null}
      {toggleError ? <p className="media-warning">{toggleError}</p> : null}

      {connectionState === ConnectionState.Connecting && (
        <p className="connecting">Connecting to room…</p>
      )}

      {mediaWarning ? <p className="media-warning">{mediaWarning}</p> : null}

      <details className="capture-details">
        <summary>Active audioCaptureDefaults</summary>
        <pre>{JSON.stringify(audioCaptureDefaults, null, 2)}</pre>
      </details>

      <div className="room-stage" data-lk-theme="default">
        <GridLayout tracks={tracks} style={{ height: 'calc(100vh - 260px)' }}>
          <ParticipantTile />
        </GridLayout>
        <RoomAudioRenderer />
        <ControlBar controls={{ chat: false, screenShare: true }} />
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { ConnectionState, RoomEvent, Track } from 'livekit-client';
import { buildAudioCaptureOptions } from '../audioCapture';
import { DeepFilterNetLiveKitProcessor } from '../livekit/deepFilterNetProcessor';
import { getDeepFilterSession } from '../models/deepfilternetOrt';

export function RoomView({
  onLeave,
  mediaWarning,
  initialRecommendedAudio = true,
  initialDeepFilterNet = true,
}) {
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const remoteParticipants = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();
  const [recommendedAudio, setRecommendedAudio] = useState(
    initialRecommendedAudio,
  );
  const [deepFilterNet, setDeepFilterNet] = useState(initialDeepFilterNet);
  const [busy, setBusy] = useState(false);
  const [dfnBusy, setDfnBusy] = useState(false);
  const [toggleError, setToggleError] = useState('');
  const [dfnStatus, setDfnStatus] = useState(
    initialDeepFilterNet ? 'DeepFilterNet: starting…' : 'DeepFilterNet: off',
  );
  const [dfnStats, setDfnStats] = useState(null);
  const processorRef = useRef(null);

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

  const getMicTrack = useCallback(() => {
    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    return pub?.track;
  }, [localParticipant]);

  const detachDeepFilterNet = useCallback(async () => {
    const micTrack = getMicTrack();
    processorRef.current = null;
    if (micTrack && typeof micTrack.stopProcessor === 'function') {
      await micTrack.stopProcessor();
    }
  }, [getMicTrack]);

  const attachDeepFilterNet = useCallback(async () => {
    const micTrack = getMicTrack();
    if (!micTrack) {
      setDfnStatus('DeepFilterNet: waiting for microphone…');
      return;
    }

    setDfnStatus('DeepFilterNet: loading model…');
    await getDeepFilterSession();

    const processor = new DeepFilterNetLiveKitProcessor({
      enabled: true,
      attenLimDb: 0,
    });
    processorRef.current = processor;
    await micTrack.setProcessor(processor);
    setDfnStatus('DeepFilterNet: on (ORT)');
  }, [getMicTrack]);

  const syncDeepFilterNet = useCallback(
    async (enabled) => {
      setDfnBusy(true);
      setToggleError('');
      try {
        if (enabled) {
          await attachDeepFilterNet();
        } else {
          await detachDeepFilterNet();
          setDfnStatus('DeepFilterNet: off');
          setDfnStats(null);
        }
        setDeepFilterNet(enabled);
      } catch (err) {
        console.error('[RoomView] DeepFilterNet toggle failed:', err);
        setToggleError(
          err?.message || 'Failed to toggle DeepFilterNet processor.',
        );
        setDfnStatus('DeepFilterNet: error');
      } finally {
        setDfnBusy(false);
      }
    },
    [attachDeepFilterNet, detachDeepFilterNet],
  );

  // Attach once connected / when mic becomes available.
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return undefined;
    if (!deepFilterNet) return undefined;

    let cancelled = false;
    const tryAttach = async () => {
      if (cancelled) return;
      if (processorRef.current) return;
      try {
        await attachDeepFilterNet();
      } catch (err) {
        if (!cancelled) {
          console.error('[RoomView] DeepFilterNet attach failed:', err);
          setToggleError(err?.message || 'Failed to attach DeepFilterNet.');
          setDfnStatus('DeepFilterNet: error');
        }
      }
    };

    void tryAttach();
    const onLocalTrackPublished = () => {
      void tryAttach();
    };
    room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);

    return () => {
      cancelled = true;
      room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
    };
  }, [attachDeepFilterNet, connectionState, deepFilterNet, room]);

  // Cleanup processor on leave/unmount.
  useEffect(() => {
    return () => {
      void detachDeepFilterNet();
    };
  }, [detachDeepFilterNet]);

  // Poll lightweight inference stats while enabled.
  useEffect(() => {
    if (!deepFilterNet) return undefined;
    const id = window.setInterval(() => {
      const stats = processorRef.current?.getStats?.();
      if (stats) setDfnStats(stats);
    }, 1000);
    return () => window.clearInterval(id);
  }, [deepFilterNet]);

  const applyCaptureSettings = useCallback(
    async (recommended) => {
      const nextOptions = buildAudioCaptureOptions({ recommended });
      room.options.audioCaptureDefaults = {
        ...room.options.audioCaptureDefaults,
        ...nextOptions,
      };

      const micTrack = getMicTrack();
      const wasDfn = deepFilterNet;

      if (wasDfn) {
        await detachDeepFilterNet();
      }

      if (micTrack && typeof micTrack.restartTrack === 'function') {
        await micTrack.restartTrack(nextOptions);
      } else {
        await localParticipant.setMicrophoneEnabled(true, nextOptions);
      }

      if (wasDfn) {
        await attachDeepFilterNet();
      }
    },
    [
      attachDeepFilterNet,
      deepFilterNet,
      detachDeepFilterNet,
      getMicTrack,
      localParticipant,
      room,
    ],
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

  const handleToggleDeepFilterNet = async (event) => {
    await syncDeepFilterNet(event.target.checked);
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
            WebRTC:{' '}
            <strong>{recommendedAudio ? 'recommended' : 'raw'}</strong>
            {' · '}
            DFN: <strong>{deepFilterNet ? 'on' : 'off'}</strong>
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

      <div className="settings-toggle-bar">
        <label className="checkbox-label" htmlFor="deepFilterNetLive">
          <input
            id="deepFilterNetLive"
            type="checkbox"
            checked={deepFilterNet}
            disabled={dfnBusy || connectionState !== ConnectionState.Connected}
            onChange={handleToggleDeepFilterNet}
          />
          DeepFilterNet3 (ONNX Runtime Web) on published mic
        </label>
        <span className="settings-hint">{dfnStatus}</span>
        {dfnStats ? (
          <span className="settings-hint">
            frame {dfnStats.lastFrameMs.toFixed(1)} ms · underruns{' '}
            {dfnStats.underruns}
          </span>
        ) : null}
      </div>

      {busy || dfnBusy ? (
        <p className="connecting">Updating audio pipeline…</p>
      ) : null}
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
        <GridLayout tracks={tracks} style={{ height: 'calc(100vh - 300px)' }}>
          <ParticipantTile />
        </GridLayout>
        <RoomAudioRenderer />
        <ControlBar controls={{ chat: false, screenShare: true }} />
      </div>
    </div>
  );
}

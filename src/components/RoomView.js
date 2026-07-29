import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { RnnoiseLiveKitProcessor } from '../livekit/rnnoiseProcessor';
import {
  LIVE_NOISE_MODELS,
  selectNoiseModel,
} from '../livekit/selectNoiseModel';
import { getDeepFilterSession } from '../models/deepfilternetOrt';
import { getRnnoiseModule } from '../models/rnnoiseWasm';

export function RoomView({
  onLeave,
  mediaWarning,
  initialRecommendedAudio = true,
  initialNoiseSuppression = true,
}) {
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const remoteParticipants = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();
  const [recommendedAudio, setRecommendedAudio] = useState(
    initialRecommendedAudio,
  );
  const [noiseSuppression, setNoiseSuppression] = useState(
    initialNoiseSuppression,
  );
  const [busy, setBusy] = useState(false);
  const [nsBusy, setNsBusy] = useState(false);
  const [toggleError, setToggleError] = useState('');
  const [nsStatus, setNsStatus] = useState(
    initialNoiseSuppression
      ? 'Noise suppression: selecting model…'
      : 'Noise suppression: off',
  );
  const [nsStats, setNsStats] = useState(null);
  const processorRef = useRef(null);
  const selectedModelRef = useRef(null);

  const selection = useMemo(() => selectNoiseModel(), []);

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

  const detachNoiseProcessor = useCallback(async () => {
    const micTrack = getMicTrack();
    processorRef.current = null;
    if (micTrack && typeof micTrack.stopProcessor === 'function') {
      await micTrack.stopProcessor();
    }
  }, [getMicTrack]);

  const attachWithModel = useCallback(
    async (modelId) => {
      const micTrack = getMicTrack();
      if (!micTrack) {
        setNsStatus('Noise suppression: waiting for microphone…');
        return null;
      }

      if (modelId === LIVE_NOISE_MODELS.DEEPFILTERNET) {
        setNsStatus('DeepFilterNet3: loading model…');
        await getDeepFilterSession();
        const processor = new DeepFilterNetLiveKitProcessor({
          enabled: true,
          attenLimDb: 0,
        });
        processorRef.current = processor;
        await micTrack.setProcessor(processor);
        selectedModelRef.current = LIVE_NOISE_MODELS.DEEPFILTERNET;
        setNsStatus(`DeepFilterNet3: on — ${selection.reason}`);
        return LIVE_NOISE_MODELS.DEEPFILTERNET;
      }

      setNsStatus('RNNoise: loading WASM…');
      await getRnnoiseModule();
      const processor = new RnnoiseLiveKitProcessor({ enabled: true });
      processorRef.current = processor;
      await micTrack.setProcessor(processor);
      selectedModelRef.current = LIVE_NOISE_MODELS.RNNOISE;
      setNsStatus(`RNNoise: on — ${selection.reason}`);
      return LIVE_NOISE_MODELS.RNNOISE;
    },
    [getMicTrack, selection.reason],
  );

  const attachNoiseProcessor = useCallback(async () => {
    const preferred = selection.modelId;

    try {
      return await attachWithModel(preferred);
    } catch (err) {
      // If DeepFilterNet fails on a "capable" device, fall back to RNNoise.
      if (preferred === LIVE_NOISE_MODELS.DEEPFILTERNET) {
        console.warn(
          '[RoomView] DeepFilterNet failed, falling back to RNNoise:',
          err,
        );
        setNsStatus('DeepFilterNet failed — falling back to RNNoise…');
        try {
          await detachNoiseProcessor();
        } catch {
          /* ignore */
        }
        return await attachWithModel(LIVE_NOISE_MODELS.RNNOISE);
      }
      throw err;
    }
  }, [attachWithModel, detachNoiseProcessor, selection.modelId]);

  const syncNoiseSuppression = useCallback(
    async (enabled) => {
      setNsBusy(true);
      setToggleError('');
      try {
        if (enabled) {
          await attachNoiseProcessor();
        } else {
          await detachNoiseProcessor();
          selectedModelRef.current = null;
          setNsStatus('Noise suppression: off');
          setNsStats(null);
        }
        setNoiseSuppression(enabled);
      } catch (err) {
        console.error('[RoomView] noise suppression toggle failed:', err);
        setToggleError(
          err?.message || 'Failed to toggle noise suppression processor.',
        );
        setNsStatus('Noise suppression: error');
      } finally {
        setNsBusy(false);
      }
    },
    [attachNoiseProcessor, detachNoiseProcessor],
  );

  // Attach once connected / when mic becomes available.
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return undefined;
    if (!noiseSuppression) return undefined;

    let cancelled = false;
    const tryAttach = async () => {
      if (cancelled) return;
      if (processorRef.current) return;
      try {
        await attachNoiseProcessor();
      } catch (err) {
        if (!cancelled) {
          console.error('[RoomView] noise processor attach failed:', err);
          setToggleError(err?.message || 'Failed to attach noise processor.');
          setNsStatus('Noise suppression: error');
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
  }, [attachNoiseProcessor, connectionState, noiseSuppression, room]);

  // Cleanup processor on leave/unmount.
  useEffect(() => {
    return () => {
      void detachNoiseProcessor();
    };
  }, [detachNoiseProcessor]);

  // Poll lightweight inference stats while enabled.
  useEffect(() => {
    if (!noiseSuppression) return undefined;
    const id = window.setInterval(() => {
      const stats = processorRef.current?.getStats?.();
      if (stats) setNsStats(stats);
    }, 1000);
    return () => window.clearInterval(id);
  }, [noiseSuppression]);

  const applyCaptureSettings = useCallback(
    async (recommended) => {
      const nextOptions = buildAudioCaptureOptions({ recommended });
      room.options.audioCaptureDefaults = {
        ...room.options.audioCaptureDefaults,
        ...nextOptions,
      };

      const micTrack = getMicTrack();
      const wasNs = noiseSuppression;

      if (wasNs) {
        await detachNoiseProcessor();
      }

      if (micTrack && typeof micTrack.restartTrack === 'function') {
        await micTrack.restartTrack(nextOptions);
      } else {
        await localParticipant.setMicrophoneEnabled(true, nextOptions);
      }

      if (wasNs) {
        await attachNoiseProcessor();
      }
    },
    [
      attachNoiseProcessor,
      detachNoiseProcessor,
      getMicTrack,
      localParticipant,
      noiseSuppression,
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

  const handleToggleNoiseSuppression = async (event) => {
    await syncNoiseSuppression(event.target.checked);
  };

  const activeModelLabel =
    selectedModelRef.current === LIVE_NOISE_MODELS.DEEPFILTERNET
      ? 'DeepFilterNet3'
      : selectedModelRef.current === LIVE_NOISE_MODELS.RNNOISE
        ? 'RNNoise'
        : selection.modelLabel;

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
            NS:{' '}
            <strong>
              {noiseSuppression ? activeModelLabel : 'off'}
            </strong>
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
        <label className="checkbox-label" htmlFor="noiseSuppressionLive">
          <input
            id="noiseSuppressionLive"
            type="checkbox"
            checked={noiseSuppression}
            disabled={nsBusy || connectionState !== ConnectionState.Connected}
            onChange={handleToggleNoiseSuppression}
          />
          AI noise suppression (auto: DeepFilterNet / RNNoise)
        </label>
        <span className="settings-hint">{nsStatus}</span>
        {nsStats ? (
          <span className="settings-hint">
            frame {nsStats.lastFrameMs.toFixed(1)} ms · underruns{' '}
            {nsStats.underruns}
          </span>
        ) : null}
      </div>

      <div className="capture-summary" style={{ margin: '0 20px 12px' }}>
        <p className="capture-summary-title">Selected model for this device</p>
        <ul>
          <li>
            Preferred: <code>{selection.modelLabel}</code>
          </li>
          <li>
            Reason: <code>{selection.reason}</code>
          </li>
          <li>
            Cores: <code>{selection.assessment.cores}</code>
            {' · '}
            Memory:{' '}
            <code>
              {selection.assessment.memoryGB != null
                ? `${selection.assessment.memoryGB} GB`
                : 'unknown'}
            </code>
            {' · '}
            Mobile: <code>{String(selection.assessment.isMobile)}</code>
            {' · '}
            Score: <code>{selection.assessment.score}</code>
          </li>
        </ul>
      </div>

      {busy || nsBusy ? (
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
        <GridLayout tracks={tracks} style={{ height: 'calc(100vh - 340px)' }}>
          <ParticipantTile />
        </GridLayout>
        <RoomAudioRenderer />
        <ControlBar controls={{ chat: false, screenShare: true }} />
      </div>
    </div>
  );
}

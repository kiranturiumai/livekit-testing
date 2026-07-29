import { useEffect, useMemo, useState } from 'react';
import { audioBufferToMono, decodeAudioSource } from '../audio/decodeAudio';
import { encodeWavBlob } from '../audio/wavEncode';
import { computeAudioMetrics, scoreModelRun } from '../audio/metrics';
import { getNoiseModel, NOISE_MODELS } from '../models';
import { DEEPFILTERNET_ORT_ID } from '../models/deepfilternetOrt';
import { StatsPanel } from './StatsPanel';

const DEFAULT_SOURCE = '/krisp-original.mp3';

function getMemoryMB() {
  if (performance.memory) {
    return performance.memory.usedJSHeapSize / (1024 * 1024);
  }
  return null;
}

export function ModelLab() {
  const [modelId, setModelId] = useState(DEEPFILTERNET_ORT_ID);
  const [sourceUrl, setSourceUrl] = useState(DEFAULT_SOURCE);
  const [pickedFile, setPickedFile] = useState(null);
  const [attenLimDb, setAttenLimDb] = useState(0);
  const [status, setStatus] = useState('Idle — click Process to denoise.');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [originalUrl, setOriginalUrl] = useState(DEFAULT_SOURCE);
  const [enhancedUrl, setEnhancedUrl] = useState('');
  const [runHistory, setRunHistory] = useState([]);

  const model = useMemo(() => getNoiseModel(modelId), [modelId]);

  useEffect(() => {
    return () => {
      if (enhancedUrl) URL.revokeObjectURL(enhancedUrl);
    };
  }, [enhancedUrl]);

  const handleFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setPickedFile(file);
    setError('');
    if (enhancedUrl) {
      URL.revokeObjectURL(enhancedUrl);
      setEnhancedUrl('');
    }
    if (file) {
      const url = URL.createObjectURL(file);
      setOriginalUrl(url);
      setSourceUrl(url);
    } else {
      setOriginalUrl(DEFAULT_SOURCE);
      setSourceUrl(DEFAULT_SOURCE);
    }
  };

  const handleProcess = async () => {
    setBusy(true);
    setError('');
    setProgress(0);
    setStatus(`Loading ${model.label}…`);

    const totalStart = performance.now();
    const memBefore = getMemoryMB();
    let prepareMs = 0;
    let decodeMs = 0;
    let encodeMs = 0;

    try {
      const prepStart = performance.now();
      await model.prepare();
      prepareMs = performance.now() - prepStart;

      setStatus('Decoding audio…');
      const decStart = performance.now();
      const source = pickedFile || sourceUrl;
      const buffer = await decodeAudioSource(source);
      const mono = audioBufferToMono(buffer);
      decodeMs = performance.now() - decStart;

      setStatus(`Running ${model.label} inference…`);
      const result = await model.process(mono, buffer.sampleRate, {
        attenLimDb: Number(attenLimDb),
        onProgress: (p) => setProgress(p),
      });

      setStatus('Analyzing & encoding…');
      const encStart = performance.now();
      const wav = encodeWavBlob(result.samples, result.sampleRate);
      encodeMs = performance.now() - encStart;

      if (enhancedUrl) URL.revokeObjectURL(enhancedUrl);
      const nextUrl = URL.createObjectURL(wav);
      setEnhancedUrl(nextUrl);
      setProgress(1);

      const memAfter = getMemoryMB();
      const totalMs = performance.now() - totalStart;

      // Compute audio quality metrics (original vs enhanced)
      const audioMetrics = computeAudioMetrics(mono, result.samples, result.sampleRate);

      const runStats = {
        modelId: model.id,
        modelLabel: model.label,
        timestamp: Date.now(),
        prepareMs,
        decodeMs,
        encodeMs,
        elapsedMs: result.stats.elapsedMs,
        totalMs,
        audioMs: result.stats.audioMs,
        rtf: result.stats.rtf,
        frames: result.stats.frames,
        speechFrames: result.stats.speechFrames,
        silenceGated: result.stats.silenceGated,
        vadThreshold: result.stats.vadThreshold,
        note: result.stats.note,
        memBeforeMB: memBefore,
        peakMemoryMB: memAfter,
        memDeltaMB: memBefore != null && memAfter != null ? memAfter - memBefore : null,
        audioDurationSec: result.stats.audioMs ? result.stats.audioMs / 1000 : null,
        audioMetrics,
      };

      // Compute composite score and live-call prediction
      const scoring = scoreModelRun(runStats, audioMetrics);
      runStats.scores = scoring.scores;
      runStats.overall = scoring.overall;
      runStats.msPerFrame = scoring.msPerFrame;
      runStats.liveCall = scoring.liveCall;

      setRunHistory((prev) => [...prev, runStats]);

      setStatus(
        `Done — Score: ${scoring.overall}/100 · RTF ${result.stats.rtf.toFixed(3)}x · ${(totalMs / 1000).toFixed(2)}s total`,
      );
    } catch (err) {
      console.error('[ModelLab] process failed:', err);
      setError(err?.message || 'Processing failed.');
      setStatus('Failed');
    } finally {
      setBusy(false);
    }
  };

  const handleClearHistory = () => setRunHistory([]);

  return (
    <main className="join-panel model-lab">
      <h1>Model Lab — Noise Suppression</h1>
      <p className="subtitle">
        Offline noise suppression testing. Select a model, process audio, and compare
        performance metrics across models.
      </p>

      <div className="join-form">
        <label htmlFor="modelSelect">
          Model
          <select
            id="modelSelect"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={busy}
          >
            {NOISE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label htmlFor="audioFile">
          Input audio
          <input
            id="audioFile"
            type="file"
            accept="audio/*"
            onChange={handleFileChange}
            disabled={busy}
          />
        </label>
        <p className="settings-hint">
          Default sample: <code>{DEFAULT_SOURCE}</code>
        </p>

        <label htmlFor="attenLimDb">
          Attenuation limit (dB): {attenLimDb}
          <input
            id="attenLimDb"
            type="range"
            min="0"
            max="50"
            step="1"
            value={attenLimDb}
            onChange={(e) => setAttenLimDb(Number(e.target.value))}
            disabled={busy}
          />
        </label>
        <p className="settings-hint">
          0 = full suppression. Higher blends more of the original noisy signal.
        </p>

        <div className="token-actions">
          <button type="button" onClick={handleProcess} disabled={busy}>
            {busy ? 'Processing…' : 'Process with model'}
          </button>
          {enhancedUrl ? (
            <a className="secondary-btn download-link" href={enhancedUrl} download="enhanced.wav">
              Download enhanced WAV
            </a>
          ) : null}
          {runHistory.length > 0 && (
            <button type="button" className="secondary-btn" onClick={handleClearHistory} disabled={busy}>
              Clear history
            </button>
          )}
        </div>

        {busy || progress > 0 ? (
          <div className="progress-bar" aria-label="Processing progress">
            <div className="progress-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}

        <p className="status-line">{status}</p>
        {error ? <p className="error">{error}</p> : null}

        <div className="audio-compare">
          <div>
            <h2>Original</h2>
            <audio controls src={originalUrl} preload="metadata" />
          </div>
          <div>
            <h2>Enhanced</h2>
            {enhancedUrl ? (
              <audio controls src={enhancedUrl} preload="metadata" />
            ) : (
              <p className="settings-hint">Run process to hear the result.</p>
            )}
          </div>
        </div>
      </div>

      <StatsPanel history={runHistory} />
    </main>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { audioBufferToMono, decodeAudioSource } from '../audio/decodeAudio';
import { encodeWavBlob } from '../audio/wavEncode';
import { getNoiseModel, NOISE_MODELS } from '../models';
import { DEEPFILTERNET_ORT_ID } from '../models/deepfilternetOrt';

const DEFAULT_SOURCE = '/krisp-original.mp3';

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
  const [stats, setStats] = useState(null);

  const model = useMemo(() => getNoiseModel(modelId), [modelId]);

  useEffect(() => {
    return () => {
      if (enhancedUrl) URL.revokeObjectURL(enhancedUrl);
    };
  }, [enhancedUrl]);

  const handleFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setPickedFile(file);
    setStats(null);
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
    setStats(null);
    setStatus(`Loading ${model.label}…`);

    try {
      await model.prepare();
      setStatus('Decoding audio…');

      const source = pickedFile || sourceUrl;
      const buffer = await decodeAudioSource(source);
      const mono = audioBufferToMono(buffer);

      setStatus('Running DeepFilterNet inference…');
      const result = await model.process(mono, buffer.sampleRate, {
        attenLimDb: Number(attenLimDb),
        onProgress: (p) => setProgress(p),
      });

      const wav = encodeWavBlob(result.samples, result.sampleRate);
      if (enhancedUrl) URL.revokeObjectURL(enhancedUrl);
      const nextUrl = URL.createObjectURL(wav);
      setEnhancedUrl(nextUrl);
      setStats(result.stats);
      setProgress(1);
      setStatus(
        `Done in ${(result.stats.elapsedMs / 1000).toFixed(2)}s (RTF ${result.stats.rtf.toFixed(2)}x)`,
      );
    } catch (err) {
      console.error('[ModelLab] process failed:', err);
      setError(err?.message || 'Processing failed.');
      setStatus('Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="join-panel model-lab">
      <h1>Model lab — DeepFilterNet</h1>
      <p className="subtitle">
        Offline noise suppression with ONNX Runtime Web. Process the sample
        (or your own file), then compare original vs enhanced.
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
            {busy ? 'Processing…' : 'Process with DeepFilterNet'}
          </button>
          {enhancedUrl ? (
            <a className="secondary-btn download-link" href={enhancedUrl} download="deepfilternet-enhanced.wav">
              Download enhanced WAV
            </a>
          ) : null}
        </div>

        {busy || progress > 0 ? (
          <div className="progress-bar" aria-label="Processing progress">
            <div className="progress-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}

        <p className="status-line">{status}</p>
        {stats ? (
          <p className="settings-hint">
            Frames: {stats.frames} · Audio: {(stats.audioMs / 1000).toFixed(2)}s ·
            Wall: {(stats.elapsedMs / 1000).toFixed(2)}s
          </p>
        ) : null}
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
    </main>
  );
}

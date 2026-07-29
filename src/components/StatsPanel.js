import { useState } from 'react';

/**
 * Visual stats dashboard for model processing results.
 * Shows performance metrics, audio quality, model score, and live-call prediction.
 */
export function StatsPanel({ history }) {
  const [selectedRuns, setSelectedRuns] = useState([]);

  if (!history || history.length === 0) return null;

  const latest = history[history.length - 1];

  const toggleRun = (idx) => {
    setSelectedRuns((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
    );
  };

  const compareRuns =
    selectedRuns.length > 0
      ? selectedRuns.map((i) => history[i]).filter(Boolean)
      : [latest];

  const maxElapsed = Math.max(...history.map((r) => r.elapsedMs));
  const maxPeak = Math.max(...history.map((r) => r.peakMemoryMB || 0)) || 1;
  const maxRtf = Math.max(...history.map((r) => r.rtf)) || 1;
  const maxScore = 100;

  return (
    <div className="stats-panel">
      {/* ── Model Score ─────────────────────── */}
      {latest.overall != null && (
        <div className="score-hero">
          <ScoreRing score={latest.overall} />
          <div className="score-hero-text">
            <span className="score-hero-label">Overall Score</span>
            <span className="score-hero-model">{latest.modelLabel}</span>
          </div>
        </div>
      )}

      {/* ── LiveKit Call Prediction ──────────── */}
      {latest.liveCall && (
        <div className="live-call-card" style={{ borderLeftColor: latest.liveCall.verdictColor }}>
          <h3>LiveKit Call Prediction</h3>
          <p className="live-call-verdict" style={{ color: latest.liveCall.verdictColor }}>
            {latest.liveCall.verdict}
          </p>
          <div className="live-call-grid">
            <MiniStat label="Real-time ready" value={latest.liveCall.ready ? 'Yes' : 'No'} good={latest.liveCall.ready} />
            <MiniStat label="Est. latency" value={`${latest.liveCall.estimatedLatencyMs.toFixed(1)} ms`} />
            <MiniStat label="CPU budget" value={`${latest.liveCall.cpuBudgetPct.toFixed(0)}%`} warn={latest.liveCall.cpuBudgetPct > 70} />
            <MiniStat label="Frame budget" value={`${latest.liveCall.frameBudgetMs} ms`} />
            <MiniStat label="Ms per frame" value={`${latest.msPerFrame.toFixed(2)} ms`} />
            <MiniStat label="Headroom" value={latest.liveCall.cpuBudgetPct < 100 ? `${(100 - latest.liveCall.cpuBudgetPct).toFixed(0)}%` : 'None'} good={latest.liveCall.cpuBudgetPct < 70} />
          </div>
        </div>
      )}

      {/* ── Score Breakdown ─────────────────── */}
      {latest.scores && (
        <div className="stats-section">
          <h3>Score Breakdown</h3>
          <div className="score-bars">
            <ScoreBar label="Speed (RTF)" score={latest.scores.rtf} weight="40%" />
            <ScoreBar label="Frame Latency" score={latest.scores.latency} weight="25%" />
            <ScoreBar label="Memory Efficiency" score={latest.scores.memory} weight="15%" />
            <ScoreBar label="Noise Reduction" score={latest.scores.noiseReduction} weight="10%" />
            <ScoreBar label="Signal Preservation" score={latest.scores.signalPreservation} weight="10%" />
          </div>
        </div>
      )}

      {/* ── Summary cards ───────────────────── */}
      <div className="stats-cards">
        <StatCard
          label="Processing Time"
          value={`${(latest.elapsedMs / 1000).toFixed(2)}s`}
          sub={`${latest.audioMs ? (latest.audioMs / 1000).toFixed(2) : '?'}s audio`}
          color="#3d7eff"
        />
        <StatCard
          label="Real-Time Factor"
          value={`${latest.rtf.toFixed(3)}x`}
          sub={latest.rtf < 1 ? 'Faster than real-time' : 'Slower than real-time'}
          color={latest.rtf < 1 ? '#4ecf73' : '#ff6b6b'}
        />
        <StatCard
          label="Frames"
          value={latest.frames || '—'}
          sub={latest.speechFrames != null ? `${latest.speechFrames} speech / ${latest.silenceGated} gated` : `${latest.msPerFrame ? latest.msPerFrame.toFixed(2) + ' ms/frame' : ''}`}
          color="#a78bfa"
        />
        <StatCard
          label="Peak Memory"
          value={latest.peakMemoryMB ? `${latest.peakMemoryMB.toFixed(1)} MB` : 'N/A'}
          sub={latest.memDeltaMB ? `+${latest.memDeltaMB.toFixed(1)} MB delta` : 'Chrome only'}
          color="#f59e0b"
        />
      </div>

      {/* ── Audio Quality Metrics ───────────── */}
      {latest.audioMetrics && (
        <div className="stats-section">
          <h3>Audio Quality</h3>
          <div className="audio-metrics-grid">
            <MetricCard
              label="Original RMS"
              value={`${latest.audioMetrics.originalRmsDb.toFixed(1)} dB`}
              icon="🔊"
            />
            <MetricCard
              label="Enhanced RMS"
              value={`${latest.audioMetrics.enhancedRmsDb.toFixed(1)} dB`}
              icon="🔇"
            />
            <MetricCard
              label="Original Peak"
              value={`${latest.audioMetrics.originalPeakDb.toFixed(1)} dB`}
              icon="📈"
            />
            <MetricCard
              label="Enhanced Peak"
              value={`${latest.audioMetrics.enhancedPeakDb.toFixed(1)} dB`}
              icon="📉"
            />
            <MetricCard
              label="Noise Change"
              value={`${latest.audioMetrics.noiseReductionDb.toFixed(1)} dB`}
              icon="🎯"
            />
            <MetricCard
              label="SDR"
              value={`${latest.audioMetrics.sdrDb.toFixed(1)} dB`}
              icon="📊"
            />
            <MetricCard
              label="Energy Ratio"
              value={`${(latest.audioMetrics.energyRatio * 100).toFixed(1)}%`}
              icon="⚡"
            />
            <MetricCard
              label="Duration"
              value={`${latest.audioMetrics.durationSec.toFixed(2)}s`}
              icon="⏱"
            />
          </div>
        </div>
      )}

      {/* ── Timing Breakdown ────────────────── */}
      <div className="stats-section">
        <h3>Timing Breakdown</h3>
        <div className="stats-bars">
          {latest.prepareMs != null && (
            <BarRow label="Model Load" value={latest.prepareMs} max={latest.totalMs || latest.elapsedMs} unit="ms" color="#8ec7ff" />
          )}
          {latest.decodeMs != null && (
            <BarRow label="Audio Decode" value={latest.decodeMs} max={latest.totalMs || latest.elapsedMs} unit="ms" color="#a78bfa" />
          )}
          <BarRow label="Inference" value={latest.elapsedMs} max={latest.totalMs || latest.elapsedMs} unit="ms" color="#3d7eff" />
          {latest.encodeMs != null && (
            <BarRow label="WAV Encode" value={latest.encodeMs} max={latest.totalMs || latest.elapsedMs} unit="ms" color="#4ecf73" />
          )}
        </div>
      </div>

      {/* ── Model-specific details ──────────── */}
      {(latest.note || latest.vadThreshold != null) && (
        <div className="stats-section">
          <h3>Model Details</h3>
          <div className="stats-detail-grid">
            {latest.vadThreshold != null && <DetailRow label="VAD Threshold" value={latest.vadThreshold} />}
            {latest.speechFrames != null && <DetailRow label="Speech Frames" value={latest.speechFrames} />}
            {latest.silenceGated != null && <DetailRow label="Silence Gated" value={latest.silenceGated} />}
            {latest.note && <DetailRow label="Note" value={latest.note} />}
          </div>
        </div>
      )}

      {/* ── Run History Comparison ───────────── */}
      {history.length > 1 && (
        <div className="stats-section">
          <h3>Run History — Compare</h3>
          <p className="stats-hint">Click rows to select for comparison.</p>
          <table className="stats-table">
            <thead>
              <tr>
                <th></th>
                <th>Model</th>
                <th>Score</th>
                <th>Time</th>
                <th>RTF</th>
                <th>Live?</th>
              </tr>
            </thead>
            <tbody>
              {history.map((run, i) => (
                <tr
                  key={i}
                  className={selectedRuns.includes(i) ? 'selected' : ''}
                  onClick={() => toggleRun(i)}
                >
                  <td><input type="checkbox" checked={selectedRuns.includes(i)} readOnly /></td>
                  <td className="model-name">{run.modelLabel}</td>
                  <td><span className="score-badge" style={{ background: scoreColor(run.overall) }}>{run.overall}</span></td>
                  <td>{(run.elapsedMs / 1000).toFixed(2)}s</td>
                  <td className={run.rtf < 1 ? 'stat-good' : 'stat-warn'}>{run.rtf.toFixed(3)}x</td>
                  <td>{run.liveCall?.ready ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {compareRuns.length > 0 && (
            <div className="compare-charts">
              <h4>Overall Score</h4>
              {compareRuns.map((run, i) => (
                <BarRow key={`s-${i}`} label={run.modelLabel} value={run.overall || 0} max={maxScore} unit="/100" color={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}

              <h4>Processing Time</h4>
              {compareRuns.map((run, i) => (
                <BarRow key={`t-${i}`} label={run.modelLabel} value={run.elapsedMs} max={maxElapsed} unit="ms" color={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}

              <h4>Real-Time Factor (lower is better)</h4>
              {compareRuns.map((run, i) => (
                <BarRow key={`r-${i}`} label={run.modelLabel} value={run.rtf} max={maxRtf} unit="x" color={CHART_COLORS[i % CHART_COLORS.length]} precision={3} />
              ))}

              {compareRuns.some((r) => r.peakMemoryMB) && (
                <>
                  <h4>Peak Memory</h4>
                  {compareRuns.map((run, i) => (
                    <BarRow key={`m-${i}`} label={run.modelLabel} value={run.peakMemoryMB || 0} max={maxPeak} unit="MB" color={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const CHART_COLORS = ['#3d7eff', '#4ecf73', '#f59e0b', '#a78bfa', '#ff6b6b', '#8ec7ff'];

function scoreColor(score) {
  if (score >= 75) return '#4ecf73';
  if (score >= 50) return '#f59e0b';
  return '#ff6b6b';
}

function ScoreRing({ score }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = scoreColor(score);

  return (
    <svg className="score-ring" width="100" height="100" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r={radius} fill="none" stroke="#1a2744" strokeWidth="8" />
      <circle
        cx="50" cy="50" r={radius} fill="none"
        stroke={color} strokeWidth="8"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 50 50)"
        style={{ transition: 'stroke-dashoffset 600ms ease' }}
      />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central"
        fill={color} fontSize="22" fontWeight="700">
        {score}
      </text>
    </svg>
  );
}

function ScoreBar({ label, score, weight }) {
  const color = scoreColor(score);
  return (
    <div className="score-bar-row">
      <span className="score-bar-label">{label} <span className="score-bar-weight">({weight})</span></span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="bar-value" style={{ color }}>{Math.round(score)}</span>
    </div>
  );
}

function StatCard({ label, value, sub, color }) {
  return (
    <div className="stat-card" style={{ borderTopColor: color }}>
      <span className="stat-card-value" style={{ color }}>{value}</span>
      <span className="stat-card-label">{label}</span>
      {sub && <span className="stat-card-sub">{sub}</span>}
    </div>
  );
}

function MetricCard({ label, value, icon }) {
  return (
    <div className="metric-card">
      <span className="metric-icon">{icon}</span>
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

function MiniStat({ label, value, good, warn }) {
  let cls = 'mini-stat-value';
  if (good === true) cls += ' stat-good';
  else if (good === false || warn) cls += ' stat-warn';
  return (
    <div className="mini-stat">
      <span className="mini-stat-label">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}

function BarRow({ label, value, max, unit, color, precision = 0 }) {
  const pct = max > 0 ? Math.max((value / max) * 100, 2) : 0;
  const display = precision > 0 ? Number(value).toFixed(precision) : Math.round(value);
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="bar-value">{display}{unit}</span>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{String(value)}</span>
    </div>
  );
}

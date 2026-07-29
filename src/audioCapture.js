/**
 * Voice-first WebRTC capture defaults (matches qale VOICE_AUDIO_CAPTURE).
 * AEC / NS / AGC are hard-required; voiceIsolation and mono stay soft so
 * unsupported browsers/devices do not fail getUserMedia.
 */
export const VOICE_AUDIO_CAPTURE = {
  echoCancellation: { exact: true },
  noiseSuppression: { exact: true },
  autoGainControl: { exact: true },
  voiceIsolation: { ideal: true },
  channelCount: { ideal: 1 },
};

/** Raw capture with browser processing explicitly off. */
export const RAW_AUDIO_CAPTURE = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: false,
  channelCount: { ideal: 1 },
};

export function buildAudioCaptureOptions({ recommended }) {
  return recommended ? { ...VOICE_AUDIO_CAPTURE } : { ...RAW_AUDIO_CAPTURE };
}

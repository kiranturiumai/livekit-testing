const API_KEY = process.env.REACT_APP_LIVEKIT_API_KEY || 'devkey';
const API_SECRET = process.env.REACT_APP_LIVEKIT_API_SECRET || 'secret';
const TOKEN_TTL = process.env.REACT_APP_LIVEKIT_TOKEN_TTL || '24h';

const ADJECTIVES = [
  'amber',
  'brisk',
  'calm',
  'daring',
  'eager',
  'fuzzy',
  'gentle',
  'happy',
  'ivory',
  'jolly',
  'keen',
  'lucky',
  'merry',
  'noble',
  'plucky',
  'quick',
  'rusty',
  'sunny',
  'tidy',
  'vivid',
];

const NOUNS = [
  'badger',
  'cedar',
  'dolphin',
  'eagle',
  'falcon',
  'gecko',
  'heron',
  'ibis',
  'jaguar',
  'koala',
  'lynx',
  'mango',
  'newt',
  'otter',
  'panda',
  'quail',
  'raven',
  'sparrow',
  'tiger',
  'ursa',
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function randomParticipantName() {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(Math.random() * 900 + 100)}`;
}

function parseTtlSeconds(ttl) {
  if (typeof ttl === 'number' && Number.isFinite(ttl)) {
    return Math.max(1, Math.floor(ttl));
  }

  const match = String(ttl)
    .trim()
    .match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!match) {
    return 24 * 60 * 60;
  }

  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return amount * multipliers[unit];
}

function base64UrlEncode(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJson(value) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function signHs256(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  return base64UrlEncode(signature);
}

/**
 * Mint a LiveKit join token in the browser (local testing only).
 * Uses the same claim shape as livekit-server-sdk AccessToken.
 */
export async function createJoinToken({
  roomName,
  identity = randomParticipantName(),
  ttl = TOKEN_TTL,
  apiKey = API_KEY,
  apiSecret = API_SECRET,
} = {}) {
  if (!roomName?.trim()) {
    throw new Error('Room name is required to generate a token.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: apiKey,
    sub: identity,
    name: identity,
    nbf: now,
    exp: now + parseTtlSeconds(ttl),
    video: {
      roomJoin: true,
      room: roomName.trim(),
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };

  const unsigned = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await signHs256(unsigned, apiSecret);
  return {
    token: `${unsigned}.${signature}`,
    identity,
    roomName: roomName.trim(),
    ttl,
  };
}

import { AccessToken } from 'livekit-server-sdk';

const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
const roomName = process.argv[2] || 'noise-test';
const identity = process.argv[3] || `tester-${Date.now()}`;
const ttl = process.env.LIVEKIT_TOKEN_TTL || '24h';

const at = new AccessToken(apiKey, apiSecret, {
  identity,
  name: identity,
  ttl,
});

at.addGrant({
  roomJoin: true,
  room: roomName,
  canPublish: true,
  canSubscribe: true,
  canPublishData: true,
});

const token = await at.toJwt();

console.log(`Room:     ${roomName}`);
console.log(`Identity: ${identity}`);
console.log(`TTL:      ${ttl}`);
console.log('');
console.log(token);

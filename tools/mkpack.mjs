import { writeFileSync, statSync } from 'node:fs';
import { encodeFrame, LM_COUNT } from '../src/net/protocol.js';
const lm = Array.from({ length: LM_COUNT }, (_, i) => ({ x: 0.5 + (i % 10) / 1000, y: 0.5, z: 0 }));
writeFileSync('./tools/_pkt.tmp', Buffer.from(encodeFrame({ seq: 1, captureAt: 1, width: 720, height: 1280, landmarks: lm, blinkL: 0.1, blinkR: 0.1 })));
console.log('packet bytes', statSync('./tools/_pkt.tmp').size);

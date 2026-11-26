/* ============================================================
   net/protocol.js — 手机 ↔ PC 的关键点传输协议
   ------------------------------------------------------------
   设计取舍：**不传视频，传 MediaPipe 的结果**。
   理由：
   1) 带宽从 ~1.5 MB/s 降到 ~87 KB/s（30 fps），弱 Wi-Fi 也能跑；
   2) 手机端已经用 GPU 算过一遍，PC 不必再推理第二次；
   3) 画面不出手机，隐私上更干净；
   4) PC 端可以直接复用 analyzeFace()，两路特征语义完全一致，
      不会出现「两份实现慢慢漂移」的问题。

   包格式（小端，共 2894 字节）：
     0   u32  magic     'EPL1'
     4   u32  seq       帧序号
     8   f64  captureAt 手机端 performance.now()
     16  u16  width     视频帧宽（用于把归一化 z 还原成像素尺度）
     18  u16  height    视频帧高
     20  u16  lmCount   关键点数量（478）
     22  u16  flags     bit0 = 附带眨眼分数
     24  ...  点表：lmCount × (u16 x, u16 y, i16 z)
     ..  u8 blinkLeft, u8 blinkRight
   ============================================================ */

export const MAGIC = 0x45504c31; // 'EPL1'
export const LM_COUNT = 478;
export const HEADER_BYTES = 24;
export const PACKET_BYTES = HEADER_BYTES + LM_COUNT * 6 + 2;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampS = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * 把 478 个归一化关键点打包成二进制。
 * x/y ∈ [0,1] 用 u16（精度 1.5e-5，1280 宽下约 0.02px）；
 * z 是相对脸宽的深度，范围约 ±0.1，用 i16 足够。
 */
export function encodeFrame({ seq = 0, captureAt = 0, width = 640, height = 480, landmarks, blinkL = 0, blinkR = 0 }) {
  const buf = new ArrayBuffer(PACKET_BYTES);
  const dv = new DataView(buf);
  // magic 按字节写，保证和 Python / Node 服务端校验的 b'EPL1' 完全一致
  dv.setUint8(0, 0x45); dv.setUint8(1, 0x50); dv.setUint8(2, 0x4c); dv.setUint8(3, 0x31);
  dv.setUint32(4, seq >>> 0, true);
  dv.setFloat64(8, captureAt, true);
  dv.setUint16(16, Math.min(65535, width | 0), true);
  dv.setUint16(18, Math.min(65535, height | 0), true);
  dv.setUint16(20, LM_COUNT, true);
  dv.setUint16(22, 1, true);

  let o = HEADER_BYTES;
  for (let i = 0; i < LM_COUNT; i++) {
    const p = landmarks[i];
    if (!p) {
      dv.setUint16(o, 0, true);
      dv.setUint16(o + 2, 0, true);
      dv.setInt16(o + 4, 0, true);
      o += 6;
      continue;
    }
    dv.setUint16(o, Math.round(clamp01(p.x) * 65535), true);
    dv.setUint16(o + 2, Math.round(clamp01(p.y) * 65535), true);
    dv.setInt16(o + 4, Math.round(clampS(p.z) * 32767), true);
    o += 6;
  }
  dv.setUint8(o, Math.round(clamp01(blinkL) * 255));
  dv.setUint8(o + 1, Math.round(clamp01(blinkR) * 255));
  return buf;
}

/** 解包；magic 或长度不对时返回 null（服务端可能收到半包/杂包） */
export function decodeFrame(buffer) {
  const dv = buffer instanceof DataView ? buffer : new DataView(buffer);
  if (dv.byteLength < HEADER_BYTES) return null;
  if (dv.getUint8(0) !== 0x45 || dv.getUint8(1) !== 0x50 || dv.getUint8(2) !== 0x4c || dv.getUint8(3) !== 0x31) return null;
  const seq = dv.getUint32(4, true);
  const captureAt = dv.getFloat64(8, true);
  const width = dv.getUint16(16, true);
  const height = dv.getUint16(18, true);
  const count = dv.getUint16(20, true);
  const flags = dv.getUint16(22, true);
  if (count < 1 || dv.byteLength < HEADER_BYTES + count * 6) return null;

  const landmarks = new Array(count);
  let o = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    landmarks[i] = {
      x: dv.getUint16(o, true) / 65535,
      y: dv.getUint16(o + 2, true) / 65535,
      z: dv.getInt16(o + 4, true) / 32767,
    };
    o += 6;
  }
  let blink = null;
  if ((flags & 1) && dv.byteLength >= o + 2) {
    blink = [dv.getUint8(o) / 255, dv.getUint8(o + 1) / 255];
  }
  return { seq, captureAt, width, height, landmarks, blink, bytes: dv.byteLength };
}

/**
 * 还原成 MediaPipe 的 result 形状，直接喂给 vision.js 的 analyzeFace()。
 * 只回填我们用到的 4 个 blendshape（眨眼），避免依赖 52 类的顺序。
 */
export function toResult(packet) {
  const result = { faceLandmarks: [packet.landmarks] };
  if (packet.blink) {
    result.faceBlendshapes = [{
      categories: [
        { categoryName: 'eyeBlinkLeft', score: packet.blink[0] },
        { categoryName: 'eyeBlinkRight', score: packet.blink[1] },
      ],
    }];
  }
  return result;
}

/* ---------------- base64（SSE 用） ---------------- */

export function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(out);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

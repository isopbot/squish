'use strict';

/**
 * JPEG 无损优化：只重排/丢弃 APPn、COM 等元数据段，扫描数据（像素）一个字节都不动。
 * 这是真正意义上的「无损」——等价于 jpegtran 的 -copy none。
 *
 * 特例：若 EXIF 里的 Orientation 不是 1（需要旋转才能正确显示），保留该 APP1 段，
 * 否则用户会看到图片被转错方向。这时仍然丢弃 ICC/IPTC/XMP/缩略图等其余段。
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;

function readOrientation(exifPayload) {
  if (exifPayload.length < 14) return 0;
  if (exifPayload.toString('latin1', 0, 6) !== 'Exif\0\0') return 0;
  const tiff = exifPayload.subarray(6);
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  try {
    if (u16(2) !== 42) return 0;
    const ifd = u32(4);
    if (ifd + 2 > tiff.length) return 0;
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
  } catch {
    return 0;
  }
  return 0;
}

/**
 * @param {Buffer} buf 原始 JPEG
 * @param {{keepIcc?: boolean}} opts
 * @returns {{buffer: Buffer, removed: number, orientation: number}}
 */
function stripJpegMetadata(buf, opts = {}) {
  const keepIcc = Boolean(opts.keepIcc);
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) {
    throw new Error('不是有效的 JPEG 数据');
  }

  const parts = [buf.subarray(0, 2)];
  let i = 2;
  let removed = 0;
  let orientation = 0;
  let finished = false;

  while (i < buf.length) {
    if (buf[i] !== 0xff) return { buffer: buf, removed: 0, orientation };

    const marker = buf[i + 1];

    // 填充字节
    if (marker === 0xff) { i += 1; continue; }

    // 无长度字段的标记
    if (marker === SOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === EOI) {
      parts.push(buf.subarray(i, i + 2));
      finished = true;
      break;
    }
    // 任何非法/异常标记，直接放弃优化
    if (marker === 0x00 || marker === 0xd8) return { buffer: buf, removed: 0, orientation };

    if (i + 4 > buf.length) return { buffer: buf, removed: 0, orientation };
    const len = buf.readUInt16BE(i + 2);
    const segEnd = i + 2 + len;
    if (len < 2 || segEnd > buf.length) return { buffer: buf, removed: 0, orientation };

    // 扫描数据起到文件尾原样保留（含后续扫描与 EOI）
    if (marker === SOS) {
      parts.push(buf.subarray(i));
      finished = true;
      break;
    }

    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isCom = marker === 0xfe;
    if (marker === 0xe1) {
      const o = readOrientation(buf.subarray(i + 4, segEnd));
      if (o) orientation = o;
    }

    let drop = false;
    if (isCom) drop = true;
    else if (isApp) {
      if (marker === 0xe0) drop = false; // JFIF 头保留（极小且兼容性相关）
      else if (marker === 0xe1) drop = orientation <= 1; // 需要旋转时保留 EXIF
      else drop = !keepIcc; // ICC / IPTC / XMP / Adobe 等
    }

    if (drop) removed += segEnd - i;
    else parts.push(buf.subarray(i, segEnd));

    i = segEnd;
  }

  if (!finished) return { buffer: buf, removed: 0, orientation };

  const out = Buffer.concat(parts);
  if (out.length >= buf.length) return { buffer: buf, removed: 0, orientation };
  return { buffer: out, removed, orientation };
}

module.exports = { stripJpegMetadata, readOrientation };

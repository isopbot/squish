'use strict';

/**
 * 极简 BMP 解码器（libvips/sharp 不支持读取 BMP，这里补上）。
 * 支持：24/32/16 位真彩、8/4/1 位调色板，BI_RGB / BI_BITFIELDS；不支持 RLE 压缩。
 * 返回 { data: RGBA Buffer, width, height }。
 */
function decodeBmp(buf) {
  if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    throw new Error('不是有效的 BMP 文件');
  }

  const dataOffset = buf.readUInt32LE(10);
  const dibSize = buf.readUInt32LE(14);
  let width;
  let height;
  let bpp;
  let compression = 0;
  let paletteCount = 0;
  let paletteEntrySize = 4;

  if (dibSize === 12) {
    // BITMAPCOREHEADER
    width = buf.readInt16LE(18);
    height = buf.readInt16LE(20);
    bpp = buf.readUInt16LE(24);
    paletteEntrySize = 3;
  } else if (dibSize >= 40) {
    width = buf.readInt32LE(18);
    height = buf.readInt32LE(22);
    bpp = buf.readUInt16LE(28);
    compression = buf.readUInt32LE(30);
    paletteCount = buf.readUInt32LE(46) || 0;
  } else {
    throw new Error('不支持的 BMP 头格式');
  }

  if (compression !== 0 && compression !== 3) {
    throw new Error('不支持 RLE 压缩的 BMP');
  }
  if (!width || !height) throw new Error('BMP 尺寸无效');

  const topDown = height < 0;
  if (topDown) height = -height;
  if (width > 50000 || height > 50000) throw new Error('BMP 尺寸超出限制');

  const paletteStart = 14 + dibSize;
  const paletteLen = bpp <= 8 ? (paletteCount || 1 << bpp) : 0;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const out = Buffer.alloc(width * height * 4, 255);

  let hasAlpha = false;

  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    const rowStart = dataOffset + srcY * stride;
    if (rowStart + Math.ceil((bpp * width) / 8) > buf.length) throw new Error('BMP 数据不完整');

    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (bpp === 32) {
        const p = rowStart + x * 4;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2]; a = buf[p + 3];
        if (a !== 0 && a !== 255) hasAlpha = true;
      } else if (bpp === 24) {
        const p = rowStart + x * 3;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else if (bpp === 16) {
        const p = rowStart + x * 2;
        const v = buf.readUInt16LE(p);
        r = ((v >> 10) & 0x1f) * 255 / 31;
        g = ((v >> 5) & 0x1f) * 255 / 31;
        b = (v & 0x1f) * 255 / 31;
      } else if (bpp === 8 || bpp === 4 || bpp === 1) {
        let idx;
        if (bpp === 8) idx = buf[rowStart + x];
        else if (bpp === 4) {
          const byte = buf[rowStart + (x >> 1)];
          idx = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
        } else {
          const byte = buf[rowStart + (x >> 3)];
          idx = (byte >> (7 - (x % 8))) & 1;
        }
        if (idx >= paletteLen) idx = 0;
        const po = paletteStart + idx * paletteEntrySize;
        if (po + 2 < buf.length) {
          b = buf[po]; g = buf[po + 1]; r = buf[po + 2];
        }
      } else {
        throw new Error(`不支持的 BMP 位深：${bpp}`);
      }

      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }

  if (!hasAlpha) {
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
  }

  return { data: out, width, height };
}

module.exports = { decodeBmp };

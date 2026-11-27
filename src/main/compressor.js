'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { FORMAT_BY_EXT, EXT_BY_FORMAT } = require('./formats');
const { decodeBmp } = require('./bmp');
const { stripJpegMetadata } = require('./jpeglossless');

sharp.concurrency(Math.max(2, Math.min(6, os.cpus().length - 1 || 2)));
sharp.cache({ memory: 64, files: 40, items: 200 });

/** 智能模式的强度预设（按目标格式分别给质量） */
const LEVELS = {
  1: { jpeg: 88, webp: 90, avif: 66, png: 92 },
  2: { jpeg: 78, webp: 82, avif: 55, png: 82 },
  3: { jpeg: 62, webp: 68, avif: 42, png: 68 },
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function qualityFor(fmt, opts) {
  if (opts.mode === 'lossless') return 100;
  if (opts.mode === 'custom') {
    const q = clamp(Math.round(Number(opts.quality) || 78), 1, 100);
    if (fmt === 'avif') return clamp(Math.round(q * 0.68), 8, 100);
    if (fmt === 'webp') return clamp(q + 5, 1, 100);
    return q;
  }
  const lv = LEVELS[opts.level] || LEVELS[2];
  return lv[fmt] ?? 80;
}

/** 源扩展名 + 目标格式 -> 实际输出格式 */
function resolveTargetFormat(inputExt, targetFormat) {
  const want = (targetFormat || 'keep').toLowerCase();
  if (want !== 'keep') return want;
  const src = FORMAT_BY_EXT[inputExt] || 'jpeg';
  if (src === 'bmp') return 'png';        // sharp 无法写 BMP
  if (src === 'heic' || src === 'heif') return 'jpeg';
  if (src === 'svg') return 'svg';
  return src;
}

/** 输出文件扩展名（含前导点） */
function outputExtFor(inputExt, targetFormat) {
  const fmt = resolveTargetFormat(inputExt, targetFormat);
  if (fmt === 'svg') return '.svg';
  return EXT_BY_FORMAT[fmt] || inputExt;
}

function formatOptions(fmt, opts) {
  const lossless = opts.mode === 'lossless';
  const q = qualityFor(fmt, opts);
  switch (fmt) {
    case 'jpeg':
      return lossless
        ? { quality: 100, mozjpeg: true, chromaSubsampling: '4:4:4', progressive: true }
        : {
            quality: q,
            mozjpeg: true,
            chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0',
            progressive: true,
          };
    case 'png':
      return lossless
        ? { compressionLevel: 9, effort: 8, palette: false, adaptiveFiltering: true, force: true }
        : {
            compressionLevel: 9,
            effort: 8,
            palette: true,
            quality: q,
            colours: opts.mode === 'custom' ? 256 : opts.level === 3 ? 128 : 256,
            dither: 1,
            force: true,
          };
    case 'webp':
      return lossless
        ? { lossless: true, effort: 6, smartSubsample: false }
        : { quality: q, effort: 5, smartSubsample: true, alphaQuality: clamp(q + 15, 1, 100) };
    case 'avif':
      return lossless
        ? { lossless: true, effort: 6 }
        : { quality: q, effort: 5, chromaSubsampling: '4:2:0' };
    case 'tiff':
      return lossless
        ? { compression: 'deflate', predictor: 'horizontal', xres: 72, yres: 72 }
        : { compression: 'jpeg', quality: q, predictor: 'horizontal', xres: 72, yres: 72 };
    case 'gif':
      return { effort: 7, colours: 256, dither: 1, reuse: true };
    default:
      return {};
  }
}

let _svgo = null;
async function svgo() {
  if (!_svgo) {
    try {
      _svgo = require('svgo');
    } catch {
      const mod = await import('svgo');
      _svgo = mod.optimize ? mod : mod.default;
    }
  }
  return _svgo;
}

/**
 * 把一张图片压缩成 Buffer。
 * @param {string} input 绝对路径
 * @param {object} opts 见 README / 渲染层设置
 * @returns {Promise<{buffer:Buffer,sizeIn:number,width:number,height:number,format:string,note:string,lossless:boolean}>}
 */
async function compressToBuffer(input, opts = {}) {
  const stat = await fs.stat(input);
  const sizeIn = stat.size;
  const ext = path.extname(input).toLowerCase();
  const srcFmt = FORMAT_BY_EXT[ext] || 'jpeg';
  const target = resolveTargetFormat(ext, opts.targetFormat);
  let note = '';

  if (srcFmt === 'heic' || srcFmt === 'heif') {
    throw new Error('暂不支持 HEIC/HEIF 解码（受 HEVC 授权限制），可先导出为 JPEG');
  }

  // ---------- SVG：保持矢量 -> 用 svgo 精简 ----------
  if (srcFmt === 'svg' && target === 'svg') {
    const raw = await fs.readFile(input, 'utf8');
    const { optimize } = await svgo();
    let data;
    try {
      data = optimize(raw, { multipass: true, floatPrecision: 3 }).data;
    } catch {
      throw new Error('SVG 解析失败');
    }
    const buffer = Buffer.from(data, 'utf8');
    return { buffer, sizeIn, width: 0, height: 0, format: 'svg', note: '矢量精简', lossless: true };
  }

  // ---------- 已是有损编码的格式：无损模式下重编码只会变大，直接跳过 ----------
  if (
    opts.mode === 'lossless' &&
    target === srcFmt &&
    !opts.maxWidth &&
    !opts.maxHeight &&
    ['webp', 'avif', 'gif'].includes(srcFmt)
  ) {
    return {
      buffer: null,
      skip: true,
      sizeIn,
      width: 0,
      height: 0,
      format: srcFmt,
      note: `${srcFmt.toUpperCase()} 已是高效有损编码，无损模式无收益`,
      lossless: true,
    };
  }

  // ---------- JPEG 真无损：只删元数据段 ----------
  if (
    opts.mode === 'lossless' &&
    (srcFmt === 'jpeg') &&
    target === 'jpeg' &&
    !opts.maxWidth &&
    !opts.maxHeight
  ) {
    const raw = await fs.readFile(input);
    const { buffer, removed } = stripJpegMetadata(raw, { keepIcc: Boolean(opts.keepMetadata) });
    return {
      buffer,
      sizeIn,
      width: 0,
      height: 0,
      format: 'jpeg',
      note: removed > 0 ? `无损剥离元数据 ${(removed / 1024).toFixed(0)} KB（像素零改动）` : '已是最优，无需处理',
      lossless: true,
    };
  }

  // ---------- 通用管线 ----------
  let img;
  let hasAlpha = false;
  let isAnimated = false;

  if (srcFmt === 'bmp') {
    const raw = await fs.readFile(input);
    const bmp = decodeBmp(raw);
    img = sharp(bmp.data, {
      raw: { width: bmp.width, height: bmp.height, channels: 4 },
      limitInputPixels: false,
    });
    hasAlpha = true;
    note = 'BMP 转码';
  } else {
    const isSvg = srcFmt === 'svg';
    const meta = await sharp(input, { limitInputPixels: false, failOn: 'none', density: isSvg ? 144 : 72 }).metadata();
    hasAlpha = Boolean(meta.hasAlpha);
    isAnimated = (meta.pages || 1) > 1;

    const keepAnimation = target === 'gif' || target === 'webp';
    if (isAnimated && !keepAnimation) {
      note = '多帧图已保留第 1 帧';
    }
    img = sharp(input, {
      limitInputPixels: false,
      failOn: 'none',
      density: isSvg ? 144 : 72,
      animated: isAnimated && keepAnimation,
    });
  }

  img = img.rotate();

  if (opts.maxWidth || opts.maxHeight) {
    img = img.resize({
      width: Number(opts.maxWidth) || null,
      height: Number(opts.maxHeight) || null,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  if (target === 'jpeg' && hasAlpha) {
    img = img.flatten({ background: '#ffffff' });
  }

  if (opts.keepMetadata) img = img.withMetadata();

  const { data, info } = await img
    .toFormat(target === 'svg' ? 'png' : target, formatOptions(target, opts))
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    sizeIn,
    width: info.width || 0,
    height: info.height || 0,
    format: target,
    note: isAnimated && target === 'gif' ? '动态图已优化' : note,
    lossless: opts.mode === 'lossless' && target !== 'gif' && target !== 'jpeg',
  };
}

/** 缩略图 dataURL（失败返回 null） */
async function makeThumb(input, size = 64) {
  try {
    const buf = await sharp(input, { failOn: 'none', limitInputPixels: false })
      .rotate()
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .webp({ quality: 72 })
      .toBuffer();
    return `data:image/webp;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

module.exports = {
  compressToBuffer,
  makeThumb,
  outputExtFor,
  resolveTargetFormat,
  qualityFor,
};

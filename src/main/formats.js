'use strict';

/** 支持读取的图片扩展名（小写、带点） */
const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif',
  '.png', '.webp', '.avif',
  '.gif', '.tif', '.tiff',
  '.svg', '.bmp',
  '.heic', '.heif',
]);

/** 扩展名 -> 内部格式标识 */
const FORMAT_BY_EXT = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.jpe': 'jpeg', '.jfif': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.avif': 'avif',
  '.gif': 'gif',
  '.tif': 'tiff', '.tiff': 'tiff',
  '.svg': 'svg',
  '.bmp': 'bmp',
  '.heic': 'heic', '.heif': 'heif',
};

/** 内部格式 -> 优先扩展名 */
const EXT_BY_FORMAT = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  gif: '.gif',
  tiff: '.tif',
  svg: '.svg',
  bmp: '.bmp',
};

/** 可选择的输出格式 */
const OUTPUT_FORMATS = ['keep', 'jpeg', 'png', 'webp', 'avif'];

function isImagePath(p) {
  return IMAGE_EXTS.has(require('node:path').extname(String(p)).toLowerCase());
}

function extForFormat(fmt) {
  return EXT_BY_FORMAT[fmt] || '.jpg';
}

module.exports = {
  IMAGE_EXTS,
  FORMAT_BY_EXT,
  EXT_BY_FORMAT,
  OUTPUT_FORMATS,
  isImagePath,
  extForFormat,
};

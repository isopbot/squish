'use strict';

/**
 * 引擎自测：生成样本图片，跑各模式压缩，校验压缩率与「无损」真实性。
 * 运行：npm run test:engine
 */

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const { compressToBuffer } = require('../src/main/compressor');
const { stripJpegMetadata } = require('../src/main/jpeglossless');

const OUT = path.join(__dirname, '..', '.samples');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** CI 里靠它判定成败：无损被破坏、或压缩后反而变大，都算失败 */
const failures = [];

async function hashPixels(file) {
  const { data, info } = await sharp(file, { limitInputPixels: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    hash: crypto.createHash('sha1').update(data).digest('hex').slice(0, 12),
    w: info.width,
    h: info.height,
  };
}

async function makeSamples() {
  await fs.mkdir(OUT, { recursive: true });

  // 1. 模拟照片：渐变 + 噪点
  const noise = Buffer.alloc(2400 * 1600 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 255) | 0;
  const noiseImg = sharp(noise, { raw: { width: 2400, height: 1600, channels: 3 } }).blur(1.2);
  const grad = Buffer.alloc(2400 * 1600 * 3);
  for (let y = 0; y < 1600; y++) {
    for (let x = 0; x < 2400; x++) {
      const o = (y * 2400 + x) * 3;
      grad[o] = (x / 2400) * 210 + 20;
      grad[o + 1] = (y / 1600) * 190 + 30;
      grad[o + 2] = 120 + 80 * Math.sin(x / 180);
    }
  }
  const blend = await sharp(grad, { raw: { width: 2400, height: 1600, channels: 3 } })
    .composite([{ input: await noiseImg.png().toBuffer(), blend: 'overlay', opacity: 0.45 }])
    .jpeg({ quality: 92 })
    .toBuffer();
  await fs.writeFile(path.join(OUT, 'photo.jpg'), blend);

  // 2. 带 alpha 的截屏类 PNG
  const png = await sharp({
    create: { width: 1600, height: 1100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([
      { input: Buffer.from(`<svg width="1600" height="1100"><rect x="60" y="60" width="700" height="420" rx="24" fill="#12b886" opacity="0.85"/><circle cx="1100" cy="600" r="240" fill="#0f9d77" opacity="0.55"/><text x="90" y="700" font-size="64" fill="#20303a">Squish Sample</text></svg>`) },
    ])
    .png()
    .toBuffer();
  await fs.writeFile(path.join(OUT, 'shot.png'), png);

  // 3. WebP / GIF / TIFF / BMP / SVG
  await sharp(blend).resize(1200).webp({ quality: 88 }).toFile(path.join(OUT, 'pic.webp'));
  await sharp(blend).resize(640).gif().toFile(path.join(OUT, 'pic.gif'));
  await sharp(blend).resize(1200).tiff().toFile(path.join(OUT, 'pic.tif'));
  await sharp(blend).resize(800).png().toFile(path.join(OUT, 'pic.png'));

  // 手写一个 24 位未压缩 BMP
  const w = 800;
  const h = 600;
  const rowSize = Math.floor((24 * w + 31) / 32) * 4;
  const bmp = Buffer.alloc(54 + rowSize * h);
  bmp.write('BM', 0);
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(w, 18);
  bmp.writeInt32LE(h, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(0, 30);
  bmp.writeUInt32LE(rowSize * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = 54 + (h - 1 - y) * rowSize + x * 3;
      bmp[o] = (x * 255 / w) | 0;
      bmp[o + 1] = (y * 255 / h) | 0;
      bmp[o + 2] = 140;
    }
  }
  await fs.writeFile(path.join(OUT, 'pic.bmp'), bmp);

  await fs.writeFile(path.join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <!-- 注释：会被 svgo 去掉 -->
    <g>
      <rect width="512" height="512" rx="112" fill="#0f9d77"/>
      <path d="M256 140v90M256 140l-42 42M256 140l42 42" stroke="#fff" stroke-width="26" stroke-linecap="round" fill="none"/>
      <path d="M256 372v-90M256 372l-42-42M256 372l42-42" stroke="#fff" stroke-width="26" stroke-linecap="round" fill="none"/>
    </g>
  </svg>`);

  return OUT;
}

async function run(label, opts, files) {
  console.log(`\n=== ${label} ===`);
  for (const file of files) {
    const name = path.basename(file);
    const before = (await fs.stat(file)).size;
    try {
      const res = await compressToBuffer(file, opts);
      if (res.skip) {
        console.log(`${name.padEnd(10)} ${kb(before).padStart(10)} →     跳过      ${''.padStart(7)}  ${res.format.padEnd(5)} ${res.note || ''}`);
        continue;
      }
      const after = res.buffer.length;
      const pct = ((1 - after / before) * 100).toFixed(1);
      const outFile = path.join(OUT, `out-${label}-${name}`);
      await fs.writeFile(outFile, res.buffer);

      let losslessFlag = '';
      const isBmp = path.extname(file).toLowerCase() === '.bmp';
      if (opts.mode === 'lossless' && res.format === 'svg') losslessFlag = '矢量';
      else if (opts.mode === 'lossless' && !isBmp && ['png', 'webp', 'avif', 'tiff'].includes(res.format)) {
        const a = await hashPixels(file);
        const b = await hashPixels(outFile);
        const same = a.hash === b.hash && a.w === b.w;
        losslessFlag = same ? '像素一致 ✓' : `像素变化 ✗ (${a.hash}→${b.hash})`;
        if (!same) failures.push(`${label}/${name}: 无损重编码后像素变化`);
      } else if (opts.mode === 'lossless' && res.format === 'jpeg') {
        const a = await hashPixels(file);
        const b = await hashPixels(outFile);
        losslessFlag = a.hash === b.hash ? '像素一致 ✓' : '像素变化 ✗';
        if (a.hash !== b.hash) failures.push(`${label}/${name}: 无损 JPEG 像素变化`);
      } else if (opts.mode === 'smart' && label === 'smart-2' && ['jpeg', 'png'].includes(res.format) && after >= before) {
        failures.push(`${label}/${name}: 智能模式下没有变小（${kb(before)} → ${kb(after)}）`);
      }
      console.log(
        `${name.padEnd(10)} ${kb(before).padStart(10)} → ${kb(after).padStart(10)}  ${(pct + '%').padStart(7)}  ${res.format.padEnd(5)} ${losslessFlag} ${res.note || ''}`
      );
    } catch (err) {
      console.log(`${name.padEnd(10)} 失败：${err.message}`);
      failures.push(`${label}/${name}: 压缩抛错 ${err.message}`);
    }
  }
}

(async () => {
  await makeSamples();
  const files = ['photo.jpg', 'shot.png', 'pic.webp', 'pic.gif', 'pic.tif', 'pic.bmp', 'icon.svg'].map((f) =>
    path.join(OUT, f)
  );

  await run('smart-2', { mode: 'smart', level: 2, targetFormat: 'keep' }, files);
  await run('lossless', { mode: 'lossless', targetFormat: 'keep' }, files);
  await run('to-webp', { mode: 'smart', level: 2, targetFormat: 'webp' }, files);
  await run('limit-1600', { mode: 'smart', level: 2, targetFormat: 'keep', maxWidth: 1600, maxHeight: 1600 }, files);

  // JPEG 元数据无损剥离：人为插入 COM + 假 EXIF
  console.log('\n=== jpeg 元数据剥离 ===');
  const jpg = await fs.readFile(path.join(OUT, 'photo.jpg'));
  const junk = Buffer.alloc(4000, 0x20);
  const comSeg = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([(junk.length + 2) >> 8, (junk.length + 2) & 0xff]), junk]);
  const withMeta = Buffer.concat([jpg.subarray(0, 2), comSeg, jpg.subarray(2)]);
  const stripped = stripJpegMetadata(withMeta);
  const a = await hashPixels(path.join(OUT, 'photo.jpg'));
  const tmpJpg = path.join(OUT, 'stripped.jpg');
  await fs.writeFile(tmpJpg, stripped.buffer);
  const b = await hashPixels(tmpJpg);
  const stripOk = a.hash === b.hash;
  console.log(
    `插入 ${kb(withMeta.length)} → 剥离后 ${kb(stripped.buffer.length)}，移除 ${stripped.removed} 字节，像素${stripOk ? '一致 ✓' : '变化 ✗'}`
  );
  if (!stripOk) failures.push('JPEG 元数据剥离改变了像素');
  if (stripped.removed <= 0) failures.push('JPEG 元数据剥离没有移除任何字节');

  console.log(`\n输出目录：${OUT}`);

  if (failures.length) {
    console.error(`\n✗ 自测失败 ${failures.length} 项：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✓ 全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

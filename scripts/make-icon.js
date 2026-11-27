'use strict';

/** 生成应用图标：build/icon.png (1024) + build/icon.ico 由 electron-builder 自动转换 */
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#3ee0ae"/>
      <stop offset="0.55" stop-color="#12b58c"/>
      <stop offset="1" stop-color="#068a72"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="22" flood-color="#04614f" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="92" y="92" width="840" height="840" rx="196" fill="url(#bg)" filter="url(#soft)"/>
  <rect x="92" y="92" width="840" height="840" rx="196" fill="url(#gloss)"/>
  <g stroke="#ffffff" stroke-width="52" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M512 296v152M512 296l-72 74M512 296l72 74"/>
    <path d="M512 728V576M512 728l-72-74M512 728l72-74"/>
  </g>
  <rect x="392" y="492" width="240" height="40" rx="20" fill="#ffffff" opacity="0.9"/>
</svg>`;

(async () => {
  const dir = path.join(__dirname, '..', 'build');
  await fs.mkdir(dir, { recursive: true });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  await fs.writeFile(path.join(dir, 'icon.png'), png);
  await fs.writeFile(path.join(dir, 'icon.svg'), svg);
  // 附带 512 版本，Windows 构建与商店素材常用
  await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(path.join(dir, 'icon-512.png'));
  console.log('图标已生成：build/icon.png');
})();

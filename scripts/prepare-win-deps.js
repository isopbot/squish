'use strict';

/**
 * 在 macOS / Linux 上交叉打 Windows 包时，sharp 默认只装了本机平台的二进制，
 * Windows 用户装上会启动即报错。这个脚本把 Windows 版 sharp 原生依赖补进 node_modules。
 * 在 Windows 上打包不需要它（npm install 会自动选对平台）。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PKGS = [
  ['@img/sharp-win32-x64', '0.33.5'],
  ['@img/sharp-libvips-win32-x64', '1.0.6'],
];

const imgDir = path.join(__dirname, '..', 'node_modules', '@img');

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.log('当前平台无需补装 Windows 依赖，跳过。');
  process.exit(0);
}

fs.mkdirSync(imgDir, { recursive: true });

for (const [name, version] of PKGS) {
  const target = path.join(imgDir, name.split('/')[1]);
  if (fs.existsSync(target)) {
    console.log(`已存在 ${name}，跳过`);
    continue;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-win-'));
  console.log(`下载 ${name}@${version} ...`);
  const tgz = execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], {
    cwd: tmp,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop();
  execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp]);
  fs.renameSync(path.join(tmp, 'package'), target);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`已安装 ${name} -> ${target}`);
}

console.log('完成，可以执行 electron-builder --win 了。');

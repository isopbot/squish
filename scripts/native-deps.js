'use strict';

/**
 * sharp 的原生依赖（@img/sharp-<platform>-<arch> + @img/sharp-libvips-<platform>-<arch>）
 * 默认只会装当前机器那一份。交叉打包时如果不对，打出来的包在目标机器上一启动就崩
 * （典型症状：Intel dmg 里装着 arm64 的 .node，或者 mac 包里塞着 Windows 版）。
 *
 *   node scripts/native-deps.js ensure darwin x64   # 缺什么补什么（npm pack + 解压，绕过 npm 的平台校验）
 *   node scripts/native-deps.js prune  darwin x64   # 删掉其它平台的 @img 目录，只留目标平台
 *   node scripts/native-deps.js status              # 看看现在装了哪些
 *
 * 打包脚本里成对使用：ensure 目标平台 → prune 目标平台 → electron-builder。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'node_modules', '@img');
const PKG_PREFIXES = ['sharp-', 'sharp-libvips-'];

/** 从 sharp 的 optionalDependencies 里读出版本，避免版本号写死在脚本里 */
function resolveVersions() {
  const sharpPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'sharp', 'package.json'), 'utf8'));
  const optional = sharpPkg.optionalDependencies || {};
  return (platform, arch) => {
    const sharpName = `@img/sharp-${platform}-${arch}`;
    const vipsName = `@img/sharp-libvips-${platform}-${arch}`;
    return [
      [sharpName, optional[sharpName]],
      [vipsName, optional[vipsName]],
    ].filter(([, v]) => Boolean(v));
  };
}

function listInstalled() {
  if (!fs.existsSync(IMG_DIR)) return [];
  return fs
    .readdirSync(IMG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && PKG_PREFIXES.some((p) => d.name.startsWith(p)))
    .map((d) => d.name);
}

function ensure(platform, arch) {
  if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
  const lookup = resolveVersions();
  const pkgs = lookup(platform, arch);
  if (!pkgs.length) {
    throw new Error(`sharp 的 optionalDependencies 里没有 ${platform}-${arch}，无法交叉打包`);
  }
  for (const [name, version] of pkgs) {
    const target = path.join(IMG_DIR, name.split('/')[1]);
    if (fs.existsSync(target)) {
      console.log(`已存在 ${name}@${version}，跳过`);
      continue;
    }
    console.log(`下载 ${name}@${version} ...`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-native-'));
    const tgz = execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], { cwd: tmp, encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop();
    execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp]);
    fs.renameSync(path.join(tmp, 'package'), target);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`  → ${path.relative(ROOT, target)}`);
  }
}

function prune(platform, arch) {
  const keep = [`sharp-${platform}-${arch}`, `sharp-libvips-${platform}-${arch}`];
  const removed = [];
  for (const dir of listInstalled()) {
    if (keep.includes(dir)) continue;
    fs.rmSync(path.join(IMG_DIR, dir), { recursive: true, force: true });
    removed.push(dir);
  }
  console.log(removed.length ? `已移除其它平台：${removed.join(', ')}` : '没有需要移除的平台目录');
  console.log(`保留：${keep.filter((k) => fs.existsSync(path.join(IMG_DIR, k))).join(', ') || '（无）'}`);
}

function status() {
  const dirs = listInstalled();
  console.log(`本机：${process.platform}-${process.arch}`);
  if (!dirs.length) return console.log('@img 下没有任何 sharp 原生依赖');
  for (const d of dirs) {
    const pkg = path.join(IMG_DIR, d, 'package.json');
    const version = fs.existsSync(pkg) ? JSON.parse(fs.readFileSync(pkg, 'utf8')).version : '?';
    console.log(`  ${d.padEnd(30)} ${version}`);
  }
}

const [cmd, platform, arch] = process.argv.slice(2);
if (cmd === 'status') {
  status();
} else if (cmd === 'ensure' || cmd === 'prune') {
  if (!platform || !arch) {
    console.error('用法：node scripts/native-deps.js ensure|prune <platform> <arch>，例如 darwin arm64 / win32 x64');
    process.exit(1);
  }
  if (cmd === 'ensure') ensure(platform, arch);
  else prune(platform, arch);
} else {
  console.error('用法：node scripts/native-deps.js ensure|prune <platform> <arch> | status');
  process.exit(1);
}

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isImagePath } = require('./formats');

const MAX_FILES = 20000;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'Library',
  '$RECYCLE.BIN', 'System Volume Information', '.Trash', '.Spotlight-V100',
]);

/**
 * 扫描文件/文件夹，返回可选中的图片列表。
 * @param {string[]} inputs 绝对路径（文件或文件夹）
 * @param {{recursive?: boolean, exclude?: string[]}} opts
 */
async function scanPaths(inputs, opts = {}) {
  const recursive = opts.recursive !== false;
  const excludes = (opts.exclude || []).filter(Boolean).map((p) => path.resolve(p) + path.sep);
  const seen = new Set();
  const items = [];
  let truncated = false;
  let dirs = 0;

  const add = (abs, rel, root, size) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    items.push({
      id: abs,
      path: abs,
      name: path.basename(abs),
      rel,
      root,
      size,
      ext: path.extname(abs).toLowerCase(),
    });
  };

  for (const input of inputs) {
    if (items.length >= MAX_FILES) { truncated = true; break; }
    const abs = path.resolve(input);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      const root = abs;
      const stack = [abs];
      while (stack.length && items.length < MAX_FILES) {
        const dir = stack.pop();
        dirs++;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (!recursive) continue;
            if (ent.name.startsWith('.')) continue;
            if (SKIP_DIRS.has(ent.name)) continue;
            if (excludes.some((ex) => (full + path.sep).startsWith(ex))) continue;
            stack.push(full);
          } else if (ent.isFile() && isImagePath(ent.name)) {
            let fst;
            try {
              fst = await fs.stat(full);
            } catch {
              continue;
            }
            add(full, path.relative(root, full), root, fst.size);
            if (items.length >= MAX_FILES) break;
          }
        }
      }
    } else if (st.isFile() && isImagePath(abs)) {
      add(abs, path.basename(abs), path.dirname(abs), st.size);
    }
  }

  items.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  return { items, truncated, dirs };
}

module.exports = { scanPaths, MAX_FILES };

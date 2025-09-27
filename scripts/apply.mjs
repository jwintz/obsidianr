#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const vaultPath = process.env.OBSIDIANR_VAULT_PATH;

if (!vaultPath) {
  console.warn('[apply] OBSIDIANR_VAULT_PATH not set; skipping copy.');
  process.exit(0);
}

const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'obsidianr');

async function copyFile(srcName) {
  const src = path.join(rootDir, srcName);
  const dest = path.join(pluginDir, srcName);
  await fs.promises.copyFile(src, dest);
}

async function main() {
  try {
    await fs.promises.mkdir(pluginDir, { recursive: true });
    await Promise.all([
      copyFile('manifest.json'),
      copyFile('main.js'),
      copyFile('styles.css'),
      copyFile('versions.json'),
      copyFile('README.md')
    ]);
    console.log(`[apply] Copied plugin files into ${pluginDir}`);
  } catch (error) {
    console.error('[apply] Failed to copy plugin files:', error);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
import { build } from 'esbuild';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const isProduction = process.env.NODE_ENV === 'production';

const banner = `/* ObsidianR Reader v${pkg.version} */`;

async function runBuild() {
  try {
    await build({
      entryPoints: [path.join(rootDir, 'src', 'main.ts')],
      outfile: path.join(rootDir, 'main.js'),
      bundle: true,
      minify: isProduction,
      sourcemap: isProduction ? false : 'inline',
      format: 'cjs',
      target: ['chrome100', 'firefox100', 'safari15'],
      platform: 'browser',
      external: ['obsidian', '@codemirror/lang-*', '@codemirror/state', '@codemirror/view'],
      banner: {
        js: banner
      },
      logLevel: 'info',
      treeShaking: true
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

if (watch) {
  console.log('Building in watch mode...');
  await build({
    entryPoints: [path.join(rootDir, 'src', 'main.ts')],
    outfile: path.join(rootDir, 'main.js'),
    bundle: true,
    minify: false,
    sourcemap: 'inline',
    format: 'cjs',
    target: ['chrome100', 'firefox100', 'safari15'],
    platform: 'browser',
    external: ['obsidian', '@codemirror/lang-*', '@codemirror/state', '@codemirror/view'],
    banner: {
      js: banner
    },
    logLevel: 'info',
    treeShaking: true,
    watch: {
      onRebuild(error) {
        if (error) {
          console.error('Rebuild failed:', error);
        } else {
          console.log('Rebuild succeeded');
        }
      }
    }
  });
  console.log('Watching for changes...');
} else {
  await runBuild();
}

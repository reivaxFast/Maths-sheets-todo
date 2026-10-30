// Builds vendor/: the browser libraries the "Ask Claude" chat loads on first use.
// Run again after updating any of these packages:  node scripts/build-vendor.js
//
// - anthropic-sdk.js: the Anthropic SDK bundled into one script that sets window.Anthropic.
//   The app has no bundler, and the SDK's ES modules import other packages by name, which
//   browsers can't resolve.
// - marked.umd.js: formats Claude's answers (headings, lists, code).
// - katex/: renders maths written as $...$ / $$...$$ (with its woff2 fonts).
// - pdfjs.js: pdf.js, for reading the text of lecture notes so only the relevant pages are
//   sent. Its worker is bundled in and runs on the page (globalThis.pdfjsWorker), since
//   module workers don't load reliably from the desktop app's file:// pages.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'vendor');
const versionOf = pkg =>
  JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'katex', 'fonts'), { recursive: true });

esbuild.buildSync({
  stdin: {
    contents: "import Anthropic from '@anthropic-ai/sdk'; window.Anthropic = Anthropic;",
    resolveDir: root,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'eof',
  outfile: path.join(out, 'anthropic-sdk.js'),
});

esbuild.buildSync({
  stdin: {
    contents: [
      "import * as pdfjsLib from 'pdfjs-dist/build/pdf.min.mjs';",
      "import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs';",
      'globalThis.pdfjsWorker = pdfjsWorker;',
      'window.pdfjsLib = pdfjsLib;',
    ].join('\n'),
    resolveDir: root,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  outfile: path.join(out, 'pdfjs.js'),
});

fs.copyFileSync(path.join(root, 'node_modules/marked/lib/marked.umd.js'), path.join(out, 'marked.umd.js'));

const katex = path.join(root, 'node_modules/katex/dist');
fs.copyFileSync(path.join(katex, 'katex.min.js'), path.join(out, 'katex', 'katex.min.js'));
fs.copyFileSync(path.join(katex, 'katex.min.css'), path.join(out, 'katex', 'katex.min.css'));
// Only woff2: every browser the app runs in supports it, and it's the format the CSS lists first
for (const font of fs.readdirSync(path.join(katex, 'fonts')).filter(f => f.endsWith('.woff2'))) {
  fs.copyFileSync(path.join(katex, 'fonts', font), path.join(out, 'katex', 'fonts', font));
}

console.log(`Built vendor/: @anthropic-ai/sdk ${versionOf('@anthropic-ai/sdk')}, ` +
  `marked ${versionOf('marked')}, katex ${versionOf('katex')}, pdfjs-dist ${versionOf('pdfjs-dist')}`);

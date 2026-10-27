// Copies the app's web files into www/. Capacitor packages www/ into the Android app, and the
// same folder is what's published as the website (see .github/workflows/pages.yml).
// The desktop app doesn't use this: Electron loads the files from the project folder.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const files = [
  'index.html',
  'style.css',
  'script.js',
  'sync.js',
  'mobile.js',
  'web.js',
  'icon.png',
  // Website only: install details, icons and the offline service worker
  'manifest.webmanifest',
  'sw.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  // Kept at the same path, since index.html loads it from there
  'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
];

fs.rmSync(out, { recursive: true, force: true });
for (const file of files) {
  const target = path.join(out, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
console.log(`Copied ${files.length} files to www/`);

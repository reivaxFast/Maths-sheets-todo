// Copies the app's web files into www/, which Capacitor packages into the Android app.
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
  'icon.png',
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

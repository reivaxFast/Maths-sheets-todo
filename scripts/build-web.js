// Copies the app's web files into www/. Capacitor packages www/ into the Android app, and the
// same folder is what's published as the website (see .github/workflows/pages.yml).
// The desktop app doesn't use this: Electron loads the files from the project folder.
//
// `--android` leaves out the website-only scanner and OpenCV (11 MB), since the Android app
// uses Google's scanner instead.
const fs = require('fs');
const path = require('path');

const android = process.argv.includes('--android');
const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const files = [
  'index.html',
  'style.css',
  'script.js',
  'claude.js',
  'vendor/', // Folders end in /: copied whole (built by scripts/build-vendor.js)
  'sync.js',
  'mobile.js',
  'web.js',
  'icon.png',
  // Kept at the same paths, since the app loads them from there
  'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
  'node_modules/pdf-lib/dist/pdf-lib.min.js', // For "Draft as combined"
  // Website only: install details, icons and the offline service worker
  'manifest.webmanifest',
  'sw.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];
const websiteScanner = [
  'scanner.js',
  'node_modules/@techstark/opencv-js/dist/opencv.js',
];
if (!android) files.push(...websiteScanner);

fs.rmSync(out, { recursive: true, force: true });
for (const file of files) {
  const target = path.join(out, file);
  if (file.endsWith('/')) {
    fs.cpSync(path.join(root, file), target, { recursive: true });
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
console.log(`Copied ${files.length} files to www/${android ? ' (Android: no web scanner)' : ''}`);

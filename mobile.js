// In the Android app (Capacitor), provides the same `window.files` the desktop app gets from
// preload.js, using Android's own file handling. Does nothing on desktop or in a browser.
//
// The plugins are reached through Capacitor.Plugins, so no bundler is needed.

if (window.Capacitor?.isNativePlatform()) {
  const { App, CapacitorHttp, Filesystem, FileOpener, Share } = window.Capacitor.Plugins;

  const safeName = name => String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  // Files go in a fresh cache folder each time, so two with the same name don't clash
  async function writeCacheFile(name, base64) {
    const { uri } = await Filesystem.writeFile({
      path: `files-${Date.now()}/${safeName(name)}`,
      data: base64,
      directory: 'CACHE',
      recursive: true,
    });
    return uri;
  }

  window.files = {
    // Opens the PDF in whichever PDF viewer is installed
    async openPdf(name, data) {
      try {
        const uri = await writeCacheFile(name, arrayBufferToBase64(data));
        await FileOpener.open({ filePath: uri, contentType: 'application/pdf' });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    // Phones can't download straight to a folder, so exports go through the share sheet
    // (Save to Files, Drive, email, …)
    async saveExport(name, text) {
      try {
        const uri = await writeCacheFile(name, arrayBufferToBase64(new TextEncoder().encode(text)));
        await Share.share({ title: name, files: [uri] });
        return { ok: true };
      } catch (e) {
        // Closing the share sheet without picking anything isn't an error
        return { ok: /cancel/i.test(e?.message || '') };
      }
    },
    onImportFile() {},
  };

  // Updates come from the latest GitHub release: latest.yml (made by the desktop build) says
  // which version it is, and the APK beside it is named Worksheets-<version>.apk.
  // Requests go through Capacitor's native HTTP, since GitHub doesn't allow them from web pages.
  const RELEASES = 'https://github.com/reivaxFast/Maths-sheets-todo/releases';

  // True if version a (e.g. "1.10.0") is later than b
  function isNewer(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
  }

  let progressCallback = () => {};
  Filesystem.addListener('progress', ({ bytes, contentLength }) => {
    if (contentLength) progressCallback(Math.round((bytes / contentLength) * 100));
  });

  window.updates = {
    async check() {
      try {
        const { version: current } = await App.getInfo();
        const res = await CapacitorHttp.get({ url: `${RELEASES}/latest/download/latest.yml`, responseType: 'text' });
        const latest = res.status === 200 && /^version:\s*['"]?([\d.]+)/m.exec(res.data)?.[1];
        return latest && isNewer(latest, current) ? latest : null;
      } catch {
        return null; // Offline, or no release to compare with
      }
    },
    // Downloads the new APK and hands it to Android's installer, which asks the user to confirm.
    // The first time, Android also asks to allow installing apps from Worksheets.
    async install(version) {
      try {
        const path = `update-${version}.apk`;
        await Filesystem.downloadFile({
          url: `${RELEASES}/download/v${version}/Worksheets-${version}.apk`,
          path,
          directory: 'CACHE',
          progress: true,
        });
        const { uri } = await Filesystem.getUri({ path, directory: 'CACHE' });
        await FileOpener.open({ filePath: uri, contentType: 'application/vnd.android.package-archive' });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    onProgress(callback) {
      progressCallback = callback;
    },
  };

  // Android's file picker doesn't know .todo files and would grey them out
  document.getElementById('import-file').accept = '';
}

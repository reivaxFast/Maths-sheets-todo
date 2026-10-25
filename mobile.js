// In the Android app (Capacitor), provides the same `window.files` the desktop app gets from
// preload.js, using Android's own file handling. Does nothing on desktop or in a browser.
//
// The plugins are reached through Capacitor.Plugins, so no bundler is needed.

if (window.Capacitor?.isNativePlatform()) {
  const { Filesystem, FileOpener, Share } = window.Capacitor.Plugins;

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

  // Android's file picker doesn't know .todo files and would grey them out
  document.getElementById('import-file').accept = '';
}

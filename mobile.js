// In the Android app (Capacitor), provides the same `window.files` the desktop app gets from
// preload.js, using Android's own file handling. Does nothing on desktop or in a browser.
//
// The plugins are reached through Capacitor.Plugins, so no bundler is needed.

if (window.Capacitor?.isNativePlatform()) {
  const { App, CapacitorHttp, DocumentScanner, EmailComposer, Filesystem, FileOpener, Share } = window.Capacitor.Plugins;

  const safeName = name => String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function base64ToArrayBuffer(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Google's document scanner is a Play services module that some phones download on first use
  const SCANNER_INSTALL = { COMPLETED: 4, FAILED: 5, CANCELED: 3 };
  async function ensureScannerInstalled(onStatus) {
    const { available } = await DocumentScanner.isGoogleDocumentScannerModuleAvailable();
    if (available) return;
    onStatus('Downloading the document scanner…');
    await new Promise((resolve, reject) => {
      DocumentScanner.addListener('googleDocumentScannerModuleInstallProgress', ({ state }) => {
        if (state === SCANNER_INSTALL.COMPLETED) resolve();
        if (state === SCANNER_INSTALL.FAILED || state === SCANNER_INSTALL.CANCELED) {
          reject(new Error("The document scanner couldn't be downloaded. Check your connection and try again."));
        }
      });
      DocumentScanner.installGoogleDocumentScannerModule().catch(reject);
    }).finally(() => DocumentScanner.removeAllListeners());
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
    // Shares a PDF under the given name, e.g. a submission with its course's file name
    async sharePdf(name, data) {
      try {
        const uri = await writeCacheFile(name, arrayBufferToBase64(data));
        await Share.share({ title: name, files: [uri] });
        return { ok: true };
      } catch (e) {
        return { ok: /cancel/i.test(e?.message || '') };
      }
    },
    // Opens Google's document scanner (edge detection, cropping, cleanup) and returns the
    // pages as one PDF. Pages can also be picked from the photo gallery.
    async scanPdf(onStatus) {
      try {
        await ensureScannerInstalled(onStatus);
        const result = await DocumentScanner.scanDocument({
          galleryImportAllowed: true,
          pageLimit: 50,
          resultFormats: 'PDF',
          scannerMode: 'FULL',
        });
        if (!result.pdf) return { ok: false, cancelled: true };
        const { data } = await Filesystem.readFile({ path: result.pdf.uri });
        return { ok: true, data: base64ToArrayBuffer(data), pages: result.pdf.pageCount };
      } catch (e) {
        const message = e?.message || '';
        if (/cancel/i.test(message)) return { ok: false, cancelled: true };
        return { ok: false, error: /couldn't be downloaded/.test(message) ? message : null };
      }
    },
    // Opens the phone's email app with everything filled in. PDFs are written to the cache
    // first and attached by path, since large files can't be passed to it directly.
    async draftEmail({ to, subject, body, attachments }) {
      try {
        const files = [];
        for (const a of attachments) {
          const uri = await writeCacheFile(a.name, arrayBufferToBase64(a.data));
          files.push({ type: 'absolute', path: decodeURIComponent(uri.replace(/^file:\/\//, '')) });
        }
        await EmailComposer.open({ to: [to], subject, body, attachments: files });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    // Ask Claude (claude.js): uploads a PDF to the Anthropic Files API. Anthropic's /v1/files
    // doesn't accept requests from web pages, so it goes through Android's own networking.
    async claudeUpload({ apiKey, name, data }) {
      try {
        const res = await CapacitorHttp.request({
          url: 'https://api.anthropic.com/v1/files',
          method: 'POST',
          // Capacitor adds the multipart boundary; the type must be set for it to send a body
          headers: { 'Content-Type': 'multipart/form-data', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          dataType: 'formData',
          data: [{
            type: 'base64File',
            key: 'file',
            value: arrayBufferToBase64(data),
            fileName: safeName(name),
            contentType: 'application/pdf',
          }],
          responseType: 'json',
        });
        const body = typeof res.data === 'string' ? JSON.parse(res.data || '{}') : res.data || {};
        return res.status >= 200 && res.status < 300
          ? { ok: true, id: body.id }
          : { ok: false, status: res.status, message: body.error?.message };
      } catch {
        return { ok: false }; // No connection
      }
    },
    async claudeDelete({ apiKey, id }) {
      try {
        await CapacitorHttp.request({
          url: `https://api.anthropic.com/v1/files/${encodeURIComponent(id)}`,
          method: 'DELETE',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        });
      } catch {}
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

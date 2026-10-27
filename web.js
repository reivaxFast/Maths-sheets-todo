// On the website (a plain browser, not the desktop or Android app), provides `window.files`
// using what browsers can do, and registers the service worker so the site can be installed
// and opened offline. Does nothing in the apps, which bring their own `window.files`.

if (!window.files && !window.Capacitor?.isNativePlatform()) {
  const pdfFile = (name, data) => new File([data], name, { type: 'application/pdf' });

  // Phones can hand files to other apps through the share sheet; most computers can't
  let canShareFiles = false;
  try {
    canShareFiles = !!navigator.canShare?.({ files: [pdfFile('test.pdf', new Uint8Array(1))] });
  } catch {}

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  const shareCancelled = e => e?.name === 'AbortError';

  window.files = {
    // Opens in a new tab, where the browser's own PDF viewer shows it
    async openPdf(name, data) {
      const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
      const tab = window.open(url, '_blank');
      // Blocked pop-up, or a phone browser that can't show PDFs in a tab: download instead
      if (!tab) download(name, new Blob([data], { type: 'application/pdf' }));
      return { ok: true };
    },

    // Drafts an email:
    // - Phone: the share sheet, with the PDFs, subject and message, so they can go to the email
    //   app. Sharing can't fill in who it's to, so the tutor's address is copied to paste in.
    //   Without PDFs, a mailto: link fills in everything.
    // - Computer: downloads the draft as an .eml file. Opening it in Outlook (new or classic)
    //   gives a new email with the PDFs attached.
    async draftEmail({ to, subject, body, attachments, eml, toName }) {
      if (canShareFiles && attachments.length) {
        let copied = false;
        try {
          await navigator.clipboard.writeText(to);
          copied = true;
        } catch {}
        try {
          await navigator.share({ files: attachments.map(a => pdfFile(a.name, a.data)), title: subject, text: body });
          return { ok: true, mode: 'share', copied, to };
        } catch (e) {
          return shareCancelled(e) ? { ok: true, mode: 'cancelled' } : { ok: false };
        }
      }
      if (!attachments.length) {
        location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        return { ok: true, mode: 'mailto' };
      }
      download(`Email to ${toName.replace(/[<>:"/\\|?*]/g, '')}.eml`, new Blob([eml], { type: 'message/rfc822' }));
      return { ok: true, mode: 'download' };
    },

    onImportFile() {},
  };

  // Only phones get Share; computers keep the Save button, which downloads
  if (canShareFiles) {
    window.files.sharePdf = async (name, data) => {
      try {
        await navigator.share({ files: [pdfFile(name, data)], title: name });
        return { ok: true };
      } catch (e) {
        return { ok: shareCancelled(e) };
      }
    };
  }

  // Phones (touch screen with a camera API) get a Scan button. The scanner and OpenCV (about
  // 11 MB) only download the first time it's used, then the service worker keeps them.
  const isPhone = matchMedia('(pointer: coarse)').matches && !!navigator.mediaDevices?.getUserMedia;
  if (isPhone) {
    const loadScript = src => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
    let scannerLoaded = null;

    window.files.scanPdf = async onStatus => {
      try {
        if (!window.WebScanner) {
          onStatus('Loading the scanner… (the first time takes a little while)');
          scannerLoaded ||= Promise.all([
            loadScript('node_modules/@techstark/opencv-js/dist/opencv.js'),
            loadScript('scanner.js'),
          ]);
          await scannerLoaded;
        }
        return await window.WebScanner.scan();
      } catch {
        scannerLoaded = null;
        return { ok: false, error: "The scanner couldn't load. Check your connection and try again." };
      }
    };
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Document scanner for the website on phones (the Android app uses Google's scanner instead).
//
// Loaded by web.js the first time Scan is pressed, together with OpenCV.js. Steps:
//   1. Camera: a live view that outlines the page it finds
//   2. Corners: the photo with the page's corners, which can be dragged into place
//   3. Clean up: the straightened page in colour, greyscale or black and white
// Pages build up until Done, then become one PDF.
//
// window.WebScanner.scan() resolves to { ok: true, data: ArrayBuffer, pages } or
// { ok: false, cancelled: true }.

(() => {
  const DETECT_SIZE = 480;   // Longest side used for finding the page (smaller is faster)
  const PAGE_SIZE = 2200;    // Longest side of a saved page, in pixels
  const JPEG_QUALITY = 0.82;
  const LIVE_DETECT_MS = 300;
  const FILTERS = [
    { id: 'colour', label: 'Colour' },
    { id: 'grey', label: 'Greyscale' },
    { id: 'bw', label: 'Black & white' },
  ];

  let cv = null;

  // Waits for OpenCV's WebAssembly to start, then sets `cv`. OpenCV's object has a `then`
  // method, so it must never be passed to resolve() or awaited: the promise would keep
  // "unwrapping" it forever and freeze the page. Readiness is checked by polling instead.
  function cvReady() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function check() {
        const c = window.cv;
        if (c?.Mat && c.imread) {
          cv = c;
          return resolve();
        }
        if (Date.now() - started > 60000) return reject(new Error('OpenCV did not start'));
        setTimeout(check, 100);
      })();
    });
  }

  // Finding and straightening the page

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Top-left, top-right, bottom-right, bottom-left
  function orderCorners(pts) {
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  }

  // A rectangle just inside the image, for when no page is found
  function defaultCorners(w, h) {
    const m = 0.08;
    return [
      { x: w * m, y: h * m }, { x: w * (1 - m), y: h * m },
      { x: w * (1 - m), y: h * (1 - m) }, { x: w * m, y: h * (1 - m) },
    ];
  }

  // Looks for the largest four-sided shape covering a good part of the image (the page).
  // Returns its corners in the source's pixels, or null.
  function findPage(source) {
    const w = source.width;
    const h = source.height;
    const scale = Math.min(1, DETECT_SIZE / Math.max(w, h));
    const small = document.createElement('canvas');
    small.width = Math.round(w * scale);
    small.height = Math.round(h * scale);
    small.getContext('2d').drawImage(source, 0, 0, small.width, small.height);

    const src = cv.imread(small);
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    let best = null;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 40, 120);
      cv.dilate(edges, edges, kernel);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const minArea = small.width * small.height * 0.15;
      let bestArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area > minArea && area > bestArea) {
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            bestArea = area;
            best = [];
            for (let j = 0; j < 4; j++) {
              best.push({ x: approx.data32S[j * 2] / scale, y: approx.data32S[j * 2 + 1] / scale });
            }
          }
          approx.delete();
        }
        c.delete();
      }
    } finally {
      [src, gray, edges, contours, hierarchy, kernel].forEach(m => m.delete());
    }
    return best && orderCorners(best);
  }

  // Cuts out the page and flattens it to a rectangle
  function straighten(source, corners) {
    const [tl, tr, br, bl] = corners;
    let width = Math.max(dist(tl, tr), dist(bl, br));
    let height = Math.max(dist(tl, bl), dist(tr, br));
    const fit = Math.min(1, PAGE_SIZE / Math.max(width, height));
    width = Math.round(width * fit);
    height = Math.round(height * fit);

    const src = cv.imread(source);
    const out = new cv.Mat();
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flatMap(p => [p.x, p.y]));
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
    const matrix = cv.getPerspectiveTransform(from, to);
    try {
      cv.warpPerspective(src, out, matrix, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const canvas = document.createElement('canvas');
      cv.imshow(canvas, out);
      return canvas;
    } finally {
      [src, out, from, to, matrix].forEach(m => m.delete());
    }
  }

  // Evens out lighting by dividing by a heavily blurred copy (the paper's shading), which
  // turns the paper white and keeps writing dark. Black & white then thresholds that.
  function applyFilter(page, filter) {
    if (filter === 'colour') return page;
    const src = cv.imread(page);
    const gray = new cv.Mat();
    const background = new cv.Mat();
    const out = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const k = Math.max(21, Math.round(Math.max(page.width, page.height) / 30)) | 1;
      cv.GaussianBlur(gray, background, new cv.Size(k, k), 0);
      cv.divide(gray, background, out, 255);
      if (filter === 'bw') {
        const block = Math.max(15, Math.round(Math.max(page.width, page.height) / 60)) | 1;
        cv.adaptiveThreshold(out, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
      } else {
        cv.normalize(out, out, 0, 255, cv.NORM_MINMAX);
      }
      const canvas = document.createElement('canvas');
      cv.imshow(canvas, out);
      return canvas;
    } finally {
      [src, gray, background, out].forEach(m => m.delete());
    }
  }

  // PDF: one JPEG per page, each page A4 wide with the photo's proportions

  async function buildPdf(pages) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = part => {
      const bytes = typeof part === 'string' ? enc.encode(part) : part;
      chunks.push(bytes);
      length += bytes.length;
    };
    const object = (n, body) => {
      offsets[n] = length;
      push(`${n} 0 obj\n`);
      for (const part of body) push(part);
      push('\nendobj\n');
    };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    object(2, [`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`]);
    for (let i = 0; i < pages.length; i++) {
      const { jpeg, width, height } = pages[i];
      const pw = 595.28;
      const ph = +(pw * height / width).toFixed(2);
      const [page, content, image] = [3 + i * 3, 4 + i * 3, 5 + i * 3];
      const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
      object(page, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
        `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`]);
      object(content, [`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`]);
      object(image, [
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        jpeg,
        '\nendstream',
      ]);
    }
    const count = 3 + pages.length * 3;
    const xref = length;
    push(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const pdf = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      pdf.set(c, at);
      at += c.length;
    }
    return pdf.buffer;
  }

  const toJpeg = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    .then(blob => blob.arrayBuffer())
    .then(buffer => new Uint8Array(buffer));

  // Screens

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  }

  function button(text, className, onClick) {
    const b = el('button', className, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // Where an image of size w×h sits when fitted inside a box (like object-fit: contain)
  function fitBox(w, h, box) {
    const s = Math.min(box.width / w, box.height / h);
    return { scale: s, x: (box.width - w * s) / 2, y: (box.height - h * s) / 2 };
  }

  function drawOutline(ctx, corners, fit, colour) {
    ctx.beginPath();
    corners.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](fit.x + p.x * fit.scale, fit.y + p.y * fit.scale));
    ctx.closePath();
    ctx.fillStyle = 'rgba(124, 108, 240, 0.18)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = colour;
    ctx.stroke();
  }

  function scan() {
    return new Promise(resolve => {
      const pages = []; // { jpeg, width, height, thumb }
      let filter = 'grey';
      try {
        filter = localStorage.getItem('scanFilter') || 'grey';
      } catch {}

      const root = el('div', 'scanner');
      document.body.append(root);
      document.body.classList.add('scanning');
      let stream = null;
      let liveTimer = null;

      function stopCamera() {
        clearInterval(liveTimer);
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
      }

      function finish(result) {
        stopCamera();
        root.remove();
        document.body.classList.remove('scanning');
        resolve(result);
      }

      // 1. Camera

      const photoInput = el('input');
      photoInput.type = 'file';
      photoInput.accept = 'image/*';
      photoInput.addEventListener('change', async () => {
        const file = photoInput.files[0];
        photoInput.value = '';
        if (!file) return;
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const canvas = el('canvas');
        const fit = Math.min(1, 4000 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.round(bitmap.width * fit);
        canvas.height = Math.round(bitmap.height * fit);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        showCorners(canvas);
      });

      async function showCamera() {
        root.innerHTML = '';
        const stage = el('div', 'scan-stage');
        const video = el('video');
        video.playsInline = true;
        video.muted = true;
        const overlay = el('canvas', 'scan-overlay');
        const hint = el('div', 'scan-hint', 'Lay the page on a darker surface and fit it in view');
        stage.append(video, overlay, hint);

        const strip = el('div', 'scan-pages');
        pages.forEach((p, i) => {
          const item = el('div', 'scan-thumb');
          const img = el('img');
          img.src = p.thumb;
          img.alt = `Page ${i + 1}`;
          item.append(img, el('span', 'scan-thumb-no', String(i + 1)));
          if (i > 0) {
            item.append(button('◀', 'scan-thumb-move', () => {
              [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
              showCamera();
            }));
          }
          item.append(button('×', 'scan-thumb-del', () => {
            pages.splice(i, 1);
            showCamera();
          }));
          strip.append(item);
        });

        const bar = el('div', 'scan-bar');
        const cancel = button('Cancel', 'scan-secondary', () => {
          if (!pages.length || confirm(`Discard ${pages.length} scanned page${pages.length === 1 ? '' : 's'}?`)) {
            finish({ ok: false, cancelled: true });
          }
        });
        const shutter = button('', 'scan-shutter', () => capture(video));
        shutter.setAttribute('aria-label', 'Take photo');
        const done = button(pages.length ? `Done (${pages.length})` : 'Done', 'scan-primary', async () => {
          done.disabled = true;
          done.textContent = 'Saving…';
          const data = await buildPdf(pages);
          finish({ ok: true, data, pages: pages.length });
        });
        done.disabled = !pages.length;
        const gallery = button('🖼', 'scan-icon', () => photoInput.click());
        gallery.title = 'Use a photo you already took';
        bar.append(cancel, gallery, shutter, done);
        root.append(stage, strip, bar);

        try {
          stream ||= await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          });
          video.srcObject = stream;
          await video.play();
        } catch {
          // No camera access (refused, or none): photos can still be taken with the phone's camera app
          stopCamera();
          hint.textContent = 'The camera couldn\'t be opened here. Tap the button below to take a photo instead.';
          photoInput.capture = 'environment';
          shutter.onclick = () => photoInput.click();
          return;
        }

        // Outlines the page in the live view a few times a second
        const frame = el('canvas');
        clearInterval(liveTimer);
        liveTimer = setInterval(() => {
          if (!video.videoWidth || !root.isConnected) return;
          const s = Math.min(1, DETECT_SIZE / Math.max(video.videoWidth, video.videoHeight));
          frame.width = Math.round(video.videoWidth * s);
          frame.height = Math.round(video.videoHeight * s);
          frame.getContext('2d').drawImage(video, 0, 0, frame.width, frame.height);
          const corners = findPage(frame);
          const box = stage.getBoundingClientRect();
          overlay.width = box.width;
          overlay.height = box.height;
          const ctx = overlay.getContext('2d');
          ctx.clearRect(0, 0, box.width, box.height);
          if (corners) drawOutline(ctx, corners, fitBox(frame.width, frame.height, box), '#7c6cf0');
          hint.hidden = !!corners;
        }, LIVE_DETECT_MS);
      }

      // Uses the camera's full-resolution photo where the browser allows it, else a video frame
      async function capture(video) {
        if (!video.videoWidth) return;
        let source = null;
        try {
          if ('ImageCapture' in window && stream) {
            const blob = await new ImageCapture(stream.getVideoTracks()[0]).takePhoto();
            source = await createImageBitmap(blob);
          }
        } catch {}
        const canvas = el('canvas');
        const w = source?.width || video.videoWidth;
        const h = source?.height || video.videoHeight;
        const fit = Math.min(1, 4000 / Math.max(w, h));
        canvas.width = Math.round(w * fit);
        canvas.height = Math.round(h * fit);
        canvas.getContext('2d').drawImage(source || video, 0, 0, canvas.width, canvas.height);
        showCorners(canvas);
      }

      // 2. Corners

      function showCorners(photo) {
        clearInterval(liveTimer);
        root.innerHTML = '';
        const corners = findPage(photo) || defaultCorners(photo.width, photo.height);
        const stage = el('div', 'scan-stage scan-adjust');
        const view = el('canvas');
        const handles = corners.map(() => el('div', 'scan-handle'));
        stage.append(view, ...handles);
        const hint = el('div', 'scan-hint scan-hint-top', 'Drag the corners onto the page\'s corners');
        stage.append(hint);

        let fit;
        function draw() {
          const box = stage.getBoundingClientRect();
          view.width = box.width;
          view.height = box.height;
          fit = fitBox(photo.width, photo.height, box);
          const ctx = view.getContext('2d');
          ctx.clearRect(0, 0, box.width, box.height);
          ctx.drawImage(photo, fit.x, fit.y, photo.width * fit.scale, photo.height * fit.scale);
          drawOutline(ctx, corners, fit, '#b5aaff');
          handles.forEach((h, i) => {
            h.style.left = `${fit.x + corners[i].x * fit.scale}px`;
            h.style.top = `${fit.y + corners[i].y * fit.scale}px`;
          });
        }

        handles.forEach((handle, i) => {
          handle.addEventListener('pointerdown', e => {
            e.preventDefault();
            handle.setPointerCapture(e.pointerId);
            const move = ev => {
              const box = stage.getBoundingClientRect();
              corners[i] = {
                x: Math.min(photo.width, Math.max(0, (ev.clientX - box.left - fit.x) / fit.scale)),
                y: Math.min(photo.height, Math.max(0, (ev.clientY - box.top - fit.y) / fit.scale)),
              };
              draw();
            };
            const up = () => {
              handle.removeEventListener('pointermove', move);
              handle.removeEventListener('pointerup', up);
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
          });
        });

        const bar = el('div', 'scan-bar');
        bar.append(
          button('Retake', 'scan-secondary', showCamera),
          button('Whole photo', 'scan-secondary', () => {
            corners.splice(0, 4, { x: 0, y: 0 }, { x: photo.width, y: 0 },
              { x: photo.width, y: photo.height }, { x: 0, y: photo.height });
            draw();
          }),
          button('Next', 'scan-primary', () => showCleanUp(photo, orderCorners(corners))),
        );
        root.append(stage, bar);
        requestAnimationFrame(draw);
        window.addEventListener('resize', draw, { once: true });
      }

      // 3. Clean up

      function showCleanUp(photo, corners) {
        root.innerHTML = '';
        const page = straighten(photo, corners);
        const stage = el('div', 'scan-stage scan-preview');
        let shown = applyFilter(page, filter);
        stage.append(shown);

        const choices = el('div', 'scan-filters');
        for (const f of FILTERS) {
          const b = button(f.label, f.id === filter ? 'active' : '', () => {
            filter = f.id;
            try {
              localStorage.setItem('scanFilter', filter);
            } catch {}
            choices.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
            const next = applyFilter(page, filter);
            shown.replaceWith(next);
            shown = next;
          });
          choices.append(b);
        }

        const bar = el('div', 'scan-bar');
        bar.append(
          button('Back', 'scan-secondary', () => showCorners(photo)),
          button(`Keep page ${pages.length + 1}`, 'scan-primary', async () => {
            const thumb = el('canvas');
            const s = 160 / Math.max(shown.width, shown.height);
            thumb.width = Math.round(shown.width * s);
            thumb.height = Math.round(shown.height * s);
            thumb.getContext('2d').drawImage(shown, 0, 0, thumb.width, thumb.height);
            pages.push({ jpeg: await toJpeg(shown), width: shown.width, height: shown.height, thumb: thumb.toDataURL() });
            showCamera();
          }),
        );
        root.append(stage, choices, bar);
      }

      showCamera();
    });
  }

  window.WebScanner = {
    async scan() {
      await cvReady();
      return scan();
    },
    // For testing: the processing steps without the screens
    _test: { cvReady, findPage, straighten, applyFilter, buildPdf, toJpeg },
  };
})();

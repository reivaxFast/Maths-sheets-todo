// Ask Claude: a chat about one worksheet, where Claude reads the worksheet (problem sheet) and
// the course's lecture notes, plus the submission and marked work if ticked, and answers
// questions from them.
//
// - Uses the user's own Anthropic API key, kept only on this device (localStorage). It isn't
//   synced or exported. Requests go straight from the app to the Anthropic API.
// - Cost: reading is what's billed, so long lecture notes are cut down to the pages that match
//   the worksheet and the first question (or all pages, or a range the user types). Each set of
//   notes' text is extracted on this device once (pdf.js) and searched locally; the chosen
//   pages are copied into a smaller PDF (pdf-lib). Both are kept in IndexedDB (claude-index).
// - The notes come first in the request, so worksheets in a course that send the same pages
//   share the cached notes. Everything sent is cached for an hour (prompt caching), so
//   follow-up questions pay little for the materials.
// - The model is chosen per conversation (Haiku, Sonnet or Opus); the default is remembered.
// - In the desktop and Android apps, PDFs are uploaded with the Files API and reused by file
//   id. The Files API doesn't accept requests from web pages, so the upload goes through the
//   app's native side (window.files.claudeUpload, from preload.js / mobile.js).
// - On the website there's no native side, so PDFs go inside each request instead (base64),
//   which limits them to about 22 MB in total. They're not stored with the conversation:
//   they're read back from this device's storage for each question.
// - Each worksheet keeps its own conversation on this device. The model and materials can't
//   change mid-conversation (the API only allows appending), so changing them starts a new one.
//
// Libraries (vendor/, built by scripts/build-vendor.js) load the first time a chat opens;
// pdf.js only when notes need reading.

(() => {
  // US$ per million tokens: input, 1-hour cache write (2x input), cache read, output.
  // Haiku 5.5's rates are for prompts up to 100K tokens; above that they're 5x (see costOf).
  const MODELS = {
    'claude-haiku-5-5': {
      label: 'Haiku 5.5: cheapest, for quick questions',
      price: { input: 0.1, cacheWrite: 0.2, cacheRead: 0.01, output: 0.5 },
      longPromptFactor: 5,
      effort: 'medium',
      fallbacks: false, // No server-side fallback for Haiku 5.5
    },
    'claude-sonnet-5-5': {
      label: 'Sonnet 5.5: good value for most questions',
      price: { input: 2, cacheWrite: 4, cacheRead: 0.2, output: 10 },
      effort: 'medium',
      fallbacks: true,
    },
    'claude-opus-5-5': {
      label: 'Opus 5.5: most capable, for the hardest problems',
      price: { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 },
      effort: 'high',
      fallbacks: true,
    },
  };
  const DEFAULT_MODEL = 'claude-sonnet-5-5';

  const KEY_STORAGE = 'claudeApiKey';
  const MODEL_STORAGE = 'claudeModel';
  const FILES_STORAGE = 'claudeFiles'; // { owner, files: { [materialId]: { fileId, size } } }
  const CHAT_PREFIX = 'claudeChat:'; // + task id: { model, docs: [{ key, pages }], messages }
  const CACHE = { type: 'ephemeral', ttl: '1h' };
  // Website only: PDFs sent inside the request. A request may be 32 MB and base64 adds a
  // third, so this leaves room for the rest of the conversation.
  const INLINE_LIMIT = 22 * 1024 * 1024;
  // Notes longer than this are cut down to the pages that match, about PAGE_BUDGET of them
  const AUTO_MIN_PAGES = 30;
  const PAGE_BUDGET = 20;
  const MAX_PAGES = 600; // Claude's limit per request

  const SYSTEM = [
    "You are helping a university student with a worksheet from one of their courses.",
    "The first message contains the course's lecture notes (sometimes only the pages that match the worksheet, as marked in their title), the worksheet, and sometimes the student's own submission or their marked work.",
    "Answer the student's questions from these materials: use the methods, notation and results in the lecture notes, and say where in the notes something comes from (for example the section, theorem or page).",
    "If the material you have doesn't cover what's needed, say so before drawing on outside knowledge; when only some pages of the notes were included, you can suggest the student starts a new conversation with more of the notes.",
    "When they ask about a question, help them understand how to approach it; give a full worked solution when they ask for one.",
    "Write mathematics in LaTeX, between $...$ for inline maths and $$...$$ for displayed equations.",
  ].join(' ');

  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    json(key, fallback) {
      try {
        return JSON.parse(this.get(key)) ?? fallback;
      } catch {
        return fallback;
      }
    },
  };

  const apiKey = () => store.get(KEY_STORAGE);
  const defaultModel = () => (MODELS[store.get(MODEL_STORAGE)] ? store.get(MODEL_STORAGE) : DEFAULT_MODEL);
  const mb = bytes => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  const dollars = n => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(text, className, onClick, title) {
    const b = el('button', className, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  // Libraries

  const loadScript = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(s);
  });

  let libsLoaded = null;
  function loadLibs() {
    libsLoaded ||= (async () => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'vendor/katex/katex.min.css';
      document.head.append(css);
      await Promise.all([
        loadScript('vendor/anthropic-sdk.js'),
        loadScript('vendor/marked.umd.js'),
        loadScript('vendor/katex/katex.min.js'),
      ]);
      // Claude's text is shown as formatted HTML, so raw HTML in it is shown as text and
      // only web links are kept (no scripts, images or other URLs from the answer)
      window.marked.use({
        renderer: {
          html: ({ text }) => escapeHtml(text),
          image: ({ text }) => escapeHtml(text),
          link({ href, tokens }) {
            const label = this.parser.parseInline(tokens);
            return /^(https?:|mailto:)/i.test(href)
              ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
              : label;
          },
        },
      });
    })().catch(e => {
      libsLoaded = null;
      throw e;
    });
    return libsLoaded;
  }

  let pdfjsLoaded = null;
  const loadPdfjs = () => (pdfjsLoaded ||= loadScript('vendor/pdfjs.js').catch(e => {
    pdfjsLoaded = null;
    throw e;
  }));

  const client = () => new window.Anthropic({ apiKey: apiKey(), dangerouslyAllowBrowser: true });

  // Formats an answer: maths is taken out first (so markdown doesn't mangle underscores and
  // asterisks inside it), the rest goes through marked, then the maths goes back in via KaTeX
  function renderAnswer(text) {
    const maths = [];
    const stash = (tex, display) => `@@MATH${maths.push({ tex, display }) - 1}@@`;
    const source = text
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(tex, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stash(tex, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stash(tex, false))
      .replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)\$/g, (_, before, tex) => before + stash(tex, false));
    return window.marked.parse(source).replace(/@@MATH(\d+)@@/g, (_, i) => {
      const { tex, display } = maths[i];
      try {
        return window.katex.renderToString(tex, { displayMode: display, throwOnError: false });
      } catch {
        return escapeHtml(tex);
      }
    });
  }

  class UserError extends Error {}

  // Turns an API error into something to show
  function explain(e) {
    const A = window.Anthropic;
    const text = String(e?.message || e || '');
    if (e instanceof UserError) return text;
    if (A && e instanceof A.AuthenticationError) return 'Claude didn\'t accept your API key. Check it in Claude settings.';
    if (A && e instanceof A.PermissionDeniedError) return 'Your API key isn\'t allowed to do this. Check its permissions in the Claude Console.';
    if (A && e instanceof A.RateLimitError) return 'Too many requests right now. Wait a minute and try again.';
    if (A && e instanceof A.NotFoundError) return 'One of the uploaded PDFs is no longer on Anthropic\'s side. Start a new conversation to upload it again.';
    if (A && e instanceof A.APIConnectionError) return 'Couldn\'t reach Claude. Check your internet connection.';
    if (/credit balance/i.test(text)) return 'Your Anthropic account is out of credit. Add some in the Claude Console (Billing).';
    if (/page|prompt is too long|too large|exceed/i.test(text)) {
      return `These PDFs are too big to read together (Claude reads up to ${MAX_PAGES} pages at once). ` +
        'Start a new conversation with fewer pages of the notes.';
    }
    return `Claude couldn't answer: ${text.replace(/^\d{3}\s*/, '')}`;
  }

  // On-device store for the notes' text and the cut-down PDFs (IndexedDB "claude-index")

  const indexDb = new Promise((resolve, reject) => {
    const req = indexedDB.open('claude-index', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('text'); // pdfKey -> { size, pages: [text per page] }
      req.result.createObjectStore('subsets'); // "pdfKey|size|1,2,3" -> Blob
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function idb(storeName, mode, fn) {
    const db = await indexDb;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(storeName, mode).objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function pdfBlob(doc) {
    const blob = await getPdf(doc.key) || await remotePdf(doc.key);
    if (!blob) {
      throw new UserError(`${doc.name} isn't on this device yet. If it was added on another device, ` +
        'open the app there so it can sync, then try again.');
    }
    return blob;
  }

  // The text of each page, extracted once per version of the PDF
  async function pageTexts(doc, onStatus) {
    const blob = await pdfBlob(doc);
    const known = await idb('text', 'readonly', s => s.get(doc.key));
    if (known?.size === blob.size) return known.pages;

    await loadPdfjs();
    const loading = window.pdfjsLib.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()),
      isEvalSupported: false,
    });
    const pdf = await loading.promise;
    const pages = [];
    try {
      for (let n = 1; n <= pdf.numPages; n++) {
        if (n % 10 === 1) onStatus(`Reading the text of ${doc.name} (first time only): page ${n} of ${pdf.numPages}…`);
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim());
        page.cleanup();
      }
    } finally {
      loading.destroy();
    }
    await idb('text', 'readwrite', s => s.put({ size: blob.size, pages }, doc.key));
    return pages;
  }

  // Finding the pages that match

  const STOP_WORDS = new Set(('the and for that with this are from which then let show find prove '
    + 'where when what will can its has have not but all any each was were been into such than these '
    + 'those there their our you your use using given give question questions part parts sheet answer '
    + 'following hence thus also may must one two three four five').split(' '));

  const termsOf = text => (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
    .map(w => w.replace(/'s$|-$/, ''))
    .filter(w => !STOP_WORDS.has(w));

  // Ranks pages by BM25 against the worksheet and question (question words count double), then
  // takes the best pages plus the page after each (results often run over), up to the budget
  function pickPages(pageTextsList, query, budget = PAGE_BUDGET) {
    const docs = pageTextsList.map(termsOf);
    const n = docs.length;
    const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, n) || 1;
    const df = new Map();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
    const weights = new Map();
    for (const [t, w] of query) if (df.has(t)) weights.set(t, w);

    const scored = docs.map((d, i) => {
      const tf = new Map();
      for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const [t, w] of weights) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += w * idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avgLength));
      }
      return { page: i + 1, score };
    }).filter(p => p.score > 0).sort((a, b) => b.score - a.score);

    const chosen = new Set();
    for (const { page } of scored) {
      if (chosen.size >= budget) break;
      chosen.add(page);
      if (page < n && chosen.size < budget) chosen.add(page + 1);
    }
    return [...chosen].sort((a, b) => a - b);
  }

  function queryTerms(worksheetText, question) {
    const query = new Map();
    for (const t of termsOf(worksheetText)) query.set(t, Math.max(query.get(t) || 0, 1));
    for (const t of termsOf(question)) query.set(t, 2);
    return query;
  }

  // "3-7, 12" -> [3, 4, 5, 6, 7, 12]; null if it doesn't make sense for a PDF of `count` pages
  function parsePages(text, count) {
    const pages = new Set();
    for (const part of text.split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) return null;
      const from = Number(m[1]);
      const to = Number(m[2] || m[1]);
      if (from < 1 || to < from || to > count) return null;
      for (let p = from; p <= to; p++) pages.add(p);
    }
    return pages.size ? [...pages].sort((a, b) => a - b) : null;
  }

  // [3, 4, 5, 9] -> "3–5, 9"
  function describePages(pages) {
    const runs = [];
    for (const p of pages) {
      const last = runs[runs.length - 1];
      if (last && p === last[1] + 1) last[1] = p;
      else runs.push([p, p]);
    }
    return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
  }

  // The PDF to send for a material: the whole file, or a copy with only its chosen pages
  // (kept, so the same bytes are sent each time and the cache keeps matching)
  async function materialBlob(material) {
    const blob = await pdfBlob(material);
    if (!material.pages) return blob;
    const id = `${material.key}|${blob.size}|${material.pages.join(',')}`;
    const kept = await idb('subsets', 'readonly', s => s.get(id));
    if (kept) return kept;

    await loadPdfLib();
    const { PDFDocument } = window.PDFLib;
    const source = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
    const subset = await PDFDocument.create({ updateMetadata: false });
    for (const page of await subset.copyPages(source, material.pages.map(p => p - 1))) subset.addPage(page);
    const out = new Blob([await subset.save()], { type: 'application/pdf' });
    await idb('subsets', 'readwrite', s => s.put(out, id));
    return out;
  }

  // Uploads (Files API, desktop and Android apps)

  // File ids belong to the API key's organisation, so a different key starts afresh
  function fileCache() {
    const owner = (apiKey() || '').slice(-8);
    const cache = store.json(FILES_STORAGE, null);
    return cache?.owner === owner ? cache : { owner, files: {} };
  }

  const canUpload = () => typeof window.files?.claudeUpload === 'function';

  // The native upload reports an HTTP status rather than throwing the SDK's error classes
  function uploadError(result, name) {
    const why = {
      401: 'Claude didn\'t accept your API key. Check it in Claude settings.',
      403: 'Your API key isn\'t allowed to upload files. Check its permissions in the Claude Console.',
      413: `${name} is too big to upload.`,
      429: 'Too many requests right now. Wait a minute and try again.',
    }[result.status];
    return new UserError(why || (result.status
      ? `Couldn't upload ${name}: ${result.message || `error ${result.status}`}`
      : `Couldn't upload ${name}. Check your internet connection.`));
  }

  async function uploadedId(material, blob, onStatus) {
    const id = `${material.key}|${material.pages ? material.pages.join(',') : 'all'}`;
    const cache = fileCache();
    const known = cache.files[id];
    if (known && known.size === blob.size) return known.fileId;

    onStatus(`Uploading ${material.name} (${mb(blob.size)})…`);
    const result = await window.files.claudeUpload({
      apiKey: apiKey(),
      name: unsafeFileChars(material.name),
      data: await blob.arrayBuffer(),
    });
    if (!result.ok) throw uploadError(result, material.name);
    // The PDF changed: the old copy isn't needed any more
    if (known) window.files.claudeDelete?.({ apiKey: apiKey(), id: known.fileId });
    cache.files[id] = { fileId: result.id, size: blob.size };
    store.set(FILES_STORAGE, JSON.stringify(cache));
    return result.id;
  }

  // Website: the PDFs' base64, read from this device's storage for every request
  async function inlineData(blobs, materials) {
    const total = blobs.reduce((n, b) => n + b.size, 0);
    if (total > INLINE_LIMIT) {
      const biggest = materials[blobs.indexOf(blobs.reduce((a, b) => (b.size > a.size ? b : a)))];
      throw new UserError(`These PDFs add up to ${mb(total)}, more than the website can send at once ` +
        `(about ${mb(INLINE_LIMIT)}). Send fewer pages of ${biggest.name}, untick it, or use the ` +
        'desktop or Android app, which can upload larger files.');
    }
    return Promise.all(blobs.map(async b => bytesToBase64(new Uint8Array(await b.arrayBuffer()))));
  }

  const titleOf = (m, pageCount) => `${m.label}: ${m.name}` +
    (m.pages ? ` (only pages ${describePages(m.pages)} of ${pageCount ?? m.pageCount})` : '');

  // The document blocks for a conversation's materials: notes first (so they're the shared,
  // cached part), then the worksheet and anything else ticked
  async function materialBlocks(materials, onStatus) {
    const blobs = [];
    for (const m of materials) blobs.push(await materialBlob(m));
    let sources;
    if (canUpload()) {
      sources = [];
      for (let i = 0; i < materials.length; i++) {
        sources.push({ type: 'file', file_id: await uploadedId(materials[i], blobs[i], onStatus) });
      }
    } else {
      onStatus('Preparing the PDFs…');
      const data = await inlineData(blobs, materials);
      sources = data.map(d => ({ type: 'base64', media_type: 'application/pdf', data: d }));
    }
    const blocks = materials.map((m, i) => ({ type: 'document', source: sources[i], title: titleOf(m) }));
    const lastNotes = materials.map(m => m.notes).lastIndexOf(true);
    if (lastNotes >= 0) blocks[lastNotes].cache_control = CACHE;
    blocks[blocks.length - 1].cache_control = CACHE;
    return blocks;
  }

  // Website conversations are saved without the PDFs' base64 (far too big for this device's
  // storage) and get it back from this device's storage before each request
  function forStorage(messages) {
    return messages.map((m, i) => i > 0 || typeof m.content === 'string' ? m : {
      ...m,
      content: m.content.map(b => b.source?.type === 'base64' ? { ...b, source: { ...b.source, data: null } } : b),
    });
  }

  async function withPdfData(messages, materials) {
    const first = messages[0];
    if (!first || typeof first.content === 'string' || !first.content.some(b => b.source?.data === null)) {
      return messages;
    }
    const blobs = [];
    for (const m of materials) blobs.push(await materialBlob(m));
    const data = await inlineData(blobs, materials);
    let i = 0;
    const content = first.content.map(b => b.source?.data === null
      ? { ...b, source: { ...b.source, data: data[i++] } }
      : b);
    return [{ ...first, content }, ...messages.slice(1)];
  }

  function costOf(usage, model) {
    const { price, longPromptFactor = 1 } = MODELS[model] || MODELS[DEFAULT_MODEL];
    const read = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const factor = read > 100000 ? longPromptFactor : 1;
    return factor * (
      (usage.input_tokens || 0) * price.input +
      (usage.cache_creation_input_tokens || 0) * price.cacheWrite +
      (usage.cache_read_input_tokens || 0) * price.cacheRead +
      (usage.output_tokens || 0) * price.output
    ) / 1e6;
  }

  // What Claude can read for a task, in the order it's sent: notes, worksheet, then optional
  function docsFor(task) {
    const course = courseOf(task);
    const docs = [];
    for (const f of course?.files || []) {
      docs.push({ key: noteKey(course, f), name: f.name, label: 'Lecture notes', notes: true, on: true, mode: 'auto' });
    }
    if (task.problemName) {
      docs.push({ key: PDF_KINDS.problem.key(task.id), name: task.problemName, label: 'Worksheet', fixed: true, on: true });
    }
    if (task.pdfName) {
      docs.push({ key: PDF_KINDS.work.key(task.id), name: pdfName(task, PDF_KINDS.work), label: 'My submission', on: false });
    }
    if (task.markedName) {
      docs.push({ key: PDF_KINDS.marked.key(task.id), name: task.markedName, label: 'Marked work', on: false });
    }
    return docs;
  }

  // Works out each ticked document's pages for a new conversation
  async function chooseMaterials(docs, question, onStatus) {
    const chosen = docs.filter(d => d.on);
    const worksheet = chosen.find(d => d.fixed);
    let worksheetText = null;
    const materials = [];
    for (const d of chosen) {
      const m = { key: d.key, name: d.name, label: d.label, notes: !!d.notes, pages: null };
      if (d.notes) {
        const texts = await pageTexts(d, onStatus);
        m.pageCount = texts.length;
        if (d.mode === 'custom') {
          m.pages = parsePages(d.range || '', texts.length);
          if (!m.pages) throw new UserError(`Pages for ${d.name}: write them like 10-25, 40 (it has ${texts.length} pages).`);
        } else if (d.mode === 'auto' && texts.length > AUTO_MIN_PAGES) {
          worksheetText ??= worksheet ? (await pageTexts(worksheet, onStatus)).join(' ') : '';
          const picked = pickPages(texts, queryTerms(worksheetText, question));
          // No text to match on (e.g. scanned notes): send them whole if they fit
          m.pages = picked.length ? picked : null;
        }
        if (!m.pages && texts.length > MAX_PAGES) {
          throw new UserError(`${d.name} has ${texts.length} pages, more than Claude reads at once ` +
            `(${MAX_PAGES}). Choose some pages of it.`);
        }
      }
      materials.push(m);
    }
    return materials;
  }

  // Connect (API key) and settings

  let connectModal = null;
  let afterConnect = null;

  function openConnect(then) {
    afterConnect = then || null;
    if (!connectModal) connectModal = buildConnect();
    connectModal.refresh();
    connectModal.hidden = false;
    connectModal.querySelector('input').focus();
  }

  function buildConnect() {
    const modal = el('div', 'modal claude-modal');
    const box = el('div', 'modal-box claude-connect');
    const head = el('div', 'modal-head');
    head.append(el('h2', null, 'Connect Claude'), button('Close', 'secondary', () => (modal.hidden = true)));

    const intro = el('p', 'muted');
    intro.innerHTML = 'Ask Claude about a worksheet and it answers from the worksheet and your lecture notes. ' +
      'It uses your own Anthropic API key, from the ' +
      '<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">Claude Console</a>, ' +
      'and questions are billed to that account. Each answer shows roughly what it cost.';
    const privacy = el('p', 'muted', 'The key stays on this device only: it isn\'t synced or included in exports. ' +
      'Your PDFs are sent to Anthropic when you ask a question.');

    const form = el('form', 'claude-key-form');
    const input = el('input');
    input.type = 'password';
    input.placeholder = 'sk-ant-…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const save = el('button', null, 'Save');
    save.type = 'submit';
    form.append(input, save);

    const status = el('p', 'claude-status');
    const disconnect = button('Disconnect', 'secondary danger', () => {
      store.set(KEY_STORAGE, null);
      store.set(FILES_STORAGE, null);
      input.value = '';
      modal.refresh();
      updateHeader();
    });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const key = input.value.trim();
      if (!key) return;
      save.disabled = true;
      status.className = 'claude-status';
      status.textContent = 'Checking the key…';
      const previous = apiKey();
      store.set(KEY_STORAGE, key);
      try {
        await loadLibs();
        // Free, and fails if the key is wrong. (The models endpoint would be the obvious
        // check, but it doesn't allow web pages to read its error responses.)
        await client().messages.countTokens({ model: defaultModel(), messages: [{ role: 'user', content: 'Hi' }] });
        input.value = '';
        modal.refresh();
        updateHeader();
        status.textContent = 'Connected.';
        if (afterConnect) {
          const then = afterConnect;
          afterConnect = null;
          modal.hidden = true;
          then();
        }
      } catch (err) {
        store.set(KEY_STORAGE, previous);
        status.className = 'claude-status error';
        status.textContent = explain(err);
      } finally {
        save.disabled = false;
      }
    });

    modal.refresh = () => {
      const connected = !!apiKey();
      status.className = 'claude-status';
      status.textContent = connected ? `Connected (key ending ${apiKey().slice(-4)}).` : '';
      input.placeholder = connected ? 'Paste a different key to replace it' : 'sk-ant-…';
      disconnect.hidden = !connected;
    };
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.hidden = true;
    });

    box.append(head, intro, privacy, form, status, disconnect);
    modal.append(box);
    modal.hidden = true;
    document.body.append(modal);
    return modal;
  }

  // Header button
  const headerBtn = button('✦ Claude', null, () => openConnect(), 'Connect Claude to ask questions about worksheets');
  headerBtn.id = 'claude-btn';
  document.querySelector('header .actions').prepend(headerBtn);
  function updateHeader() {
    headerBtn.textContent = apiKey() ? '✦ Claude ✓' : '✦ Claude';
  }
  updateHeader();

  // Chat

  let chatModal = null;

  function openChat(task) {
    if (!apiKey()) {
      openConnect(() => openChat(task));
      return;
    }
    chatModal?.remove();
    chatModal = buildChat(task);
    document.body.append(chatModal);
    document.body.classList.add('chatting');
    chatModal.querySelector('textarea').focus();
  }

  function closeChat() {
    chatModal?.remove();
    chatModal = null;
    document.body.classList.remove('chatting');
  }

  function loadChat(storageKey) {
    const chat = store.json(storageKey, null) || { model: null, docs: null, messages: [] };
    // Conversations from before page choice and model choice: whole PDFs, on Claude Opus 5.5
    if (chat.messages.length) {
      chat.model ||= 'claude-opus-5-5';
      chat.docs = (chat.docs || []).map(d => (typeof d === 'string' ? { key: d, pages: null } : d));
    }
    return chat;
  }

  function buildChat(task) {
    const storageKey = CHAT_PREFIX + task.id;
    const chat = loadChat(storageKey);
    const docs = docsFor(task);
    const locked = chat.messages.length > 0;
    // A conversation keeps the model and materials it started with
    if (locked) {
      for (const d of docs) {
        const used = chat.docs.find(x => x.key === d.key);
        d.on = !!used;
        d.sent = used;
      }
    }
    let model = locked ? chat.model : defaultModel();
    let busy = false;

    const modal = el('div', 'modal claude-modal');
    const box = el('div', 'modal-box claude-chat');
    const head = el('div', 'modal-head');
    const newChat = button('New conversation', 'secondary', () => {
      if (busy || (chat.messages.length && !confirm('Start a new conversation? This one will be cleared.'))) return;
      store.set(storageKey, null);
      chatModal.remove();
      chatModal = buildChat(task);
      document.body.append(chatModal);
    });
    head.append(el('h2', null, taskTitle(task)), el('div', 'claude-head-actions'));
    head.lastChild.append(newChat, button('Close', 'secondary', closeChat));

    // Model and materials
    const materials = el('div', 'claude-materials');
    const modelRow = el('label', 'claude-model');
    const modelSelect = el('select');
    for (const [id, m] of Object.entries(MODELS)) modelSelect.append(new Option(m.label, id));
    modelSelect.value = model;
    modelSelect.disabled = locked;
    modelSelect.addEventListener('change', () => {
      model = modelSelect.value;
      store.set(MODEL_STORAGE, model);
    });
    modelRow.append(el('span', null, 'Model'), modelSelect);
    materials.append(modelRow);

    const controls = [modelSelect];
    for (const d of docs) {
      const row = el('div', 'claude-doc');
      const label = el('label');
      const tick = el('input');
      tick.type = 'checkbox';
      tick.checked = d.on;
      tick.disabled = d.fixed || locked;
      tick.addEventListener('change', () => (d.on = tick.checked));
      label.append(tick, el('span', null, `${d.label}: ${d.name}`));
      row.append(label);
      if (!d.fixed) controls.push(tick);

      if (d.notes) {
        if (locked) {
          if (d.sent) row.append(el('span', 'claude-pages', d.sent.pages ? `pages ${describePages(d.sent.pages)}` : 'all pages'));
        } else {
          const mode = el('select', 'claude-pages');
          mode.append(
            new Option('Pages for your question', 'auto'),
            new Option('All pages', 'all'),
            new Option('Pages…', 'custom'),
          );
          const range = el('input', 'claude-range');
          range.placeholder = 'e.g. 10-25, 40';
          range.hidden = true;
          mode.addEventListener('change', () => {
            d.mode = mode.value;
            range.hidden = d.mode !== 'custom';
            if (!range.hidden) range.focus();
          });
          range.addEventListener('input', () => (d.range = range.value));
          row.append(mode, range);
          controls.push(mode, range);
        }
      }
      materials.append(row);
    }
    const note = el('div', 'claude-note', locked
      ? 'To change the model or what Claude reads, start a new conversation.'
      : `For notes over ${AUTO_MIN_PAGES} pages, "Pages for your question" sends about ${PAGE_BUDGET} pages ` +
        'that match the worksheet and your first question, which costs far less than all of them.');
    materials.append(note);

    const log = el('div', 'claude-log');
    const status = el('div', 'claude-note claude-busy');

    const form = el('form', 'claude-ask');
    const input = el('textarea');
    input.rows = 2;
    input.placeholder = 'Ask about this worksheet, e.g. "How do I start question 2?"';
    const send = el('button', null, 'Ask');
    send.type = 'submit';
    form.append(input, send);
    // Enter sends; Shift+Enter adds a new line
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    function bubble(role, html, extra) {
      const b = el('div', `claude-msg ${role}`);
      const body = el('div', 'claude-body');
      body.innerHTML = html;
      b.append(body);
      if (extra) b.append(el('div', 'claude-note', extra));
      log.append(b);
      log.scrollTop = log.scrollHeight;
      return b;
    }

    const textOf = content => typeof content === 'string'
      ? content
      : content.filter(b => b.type === 'text').map(b => b.text).join('');

    function showHistory() {
      for (const m of chat.messages) {
        if (m.role === 'user') bubble('user', escapeHtml(textOf(m.content)).replace(/\n/g, '<br>'));
        else bubble('assistant', renderAnswer(textOf(m.content)));
      }
      if (!chat.messages.length) {
        log.append(el('div', 'claude-empty',
          'Ask anything about this worksheet. Claude reads what\'s ticked above and answers from it.'));
      }
    }

    function lock(sent) {
      for (const c of controls) c.disabled = true;
      note.textContent = 'To change the model or what Claude reads, start a new conversation.';
      for (const m of sent) {
        if (!m.notes) continue;
        const row = [...materials.querySelectorAll('.claude-doc')][docs.findIndex(d => d.key === m.key)];
        row?.querySelectorAll('.claude-pages, .claude-range').forEach(x => x.remove());
        row?.append(el('span', 'claude-pages', m.pages
          ? `pages ${describePages(m.pages)} of ${m.pageCount}`
          : `all ${m.pageCount} pages`));
      }
    }

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question || busy) return;
      busy = true;
      send.disabled = true;
      log.querySelector('.claude-empty')?.remove();
      bubble('user', escapeHtml(question).replace(/\n/g, '<br>'));
      input.value = '';
      const answer = bubble('assistant', '<span class="claude-thinking">Thinking…</span>');
      const body = answer.querySelector('.claude-body');
      const onStatus = text => (status.textContent = text);
      const started = Date.now();
      const first = !chat.messages.length;

      try {
        let messages;
        let sent = null;
        if (first) {
          sent = await chooseMaterials(docs, question, onStatus);
          const blocks = await materialBlocks(sent, onStatus);
          messages = [{ role: 'user', content: [...blocks, { type: 'text', text: question }] }];
        } else {
          const materialsSent = chat.docs.map(d => ({ ...d, ...(docs.find(x => x.key === d.key) || { name: 'A PDF' }) , pages: d.pages }));
          messages = [...await withPdfData(chat.messages, materialsSent), { role: 'user', content: question }];
        }
        onStatus('Claude is reading and thinking…');

        const settings = MODELS[model];
        // Server-side fallbacks (Sonnet and Opus): if the model's safeguards decline, the
        // request is re-run on Anthropic's recommended fallback model instead of failing
        const stream = client().beta.messages.stream({
          model,
          max_tokens: 32000,
          system: SYSTEM,
          thinking: { type: 'adaptive' },
          output_config: { effort: settings.effort },
          cache_control: CACHE,
          ...(settings.fallbacks && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
          messages,
        });
        let pending = null;
        stream.on('text', (_, snapshot) => {
          status.textContent = 'Claude is answering…';
          // Re-render at most a few times a second while text streams in
          pending ||= setTimeout(() => {
            pending = null;
            body.innerHTML = renderAnswer(snapshot);
            log.scrollTop = log.scrollHeight;
          }, 120);
        });
        const final = await stream.finalMessage();
        clearTimeout(pending);

        if (final.stop_reason === 'refusal') {
          body.textContent = 'Claude declined to answer this. Try rephrasing the question.';
          answer.classList.add('error');
        } else {
          body.innerHTML = renderAnswer(textOf(final.content));
          if (first) {
            chat.model = model;
            chat.docs = sent.map(m => ({ key: m.key, pages: m.pages, pageCount: m.pageCount }));
            lock(sent);
          }
          // The full content goes back unchanged on the next question, thinking blocks included
          chat.messages = forStorage([...messages, { role: 'assistant', content: final.content }]);
          if (!store.set(storageKey, JSON.stringify(chat))) {
            onStatus('This conversation is too big to save on this device, but you can keep asking now.');
          }
          const secs = Math.round((Date.now() - started) / 1000);
          const cut = final.stop_reason === 'max_tokens' ? ' The answer was cut off at the length limit.' : '';
          answer.append(el('div', 'claude-note', `≈ ${dollars(costOf(final.usage, model))} · ${secs}s${cut}`));
        }
        if (!status.textContent.startsWith('This conversation')) status.textContent = '';
      } catch (err) {
        body.textContent = explain(err);
        answer.classList.add('error');
        status.textContent = '';
        // Nothing was saved, so the question can just be asked again
        input.value = question;
      } finally {
        busy = false;
        send.disabled = false;
        log.scrollTop = log.scrollHeight;
      }
    });

    modal.addEventListener('click', e => {
      if (e.target === modal && !busy) closeChat();
    });

    box.append(head, materials, log, status, form);
    modal.append(box);
    loadLibs().then(showHistory, err => {
      log.append(el('div', 'claude-empty error', explain(err)));
      send.disabled = true;
    });
    return modal;
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && chatModal) closeChat();
  });

  // Called by script.js for each task with a worksheet
  window.ClaudeTutor = {
    taskButton(task) {
      return button('💬 Ask Claude', 'pdf-attach ask-claude', () => openChat(task),
        'Ask Claude about this worksheet, using the course\'s lecture notes');
    },
    // For testing the page picking on real notes without calling the API
    _test: { pageTexts, pickPages, queryTerms, parsePages, describePages, materialBlob, chooseMaterials, docsFor },
  };

  render();
})();

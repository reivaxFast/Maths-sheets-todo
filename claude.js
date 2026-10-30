// Ask Claude: a chat about one worksheet, where Claude reads the worksheet (problem sheet) and
// the course's lecture notes, plus the submission and marked work if ticked, and answers
// questions from them.
//
// - Uses the user's own Anthropic API key, kept only on this device (localStorage). It isn't
//   synced or exported. Requests go straight from the app to the Anthropic API.
// - In the desktop and Android apps, PDFs are uploaded once with the Files API and reused by
//   file id (lecture notes can be larger than the 32 MB a request may carry). Ids are
//   remembered per PDF and re-uploaded if the PDF changes. The Files API doesn't accept
//   requests from web pages, so the upload goes through the app's native side
//   (window.files.claudeUpload, from preload.js / mobile.js).
// - On the website there's no native side, so PDFs go inside each request instead (base64),
//   which limits them to about 22 MB in total. They're not stored with the conversation:
//   they're read back from the app's storage for each question.
// - The materials are cached for an hour (prompt caching), so follow-up questions only pay
//   full price for the question and answer.
// - Each worksheet keeps its own conversation on this device. The materials can't change
//   mid-conversation (the API only allows appending), so changing them starts a new one.
//
// Libraries (vendor/, built by scripts/build-vendor.js) load the first time a chat opens.

(() => {
  const MODEL = 'claude-opus-5-5';
  const KEY_STORAGE = 'claudeApiKey';
  const FILES_STORAGE = 'claudeFiles'; // { owner, files: { [pdfKey]: { fileId, name, size } } }
  const CHAT_PREFIX = 'claudeChat:'; // + task id: { docs: [pdfKey], messages: [API messages] }
  // Claude Opus 5.5, US$ per million tokens: input, 1-hour cache write, cache read, output
  const PRICE = { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 };
  const CACHE = { type: 'ephemeral', ttl: '1h' };
  // Website only: PDFs sent inside the request. A request may be 32 MB and base64 adds a
  // third, so this leaves room for the rest of the conversation.
  const INLINE_LIMIT = 22 * 1024 * 1024;

  const SYSTEM = [
    "You are helping a university student with a worksheet from one of their courses.",
    "The first message contains the worksheet and the course's lecture notes, and sometimes the student's own submission or their marked work.",
    "Answer the student's questions from these materials: use the methods, notation and results in the lecture notes, and say where in the notes something comes from (for example the section, theorem or page).",
    "If the notes don't cover what's needed, say so before drawing on outside knowledge.",
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
      return 'These PDFs are too big to read together (Claude reads up to 600 pages at once). ' +
        'Start a new conversation with fewer lecture notes ticked.';
    }
    return `Claude couldn't answer: ${text.replace(/^\d{3}\s*/, '')}`;
  }

  class UserError extends Error {}

  // Uploads (Files API)

  // File ids belong to the API key's organisation, so a different key starts afresh
  function fileCache() {
    const owner = (apiKey() || '').slice(-8);
    const cache = store.json(FILES_STORAGE, null);
    return cache?.owner === owner ? cache : { owner, files: {} };
  }

  const canUpload = () => typeof window.files?.claudeUpload === 'function';

  async function pdfBlob(doc) {
    const blob = await getPdf(doc.key) || await remotePdf(doc.key);
    if (!blob) {
      throw new UserError(`${doc.name} isn't on this device yet. If it was added on another device, ` +
        'open the app there so it can sync, then try again.');
    }
    return blob;
  }

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

  async function uploadedId(doc, onStatus) {
    const blob = await pdfBlob(doc);
    const cache = fileCache();
    const known = cache.files[doc.key];
    if (known && known.size === blob.size && known.name === doc.name) return known.fileId;

    onStatus(`Uploading ${doc.name} (${mb(blob.size)})…`);
    const result = await window.files.claudeUpload({
      apiKey: apiKey(),
      name: unsafeFileChars(doc.name),
      data: await blob.arrayBuffer(),
    });
    if (!result.ok) throw uploadError(result, doc.name);
    // The PDF changed: the old copy isn't needed any more
    if (known) window.files.claudeDelete?.({ apiKey: apiKey(), id: known.fileId });
    cache.files[doc.key] = { fileId: result.id, name: doc.name, size: blob.size };
    store.set(FILES_STORAGE, JSON.stringify(cache));
    return result.id;
  }

  // Website: the PDFs' base64, read from the app's storage for every request (the same bytes
  // each time, so the cache still matches)
  async function inlineData(docs) {
    const blobs = await Promise.all(docs.map(pdfBlob));
    const total = blobs.reduce((n, b) => n + b.size, 0);
    if (total > INLINE_LIMIT) {
      const biggest = docs[blobs.indexOf(blobs.reduce((a, b) => (b.size > a.size ? b : a)))];
      throw new UserError(`These PDFs add up to ${mb(total)}, more than the website can send at once ` +
        `(about ${mb(INLINE_LIMIT)}). Untick ${biggest.name} and ask again, or use the desktop or ` +
        'Android app, which can upload larger files.');
    }
    return Promise.all(blobs.map(async b => bytesToBase64(new Uint8Array(await b.arrayBuffer()))));
  }

  // What Claude can read for a task: the worksheet always, the rest optional
  function docsFor(task) {
    const course = courseOf(task);
    const docs = [];
    if (task.problemName) {
      docs.push({ key: PDF_KINDS.problem.key(task.id), name: task.problemName, label: 'Worksheet', fixed: true, on: true });
    }
    for (const f of course?.files || []) {
      docs.push({ key: noteKey(course, f), name: f.name, label: 'Lecture notes', on: true });
    }
    if (task.pdfName) {
      docs.push({ key: PDF_KINDS.work.key(task.id), name: pdfName(task, PDF_KINDS.work), label: 'My submission', on: false });
    }
    if (task.markedName) {
      docs.push({ key: PDF_KINDS.marked.key(task.id), name: task.markedName, label: 'Marked work', on: false });
    }
    return docs;
  }

  async function materialBlocks(docs, onStatus) {
    const blocks = [];
    if (canUpload()) {
      for (const doc of docs) {
        blocks.push({
          type: 'document',
          source: { type: 'file', file_id: await uploadedId(doc, onStatus) },
          title: `${doc.label}: ${doc.name}`,
        });
      }
    } else {
      onStatus('Preparing the PDFs…');
      const data = await inlineData(docs);
      docs.forEach((doc, i) => blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: data[i] },
        title: `${doc.label}: ${doc.name}`,
      }));
    }
    // The materials are the expensive, unchanging part: cache them for an hour
    blocks[blocks.length - 1].cache_control = CACHE;
    return blocks;
  }

  // Website conversations are saved without the PDFs' base64 (far too big for this device's
  // storage) and get it back from the app's storage before each request
  function forStorage(messages) {
    return messages.map((m, i) => i > 0 || typeof m.content === 'string' ? m : {
      ...m,
      content: m.content.map(b => b.source?.type === 'base64' ? { ...b, source: { ...b.source, data: null } } : b),
    });
  }

  // `docs`: the conversation's documents in order, as { key, name }
  async function withPdfData(messages, docs) {
    const first = messages[0];
    if (!first || typeof first.content === 'string' || !first.content.some(b => b.source?.data === null)) {
      return messages;
    }
    const data = await inlineData(docs);
    let i = 0;
    const content = first.content.map(b => b.source?.data === null
      ? { ...b, source: { ...b.source, data: data[i++] } }
      : b);
    return [{ ...first, content }, ...messages.slice(1)];
  }

  const costOf = usage => (
    (usage.input_tokens || 0) * PRICE.input +
    (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
    (usage.cache_read_input_tokens || 0) * PRICE.cacheRead +
    (usage.output_tokens || 0) * PRICE.output
  ) / 1e6;

  // Connect (API key)

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
        await client().messages.countTokens({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }] });
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

  function buildChat(task) {
    const storageKey = CHAT_PREFIX + task.id;
    const chat = store.json(storageKey, null) || { docs: null, messages: [] };
    const docs = docsFor(task);
    // A conversation keeps the materials it started with
    if (chat.messages.length && chat.docs) {
      for (const d of docs) d.on = d.fixed || chat.docs.includes(d.key);
    }
    let busy = false;

    const modal = el('div', 'modal claude-modal');
    const box = el('div', 'modal-box claude-chat');
    const head = el('div', 'modal-head');
    const title = el('h2', null, taskTitle(task));
    const newChat = button('New conversation', 'secondary', () => {
      if (busy || (chat.messages.length && !confirm('Start a new conversation? This one will be cleared.'))) return;
      store.set(storageKey, null);
      chatModal.remove();
      chatModal = buildChat(task);
      document.body.append(chatModal);
    });
    head.append(title, el('div', 'claude-head-actions'));
    head.lastChild.append(newChat, button('Close', 'secondary', closeChat));

    // Which PDFs Claude reads
    const materials = el('div', 'claude-materials');
    const locked = chat.messages.length > 0;
    for (const d of docs) {
      const label = el('label', 'claude-doc');
      const tick = el('input');
      tick.type = 'checkbox';
      tick.checked = d.on;
      tick.disabled = d.fixed || locked;
      tick.addEventListener('change', () => (d.on = tick.checked));
      label.append(tick, el('span', null, `${d.label}: ${d.name}`));
      materials.append(label);
    }
    const lockNote = el('div', 'claude-note', locked
      ? 'To change what Claude reads, start a new conversation.'
      : 'Lecture notes can be large: each first question reads them in full, then they\'re cached for an hour.');
    materials.append(lockNote);

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

    function bubble(role, html, note) {
      const b = el('div', `claude-msg ${role}`);
      const body = el('div', 'claude-body');
      body.innerHTML = html;
      b.append(body);
      if (note) b.append(el('div', 'claude-note', note));
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
          'Ask anything about this worksheet. Claude reads the PDFs ticked above and answers from them.'));
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

      try {
        const api = client();
        let messages;
        if (!chat.messages.length) {
          const chosen = docs.filter(d => d.on);
          const blocks = await materialBlocks(chosen, onStatus);
          messages = [{ role: 'user', content: [...blocks, { type: 'text', text: question }] }];
          chat.docs = chosen.map(d => d.key);
          materials.querySelectorAll('input').forEach(b => (b.disabled = true));
          lockNote.textContent = 'To change what Claude reads, start a new conversation.';
        } else {
          const conversationDocs = chat.docs.map(key => docs.find(d => d.key === key) || { key, name: 'A PDF' });
          messages = [...await withPdfData(chat.messages, conversationDocs), { role: 'user', content: question }];
        }
        onStatus('Claude is reading and thinking…');

        // Server-side fallbacks: if Claude Opus 5.5's safeguards decline, the request is
        // re-run on Anthropic's recommended fallback model instead of failing
        const stream = api.beta.messages.stream({
          model: MODEL,
          max_tokens: 32000,
          system: SYSTEM,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          cache_control: CACHE,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
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
          if (!chat.messages.length) chat.docs = null;
        } else {
          body.innerHTML = renderAnswer(textOf(final.content));
          // The full content goes back unchanged on the next question, thinking blocks included
          chat.messages = forStorage([...messages, { role: 'assistant', content: final.content }]);
          if (!store.set(storageKey, JSON.stringify(chat))) {
            onStatus('This conversation is too big to save on this device, but you can keep asking now.');
          }
          const secs = Math.round((Date.now() - started) / 1000);
          const cut = final.stop_reason === 'max_tokens' ? ' The answer was cut off at the length limit.' : '';
          answer.append(el('div', 'claude-note', `≈ ${dollars(costOf(final.usage))} · ${secs}s${cut}`));
        }
        if (!status.textContent.startsWith('This conversation')) status.textContent = '';
      } catch (err) {
        body.textContent = explain(err);
        answer.classList.add('error');
        status.textContent = '';
        // Nothing was saved, so the question can just be asked again
        if (!chat.messages.length) chat.docs = null;
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
  };

  render();
})();

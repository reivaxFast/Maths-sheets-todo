// Sync across devices through Supabase, once signed in.
//
// Everything is still saved locally first, so the app works offline. Each save sends what
// changed, and changes made on other devices arrive live (or on the next pull). When the same
// task or course was edited on two devices, the newer edit wins. PDFs are uploaded to storage
// and downloaded on other devices the first time they're opened.

const SUPABASE_URL = 'https://ssvuujysnypxtalyvopg.supabase.co';
// The publishable key is meant to be public: the database rules keep each user's data private
const SUPABASE_KEY = 'sb_publishable_Kzc44pgNpZGmAVZZZ4PbCg_A0vNZwb4';
const PDF_BUCKET = 'pdfs';
const RETRY_SECONDS = 15;
const PAGE_SIZE = 1000;

const cloud = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// The synced lists, read through functions since `courses` is sometimes replaced
const SYNCED = { tasks: () => tasks, courses: () => courses };

// What this device last sent or received, so a save can tell what changed:
// { userId, tasks: { [id]: { json, at, dirty, deleted } }, courses: { ... }, pdfs: { [key]: name } }
// `at` is when the item was last edited, `dirty` means it hasn't been sent yet,
// and `pdfs` holds the PDFs known to be in storage.
let syncState = loadSyncState();
let user = null;
let channel = null;
let syncError = false;
let pulling = false;
let pushing = false;
let pdfsRunning = false;
let pdfsAgain = false;
let pushTimer;
let retryTimer;

function loadSyncState() {
  try {
    const state = JSON.parse(localStorage.getItem('sync'));
    return state?.userId ? state : null;
  } catch {
    return null;
  }
}

function storeSyncState() {
  if (syncState) localStorage.setItem('sync', JSON.stringify(syncState));
  else localStorage.removeItem('sync');
}

const hasDirty = () => Object.keys(SYNCED).some(t => Object.values(syncState[t]).some(e => e.dirty));

// Called by save(): marks new, edited and deleted items to be sent
function syncChanged() {
  if (!user) return;
  const now = Date.now();
  for (const [table, items] of Object.entries(SYNCED)) {
    const known = syncState[table];
    const present = new Set();
    for (const item of items()) {
      const id = String(item.id);
      const json = JSON.stringify(item);
      const entry = known[id];
      present.add(id);
      if (!entry || entry.deleted || entry.json !== json) {
        // Always later than the last edit, even if this computer's clock is behind
        known[id] = { json, at: Math.max(now, (entry?.at || 0) + 1), dirty: true, deleted: false };
      }
    }
    // Deleted items are kept as deleted, so other devices remove them too
    for (const [id, entry] of Object.entries(known)) {
      if (!present.has(id) && !entry.deleted) {
        known[id] = { json: entry.json, at: Math.max(now, entry.at + 1), dirty: true, deleted: true };
      }
    }
  }
  storeSyncState();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 400);
  syncPdfs();
  showSyncStatus();
}

// Applies a row from the server; returns true if the local lists changed.
// An item this device has never synced takes the server's version.
function applyRemote(table, row) {
  const at = Date.parse(row.updated_at);
  const entry = syncState[table][row.id];
  if (entry && entry.at >= at) return false; // Already have this edit, or a newer local one

  const list = SYNCED[table]();
  const index = list.findIndex(item => String(item.id) === row.id);
  remotePdfs(table, index >= 0 ? list[index] : null, row.deleted ? null : row.data);
  if (row.deleted) {
    if (index >= 0) list.splice(index, 1);
  } else if (index >= 0) {
    list[index] = row.data;
  } else {
    list.push(row.data);
  }
  syncState[table][row.id] = { json: JSON.stringify(row.data), at, dirty: false, deleted: row.deleted };
  return true;
}

// taskPdfs and coursePdfs come from script.js, which loads after this file
const pdfsOf = (table, item) => (table === 'tasks' ? taskPdfs : coursePdfs)(item);

// Keeps PDF records in step with an item changed on another device. A PDF removed or
// replaced there is dropped here too, so the new one is downloaded when it's opened.
function remotePdfs(table, oldItem, newItem) {
  const before = oldItem ? pdfsOf(table, oldItem) : new Map();
  const after = newItem ? pdfsOf(table, newItem) : new Map();
  for (const [key, name] of before) {
    if (after.get(key) !== name) {
      deletePdf(key).catch(() => {});
      delete syncState.pdfs[key];
    }
  }
  for (const [key, name] of after) syncState.pdfs[key] = name;
}

async function pull() {
  let changed = false;
  for (const table of Object.keys(SYNCED)) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await cloud.from(table)
        .select('id, data, updated_at, deleted')
        .order('id')
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!user) return false; // Signed out meanwhile
      for (const row of data) if (applyRemote(table, row)) changed = true;
      if (data.length < PAGE_SIZE) break;
    }
  }
  return changed;
}

// Brings down other devices' changes, then sends this device's
async function pullAndPush() {
  if (!user || pulling) return;
  pulling = true;
  showSyncStatus();
  try {
    const changed = await pull();
    if (user) {
      syncError = false;
      save(); // Saves what arrived and sends anything not sent yet
      if (changed) render();
    }
  } catch {
    failed();
  } finally {
    pulling = false;
    showSyncStatus();
  }
}

async function push() {
  if (!user || pushing) return;
  pushing = true;
  showSyncStatus();
  try {
    for (const table of Object.keys(SYNCED)) {
      const dirty = Object.entries(syncState[table]).filter(([, e]) => e.dirty);
      if (dirty.length === 0) continue;
      const { error } = await cloud.from(table).upsert(dirty.map(([id, e]) => ({
        user_id: user.id,
        id,
        data: JSON.parse(e.json),
        updated_at: new Date(e.at).toISOString(),
        deleted: e.deleted,
      })));
      if (error) throw error;
      if (!user) return;
      // An item edited again while sending stays dirty and goes in the next push
      for (const [id, e] of dirty) if (syncState[table][id] === e) e.dirty = false;
      storeSyncState();
    }
    syncError = false;
  } catch {
    failed();
  } finally {
    pushing = false;
    if (user && !syncError && hasDirty()) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(push, 400);
    }
    showSyncStatus();
  }
}

// Offline or the server couldn't be reached: everything is tried again shortly
function failed() {
  syncError = true;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(pullAndPush, RETRY_SECONDS * 1000);
}

// PDFs
//
// Local keys can be numbers (submissions use the plain task id), but `syncState.pdfs` is
// saved as JSON, so its keys are always strings.

// Files live in a folder named after the user, which the storage rules require
const pdfPath = key => `${user.id}/${String(key).replaceAll(':', '-')}`;

// Files over the storage size limit are skipped (and reported once) rather than retried forever
const tooBig = new Set();
const isTooBig = error => String(error.statusCode ?? error.status) === '413' || /size/i.test(error.message);

// Uploads PDFs attached here, and removes uploaded ones that are no longer attached
async function syncPdfs() {
  if (!user) return;
  if (pdfsRunning) {
    pdfsAgain = true;
    return;
  }
  pdfsRunning = true;
  try {
    const refs = storedPdfs();
    for (const [key, name] of refs) {
      if (syncState.pdfs[key] === name || tooBig.has(String(key))) continue;
      const blob = await getPdf(key);
      if (!blob) continue;
      const { error } = await cloud.storage.from(PDF_BUCKET)
        .upload(pdfPath(key), blob, { upsert: true, contentType: 'application/pdf' });
      if (error && isTooBig(error)) {
        tooBig.add(String(key));
        showMessage(`${name} is too large to sync. It stays on this computer only.`, true);
        continue;
      }
      if (error) throw error;
      if (!user) return;
      syncState.pdfs[key] = name;
      storeSyncState();
    }
    const wanted = new Set([...refs.keys()].map(String));
    for (const key of Object.keys(syncState.pdfs)) {
      if (wanted.has(key)) continue;
      delete syncState.pdfs[key];
      // Waits out the undo window, so undoing a delete still has the uploaded copy
      setTimeout(() => {
        const stillWanted = [...storedPdfs().keys()].some(k => String(k) === key);
        if (user && !stillWanted) cloud.storage.from(PDF_BUCKET).remove([pdfPath(key)]);
      }, (UNDO_SECONDS + 2) * 1000);
    }
    storeSyncState();
  } catch {
    failed();
  } finally {
    pdfsRunning = false;
    showSyncStatus();
    if (pdfsAgain) {
      pdfsAgain = false;
      syncPdfs();
    }
  }
}

// A PDF attached on another device is downloaded the first time it's needed, then kept here
async function remotePdf(key) {
  if (!user) return null;
  const { data, error } = await cloud.storage.from(PDF_BUCKET).download(pdfPath(key));
  if (error) return null;
  const blob = new Blob([data], { type: 'application/pdf' });
  await putPdf(key, blob).catch(() => {});
  return blob;
}

// Starting and stopping

function startSync(session) {
  user = session.user;
  // A different account starts from scratch, so one account's data never mixes into another's
  if (syncState?.userId !== user.id) {
    syncState = { userId: user.id, tasks: {}, courses: {}, pdfs: {} };
    storeSyncState();
  }
  channel = cloud.channel('sync-' + user.id);
  for (const table of Object.keys(SYNCED)) {
    channel.on('postgres_changes',
      { event: '*', schema: 'public', table, filter: `user_id=eq.${user.id}` },
      payload => {
        if (payload.new?.id && applyRemote(table, payload.new)) {
          save();
          render();
        }
      });
  }
  // Pulls again whenever the live connection (re)connects, to catch anything missed
  channel.subscribe(status => {
    if (status === 'SUBSCRIBED') pullAndPush();
  });
  pullAndPush();
}

function stopSync() {
  if (channel) cloud.removeChannel(channel);
  channel = null;
  user = null;
  syncState = null;
  syncError = false;
  storeSyncState();
  clearTimeout(pushTimer);
  clearTimeout(retryTimer);
  showSyncStatus();
}

// Called once script.js has loaded the lists
function startCloud() {
  if (!cloud) {
    syncBtn.hidden = true; // Supabase library missing: the app works as before, unsynced
    return;
  }
  cloud.auth.onAuthStateChange((event, session) => {
    // Supabase asks that other calls wait until this callback has returned
    setTimeout(() => {
      if (session && !user) startSync(session);
      else if (!session && user) stopSync();
      else if (session) user = session.user;
      showSyncStatus();
    });
  });
  window.addEventListener('online', pullAndPush);
  window.addEventListener('offline', showSyncStatus);
}

// Sign-in dialog

const syncBtn = document.getElementById('sync-btn');
const syncModal = document.getElementById('sync-modal');
const emailForm = document.getElementById('email-form');
const codeForm = document.getElementById('code-form');
const accountBox = document.getElementById('account');
const syncErrorText = document.getElementById('sync-error');
let signInEmail = '';

function showSyncStatus() {
  let text = 'Sign in to sync';
  let detail = '';
  if (user) {
    if (syncError || !navigator.onLine) {
      text = 'Offline';
      detail = "Can't reach the server. Changes are saved here and will sync when you're back online.";
    } else if (pulling || pushing || pdfsRunning || hasDirty()) {
      text = 'Syncing…';
      detail = 'Syncing your changes…';
    } else {
      text = 'Synced';
      detail = 'Everything is synced.';
    }
  }
  syncBtn.textContent = text;
  syncBtn.className = user ? (text === 'Synced' ? 'synced' : text === 'Offline' ? 'offline' : 'syncing') : '';
  syncBtn.title = user ? `Signed in as ${user.email}` : 'Sync your tasks across devices';
  document.getElementById('account-email').textContent = user?.email || '';
  document.getElementById('account-status').textContent = detail;
}

function showSyncError(text) {
  syncErrorText.textContent = text;
  syncErrorText.hidden = !text;
}

function openSync() {
  showSyncError('');
  emailForm.hidden = !!user || !!signInEmail;
  codeForm.hidden = !!user || !signInEmail;
  accountBox.hidden = !user;
  document.getElementById('sync-title').textContent = user ? 'Sync' : 'Sign in to sync';
  syncModal.hidden = false;
  if (!user) (signInEmail ? codeBoxes[0] : document.getElementById('sync-email')).focus();
}

// The code is typed into one box per digit. Typing moves on to the next box, Backspace
// goes back, pasting fills them all, and filling the last box signs in.
const CODE_LENGTH = 6;
const codeBoxes = Array.from({ length: CODE_LENGTH }, (_, i) => {
  const box = document.createElement('input');
  box.type = 'text';
  box.inputMode = 'numeric';
  box.maxLength = 1;
  box.autocomplete = i === 0 ? 'one-time-code' : 'off';
  box.ariaLabel = `Digit ${i + 1}`;
  document.getElementById('code-boxes').append(box);
  return box;
});
const codeValue = () => codeBoxes.map(b => b.value).join('');

function fillCode(digits, from) {
  for (const [i, digit] of [...digits].slice(0, CODE_LENGTH - from).entries()) codeBoxes[from + i].value = digit;
  const next = codeBoxes.find(b => !b.value);
  (next || codeBoxes[CODE_LENGTH - 1]).focus();
  if (!next) codeForm.requestSubmit();
}

codeBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    const digits = box.value.replace(/\D/g, '');
    box.value = '';
    if (digits) fillCode(digits, i);
  });
  box.addEventListener('paste', e => {
    e.preventDefault();
    fillCode(e.clipboardData.getData('text').replace(/\D/g, ''), 0);
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      codeBoxes[i - 1].value = '';
      codeBoxes[i - 1].focus();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      codeBoxes[i - 1].focus();
    } else if (e.key === 'ArrowRight' && i < CODE_LENGTH - 1) {
      codeBoxes[i + 1].focus();
    }
  });
  box.addEventListener('focus', () => box.select());
});

function clearCode() {
  codeBoxes.forEach(b => (b.value = ''));
}

function closeSync() {
  syncModal.hidden = true;
}

syncBtn.addEventListener('click', openSync);
document.getElementById('sync-close').addEventListener('click', closeSync);
syncModal.addEventListener('click', e => {
  if (e.target === syncModal) closeSync();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !syncModal.hidden) closeSync();
});

emailForm.addEventListener('submit', async e => {
  e.preventDefault();
  const button = emailForm.querySelector('button');
  const email = document.getElementById('sync-email').value.trim();
  button.disabled = true;
  showSyncError('');
  // Makes the account the first time an email is used, so there's no separate sign-up
  const { error } = await cloud.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  button.disabled = false;
  if (error) {
    showSyncError(navigator.onLine
      ? `Couldn't send a code: ${error.message}`
      : "You're offline. Connect to the internet to sign in.");
    return;
  }
  signInEmail = email;
  document.getElementById('code-sent').textContent =
    `We sent a sign-in code to ${email}. It can take a minute, and check your spam folder if it doesn't arrive.`;
  openSync();
});

codeForm.addEventListener('submit', async e => {
  e.preventDefault();
  const button = codeForm.querySelector('button[type=submit]');
  const code = codeValue();
  if (code.length < CODE_LENGTH) {
    showSyncError(`Enter all ${CODE_LENGTH} digits of the code.`);
    codeBoxes.find(b => !b.value).focus();
    return;
  }
  if (button.disabled) return; // Already checking this code
  button.disabled = true;
  showSyncError('');
  const { error } = await cloud.auth.verifyOtp({ email: signInEmail, token: code, type: 'email' });
  button.disabled = false;
  if (error) {
    showSyncError("That code didn't work. Check it, or go back and send a new one.");
    clearCode();
    codeBoxes[0].focus();
    return;
  }
  signInEmail = '';
  clearCode();
  closeSync();
  showMessage('Signed in. Your tasks will now sync.');
});

document.getElementById('code-back').addEventListener('click', () => {
  signInEmail = '';
  clearCode();
  openSync();
});

async function signOut(clear) {
  if (hasDirty() && !confirm("Some changes haven't synced yet and won't reach your account. Sign out anyway?")) return;
  if (clear && !confirm('Remove all tasks, courses and PDFs from this computer? They stay in your account.')) return;
  // Only this device: other devices stay signed in
  await cloud.auth.signOut({ scope: 'local' });
  stopSync();
  if (clear) {
    tasks.length = 0;
    courses.length = 0;
    save();
    render();
    cleanUpPdfs();
  }
  closeSync();
  showMessage(clear ? 'Signed out and removed your data from this computer.' : 'Signed out. Your tasks stay on this computer.');
}

document.getElementById('sign-out').addEventListener('click', () => signOut(false));
document.getElementById('sign-out-clear').addEventListener('click', () => signOut(true));

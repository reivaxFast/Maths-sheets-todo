const STATUSES = [
  { id: 'mostly', label: 'Mostly complete' },
  { id: 'complete', label: 'Complete' },
  { id: 'submitted', label: 'Submitted' },
];

const form = document.getElementById('add-form');
const sheetInput = document.getElementById('task-sheet');
const dueInput = document.getElementById('task-due');
const timeInput = document.getElementById('task-time');
const courseSelect = document.getElementById('task-course');
// "Mostly complete" and no status both count as incomplete
const SECTIONS = ['incomplete', 'complete', 'submitted'];
const NEW_COURSE = '__new';

function sectionOf(task) {
  return task.status === 'complete' || task.status === 'submitted' ? task.status : 'incomplete';
}

let tasks = load('tasks');
let courses = load('courses');

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function save() {
  localStorage.setItem('tasks', JSON.stringify(tasks));
  localStorage.setItem('courses', JSON.stringify(courses));
  syncChanged();
}

// Timestamp-based ids with random last digits, so items made at the same moment on two
// synced devices don't collide, bumped so two made here in one millisecond don't either
let lastId = 0;
function nextId() {
  lastId = Math.max(Date.now() * 1000 + Math.floor(Math.random() * 1000), lastId + 1);
  return lastId;
}

function courseOf(task) {
  return courses.find(c => c.id === task.courseId) || null;
}

// Each task can hold three PDFs. `field` is the task property holding the file name;
// submissions are keyed by plain task id (as before), the others by "id:problem" and "id:marked".
// Marked work can only be added once the task is submitted (`afterSubmit`).
// `scannable` kinds get a Scan button in the Android app.
const PDF_KINDS = {
  problem: { field: 'problemName', key: id => `${id}:problem`, icon: '📋', label: 'Problem sheet' },
  work: { field: 'pdfName', key: id => id, icon: '📄', label: 'Submission', scannable: true },
  marked: { field: 'markedName', key: id => `${id}:marked`, icon: '✅', label: 'Marked work', afterSubmit: true, scannable: true },
};

function pdfKeys(task) {
  return Object.values(PDF_KINDS).filter(k => task[k.field]).map(k => k.key(task.id));
}

// Courses hold any number of notes PDFs in `files` ([{ id, name }]), keyed by "courseId:notes:fileId"
const noteKey = (course, file) => `${course.id}:notes:${file.id}`;

// The PDFs an item refers to, as a Map of storage key to file name
function taskPdfs(task) {
  return new Map(Object.values(PDF_KINDS).filter(k => task[k.field]).map(k => [k.key(task.id), task[k.field]]));
}
function coursePdfs(course) {
  return new Map((course.files || []).map(f => [noteKey(course, f), f.name]));
}
function storedPdfs() {
  return new Map([...tasks.flatMap(t => [...taskPdfs(t)]), ...courses.flatMap(c => [...coursePdfs(c)])]);
}

// PDFs are too large for localStorage, so they live in IndexedDB
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('todo-files', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('pdfs');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function pdfStore(mode, fn) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction('pdfs', mode).objectStore('pdfs'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const putPdf = (id, file) => pdfStore('readwrite', s => s.put(file, id));
const getPdf = id => pdfStore('readonly', s => s.get(id));
const deletePdf = id => pdfStore('readwrite', s => s.delete(id));

const pdfInput = document.createElement('input');
pdfInput.type = 'file';
pdfInput.accept = 'application/pdf,.pdf';
let pdfTarget = null; // { task, kind }

pdfInput.addEventListener('change', async () => {
  const file = pdfInput.files[0];
  pdfInput.value = '';
  if (!file || !pdfTarget) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showMessage('Please choose a PDF file.', true);
    return;
  }
  await storePdf(pdfTarget.task, pdfTarget.kind, file, file.name);
});

async function storePdf(task, kind, blob, name) {
  try {
    await putPdf(kind.key(task.id), blob);
  } catch {
    showMessage("Couldn't save that PDF.", true);
    return false;
  }
  task[kind.field] = name;
  save();
  render();
  return true;
}

// Android only: scans paper with the camera into a PDF (see mobile.js)
async function scanPdf(task, kind) {
  const result = await window.files.scanPdf(status => showMessage(status));
  if (!result.ok) {
    if (!result.cancelled) showMessage(result.error || "Couldn't scan. Please try again.", true);
    return;
  }
  const blob = new Blob([result.data], { type: 'application/pdf' });
  if (await storePdf(task, kind, blob, scanName(task, kind))) {
    showMessage(`Scanned ${result.pages} page${result.pages === 1 ? '' : 's'} as ${pdfName(task, kind)}`);
  }
}

// Saves a copy under its shown name (desktop: a Save dialog), or on Android opens the share
// sheet, e.g. to upload a submission with the course's file name
async function savePdfCopy(key, name) {
  const blob = await getPdf(key) || await remotePdf(key);
  if (!blob) {
    showMessage("That PDF couldn't be found.", true);
    return;
  }
  if (window.files?.sharePdf) {
    const result = await window.files.sharePdf(name, await blob.arrayBuffer());
    if (!result.ok) showMessage("Couldn't share that PDF.", true);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const notesInput = document.createElement('input');
notesInput.type = 'file';
notesInput.accept = 'application/pdf,.pdf';
notesInput.multiple = true;
let notesCourse = null;

notesInput.addEventListener('change', async () => {
  const files = [...notesInput.files];
  notesInput.value = '';
  if (!notesCourse) return;
  const pdfs = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (pdfs.length < files.length) showMessage('Only PDF files can be added as course notes.', true);
  notesCourse.files ||= [];
  for (const file of pdfs) {
    const entry = { id: nextId(), name: file.name };
    try {
      await putPdf(noteKey(notesCourse, entry), file);
    } catch {
      showMessage(`Couldn't save ${file.name}.`, true);
      continue;
    }
    notesCourse.files.push(entry);
  }
  save();
  render();
});

async function openPdf(key, name) {
  // Not here yet if it was attached on another device
  const blob = await getPdf(key) || await remotePdf(key);
  if (!blob) {
    showMessage(user
      ? "That PDF couldn't be found. If it was added on another device, try again once that device has synced."
      : "That PDF couldn't be found.", true);
    return;
  }
  if (window.files) {
    // In the app: saved to a temp file and opened in the default browser
    const result = await window.files.openPdf(name, await blob.arrayBuffer());
    if (!result.ok) showMessage("Couldn't open that PDF in your browser.", true);
  } else {
    // Running in a plain browser (e.g. testing): open in a new tab
    window.open(URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })));
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !coursesModal.hidden) closeCourses();
});

function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = v => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// "YYYY-MM-DD HH:MM" strings sort and compare correctly as text.
// Tasks from before times were added count as due at the end of the day.
function dueKey(task) {
  return `${task.due} ${task.time || '23:59'}`;
}

function nowKey() {
  const d = new Date();
  return `${today()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Tasks are sheets ("Maths – Sheet 3"); older tasks from before sheets keep their typed text
function taskTitle(task) {
  if (!task.sheet) return task.text;
  return `${courseOf(task)?.name || 'No course'} – Sheet ${task.sheet}`;
}

// A course's file name format, e.g. "Xavier_Howard_IntroCalculus_{sheet}.pdf".
// {sheet} or {sheet number} is replaced with the task's sheet number.
const SHEET_PLACEHOLDER = /\{\s*sheet(?:\s*(?:number|no\.?|#))?\s*\}/gi;
const unsafeFileChars = name => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');

function formatFileName(format, sheet) {
  const name = unsafeFileChars(format.replace(SHEET_PLACEHOLDER, sheet)).trim();
  return /\.pdf$/i.test(name) ? name : name + '.pdf';
}

// The name a PDF is shown, opened, saved and shared under. Submissions use the course's
// format when it has one, so changing the format renames every submission in the course.
function pdfName(task, kind) {
  const uploaded = task[kind.field];
  const format = courseOf(task)?.fileFormat;
  if (uploaded && kind === PDF_KINDS.work && format && task.sheet) return formatFileName(format, task.sheet);
  return uploaded;
}

// Email templates. Each course can set its own subject and body; these are used otherwise.
// Tags are filled in when the email is drafted (case doesn't matter).
const DEFAULT_EMAIL_SUBJECT = '{Course} – {SheetLabel}';
const DEFAULT_EMAIL_BODY = 'Dear {TutorFirstName},\n\nPlease find attached my work for {SheetLabel}.\n\nBest wishes,';
const EMAIL_TAGS = '{TutorFirstName} {TutorSurname} {TutorName} {Course} {Sheets} (e.g. "3 and 4") {SheetLabel} (e.g. "Sheets 3 and 4")';
const TITLES = /^(dr|prof|professor|mr|mrs|ms|miss|mx|sir|dame)\.?$/i;

// "Dr Jane Smith" → { first: 'Jane', surname: 'Smith' }. With only one name besides a
// title ("Dr Smith"), both tags use it.
function tutorNames(tutor) {
  const words = String(tutor || '').trim().split(/\s+/).filter(Boolean);
  const names = words.filter(w => !TITLES.test(w));
  const use = names.length ? names : words;
  return { first: use[0] || '', surname: use[use.length - 1] || '' };
}

// "3", "3 and 4", "3, 4 and 5"
function joinSheets(sheets) {
  const sorted = [...sheets].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return sorted.length < 2 ? sorted.join('') : `${sorted.slice(0, -1).join(', ')} and ${sorted.at(-1)}`;
}

function fillTemplate(template, course, sheets) {
  const { first, surname } = tutorNames(course.tutor);
  const values = {
    tutorfirstname: first,
    tutorsurname: surname,
    tutorname: course.tutor,
    course: course.name,
    sheets: joinSheets(sheets),
    sheet: joinSheets(sheets),
    sheetlabel: `${sheets.length === 1 ? 'Sheet' : 'Sheets'} ${joinSheets(sheets)}`,
  };
  // Spaces are ignored and "Tutur" is read as "Tutor", so small typos in a tag still work
  return template.replace(/\{\s*([a-z ]+?)\s*\}/gi, (tag, word) => {
    const key = word.replace(/\s+/g, '').toLowerCase().replace(/^tutur/, 'tutor');
    return values[key] ?? tag;
  });
}

const emailSubject = (course, sheets) => fillTemplate(course.emailSubject || DEFAULT_EMAIL_SUBJECT, course, sheets);
const emailBody = (course, sheets) => fillTemplate(course.emailBody || DEFAULT_EMAIL_BODY, course, sheets);

// Name for a scanned PDF, before the course's format (if any) is applied
function scanName(task, kind) {
  const suffix = kind === PDF_KINDS.work ? '' : ` ${kind.label.toLowerCase()}`;
  return unsafeFileChars(`${taskTitle(task)}${suffix}.pdf`);
}

function courseOptions(select, selectedId, withNew) {
  select.innerHTML = '';
  // In the add form the empty option is a prompt, and the form requires a real course
  select.append(new Option(withNew ? 'Choose course…' : 'No course', ''));
  for (const c of [...courses].sort((a, b) => a.name.localeCompare(b.name))) {
    select.append(new Option(c.name, c.id));
  }
  if (withNew) select.append(new Option('+ New course…', NEW_COURSE));
  select.value = courses.some(c => c.id === selectedId) ? selectedId : '';
}

function render() {
  const counts = {};
  for (const section of SECTIONS) {
    document.getElementById('list-' + section).innerHTML = '';
    counts[section] = 0;
  }

  const sorted = [...tasks].sort((a, b) => dueKey(a).localeCompare(dueKey(b)));
  for (const task of sorted) {
    const section = sectionOf(task);
    counts[section]++;

    const li = document.createElement('li');
    li.className = 'task' + (task.status ? ` status-${task.status}` : '');
    if (dueKey(task) < nowKey() && task.status !== 'submitted') li.classList.add('overdue');
    li.classList.toggle('selected', selected.has(task.id));

    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'task-pick';
    pick.title = 'Select, e.g. to email several sheets to the tutor at once';
    pick.checked = selected.has(task.id);
    pick.addEventListener('change', () => {
      if (pick.checked) selected.add(task.id);
      else selected.delete(task.id);
      li.classList.toggle('selected', pick.checked);
      renderSelection();
    });
    li.append(pick);

    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = taskTitle(task);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const due = document.createElement('span');
    due.className = 'due';
    due.textContent = 'Due ' + formatDate(task.due) + (task.time ? ', ' + formatTime(task.time) : '');
    const course = document.createElement('select');
    course.className = 'course-tag';
    course.title = 'Course';
    courseOptions(course, task.courseId, false);
    course.addEventListener('change', () => {
      task.courseId = course.value || null;
      save();
      render();
    });
    meta.append(due, course);
    info.append(title, meta);

    const courseNotes = courseOf(task)?.notes;
    if (courseNotes) {
      // Shows one line until clicked, then the full notes
      const notes = document.createElement('div');
      notes.className = 'task-notes';
      notes.title = 'Click to show all';
      notes.textContent = courseNotes;
      notes.addEventListener('click', () => notes.classList.toggle('expanded'));
      info.append(notes);
    }

    const pdf = document.createElement('div');
    pdf.className = 'pdf';
    for (const kind of Object.values(PDF_KINDS)) {
      const name = pdfName(task, kind);
      if (name) {
        const view = document.createElement('button');
        view.className = 'pdf-link';
        view.title = `${kind.label}: ${name}` +
          (name !== task[kind.field] ? ` (uploaded as ${task[kind.field]})` : '');
        view.textContent = `${kind.icon} ${name}`;
        view.addEventListener('click', () => openPdf(kind.key(task.id), name));
        pdf.append(view);
        if (kind === PDF_KINDS.work) {
          const copy = document.createElement('button');
          copy.className = 'pdf-save';
          copy.textContent = window.files?.sharePdf ? 'Share' : 'Save';
          copy.title = window.files?.sharePdf ? `Share as ${name}` : `Save a copy as ${name}`;
          copy.addEventListener('click', () => savePdfCopy(kind.key(task.id), name));
          pdf.append(copy);
        }
        const remove = document.createElement('button');
        remove.className = 'pdf-remove';
        remove.title = `Remove ${kind.label.toLowerCase()}`;
        remove.textContent = '×';
        remove.addEventListener('click', async () => {
          await deletePdf(kind.key(task.id));
          delete task[kind.field];
          save();
          render();
        });
        pdf.append(remove);
      } else if (!kind.afterSubmit || task.status === 'submitted') {
        const attach = document.createElement('button');
        attach.className = 'pdf-attach';
        attach.textContent = `+ ${kind.label}`;
        attach.addEventListener('click', () => {
          pdfTarget = { task, kind };
          pdfInput.click();
        });
        pdf.append(attach);
        if (kind.scannable && window.files?.scanPdf) {
          const scan = document.createElement('button');
          scan.className = 'pdf-attach pdf-scan';
          scan.textContent = '📷 Scan';
          scan.title = `Scan your ${kind.label.toLowerCase()} with the camera`;
          scan.addEventListener('click', () => scanPdf(task, kind));
          pdf.append(scan);
        }
      }
    }
    info.append(pdf);

    // The course's notes, so they can be opened straight from the task (added in Courses)
    const taskCourse = courseOf(task);
    if (taskCourse?.files?.length) {
      const notesRow = document.createElement('div');
      notesRow.className = 'pdf task-course-notes';
      for (const file of taskCourse.files) {
        const view = document.createElement('button');
        view.className = 'pdf-link';
        view.title = `Course notes: ${file.name}`;
        view.textContent = `📚 ${file.name}`;
        view.addEventListener('click', () => openPdf(noteKey(taskCourse, file), file.name));
        notesRow.append(view);
      }
      info.append(notesRow);
    }

    const options = document.createElement('div');
    options.className = 'options';
    for (const s of STATUSES) {
      const btn = document.createElement('button');
      btn.textContent = s.label;
      btn.className = 'opt opt-' + s.id + (task.status === s.id ? ' active' : '');
      // Clicking the active option again clears it
      btn.addEventListener('click', () => {
        task.status = task.status === s.id ? null : s.id;
        save();
        render();
        if (task.status === 'submitted') showMessage(`✓ ${taskTitle(task)} submitted`);
      });
      options.append(btn);
    }

    const del = document.createElement('button');
    del.className = 'delete';
    del.title = 'Delete task';
    del.textContent = '×';
    del.addEventListener('click', () => deleteTask(task));

    li.append(info, options, del);
    document.getElementById('list-' + section).append(li);
  }

  for (const section of SECTIONS) {
    document.getElementById('count-' + section).textContent = counts[section];
    if (counts[section] === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing here.';
      document.getElementById('list-' + section).append(li);
    }
  }

  courseOptions(courseSelect, courseSelect.value, true);
  renderCourses();
  renderSelection();
}

// Selecting tasks
//
// Ticked tasks from one course can be emailed to its tutor together, with their
// submissions attached, using the course's email template.

const selected = new Set();
const selectionBar = document.getElementById('selection-bar');
const selectionText = document.getElementById('selection-text');
const draftBtn = document.getElementById('draft-email-btn');

function selectedTasks() {
  return tasks.filter(t => selected.has(t.id));
}

function renderSelection() {
  // Drop tasks that were deleted (here or on another device)
  for (const id of selected) if (!tasks.some(t => t.id === id)) selected.delete(id);
  const picked = selectedTasks();
  selectionBar.hidden = picked.length === 0;
  document.body.classList.toggle('has-selection', picked.length > 0);
  if (!picked.length) return;

  const courseIds = new Set(picked.map(t => t.courseId));
  const course = courseIds.size === 1 ? courseOf(picked[0]) : null;
  let problem = '';
  if (courseIds.size > 1) problem = 'These are from different courses. Pick sheets from one course to email them.';
  else if (!course) problem = "These tasks don't have a course, so there's no tutor to email.";
  else if (!course.email) problem = `${course.name} has no tutor email. Add one in Courses.`;

  selectionText.textContent = problem ||
    `${picked.length} selected · ${course.name} · to ${course.tutor}`;
  selectionBar.classList.toggle('problem', !!problem);
  draftBtn.disabled = !!problem;
}

document.getElementById('clear-selection-btn').addEventListener('click', () => {
  selected.clear();
  render();
});
draftBtn.addEventListener('click', () => draftEmail(selectedTasks()));

// Builds the email from the course's template with each task's submission attached (under
// the course's file name format), and opens it as a draft: in Outlook on desktop, or the
// phone's email app on Android. Nothing is sent; that's left to you.
async function draftEmail(picked) {
  picked = [...picked].sort((a, b) => String(a.sheet || a.text).localeCompare(String(b.sheet || b.text), undefined, { numeric: true }));
  const course = courseOf(picked[0]);
  const sheets = picked.map(t => t.sheet || t.text);
  const attachments = [];
  const missing = [];
  for (const task of picked) {
    const key = PDF_KINDS.work.key(task.id);
    const blob = task.pdfName && (await getPdf(key) || await remotePdf(key));
    if (blob) attachments.push({ name: pdfName(task, PDF_KINDS.work), data: await blob.arrayBuffer() });
    else missing.push(task);
  }
  const email = {
    to: course.email,
    toName: course.tutor,
    subject: emailSubject(course, sheets),
    body: emailBody(course, sheets),
    attachments,
  };

  let result;
  if (window.files?.draftEmail) {
    result = await window.files.draftEmail(email); // Android
  } else if (window.files?.openEmailDraft) {
    result = await window.files.openEmailDraft({ ...email, eml: buildEmail(email) }); // Desktop
  } else {
    // In a plain browser (e.g. testing): download the draft
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buildEmail(email)], { type: 'message/rfc822' }));
    a.download = 'draft.eml';
    a.click();
    URL.revokeObjectURL(a.href);
    result = { ok: true };
  }
  if (!result.ok) {
    showMessage("Couldn't open your email app.", true);
    return;
  }
  // The new Outlook (and most email apps) can't be handed attachments, so the PDFs are put
  // in a folder that opens beside the email
  const dragIn = result.mode === 'mailto' && attachments.length
    ? ` Drag the ${attachments.length === 1 ? 'PDF' : `${attachments.length} PDFs`} from the folder that opened into it.`
    : '';

  const n = picked.length;
  const one = missing.length === 1;
  const note = missing.length
    ? ` ${one ? 'Sheet' : 'Sheets'} ${joinSheets(missing.map(t => t.sheet || t.text))} ${one ? 'has' : 'have'} no submission, so nothing is attached for ${one ? 'it' : 'them'}.`
    : '';
  selected.clear();
  render();
  showMessage(`Email to ${course.tutor} drafted.${dragIn}${note}`, missing.length > 0, {
    label: `Mark ${n === 1 ? 'as' : `${n} as`} submitted`,
    fn: () => {
      for (const t of picked) t.status = 'submitted';
      save();
      render();
    },
  }, 30);
}

// Email file (.eml) for desktop mail apps

function wrapBase64(bytes) {
  return bytesToBase64(bytes).replace(/.{1,76}/g, '$&\r\n');
}

// Encodes a header value so names with accents etc. survive
function encodeHeader(text) {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : '=?UTF-8?B?' + bytesToBase64(new TextEncoder().encode(text)) + '?=';
}

function buildEmail({ to, toName, subject, body, attachments }) {
  const boundary = '----=_worksheets_' + Date.now().toString(36);
  const lines = [
    // Tells Outlook to open this as an unsent draft rather than a received message
    'X-Unsent: 1',
    `To: "${encodeHeader(toName.replace(/"/g, ''))}" <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(new TextEncoder().encode(body.replace(/\r?\n/g, '\r\n'))),
  ];
  for (const a of attachments) {
    const name = encodeHeader(a.name.replace(/"/g, ''));
    lines.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(new Uint8Array(a.data)),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

const UNDO_SECONDS = 8;

// The PDFs are kept until the undo window has passed, so Undo brings them back too
function deleteTask(task) {
  const index = tasks.indexOf(task);
  tasks.splice(index, 1);
  save();
  render();

  const keys = pdfKeys(task);
  const pdfTimer = keys.length
    ? setTimeout(() => keys.forEach(deletePdf), UNDO_SECONDS * 1000 + 500)
    : null;
  showMessage(`Deleted ${taskTitle(task)}`, false, {
    label: 'Undo',
    fn: () => {
      clearTimeout(pdfTimer);
      tasks.splice(Math.min(index, tasks.length), 0, task);
      save();
      render();
    },
  });
}

// Removes PDFs left behind if the app closed during an undo window
async function cleanUpPdfs() {
  const keys = new Set(storedPdfs().keys());
  for (const key of await pdfStore('readonly', s => s.getAllKeys())) {
    if (!keys.has(key)) deletePdf(key);
  }
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const courseId = courseSelect.value;
  const sheet = sheetInput.value.trim();
  if (tasks.some(t => t.courseId === courseId && t.sheet?.toLowerCase() === sheet.toLowerCase())) {
    showMessage(`${courses.find(c => c.id === courseId).name} sheet ${sheet} is already in your list.`, true);
    return;
  }
  tasks.push({
    id: nextId(),
    sheet,
    due: dueInput.value,
    time: timeInput.value,
    status: null,
    courseId,
  });
  // Remembered as the default for the next sheet in this course
  const course = courses.find(c => c.id === courseId);
  course.lastDue = dueInput.value;
  course.lastTime = timeInput.value;
  save();
  render();
  suggestSheet();
  sheetInput.focus();
});

// Pre-fills the next sheet number for the chosen course (one more than the highest so far)
function suggestSheet() {
  const numbers = tasks
    .filter(t => t.courseId === courseSelect.value && /^\d+$/.test(t.sheet || ''))
    .map(t => Number(t.sheet));
  sheetInput.value = courseSelect.value && numbers.length ? Math.max(...numbers) + 1 : '';
}

// When a course is picked, fill in its next sheet and the date and time of its last submission
function applyCourseDefaults() {
  suggestSheet();
  const course = courses.find(c => c.id === courseSelect.value);
  if (course?.lastDue) dueInput.value = course.lastDue;
  if (course?.lastTime) timeInput.value = course.lastTime;
}

// Courses

const coursesModal = document.getElementById('courses-modal');
const courseList = document.getElementById('course-list');
const courseForm = document.getElementById('course-form');
// Set when the modal was opened from "+ New course…", so the new course gets selected
let pickNewCourse = false;

function openCourses(fromPicker) {
  pickNewCourse = fromPicker;
  coursesModal.hidden = false;
  if (fromPicker || courses.length === 0) document.getElementById('course-name').focus();
}

function closeCourses() {
  coursesModal.hidden = true;
  if (courseSelect.value === NEW_COURSE) courseSelect.value = '';
  pickNewCourse = false;
}

document.getElementById('courses-btn').addEventListener('click', () => openCourses(false));
document.getElementById('courses-close').addEventListener('click', closeCourses);
coursesModal.addEventListener('click', e => {
  if (e.target === coursesModal) closeCourses();
});

let lastCourse = '';
courseSelect.addEventListener('focus', () => (lastCourse = courseSelect.value));
courseSelect.addEventListener('change', () => {
  if (courseSelect.value === NEW_COURSE) {
    courseSelect.value = lastCourse;
    openCourses(true);
  } else {
    lastCourse = courseSelect.value;
    applyCourseDefaults();
  }
});

courseForm.addEventListener('submit', e => {
  e.preventDefault();
  const course = {
    id: 'c' + nextId(),
    name: document.getElementById('course-name').value.trim(),
    tutor: document.getElementById('course-tutor').value.trim(),
    email: document.getElementById('course-email').value.trim(),
    notes: document.getElementById('course-notes').value.trim(),
    fileFormat: document.getElementById('course-format').value.trim(),
  };
  courses.push(course);
  save();
  courseForm.reset();
  render();
  if (pickNewCourse) {
    courseSelect.value = course.id;
    lastCourse = course.id;
    closeCourses();
    applyCourseDefaults();
    sheetInput.focus();
  }
});

function renderCourses() {
  courseList.innerHTML = '';
  if (courses.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No courses yet. Add one below.';
    courseList.append(li);
    return;
  }
  for (const course of [...courses].sort((a, b) => a.name.localeCompare(b.name))) {
    const li = document.createElement('li');
    li.className = 'course-row';
    for (const [field, type, placeholder] of [
      ['name', 'text', 'Course name'],
      ['tutor', 'text', 'Tutor name'],
      ['email', 'email', 'Tutor email'],
    ]) {
      const input = document.createElement('input');
      input.type = type;
      input.placeholder = placeholder;
      input.value = course[field];
      input.required = true;
      input.addEventListener('change', () => {
        if (!input.value.trim() || !input.checkValidity()) {
          input.value = course[field];
          return;
        }
        course[field] = input.value.trim();
        save();
        render();
      });
      li.append(input);
    }
    const notes = document.createElement('textarea');
    notes.className = 'course-notes';
    notes.rows = 2;
    notes.placeholder = 'Submission notes (optional)';
    notes.value = course.notes || '';
    notes.addEventListener('change', () => {
      course.notes = notes.value.trim();
      save();
      render();
    });

    const format = document.createElement('input');
    format.type = 'text';
    format.className = 'course-format';
    format.placeholder = 'Submission file name (optional), e.g. Xavier_Howard_IntroCalculus_{sheet}.pdf';
    format.title = '{sheet} is replaced with the sheet number';
    format.value = course.fileFormat || '';
    const preview = document.createElement('div');
    preview.className = 'format-preview';
    const showPreview = () => (preview.textContent = formatPreview(format.value));
    showPreview();
    format.addEventListener('input', showPreview);
    format.addEventListener('change', () => {
      course.fileFormat = format.value.trim();
      save();
      render();
    });

    const files = document.createElement('div');
    files.className = 'pdf course-files';
    for (const file of course.files || []) {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'pdf-link';
      view.title = `Course notes: ${file.name} (opens in your browser)`;
      view.textContent = `📚 ${file.name}`;
      view.addEventListener('click', () => openPdf(noteKey(course, file), file.name));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pdf-remove';
      remove.title = 'Remove these notes';
      remove.textContent = '×';
      remove.addEventListener('click', async () => {
        await deletePdf(noteKey(course, file));
        course.files = course.files.filter(f => f.id !== file.id);
        save();
        render();
      });
      files.append(view, remove);
    }
    const attach = document.createElement('button');
    attach.type = 'button';
    attach.className = 'pdf-attach';
    attach.textContent = '+ Course notes';
    attach.title = 'Add lecture notes or other PDFs for this course (you can pick several)';
    attach.addEventListener('click', () => {
      notesCourse = course;
      notesInput.click();
    });
    files.append(attach);

    const used = tasks.filter(t => t.courseId === course.id).length;
    const noteCount = course.files?.length || 0;
    const del = document.createElement('button');
    del.className = 'delete';
    del.type = 'button';
    del.title = used ? `Delete course (${used} task${used === 1 ? '' : 's'} will have no course)` : 'Delete course';
    del.textContent = '×';
    del.addEventListener('click', () => {
      const losing = [
        used && `${used} task${used === 1 ? '' : 's'} will be left with no course`,
        noteCount && `its ${noteCount} course notes PDF${noteCount === 1 ? '' : 's'} will be deleted`,
      ].filter(Boolean);
      if (losing.length && !confirm(`Delete "${course.name}"? ${losing.join(', and ')}.`)) return;
      for (const key of coursePdfs(course).keys()) deletePdf(key);
      courses = courses.filter(c => c.id !== course.id);
      for (const t of tasks) if (t.courseId === course.id) t.courseId = null;
      save();
      render();
    });
    const email = document.createElement('details');
    email.className = 'course-email';
    const summary = document.createElement('summary');
    summary.textContent = course.emailSubject || course.emailBody ? 'Email (customised)' : 'Email';
    const subject = document.createElement('input');
    subject.type = 'text';
    subject.placeholder = DEFAULT_EMAIL_SUBJECT;
    subject.value = course.emailSubject || '';
    subject.title = 'Subject. Leave empty for the default shown in grey.';
    const body = document.createElement('textarea');
    body.rows = 6;
    body.placeholder = DEFAULT_EMAIL_BODY;
    body.value = course.emailBody || '';
    body.title = 'Message. Leave empty for the default shown in grey.';
    const help = document.createElement('div');
    help.className = 'email-help';
    help.textContent = `Tags: ${EMAIL_TAGS}`;
    const example = document.createElement('pre');
    example.className = 'email-example';
    const showExample = () => {
      const draft = { ...course, emailSubject: subject.value.trim(), emailBody: body.value.trim() };
      example.textContent = `To: ${course.email}\nSubject: ${emailSubject(draft, ['3', '4'])}\n\n${emailBody(draft, ['3', '4'])}`;
    };
    showExample();
    for (const field of [subject, body]) {
      field.addEventListener('input', showExample);
      field.addEventListener('change', () => {
        course.emailSubject = subject.value.trim();
        course.emailBody = body.value.trim();
        save();
        summary.textContent = course.emailSubject || course.emailBody ? 'Email (customised)' : 'Email';
      });
    }
    const exampleLabel = document.createElement('div');
    exampleLabel.className = 'email-help';
    exampleLabel.textContent = 'Example for sheets 3 and 4:';
    email.append(summary, subject, body, help, exampleLabel, example);

    li.append(del, notes, format, preview, email, files);
    courseList.append(li);
  }
}

// Shows what a format gives for sheet 3, so mistakes are easy to spot while typing
function formatPreview(format) {
  if (!format.trim()) return '';
  SHEET_PLACEHOLDER.lastIndex = 0;
  if (!SHEET_PLACEHOLDER.test(format)) return 'Add {sheet} where the sheet number goes.';
  return `Sheet 3 is saved as ${formatFileName(format.trim(), '3')}`;
}

const newFormat = document.getElementById('course-format');
const newFormatPreview = document.getElementById('course-format-preview');
newFormat.addEventListener('input', () => (newFormatPreview.textContent = formatPreview(newFormat.value)));
courseForm.addEventListener('reset', () => (newFormatPreview.textContent = ''));

// Messages

const message = document.getElementById('message');
let messageTimer;

// action is an optional { label, fn } shown as a button, e.g. Undo
function showMessage(text, isError, action, seconds) {
  message.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  message.append(span);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      message.hidden = true;
      action.fn();
    });
    message.append(btn);
  }
  message.className = isError ? 'error' : '';
  message.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (message.hidden = true), (seconds || (action ? UNDO_SECONDS : 4)) * 1000);
}

// Export / import
//
// Exports are .todo files: JSON holding courses, tasks and each task's problem sheet PDF
// (base64). Submissions aren't included. Older .json exports (a plain task array, or
// { tasks, courses }) still import as they are.

const EXPORT_FORMAT = 'todo-export';
const EXPORT_VERSION = 2;

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

document.getElementById('export-btn').addEventListener('click', async () => {
  if (tasks.length === 0 && courses.length === 0) {
    showMessage('Nothing to export yet.', true);
    return;
  }

  const problemSheets = {};
  for (const task of tasks) {
    if (!task.problemName) continue;
    const key = PDF_KINDS.problem.key(task.id);
    const blob = await getPdf(key) || await remotePdf(key);
    if (!blob) continue;
    problemSheets[task.id] = {
      name: task.problemName,
      data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    };
  }

  const data = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    // Course notes aren't exported, so their file lists are left out
    courses: courses.map(({ files, ...c }) => c),
    // Submission and marked work file names are left out, since those PDFs aren't exported
    tasks: tasks.map(({ pdfName, markedName, ...t }) => t),
    problemSheets,
  };
  const name = `tasks-${today()}.todo`;
  if (window.files?.saveExport) {
    // On Android: handed to the share sheet, since there's no downloads folder to save into
    const result = await window.files.saveExport(name, JSON.stringify(data));
    if (!result.ok) showMessage("Couldn't export your tasks.", true);
    return;
  }
  const blob = new Blob([JSON.stringify(data)], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);

  const n = Object.keys(problemSheets).length;
  showMessage(`Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'}` +
    (n ? ` with ${n} problem sheet${n === 1 ? '' : 's'}.` : '.'));
});

const importFile = document.getElementById('import-file');
document.getElementById('import-btn').addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (file) await importText(await file.text());
});

// Double-clicking a .todo file opens the app, which passes the file in here
window.files?.onImportFile(file => importText(file.text));

async function importText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    showMessage("That file isn't a valid task export.", true);
    return;
  }
  // Oldest exports were a plain array of tasks with no courses
  const incomingTasks = Array.isArray(data) ? data : data?.tasks;
  const incomingCourses = Array.isArray(data?.courses) ? data.courses : [];
  const incomingSheets = data && typeof data.problemSheets === 'object' ? data.problemSheets : {};
  if (!Array.isArray(incomingTasks)) {
    showMessage("That file isn't a valid task export.", true);
    return;
  }
  if (data.format === EXPORT_FORMAT && data.version > EXPORT_VERSION) {
    showMessage('That file was made by a newer version of the app. Please update to import it.', true);
    return;
  }

  const courseIds = new Set(courses.map(c => c.id));
  let addedCourses = 0;
  for (const c of incomingCourses) {
    if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || courseIds.has(c.id)) continue;
    courses.push({
      id: c.id,
      name: c.name,
      tutor: String(c.tutor || ''),
      email: String(c.email || ''),
      notes: String(c.notes || ''),
      ...(typeof c.fileFormat === 'string' && c.fileFormat && { fileFormat: c.fileFormat }),
      ...(typeof c.emailSubject === 'string' && c.emailSubject && { emailSubject: c.emailSubject }),
      ...(typeof c.emailBody === 'string' && c.emailBody && { emailBody: c.emailBody }),
      ...(isDate(c.lastDue) && { lastDue: c.lastDue }),
      ...(isTime(c.lastTime) && { lastTime: c.lastTime }),
    });
    courseIds.add(c.id);
    addedCourses++;
  }

  // Saves a task's problem sheet from the file; returns true if one was added
  async function importSheet(task, sheet) {
    if (!sheet || typeof sheet.name !== 'string' || typeof sheet.data !== 'string') return false;
    try {
      const file = new Blob([base64ToBytes(sheet.data)], { type: 'application/pdf' });
      await putPdf(PDF_KINDS.problem.key(task.id), file);
    } catch {
      return false;
    }
    task.problemName = sheet.name;
    return true;
  }

  const validStatuses = STATUSES.map(s => s.id);
  let added = 0;
  let addedSheets = 0;
  for (const t of incomingTasks) {
    if (!t || !isDate(t.due)) continue;
    // Tasks are sheets now, but older exports have typed text instead
    const hasSheet = typeof t.sheet === 'string' && t.sheet.trim() !== '';
    if (!hasSheet && typeof t.text !== 'string') continue;

    // A task already in the list isn't duplicated, but gets the problem sheet if it lacks one
    const existing = tasks.find(e => e.id === t.id);
    if (existing) {
      if (!existing.problemName && await importSheet(existing, incomingSheets[t.id])) addedSheets++;
      continue;
    }

    const task = {
      id: typeof t.id === 'number' ? t.id : nextId(),
      ...(hasSheet ? { sheet: t.sheet.trim() } : { text: t.text }),
      due: t.due,
      ...(isTime(t.time) && { time: t.time }),
      status: validStatuses.includes(t.status) ? t.status : null,
      courseId: courseIds.has(t.courseId) ? t.courseId : null,
    };
    if (await importSheet(task, incomingSheets[t.id])) addedSheets++;
    tasks.push(task);
    added++;
  }
  save();
  render();

  const parts = [];
  if (added) parts.push(`${added} task${added === 1 ? '' : 's'}`);
  if (addedCourses) parts.push(`${addedCourses} course${addedCourses === 1 ? '' : 's'}`);
  if (addedSheets) parts.push(`${addedSheets} problem sheet${addedSheets === 1 ? '' : 's'}`);
  showMessage(parts.length ? `Imported ${parts.join(', ')}.` : 'Nothing new to import.');
}

// Updates
//
// window.updates comes from preload.js (desktop) or mobile.js (Android). The Update button
// only appears once a newer release is found on GitHub.

const UPDATE_CHECK_HOURS = 6;
const updateBtn = document.getElementById('update-btn');
let updateVersion = null;

function showUpdateButton() {
  updateBtn.textContent = `Update to ${updateVersion}`;
  updateBtn.disabled = false;
  updateBtn.hidden = false;
}

async function checkForUpdate() {
  if (!window.updates || updateVersion) return;
  updateVersion = await window.updates.check();
  if (updateVersion) showUpdateButton();
}

updateBtn.addEventListener('click', async () => {
  updateBtn.disabled = true;
  updateBtn.textContent = 'Downloading…';
  const result = await window.updates.install(updateVersion);
  if (!result.ok) showMessage("Couldn't download the update. Check your connection and try again.", true);
  // On desktop the app closes to install. On Android the installer opens, and the button
  // comes back in case it was cancelled.
  showUpdateButton();
});

window.updates?.onProgress(percent => {
  if (updateBtn.disabled) updateBtn.textContent = `Downloading… ${percent}%`;
});
window.addEventListener('online', checkForUpdate);
setInterval(checkForUpdate, UPDATE_CHECK_HOURS * 60 * 60 * 1000);

dueInput.value = today();
render();
cleanUpPdfs();
startCloud();
checkForUpdate();

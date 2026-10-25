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

// Each task can hold two PDFs. `field` is the task property holding the file name;
// submissions are keyed by plain task id (as before), problem sheets by "id:problem".
const PDF_KINDS = {
  problem: { field: 'problemName', key: id => `${id}:problem`, icon: '📋', label: 'Problem sheet' },
  work: { field: 'pdfName', key: id => id, icon: '📄', label: 'Submission' },
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
  const { task, kind } = pdfTarget;
  try {
    await putPdf(kind.key(task.id), file);
  } catch {
    showMessage("Couldn't save that PDF.", true);
    return;
  }
  task[kind.field] = file.name;
  save();
  render();
});

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
      const name = task[kind.field];
      if (name) {
        const view = document.createElement('button');
        view.className = 'pdf-link';
        view.title = `${kind.label}: ${name} (opens in your browser)`;
        view.textContent = `${kind.icon} ${name}`;
        view.addEventListener('click', () => openPdf(kind.key(task.id), name));
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
        pdf.append(view, remove);
      } else {
        const attach = document.createElement('button');
        attach.className = 'pdf-attach';
        attach.textContent = `+ ${kind.label}`;
        attach.addEventListener('click', () => {
          pdfTarget = { task, kind };
          pdfInput.click();
        });
        pdf.append(attach);
      }
    }
    info.append(pdf);

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
    li.append(del, notes, files);
    courseList.append(li);
  }
}

// Messages

const message = document.getElementById('message');
let messageTimer;

// action is an optional { label, fn } shown as a button, e.g. Undo
function showMessage(text, isError, action) {
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
  messageTimer = setTimeout(() => (message.hidden = true), action ? UNDO_SECONDS * 1000 : 4000);
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
    // Submission file names are left out, since the PDFs themselves aren't exported
    tasks: tasks.map(({ pdfName, ...t }) => t),
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

dueInput.value = today();
render();
cleanUpPdfs();
startCloud();

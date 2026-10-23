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
}

// Timestamp-based ids, bumped so two items made in the same millisecond never collide
let lastId = 0;
function nextId() {
  lastId = Math.max(Date.now(), lastId + 1);
  return lastId;
}

function courseOf(task) {
  return courses.find(c => c.id === task.courseId) || null;
}

// PDFs are too large for localStorage, so they live in IndexedDB keyed by task id
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
let pdfTarget = null;

pdfInput.addEventListener('change', async () => {
  const file = pdfInput.files[0];
  pdfInput.value = '';
  if (!file || !pdfTarget) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showMessage('Please choose a PDF file.', true);
    return;
  }
  try {
    await putPdf(pdfTarget.id, file);
  } catch {
    showMessage("Couldn't save that PDF.", true);
    return;
  }
  pdfTarget.pdfName = file.name;
  save();
  render();
});

const viewer = document.getElementById('pdf-viewer');
const viewerFrame = document.getElementById('pdf-frame');
const viewerTitle = document.getElementById('pdf-title');

async function openPdf(task) {
  const blob = await getPdf(task.id);
  if (!blob) {
    showMessage("That PDF couldn't be found.", true);
    return;
  }
  viewerTitle.textContent = task.pdfName;
  viewerFrame.src = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
  viewer.hidden = false;
}

function closePdf() {
  URL.revokeObjectURL(viewerFrame.src);
  viewerFrame.src = 'about:blank';
  viewer.hidden = true;
}
document.getElementById('pdf-close').addEventListener('click', closePdf);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!viewer.hidden) closePdf();
  else if (!coursesModal.hidden) closeCourses();
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
    if (task.pdfName) {
      const view = document.createElement('button');
      view.className = 'pdf-link';
      view.title = 'View PDF';
      view.textContent = '📄 ' + task.pdfName;
      view.addEventListener('click', () => openPdf(task));
      const remove = document.createElement('button');
      remove.className = 'pdf-remove';
      remove.title = 'Remove PDF';
      remove.textContent = '×';
      remove.addEventListener('click', async () => {
        await deletePdf(task.id);
        delete task.pdfName;
        save();
        render();
      });
      pdf.append(view, remove);
    } else {
      const attach = document.createElement('button');
      attach.className = 'pdf-attach';
      attach.textContent = '+ Attach PDF';
      attach.addEventListener('click', () => {
        pdfTarget = task;
        pdfInput.click();
      });
      pdf.append(attach);
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

// The PDF is kept until the undo window has passed, so Undo brings it back too
function deleteTask(task) {
  const index = tasks.indexOf(task);
  tasks.splice(index, 1);
  save();
  render();

  const pdfTimer = task.pdfName
    ? setTimeout(() => deletePdf(task.id), UNDO_SECONDS * 1000 + 500)
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
  const ids = new Set(tasks.filter(t => t.pdfName).map(t => t.id));
  for (const key of await pdfStore('readonly', s => s.getAllKeys())) {
    if (!ids.has(key)) deletePdf(key);
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

    const used = tasks.filter(t => t.courseId === course.id).length;
    const del = document.createElement('button');
    del.className = 'delete';
    del.type = 'button';
    del.title = used ? `Delete course (${used} task${used === 1 ? '' : 's'} will have no course)` : 'Delete course';
    del.textContent = '×';
    del.addEventListener('click', () => {
      if (used && !confirm(`Delete "${course.name}"? ${used} task${used === 1 ? '' : 's'} will be left with no course.`)) return;
      courses = courses.filter(c => c.id !== course.id);
      for (const t of tasks) if (t.courseId === course.id) t.courseId = null;
      save();
      render();
    });
    li.append(del, notes);
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

document.getElementById('export-btn').addEventListener('click', () => {
  if (tasks.length === 0) {
    showMessage('No tasks to export.', true);
    return;
  }
  const data = { tasks, courses };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tasks-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

const importFile = document.getElementById('import-file');
document.getElementById('import-btn').addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showMessage("That file isn't a valid task export.", true);
    return;
  }
  // Older exports were a plain array of tasks with no courses
  const incomingTasks = Array.isArray(data) ? data : data?.tasks;
  const incomingCourses = Array.isArray(data?.courses) ? data.courses : [];
  if (!Array.isArray(incomingTasks)) {
    showMessage("That file isn't a valid task export.", true);
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

  const validStatuses = STATUSES.map(s => s.id);
  // Skip tasks already in the list so importing the same file twice doesn't duplicate them
  const existing = new Set(tasks.map(t => t.id));
  let added = 0;
  for (const t of incomingTasks) {
    if (!t || !isDate(t.due)) continue;
    // Tasks are sheets now, but older exports have typed text instead
    const hasSheet = typeof t.sheet === 'string' && t.sheet.trim() !== '';
    if (!hasSheet && typeof t.text !== 'string') continue;
    if (existing.has(t.id)) continue;
    const id = typeof t.id === 'number' ? t.id : nextId();
    tasks.push({
      id,
      ...(hasSheet ? { sheet: t.sheet.trim() } : { text: t.text }),
      due: t.due,
      ...(isTime(t.time) && { time: t.time }),
      status: validStatuses.includes(t.status) ? t.status : null,
      courseId: courseIds.has(t.courseId) ? t.courseId : null,
    });
    existing.add(id);
    added++;
  }
  save();
  render();
  const parts = [];
  if (added) parts.push(`${added} task${added === 1 ? '' : 's'}`);
  if (addedCourses) parts.push(`${addedCourses} course${addedCourses === 1 ? '' : 's'}`);
  showMessage(parts.length ? `Imported ${parts.join(' and ')}.` : 'No new tasks to import.');
});

dueInput.value = today();
render();
cleanUpPdfs();

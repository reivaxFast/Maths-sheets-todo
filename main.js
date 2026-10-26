const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');

// Hide the File / Edit / View / Window menu bar
Menu.setApplicationMenu(null);

function regQuery(key, value) {
    return new Promise(resolve => {
        const args = value ? ['query', key, '/v', value] : ['query', key, '/ve'];
        execFile('reg', args, { windowsHide: true }, (err, stdout) => {
            const match = !err && stdout.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
            resolve(match ? match[1].trim() : null);
        });
    });
}

// Splits a command line like `"C:\x\msedge.exe" --single-argument %1` into parts
function splitCommand(command) {
    return (command.match(/"[^"]*"|\S+/g) || []).map(part => part.replace(/^"|"$/g, ''));
}

// Opens a URL in the user's default web browser, read from Windows' http handler
async function openInBrowser(url) {
    if (process.platform === 'win32') {
        // Newer Windows 11 keeps the current choice under UserChoiceLatest\ProgId and can leave
        // an out-of-date one (often Edge) in UserChoice, so the newer key is checked first
        const http = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http';
        const progId = await regQuery(`${http}\\UserChoiceLatest\\ProgId`, 'ProgId')
            || await regQuery(`${http}\\UserChoice`, 'ProgId');
        const command = progId && await regQuery(`HKCR\\${progId}\\shell\\open\\command`);
        if (command) {
            const [exe, ...args] = splitCommand(command);
            const withUrl = args.some(a => a.includes('%1'))
                ? args.map(a => a.replace('%1', url))
                : [...args, url];
            const ok = await new Promise(resolve => {
                const child = spawn(exe, withUrl, { detached: true, stdio: 'ignore' });
                child.on('error', () => resolve(false));
                child.on('spawn', () => resolve(true));
            });
            if (ok) return;
        }
    }
    // Fallback: let the system decide (usually the default PDF viewer)
    await shell.openExternal(url);
}

// The browser can't read the app's own storage, so the PDF is written to a temp file first
ipcMain.handle('open-pdf', async (event, name, data) => {
    try {
        const safeName = path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file.pdf';
        // A fresh folder each time so two PDFs with the same name don't overwrite each other
        const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'todo-pdf-'));
        const file = path.join(dir, safeName);
        await fs.promises.writeFile(file, Buffer.from(data));
        await openInBrowser(pathToFileURL(file).href);
        return { ok: true };
    } catch {
        return { ok: false };
    }
});

// Updates come from the GitHub releases named in package.json's build.publish.
// Nothing downloads until the Update button is clicked.
autoUpdater.autoDownload = false;
autoUpdater.on('download-progress', p => win?.webContents.send('update-progress', Math.round(p.percent)));

// Returns the newer version's number, or null. Only the installed app updates: `npm start` runs from source.
ipcMain.handle('check-update', async () => {
  if (!app.isPackaged) return null;
  try {
    const result = await autoUpdater.checkForUpdates();
    return result?.isUpdateAvailable ? result.updateInfo.version : null;
  } catch {
    return null; // Offline, or no release to compare with
  }
});

// Downloads the new installer, then closes the app, installs it quietly and reopens
ipcMain.handle('install-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    autoUpdater.quitAndInstall(true, true);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// Opening a .todo file (e.g. double-clicking it) passes its path on the command line
function todoFileFrom(argv) {
    return argv.slice(1).find(arg => arg.toLowerCase().endsWith('.todo') && fs.existsSync(arg));
}

async function sendImportFile(file) {
    try {
        const text = await fs.promises.readFile(file, 'utf8');
        win.webContents.send('import-file', { name: path.basename(file), text });
    } catch {
        // Unreadable file: ignore, the app still opens normally
    }
}

let win = null;
let pendingFile = todoFileFrom(process.argv);

// Only one copy of the app runs; opening another .todo file hands it to the open window
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', (event, argv) => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
        const file = todoFileFrom(argv);
        if (file) sendImportFile(file);
    });
    app.whenReady().then(createWindow);
}

function createWindow() {
    win = new BrowserWindow({
        width: 1000,
        height: 700,
        icon: path.join(__dirname, 'icon.png'),
        backgroundColor: '#1e1e2e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    win.webContents.on('did-finish-load', () => {
        if (pendingFile) sendImportFile(pendingFile);
        pendingFile = null;
    });
    win.loadFile('index.html');
}

app.on('window-all-closed', () => app.quit());

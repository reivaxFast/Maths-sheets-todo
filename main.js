const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// Hide the File / Edit / View / Window menu bar
Menu.setApplicationMenu(null);

function createWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 700,
        icon: path.join(__dirname, 'icon.png'),
        backgroundColor: '#1e1e2e',
    });
    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());

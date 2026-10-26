const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('files', {
    openPdf: (name, data) => ipcRenderer.invoke('open-pdf', name, data),
    onImportFile: callback => ipcRenderer.on('import-file', (event, file) => callback(file)),
    openEmailDraft: eml => ipcRenderer.invoke('open-email-draft', eml),
});

contextBridge.exposeInMainWorld('updates', {
    check: () => ipcRenderer.invoke('check-update'),
    install: () => ipcRenderer.invoke('install-update'),
    onProgress: callback => ipcRenderer.on('update-progress', (event, percent) => callback(percent)),
});

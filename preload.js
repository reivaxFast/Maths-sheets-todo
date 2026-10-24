const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('files', {
    openPdf: (name, data) => ipcRenderer.invoke('open-pdf', name, data),
    onImportFile: callback => ipcRenderer.on('import-file', (event, file) => callback(file)),
});

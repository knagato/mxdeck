const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("editor", {
  init: () => ipcRenderer.invoke("editor:init"),
  chooseIcon: () => ipcRenderer.invoke("editor:choose-icon"),
  save: (data) => ipcRenderer.invoke("editor:save", data),
  cancel: () => ipcRenderer.send("editor:cancel"),
});

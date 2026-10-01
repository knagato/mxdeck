const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
  list: () => ipcRenderer.invoke("plugin-install:list"),
  run: (input) => ipcRenderer.invoke("plugin-install:run", input),
  cancel: () => ipcRenderer.send("plugin-install:cancel"),
});

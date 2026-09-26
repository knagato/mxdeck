const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
  run: (input) => ipcRenderer.invoke("plugin-install:run", input),
  cancel: () => ipcRenderer.send("plugin-install:cancel"),
});

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  activate: (id) => ipcRenderer.send("activate", id),
  on: (channel, fn) => {
    if (!["accounts", "active", "badges"].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});

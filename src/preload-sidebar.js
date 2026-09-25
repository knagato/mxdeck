const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  activate: (id) => ipcRenderer.send("activate", id),
  addAccount: () => ipcRenderer.send("add-account"),
  accountMenu: (id) => ipcRenderer.send("account-menu", id),
  reorder: (ids) => ipcRenderer.send("reorder", ids),
  on: (channel, fn) => {
    if (!["accounts", "active", "badges"].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});

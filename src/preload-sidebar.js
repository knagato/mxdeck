const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  activate: (id) => ipcRenderer.send("activate", id),
  addAccount: () => ipcRenderer.send("add-account"),
  accountMenu: (id) => ipcRenderer.send("account-menu", id),
  reorder: (ids) => ipcRenderer.send("reorder", ids),
  taskbarBadge: (dataUrl) => ipcRenderer.send("taskbar-badge", dataUrl),
  on: (channel, fn) => {
    if (!["accounts", "active", "badges", "edge", "taskbar-badge"].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});

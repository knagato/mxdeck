// プラグインのパネル用。main 側で ctx.panel.handle した channel だけを呼べる。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mxdeck", {
  invoke: (channel, ...args) => ipcRenderer.invoke("mxdeck:panel", String(channel), ...args),
  on: (channel, fn) =>
    ipcRenderer.on("mxdeck:panel", (_e, ch, payload) => {
      if (ch === channel) fn(payload);
    }),
  close: () => ipcRenderer.send("mxdeck:panel-close"),
});

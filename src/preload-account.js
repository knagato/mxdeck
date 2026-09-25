// アカウントビュー用。Element は通知クリック時に window.focus() を呼ぶので、
// それを横取りしてシェル側にこのアカウントへ切り替えてもらう。
const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("__elementMulti", {
  focus: () => ipcRenderer.send("focus-me"),
});

webFrame.executeJavaScript(`(() => {
  const original = window.focus.bind(window);
  window.focus = () => { window.__elementMulti.focus(); original(); };
})()`);

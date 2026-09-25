// アカウントビュー用。ページが出した通知がクリックされたら、シェル側にこのアカウントへ切り替えてもらう。
// クリック時の振る舞いはクライアントごとに違う（Element は window.focus()、Cinny は画面内遷移だけ）ので、
// Notification そのものを包んで click を拾う。
const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("__elementMulti", {
  focus: () => ipcRenderer.send("focus-me"),
});

webFrame.executeJavaScript(`(() => {
  const Original = window.Notification;
  if (!Original) return;
  class Notification extends Original {
    constructor(...args) {
      super(...args);
      this.addEventListener("click", () => window.__elementMulti.focus());
    }
  }
  window.Notification = Notification;
})()`);

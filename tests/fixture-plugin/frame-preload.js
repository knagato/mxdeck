// アカウントのビューのすべてのフレームで走る。宣言したオリジン以外からの invoke は main で拒否される
const { ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke("mxdeck:frame", "fixture", channel, payload);

ipcRenderer.on("mxdeck:frame:fixture", (_e, channel, payload) => {
  if (channel === "ack") invoke("acked", { origin: location.origin, payload });
});

invoke("hello", { origin: location.origin, top: window === window.top }).then(
  () => {},
  (err) => {
    // 拒否されたことをタイトルに出す（テストが CDP で読む）
    const mark = () => {
      document.title = `rejected:${location.origin}:${/forbidden/.test(String(err)) ? "forbidden" : err}`;
    };
    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", mark);
    else mark();
  },
);

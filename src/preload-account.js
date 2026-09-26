// アカウントビュー用。ページが出した通知がクリックされたら、シェル側にこのアカウントへ切り替えてもらう。
// クリック時の振る舞いはクライアントごとに違う（Element は window.focus()、Cinny は画面内遷移だけ）ので、
// Notification そのものを包んで click を拾う。
// フレームを使うプラグインがあると iframe でも preload が走る（nodeIntegrationInSubFrames）ので、
// 最上位のフレームでだけ動かす。
const { contextBridge, ipcRenderer, webFrame } = require("electron");

if (window === window.top) {
  contextBridge.exposeInMainWorld("__mxdeck", {
    focus: () => ipcRenderer.send("focus-me"),
  });

  webFrame.executeJavaScript(`(() => {
    const Original = window.Notification;
    if (!Original) return;
    class Notification extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener("click", () => window.__mxdeck.focus());
      }
    }
    window.Notification = Notification;
  })()`);

  // サイドバーをページの左端と同じ色に塗るため、左端に見えている不透明な背景色を知らせる。
  // クライアントのテーマ（ライト/ダーク）は OS の外観とは別に選べるので、OS ではなくページに合わせる。
  // ダイアログの半透明な背景幕は飛ばし、その下の面の色を拾う。テーマの切り替えを拾うため定期的に見直す。
  const edgeColor = () => {
    for (const el of document.elementsFromPoint(0, window.innerHeight / 2)) {
      const c = getComputedStyle(el).backgroundColor;
      if (c.startsWith("rgb(")) return c;
    }
    return null;
  };
  let lastEdge;
  setInterval(() => {
    const c = edgeColor();
    if (c !== lastEdge) ipcRenderer.send("edge-color", (lastEdge = c));
  }, 1000);
}

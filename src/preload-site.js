// プラグインのサインイン用ウィンドウ（ctx.sites.open）向け。mxdeck ではパスキーでサインインできないので、
// ページからはパスキー（WebAuthn）が無いように見せる。Slack などはパスキーの自動入力を呼ぶため、
// 開いただけで macOS のパスキーの画面が出て、使えないのに毎回閉じることになる。
// PublicKeyCredential が無ければ、たいていのサイトはパスキーを使わずにメールやパスワードの入力を出す。
// それでも呼んできたものは、ユーザーが取り消したときと同じ NotAllowedError で断る
const { contextBridge } = require("electron");

contextBridge.executeInMainWorld({
  func: () => {
    delete window.PublicKeyCredential;
    const credentials = navigator.credentials;
    if (!credentials) return;
    for (const name of ["get", "create"]) {
      const original = credentials[name].bind(credentials);
      credentials[name] = (options) =>
        options?.publicKey
          ? Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"))
          : original(options);
    }
  },
});

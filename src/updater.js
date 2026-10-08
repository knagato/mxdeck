// 新しい版を GitHub Releases から取ってきて入れ替える（electron-updater）。
// 起動の少し後と 6 時間おきに確かめ、あれば裏でダウンロードし、済んだら再起動を勧める。断っても終了時に入る。
// 確かめた結果（最新だった・失敗した）を知らせるのは、メニューの「アップデートを確認…」から呼んだときだけ。
// 更新に使うのは macOS が署名・公証済みの zip と latest-mac.yml、Windows がインストーラと latest.yml
// （どちらもリリースに添付する。scripts/release.sh を参照）
const { app, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");

const FIRST_CHECK = 30 * 1000;
const INTERVAL = 6 * 60 * 60 * 1000;

let ctx; // { win, log, rebuildMenu }
let manual = false; // いま走っている確認がメニューからのものか
let available; // 見つかってダウンロード中の版
let downloaded; // ダウンロードが済んだ版

// 開発起動（pnpm start）では確かめない。MXDECK_UPDATE_URL は動作確認用で、
// latest-mac.yml / latest.yml と更新ファイルを置いた URL（generic）を GitHub の代わりに見る
const active = () => app.isPackaged;

function init({ win, log, rebuildMenu }) {
  ctx = { win, log, rebuildMenu };
  if (!active()) return;
  const url = process.env.MXDECK_UPDATE_URL;
  if (url) autoUpdater.setFeedURL({ provider: "generic", url });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log(`update: ${m}`),
    warn: (m) => log(`update: ${m}`),
    error: (m) => log(`update: ${m}`),
    debug: () => {},
  };

  autoUpdater.on("update-available", (info) => {
    available = info.version;
    ctx.rebuildMenu();
    if (manual) {
      manual = false;
      message({ message: `mxdeck ${info.version} があります`, detail: "裏でダウンロードし、済んだら知らせます。" });
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (!manual) return;
    manual = false;
    message({ message: "最新のバージョンです", detail: `mxdeck ${app.getVersion()}` });
  });
  autoUpdater.on("error", (err) => {
    available = undefined;
    ctx.rebuildMenu();
    if (!manual) return;
    manual = false;
    message({ type: "error", message: "アップデートを確認できませんでした", detail: String(err?.message ?? err) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    available = undefined;
    downloaded = info.version;
    manual = false;
    ctx.rebuildMenu();
    promptRestart();
  });

  setTimeout(check, FIRST_CHECK);
  setInterval(check, INTERVAL);
}

function message(options) {
  const win = ctx.win();
  const opts = { type: "info", buttons: ["OK"], ...options };
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

async function promptRestart() {
  const { response } = await message({
    message: `mxdeck ${downloaded} に更新できます`,
    detail: "再起動すると入れ替わります。あとにしたときは、次に終了したときに入ります。",
    buttons: ["再起動して更新", "あとで"],
    defaultId: 0,
    cancelId: 1,
  });
  // Windows は黙ってインストールし、済んだら起動し直す（macOS では引数は使われない）
  if (response === 0) autoUpdater.quitAndInstall(true, true);
}

function check() {
  if (!active() || available || downloaded) return;
  autoUpdater.checkForUpdates().catch(() => {}); // 失敗は error イベントで扱う
}

// メニューの「アップデートを確認…」
function checkFromMenu() {
  if (!active()) {
    message({ message: "開発中の起動では更新を確かめません", detail: `mxdeck ${app.getVersion()}` });
    return;
  }
  if (downloaded) return promptRestart();
  if (available) {
    message({ message: `mxdeck ${available} をダウンロードしています`, detail: "済んだら知らせます。" });
    return;
  }
  manual = true;
  check();
}

function menuItem() {
  if (downloaded) return { label: `再起動して ${downloaded} に更新…`, click: promptRestart };
  return { label: "アップデートを確認…", click: checkFromMenu };
}

module.exports = { init, menuItem };

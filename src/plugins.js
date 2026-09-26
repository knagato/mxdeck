// プラグイン。plugins.json に書かれたフォルダだけを読み込み、activate(ctx) を呼ぶ。
// プラグインは main プロセスで動く信頼済みのコードで、ctx は権限を絞るためではなく
// mxdeck の内側（メニュー・アカウントのビュー・ウィンドウ）に触れる口を決めておくためにある。
// 境界はふたつ: 読み込むのは明示されたフォルダだけ、フレームからの IPC はオリジンを main で確かめる。
// 書き方は docs/PLUGINS.md。

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const store = require("./accounts");

const API_VERSION = 1;
const PLUGINS_FILE =
  process.env.MXDECK_PLUGINS || path.join(path.dirname(store.ACCOUNTS_FILE), "plugins.json");
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const plugins = []; // { id, name, dir, entry, menu: [], panelHandlers: Map, frameHandlers: Map, frames: {origins, preload}[], windows: Set }
const errors = []; // { where, message }
let host; // main.js から渡される: win(), accounts(), activeId(), accountViews(), rebuildMenu()

function readFile() {
  try {
    const data = JSON.parse(fs.readFileSync(PLUGINS_FILE, "utf8"));
    return Array.isArray(data.plugins) ? data.plugins : [];
  } catch (err) {
    if (err.code !== "ENOENT") errors.push({ where: PLUGINS_FILE, message: String(err.message ?? err) });
    return [];
  }
}

function writeFile(entries) {
  fs.mkdirSync(path.dirname(PLUGINS_FILE), { recursive: true });
  const tmp = `${PLUGINS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ plugins: entries }, null, 2) + "\n");
  fs.renameSync(tmp, PLUGINS_FILE);
}

// package.json の "mxdeck" を読んで確かめる。読み込み前（追加するとき）にも使う
function inspect(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const m = pkg.mxdeck;
  if (!m || typeof m !== "object") throw new Error('package.json に "mxdeck" がありません');
  if (!ID_RE.test(m.id ?? "")) throw new Error(`mxdeck.id は英小文字・数字・- で 40 字まで: ${m.id}`);
  if (m.api !== API_VERSION) throw new Error(`mxdeck.api ${m.api} には対応していません（この mxdeck は ${API_VERSION}）`);
  const entry = path.resolve(dir, m.main ?? "index.js");
  if (!entry.startsWith(path.resolve(dir) + path.sep)) throw new Error("mxdeck.main がフォルダの外を指しています");
  return { id: m.id, name: m.name ?? pkg.name ?? m.id, version: pkg.version ?? "", entry };
}

function load(hooks) {
  host = hooks;
  for (const e of readFile()) {
    if (e.enabled === false) continue;
    const dir = path.resolve(store.expandHome(String(e.path ?? "")));
    try {
      const info = inspect(dir);
      if (plugins.some((p) => p.id === info.id)) throw new Error(`id が重複しています: ${info.id}`);
      const plugin = {
        ...info,
        dir,
        menu: [],
        panelHandlers: new Map(),
        frameHandlers: new Map(),
        frames: [],
        windows: new Set(),
      };
      const mod = require(info.entry);
      if (typeof mod.activate !== "function") throw new Error("activate(ctx) が export されていません");
      plugins.push(plugin);
      // activate はウィンドウを作る前に呼ぶ（フレームへの差し込みはビューを作るときに要る）。
      // async でもよいが、待たない。失敗は後で一覧に出す
      Promise.resolve()
        .then(() => mod.activate(makeContext(plugin, e.config ?? {})))
        .catch((err) => report(info.id, err));
    } catch (err) {
      report(e.path, err);
    }
  }
}

function report(where, err) {
  errors.push({ where: String(where), message: String(err?.stack ?? err?.message ?? err) });
  console.error(`[plugin ${where}]`, err);
}

// 起動後に、読み込めなかったプラグインをまとめて知らせる
function showErrors() {
  if (!errors.length) return;
  dialog.showMessageBox(host.win(), {
    type: "warning",
    message: "読み込めなかったプラグインがあります",
    detail: errors.map((e) => `${e.where}\n  ${e.message.split("\n")[0]}`).join("\n\n"),
  });
}

// ---------------------------------------------------------------------------
// ctx

const publicAccount = (a) => a && { id: a.id, name: a.name, url: a.url };

function makeContext(plugin, config) {
  return Object.freeze({
    id: plugin.id,
    dir: plugin.dir,
    config: structuredClone(config),
    locale: app.getLocale(),

    menu: {
      // { label, accelerator?, click } か { type: "separator" }。「プラグイン」メニューに並ぶ
      add(item) {
        plugin.menu.push(item);
        host.rebuildMenu();
      },
    },

    accounts: {
      list: () => host.accounts().map(publicAccount),
      active: () => publicAccount(host.accounts().find((a) => a.id === host.activeId())) ?? null,
    },

    panel: {
      // パネルからの window.mxdeck.invoke(channel, ...args) を受ける
      handle(channel, fn) {
        plugin.panelHandlers.set(String(channel), fn);
      },
      open: (opts) => openPanel(plugin, opts),
    },

    sites: {
      session: (name) => siteSession(plugin, name),
      open: (name, url, opts) => openSite(plugin, name, url, opts),
    },

    frames: {
      // アカウントのビューの中で、origins のフレームにだけ効く preload を差し込む
      inject({ origins, preload }) {
        if (!Array.isArray(origins) || !origins.length) throw new Error("frames.inject: origins が要ります");
        const list = origins.map((o) => new URL(o).origin);
        if (!path.isAbsolute(preload)) throw new Error("frames.inject: preload は絶対パスで");
        plugin.frames.push({ origins: list, preload });
      },
      // フレームからの ipcRenderer.invoke("mxdeck:frame", pluginId, channel, payload) を受ける。
      // 送り元がアカウントのビューで、inject で宣言したオリジンのときだけ fn が呼ばれる
      handle(channel, fn) {
        plugin.frameHandlers.set(String(channel), fn);
      },
      // 宣言したオリジンのフレームへ送る（preload 側は ipcRenderer.on(`mxdeck:frame:${id}`)）
      send(channel, payload, { accountId } = {}) {
        for (const { account, wc } of host.accountViews()) {
          if (accountId && account.id !== accountId) continue;
          for (const f of wc.mainFrame?.framesInSubtree ?? []) {
            if (frameOriginAllowed(plugin, f.origin)) f.send(`mxdeck:frame:${plugin.id}`, channel, payload);
          }
        }
      },
    },
  });
}

// ---------------------------------------------------------------------------
// パネル（拡張のポップアップにあたる、メインウィンドウに付くシート）

function openPanel(plugin, { file, width = 420, height = 520, resizable = false } = {}) {
  const w = new BrowserWindow({
    parent: host.win(),
    modal: true,
    width,
    height,
    resizable,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-plugin-panel.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const wcId = w.webContents.id;
  panelOwners.set(wcId, plugin);
  w.on("closed", () => panelOwners.delete(wcId));
  track(plugin, w);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.loadFile(path.resolve(plugin.dir, file));
  w.once("ready-to-show", () => w.show());
  return {
    window: w,
    send: (channel, payload) => !w.isDestroyed() && w.webContents.send("mxdeck:panel", channel, payload),
    close: () => !w.isDestroyed() && w.close(),
  };
}

const panelOwners = new Map(); // webContents.id -> plugin
const panelOwner = (e) => panelOwners.get(e.sender.id);

ipcMain.handle("mxdeck:panel", async (e, channel, ...args) => {
  const plugin = panelOwner(e);
  const fn = plugin?.panelHandlers.get(channel);
  if (!fn) throw new Error(`no handler: ${channel}`);
  return fn(...args);
});
ipcMain.on("mxdeck:panel-close", (e) => panelOwner(e) && BrowserWindow.fromWebContents(e.sender).close());

// ---------------------------------------------------------------------------
// サイト用のウィンドウと保存領域。アカウントとは別の partition で、プラグインとサイト名ごとに分かれる

const siteSessions = new Map();

function siteSession(plugin, name) {
  if (!ID_RE.test(String(name))) throw new Error(`sites: 名前は英小文字・数字・-: ${name}`);
  const partition = `persist:plugin-${plugin.id}-${name}`;
  if (!siteSessions.has(partition)) {
    const ses = session.fromPartition(partition);
    // サインインに使うだけなので、通知・カメラなどは出さない
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    siteSessions.set(partition, ses);
  }
  return siteSessions.get(partition);
}

const siteWindows = new Map(); // partition -> BrowserWindow

function siteWindowOptions(ses, show) {
  return {
    width: 1100,
    height: 800,
    show,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true },
  };
}

function wireSiteWindow(plugin, w, ses) {
  track(plugin, w);
  const wc = w.webContents;
  // SSO のポップアップ（Google など）は同じ保存領域で開く。それ以外のスキームは開かない
  wc.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/.test(url)) return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: siteWindowOptions(ses, true) };
  });
  wc.on("did-create-window", (child) => wireSiteWindow(plugin, child, ses));
  wc.on("context-menu", (_e, p) => {
    const t = [];
    if (p.isEditable) t.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    else if (p.selectionText) t.push({ role: "copy" });
    if (t.length) Menu.buildFromTemplate(t).popup({ window: w });
  });
}

// show: false なら画面に出さずに読み込む（ページの中の値を読むだけのとき）。
// 同じ名前のウィンドウが開いていれば、それを前に出して使う
function openSite(plugin, name, url, { show = true } = {}) {
  const ses = siteSession(plugin, name);
  const partition = `persist:plugin-${plugin.id}-${name}`;
  let w = siteWindows.get(partition);
  if (!w || w.isDestroyed()) {
    w = new BrowserWindow(siteWindowOptions(ses, show));
    siteWindows.set(partition, w);
    wireSiteWindow(plugin, w, ses);
    w.webContents.on("page-title-updated", (_e, title) => w.setTitle(`${title} — ${plugin.name}`));
    w.on("closed", () => siteWindows.get(partition) === w && siteWindows.delete(partition));
    if (url) w.loadURL(url);
  } else if (show) {
    w.show();
    w.focus();
  }
  const wc = w.webContents;
  return {
    window: w,
    webContents: wc,
    session: ses,
    loaded: () =>
      wc.isLoading() ? new Promise((resolve) => wc.once("did-stop-loading", resolve)) : Promise.resolve(),
    currentPage: () => (wc.isDestroyed() ? null : { url: wc.getURL(), title: wc.getTitle() }),
    close: () => !w.isDestroyed() && w.close(),
  };
}

function track(plugin, w) {
  plugin.windows.add(w);
  w.on("closed", () => plugin.windows.delete(w));
}

// ---------------------------------------------------------------------------
// フレーム

const usesFrames = () => plugins.some((p) => p.frames.length > 0);

function frameOriginAllowed(plugin, origin) {
  return plugin.frames.some((f) => f.origins.includes(origin));
}

// アカウントの session に、各プラグインのフレーム用 preload を登録する（session ごとに 1 回）
const preparedSessions = new WeakSet();
function prepareAccountSession(ses) {
  if (preparedSessions.has(ses)) return;
  preparedSessions.add(ses);
  for (const p of plugins) for (const f of p.frames) ses.registerPreloadScript({ type: "frame", filePath: f.preload });
}

ipcMain.handle("mxdeck:frame", async (e, pluginId, channel, payload) => {
  const view = host.accountViews().find((v) => v.wc === e.sender);
  const plugin = plugins.find((p) => p.id === pluginId);
  const origin = e.senderFrame?.origin;
  if (!view || !plugin || !origin || !frameOriginAllowed(plugin, origin)) throw new Error("forbidden");
  const fn = plugin.frameHandlers.get(channel);
  if (!fn) throw new Error(`no handler: ${channel}`);
  return fn(payload, { account: publicAccount(view.account), origin });
});

// ---------------------------------------------------------------------------
// メニュー（「プラグイン」）と管理

function menuTemplate() {
  const items = [];
  for (const p of plugins) {
    if (!p.menu.length) continue;
    if (items.length) items.push({ type: "separator" });
    items.push(...p.menu.map((m) => ({ ...m })));
  }
  if (items.length) items.push({ type: "separator" });
  const entries = readFile();
  const manage = entries.map((e) => {
    const loaded = plugins.find((p) => path.resolve(store.expandHome(String(e.path))) === p.dir);
    return {
      label: loaded ? `${loaded.name} ${loaded.version}` : String(e.path),
      type: "checkbox",
      checked: e.enabled !== false,
      click: () => setEnabled(e.path, e.enabled === false),
    };
  });
  items.push(
    { label: "プラグインを追加…", click: addPlugin },
    { label: "有効なプラグイン", submenu: manage.length ? manage : [{ label: "（なし）", enabled: false }] },
    { label: "plugins.json を開く", click: openFile },
  );
  return { label: "プラグイン", submenu: items };
}

function openFile() {
  if (!fs.existsSync(PLUGINS_FILE)) writeFile([]);
  shell.openPath(PLUGINS_FILE);
}

async function askRestart(message) {
  const { response } = await dialog.showMessageBox(host.win(), {
    type: "info",
    buttons: ["再起動", "あとで"],
    defaultId: 0,
    cancelId: 1,
    message,
    detail: "プラグインの読み込み・取り外しは起動時に行います。",
  });
  if (response === 0) {
    app.relaunch();
    app.quit();
  }
}

async function addPlugin() {
  const { canceled, filePaths } = await dialog.showOpenDialog(host.win(), {
    message: "プラグインのフォルダ（package.json に \"mxdeck\" があるもの）を選んでください",
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths[0]) return;
  const dir = filePaths[0];
  let info;
  try {
    info = inspect(dir);
  } catch (err) {
    dialog.showErrorBox("プラグインとして読み込めません", String(err.message ?? err));
    return;
  }
  const entries = readFile();
  if (entries.some((e) => path.resolve(store.expandHome(String(e.path))) === dir)) {
    dialog.showErrorBox("追加済みです", dir);
    return;
  }
  const { response } = await dialog.showMessageBox(host.win(), {
    type: "warning",
    buttons: ["追加", "キャンセル"],
    defaultId: 1,
    cancelId: 1,
    message: `「${info.name}」を追加しますか？`,
    detail:
      `${dir}\n\nプラグインは mxdeck の中で、mxdeck と同じ権限で動きます` +
      "（ファイル・ネットワーク・各サイトの保存データに触れられます）。信頼できるものだけを追加してください。",
  });
  if (response !== 0) return;
  writeFile([...entries, { path: store.contractHome(dir), enabled: true }]);
  host.rebuildMenu();
  await askRestart(`「${info.name}」を追加しました`);
}

async function setEnabled(p, enabled) {
  writeFile(readFile().map((e) => (e.path === p ? { ...e, enabled } : e)));
  host.rebuildMenu();
  await askRestart(enabled ? "プラグインを有効にしました" : "プラグインを無効にしました");
}

// メインウィンドウを閉じたら、プラグインのウィンドウも閉じる（残るとアプリが終わらない）
function closeAll() {
  for (const p of plugins) for (const w of p.windows) if (!w.isDestroyed()) w.destroy();
}

// メモリ使用量の表に、プラグインのウィンドウ（パネル・サイト）を別の行で出す
function windowsByPlugin() {
  return plugins.map((p) => ({ name: p.name, webContents: [...p.windows].map((w) => w.webContents) }));
}

module.exports = {
  load,
  showErrors,
  menuTemplate,
  usesFrames,
  prepareAccountSession,
  windowsByPlugin,
  closeAll,
  PLUGINS_FILE,
};

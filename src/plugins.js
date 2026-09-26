// プラグイン。plugins.json に書かれたフォルダだけを読み込み、activate(ctx) を呼ぶ。
// プラグインは main プロセスで動く信頼済みのコードで、ctx は権限を絞るためではなく
// mxdeck の内側（メニュー・アカウントのビュー・ウィンドウ）に触れる口を決めておくためにある。
// 境界はふたつ: 読み込むのは明示されたフォルダだけ、フレームからの IPC はオリジンを main で確かめる。
// 書き方は docs/PLUGINS.md。

const { app, BrowserWindow, Menu, dialog, ipcMain, net, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const store = require("./accounts");
const github = require("./github");

const API_VERSION = 1;
const PLUGINS_FILE =
  process.env.MXDECK_PLUGINS || path.join(path.dirname(store.ACCOUNTS_FILE), "plugins.json");
// GitHub から追加したプラグインは、ここの <id>/ に置く
const PLUGINS_DIR = path.join(path.dirname(PLUGINS_FILE), "plugins");
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
      close: (name) => closeSite(plugin, name),
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

const openPanels = new Map(); // "<plugin>:<file>" -> handle

// 同じパネルが開いていれば、それを返す（メニューを 2 回押してシートが重ならないように）
function openPanel(plugin, { file, width = 420, height = 520, resizable = false } = {}) {
  const key = `${plugin.id}:${path.resolve(plugin.dir, file)}`;
  const open = openPanels.get(key);
  if (open && !open.window.isDestroyed()) {
    open.window.focus();
    return open;
  }
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
  // シートには閉じるボタンが無い。プラグインの作りによらず、Esc と ⌘W で必ず閉じられるようにする
  w.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "Escape" || ((input.meta || input.control) && input.key.toLowerCase() === "w")) {
      e.preventDefault();
      w.close();
    }
  });
  w.loadFile(path.resolve(plugin.dir, file));
  w.once("ready-to-show", () => w.show());
  const handle = {
    window: w,
    send: (channel, payload) => !w.isDestroyed() && w.webContents.send("mxdeck:panel", channel, payload),
    close: () => !w.isDestroyed() && w.close(),
  };
  openPanels.set(key, handle);
  w.on("closed", () => openPanels.get(key) === handle && openPanels.delete(key));
  return handle;
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

const siteWindows = new Map(); // partition -> BrowserWindow（sites.open が開いた、そのサイトの主ウィンドウ）
const sitePopups = new Map(); // partition -> Set<BrowserWindow>（そこから開いたポップアップ）

function siteWindowOptions(ses, show) {
  return {
    width: 1100,
    height: 800,
    show,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true },
  };
}

function wireSiteWindow(plugin, w, ses, partition) {
  track(plugin, w);
  const wc = w.webContents;
  // ウィンドウが増えると、どれが何か分からなくなる。新しいタブとして開くもの（target=_blank、
  // ワークスペースを開く等）は、このウィンドウの中で開く。サイズ指定つきのポップアップ（Google 等の
  // SSO。閉じるときに opener へ結果を返す）だけは、同じ保存領域の別ウィンドウで開く。
  // http(s) 以外のスキーム（デスクトップアプリを呼ぶ slack:// 等）は開かない
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!/^https?:/.test(url)) return { action: "deny" };
    if (disposition !== "new-window") {
      wc.loadURL(url);
      return { action: "deny" };
    }
    return { action: "allow", overrideBrowserWindowOptions: siteWindowOptions(ses, true) };
  });
  wc.on("did-create-window", (child) => {
    if (!sitePopups.has(partition)) sitePopups.set(partition, new Set());
    sitePopups.get(partition).add(child);
    child.on("closed", () => sitePopups.get(partition)?.delete(child));
    wireSiteWindow(plugin, child, ses, partition);
  });
  // どのプラグインのウィンドウかをタイトルで示す（普通のブラウザと見分けられるように）
  wc.on("page-title-updated", (e, title) => {
    e.preventDefault();
    w.setTitle(`${title} — ${plugin.name}`);
  });
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
    wireSiteWindow(plugin, w, ses, partition);
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
    close: () => closeSite(plugin, name),
  };
}

// そのサイトのウィンドウをポップアップも含めて閉じ、閉じた数を返す。保存領域（サインイン）はそのまま
function closeSite(plugin, name) {
  const partition = `persist:plugin-${plugin.id}-${name}`;
  const open = [siteWindows.get(partition), ...(sitePopups.get(partition) ?? [])].filter((w) => w && !w.isDestroyed());
  for (const w of open) w.close();
  return open.length;
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
    { label: "フォルダから追加…", click: addPlugin },
    { label: "GitHub から追加…", click: openInstaller },
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

// ---------------------------------------------------------------------------
// GitHub から追加。リポジトリを入れるシートを出し、アーカイブを落として PLUGINS_DIR/<id> に置く。
// 同じ id のものが PLUGINS_DIR にあれば、入れ替える（更新）

let installer; // シートの BrowserWindow

function openInstaller() {
  if (installer && !installer.isDestroyed()) {
    if (installer.isVisible()) {
      installer.focus();
      return;
    }
    // 別のシート（アカウントの編集）が出ていて表に出られなかったもの。作り直す
    installer.destroy();
  }
  installer = new BrowserWindow({
    parent: host.win(),
    modal: true,
    width: 460,
    height: 250,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-plugin-install.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  installer.loadFile(path.join(__dirname, "plugin-install.html"));
  installer.once("ready-to-show", () => installer.show());
}

const fromInstaller = (e) => !!installer && !installer.isDestroyed() && e.sender === installer.webContents;

ipcMain.handle("plugin-install:run", async (e, input) => {
  if (!fromInstaller(e)) return { error: "forbidden" };
  try {
    return await installFromGitHub(input);
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
});
ipcMain.on("plugin-install:cancel", (e) => fromInstaller(e) && installer.close());

// plugins.json の項目が指すプラグインの id（読めなければ null）
function entryId(e) {
  try {
    return inspect(path.resolve(store.expandHome(String(e.path)))).id;
  } catch {
    return null;
  }
}

async function installFromGitHub(input) {
  const spec = github.parseSpec(input);
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(PLUGINS_DIR, ".download-"));
  try {
    const { commit } = await github.download(spec, tmp, { fetch: net.fetch });
    let info;
    try {
      info = inspect(tmp);
    } catch (err) {
      throw new Error(`mxdeck のプラグインではありません: ${err.message ?? err}`);
    }
    // npm install はしない。依存パッケージが要るものは、node_modules ごと置いてあるときだけ入れる
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"));
    if (Object.keys(pkg.dependencies ?? {}).length && !fs.existsSync(path.join(tmp, "node_modules"))) {
      throw new Error(
        "依存パッケージ（dependencies）が要るプラグインは、GitHub から直接は追加できません。" +
          "clone して pnpm install してから「フォルダから追加…」で追加してください",
      );
    }

    const dest = path.join(PLUGINS_DIR, info.id);
    const entries = readFile();
    const current = entries.find((e) => path.resolve(store.expandHome(String(e.path))) === dest);
    const clash = entries.find((e) => e !== current && entryId(e) === info.id);
    if (clash) throw new Error(`同じ id（${info.id}）のプラグインが追加済みです: ${clash.path}`);

    const source = github.specString(spec);
    const at = commit ? `（${commit.slice(0, 7)}）` : "";
    const { response } = await dialog.showMessageBox(installer, {
      type: "warning",
      buttons: [current ? "更新" : "追加", "キャンセル"],
      defaultId: 1,
      cancelId: 1,
      message: current
        ? `「${info.name}」を ${info.version} に更新しますか？`
        : `「${info.name}」${info.version} を追加しますか？`,
      detail:
        `${source}${at}\n\nプラグインは mxdeck の中で、mxdeck と同じ権限で動きます` +
        "（ファイル・ネットワーク・各サイトの保存データに触れられます）。信頼できるものだけを追加してください。",
    });
    if (response !== 0) return { canceled: true };

    // 入れ替えは、古いものを退けてから新しいものを置く（途中で失敗しても古いものへ戻せるように）
    const old = fs.existsSync(dest) ? `${tmp}-old` : null;
    if (old) fs.renameSync(dest, old);
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      if (old) fs.renameSync(old, dest);
      throw err;
    }
    if (old) fs.rmSync(old, { recursive: true, force: true });

    // config など手で書いたキーは残す。明示して入れたものなので、無効にしてあっても有効に戻す
    const entry = { path: store.contractHome(dest), ...current, enabled: true, source, commit: commit ?? undefined };
    writeFile(current ? entries.map((e) => (e === current ? entry : e)) : [...entries, entry]);
    host.rebuildMenu();
    installer.close();
    askRestart(current ? `「${info.name}」を更新しました` : `「${info.name}」を追加しました`);
    return { ok: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
  PLUGINS_DIR,
};

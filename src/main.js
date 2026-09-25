// element-multi: 複数の Element Web を1ウィンドウで切り替えるシェル。
// アカウントごとに別 partition（Cookie / IndexedDB / Service Worker が独立）の
// WebContentsView を作り、左端のサイドバーで表示を切り替える。
// 非表示のビューも生かしたまま（backgroundThrottling: false）なので同期と通知は続く。

const { app, BaseWindow, WebContentsView, Menu, shell, ipcMain, nativeImage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SIDEBAR_WIDTH = 72;
const CONFIG_DIR = path.join(os.homedir(), ".config", "element-multi");
const ACCOUNTS_FILE = process.env.ELEMENT_MULTI_ACCOUNTS || path.join(CONFIG_DIR, "accounts.json");
const STATE_FILE = () => path.join(app.getPath("userData"), "state.json");

// Element Web が要求する権限のうち、許可するもの（通知・通話・画面共有・全画面・クリップボード）
const ALLOWED_PERMISSIONS = new Set([
  "notifications",
  "media",
  "display-capture",
  "fullscreen",
  "clipboard-read",
  "clipboard-sanitized-write",
]);

let win;
let sidebar;
let accounts = [];
const views = new Map(); // id -> WebContentsView
const badges = new Map(); // id -> { count, unread }
let activeId;

function expandHome(p) {
  return p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", "accounts.example.json"), ACCOUNTS_FILE);
    console.log(`accounts.json が無いので見本をコピーした: ${ACCOUNTS_FILE}`);
  }
  const { accounts: list } = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  const seen = new Set();
  for (const a of list) {
    if (!/^[a-z0-9_-]+$/i.test(a.id)) throw new Error(`id は英数字と -_ のみ: ${a.id}`);
    if (seen.has(a.id)) throw new Error(`id が重複している: ${a.id}`);
    if (!a.url) throw new Error(`url が無い: ${a.id}`);
    seen.add(a.id);
  }
  return list;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...readState(), ...patch }, null, 2));
}

function iconDataUrl(account) {
  const p = expandHome(account.icon);
  if (!p || !fs.existsSync(p)) return null;
  return nativeImage.createFromPath(p).resize({ width: 96, height: 96, quality: "best" }).toDataURL();
}

// Element Web のタイトルは "<brand> [3]"（通知数）や "* <brand>"（未読のみ）の形になる
function parseTitle(title) {
  const m = title.match(/\[(\d+)\]/);
  return { count: m ? Number(m[1]) : 0, unread: !m && /(^|\s)\*(\s|$)/.test(title) };
}

function pushBadges() {
  const payload = Object.fromEntries(badges);
  sidebar.webContents.send("badges", payload);
  const total = [...badges.values()].reduce((s, b) => s + b.count, 0);
  const anyUnread = [...badges.values()].some((b) => b.unread);
  app.dock?.setBadge(total > 0 ? String(total) : anyUnread ? "•" : "");
}

function layout() {
  const { width, height } = win.getContentBounds();
  sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  for (const v of views.values()) {
    v.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height });
  }
}

function createAccountView(account) {
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:acct-${account.id}`,
      preload: path.join(__dirname, "preload-account.js"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  const wc = view.webContents;
  const ses = wc.session;

  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  // target=_blank のリンクは既定ブラウザへ。ログイン(OIDC)は同じビュー内の遷移なので影響しない
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  wc.on("page-title-updated", (_e, title) => {
    badges.set(account.id, parseTitle(title));
    pushBadges();
    if (account.id === activeId) win.setTitle(`${account.name} — ${title}`);
  });

  wc.on("context-menu", (_e, params) => buildContextMenu(wc, params).popup({ window: win }));

  view.setVisible(false);
  win.contentView.addChildView(view);
  wc.loadURL(account.url);
  views.set(account.id, view);
  badges.set(account.id, { count: 0, unread: false });
  return view;
}

function buildContextMenu(wc, params) {
  const t = [];
  for (const s of params.dictionarySuggestions ?? []) {
    t.push({ label: s, click: () => wc.replaceMisspelling(s) });
  }
  if (params.misspelledWord) {
    t.push({
      label: "辞書に追加",
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    t.push({ type: "separator" });
  }
  if (params.linkURL) {
    t.push({ label: "リンクをブラウザで開く", click: () => shell.openExternal(params.linkURL) });
    t.push({ label: "リンクをコピー", click: () => require("electron").clipboard.writeText(params.linkURL) });
    t.push({ type: "separator" });
  }
  if (params.mediaType === "image" && params.srcURL) {
    t.push({ label: "画像をコピー", click: () => wc.copyImageAt(params.x, params.y) });
    t.push({ type: "separator" });
  }
  const f = params.editFlags;
  if (params.isEditable) {
    t.push({ role: "cut", enabled: f.canCut }, { role: "copy", enabled: f.canCopy });
    t.push({ role: "paste", enabled: f.canPaste }, { role: "selectAll", enabled: f.canSelectAll });
  } else if (params.selectionText) {
    t.push({ role: "copy" });
  }
  if (t.length === 0) t.push({ role: "copy", enabled: false });
  return Menu.buildFromTemplate(t);
}

function activate(id) {
  const account = accounts.find((a) => a.id === id) ?? accounts[0];
  activeId = account.id;
  const view = views.get(activeId) ?? createAccountView(account);
  for (const [vid, v] of views) v.setVisible(vid === activeId);
  layout();
  view.webContents.focus();
  win.setTitle(`${account.name} — ${view.webContents.getTitle()}`);
  sidebar.webContents.send("active", activeId);
  writeState({ activeId });
}

function activeWebContents() {
  return views.get(activeId)?.webContents;
}

function buildMenu() {
  const accountItems = accounts.map((a, i) => ({
    label: a.name,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => activate(a.id),
  }));
  const template = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "表示",
      submenu: [
        { label: "再読み込み", accelerator: "CmdOrCtrl+R", click: () => activeWebContents()?.reload() },
        {
          label: "キャッシュを無視して再読み込み",
          accelerator: "Shift+CmdOrCtrl+R",
          click: () => activeWebContents()?.reloadIgnoringCache(),
        },
        {
          label: "開発者ツール",
          accelerator: "Alt+CmdOrCtrl+I",
          click: () => activeWebContents()?.toggleDevTools(),
        },
        { type: "separator" },
        { label: "拡大", accelerator: "CmdOrCtrl+Plus", click: () => zoom(+0.5) },
        { label: "縮小", accelerator: "CmdOrCtrl+-", click: () => zoom(-0.5) },
        { label: "実際のサイズ", accelerator: "CmdOrCtrl+0", click: () => zoom(null) },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "アカウント",
      submenu: [
        ...accountItems,
        { type: "separator" },
        { label: "accounts.json を開く", click: () => shell.openPath(ACCOUNTS_FILE) },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function zoom(delta) {
  const wc = activeWebContents();
  if (!wc) return;
  wc.setZoomLevel(delta === null ? 0 : wc.getZoomLevel() + delta);
}

function createWindow() {
  const state = readState();
  win = new BaseWindow({
    width: state.bounds?.width ?? 1280,
    height: state.bounds?.height ?? 860,
    x: state.bounds?.x,
    y: state.bounds?.y,
    minWidth: 640,
    minHeight: 480,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 26, y: 18 },
  });

  sidebar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload-sidebar.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.contentView.addChildView(sidebar);
  sidebar.webContents.loadFile(path.join(__dirname, "sidebar.html"));
  sidebar.webContents.once("did-finish-load", () => {
    sidebar.webContents.send(
      "accounts",
      accounts.map((a) => ({ id: a.id, name: a.name, color: a.color, icon: iconDataUrl(a) })),
    );
    activate(state.activeId);
    // 残りのアカウントも裏で読み込み、起動直後から通知・未読が届くようにする
    for (const a of accounts) if (!views.has(a.id)) createAccountView(a);
    layout();
  });

  win.on("resize", layout);
  win.on("close", () => writeState({ bounds: win.getBounds() }));
  win.on("focus", () => activeWebContents()?.focus());
  layout();
}

ipcMain.on("activate", (_e, id) => activate(id));
// 通知クリック時に Element が window.focus() を呼ぶので、そのアカウントへ切り替える
ipcMain.on("focus-me", (e) => {
  for (const [id, v] of views) {
    if (v.webContents === e.sender) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      activate(id);
    }
  }
});

// 保存先は productName（"Element Multi"）ではなく固定名にする。
// 開発起動（pnpm start）と .app で同じ partition を共有し、ログインをやり直さずに済むように。
app.setPath("userData", path.join(app.getPath("appData"), "element-multi"));

// Google 等の IdP は UA に "Electron/" があると埋め込みブラウザ扱いでログインを拒むことがあるので外す
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|element-multi)\/\S+/g, "");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    accounts = loadAccounts();
    buildMenu();
    createWindow();
  });
  app.on("activate", () => {
    if (win) win.show();
  });
  app.on("window-all-closed", () => app.quit());
}

// mxdeck: 複数の Matrix Web クライアントを1ウィンドウで切り替えるシェル。
// アカウントごとに別 partition（Cookie / IndexedDB / Service Worker が独立）の
// WebContentsView を作り、左端のサイドバーで表示を切り替える。
// 非表示のビューも生かしたまま（backgroundThrottling: false）なので同期と通知は続く。

const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  Menu,
  shell,
  ipcMain,
  nativeImage,
  dialog,
  session,
  clipboard,
  powerMonitor,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const store = require("./accounts");
const plugins = require("./plugins");
const siteIcon = require("./site-icon");

const SIDEBAR_WIDTH = 84;
const isMac = process.platform === "darwin";
const STATE_FILE = () => path.join(app.getPath("userData"), "state.json");
const partitionOf = (id) => `persist:acct-${id}`;

// Web クライアントが要求する権限のうち、許可するもの（通知・通話・画面共有・全画面・クリップボード）
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
const badges = new Map(); // id -> { title, favicon }
const edgeColors = new Map(); // id -> [r, g, b]（ページ左端の背景色。サイドバーをこの色に塗る）
const failedUrls = new Map(); // id -> 読み込めなかった URL（エラー画面を出している間の再読み込み先）
const authOrigins = new Map(); // id -> Set<origin>（サインインで通った認証サーバー。state.json にも残す）
const popups = new Set(); // アカウントのページがアプリ内に開いたウィンドウ
let activeId;
let editor; // { win, targetId }（targetId が無ければ新規追加）

const findAccount = (id) => accounts.find((a) => a.id === id);

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// IPC は送り元を確かめる。アカウントのビューは外部の Web ページなので、
// サイドバーや編集シート向けのチャンネルを叩けないようにする（preload で公開していなくても念のため）
const fromSidebar = (e) => e.sender === sidebar?.webContents;
const fromEditor = (e) => !!editor && e.sender === editor.win.webContents;
const onSidebar = (channel, fn) => ipcMain.on(channel, (e, ...args) => fromSidebar(e) && fn(...args));
const handleEditor = (channel, fn) =>
  ipcMain.handle(channel, (e, ...args) => (fromEditor(e) ? fn(...args) : { error: "forbidden" }));

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

function iconDataUrl(iconPath) {
  const p = store.expandHome(iconPath);
  if (!p || !fs.existsSync(p)) return null;
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? null : img.resize({ width: 96, height: 96, quality: "best" }).toDataURL();
}

// ---------------------------------------------------------------------------
// 未読バッジ
// 未読の拾い方はクライアントごとに違うので、タイトルと favicon の両方から拾って合成する。
// どちらの形式にも当てはまらないクライアントは、バッジが出ないだけで他は動く。

// Element Web: タイトルが "<brand> [3]"（通知数）や "* <brand>"（未読のみ）になる
function parseTitle(title) {
  const m = title.match(/\[(\d+)\]/);
  return { count: m ? Number(m[1]) : 0, unread: !m && /(^|\s)\*(\s|$)/.test(title) };
}

// Cinny: favicon を data URL の SVG で差し替える。メンションありは緑、未読ありは灰のロゴ
function parseFavicons(favicons) {
  const svg = decodeURIComponent(favicons.find((u) => u.startsWith("data:image/svg")) ?? "").toUpperCase();
  return { mention: svg.includes("#45B83B"), unread: svg.includes("#989898") };
}

function setSignal(id, key, value) {
  const b = badges.get(id);
  if (!b) return;
  b[key] = value;
  pushBadges();
}

function mergedBadge({ title, favicon }) {
  return {
    count: title.count,
    mention: favicon.mention,
    unread: title.unread || favicon.unread || favicon.mention,
  };
}

let appBadge = "";

function pushBadges() {
  const merged = Object.fromEntries([...badges].map(([id, b]) => [id, mergedBadge(b)]));
  sidebar.webContents.send("badges", merged);
  const all = Object.values(merged);
  const total = all.reduce((s, b) => s + b.count, 0);
  const label = total > 0 ? String(total) : all.some((b) => b.mention) ? "!" : all.some((b) => b.unread) ? "•" : "";
  if (label === appBadge) return;
  appBadge = label;
  // macOS は Dock に文字で出せる。Windows のタスクバーは画像しか重ねられないので、サイドバーに描いてもらう
  if (isMac) app.dock?.setBadge(label);
  else if (process.platform === "win32") sidebar.webContents.send("taskbar-badge", label);
}

// ---------------------------------------------------------------------------
// アカウントのビュー

function layout() {
  const { width, height } = win.getContentBounds();
  sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  for (const v of views.values()) {
    v.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height });
  }
}

// ウィンドウ全体が白いまま描かれなくなることがある（Windows で GPU プロセスが落ちて作り直されたとき、
// スリープ・画面ロックから戻ったときなど）。ウィンドウを動かしても直らないので、ビューの大きさを一度変えて
// 描き直させる。大きさが同じだと新しいフレームが作られない
function repaint(reason) {
  if (!win || win.isDestroyed()) return;
  log(`repaint: ${reason}`);
  const { width, height } = win.getContentBounds();
  sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height: Math.max(0, height - 1) });
  for (const v of views.values()) {
    v.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH - 1), height });
  }
  setTimeout(() => {
    if (win.isDestroyed()) return;
    layout();
    for (const wc of [sidebar.webContents, activeWebContents()]) if (wc && !wc.isDestroyed()) wc.invalidate();
  }, 50);
}

// 白くなった原因を後から追えるよう、プロセスが落ちた・描き直したといった出来事を userData/mxdeck.log に残す
function log(message) {
  const file = path.join(app.getPath("userData"), "mxdeck.log");
  try {
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > 1_000_000) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function createAccountView(account) {
  const { id } = account;
  const view = new WebContentsView({
    webPreferences: {
      partition: partitionOf(id),
      preload: path.join(__dirname, "preload-account.js"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true,
      // フレームに差し込むプラグインがあるときだけ、iframe でも preload を走らせる
      nodeIntegrationInSubFrames: plugins.usesFrames(),
    },
  });
  const wc = view.webContents;
  const ses = wc.session;
  plugins.prepareAccountSession(ses);

  // 権限はそのアカウントのサイトを表示している間だけ出す。SSO などで別サイトへ移った画面には出さない。
  // 判定はトップレベルの URL で行う（通話ウィジェット等の iframe は親ページの許可で動く）。
  // webContents が無い確認（Service Worker 等）は、要求元のオリジンで判定する。
  const allowed = (w, permission, requestingOrigin) => {
    const account = findAccount(id);
    if (!account || !ALLOWED_PERMISSIONS.has(permission)) return false;
    const origin = w && !w.isDestroyed() ? originOf(w.getURL()) : originOf(requestingOrigin);
    return origin !== null && origin === originOf(account.url);
  };
  ses.setPermissionRequestHandler((w, permission, callback, details) =>
    callback(allowed(w, permission, details?.requestingUrl)),
  );
  ses.setPermissionCheckHandler((w, permission, requestingOrigin) => allowed(w, permission, requestingOrigin));

  handleWindowOpen(id, wc);
  wc.on("did-start-navigation", (e) => e.isMainFrame && !e.isSameDocument && noteAuthOrigin(id, wc.getURL(), e.url));

  // Electron は読み込めなくてもエラー画面を出さず、白いままになる。理由と直し方を出す。
  // -3 は中断（別の遷移に置き換わった等）で失敗ではない。http(s) 以外（アプリを呼ぶスキーム等）も対象外
  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    const account = findAccount(id);
    if (!account || !isMainFrame || code === -3 || !/^https?:/.test(url)) return;
    failedUrls.set(id, url);
    wc.loadURL(errorPage(account, url, description));
  });

  wc.on("page-title-updated", (_e, title) => {
    setSignal(id, "title", parseTitle(title));
    if (id === activeId) updateWindowTitle();
  });
  wc.on("page-favicon-updated", (_e, favicons) => setSignal(id, "favicon", parseFavicons(favicons)));

  wc.on("context-menu", (_e, params) => buildContextMenu(wc, params).popup({ window: win }));

  // ページのプロセスが落ちると白いままになる。読み込み直す（メモリ不足で殺された等。正常終了は除く）
  wc.on("render-process-gone", (_e, details) => {
    log(`account ${id} renderer gone: ${details.reason} (${details.exitCode})`);
    if (details.reason !== "clean-exit" && views.get(id)?.webContents === wc) reloadAccount(id);
  });

  view.setVisible(false);
  win.contentView.addChildView(view);
  wc.loadURL(account.url);
  views.set(id, view);
  badges.set(id, { title: { count: 0, unread: false }, favicon: { mention: false, unread: false } });
  return view;
}

function destroyAccountView(id) {
  const view = views.get(id);
  if (!view) return;
  win.contentView.removeChildView(view);
  view.webContents.close();
  views.delete(id);
  badges.delete(id);
  edgeColors.delete(id);
  failedUrls.delete(id);
}

// アカウントのページが開こうとするウィンドウ。メッセージ内のリンクなどは既定ブラウザへ。
// ただしサインインの続き（認証サーバーで本人確認のリセットを承認する、IdP のポップアップ等）をブラウザで開くと、
// そこにはこのアカウントのログイン状態が無く、済ませても結果がアプリへ戻らない。そういうものは同じ保存領域の
// 子ウィンドウで開く。見分け方は、サイズ指定つきのポップアップか、宛先が認証サーバーか。
// このアカウントのサイトを新しいタブとして開くもの（ウェルカム画面の「サインイン」が target=_blank のクライアント
// もある）は、アカウントのビューそのもので開く。別のウィンドウにすると同じ保存領域でクライアントが2つ動き、
// ログインがそちらで済んでしまう（Element は「別のウィンドウで開いています」になる）
function handleWindowOpen(id, wc) {
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const origin = originOf(url);
    const web = /^https?:/.test(url);
    if (web && disposition !== "new-window" && origin === originOf(findAccount(id)?.url)) {
      views.get(id)?.webContents.loadURL(url);
      // 子ウィンドウから開いたときは、メインウィンドウを前に出す
      if (wc !== views.get(id)?.webContents) {
        win.focus();
        activate(id);
      }
      return { action: "deny" };
    }
    if (web && (disposition === "new-window" || authOriginsOf(id).has(origin))) {
      // ポップアップはページが指定した大きさのまま。新しいタブとして開くもの（認証サーバー）は普通のブラウザくらいで
      const size = disposition === "new-window" ? {} : { width: 1000, height: 800 };
      return { action: "allow", overrideBrowserWindowOptions: size };
    }
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("did-create-window", (child) => {
    popups.add(child);
    child.on("closed", () => popups.delete(child));
    child.removeMenu(); // Windows ではアプリのメニューバーが付き、Ctrl+R 等がメインウィンドウに効いてしまう
    const cwc = child.webContents;
    handleWindowOpen(id, cwc);
    cwc.on("context-menu", (_e, params) => buildContextMenu(cwc, params).popup({ window: child }));
    // どのアカウントのウィンドウかをタイトルで示す
    cwc.on("page-title-updated", (e, title) => {
      e.preventDefault();
      child.setTitle(`${title} — ${findAccount(id)?.name ?? app.getName()}`);
    });
  });
}

function authOriginsOf(id) {
  if (!authOrigins.has(id)) authOrigins.set(id, new Set(readState().authOrigins?.[id] ?? []));
  return authOrigins.get(id);
}

// アカウントのサイトから別のオリジンへ移ったら、そこを認証サーバーとして覚える（OIDC の MAS、SSO の
// ホームサーバー）。覚えるのは最初の一歩だけで、その先の IdP（Google 等）は含めない。
// IdP のサイト（github.com 等）へのリンクまでアプリ内で開くことになるため
function noteAuthOrigin(id, from, to) {
  const home = originOf(findAccount(id)?.url);
  const origin = originOf(to);
  if (!home || originOf(from) !== home || !/^https?:/.test(to) || origin === home) return;
  const known = authOriginsOf(id);
  if (known.has(origin)) return;
  known.add(origin);
  writeState({ authOrigins: { ...readState().authOrigins, [id]: [...known] } });
}

function forgetAuthOrigins(id) {
  authOrigins.delete(id);
  const { [id]: _, ...rest } = readState().authOrigins ?? {};
  writeState({ authOrigins: rest });
}

function errorPage(account, url, description) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<title>読み込めませんでした</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif; }
  main { max-width: 560px; margin: 18vh auto 0; padding: 0 32px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  code { word-break: break-all; }
  .muted { opacity: 0.6; }
</style>
<main>
  <h1>「${esc(account.name)}」を読み込めませんでした</h1>
  <p><code>${esc(url)}</code><br><span class="muted">${esc(description)}</span></p>
  <p>URL が合っているか、ネットワークにつながっているかを確かめてください。</p>
  <p>URL を直すときは、サイドバーのアイコンを右クリックして「編集…」。保存すると読み込み直します。</p>
  <p><a href="${esc(url)}">もう一度読み込む</a>（${isMac ? "⌘R" : "Ctrl+R"}）</p>
</main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// エラー画面を出しているときは、読み込めなかった URL から読み直す（reload だとエラー画面を読み直すだけ）
function reloadAccount(id, { ignoreCache = false } = {}) {
  const wc = views.get(id)?.webContents;
  if (!wc) return;
  if (wc.getURL().startsWith("data:") && failedUrls.has(id)) wc.loadURL(failedUrls.get(id));
  else if (ignoreCache) wc.reloadIgnoringCache();
  else wc.reload();
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
    t.push({ label: "リンクをコピー", click: () => clipboard.writeText(params.linkURL) });
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

function updateWindowTitle() {
  const account = findAccount(activeId);
  const pageTitle = views.get(activeId)?.webContents.getTitle();
  win.setTitle(account ? `${account.name} — ${pageTitle}` : app.getName());
}

function activate(id) {
  const account = findAccount(id) ?? accounts[0];
  activeId = account?.id;
  for (const [vid, v] of views) v.setVisible(vid === activeId);
  if (account) {
    const view = views.get(activeId) ?? createAccountView(account);
    view.setVisible(true);
    layout();
    view.webContents.focus();
    writeState({ activeId });
  }
  updateWindowTitle();
  sidebar.webContents.send("active", activeId);
  pushEdgeColor();
}

function pushEdgeColor() {
  sidebar.webContents.send("edge", edgeColors.get(activeId) ?? null);
}

function activeWebContents() {
  return views.get(activeId)?.webContents;
}

// ---------------------------------------------------------------------------
// アカウント一覧の変更。追加・編集・削除・並べ替え・ファイルからの読み直しは全部ここを通す。

function sendAccounts() {
  sidebar.webContents.send(
    "accounts",
    accounts.map((a) => ({ id: a.id, name: a.name, color: a.color, icon: iconDataUrl(a.icon) })),
  );
  sidebar.webContents.send("active", activeId);
  pushBadges();
}

function applyAccounts(next, { save = true } = {}) {
  if (save) store.save(next);
  const nextIds = new Set(next.map((a) => a.id));
  for (const id of [...views.keys()]) if (!nextIds.has(id)) destroyAccountView(id);
  for (const a of next) {
    const before = findAccount(a.id);
    if (views.has(a.id) && before && before.url !== a.url) views.get(a.id).webContents.loadURL(a.url);
  }
  accounts = next;
  for (const a of accounts) if (!views.has(a.id)) createAccountView(a);
  buildMenu();
  sendAccounts();
  activate(nextIds.has(activeId) ? activeId : accounts[0]?.id);
  layout();
}

function reloadAccountsFile() {
  try {
    applyAccounts(store.load(), { save: false });
  } catch (err) {
    dialog.showErrorBox("accounts.json を読めませんでした", String(err.message ?? err));
  }
}

async function removeAccount(id) {
  const account = findAccount(id);
  if (!account) return;
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["削除", "キャンセル"],
    defaultId: 1,
    cancelId: 1,
    message: `「${account.name}」を削除しますか？`,
    detail:
      "一覧から外します。保存データを残しておけば、同じ URL で追加し直したときにログイン状態が戻ります。\n" +
      "サーバー側のセッション（ログイン中の端末）は消えないので、不要ならクライアントの中で先にログアウトしてください。",
    checkboxLabel: "このアカウントの保存データも消す（ログイン状態・暗号鍵・キャッシュ）",
    checkboxChecked: false,
  });
  if (response !== 0) return;
  applyAccounts(accounts.filter((a) => a.id !== id));
  // データを残した場合は、同じ URL で追加し直したときにこの id（保存領域）を使えるよう覚えておく
  const kept = (readState().removed ?? []).filter((r) => r.id !== id);
  if (!checkboxChecked) kept.push({ id, url: account.url });
  writeState({ removed: kept });
  if (checkboxChecked) {
    const ses = session.fromPartition(partitionOf(id));
    await ses.clearStorageData();
    await ses.clearCache();
    store.removeImportedIcon(account);
    forgetAuthOrigins(id);
  }
}

function reorderAccounts(ids) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const next = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
  for (const a of accounts) if (!next.includes(a)) next.push(a);
  if (next.every((a, i) => a === accounts[i])) return;
  applyAccounts(next);
}

// ---------------------------------------------------------------------------
// アカウントの追加・編集シート

function openEditor(targetId) {
  if (editor) {
    editor.win.focus();
    return;
  }
  const w = new BrowserWindow({
    parent: win,
    modal: true,
    width: 460,
    height: 390,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-editor.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  w.removeMenu(); // Windows では子ウィンドウにもアプリのメニューバーが付くので外す
  editor = { win: w, targetId };
  w.loadFile(path.join(__dirname, "editor.html"));
  w.once("ready-to-show", () => w.show());
  w.on("closed", () => {
    editor = undefined;
    activeWebContents()?.focus();
  });
}

handleEditor("editor:init", () => {
  const account = editor?.targetId ? findAccount(editor.targetId) : undefined;
  if (!account) return { isNew: true, account: { name: "", url: "", color: "#0dbd8b", icon: null } };
  return {
    isNew: false,
    account: { ...account, iconPreview: iconDataUrl(account.icon), partition: partitionOf(account.id) },
  };
});

handleEditor("editor:choose-icon", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(editor.win, {
    properties: ["openFile"],
    filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "webp", "icns", "tiff", "ico", "bmp"] }],
  });
  if (canceled || !filePaths[0]) return null;
  const preview = iconDataUrl(filePaths[0]);
  return preview ? { path: filePaths[0], preview } : { error: "この画像は読み込めませんでした" };
});

// サイトのアイコンは一時フォルダに落とし、保存したときに「画像を選ぶ」と同じ経路で icons/ へコピーする
handleEditor("editor:fetch-icon", async (input) => {
  let url;
  try {
    url = store.normalizeUrl(input);
  } catch {
    return { error: "URL が正しくありません（https://… の形で入れてください）" };
  }
  // 編集中のアカウントならその保存領域で取りに行く（ログインが要るサイトでも Cookie が付く）
  const ses = editor.targetId ? session.fromPartition(partitionOf(editor.targetId)) : session.defaultSession;
  const dir = path.join(app.getPath("temp"), "mxdeck-site-icon");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  try {
    return await siteIcon.findIcon(url, {
      fetch: (u, opts) => ses.fetch(u, opts),
      accept: (buf, ext) => {
        // ICO は PNG にしてから置く（macOS の nativeImage は ICO を読めない）
        const ico = ext === ".ico" && siteIcon.fromIco(buf);
        if (ico) {
          buf = ico.png ?? nativeImage.createFromBitmap(ico.bgra, { width: ico.width, height: ico.height }).toPNG();
          ext = ".png";
        }
        const p = path.join(dir, `icon-${++n}${ext}`);
        fs.writeFileSync(p, buf);
        const preview = iconDataUrl(p);
        return preview && { path: p, preview };
      },
    });
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
});

handleEditor("editor:save", (data = {}) => {
  const name = String(data.name ?? "").trim();
  if (!name) return { error: "名前を入れてください" };
  let url;
  try {
    url = store.normalizeUrl(data.url);
  } catch {
    return { error: "URL が正しくありません（https://… の形で入れてください）" };
  }
  const targetId = editor?.targetId;
  const before = targetId ? findAccount(targetId) : undefined;
  const ids = accounts.map((a) => a.id);
  // データを残して削除したアカウントと同じ URL なら、その保存領域を引き継ぐ（ログイン状態が戻る）
  const removed = readState().removed ?? [];
  const revived = before ? undefined : removed.find((r) => r.url === url && !ids.includes(r.id));
  const id = before?.id ?? revived?.id ?? store.makeId(name, url, ids);

  // 手で書き足した未知のキーは残す
  const entry = { ...before, id, name, url };
  if (data.color) entry.color = data.color;
  if (data.iconChanged) {
    if (data.icon) entry.icon = store.importIcon(id, data.icon);
    else delete entry.icon;
  }

  try {
    applyAccounts(before ? accounts.map((a) => (a.id === id ? entry : a)) : [...accounts, entry]);
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
  if (revived) writeState({ removed: removed.filter((r) => r !== revived) });
  if (!before) activate(id);
  editor?.win.close();
  return { ok: true };
});

ipcMain.on("editor:cancel", (e) => fromEditor(e) && editor.win.close());

// ---------------------------------------------------------------------------
// メニュー

function buildMenu() {
  const accountItems = accounts.map((a, i) => ({
    label: a.name,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => activate(a.id),
  }));
  const template = [
    // Windows にはアプリ名のメニューが無いので、終了はファイルメニューに置く
    isMac ? { role: "appMenu" } : { label: "ファイル", submenu: [{ role: "quit", label: "終了" }] },
    { role: "editMenu" },
    {
      label: "表示",
      submenu: [
        { label: "再読み込み", accelerator: "CmdOrCtrl+R", click: () => reloadAccount(activeId) },
        {
          label: "キャッシュを無視して再読み込み",
          accelerator: "Shift+CmdOrCtrl+R",
          click: () => reloadAccount(activeId, { ignoreCache: true }),
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
        { type: "separator" },
        { label: "メモリ使用量…", click: showMemoryReport },
        // ウィンドウが白いまま戻らないときの手動の逃げ道
        { label: "画面を描き直す", click: () => repaint("menu") },
      ],
    },
    {
      label: "アカウント",
      submenu: [
        ...accountItems,
        { type: "separator" },
        { label: "アカウントを追加…", accelerator: "CmdOrCtrl+Shift+N", click: () => openEditor() },
        // メニューは activeId が決まる前にも作るので、有効/無効ではなく押したときに判定する
        { label: "表示中のアカウントを編集…", click: () => activeId && openEditor(activeId) },
        { label: "表示中のアカウントを削除…", click: () => activeId && removeAccount(activeId) },
        { type: "separator" },
        { label: "accounts.json を開く", click: () => shell.openPath(store.ACCOUNTS_FILE) },
        { label: "accounts.json を読み直す", click: reloadAccountsFile },
      ],
    },
    plugins.menuTemplate(),
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// メモリ使用量
// アカウント1つが複数のプロセスを使うことがある（ウィジェットなど別オリジンの iframe はサイト分離で別プロセス）。
// フレームが載っているプロセスをたどってアカウントごとに合算し、残りは Electron 本体側として種類別に出す。

function memoryReport() {
  const metrics = app.getAppMetrics();
  const kbOf = new Map(metrics.map((m) => [m.pid, m.memory.workingSetSize])); // macOS では KB 単位
  const claimed = new Set();
  const pidsOf = (wc) => {
    if (!wc || wc.isDestroyed()) return [];
    const pids = new Set([wc.getOSProcessId()]);
    for (const f of wc.mainFrame?.framesInSubtree ?? []) if (f.osProcessId) pids.add(f.osProcessId);
    return [...pids].filter((pid) => !claimed.has(pid));
  };
  const sum = (pids) => pids.reduce((s, pid) => s + (kbOf.get(pid) ?? 0), 0);
  const claim = (name, pids) => {
    pids.forEach((pid) => claimed.add(pid));
    return { name, processes: pids.length, kb: sum(pids) };
  };

  const rows = accounts.map((a) => claim(a.name, pidsOf(views.get(a.id)?.webContents)));
  rows.push(claim("（サイドバー）", pidsOf(sidebar.webContents)));
  for (const p of plugins.windowsByPlugin()) {
    const pids = [...new Set(p.webContents.flatMap(pidsOf))];
    if (pids.length) rows.push(claim(`（プラグイン: ${p.name}）`, pids));
  }

  const byType = new Map();
  for (const m of metrics) {
    if (claimed.has(m.pid)) continue;
    const key = m.type === "Utility" && m.serviceName ? `Utility: ${m.serviceName}` : m.type;
    const t = byType.get(key) ?? { processes: 0, kb: 0 };
    t.processes += 1;
    t.kb += m.memory.workingSetSize;
    byType.set(key, t);
  }
  for (const [type, t] of byType) rows.push({ name: `（${type}）`, ...t });
  return { rows, totalKb: metrics.reduce((s, m) => s + m.memory.workingSetSize, 0), processes: metrics.length };
}

function showMemoryReport() {
  const { rows, totalKb, processes } = memoryReport();
  const mb = (kb) => `${Math.round(kb / 1024)} MB`;
  const lines = rows.sort((x, y) => y.kb - x.kb).map((r) => `${r.name}: ${mb(r.kb)}（${r.processes} プロセス）`);
  dialog.showMessageBox(win, {
    type: "info",
    message: `メモリ使用量 合計 ${mb(totalKb)}（${processes} プロセス）`,
    detail:
      `${lines.join("\n")}\n\n各プロセスの working set（共有メモリを含む）の合計。` +
      `${isMac ? "アクティビティモニタ" : "タスクマネージャー"}の「メモリ」とは数え方が違う。`,
  });
}

function zoom(delta) {
  const wc = activeWebContents();
  if (!wc) return;
  wc.setZoomLevel(delta === null ? 0 : wc.getZoomLevel() + delta);
}

// ---------------------------------------------------------------------------
// ウィンドウ

function createWindow() {
  const state = readState();
  win = new BaseWindow({
    width: state.bounds?.width ?? 1280,
    height: state.bounds?.height ?? 860,
    x: state.bounds?.x,
    y: state.bounds?.y,
    minWidth: 640,
    minHeight: 480,
    // macOS はタイトルバーを隠し、信号機ボタンをサイドバーの上に置く。
    // Windows は普通の枠とメニューバーのまま（ボタンを重ねると、ページの右上にあるボタンに被る）
    ...(isMac && {
      titleBarStyle: "hiddenInset",
      // 信号機ボタンがサイドバーの幅に収まる位置（macOS 26 では3つで幅 60pt ほど）。
      // はみ出すとアカウントのページ左上（Element のスペース一覧など）に被る
      trafficLightPosition: { x: 12, y: 18 },
    }),
  });
  if (state.maximized) win.maximize();

  sidebar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload-sidebar.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.contentView.addChildView(sidebar);
  sidebar.webContents.loadFile(path.join(__dirname, "sidebar.html"), { query: { platform: process.platform } });
  sidebar.webContents.once("did-finish-load", () => {
    sendAccounts();
    activate(state.activeId);
    // 残りのアカウントも裏で読み込み、起動直後から通知・未読が届くようにする
    for (const a of accounts) if (!views.has(a.id)) createAccountView(a);
    layout();
    if (accounts.length === 0) openEditor();
    plugins.showErrors();
  });

  win.on("resize", layout);
  // 最大化したまま閉じても、元の大きさを覚えておく
  win.on("close", () => writeState({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
  win.on("closed", () => {
    plugins.closeAll();
    for (const w of popups) w.close();
  });
  win.on("focus", () => activeWebContents()?.focus());
  // サイドバーのプロセスが落ちたら読み込み直し、一覧・選択中・バッジ・色を送り直す
  sidebar.webContents.on("render-process-gone", (_e, details) => {
    log(`sidebar renderer gone: ${details.reason} (${details.exitCode})`);
    if (details.reason === "clean-exit") return;
    sidebar.webContents.once("did-finish-load", () => {
      sendAccounts();
      pushEdgeColor();
    });
    sidebar.webContents.reload();
  });
  layout();
}

onSidebar("activate", (id) => activate(id));
onSidebar("add-account", () => openEditor());
onSidebar("reorder", (ids) => Array.isArray(ids) && reorderAccounts(ids));
// タスクバーのボタンに重ねる未読バッジ（sidebar.js が描いた PNG）
onSidebar("taskbar-badge", (dataUrl) => {
  if (process.platform !== "win32") return;
  const ok = typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,");
  const img = ok ? nativeImage.createFromDataURL(dataUrl) : null;
  win.setOverlayIcon(img && !img.isEmpty() ? img : null, img ? "未読あり" : "");
});
onSidebar("account-menu", (id) => {
  if (!findAccount(id)) return;
  Menu.buildFromTemplate([
    { label: "編集…", click: () => openEditor(id) },
    { label: "再読み込み", click: () => reloadAccount(id) },
    { type: "separator" },
    { label: "削除…", click: () => removeAccount(id) },
  ]).popup({ window: win });
});
// アカウントのビューの最上位フレームから来た IPC なら、そのアカウントの id
function accountIdOf(e) {
  if (!e.senderFrame || e.senderFrame.parent) return undefined;
  for (const [id, v] of views) if (v.webContents === e.sender) return id;
  return undefined;
}

// 通知がクリックされたら（preload-account.js が知らせてくる）、そのアカウントへ切り替える
ipcMain.on("focus-me", (e) => {
  const id = accountIdOf(e);
  if (!id) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  activate(id);
});
// ページ左端の背景色（preload-account.js が知らせてくる）。外部のページから来る値なので rgb の数値だけ取り出す
ipcMain.on("edge-color", (e, color) => {
  const id = accountIdOf(e);
  if (!id) return;
  const m = typeof color === "string" && color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  if (m) edgeColors.set(id, m.slice(1).map((n) => Math.min(255, Number(n))));
  else edgeColors.delete(id);
  if (id === activeId) pushEdgeColor();
});

// 保存先を固定名にする。開発起動（pnpm start）の既定は package.json の name、.app は productName で
// 変わりうるので、両方で同じ partition を共有してログインをやり直さずに済むように明示する。
// MXDECK_USER_DATA は動作確認用（普段使いのログイン状態に触れずに別の保存先で起動する）
app.setPath("userData", process.env.MXDECK_USER_DATA || path.join(app.getPath("appData"), "mxdeck"));

// Windows の通知（トースト）はアプリの ID で束ねられる。インストーラが作るショートカットの ID に合わせる
if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId("com.knatrix.mxdeck");

// Windows では、ほかのウィンドウに覆われたと判定されたウィンドウの描画が止まり、前に出しても白いまま戻らない
// ことがある（Chromium のウィンドウ遮蔽の計算。画面共有や全画面のウィンドウが重なったとき等）。使わない
if (process.platform === "win32") app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// Google 等の IdP は UA に "Electron/" があると埋め込みブラウザ扱いでログインを拒むことがあるので外す
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|mxdeck)\/\S+/g, "");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    try {
      accounts = store.load();
    } catch (err) {
      // 壊れたファイルを空の一覧で上書きしないよう、別名に退避してから空で始める
      const backup = `${store.ACCOUNTS_FILE}.broken-${Date.now()}`;
      fs.renameSync(store.ACCOUNTS_FILE, backup);
      dialog.showErrorBox(
        "accounts.json を読めませんでした",
        `${err.message ?? err}\n\n元のファイルは次へ退避しました:\n${backup}`,
      );
      accounts = [];
    }
    plugins.load({
      win: () => win,
      accounts: () => accounts,
      activeId: () => activeId,
      accountViews: () =>
        [...views].flatMap(([id, v]) => {
          const account = findAccount(id);
          return account && !v.webContents.isDestroyed() ? [{ account, wc: v.webContents }] : [];
        }),
      rebuildMenu: () => buildMenu(),
    });
    buildMenu();
    createWindow();
    // GPU プロセスが落ちると作り直されるが、ビューが白いまま残ることがある。作り直しを待ってから描き直す
    app.on("child-process-gone", (_e, details) => {
      log(`${details.type} process gone: ${details.reason} (${details.exitCode})`);
      if (details.type === "GPU") setTimeout(() => repaint("gpu process gone"), 1000);
    });
    // スリープ・画面ロックから戻ったときも白くなることがある
    powerMonitor.on("resume", () => repaint("resume"));
    powerMonitor.on("unlock-screen", () => repaint("unlock-screen"));
  });
  app.on("activate", () => {
    if (win) win.show();
  });
  app.on("window-all-closed", () => app.quit());
}

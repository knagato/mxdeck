// accounts.json の読み書き。画面（ビュー・サイドバー・メニュー）への反映は main.js が行う。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_DIR = path.join(os.homedir(), ".config", "mxdeck");
const ACCOUNTS_FILE = process.env.MXDECK_ACCOUNTS || path.join(CONFIG_DIR, "accounts.json");
// アプリから選んだアイコンはここへコピーする（元ファイルを動かしても消えないように）
const ICON_DIR = path.join(CONFIG_DIR, "icons");

function expandHome(p) {
  return p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function contractHome(p) {
  const home = os.homedir() + path.sep;
  return p.startsWith(home) ? "~/" + p.slice(home.length) : p;
}

function validate(list) {
  const seen = new Set();
  for (const a of list) {
    if (!/^[a-z0-9_-]+$/i.test(a.id ?? "")) throw new Error(`id は英数字と -_ のみ: ${a.id}`);
    if (seen.has(a.id)) throw new Error(`id が重複している: ${a.id}`);
    if (!a.url) throw new Error(`url が無い: ${a.id}`);
    seen.add(a.id);
  }
  return list;
}

function load() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", "accounts.example.json"), ACCOUNTS_FILE);
    console.log(`accounts.json が無いので見本をコピーした: ${ACCOUNTS_FILE}`);
  }
  return validate(JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")).accounts ?? []);
}

// 書きかけのファイルを読まれないよう、一時ファイルに書いてから置き換える
function save(list) {
  validate(list);
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  const tmp = `${ACCOUNTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ accounts: list }, null, 2) + "\n");
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

// "matrix.org" や "https://app.cinny.in/login" のように省略した入力も受ける
function normalizeUrl(input) {
  const s = String(input ?? "").trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("http(s) の URL だけ使える");
  return url.toString();
}

// id は partition 名（保存領域）になるので、一度決めたら変えない。名前が日本語ならホスト名から作る
function makeId(name, url, existingIds) {
  const slug = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
  const base = slug(name) || slug(new URL(url).hostname) || "account";
  let id = base;
  for (let n = 2; existingIds.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function importIcon(id, srcPath) {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const dst = path.join(ICON_DIR, `${id}${path.extname(srcPath).toLowerCase() || ".png"}`);
  if (path.resolve(srcPath) !== path.resolve(dst)) {
    // 拡張子違いの古いアイコンが残らないように消しておく
    for (const f of fs.readdirSync(ICON_DIR)) if (path.parse(f).name === id) fs.rmSync(path.join(ICON_DIR, f));
    fs.copyFileSync(srcPath, dst);
  }
  return contractHome(dst);
}

// アプリがコピーしたアイコン（ICON_DIR 配下）だけ消す。ユーザーが指定した外部ファイルには触らない
function removeImportedIcon(account) {
  const p = expandHome(account.icon);
  if (p && path.dirname(path.resolve(p)) === path.resolve(ICON_DIR)) fs.rmSync(p, { force: true });
}

module.exports = {
  ACCOUNTS_FILE,
  expandHome,
  contractHome,
  load,
  save,
  normalizeUrl,
  makeId,
  importIcon,
  removeImportedIcon,
};

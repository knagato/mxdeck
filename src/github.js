// GitHub のリポジトリからプラグインを取ってくる。git は使わず、アーカイブ（tar.gz）を落として展開する
// （git の無い Mac でも動くように）。electron に依存しないので node:test で確かめられる。
const { spawn } = require("node:child_process");
const path = require("node:path");
const zlib = require("node:zlib");

const BASE = process.env.MXDECK_GITHUB || "https://github.com";
const MAX_BYTES = 50 * 1024 * 1024;
const NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

// 受け付ける書き方:
//   owner/repo, owner/repo#ref, github:owner/repo#ref,
//   https://github.com/owner/repo(.git), …/tree/<ref>, …/releases/tag/<ref>, …/commit/<sha>
// ref が無ければ既定のブランチ
function parseSpec(input) {
  let s = String(input ?? "").trim();
  let ref;
  const hash = s.indexOf("#");
  if (hash >= 0) {
    ref = s.slice(hash + 1);
    s = s.slice(0, hash);
  }
  s = s.replace(/^github:/, "").replace(/^(https?:\/\/)?(www\.)?github\.com\//, "");
  const [owner, repo = "", ...rest] = s.replace(/\/+$/, "").split("/");
  const name = repo.replace(/\.git$/, "");
  if (!NAME_RE.test(owner) || !NAME_RE.test(name)) {
    throw new Error("owner/repo か GitHub の URL で入れてください");
  }
  if (rest.length) {
    const kind = rest.slice(0, rest[0] === "releases" ? 2 : 1).join("/");
    const tail = rest.slice(kind.split("/").length).join("/");
    if (!["tree", "releases/tag", "commit"].includes(kind) || !tail) {
      throw new Error("リポジトリのトップ・ブランチ（/tree/…）・タグ・コミットの URL で入れてください");
    }
    ref ??= decodeURIComponent(tail);
  }
  if (ref !== undefined && !ref.trim()) throw new Error("# の後ろにブランチ・タグ・コミットを書いてください");
  return { owner, repo: name, ref: ref?.trim() };
}

const specString = ({ owner, repo, ref }) => `github:${owner}/${repo}${ref ? `#${ref}` : ""}`;

// git archive の tar は、先頭の pax グローバルヘッダの comment にコミットの SHA を持っている
function commitOf(tar) {
  if (tar.length < 1024 || String.fromCharCode(tar[156]) !== "g") return null;
  const size = parseInt(tar.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8);
  const body = tar.subarray(512, 512 + (size || 0)).toString();
  return /(?:^|\n)\d+ comment=([0-9a-f]{40})\n/.exec(body)?.[1] ?? null;
}

// アーカイブを dest（空のフォルダ）へ展開し、{ commit } を返す。
// アーカイブは <repo>-<ref>/ の下に入っているので、1 階層はがす
async function download(spec, dest, { fetch = globalThis.fetch, base = BASE } = {}) {
  const ref = spec.ref ? spec.ref.split("/").map(encodeURIComponent).join("/") : "HEAD";
  const url = `${base}/${spec.owner}/${spec.repo}/archive/${ref}.tar.gz`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new Error(`ダウンロードできませんでした: ${err.cause?.message ?? err.message ?? err}`);
  }
  if (res.status === 404) {
    throw new Error(
      `${spec.owner}/${spec.repo}${spec.ref ? ` の ${spec.ref}` : ""} が見つかりません（非公開のリポジトリには対応していません）`,
    );
  }
  if (!res.ok) throw new Error(`ダウンロードできませんでした（HTTP ${res.status}）`);
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new Error("アーカイブが大きすぎます");
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.length > MAX_BYTES) throw new Error("アーカイブが大きすぎます");
  let tar;
  try {
    tar = zlib.gunzipSync(gz);
  } catch {
    throw new Error("ダウンロードしたものが tar.gz ではありません");
  }
  await untar(tar, dest);
  return { commit: commitOf(tar) };
}

// macOS の tar も Windows 10 以降に入っている tar も bsdtar で、
// 既定で絶対パスや .. を含むもの・シンボリックリンク越しの書き込みを展開しない
const TAR =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "/usr/bin/tar";

function untar(tar, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn(TAR, ["-xf", "-", "-C", dest, "--strip-components", "1"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`展開できませんでした: ${stderr.trim()}`))));
    p.stdin.end(tar);
  });
}

// 公式プラグインの一覧。リポジトリの main にある src/official-plugins.json を読み、読めなければ
// アプリに同梱した版を使う（一覧に足すだけなら、mxdeck を出し直さなくても出るように）
const OFFICIAL_URL =
  process.env.MXDECK_OFFICIAL_PLUGINS ||
  "https://raw.githubusercontent.com/knagato/mxdeck/main/src/official-plugins.json";

// 形の合わない項目は黙って落とす（一覧の書き損じで、シートごと出なくならないように）
function parseOfficial(data) {
  const list = Array.isArray(data?.plugins) ? data.plugins : [];
  return list.flatMap((p) => {
    let spec;
    try {
      spec = parseSpec(p?.repo);
    } catch {
      return [];
    }
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) return [];
    return [
      {
        repo: `${spec.owner}/${spec.repo}${spec.ref ? `#${spec.ref}` : ""}`,
        id: typeof p.id === "string" ? p.id : undefined,
        name,
        description: typeof p.description === "string" ? p.description : "",
      },
    ];
  });
}

async function officialPlugins({ bundled, fetch = globalThis.fetch, url = OFFICIAL_URL }) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const plugins = parseOfficial(await res.json());
    if (plugins.length) return { plugins, remote: true };
  } catch {
    // オフライン等。同梱の一覧で続ける
  }
  return { plugins: parseOfficial(bundled), remote: false };
}

// owner/repo が同じか（ref と大文字小文字は見ない）
function sameRepo(a, b) {
  try {
    const x = parseSpec(a);
    const y = parseSpec(b);
    return `${x.owner}/${x.repo}`.toLowerCase() === `${y.owner}/${y.repo}`.toLowerCase();
  } catch {
    return false;
  }
}

module.exports = { parseSpec, specString, download, commitOf, parseOfficial, officialPlugins, sameRepo };

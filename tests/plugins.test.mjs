// プラグイン機構の結合テスト。実際に mxdeck（Electron）を起動し、tests/fixture-plugin を読み込ませる。
//
//   node tests/plugins.test.mjs
//
// 普段使いの保存先・accounts.json には触れない（一時ディレクトリで起動する）。
// ポートは OS に空きを選ばせる（固定ポートを使わない）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mxdeck-plugins-"));
const out = path.join(tmp, "out.jsonl");

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(s));
  });
}
const originOf = (s) => `http://127.0.0.1:${s.address().port}`;

// B: ウィジェット（アカウントのページに iframe で入る別オリジン）
const widget = await serve((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<!doctype html><title>widget</title><p>widget</p>");
});
// C: サインインするサイト（HttpOnly の Cookie と localStorage を置く）
const site = await serve((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.setHeader("set-cookie", "sid=secret-cookie; HttpOnly; Path=/");
  res.end("<!doctype html><title>site</title><script>localStorage.setItem('tok','secret-token')</script>");
});
// A: アカウント（Matrix クライアントの代わり）
const account = await serve((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>account</title><iframe src="${originOf(widget)}/"></iframe>`);
});

fs.writeFileSync(
  path.join(tmp, "accounts.json"),
  JSON.stringify({ accounts: [{ id: "a", name: "A", url: `${originOf(account)}/` }] }),
);
fs.writeFileSync(
  path.join(tmp, "plugins.json"),
  JSON.stringify({
    plugins: [
      {
        path: path.join(root, "tests/fixture-plugin"),
        config: { out, widgetOrigin: originOf(widget), siteUrl: `${originOf(site)}/` },
      },
      { path: path.join(tmp, "missing-plugin") },
    ],
  }),
);

// .bin/electron は起動用のラッパーで、kill しても Electron 本体が残る。本体を直接起動する
const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, [root, "--remote-debugging-port=0"], {
  env: {
    ...process.env,
    MXDECK_USER_DATA: path.join(tmp, "ud"),
    MXDECK_ACCOUNTS: path.join(tmp, "accounts.json"),
    MXDECK_PLUGINS: path.join(tmp, "plugins.json"),
  },
  stdio: process.env.MXDECK_TEST_LOG ? "inherit" : "ignore",
});

const read = () =>
  fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const want = ["frame-hello", "frame-acked", "panel-ping", "panel-push", "site"];

async function pageTitles() {
  const portFile = path.join(tmp, "ud", "DevToolsActivePort");
  if (!fs.existsSync(portFile)) return [];
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const res = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
  return res ? (await res.json()).map((t) => t.title) : [];
}

try {
  const deadline = Date.now() + 30_000;
  let titles = [];
  while (Date.now() < deadline) {
    titles = await pageTitles();
    const kinds = new Set(read().map((r) => r.kind));
    if (want.every((k) => kinds.has(k)) && titles.some((t) => t.startsWith("rejected:"))) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const rows = read();
  const byKind = (k) => rows.filter((r) => r.kind === k);
  const W = originOf(widget);
  const A = originOf(account);

  // フレーム: ウィジェットのオリジンからだけ届き、どのアカウントからかが分かる
  assert.ok(byKind("frame-hello").length >= 1, "frame hello が届いていない");
  for (const r of [...byKind("frame-hello"), ...byKind("frame-acked")]) {
    assert.equal(r.meta.origin, W);
    assert.equal(r.payload.origin, W);
    assert.equal(r.meta.account.id, "a");
  }
  assert.equal(byKind("frame-hello")[0].payload.top, false);
  assert.deepEqual(byKind("frame-acked")[0].payload.payload, { n: 1 });
  // アカウントのページ自身（宣言していないオリジン）からの invoke は拒否される
  assert.ok(titles.includes(`rejected:${A}:forbidden`), `拒否されていない: ${JSON.stringify(titles)}`);

  // パネル: invoke と、main からの send
  assert.equal(byKind("panel-ping")[0].x, 42);
  assert.equal(byKind("panel-ping")[0].active.id, "a");
  assert.equal(byKind("panel-push")[0].v, "hi");

  // サイト: HttpOnly の Cookie と localStorage が読め、アカウントの保存領域には入らない
  const s = byKind("site")[0];
  assert.equal(s.cookie, "secret-cookie");
  assert.equal(s.httpOnly, true);
  assert.equal(s.stored, "secret-token");
  assert.equal(s.leaked, 0);

  console.log("ok: frames / panel / sites / origin check");
} finally {
  child.kill("SIGKILL");
  for (const s of [widget, site, account]) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// GitHub から追加するときの、指定の読み取りとアーカイブの展開。
// GitHub には繋がない（git archive で作ったアーカイブを手元のサーバから返す）。
//
//   node --test tests/github.test.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseSpec, specString, download, parseOfficial, officialPlugins, sameRepo } = require("../src/github.js");
const bundled = require("../src/official-plugins.json");

test("parseSpec", () => {
  const cases = {
    "knagato/mxdeck-plugin-login-helper": { owner: "knagato", repo: "mxdeck-plugin-login-helper", ref: undefined },
    " knagato/x#v1.0 ": { owner: "knagato", repo: "x", ref: "v1.0" },
    "github:knagato/x#feature/y": { owner: "knagato", repo: "x", ref: "feature/y" },
    "https://github.com/knagato/x": { owner: "knagato", repo: "x", ref: undefined },
    "https://github.com/knagato/x.git": { owner: "knagato", repo: "x", ref: undefined },
    "github.com/knagato/x/": { owner: "knagato", repo: "x", ref: undefined },
    "https://github.com/knagato/x/tree/feature/y": { owner: "knagato", repo: "x", ref: "feature/y" },
    "https://github.com/knagato/x/releases/tag/v0.2.0": { owner: "knagato", repo: "x", ref: "v0.2.0" },
    "https://github.com/knagato/x/commit/d9a455e": { owner: "knagato", repo: "x", ref: "d9a455e" },
  };
  for (const [input, want] of Object.entries(cases)) assert.deepEqual(parseSpec(input), want, input);
  for (const bad of ["", "knagato", "knagato/", "../x", "knagato/..", "a/b#", "https://github.com/a/b/issues/1", "https://example.com/a/b"]) {
    assert.throws(() => parseSpec(bad), undefined, bad);
  }
  assert.equal(specString(parseSpec("https://github.com/a/b/tree/main")), "github:a/b#main");
});

test("download", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mxdeck-github-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // GitHub のアーカイブと同じく <repo>-<ref>/ の下に入った、コミット SHA つきの tar.gz
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), '{"mxdeck":{"id":"x","api":1}}');
  fs.writeFileSync(path.join(repo, "lib", "main.js"), "exports.activate = () => {};");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  const sha = git("rev-parse", "HEAD");
  const archive = path.join(tmp, "x.tar.gz");
  git("archive", "--format=tar.gz", "--prefix=x-main/", "-o", archive, "HEAD");

  const requested = [];
  const server = await new Promise((resolve) => {
    const s = http
      .createServer((req, res) => {
        requested.push(req.url);
        if (req.url.startsWith("/a/x/archive/")) return res.end(fs.readFileSync(archive));
        if (req.url.startsWith("/a/text/archive/")) return res.end("not a tarball");
        res.statusCode = 404;
        res.end();
      })
      .listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const dest = fs.mkdtempSync(path.join(tmp, "dest-"));
  const { commit } = await download(parseSpec("a/x#feature/y"), dest, { base });
  assert.equal(commit, sha);
  assert.deepEqual(fs.readdirSync(dest).sort(), ["lib", "package.json"]);
  assert.equal(requested.at(-1), "/a/x/archive/feature/y.tar.gz");

  await download(parseSpec("a/x"), fs.mkdtempSync(path.join(tmp, "dest-")), { base });
  assert.equal(requested.at(-1), "/a/x/archive/HEAD.tar.gz");

  await assert.rejects(download(parseSpec("a/missing"), dest, { base }), /見つかりません/);
  await assert.rejects(download(parseSpec("a/text"), dest, { base }), /tar\.gz ではありません/);
});

test("parseOfficial", () => {
  const list = parseOfficial({
    plugins: [
      { repo: "https://github.com/a/b", id: "b", name: " B ", description: "d" },
      { repo: "a/c#v1", name: "C" },
      { repo: "../x", name: "bad repo" },
      { repo: "a/d" },
      null,
    ],
  });
  assert.deepEqual(list, [
    { repo: "a/b", id: "b", name: "B", description: "d" },
    { repo: "a/c#v1", id: undefined, name: "C", description: "" },
  ]);
  assert.deepEqual(parseOfficial(null), []);
  // 同梱の一覧は、全部が読める
  assert.equal(parseOfficial(bundled).length, bundled.plugins.length);
});

test("officialPlugins", async () => {
  const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
  const remote = { plugins: [{ repo: "a/remote", name: "R" }] };
  const local = { plugins: [{ repo: "a/local", name: "L" }] };
  const names = (r) => [r.remote, r.plugins.map((p) => p.name)];
  assert.deepEqual(names(await officialPlugins({ bundled: local, fetch: json(remote) })), [true, ["R"]]);
  // 取れない・壊れている・空なら同梱の一覧
  assert.deepEqual(names(await officialPlugins({ bundled: local, fetch: json(remote, 404) })), [false, ["L"]]);
  assert.deepEqual(names(await officialPlugins({ bundled: local, fetch: json({ plugins: [] }) })), [false, ["L"]]);
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(names(await officialPlugins({ bundled: local, fetch: offline })), [false, ["L"]]);
});

test("sameRepo", () => {
  assert.ok(sameRepo("github:Knagato/X#main", "knagato/x"));
  assert.ok(!sameRepo("github:knagato/x", "knagato/y"));
  assert.ok(!sameRepo(undefined, "knagato/x"));
});

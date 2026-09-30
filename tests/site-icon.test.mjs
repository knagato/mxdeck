// サイトからのアイコン取得。候補の拾い方と試す順を、手元のサーバで確かめる。
//
//   node --test tests/site-icon.test.mjs
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { parseHtml, parseManifest, rank, findIcon, fromIco } = createRequire(import.meta.url)("../src/site-icon.js");

test("parseHtml", () => {
  const html = `
    <link rel="apple-touch-icon" sizes="180x180" href="vector-icons/180.png">
    <link rel="manifest" href="manifest.json">
    <link rel="icon" type="image/png" sizes="24x24" href='vector-icons/24.png'>
    <link href="/favicon.svg" rel="icon" type="image/svg+xml">
    <LINK REL="shortcut icon" href=/assets/favicon.ico>
    <link rel="icon" sizes="16x16 48x48" href="multi.ico">
    <link rel="icon" href="javascript:alert(1)">
    <link rel="stylesheet" href="bundle.css">`;
  assert.deepEqual(parseHtml(html, "https://chat.example.com/app/"), {
    icons: [
      { url: "https://chat.example.com/app/vector-icons/180.png", size: 180 },
      { url: "https://chat.example.com/app/vector-icons/24.png", size: 24 },
      { url: "https://chat.example.com/assets/favicon.ico", size: 0 },
      { url: "https://chat.example.com/app/multi.ico", size: 48 },
    ],
    manifest: "https://chat.example.com/app/manifest.json",
  });
});

test("parseManifest / rank", () => {
  const manifest = {
    icons: [
      { src: "./public/192.png", sizes: "192x192", type: "image/png" },
      { src: "/1024.png", sizes: "1024x1024" },
      { src: "maskable-512.png", sizes: "512x512", purpose: "maskable" },
      { src: "logo.svg", sizes: "any", type: "image/svg+xml" },
      { sizes: "64x64" },
    ],
  };
  const icons = parseManifest(manifest, "https://chat.example.com/app/manifest.json");
  assert.deepEqual(
    icons.map((i) => i.url),
    [
      "https://chat.example.com/app/public/192.png",
      "https://chat.example.com/1024.png",
      "https://chat.example.com/app/maskable-512.png",
    ],
  );
  const small = { url: "https://chat.example.com/app/public/192.png", size: 24 };
  assert.deepEqual(rank([small, ...icons], "https://chat.example.com/app/"), [
    "https://chat.example.com/1024.png",
    "https://chat.example.com/app/public/192.png",
    "https://chat.example.com/app/maskable-512.png",
    "https://chat.example.com/favicon.ico",
  ]);
  assert.deepEqual(parseManifest(null, "https://x/"), []);
});

test("findIcon", async (t) => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex");
  const requested = [];
  const server = await new Promise((resolve) => {
    const s = http
      .createServer((req, res) => {
        requested.push(req.url);
        const send = (type, body) => {
          res.setHeader("content-type", type);
          res.end(body);
        };
        switch (req.url) {
          case "/":
            res.statusCode = 302;
            res.setHeader("location", "/app/");
            return res.end();
          case "/app/":
            return send(
              "text/html",
              '<link rel="icon" sizes="512x512" href="big.png"><link rel="icon" sizes="32x32" href="small.png">' +
                '<link rel="manifest" href="manifest.json">',
            );
          case "/app/manifest.json":
            return send("application/json", JSON.stringify({ icons: [{ src: "/login.png", sizes: "1024x1024" }] }));
          case "/login.png": // ログイン画面に飛ばされたときのように、画像でないものが返る
            return send("text/html", "<html>login</html>");
          case "/app/big.png":
            return send("image/png", PNG);
          default:
            res.statusCode = 404;
            res.end();
        }
      })
      .listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const isPng = (buf) => buf.subarray(0, 8).equals(PNG);

  const got = await findIcon(`${base}/`, { accept: (buf, ext) => isPng(buf) && { ext, size: buf.length } });
  assert.deepEqual(got, { ext: ".png", size: 8 });
  assert.deepEqual(requested, ["/", "/app/", "/app/manifest.json", "/login.png", "/app/big.png"]);

  await assert.rejects(findIcon(`${base}/nothing`, { accept: () => null }), /開けませんでした: HTTP 404/);
  await assert.rejects(findIcon(`${base}/app/`, { accept: () => null }), /見つかりませんでした/);
});

// 渡した画像を並べた ICO を作る
function ico(entries) {
  const head = Buffer.alloc(6 + entries.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let at = head.length;
  entries.forEach(({ size, bpp, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size % 256;
    head[e + 1] = size % 256;
    head.writeUInt16LE(bpp, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(at, e + 12);
    at += data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

function bmp32(w, h, pixel) {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(w, 4);
  info.writeInt32LE(h * 2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(pixel(x, h - 1 - y), (y * w + x) * 4);
  return Buffer.concat([info, px, Buffer.alloc(Math.ceil(w / 32) * 4 * h)]);
}

test("fromIco", () => {
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("rest")]);
  // 上半分が半透明の赤、下半分が不透明の青（BGRA）
  const bmp = bmp32(16, 16, (x, y) => (y < 8 ? [0, 0, 255, 128] : [255, 0, 0, 255]));
  assert.deepEqual(fromIco(ico([{ size: 16, bpp: 32, data: bmp }, { size: 32, bpp: 32, data: png }])), { png });

  const got = fromIco(ico([{ size: 16, bpp: 32, data: bmp }]));
  assert.equal(got.width, 16);
  assert.equal(got.height, 16);
  assert.deepEqual([...got.bgra.subarray(0, 4)], [0, 0, 128, 128]); // 上の行が先・アルファ乗算済み
  assert.deepEqual([...got.bgra.subarray(-4)], [255, 0, 0, 255]);

  // アルファが全部 0 なら不透明として扱う
  const flat = fromIco(ico([{ size: 16, bpp: 32, data: bmp32(16, 16, () => [10, 20, 30, 0]) }]));
  assert.deepEqual([...flat.bgra.subarray(0, 4)], [10, 20, 30, 255]);

  assert.equal(fromIco(ico([{ size: 16, bpp: 8, data: Buffer.alloc(40) }])), null);
  assert.equal(fromIco(Buffer.from("<html>")), null);
});

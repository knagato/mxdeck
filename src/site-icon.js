// Web クライアントのサイトからアイコン画像を探して落とす。
// ページの <link rel="icon"> / <link rel="apple-touch-icon"> と manifest.json の icons から候補を集め、
// 大きいものから順に試す。electron に依存しないので node:test で確かめられる。
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

const EXT_BY_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};

function attrsOf(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  }
  return attrs;
}

// "16x16 32x32" は大きいほう。"any" や書いていないものは 0（大きさの分かるものの後に回す）
function sizeOf(sizes) {
  return Math.max(0, ...[...String(sizes ?? "").matchAll(/(\d+)x(\d+)/gi)].map((m) => Math.min(+m[1], +m[2])));
}

function resolve(href, base) {
  try {
    const url = new URL(href, base);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

// SVG は nativeImage で読めないので外す
const isSvg = (type, url) => /svg/i.test(type ?? "") || /\.svgz?$/i.test(new URL(url).pathname);

// ページの HTML から { icons: [{ url, size }], manifest: url | null }
function parseHtml(html, pageUrl) {
  const icons = [];
  let manifest = null;
  for (const [tag] of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const a = attrsOf(tag);
    const rel = String(a.rel ?? "").toLowerCase().split(/\s+/);
    const url = a.href && resolve(a.href, pageUrl);
    if (!url) continue;
    if (rel.includes("manifest")) manifest ??= url;
    else if (rel.some((r) => ["icon", "apple-touch-icon", "apple-touch-icon-precomposed"].includes(r))) {
      if (!isSvg(a.type, url)) icons.push({ url, size: sizeOf(a.sizes) });
    }
  }
  return { icons, manifest };
}

// manifest.json の icons。maskable（周りを切り落とす前提の余白つき）だけのものは後ろに回す
function parseManifest(json, manifestUrl) {
  const icons = [];
  for (const i of Array.isArray(json?.icons) ? json.icons : []) {
    const url = typeof i?.src === "string" && resolve(i.src, manifestUrl);
    if (!url || isSvg(i.type, url)) continue;
    const purpose = String(i.purpose ?? "any").split(/\s+/);
    icons.push({ url, size: sizeOf(i.sizes), maskable: !purpose.includes("any") });
  }
  return icons;
}

// 試す順: 余白つきでないもの → 大きいもの。同じ URL は1回だけ。最後に /favicon.ico
function rank(icons, pageUrl) {
  const sorted = [...icons].sort((a, b) => !!a.maskable - !!b.maskable || b.size - a.size);
  return [...new Set([...sorted.map((i) => i.url), new URL("/favicon.ico", pageUrl).toString()])];
}

async function get(fetch, url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new Error("大きすぎます");
  return res;
}

// 候補を順に落とし、accept(buffer, ext) が値を返したらそれを返す（画像として読めるかは呼び出し側が確かめる）
async function findIcon(pageUrl, { fetch = globalThis.fetch, accept }) {
  let page;
  try {
    page = await get(fetch, pageUrl);
  } catch (err) {
    throw new Error(`サイトを開けませんでした: ${err.cause?.message ?? err.message ?? err}`);
  }
  const base = page.url || pageUrl; // リダイレクト後の URL を基準にする
  const { icons, manifest } = parseHtml(await page.text(), base);
  if (manifest) {
    try {
      icons.push(...parseManifest(await (await get(fetch, manifest)).json(), manifest));
    } catch {
      // manifest が読めなくても <link> の分で続ける
    }
  }
  for (const url of rank(icons, base)) {
    try {
      const res = await get(fetch, url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) continue;
      const type = String(res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const ext = EXT_BY_TYPE[type] ?? (/\.(png|jpe?g|gif|webp|ico)$/i.exec(new URL(url).pathname)?.[0] || ".png");
      const result = await accept(buf, ext.toLowerCase());
      if (result) return result;
    } catch {
      // 次の候補へ
    }
  }
  throw new Error("サイトにアイコン画像が見つかりませんでした");
}

// macOS の nativeImage は ICO を読めないので、中の一番大きい画像を取り出す。
// PNG が入っていればそのまま { png }、32bit の BMP なら { bgra, width, height }（上から下、アルファ乗算済み）。
// それ以外（パレットの BMP など）は null
function fromIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  let best;
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const e = 6 + i * 16;
    if (e + 16 > buf.length) break;
    const entry = { size: buf[e] || 256, bpp: buf.readUInt16LE(e + 6), len: buf.readUInt32LE(e + 8), at: buf.readUInt32LE(e + 12) };
    if (entry.at + entry.len > buf.length) continue;
    if (!best || entry.size > best.size || (entry.size === best.size && entry.bpp > best.bpp)) best = entry;
  }
  if (!best) return null;
  const data = buf.subarray(best.at, best.at + best.len);
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { png: data };
  if (data.length < 40 || data.readUInt32LE(0) < 40 || data.readUInt16LE(14) !== 32) return null;
  const width = data.readInt32LE(4);
  const height = Math.abs(data.readInt32LE(8)) / 2; // XOR（色）と AND（マスク）の2枚分の高さが書いてある
  const pixels = data.subarray(data.readUInt32LE(0));
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) return null;
  // 古いアイコンはアルファが全部 0 で、透過を AND マスクだけで表している。そのときは不透明として扱う
  let hasAlpha = false;
  for (let i = 3; i < width * height * 4; i += 4) if (pixels[i]) hasAlpha = true;
  const bgra = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4; // BMP は下の行から並んでいる
    for (let x = 0; x < width * 4; x += 4) {
      const a = hasAlpha ? pixels[src + x + 3] : 255;
      for (let c = 0; c < 3; c++) bgra[y * width * 4 + x + c] = Math.round((pixels[src + x + c] * a) / 255);
      bgra[y * width * 4 + x + 3] = a;
    }
  }
  return { bgra, width, height };
}

module.exports = { parseHtml, parseManifest, rank, findIcon, fromIco };

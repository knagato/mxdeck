// tests/plugins.test.mjs 用。ctx の各 API を一通り叩き、結果を config.out に 1 行ずつ書く。
const fs = require("node:fs");
const path = require("node:path");

exports.activate = (ctx) => {
  const record = (kind, data) => fs.appendFileSync(ctx.config.out, JSON.stringify({ kind, ...data }) + "\n");

  ctx.frames.inject({ origins: [ctx.config.widgetOrigin], preload: path.join(__dirname, "frame-preload.js") });
  ctx.frames.handle("hello", (payload, meta) => {
    record("frame-hello", { payload, meta });
    setTimeout(() => ctx.frames.send("ack", { n: 1 }), 100);
    return "pong";
  });
  ctx.frames.handle("acked", (payload, meta) => record("frame-acked", { payload, meta }));

  let panel;
  ctx.panel.handle("ping", (x) => {
    record("panel-ping", { x, active: ctx.accounts.active() });
    setTimeout(() => panel.send("pushed", "hi"), 100);
    return "pong";
  });
  ctx.panel.handle("got-push", (v) => {
    record("panel-push", { v });
    // Esc でパネルが閉じる（プラグインが何もしなくても）
    panel.window.once("closed", () => record("panel-closed", {}));
    // 出ているシートを閉じる経路を試したいので、出るのを待つ（遅くとも 1 秒で出る）
    const waitShown = setInterval(() => {
      if (!panel.window.isVisible()) return;
      clearInterval(waitShown);
      record("panel-shown", {});
      panel.window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    }, 100);
  });

  ctx.menu.add({ label: "Fixture", click: () => {} });

  setTimeout(async () => {
    panel = ctx.panel.open({ file: path.join(__dirname, "panel.html") });
    const site = ctx.sites.open("site", ctx.config.siteUrl, { show: false });
    await site.loaded();
    const [cookie] = await site.session.cookies.get({ url: ctx.config.siteUrl, name: "sid" });
    const stored = await site.webContents.executeJavaScriptInIsolatedWorld(999, [
      { code: "localStorage.getItem('tok')" },
    ]);
    const accountPartitionCookies = await require("electron")
      .session.fromPartition("persist:acct-a")
      .cookies.get({ name: "sid" });
    record("site", { cookie: cookie?.value, httpOnly: cookie?.httpOnly, stored, leaked: accountPartitionCookies.length });
  }, 1500);
};

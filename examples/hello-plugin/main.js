// mxdeck プラグインの最小例。メニューからパネルを開き、表示中のアカウントと、
// サイト用ウィンドウ（プラグイン専用の保存領域）の Cookie の数を見せる。
const path = require("node:path");

exports.activate = (ctx) => {
  const site = ctx.config.site ?? "https://example.com/";

  ctx.panel.handle("state", async () => {
    const cookies = await ctx.sites.session("web").cookies.get({ url: site });
    return { account: ctx.accounts.active(), site, cookies: cookies.length };
  });
  ctx.panel.handle("open-site", () => {
    ctx.sites.open("web", site);
  });

  ctx.menu.add({
    label: "Hello…",
    click: () => ctx.panel.open({ file: path.join(__dirname, "panel.html"), width: 360, height: 220 }),
  });
};

const show = async () => {
  const s = await window.mxdeck.invoke("state");
  document.getElementById("state").textContent =
    `表示中: ${s.account?.name ?? "なし"} / ${s.site} の Cookie: ${s.cookies} 個`;
};
document.getElementById("open").onclick = () => window.mxdeck.invoke("open-site");
document.getElementById("close").onclick = () => window.mxdeck.close();
window.addEventListener("focus", show);
show();

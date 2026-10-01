const $ = (id) => document.getElementById(id);

function showError(message) {
  $("error").textContent = message ?? "";
  $("error").hidden = !message;
}

$("cancel").addEventListener("click", () => window.installer.cancel());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.installer.cancel();
});

// 公式の一覧から選んでも、リポジトリを入れても、同じ取り込み（確認 → ダウンロード → 再起動）を通る。
// 成功するとシートは main が閉じる。確認でキャンセルしたときは、選び直せるようにそのまま残す
async function install(input, button) {
  showError();
  const controls = [...document.querySelectorAll("button, input")];
  const enabled = controls.map((c) => !c.disabled);
  const label = button.textContent;
  for (const c of controls) c.disabled = true;
  button.textContent = "ダウンロード中…";
  const result = await window.installer.run(input);
  controls.forEach((c, i) => (c.disabled = !enabled[i]));
  button.textContent = label;
  if (result?.error) showError(result.error);
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!$("repo").value.trim()) {
    $("repo").focus();
    return;
  }
  install($("repo").value, $("run")).then(() => $("repo").focus());
});

(async () => {
  const { plugins = [], remote, error } = await window.installer.list();
  const list = $("official");
  list.replaceChildren();
  if (error || plugins.length === 0) {
    list.append(Object.assign(document.createElement("li"), { className: "note", textContent: "（なし）" }));
    return;
  }
  $("offline").hidden = remote !== false;
  for (const p of plugins) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "info";
    info.append(
      Object.assign(document.createElement("div"), { className: "name", textContent: p.name }),
      Object.assign(document.createElement("div"), { className: "description", textContent: p.description }),
      Object.assign(document.createElement("small"), { textContent: p.repo }),
    );
    const button = document.createElement("button");
    button.type = "button";
    // フォルダから入れたもの（開発中の clone 等）は、ここからは触らない
    button.textContent = p.installed === "github" ? "更新" : p.installed ? "追加済み" : "追加";
    button.disabled = p.installed === "folder";
    if (p.installed === "folder") button.title = "フォルダから追加したものがあります";
    button.addEventListener("click", () => install(p.repo, button));
    li.append(info, button);
    list.append(li);
  }
})();

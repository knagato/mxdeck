const $ = (id) => document.getElementById(id);

function showError(message) {
  $("error").textContent = message ?? "";
  $("error").hidden = !message;
}

$("repo").focus();
$("cancel").addEventListener("click", () => window.installer.cancel());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.installer.cancel();
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError();
  $("run").disabled = $("repo").disabled = true;
  $("run").textContent = "ダウンロード中…";
  // 成功するとシートは main が閉じる。確認でキャンセルしたときは、入れ直せるようにそのまま残す
  const result = await window.installer.run($("repo").value);
  $("run").disabled = $("repo").disabled = false;
  $("run").textContent = "ダウンロード";
  if (result?.error) showError(result.error);
  $("repo").focus();
});

const $ = (id) => document.getElementById(id);
const state = { icon: null, iconPreview: null, iconChanged: false };

function renderPreview() {
  const preview = $("preview");
  preview.replaceChildren();
  preview.style.background = state.iconPreview ? "transparent" : $("color").value;
  if (state.iconPreview) {
    const img = document.createElement("img");
    img.src = state.iconPreview;
    preview.append(img);
  } else {
    preview.textContent = [...$("name").value.trim()][0] ?? "?";
  }
  $("clear").disabled = !state.iconPreview;
}

function showError(message) {
  $("error").textContent = message ?? "";
  $("error").hidden = !message;
}

(async () => {
  const { isNew, account } = await window.editor.init();
  $("heading").textContent = isNew ? "アカウントを追加" : "アカウントを編集";
  $("save").textContent = isNew ? "追加" : "保存";
  $("name").value = account.name;
  $("url").value = account.url;
  $("color").value = account.color ?? "#0dbd8b";
  state.iconPreview = account.iconPreview ?? null;
  if (!isNew) {
    // 保存領域は id で決まっていて変えられない。どこにデータがあるかだけ見せる
    $("partition").textContent = `保存領域: ${account.partition}`;
    $("partition").hidden = false;
  }
  renderPreview();
  $("name").focus();
})();

$("name").addEventListener("input", renderPreview);
$("color").addEventListener("input", renderPreview);

$("choose").addEventListener("click", async () => {
  const picked = await window.editor.chooseIcon();
  if (!picked) return;
  if (picked.error) return showError(picked.error);
  Object.assign(state, { icon: picked.path, iconPreview: picked.preview, iconChanged: true });
  showError();
  renderPreview();
});

$("clear").addEventListener("click", () => {
  Object.assign(state, { icon: null, iconPreview: null, iconChanged: true });
  renderPreview();
});

$("cancel").addEventListener("click", () => window.editor.cancel());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.editor.cancel();
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("save").disabled = true;
  const result = await window.editor.save({
    name: $("name").value,
    url: $("url").value,
    color: $("color").value,
    icon: state.icon,
    iconChanged: state.iconChanged,
  });
  $("save").disabled = false;
  if (result?.error) showError(result.error);
});

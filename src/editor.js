const $ = (id) => document.getElementById(id);
// userIcon: 画像を自分で選んだ／外した（URL を入れたときの自動取得で上書きしない）
const state = { isNew: true, icon: null, iconPreview: null, iconChanged: false, userIcon: false };
let fetching = 0; // 最後に出したアイコン取得の番号。URL を打ち直したら古い結果は捨てる

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
  state.isNew = isNew;
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
  Object.assign(state, { icon: picked.path, iconPreview: picked.preview, iconChanged: true, userIcon: true });
  showError();
  renderPreview();
});

$("clear").addEventListener("click", () => {
  Object.assign(state, { icon: null, iconPreview: null, iconChanged: true, userIcon: true });
  renderPreview();
});

// auto: 新規追加で URL を入れたときの自動取得。失敗しても何も言わず、選んだ画像も上書きしない
async function fetchIcon({ auto = false } = {}) {
  const url = $("url").value.trim();
  if (!url) return auto || showError("先に URL を入れてください");
  const req = ++fetching;
  if (!auto) {
    $("fetch").disabled = true;
    $("fetch").textContent = "取得中…";
  }
  const got = await window.editor.fetchIcon(url);
  if (!auto) {
    $("fetch").disabled = false;
    $("fetch").textContent = "サイトから取得";
  }
  if (req !== fetching || (auto && state.userIcon)) return;
  if (got?.error) return auto || showError(got.error);
  Object.assign(state, { icon: got.path, iconPreview: got.preview, iconChanged: true, userIcon: false });
  showError();
  renderPreview();
}

$("fetch").addEventListener("click", () => fetchIcon());
$("url").addEventListener("change", () => state.isNew && !state.userIcon && fetchIcon({ auto: true }));

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

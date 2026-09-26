const nav = document.getElementById("accounts");
const buttons = new Map();
let lastBadges = {};
let activeId;

function shortcutLabel(i) {
  return i < 9 ? `（⌘${i + 1}）` : "";
}

window.shell.on("accounts", (accounts) => {
  nav.replaceChildren();
  buttons.clear();
  accounts.forEach((a, i) => {
    const b = document.createElement("button");
    b.dataset.id = a.id;
    b.title = `${a.name}${shortcutLabel(i)}`;
    b.draggable = true;
    if (a.icon) {
      const img = document.createElement("img");
      img.src = a.icon;
      img.alt = a.name;
      img.draggable = false;
      b.append(img);
    } else {
      const letter = document.createElement("span");
      letter.className = "letter";
      letter.textContent = [...a.name][0] ?? "?";
      letter.style.background = a.color ?? "#0dbd8b";
      b.append(letter);
    }
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.hidden = true;
    b.append(badge);
    b.addEventListener("click", () => window.shell.activate(a.id));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.shell.accountMenu(a.id);
    });
    nav.append(b);
    buttons.set(a.id, { button: b, badge });
  });
  renderActive();
  renderBadges();
});

function renderActive() {
  for (const [bid, { button }] of buttons) button.classList.toggle("active", bid === activeId);
}

window.shell.on("active", (id) => {
  activeId = id;
  renderActive();
});

function renderBadges() {
  for (const [id, { badge }] of buttons) {
    // 件数が分かれば数字、件数不明のメンションは "!"、未読だけなら点
    const s = lastBadges[id] ?? { count: 0, mention: false, unread: false };
    badge.hidden = !(s.count > 0 || s.mention || s.unread);
    badge.classList.toggle("dot", s.count === 0 && !s.mention && s.unread);
    badge.textContent = s.count > 0 ? (s.count > 99 ? "99+" : String(s.count)) : s.mention ? "!" : "";
  }
}

window.shell.on("badges", (badges) => {
  lastBadges = badges;
  renderBadges();
});

// 表示中のページの左端と同じ色に塗る（届かないうちは OS の外観に合わせた既定色）
window.shell.on("edge", (rgb) => {
  const root = document.documentElement;
  const dark = rgb ? 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 128 : undefined;
  if (rgb) root.style.setProperty("--bg", `rgb(${rgb.join(", ")})`);
  else root.style.removeProperty("--bg");
  root.classList.toggle("dark", dark === true);
  root.classList.toggle("light", dark === false);
});

document.getElementById("add").addEventListener("click", () => window.shell.addAccount());

// ドラッグで並べ替え。ドラッグ中は DOM 上で入れ替えて見せ、離したときに順番を送る
let dragging;
nav.addEventListener("dragstart", (e) => {
  dragging = e.target.closest("button");
  if (!dragging) return;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragging.dataset.id);
  requestAnimationFrame(() => dragging?.classList.add("dragging"));
});
nav.addEventListener("dragover", (e) => {
  if (!dragging) return;
  e.preventDefault();
  const over = e.target.closest("button");
  if (!over || over === dragging) return;
  const { top, height } = over.getBoundingClientRect();
  nav.insertBefore(dragging, e.clientY < top + height / 2 ? over : over.nextSibling);
});
nav.addEventListener("drop", (e) => e.preventDefault());
nav.addEventListener("dragend", () => {
  if (!dragging) return;
  dragging.classList.remove("dragging");
  dragging = undefined;
  window.shell.reorder([...nav.children].map((b) => b.dataset.id));
});

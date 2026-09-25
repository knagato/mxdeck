const nav = document.getElementById("accounts");
const buttons = new Map();

window.shell.on("accounts", (accounts) => {
  nav.replaceChildren();
  buttons.clear();
  accounts.forEach((a, i) => {
    const b = document.createElement("button");
    b.title = i < 9 ? `${a.name}（⌘${i + 1}）` : a.name;
    if (a.icon) {
      const img = document.createElement("img");
      img.src = a.icon;
      img.alt = a.name;
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
    nav.append(b);
    buttons.set(a.id, { button: b, badge });
  });
});

window.shell.on("active", (id) => {
  for (const [bid, { button }] of buttons) button.classList.toggle("active", bid === id);
});

window.shell.on("badges", (badges) => {
  for (const [id, { badge }] of buttons) {
    const s = badges[id] ?? { count: 0, unread: false };
    badge.hidden = !(s.count > 0 || s.unread);
    badge.classList.toggle("dot", s.count === 0 && s.unread);
    badge.textContent = s.count > 0 ? (s.count > 99 ? "99+" : String(s.count)) : "";
  }
});

// The bar across the top of every page a signed-in person uses: the screens they have, the admin pages
// for a superuser, and their account. The same on a screen, on the admin pages and on the account page,
// so getting around the hub is learned once.
//
//   On a wide screen   [logo skillfully.live] [Canvas] [Controls] [One fader] ...  [extras] [⚙] [EG]
//   On a phone         [logo] [Canvas ▾] ...                                         [extras] [⚙] [EG]
//
// The logo goes home. The screens are tabs, or on a phone the screen you are on, which lists the others.
// The gear is the admin pages. The initials are your account, and only that. A page puts what is its own
// (a screen's Ask and full screen) in #barExtras.
//
// Each page that has the bar loads this file. It asks the hub who is signed in once, and gives the answer
// to the page as SkillfullyBar.me, so the page need not ask again.
(() => {
  const bar = document.getElementById("bar");
  const me = fetch("/auth/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  globalThis.SkillfullyBar = { me };
  if (!bar) return;

  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
  };
  const here = bar.dataset.here || "";
  /** "Evan Goedde" is EG; "Evan" is E. */
  const initials = (name) =>
    String(name).trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";

  me.then((m) => {
    if (!m || !m.person) return;

    const places = m.screens.filter((s) => !s.beside);
    const current = places.find((s) => s.id === here);

    // The screens, as tabs.
    const tabs = document.getElementById("barTabs");
    for (const s of places) {
      const a = el("a", { href: "/s/" + s.id, textContent: s.name });
      if (s.id === here) a.setAttribute("aria-current", "page");
      tabs.append(a);
    }

    // On a phone: where you are, which opens the list of where else you can go.
    const label = current
      ? current.name
      : here === "admin"
      ? "Admin"
      : here === "account"
      ? "Account"
      : "Screens";
    document.getElementById("barHere").firstChild.textContent = label;
    const list = document.getElementById("barList");
    for (const s of places) {
      const a = el("a", { href: "/s/" + s.id, textContent: s.name });
      if (s.id === here) a.setAttribute("aria-current", "page");
      list.append(a);
    }
    if (!places.length) document.getElementById("barSwitch").hidden = true;

    // The admin pages.
    const admin = document.getElementById("barAdmin");
    admin.hidden = !m.person.superuser;
    if (here === "admin") admin.setAttribute("aria-current", "page");

    // The account.
    const who = document.getElementById("barWho");
    who.textContent = initials(m.person.name);
    who.setAttribute("aria-label", "Account: " + m.person.name);
    who.title = m.person.name;
    if (here === "account") who.classList.add("here");
    const menu = document.getElementById("barMenu");
    const out = el("button", { type: "button", textContent: "Sign out" });
    out.onclick = async () => {
      await fetch("/auth/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
      location.replace("/signin");
    };
    const account = el("a", { href: "/account", textContent: "Account" });
    if (here === "account") account.setAttribute("aria-current", "page");
    menu.append(el("p", { textContent: m.person.name }), account);
    if (m.person.superuser) {
      const a = el("a", { href: "/admin", textContent: "Admin" });
      if (here === "admin") a.setAttribute("aria-current", "page");
      menu.append(a);
    }
    menu.append(out);
  });

  // A list that is open closes when you choose elsewhere, or press Esc.
  const lists = () => bar.querySelectorAll("details[open]");
  addEventListener("click", (e) => {
    for (const d of lists()) if (!d.contains(e.target)) d.open = false;
  });
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const d of lists()) {
      d.open = false;
      d.querySelector("summary").focus();
    }
  });
  // Opening one closes the other.
  for (const d of bar.querySelectorAll("details")) {
    d.addEventListener("toggle", () => {
      if (d.open) { for (const o of lists()) if (o !== d) o.open = false; }
    });
  }
})();

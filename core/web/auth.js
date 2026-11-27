// Setting up a new hub, signing in, using an invitation, and your own account. One page, four forms.
const mode = document.body.dataset.mode;
let me;
// "PIN" or "password", for the words that name it.
let what = "PIN";
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const field = (id, label, opts = {}) => {
  const input = el("input", { id, name: id, required: true, ...opts });
  $("fields").append(el("label", { htmlFor: id, textContent: label }), input);
  return input;
};
function secretFields(rule, first, second) {
  const pin = rule.kind === "pin";
  what = pin ? "PIN" : "password";
  const props = pin
    ? { type: "password", inputMode: "numeric", pattern: "[0-9]*", autocomplete: "off" }
    : { type: "password", autocomplete: "new-password" };
  field("secret", cap(first.replace("%", what)), props);
  if (second) field("again", cap(second.replace("%", what)), props);
  return pin
    ? "PIN must be at least " + rule.minLength + " digits."
    : "Password must be at least " + rule.minLength + " characters" +
      (rule.mixed ? ", with a letter and a number." : ".");
}
async function start() {
  me = await call("/auth/me");
  if (me.away) return say("msg", me.message, "bad");
  if (mode === "setup") {
    if (me.claimed) return location.replace("/");
    $("lead").textContent =
      "Create the first superuser account. Enter the setup code shown on the hub computer.";
    field("code", "Setup code", { autocapitalize: "characters", spellcheck: false });
    field("name", "Name", { autocomplete: "name" });
    $("lead").textContent += " " + secretFields(me.superuserRule, "%", "Confirm %");
  } else if (mode === "signin") {
    if (!me.claimed) return location.replace("/setup");
    if (me.person) return location.replace("/");
    field("name", "Name", { autocomplete: "username", autocapitalize: "words" });
    secretFields(me.rule, "%");
    $("go").textContent = "Sign in";
    $("extra").hidden = false;
    $("extra").append(
      el(
        "p",
        { className: "dim" },
        "Have an invite code? ",
        el("a", { href: "/join", textContent: "Join" }),
      ),
    );
  } else if (mode === "join") {
    $("lead").textContent = "Enter your invite code. ";
    field("code", "Invite code", {
      autocapitalize: "characters",
      spellcheck: false,
      value: decodeURIComponent(location.hash.slice(1)),
    });
    $("lead").textContent += secretFields(me.rule, "%", "Confirm %");
  } else {
    if (!me.person) return location.replace("/signin");
    const rule = me.person.superuser ? me.superuserRule : me.rule;
    $("lead").textContent = me.person.mustChange
      ? "You signed in with a temporary " + (rule.kind === "pin" ? "PIN" : "password") +
        ". Set a new one to continue. "
      : "Signed in as " + me.person.name + ". ";
    field("current", rule.kind === "pin" ? "Current PIN" : "Current password", {
      type: "password",
      inputMode: rule.kind === "pin" ? "numeric" : "text",
    });
    $("lead").textContent += secretFields(rule, "New %", "Confirm new %");
    $("go").textContent = "Change " + what;
    $("nav").append(el("a", { href: "/", textContent: "Home" }));
    if (me.person.superuser) $("nav").append(el("a", { href: "/admin", textContent: "Skillfully Config" }));
    $("extra").hidden = false;
    const out = el("button", { className: "quiet", type: "button", textContent: "Sign out" });
    out.onclick = async () => {
      await call("/auth/signout", {});
      location.replace("/signin");
    };
    $("extra").append(out);
  }
}
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = (id) => $(id) ? $(id).value : undefined;
  if ($("again") && v("secret") !== v("again")) return say("msg", cap(what) + "s do not match.", "bad");
  $("go").disabled = true;
  const r = mode === "setup"
    ? await call("/auth/claim", { code: v("code"), name: v("name"), secret: v("secret") })
    : mode === "signin"
    ? await call("/auth/signin", { name: v("name"), secret: v("secret") })
    : mode === "join"
    ? await call("/auth/join", { code: v("code"), secret: v("secret") })
    : await call("/auth/secret", { current: v("current"), next: v("secret") });
  $("go").disabled = false;
  if (!r.ok) return say("msg", r.message, "bad");
  if (mode === "account") {
    say("msg", cap(what) + " changed.", "ok");
    $("form").reset();
    if (me.person.mustChange) location.replace("/");
    return;
  }
  location.replace("/");
});
start();

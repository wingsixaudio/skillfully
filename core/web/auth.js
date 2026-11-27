// Setting up a new hub, signing in, using an invitation, and your own account. One page, four forms.
const mode = document.body.dataset.mode;
let me;
const field = (id, label, opts = {}) => {
  const input = el("input", { id, name: id, required: true, ...opts });
  $("fields").append(el("label", { htmlFor: id, textContent: label }), input);
  return input;
};
function secretFields(rule, first, second) {
  const pin = rule.kind === "pin";
  const what = pin ? "PIN" : "password";
  const props = pin
    ? { type: "password", inputMode: "numeric", pattern: "[0-9]*", autocomplete: "off" }
    : { type: "password", autocomplete: "new-password" };
  field("secret", first.replace("%", what), props);
  if (second) field("again", second.replace("%", what), props);
  return pin
    ? "Your PIN needs at least " + rule.minLength + " digits."
    : "Your password needs at least " + rule.minLength + " characters" +
      (rule.mixed ? ", with a letter and a digit." : ".");
}
async function start() {
  me = await call("/auth/me");
  if (mode === "setup") {
    if (me.claimed) return location.replace("/");
    $("lead").textContent =
      "You are about to become this hub's first superuser. Enter the code the hub is showing where it runs.";
    field("code", "Code from the hub", { autocapitalize: "characters", spellcheck: false });
    field("name", "Your name", { autocomplete: "name" });
    $("lead").textContent += " " + secretFields(me.superuserRule, "Choose a %", "The same % again");
  } else if (mode === "signin") {
    if (!me.claimed) return location.replace("/setup");
    if (me.person) return location.replace("/");
    field("name", "Your name", { autocomplete: "username", autocapitalize: "words" });
    secretFields(me.rule, "Your %");
    $("go").textContent = "Sign in";
    $("extra").hidden = false;
    $("extra").append(
      el(
        "p",
        { className: "dim" },
        "New here? ",
        el("a", { href: "/join", textContent: "Use an invitation" }),
        ".",
      ),
    );
  } else if (mode === "join") {
    $("lead").textContent = "Enter the invitation you were given and choose how you will sign in. ";
    field("code", "Invitation", {
      autocapitalize: "characters",
      spellcheck: false,
      value: decodeURIComponent(location.hash.slice(1)),
    });
    $("lead").textContent += secretFields(me.rule, "Choose a %", "The same % again");
  } else {
    if (!me.person) return location.replace("/signin");
    const rule = me.person.superuser ? me.superuserRule : me.rule;
    $("lead").textContent = me.person.mustChange
      ? "You were given a temporary one. Choose your own before going on. "
      : "Signed in as " + me.person.name + ". Change how you sign in here. ";
    field("current", rule.kind === "pin" ? "Your current PIN" : "Your current password", {
      type: "password",
      inputMode: rule.kind === "pin" ? "numeric" : "text",
    });
    $("lead").textContent += secretFields(rule, "New %", "The same new % again");
    $("go").textContent = "Change it";
    $("nav").append(el("a", { href: "/", textContent: "Home" }));
    if (me.person.superuser) $("nav").append(el("a", { href: "/admin", textContent: "Skillfully Config" }));
    $("extra").hidden = false;
    const out = el("button", { className: "quiet", type: "button", textContent: "Sign out on this device" });
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
  if ($("again") && v("secret") !== v("again")) return say("msg", "Those two do not match.", "bad");
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
    say("msg", "Changed.", "ok");
    $("form").reset();
    if (me.person.mustChange) location.replace("/");
    return;
  }
  location.replace("/");
});
start();

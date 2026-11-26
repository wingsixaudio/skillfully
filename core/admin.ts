// A superuser's tools: people, roles, sign-in rules, screens' connections and devices.
// Only the hub's own admin page calls these, and only for a signed-in superuser.
//
// Changes that hand out power, or take a device out of Listen, ask for the superuser's own PIN or
// password again. What is wrong with a request is always said before that is asked for.

import type { Value } from "../contract/types.ts";
import type { Accounts, Person } from "./accounts.ts";
import type { Approvals } from "./approvals.ts";
import { aboutWords, advised, attemptWords, grantWords } from "./asks.ts";
import type { Config } from "./config.ts";
import type { Devices } from "./devices.ts";
import { json, notOurPage, outcome, readFile, readJson, refuse, sentence } from "./http.ts";
import { networkNotes, type Package, readPackage } from "./packages.ts";
import type { Origin } from "./registry.ts";
import type { Screens } from "./screens.ts";
import type { Store, StoreModule } from "./store.ts";

const UPLOAD_MAX = 64 * 1024 * 1024;
const UPLOAD_KEPT_MS = 10 * 60 * 1000;
/** How many things the store's shelf shows at once. The rest are found by typing. */
const SHELF_PAGE = 30;
const NO_PLACE = "This hub was started without a place to keep added devices.";

/** How far something from the store has been proven, in words. */
const PROVEN: Record<string, string> = {
  starts: "It starts and describes itself. Nobody has reported using it with a device.",
  "pretend-device": "It has been proven against a stand-in for the device, not the real thing.",
  "real-device": "It has been used with the real device.",
};

export interface AdminDeps {
  accounts: Accounts;
  approvals: Approvals;
  config: Config;
  devices: Devices;
  screens: Screens;
  store: Store;
  /** Whether any plugin, of any kind, already has this id. */
  taken: (id: string) => boolean;
}

export function adminApi(deps: AdminDeps) {
  const { accounts, approvals, config, devices, screens, store } = deps;
  /** The package each superuser is looking at, checked but not yet added. One each, for a few minutes. */
  const looking = new Map<string, { pkg: Package; at: number; from?: StoreModule }>();
  const kinds = (pkg: Package) => Object.keys((pkg.manifest.capabilities ?? {}) as Record<string, unknown>);
  const couldUse = (pkg: Package) => screens.fits(kinds(pkg)).map((m) => ({ id: m.id, name: m.name }));
  /** Only a list this hub knows the store signed can answer for a superuser in advance. */
  const advance = (m: StoreModule) => (store.signed ? m.network : []);
  const fromStore = (m: StoreModule) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    version: m.version,
    license: m.license,
    source: m.source.repo,
    proven: PROVEN[m.tested],
    notes: m.notes,
    makes: m.makes,
    section: m.section,
    maker: m.maker,
    products: m.products,
    kinds: m.kinds,
    // Whether a device on this hub already came from this entry.
    here: [...devices.hosts.keys()].some((id) => devices.record(id).origin?.store?.id === m.id),
    signed: store.signed,
    advance: advance(m).map((g) => grantWords(g)),
    // What its reviewers say about things it may ask for later. Advice only: the superuser decides.
    advises: m.advise.filter((a) => store.signed || a.say === "no").map((a) => ({
      say: a.say,
      about: aboutWords(a.about),
      why: a.why,
    })),
  });

  /** Is b a later version than a? Versions are three numbers; anything else is not later. */
  const later = (a: string, b: string) => {
    const [x, y] = [a, b].map((v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number));
    if (x.length < 3 || y.length < 3) return false;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] > x[i];
    return false;
  };
  /** What the store has for a device this hub added from it, when that is not what the hub is running. */
  const newerFor = (id: string) => {
    const origin = devices.record(id)?.origin;
    const listed = origin?.store ? store.listed(origin.store.id) : undefined;
    if (!listed || !origin?.store) return undefined;
    // Which package something is: its source at one commit, built one way. Not its bytes, which differ
    // from one build to the next, so a store that only built the same thing again offers nothing.
    const other = listed.source.commit !== origin.store.commit;
    const rebuilt = !other && listed.recipe > (origin.store.recipe ?? 0);
    return other || rebuilt ? { listed, origin, rebuilt } : undefined;
  };
  /** Where a device from the store came from, as the hub's record keeps it. */
  const storeOrigin = (m: StoreModule, pkg: Package): Origin => ({
    from: "store",
    package: { id: pkg.about.id, name: pkg.about.name, version: pkg.about.version },
    sha256: pkg.sha256,
    added: new Date().toISOString(),
    store: {
      id: m.id,
      repo: m.source.repo,
      commit: m.source.commit,
      license: m.license,
      tested: m.tested,
      recipe: m.recipe,
    },
  });

  /** Everything the admin page shows. */
  async function overview(me: Person, session: string) {
    return {
      // How much the files in the config folder propose. The Hub place shows what.
      config: await config.counts(),
      ok: true,
      me: me.id,
      // The seconds this session may still make changes without saying who it is again.
      unlocked: accounts.unlocked(session),
      people: accounts.people().map((p) => ({ ...p, devices: accounts.sessions(p.id).length })),
      roles: accounts.roles(),
      policy: accounts.policy(),
      canAdd: devices.canAdd,
      drivers: [...devices.hosts.values()].map((h) => {
        const record = devices.record(h.id);
        const secret = new Set((h.settingsForm ?? []).filter((f) => f.kind === "secret").map((f) => f.id));
        const other = newerFor(h.id);
        return {
          ...screens.describe(h),
          // What it asks for, as its manifest says. What it holds is under grants.
          permissions: h.manifest.permissions ?? {},
          added: !!record.origin,
          module: record.origin?.package ?? null,
          // Where it came from, when that is the store: its license, its source, how far it is proven.
          store: record.origin?.store
            ? { ...record.origin.store, proven: PROVEN[record.origin.store.tested] ?? "" }
            : null,
          // The store has another version of it than the one running here.
          update: other
            ? {
              version: other.listed.version,
              newer: later(other.origin.package?.version ?? "", other.listed.version),
              // The same source, packaged again by the store: a fix to the packaging, not to the module.
              rebuilt: other.rebuilt,
              proven: PROVEN[other.listed.tested] ?? "",
              source: other.listed.source.repo,
              // What a signed list allows in advance that this device does not hold yet.
              also: advance(other.listed).filter((g) => !h.granted.includes(g)).map((g) => grantWords(g)),
            }
            : null,
          form: h.settingsForm ?? null,
          // What is set now, so the form opens filled in. A secret is never sent back, only whether it is set.
          settings: Object.fromEntries(Object.entries(record.settings).filter(([k]) => !secret.has(k))),
          secretsSet: Object.keys(record.settings).filter((k) => secret.has(k)),
          // What it is waiting on a superuser for, what it holds, and what it tried that is never allowed.
          // Beside each request, what the store's reviewers say about it, if they say anything.
          asks: [...h.asks.values()].map((a) => {
            const advice = advised(a, ...store.advice(record.origin?.store?.id));
            return advice ? { ...a, advice: { say: advice.say, why: advice.why } } : a;
          }),
          grants: h.granted.map((g) => ({ grant: g, words: grantWords(g) })),
          attempts: [...h.attempts].map(([kind, times]) => ({ words: attemptWords(kind), times })),
          usedBy: screens.using(h.id).map((m) => m.name),
        };
      }),
      // What each screen offers a role, and which per-person slots its abilities refer to.
      offered: screens.manifests().map((m) => ({
        plugin: m.id,
        name: m.name,
        abilities: m.abilities.map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          caution: a.caution,
        })),
        suggested: m.roles ?? [],
        // Which connections this screen could use, and which it has been given.
        works: Object.keys(m.uses).filter((u) => u !== "log"),
        eligible: screens.eligible(m).map((h) => ({ id: h.id, name: h.manifest.name })),
        connections: approvals.of(m.id),
        slots: [
          ...new Set(
            m.abilities.flatMap((a) => Object.values(a.allows)).flatMap((al) =>
              typeof al === "string" ? [] : al.keys
            )
              .flatMap((k) => [...k.matchAll(/\{([a-z][a-z0-9]*)\}/g)].map((x) => x[1])),
          ),
        ],
      })),
    };
  }

  /**
   * A few rows of what a device holds right now, and the things it can be told to do: enough for a
   * superuser to see that it works. A large device has hundreds, so this is a handful, or what was typed
   * for, and how many there are in all. Never the whole of it, and nothing here is a setting or a secret:
   * it is what the device itself reports, which is what any screen given the device would show.
   */
  function tryOut(q: URLSearchParams): Response {
    const host = devices.hosts.get((q.get("id") ?? "").slice(0, 80));
    if (!host) return refuse(400, "No such device.");
    const typed = (q.get("find") ?? "").slice(0, 80).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const hit = (text: string) => typed.every((w) => text.toLowerCase().includes(w));
    const most = typed.length ? 40 : 8;
    const cut = (v: unknown, long: number) => String(v ?? "").slice(0, long);
    const readings: { key: string; label: string; value: Value }[] = [];
    const actions: { key: string; label: string; options: boolean }[] = [];
    let total = 0;
    for (const [key, value] of host.state) {
      const generic = /^generic\/(reading|action)\/([^/]+)(\/(title|options))?$/.exec(key);
      if (generic && generic[1] === "action") {
        if (generic[4] !== "title") continue;
        total++;
        const k = `generic/action/${generic[2]}`;
        const options = cut(host.state.get(`${k}/options`), 3);
        if (hit(`${value} ${k}`) && actions.length < most) {
          actions.push({ key: k, label: cut(value, 120), options: options !== "" && options !== "[]" });
        }
        continue;
      }
      if (generic && generic[4]) continue; // a reading's title: shown as its label, not as a row
      total++;
      const label = generic ? cut(host.state.get(`${key}/title`) ?? generic[2], 120) : key;
      if (hit(`${label} ${key}`) && readings.length < most) {
        readings.push({ key, label, value: typeof value === "string" ? value.slice(0, 200) : value });
      }
    }
    return json(
      {
        ok: true,
        control: host.mode === "act",
        running: host.status === "running",
        total,
        readings,
        actions,
      },
      200,
      { "cache-control": "no-store" },
    );
  }

  /** What the store lists, a page of it at a time: the whole list is never sent to the page. */
  async function shelf(q: URLSearchParams): Promise<Response> {
    if (!store.on) return json({ ok: true, on: false, modules: [] });
    const signed = store.signed;
    const asked = (name: string) => (q.get(name) ?? "").slice(0, 80);
    const find = asked("find"), section = asked("section"), maker = asked("maker"), kind = asked("kind");
    const after = Math.max(0, Math.min(Number.parseInt(asked("after")) || 0, 100000));
    try {
      const all = await store.list();
      // Every word typed has to be somewhere in what the thing is called, does, is made by, or is a kind of.
      const words = find.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      const found = words.length
        ? all.filter((m) => {
          const text = `${m.name} ${m.description} ${m.makes} ${m.maker} ${m.products.join(" ")} ${
            m.kinds.join(" ")
          } ${m.id}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
        : all;
      const inSection = section ? found.filter((m) => m.section === section) : found;
      // How many of what was found each maker and each kind has, so a catalog can be browsed by either.
      const count = (names: (m: StoreModule) => string[]) => {
        const n = new Map<string, number>();
        for (const m of inSection) for (const name of names(m)) n.set(name, (n.get(name) ?? 0) + 1);
        return [...n].map(([name, count]) => ({ name, count }));
      };
      const shown = inSection.filter((m) =>
        (!maker || m.maker === maker) && (!kind || m.kinds.includes(kind))
      );
      return json(
        {
          ok: true,
          on: true,
          signed,
          total: all.length,
          found: shown.length,
          after,
          sections: {
            skillfully: found.filter((m) => m.section === "skillfully").length,
            companion: found.filter((m) => m.section === "companion").length,
          },
          makers: count((m) => (m.maker ? [m.maker] : []))
            .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })).slice(0, 2000),
          kinds: count((m) => m.kinds).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            .slice(0, 40),
          modules: shown.slice(after, after + SHELF_PAGE).map(fromStore),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (err) {
      return json({ ok: true, on: true, signed, total: 0, found: 0, modules: [], message: sentence(err) });
    }
  }

  /** Check a package file a superuser chose. Nothing is added by this. */
  async function inspect(req: Request, me: Person): Promise<Response> {
    if (!devices.canAdd) return refuse(400, NO_PLACE);
    const bytes = await readFile(req, UPLOAD_MAX);
    if (bytes instanceof Response) return bytes;
    try {
      const pkg = await readPackage(bytes);
      looking.set(me.id, { pkg, at: Date.now() });
      return json({
        ok: true,
        upload: pkg.sha256,
        module: pkg.about,
        // What it will and will not be able to do, in words, before anything is decided.
        notes: networkNotes([]),
        screens: couldUse(pkg),
      });
    } catch (err) {
      return refuse(400, sentence(err));
    }
  }

  async function change(
    path: string,
    b: Record<string, unknown>,
    me: Person,
    session: string,
  ): Promise<Response> {
    const id = String(b.id ?? "");
    const who = { actor: me.id, via: "admin" };
    // A change that hands out power is made by someone who has just said who they are: with this request,
    // or within the last few minutes on this same session. A secret that is sent is always checked, so a
    // wrong one is refused even while the session is unlocked.
    const sure = async () => {
      if (b.confirm === undefined) {
        return accounts.unlocked(session) ? null : json(
          { ok: false, locked: true, message: "Confirm with your own PIN or password first." },
          400,
        );
      }
      return (await accounts.confirm(me.id, b.confirm))
        ? null
        : refuse(400, "Your own PIN or password is not right.");
    };
    switch (path) {
      case "unlock": {
        const seconds = await accounts.unlock(me.id, session, b.confirm);
        return seconds
          ? json({ ok: true, unlocked: seconds })
          : refuse(400, "Your own PIN or password is not right.");
      }
      case "lock":
        accounts.lock(me.id, session);
        return json({ ok: true, unlocked: 0 });

      case "config/apply": {
        // Do what the files say. Always a superuser who has just said who they are, however little it changes.
        const approve = b.approve === "all"
          ? "all" as const
          : Array.isArray(b.approve)
          ? b.approve.map(String).slice(0, 5000)
          : [];
        const no = await sure();
        if (no) return no;
        try {
          const r = await config.apply(approve, { actor: me.id, via: "config" });
          return json(r, r.ok ? 200 : 400);
        } catch (err) {
          return refuse(400, sentence(err));
        }
      }
      case "config/trust": {
        if (b.mode !== "strict" && b.mode !== "hour" && b.mode !== "always") {
          return refuse(400, "Choose strict, trusting for an hour, or always trusting.");
        }
        const no = await sure();
        if (no) return no;
        config.setTrust(b.mode, { actor: me.id, via: "admin" });
        return json({ ok: true, trust: config.trust() });
      }
      case "person":
        return outcome(accounts.addPerson(me.id, b.name));
      case "person/invite":
        return outcome(await accounts.invite(me.id, id));
      case "person/reset": {
        const r = (await sure()) ?? outcome(await accounts.resetSecret(me.id, id, b.temporary));
        if (r.ok) screens.drop(id);
        return r;
      }
      case "person/roles": {
        const r = (await sure()) ?? outcome(accounts.setRoles(me.id, id, b.roles));
        if (r.ok) screens.drop(id);
        return r;
      }
      case "person/slots": {
        const r = outcome(accounts.setSlots(me.id, id, b.slots));
        if (r.ok) screens.drop(id);
        return r;
      }
      case "person/disabled": {
        const r = outcome(accounts.setDisabled(me.id, id, b.disabled === true));
        if (r.ok) screens.drop(id);
        return r;
      }
      case "person/revoke":
        accounts.revoke(me.id, id);
        screens.drop(id);
        return json({ ok: true });
      case "role": {
        const r = outcome(accounts.saveRole(me.id, b.role, (p, a) => screens.abilityExists(p, a)));
        if (r.ok) screens.dropEveryone();
        return r;
      }
      case "role/delete": {
        const r = outcome(accounts.deleteRole(me.id, id));
        if (r.ok) screens.dropEveryone();
        return r;
      }
      case "policy":
        return (await sure()) ?? outcome(accounts.setPolicy(me.id, b.policy));

      case "screen/connections": {
        // Handing a plugin a connection is handing out power.
        const screen = screens.all.get(id)?.manifest;
        if (!screen) return refuse(400, "No such screen.");
        const wanted = Array.isArray(b.drivers) ? b.drivers.map(String) : null;
        const can = new Set(screens.eligible(screen).map((h) => h.id));
        if (!wanted || wanted.some((d) => !can.has(d))) {
          return refuse(400, "A screen can only be given connections of a kind it works with.");
        }
        const no = await sure();
        if (no) return no;
        const changed = approvals.set(me.id, screen.id, wanted);
        if (changed.added.length || changed.removed.length) screens.dropScreen(screen.id);
        return json({ ok: true, ...changed });
      }

      case "driver/mode": {
        if (!devices.hosts.has(id) || (b.mode !== "listen" && b.mode !== "act")) {
          return refuse(400, "No such device, or no such mode.");
        }
        const no = await sure();
        if (no) return no;
        devices.setMode(id, b.mode, who);
        screens.tellPlugins();
        return json({ ok: true });
      }
      case "driver/do": {
        // Tell a device to do one thing, from its own page. It is a superuser doing what a person with a
        // screen could do, so it passes the same checks on the way: the device has to be one people can
        // control, and what is asked has to be something it offers. Only a plain "do this", with nothing to
        // fill in. The hub logs it either way, with who asked and that it came from the admin.
        const host = devices.hosts.get(id);
        if (!host) return refuse(400, "No such device.");
        const key = String(b.key ?? "");
        if (!/^generic\/action\/[^/]{1,200}$/.test(key) || !host.state.has(`${key}/title`)) {
          return refuse(400, "That is not something this device offers to do.");
        }
        const no = await sure();
        if (no) return no;
        const done = await host.set(key, true, who);
        return done.ok ? json({ ok: true }) : refuse(
          400,
          done.error.code === "listen_mode"
            ? "People cannot control this device yet, so nothing is sent to it."
            : done.error.message,
        );
      }
      case "driver/release": {
        const host = devices.hosts.get(id);
        if (!host) return refuse(400, "No such device.");
        host.release(who);
        return json({ ok: true });
      }
      case "driver/settings": {
        const host = devices.hosts.get(id);
        if (!host) return refuse(400, "No such device.");
        const given = b.settings;
        if (!given || typeof given !== "object" || Array.isArray(given)) {
          return refuse(400, "Expected settings.");
        }
        const was = devices.record(id).settings;
        const next: Record<string, unknown> = { ...was };
        for (const [name, value] of Object.entries(given)) {
          if (!["string", "number", "boolean"].includes(typeof value) || name.length > 64) {
            return refuse(400, `The setting ${name.slice(0, 64)} is not something this hub can keep.`);
          }
          // A secret left blank means "keep what is there". It is never sent back to be re-entered.
          if (value === "" && host.settingsForm?.find((f) => f.id === name)?.kind === "secret") continue;
          next[name] = value;
        }
        const changed = Object.keys(next).filter((k) => next[k] !== was[k]).sort();
        if (changed.length) await devices.setSettings(id, next, changed, who);
        return json({ ok: true, changed });
      }
      case "driver/allow": {
        // A superuser's answers to what a device asked for, and anything they take back.
        const host = devices.hosts.get(id);
        if (!host) return refuse(400, "No such device.");
        const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(String))] : []);
        const allow = list(b.allow), deny = list(b.deny), revoke = list(b.revoke);
        if (allow.some((v) => !host.asks.has(v)) || deny.some((v) => !host.asks.has(v))) {
          return refuse(400, "It is no longer asking for one of those. Look again.");
        }
        if (revoke.some((g) => !host.granted.includes(g))) {
          return refuse(400, "It does not hold one of those.");
        }
        if (!allow.length && !deny.length && !revoke.length) {
          return json({ ok: true, allowed: [], denied: [], revoked: [] });
        }
        const no = await sure();
        if (no) return no;
        const allowed = allow.map((v) => host.asks.get(v)!.grant);
        const granted = [...new Set([...host.granted.filter((g) => !revoke.includes(g)), ...allowed])];
        if (granted.length > 64) return refuse(400, "That is more than one device can be given.");
        const denied = [...new Set([...devices.record(id).denied, ...deny])].filter((v) =>
          !allow.includes(v)
        );
        await devices.answer(id, { granted, denied }, { allowed, denied: deny, revoked: revoke }, who);
        return json({ ok: true, allowed: allow, denied: deny, revoked: revoke });
      }
      case "driver/remove": {
        if (!devices.hosts.has(id)) return refuse(400, "No such device.");
        if (!devices.record(id).origin) {
          return refuse(400, "This device was not added here, so it cannot be removed here.");
        }
        const no = await sure();
        if (no) return no;
        const had = screens.using(id);
        await devices.remove(id, who);
        for (const m of had) {
          approvals.set(me.id, m.id, approvals.of(m.id).filter((d) => d !== id));
          screens.dropScreen(m.id);
        }
        return json({ ok: true });
      }

      case "driver/update": {
        // Replace a device from the store with the version the store lists now. Everything decided for it stays.
        if (!devices.hosts.has(id)) return refuse(400, "No such device.");
        if (!devices.record(id).origin?.store) return refuse(400, "This device did not come from the store.");
        try {
          // About to act on it, so the list is read now, not from a few minutes ago.
          store.forget();
          await store.list();
        } catch (err) {
          return refuse(400, sentence(err));
        }
        const other = newerFor(id);
        if (!other) return refuse(400, "It is already the version the store lists.");
        const no = await sure();
        if (no) return no;
        try {
          const got = await store.download(other.listed.id);
          const pkg = await readPackage(got.bytes);
          if (pkg.about.id !== other.origin.package?.id) {
            throw new Error("what the store lists under that name is no longer the same module");
          }
          const host = await devices.update(id, pkg, {
            origin: { ...storeOrigin(got.module, pkg), added: other.origin.added },
            alsoGranted: advance(got.module),
          }, who);
          return json({ ok: true, id: host.id, version: pkg.about.version });
        } catch (err) {
          return refuse(400, sentence(err));
        }
      }
      case "store/fetch": {
        // Download one package from the store and check it against the list. Nothing is added by this.
        if (!devices.canAdd) return refuse(400, NO_PLACE);
        try {
          const got = await store.download(id);
          const pkg = await readPackage(got.bytes);
          if (pkg.about.id !== got.module.id) {
            throw new Error("the package is not the module the store lists");
          }
          looking.set(me.id, { pkg, at: Date.now(), from: got.module });
          return json({
            ok: true,
            upload: pkg.sha256,
            module: pkg.about,
            store: fromStore(got.module),
            screens: couldUse(pkg),
          });
        } catch (err) {
          return refuse(400, sentence(err));
        }
      }
      case "module/add": {
        const up = looking.get(me.id);
        if (!up || up.pkg.sha256 !== b.upload || Date.now() - up.at > UPLOAD_KEPT_MS) {
          return refuse(400, "Choose the package again.");
        }
        // Unless told otherwise a device starts with no access to the network and asks as it goes.
        const reach = String(b.reach ?? "ask").trim();
        const one = /^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/.test(reach);
        if (reach !== "ask" && reach !== "lan" && !one) {
          return refuse(400, "Write the address with its port, like 192.168.1.50:9999.");
        }
        const wanted = Array.isArray(b.screens) ? b.screens.map(String) : [];
        const can = new Set(couldUse(up.pkg).map((m) => m.id));
        if (wanted.some((sc) => !can.has(sc))) {
          return refuse(400, "One of those screens cannot use this device.");
        }
        const no = await sure();
        if (no) return no;
        try {
          const about = up.pkg.about;
          const origin: Origin = up.from ? storeOrigin(up.from, up.pkg) : {
            from: "file",
            package: { id: about.id, name: about.name, version: about.version },
            sha256: up.pkg.sha256,
            added: new Date().toISOString(),
          };
          // From the store, it holds what a signed list allows in advance and starts with the store's settings.
          // From a file, it holds nothing unless the superuser chose otherwise.
          const host = await devices.add(
            up.pkg,
            {
              name: String(b.name ?? ""),
              granted: up.from ? advance(up.from) : reach === "ask" ? [] : [reach, "listen"],
              settings: up.from?.settings ?? {},
              origin,
            },
            deps.taken,
            who,
          );
          looking.delete(me.id);
          for (const sc of wanted) {
            approvals.set(me.id, sc, [...approvals.of(sc), host.id]);
            screens.dropScreen(sc);
          }
          return json({ ok: true, id: host.id, name: host.manifest.name });
        } catch (err) {
          return refuse(400, sentence(err));
        }
      }
    }
    return refuse(404, "Not found.");
  }

  /** Answer one request under /admin/api/. The caller has already made sure a superuser is asking. */
  return async function handle(
    req: Request,
    path: string,
    me: Person,
    origin: string,
    session: string,
  ): Promise<Response> {
    if (req.method === "GET") {
      if (path === "store") {
        return await shelf(new URL(req.url).searchParams);
      }
      if (path === "all") return json(await overview(me, session), 200, { "cache-control": "no-store" });
      if (path === "driver/try") return tryOut(new URL(req.url).searchParams);
      // What the files in the config folder would change. Reading only: applying is a change, made below.
      if (path === "config") {
        return json({ ok: true, ...(await config.overview()), trust: config.trust() }, 200, {
          "cache-control": "no-store",
        });
      }
      return refuse(404, "Not found.");
    }
    if (req.method !== "POST") return refuse(404, "Not found.");
    if (path === "module/inspect") {
      // A file, not JSON. Still only from the hub's own page.
      return notOurPage(req, origin) ?? await inspect(req, me);
    }
    const b = await readJson(req, origin);
    return b instanceof Response ? b : await change(path, b, me, session);
  };
}

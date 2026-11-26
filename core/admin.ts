// A superuser's tools: people, roles, sign-in rules, screens' connections and devices.
// Only the hub's own admin page calls these, and only for a signed-in superuser.
//
// Changes that hand out power, or take a device out of Listen, ask for the superuser's own PIN or
// password again. What is wrong with a request is always said before that is asked for.

import type { Accounts, Person } from "./accounts.ts";
import type { Approvals } from "./approvals.ts";
import { attemptWords, grantWords } from "./asks.ts";
import type { Devices } from "./devices.ts";
import { json, notOurPage, outcome, readFile, readJson, refuse, sentence } from "./http.ts";
import { networkNotes, type Package, readPackage } from "./packages.ts";
import type { Origin } from "./registry.ts";
import type { Screens } from "./screens.ts";
import type { Store, StoreModule } from "./store.ts";

const UPLOAD_MAX = 64 * 1024 * 1024;
const UPLOAD_KEPT_MS = 10 * 60 * 1000;
const NO_PLACE = "This hub was started without a place to keep added devices.";

/** How far something from the store has been proven, in words. */
const PROVEN: Record<string, string> = {
  starts: "It starts and describes itself. Nobody has reported using it with a device.",
  "pretend-device": "It has been proven against a stand-in for the device, not the real thing.",
  "real-device": "It has been used with the real device.",
};

const fromStore = (m: StoreModule) => ({
  id: m.id,
  name: m.name,
  description: m.description,
  version: m.version,
  license: m.license,
  source: m.source.repo,
  proven: PROVEN[m.tested],
  notes: m.notes,
  advance: m.network.map((g) => grantWords(g)),
});

export interface AdminDeps {
  accounts: Accounts;
  approvals: Approvals;
  devices: Devices;
  screens: Screens;
  store: Store;
  /** Whether any plugin, of any kind, already has this id. */
  taken: (id: string) => boolean;
}

export function adminApi(deps: AdminDeps) {
  const { accounts, approvals, devices, screens, store } = deps;
  /** The package each superuser is looking at, checked but not yet added. One each, for a few minutes. */
  const looking = new Map<string, { pkg: Package; at: number; from?: StoreModule }>();
  const kinds = (pkg: Package) => Object.keys((pkg.manifest.capabilities ?? {}) as Record<string, unknown>);
  const couldUse = (pkg: Package) => screens.fits(kinds(pkg)).map((m) => ({ id: m.id, name: m.name }));

  /** Everything the admin page shows. */
  function overview(me: Person) {
    return {
      ok: true,
      me: me.id,
      people: accounts.people().map((p) => ({ ...p, devices: accounts.sessions(p.id).length })),
      roles: accounts.roles(),
      policy: accounts.policy(),
      canAdd: devices.canAdd,
      drivers: [...devices.hosts.values()].map((h) => {
        const record = devices.record(h.id);
        const secret = new Set((h.settingsForm ?? []).filter((f) => f.kind === "secret").map((f) => f.id));
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
          form: h.settingsForm ?? null,
          // What is set now, so the form opens filled in. A secret is never sent back, only whether it is set.
          settings: Object.fromEntries(Object.entries(record.settings).filter(([k]) => !secret.has(k))),
          secretsSet: Object.keys(record.settings).filter((k) => secret.has(k)),
          // What it is waiting on a superuser for, what it holds, and what it tried that is never allowed.
          asks: [...h.asks.values()],
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

  async function shelf(): Promise<Response> {
    if (!store.on) return json({ ok: true, on: false, modules: [] });
    try {
      return json({ ok: true, on: true, modules: (await store.list()).map(fromStore) }, 200, {
        "cache-control": "no-store",
      });
    } catch (err) {
      return json({ ok: true, on: true, modules: [], message: sentence(err) });
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

  async function change(path: string, b: Record<string, unknown>, me: Person): Promise<Response> {
    const id = String(b.id ?? "");
    const who = { actor: me.id, via: "admin" };
    const sure = async () =>
      (await accounts.confirm(me.id, b.confirm))
        ? null
        : refuse(400, "Your own PIN or password is not right.");
    switch (path) {
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
          const origin: Origin = {
            from: up.from ? "store" : "file",
            package: { id: about.id, name: about.name, version: about.version },
            sha256: up.pkg.sha256,
            added: new Date().toISOString(),
            ...(up.from
              ? {
                store: {
                  id: up.from.id,
                  repo: up.from.source.repo,
                  commit: up.from.source.commit,
                  license: up.from.license,
                  tested: up.from.tested,
                },
              }
              : {}),
          };
          // From the store, it holds what the store allows in advance and starts with the store's settings.
          // From a file, it holds nothing unless the superuser chose otherwise.
          const host = await devices.add(
            up.pkg,
            {
              name: String(b.name ?? ""),
              granted: up.from ? up.from.network : reach === "ask" ? [] : [reach, "listen"],
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
  return async function handle(req: Request, path: string, me: Person, origin: string): Promise<Response> {
    if (req.method === "GET") {
      if (path === "store") return await shelf();
      if (path === "all") return json(overview(me), 200, { "cache-control": "no-store" });
      return refuse(404, "Not found.");
    }
    if (req.method !== "POST") return refuse(404, "Not found.");
    if (path === "module/inspect") {
      // A file, not JSON. Still only from the hub's own page.
      return notOurPage(req, origin) ?? await inspect(req, me);
    }
    const b = await readJson(req, origin);
    return b instanceof Response ? b : await change(path, b, me);
  };
}

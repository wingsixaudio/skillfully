# Contributing

There are four things you can add. None needs a change to the hub.

| I want to...                 | Write a...                  | You need to know                                     |
| ---------------------------- | --------------------------- | ---------------------------------------------------- |
| Support a new kind of device | [Capability](#a-capability) | How to describe it in JSON                           |
| Connect a specific device    | [Driver](#a-driver)         | The device's protocol, and TypeScript or JavaScript  |
| Give people something to tap | [Screen](#a-screen)         | HTML, and whatever else you like to build pages with |
| Teach an agent a job         | [Skill](#a-skill)           | How to write the job down clearly                    |

Every plugin is a folder in `plugins/` with a `plugin.json`. Check it with
`deno task check-plugin plugins/<your-plugin>`, which tells you exactly what the hub would say. Then run
`deno task hub` and the hub picks it up. If the hub refuses it, the reason is in the log:
`http://127.0.0.1:8080/api/log?type=skillfully.plugin.refused`.

Before you open a pull request, run `deno task test`. Every pull request is also checked automatically:
formatting, lint, every plugin, every test, and every driver against the contract.

## A capability

A capability is a shared vocabulary: "a soundboard has inputs, sent to buses at a level". Drivers implement it
and screens use it, so a screen written for one soundboard works with every soundboard.

Add one file, `capabilities/<name>.json`. Start from `capabilities/switch.json`, which is the smallest.

- `options` is a JSON Schema for what a driver declares: how many outlets, whether they dim.
- `values` lists each value: its name (`outlet/{outlet}/on`), its kind (`number`, `text` or `boolean`), and
  whether it can be set.
- A part in braces is a number counted from 1. `bounds` says which option gives the count.
- Use plain words a volunteer would use. Never a vendor's names.

Check first whether an existing capability already fits. A new capability that overlaps an old one splits the
screens written for both.

## A driver

A driver talks to one device. It runs as its own process and can reach only its device and the hub.

1. Copy `plugins/sim-switch`. It is about forty lines.
2. In `plugin.json`, set `capabilities` to what your device has, and `permissions.network` to the address it
   lives at (for example `"{host}:9999"`, filled from the driver's settings). That list is what the driver
   **asks for**. A hub started with your plugin gives it that the first time it sees it. If you ask for more
   later, the driver does not get it until a superuser allows it on the admin page, the same as on anyone
   else's hub.
3. In `main.ts`, fill in three things: connect to the device in `start`, return everything it knows in
   `fullState`, and set values in `command`.
4. Prove it: `deno task conformance plugins/<your-driver>`. **This writes to the device.** Never run it on
   equipment that is in use.

Rules a driver must keep (the conformance test checks them):

- **Report what the device holds.** After setting a value, read it back and report that. If the device rounds
  or clamps, report what it really set. Never echo the request.
- **Answer every value exactly once**, in `values` or in `errors`.
- **Send a `state` message when something changes at the device.**
- **Store nothing.** Settings arrive when the hub starts you.
- **Import only your own files** and `sdk/plugin.ts`. Nothing from the internet or npm at run time.

A driver in Listen mode is never sent a command, so a new driver can watch a real device safely before it is
allowed to act.

### If a Companion module already exists for the device

You may not need to write anything. `deno task add-module <package.tgz>` runs a built Bitfocus Companion
module as it is, and shows what the module calls its variables and actions under the `generic` capability. See
`docs/architecture.md`.

That is the quick way in, and it has limits a driver written for this contract does not: its actions cannot be
confirmed by reading back, it is granted the local network unless someone narrows it, and screens written for
`switch` or `console` cannot use it. When a device deserves better, write a driver for a shared capability.

## A screen

A screen is a web page. Build it with anything; the hub serves the files in your folder.

1. Copy `plugins/one-fader`.
2. In `plugin.json`, list what the screen needs under `uses`, and no more:
   `{ "console": "write", "log": "read" }`.
3. List the **abilities** the screen offers. An ability is one thing a team might want to hand out or hold
   back, written so the hub can enforce it:

```json
"abilities": [
  { "id": "watch", "title": "See my own ear mix",
    "allows": { "console": { "access": "read", "keys": ["input/*/bus/{ears}/level", "input/*/name"] } } },
  { "id": "adjust", "title": "Adjust my own ear mix",
    "allows": { "console": { "access": "write", "keys": ["input/*/bus/{ears}/level"] } } }
]
```

- `keys` limits an ability to certain values. A star stands for any one part. A part in braces, like `{ears}`,
  is filled from the person, so one ability means "my own" for everyone. A superuser sets each person's values
  on the People page.
- Leave `keys` out (`"console": "read"`) to cover the whole capability.
- Add a `caution` to any ability others would notice, such as one that changes what everyone hears.
- An ability can never reach past `uses`. The hub refuses a screen that tries.

4. Optionally suggest starter `roles`, so a new team can add "Musician" in one tap.
5. Talk to the hub with messages. There is no library to load.

```js
// Tell the hub's shell you are ready. It answers with "hello" and the current state.
parent.postMessage({ type: "ready" }, "*");

addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m.type === "hello") {
    /* m.me: who is signed in and their slots. m.abilities: what they were granted.
                                m.plugins: the connections this screen was given */
  }
  if (m.type === "state") { /* m.plugin, m.values, m.full. Only values this person may see */ }
  if (m.type === "ack") { /* the answer to a set: m.ok, m.value or m.error */ }
  if (m.type === "link") { /* m.up: whether the hub is reachable */ }
});

// Ask for a value to be set. The answer comes back as an "ack" with the same ref.
parent.postMessage({
  type: "set",
  plugin: "sim-console",
  key: "console/input/1/bus/1/level",
  value: -8,
  ref: 1,
}, "*");
```

Design the screen around `m.abilities`: show a fader only to someone who can move it. But do not rely on that
for safety. The hub decides, and refuses and logs anything the person was not granted, whatever your page
sends.

A screen reaches only the connections a superuser gives it, so `m.plugins` may be empty on a new hub. Say so
plainly when it is, as `plugins/controls` does.

To work with devices you did not write for, ask for `"any"` under `uses` and in an ability. The hub then hands
you, in `m.capabilities`, the definition of every kind of device you can see: each value's title, kind, range
and whether it can be set. `plugins/controls` draws its whole page from that. Asking for `any` is a large
request and is flagged as one on your pull request, so use it only for a screen that is truly general.

What a screen cannot do, by design: reach the network, load code from elsewhere, read the hub's pages or
storage, see a PIN or session, say who the person is, or change anything the person was not granted. Put your
scripts, styles, images and fonts in your folder.

When you show a value after setting it, show the `value` from the `ack`. That is what the device holds, which
may differ from what was asked.

## A skill

A skill is a folder with a `SKILL.md` in the open [Agent Skills](https://agentskills.io/) format, plus a
`plugin.json` so the hub can list it. Nothing in a skill runs.

1. Copy `plugins/explain-a-change`.
2. `SKILL.md` must open with a `name` and a `description` that says when to use it.
3. Write the steps the way you would brief a careful new volunteer. Say what to read, what to conclude, and
   what never to do.
4. If the skill changes anything, say where it must stop and ask a person.

## How a change lands

Nobody pushes to `main`, including the maintainers. Every change is a pull request:

1. Make a branch and commit your change to it.
2. Open a pull request against `main`.
3. The checks run on it by themselves, on machines you do not control:
   - formatting and lint
   - every plugin through the hub's own checker
   - every test, on Linux and macOS (Windows is run and reported, and does not yet block)
   - every driver against the contract
   - a real browser, Chrome and WebKit, that sets up a hub from nothing and then has a screen try every way
     out of its sandbox
   - a report, in plain words, of what each plugin you changed asks for and what it asks for that it did not
     before
4. When the checks pass, a maintainer merges it. A pull request whose checks fail cannot be merged.
5. Once merged, the change is packed as the next version of the hub and offered to every installed hub by its
   Update button. So `main` is always something a team could be running. [docs/updates.md](docs/updates.md)
   says how.

The checks run with read-only access and no secrets, so a pull request from someone the project has never met
is safe to run.

## What gets a pull request merged

- It does one thing.
- `deno task test` passes, and a driver passes `deno task conformance`.
- It asks for the least it needs: the narrowest network address, the fewest `uses`.
- Its `description` tells a non-technical person what it is.
- Words on screen are plain. No vendor terms, no jargon.

There is no license in this repository yet. Until one is chosen, contributions cannot be accepted, because
nobody would know the terms they were given under.

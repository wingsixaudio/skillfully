# Contributing

There are four things you can add. None needs a change to the hub.

| I want to...                 | Write a...                  | You need to know                                     |
| ---------------------------- | --------------------------- | ---------------------------------------------------- |
| Support a new kind of device | [Capability](#a-capability) | How to describe it in JSON                           |
| Connect a specific device    | [Driver](#a-driver)         | The device's protocol, and TypeScript or JavaScript  |
| Give people something to tap | [Screen](#a-screen)         | HTML, and whatever else you like to build pages with |
| Teach an agent a job         | [Skill](#a-skill)           | How to write the job down clearly                    |

Every plugin is a folder in `plugins/` with a `plugin.json`. Run `deno task hub` and the hub picks it up. If
the hub refuses it, the reason is in the log: `http://127.0.0.1:8080/api/log?type=skillfully.plugin.refused`.

Before you open a pull request, run `deno task test`.

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
   lives at (for example `"{host}:9999"`, filled from the driver's settings).
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

## A screen

A screen is a web page. Build it with anything; the hub serves the files in your folder.

1. Copy `plugins/one-fader`.
2. In `plugin.json`, list what the screen needs under `uses`, and no more:
   `{ "console": "write", "log": "read" }`. The hub gives the screen exactly this list, and logs any attempt
   to go beyond it.
3. Talk to the hub with messages. There is no library to load.

```js
// Tell the hub's shell you are ready. It answers with "hello" and the current state.
parent.postMessage({ type: "ready" }, "*");

addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m.type === "hello") { /* m.plugins: the drivers you may use, with their capabilities */ }
  if (m.type === "state") { /* m.plugin, m.values, m.full */ }
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

What a screen cannot do, by design: reach the network, load code from elsewhere, read the hub's pages or
storage, or change anything it did not declare. Put your scripts, styles, images and fonts in your folder.

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

## What gets a pull request merged

- It does one thing.
- `deno task test` passes, and a driver passes `deno task conformance`.
- It asks for the least it needs: the narrowest network address, the fewest `uses`.
- Its `description` tells a non-technical person what it is.
- Words on screen are plain. No vendor terms, no jargon.

There is no license in this repository yet. Until one is chosen, contributions cannot be accepted, because
nobody would know the terms they were given under.

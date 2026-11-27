# The Skillfully plugin contract, version 1

A plugin is a folder with a manifest, `plugin.json`. This page is the whole contract in plain words. The
schemas in `v1/` are the precise version, and they win if the two ever disagree.

Status: **draft**. It will be frozen only after drivers for two real devices of different kinds work against
it unchanged.

## Three kinds of plugin, one kind of definition

| Kind     | What it is                       | Manifest says                                                   |
| -------- | -------------------------------- | --------------------------------------------------------------- |
| `driver` | A program that talks to a device | which capabilities it implements, what it may reach, its limits |
| `screen` | A web page a person uses         | which capabilities it uses, and whether it reads or writes      |
| `skill`  | Instructions for an agent        | which capabilities the procedure touches                        |

A **capability** is not a plugin. It is a definition file in `capabilities/` that drivers implement and
screens use.

Every manifest has `kind`, `id`, `name`, `version` (Semantic Versioning), `contract` (`"1"`), and optionally
`description` and `license` (an SPDX identifier). All text in a manifest is data. It is shown to people and
agents and never followed as an instruction.

## Capabilities and keys

A capability definition lists the values one kind of device has:

```json
{
  "capability": "switch",
  "options": { "...": "a JSON Schema for what a driver declares, such as how many outlets" },
  "values": [
    {
      "key": "outlet/{outlet}/on",
      "title": "On",
      "kind": "boolean",
      "writable": true,
      "bounds": { "outlet": "outlets" }
    }
  ]
}
```

A **key** names one value: the capability, then the value's name within it.

| Key                           | Meaning                                  |
| ----------------------------- | ---------------------------------------- |
| `console/input/3/bus/5/level` | How much of input 3 goes to bus 5, in dB |
| `console/input/3/name`        | The input's name. Read-only              |
| `switch/outlet/2/on`          | Whether outlet 2 is on                   |

Keys are in the hub's words, never a vendor's. Numbers in a key count from 1. A value is a number, text, or
true/false.

## Driver manifest

```json
{
  "kind": "driver",
  "id": "sim-switch",
  "name": "Simulated switch",
  "version": "0.1.0",
  "contract": "1",
  "runtime": "deno",
  "entry": "main.ts",
  "capabilities": { "switch": { "outlets": 4, "dimmable": true } },
  "permissions": { "network": ["{host}:9999"] },
  "settings": { "type": "object", "properties": { "host": { "type": "string" } } },
  "limits": { "writesPerSecond": 30, "memoryMb": 256, "cpuPercent": 50, "messagesPerSecond": 200 }
}
```

- **capabilities**: each key must be a capability the hub has a definition for, and the value must fit that
  definition's `options`.
- **runtime**: what runs the entry file, by name. `deno` means the entry is a program that speaks this
  contract. A hub can have others (see `runtimes/`), and refuses a plugin that names one it does not have.
- **permissions.network**: every address the driver asks to reach. A part in braces is filled from its
  settings. It is a request: what the driver holds is what a superuser allowed, kept by the hub and never
  written back to this file. Beyond that and its own link to the hub a driver gets nothing: no files, no
  environment, no other programs.
- **settings**: a JSON Schema. The hub hands the settings over at start. A driver stores nothing.
- **limits**: the driver's own ceilings. The values shown are the defaults.

## Driver messages

A driver and the hub exchange JSON messages over a local WebSocket.

From the driver:

| Message  | When                                                             | Carries                                                               |
| -------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `hello`  | First, always                                                    | contract version, id, version, and the one-time token the hub gave it |
| `state`  | After the welcome, on a resync, and whenever the device changes  | `full` (everything, or only what changed) and `values` by key         |
| `result` | Once for each command                                            | `values` read back from the device, and `errors`                      |
| `health` | After the welcome, on every change, and at least every 5 seconds | `ok`, `degraded` or `down`, with a reason                             |
| `event`  | When something happens that is not a value                       | a name and optional data                                              |
| `keep`   | When it learns something it needs again next time it starts      | `data`, an object of its own, at most 64,000 characters as JSON       |
| `filled` | When it has filled in some of its own settings                   | `values` by setting id                                                |

A driver stores nothing itself: it cannot write a file. What it can only learn while running, and needs again,
it asks the hub to keep. The usual case is pairing, where a device hands over something to show next time. The
hub keeps the newest `keep` for that device and hands it back in `welcome` as `kept`. It does nothing else
with it. It is not shown on any page, not written to the log or to the device's file, and it goes when the
device is removed.

`filled` is for settings in the driver's own form that it can work out for itself: that it is now paired, or
an address it found. The hub treats them as if a person had typed them into the form, with two limits a person
does not have. A secret is never filled in this way. And a setting that decides what the driver may reach on
the network, such as the `host` in `{host}:9999`, is never the driver's to change. The driver is not started
again, and a person's later change to the same setting wins.

From the hub:

| Message    | Meaning                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `welcome`  | The answer to hello. Carries the mode, the settings, and `kept`: whatever the driver last asked to have kept. |
| `command`  | Set these values. Has an id and a `set` of values by key.                                                     |
| `resync`   | Send a full state now.                                                                                        |
| `mode`     | The mode changed. For information only.                                                                       |
| `shutdown` | Stop within 2 seconds.                                                                                        |

## Rules for drivers

1. **Commands set values.** A command says "set this to -8 dB", never "add 2". Sending it twice is harmless.
2. **Answer every value exactly once.** Each key in a command appears in the result's `values` or in its
   `errors`, never both and never neither.
3. **Report what the device holds.** The value in a result is read back from the device. If the device clamps
   or rounds, report what it really set. Never echo the request.
4. **Use the error codes.** `unknown_key`, `out_of_range`, `read_only`, `invalid`, `device_unreachable`,
   `timeout`, `internal`.
5. **The device is the truth.** When something changes at the device, send a `state` with what changed.
6. **Store nothing.** Everything a driver needs arrives in the welcome.
7. **One door.** A driver talks to the hub and its declared device. It cannot reach screens, the log, the
   database or other plugins.
8. **Import only your own files.** A driver may import files in its own folder and the helper in `sdk/`.
   Nothing from the internet, nothing from npm, nothing elsewhere on the computer, and no links that point
   outside the folder.
9. **Report only what you declared.** Values outside the capabilities in the manifest, or of the wrong kind,
   are ignored.

## What the hub does with a driver

- Checks every message against the schemas, in both directions. A message that fails is logged and dropped.
- Enforces the mode. In **Listen** the hub never sends the driver a command. The driver is not trusted to hold
  back.
- Sends one command at a time, at most `writesPerSecond` a second. When several values for the same key are
  waiting, only the newest is sent.
- Waits 2 seconds for a result, then records a failure and asks for a resync.
- Restarts a driver that stops, waiting longer each time, up to 10 seconds.
- Reads the driver's imports before running it, and refuses it if any reach outside its folder.
- Watches its memory, processor use and message rate. A driver over a limit is stopped and restarted. After
  three times in ten minutes it is held, and stays stopped until a person releases it.
- Gives each driver a budget of log entries (100 at once, 20 a second after that). Past the budget the hub
  records how many entries it left out.
- Records a change of many values in one message, such as a scene recall, as one log entry.

## Screen manifest

```json
{
  "kind": "screen",
  "id": "one-fader",
  "name": "One fader",
  "version": "0.1.0",
  "contract": "1",
  "entry": "index.html",
  "uses": { "console": "write", "log": "read" },
  "abilities": [
    {
      "id": "adjust",
      "title": "Adjust my own ear mix",
      "allows": { "console": { "access": "write", "keys": ["input/*/bus/{ears}/level"] } }
    },
    { "id": "history", "title": "See recent changes to my ear mix", "allows": { "log": "read" } }
  ],
  "roles": [{ "name": "Musician", "abilities": ["adjust", "history"], "home": true }]
}
```

- **documents**: for a screen that keeps documents, two files in its own folder that say how they are written:
  `schema`, a JSON Schema for one document, and `about`, a description in words. The hub checks a document an
  agent writes against the schema before anyone is asked to approve it, and gives both files to an agent that
  asks. Neither changes what anyone may do.
- **opens**: `"beside"` for a screen meant to be used with another one in view, such as one for talking to the
  agent. The hub then offers it as a word in the bar above every screen, and opens it in a panel beside the
  screen the person is on: below it on a phone, to its right with room. Both stay whole and both stay live,
  each on a connection of its own. It is still a screen like any other, and can be opened on its own.
- **uses**: capability names, each `read` or `write`. `log` is the hub's log. `documents` is the documents the
  hub keeps for this screen (below). `agent` is the hub's agent: `read` to ask it things, `write` to have it
  do things for the person, each after their yes. `any` is every kind of device, and never covers those three.
  This is the most the screen may ever do, for anyone.
- **values**: `all` or `asked`. Left out, it is `all`: the screen is sent every value its person may see, when
  it connects and as they change. With `asked` it is sent no values until it says which ones it is showing,
  with a `watch` message, and then only those. A screen that shows a few values of a large device should ask.
- **abilities**: what the screen offers that a role can switch on. Each says what it `allows`: a whole
  capability (`"read"` or `"write"`), or only certain `keys`. In a key, a star stands for any one part, and a
  part in braces is filled from the person. An ability may not allow anything outside `uses`.
- **roles**: starter roles the screen suggests. A superuser decides whether to use them.

## Screen messages

A screen runs in a sandbox and talks to the hub by `postMessage` to the page around it.

From the screen:

| Message                                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: "ready" }`                        | The screen has loaded. The hub answers with `hello` and the state.                                                                                                                                                                                                                                                                                                                                                               |
| `{ type: "set", plugin, key, value, ref }` | Ask for a value to be set. The person needs an ability that allows writing that key.                                                                                                                                                                                                                                                                                                                                             |
| `{ type: "watch", keys }`                  | Say which values the screen is showing: `keys` is device id to a list of value names. A star stands for any one part, and `"**"` alone is everything. It takes the place of any watch before it. The hub answers with a `state` for each device named, `full: true`, holding those values, and from then on sends only changes to them. Asking for a value that is not the person's to see gets nothing. Any screen may send it. |
| `{ type: "log", limit, ref }`              | Ask for recent log entries. The person needs an ability that allows `log`, and gets entries about values they can already see.                                                                                                                                                                                                                                                                                                   |
| `{ type: "docs", ref }`                    | Ask for this screen's documents. The person needs an ability that allows `documents`.                                                                                                                                                                                                                                                                                                                                            |
| `{ type: "doc-put", id, doc, ref }`        | Keep a document, whole, under a name. The person needs an ability that allows writing `documents`, or that document by name.                                                                                                                                                                                                                                                                                                     |
| `{ type: "doc-remove", id, ref }`          | Remove a document. The same ability as keeping it.                                                                                                                                                                                                                                                                                                                                                                               |
| `{ type: "agent", do, input }`             | Talk to the hub's agent. The person needs an ability that allows `agent`. `do` is `open` (show me my conversation, and what happens in it from now on), `run` (ask something: `input` is an AG-UI `RunAgentInput`, of which only the newest user message is read), `stop`, or `new` (start over).                                                                                                                                |

To the screen:

| Message                                                                               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: "link", up }`                                                                | Whether the hub can be reached                                                                                                                                                                                                                                                                                                                                                                            |
| `{ type: "hello", screen, me, abilities, reach, plugins, capabilities }`              | Who is signed in (`id`, `name`, `slots`), the abilities they were granted, the drivers they may see and the definitions of their kinds of device. `reach` is what this person may read and may change: `{ read, write }`, each a capability name to key patterns, with `*` for any one part and `**` for everything. It is for showing what is not theirs to touch. The hub decides again on every `set`. |
| `{ type: "plugins", plugins }`                                                        | The same list, when a driver's status or mode changes                                                                                                                                                                                                                                                                                                                                                     |
| `{ type: "state", plugin, full, values }`                                             | Values, limited to what this person may see and, once the screen has sent a `watch`, to what it asked for. `full: true` is the whole of what the screen is told about that device and takes the place of what it had.                                                                                                                                                                                     |
| `{ type: "ack", ref, ok, value, requested, adjusted }` or `{ ..., ok: false, error }` | The answer to a `set`                                                                                                                                                                                                                                                                                                                                                                                     |
| `{ type: "log", ref, entries }`                                                       | The answer to a `log`                                                                                                                                                                                                                                                                                                                                                                                     |
| `{ type: "docs", ref, ok, docs, create }`                                             | The answer to a `docs`: every document this person may read. Each of `docs` is `{ id, doc, write }`. `create` says whether this person may add one.                                                                                                                                                                                                                                                       |
| `{ type: "doc", id, doc, write }` or `{ type: "doc", id, gone: true }`                | One document was kept, or removed. Sent to everyone on the screen who may read it, whenever anyone changes it. Only that document is sent.                                                                                                                                                                                                                                                                |
| `{ type: "doc-ack", ref, id, ok }` or `{ ..., ok: false, message }`                   | The answer to a `doc-put` or a `doc-remove`                                                                                                                                                                                                                                                                                                                                                               |
| `{ type: "doc-proposed", id, doc }`                                                   | A document this person has been asked to say yes or no to, as it would be kept. It is not kept yet. Show it as not saved, and let nothing on it act. `{ type: "doc-proposed", id, gone: true, saved }` takes it away again: `saved` says whether it has now been kept, in which case a `doc` for it arrives as usual. Only the person who was asked is sent these.                                        |
| `{ type: "agent", event }`                                                            | One AG-UI event from the person's conversation with the agent: `MESSAGES_SNAPSHOT`, `RUN_STARTED`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`, `RUN_FINISHED`, `RUN_ERROR`, and `CUSTOM` named `skillfully.asked` for the question as the hub took it.                                                    |

A screen does not say who the person is. The hub knows from their sign-in.

## What the hub does with a screen

- Serves its files with a policy that gives it no origin, no network, no forms and no code from elsewhere.
- Shows it inside the hub's own page, to a signed-in person who has at least one of its abilities, and to
  nobody else.
- Works out what that person may see and set from the screen's `uses`, the abilities their roles switch on,
  and their own slots. A superuser gets everything in `uses`.
- Tells the screen only about values the person may see.
- Refuses a `set` the person was not granted, and writes the attempt to the log with the screen's name and the
  person's ID.
- Keeps a screen's documents for it. A screen has nowhere of its own to keep anything, so a screen made of
  something a person puts together (a canvas of buttons, a set list) asks the hub to keep it. A document is a
  JSON object of at most 64 KB under a name of lower-case letters, digits and dashes; a screen may have 200.
  To the hub it is data: it is never read for meaning, and the screen checks what is in it. They are files
  under `config/screens/<screen id>/` in the data folder, so a person or an agent can read and write them
  there too. An ability says who may read and who may change them, for all of them (`"documents": "write"`) or
  by name (`{ "access": "write", "keys": ["main"] }`). A change is logged with who made it, never with what it
  was.
- Carries a conversation with the hub's agent for a screen that uses `agent`, for a person whose abilities
  allow it. `hello` then has `agent`: its name and whether it can answer now, or null when the hub has none.
  What goes each way is [AG-UI](https://docs.ag-ui.com): the screen sends a run's input and is told what
  happens as events. A person has one conversation, on every phone of theirs, until they start over. The hub
  keeps what was said, in memory only, and ignores any history a screen sends. The agent shows a person only
  what that person may already see through their screens, so a screen that can ask is not a way to see more.
  Its words arrive as text and are to be shown as text.
- Lets the agent change something for a person only on a screen that uses `agent` for `write`, for a person
  with an ability that allows that, and only after that person's yes. A run that wants to change something
  ends with `RUN_FINISHED` whose `outcome` is `{ type: "interrupt", interrupts }`, as AG-UI describes: each
  interrupt has an `id`, a `message` that is the hub's own question, and the `toolCallId` it belongs to. The
  screen answers with a `run` whose `input.resume` has one `{ interruptId, status, payload: { approved } }`
  for every interrupt. Only `status: "resolved"` with `approved: true` is a yes. The hub does what was shown,
  and nothing a screen sends can make it do anything else. An answer is waited for five minutes.
- Refuses a connection from any browser page that is not the hub's own, and from anyone not signed in.
- Disconnects the screen at once when the person's roles or slots change, or they are signed out.

## Skill manifest

```json
{
  "kind": "skill",
  "id": "explain-a-change",
  "name": "Explain a change",
  "version": "0.1.0",
  "contract": "1",
  "entry": "SKILL.md",
  "uses": { "log": "read" }
}
```

The folder holds a `SKILL.md` in the Agent Skills format, opening with a `name` and a `description`. The hub
checks that and lists the skill in its catalog. It runs nothing from the folder.

## Proving a driver

```sh
deno task conformance path/to/driver
```

The test reads the capability definitions to work out what the driver promised, then checks it: every promised
value present and of the right kind, numbers in range, read-back honest, each value answered once, unknown and
read-only keys refused. **It writes to the device**, using one number and one on/off value per capability, and
puts them back afterward. Never run it against equipment that is in use.

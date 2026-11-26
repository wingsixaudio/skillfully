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
- **permissions.network**: every address the driver may reach. A part in braces is filled from its settings.
  The hub grants these and its own link, and nothing else: no files, no environment, no other programs.
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

From the hub:

| Message    | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| `welcome`  | The answer to hello. Carries the mode and the settings.   |
| `command`  | Set these values. Has an id and a `set` of values by key. |
| `resync`   | Send a full state now.                                    |
| `mode`     | The mode changed. For information only.                   |
| `shutdown` | Stop within 2 seconds.                                    |

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
  "home": ["musician"]
}
```

- **uses**: capability names, each `read` or `write`. `log` is the hub's log. The hub tells the screen about
  these and nothing else, and refuses anything beyond them.
- **home**: roles this screen suggests itself as the first screen for. The hub's settings decide.

## Screen messages

A screen runs in a sandbox and talks to the hub by `postMessage` to the page around it.

From the screen:

| Message                                    | Meaning                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `{ type: "ready" }`                        | The screen has loaded. The hub answers with `hello` and the state. |
| `{ type: "set", plugin, key, value, ref }` | Ask for a value to be set. Needs `write` on that capability.       |
| `{ type: "log", limit, ref }`              | Ask for recent log entries. Needs `log`.                           |

To the screen:

| Message                                                                               | Meaning                                                                 |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `{ type: "link", up }`                                                                | Whether the hub can be reached                                          |
| `{ type: "hello", screen, uses, plugins }`                                            | The drivers this screen may use, with only the capabilities it declared |
| `{ type: "plugins", plugins }`                                                        | The same list, when a driver's status or mode changes                   |
| `{ type: "state", plugin, full, values }`                                             | Values, limited to the capabilities the screen declared                 |
| `{ type: "ack", ref, ok, value, requested, adjusted }` or `{ ..., ok: false, error }` | The answer to a `set`                                                   |
| `{ type: "log", ref, entries }`                                                       | The answer to a `log`                                                   |

A screen does not say who the person is. The hub's own page does.

## What the hub does with a screen

- Serves its files with a policy that gives it no origin, no network, no forms and no code from elsewhere.
- Shows it inside the hub's own page, which carries its messages and forwards only `set` and `log`.
- Refuses a connection from any browser page that is not the hub's own.
- Refuses a `set` the screen did not declare, and writes the attempt to the log with the screen's name and the
  person's ID.

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

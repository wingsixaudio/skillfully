# The Skillfully plugin contract, version 1

A plugin is a folder with a manifest (`plugin.json`) and a program. The hub starts the program as its own
process and talks to it with JSON messages over a local WebSocket. This page is the whole contract in plain
words. The schemas in `v1/` are the precise version, and they win if the two ever disagree.

Status: **draft**. It will be frozen only after two drivers of different kinds work against it unchanged.

## The manifest

```json
{
  "id": "sim-console",
  "name": "Simulated board",
  "description": "A pretend soundboard held in memory.",
  "version": "0.1.0",
  "contract": "1",
  "runtime": "deno",
  "entry": "main.ts",
  "capabilities": {
    "console": { "inputs": 48, "buses": 16, "level": { "min": -90, "max": 10 }, "pan": true }
  },
  "permissions": { "network": ["{host}:2223"] },
  "settings": { "type": "object", "properties": { "host": { "type": "string" } } },
  "limits": { "writesPerSecond": 30, "memoryMb": 128 }
}
```

- **capabilities** come from a fixed set the contract defines. Version 1 defines `console` only. Options
  inside a capability are declared, never assumed.
- **permissions.network** lists every address the plugin may reach. A part in braces is filled from its
  settings. The hub grants these and its own link, and nothing else: no files, no environment, no other
  programs.
- **settings** is a JSON Schema. The hub hands the settings to the plugin at start. A plugin stores nothing.
- **description** and every other piece of plugin text is data. It is shown to people and agents; it is never
  followed as an instruction.

## Values

A console's values are named in the hub's words, never the vendor's. Inputs and buses count from 1.

| Value                 | Meaning                                                                   | Kind   |
| --------------------- | ------------------------------------------------------------------------- | ------ |
| `input/3/bus/5/level` | How much of input 3 goes to bus 5, in dB. The declared minimum means off. | number |
| `input/3/bus/5/pan`   | Where it sits, from -100 (left) to +100 (right).                          | number |
| `input/3/name`        | The input's name on the board. Read-only.                                 | text   |

## Messages from the plugin

| Message  | When                                                             | Carries                                                               |
| -------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `hello`  | First, always                                                    | contract version, id, version, and the one-time token the hub gave it |
| `state`  | After the welcome, on a resync, and whenever the device changes  | `full` (everything, or only what changed) and `values`                |
| `result` | Once for each command                                            | `values` read back from the device, and `errors`                      |
| `health` | After the welcome, on every change, and at least every 5 seconds | `ok`, `degraded` or `down`, with a reason                             |
| `event`  | When something happens that is not a value                       | a name and optional data                                              |

## Messages from the hub

| Message    | Meaning                                                 |
| ---------- | ------------------------------------------------------- |
| `welcome`  | The answer to hello. Carries the mode and the settings. |
| `command`  | Set these values. Has an id and a `set` of values.      |
| `resync`   | Send a full state now.                                  |
| `mode`     | The mode changed. For information only.                 |
| `shutdown` | Stop within 2 seconds.                                  |

## Rules

1. **Commands set values.** A command says "set this to -8 dB", never "add 2". Sending it twice is harmless.
2. **Answer every value exactly once.** Each value in a command appears in the result's `values` or in its
   `errors`, never both and never neither.
3. **Report what the device holds.** The value in a result is read back from the device. If the device clamps
   or rounds, report what it really set. Never echo the request.
4. **Use the error codes.** `unknown_param`, `out_of_range`, `read_only`, `invalid`, `device_unreachable`,
   `timeout`, `internal`.
5. **The device is the truth.** When something changes at the device, send a `state` with what changed.
6. **Store nothing.** Everything a plugin needs arrives in the welcome.
7. **One door.** A plugin talks to the hub and its declared device. It cannot reach phones, the log, the
   database or other plugins.

## What the hub does on its side

- Checks every message against the schemas, in both directions. A message that fails is logged and dropped.
- Enforces the mode. In **Listen** the hub never sends the plugin a command. The plugin is not trusted to hold
  back.
- Sends one command at a time, at most `writesPerSecond` a second. When several values for the same thing are
  waiting, only the newest is sent.
- Waits 2 seconds for a result, then records a failure and asks for a resync.
- Restarts a plugin that stops, waiting longer each time, up to 10 seconds.

## Proving a plugin

```sh
deno task conformance path/to/plugin
```

This runs 24 checks. **It writes to the console**, using one send, and puts the send back afterward. Never run
it against a board that is in use.

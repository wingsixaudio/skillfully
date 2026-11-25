# Skillfully

A hub for worship-team sound. Musicians set their own ear mixes from a phone, every device sits behind one
plugin contract, and every change goes into one log.

This repository holds the foundation, built as one thin slice: **a phone moves one fader, through the hub, to
a simulated soundboard and back.** Nothing here talks to a real board yet.

## What the slice proves

| Foundation rule                  | How it is proven here                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One contract, one way in         | `contract/` defines every message as JSON Schema. The hub checks every message in both directions.                                                                                              |
| The log from the first day       | Every request, confirmation, refusal, crash and board-side change is appended to an SQLite log in CloudEvents shape. Rows cannot be changed or deleted.                                         |
| Enforced isolation               | Each plugin is its own process with only the network addresses its manifest declares. Its imports are checked before any of its code runs. A test plugin tries 17 ways out and all are blocked. |
| Limits with teeth                | The hub watches each plugin's memory, processor use and message rate, stops one that goes over, and after three times holds it until a person releases it. A plugin cannot fill the log.        |
| The board is the truth           | A write counts only when the board reads it back. The hub reports what the board holds, not what was asked for.                                                                                 |
| Failures stay small              | A plugin that crashes, lies, floods or runs out of memory is logged and restarted. The fader keeps working.                                                                                     |
| A way to say "this plugin works" | `conformance/` plays the hub's part against any console plugin and runs 24 checks.                                                                                                              |

## Run it

You need [Deno](https://deno.com) 2.2 or newer. Nothing else is installed.

```sh
deno task hub          # then open http://127.0.0.1:8080
deno task hub --lan    # lets a phone on the same network connect
deno task test         # every test
deno task conformance plugins/sim-console
```

The first run downloads one library (the JSON Schema validator). After that it runs offline.

## Layout

```
contract/      The contract: schemas (v1/), types, validators, and a plain-language guide
core/          The hub: plugin processes, the log, the write queue, the phone connection
plugins/       sim-console, the simulated board
sdk/           An optional helper for plugins written for Deno
conformance/   The conformance test for console plugins
app/phone/     The one-fader page
tests/         End-to-end, isolation, contract and log tests, with misbehaving test plugins
docs/          Decisions and what is still open
```

## Warnings

- **The conformance test writes to the console it tests.** It uses one send and puts it back, but never run it
  against a board that is in use.
- **Memory and processor limits are checked a few times a second, not enforced by the operating system.** A
  plugin can go over for a moment before it is stopped. They work on Linux and should work on macOS; on
  Windows they are not enforced, and the log says so.
- **There is no sign-in yet.** A phone says who it is and the hub believes it. Do not put this on a network
  you do not trust.
- **No license has been chosen.** Until one is added, nobody else has the right to reuse this code.

## Not built yet

A real board driver, people and instruments, saved mixes, roles and sign-in, plugin install and uninstall,
record and replay of plugin traffic, meters, and everything to do with agents. See `docs/decisions.md`.

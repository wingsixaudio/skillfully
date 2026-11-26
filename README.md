# Skillfully

A small hub that everything else plugs into. Devices, screens and agent skills are all plugins, and every
change goes into one log.

The first use is a worship team: musicians set their own ear mixes from a phone. Nothing in the hub is written
for that use. A soundboard is one definition file, a switch is another, and the ear-mix screen is a plugin
that happens to be the home screen for musicians.

This repository holds the foundation. **Nothing here talks to a real device yet**: it runs against a simulated
soundboard and a simulated switch.

## What is here

|                                                           |                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Capabilities** (`capabilities/`)                        | What a soundboard is and what a switch is, as data. Adding a kind of device is adding a file.                    |
| **Drivers** (`plugins/sim-console`, `plugins/sim-switch`) | Each runs as its own process, limited to the addresses its manifest declares.                                    |
| **A screen** (`plugins/one-fader`)                        | One ear-mix fader. A web page in a sandbox that can reach the hub only by asking, and only for what it declared. |
| **A skill** (`plugins/explain-a-change`)                  | Instructions that teach an agent to answer "why did that change?" from the log.                                  |
| **The hub** (`core/`)                                     | Plugin processes, the write queue, who may do what, and the log. It names no capability.                         |
| **The contract** (`contract/`)                            | Every manifest and message as JSON Schema, with a plain-language guide.                                          |
| **The conformance test** (`conformance/`)                 | Proves any driver of any capability keeps the contract.                                                          |

## What it proves

| Foundation rule             | How it is proven here                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One contract, one way in    | The hub checks every message in both directions against the schemas.                                                                                           |
| The hub is not about sound  | The same hub runs a soundboard and a switch. A test fails if the hub's code names either.                                                                      |
| The log from the first day  | Every request, confirmation, refusal, crash and device-side change is appended to an SQLite log in CloudEvents shape. Rows cannot be changed or deleted.       |
| Enforced isolation, drivers | A test driver tries 17 ways out and all are blocked. Imports are checked before any code runs.                                                                 |
| Enforced isolation, screens | In a real browser, a screen tries 12 ways out and all are blocked. A screen that declared only the soundboard cannot flip a switch, and the attempt is logged. |
| Limits with teeth           | The hub watches each driver's memory, processor use and message rate, stops one that goes over, and after three times holds it until a person releases it.     |
| The device is the truth     | A write counts only when the device reads it back. The hub reports what the device holds, not what was asked for.                                              |
| Failures stay small         | A driver that crashes, lies, floods or runs out of memory is logged and restarted. Everything else keeps working.                                              |

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
capabilities/  What each kind of device is, as data
contract/      The contract: schemas (v1/), types, validators, and a plain-language guide
core/          The hub
plugins/       Drivers, screens and skills. One folder each, with a plugin.json
sdk/           An optional helper for drivers written for Deno
conformance/   The conformance test for drivers
tests/         The test suite, with misbehaving test plugins
docs/          Architecture, decisions and what is still open
```

To add something, read `CONTRIBUTING.md`. To see how it fits together, read `docs/architecture.md`.

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

A real device driver, people and instruments, saved mixes, sign-in and roles, plugin install and uninstall,
record and replay of driver traffic, meters, and access for agents. See `docs/architecture.md` and
`docs/decisions.md`.

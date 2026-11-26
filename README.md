# Skillfully

A small hub that everything else plugs into. Devices, screens and agent skills are all plugins, and every
change goes into one log.

The first use is a band or production team: each person sets their own ear mix from a phone. Nothing in the
hub is written for that use. A soundboard is one definition file, a switch is another, and the ear-mix screen
is a plugin that happens to be the home screen for musicians.

This repository holds the foundation. **Nothing here talks to a real device yet**: it runs against a simulated
soundboard and a simulated switch.

## What is here

|                                                           |                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Capabilities** (`capabilities/`)                        | What a soundboard is and what a switch is, as data. Adding a kind of device is adding a file.                                        |
| **Drivers** (`plugins/sim-console`, `plugins/sim-switch`) | Each runs as its own process, limited to the addresses its manifest declares.                                                        |
| **A screen** (`plugins/one-fader`)                        | One ear-mix fader. A web page in a sandbox that can reach the hub only by asking, and only for what the person using it was granted. |
| **A skill** (`plugins/explain-a-change`)                  | Instructions that teach an agent to answer "why did that change?" from the log.                                                      |
| **The hub** (`core/`)                                     | Plugin processes, the write queue, people and sign-in, roles, and the log. It names no capability.                                   |
| **The contract** (`contract/`)                            | Every manifest and message as JSON Schema, with a plain-language guide.                                                              |
| **The conformance test** (`conformance/`)                 | Proves any driver of any capability keeps the contract.                                                                              |

## What it proves

| Foundation rule               | How it is proven here                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One contract, one way in      | The hub checks every message in both directions against the schemas.                                                                                                                                                                |
| The hub is not about sound    | The same hub runs a soundboard and a switch. A test fails if the hub's code names either.                                                                                                                                           |
| The log from the first day    | Every request, confirmation, refusal, crash, sign-in problem and change of role is appended to an SQLite log in CloudEvents shape. Rows cannot be changed or deleted. People appear as IDs, and no PIN or password is ever written. |
| One list of people            | The hub owns people, sign-in and remembered devices. A new hub is claimed with a code shown only where it runs. PINs and passwords are stored unreadable, and five wrong tries start a growing wait.                                |
| Roles are data                | Plugins declare abilities the hub can enforce. A role is a set of them. Superuser is the only role built in, and a hub can never be left without one.                                                                               |
| Each person, their own things | An ability can be limited to a person's own values. A musician can adjust the sends into their own bus and is refused, and logged, on anyone else's.                                                                                |
| Enforced isolation, drivers   | A test driver tries 17 ways out and all are blocked. Imports are checked before any code runs.                                                                                                                                      |
| Enforced isolation, screens   | In a real browser, a screen tries 13 ways out and all are blocked, including reading the session and using the superuser's tools.                                                                                                   |
| Limits with teeth             | The hub watches each driver's memory, processor use and message rate, stops one that goes over, and after three times holds it until a superuser releases it.                                                                       |
| The device is the truth       | A write counts only when the device reads it back. The hub reports what the device holds, not what was asked for.                                                                                                                   |
| Failures stay small           | A driver that crashes, lies, floods or runs out of memory is logged and restarted. Everything else keeps working.                                                                                                                   |

## Run it

You need [Deno](https://deno.com) 2.2 or newer. Nothing else is installed.

```sh
deno task hub          # then open http://127.0.0.1:8080
deno task hub --lan    # lets a phone on the same network connect
```

The first time, the hub prints a short code. Open the address, enter the code, and you become its first
superuser. From the People page you add everyone else: add a name, give them a role, and hand them the
invitation it shows.

```sh
deno task test                             # every test
deno task check-plugin plugins/one-fader   # what the hub would say about a plugin
deno task conformance plugins/sim-switch   # prove a driver keeps the contract
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

- **There is no HTTPS yet.** Sign-in travels over the network unprotected. Run it on a network you trust, not
  on shared or guest Wi-Fi.
- **The conformance test writes to the device it tests.** It puts the values back, but never run it against
  equipment that is in use.
- **Memory and processor limits are checked a few times a second, not enforced by the operating system.** A
  driver can go over for a moment before it is stopped. On Windows they are not enforced, and the log says so.
- **No license has been chosen.** Until one is added, nobody else has the right to reuse this code.
- **Run only on Linux so far.** macOS should work. Windows very likely does not yet.

## Not built yet

A real device driver, the team roster and saved mixes, a place for plugins to keep data, HTTPS, plugin install
and uninstall, record and replay of driver traffic, meters, and access for agents. See `docs/architecture.md`
and `docs/decisions.md`.

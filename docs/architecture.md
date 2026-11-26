# Architecture

Skillfully is a small hub with everything else plugged into it. The hub knows about plugins, capabilities,
values, commands, people and the log. It does not know what a soundboard, a fader, a light or an ear mix is.
Those arrive as plugins.

The first use is ear mixes for a worship team. Nothing in the hub is written for that use.

## The pieces

| Piece          | What it is                                                                                    | Who writes one                                  | Can it run code?                    |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| **Capability** | A definition file: the values one kind of device has, what kind each is, and which can be set | Anyone who wants a new kind of device supported | No. It is data                      |
| **Driver**     | A program that talks to one device and implements one or more capabilities                    | Someone who knows a device's protocol           | Yes, as its own locked-down process |
| **Screen**     | A web page a person uses                                                                      | Any web developer, with any tools               | Yes, inside a browser sandbox       |
| **Skill**      | Instructions that teach an agent one procedure                                                | Anyone who can write the procedure down         | No. It is text                      |

Every plugin is a folder with a `plugin.json`. The hub reads that file before it runs or serves anything from
the folder.

## How they connect

```
 person                       agent
   |                            |
[screen]  (sandboxed page)   [skill]  (text the agent reads)
   |  messages only             |
[shell]   (the hub's own page)  |
   |                            |
+--------------------- hub ----------------------+
|  who may do what   |  values and commands      |
|  capability definitions (data)   |   the log   |
+------------------------------------------------+
   |  messages only, one process each
[driver]      [driver]      [driver]
   |             |             |
 device        device        device
```

- A **driver** reaches its device and the hub. Nothing else: no files, no other programs, no internet, no
  other plugins.
- A **screen** reaches nothing directly. It sends messages to the hub's shell page, which passes them on. The
  hub answers only for the capabilities the screen's manifest lists under `uses`, and only at the level listed
  (`read` or `write`).
- A **skill** runs nothing. An agent reads it and then acts through the same doors as everyone else.

Everything that changes a value goes through the hub and into the log, whoever asked.

## Why it is built this way

**Capabilities are data so the hub never has to change for a new kind of device.** Adding projectors means
adding `capabilities/projector.json`. The hub validates drivers against it, scopes screens by it, and the
conformance test reads it to work out what a driver promised. No hub code names a capability; a test fails if
any does.

**Screens are ordinary web pages so any developer can write one.** There is no framework to learn and no
component set to stay inside. The price of that freedom is paid by the sandbox: a screen has no origin of its
own, no network, and no way to reach the hub except by asking.

**Trust comes from structure, not review.** A driver cannot read your files because the runtime will not let
it, not because someone read its code. A screen cannot flip a switch it did not declare because the hub
refuses, and logs the attempt. This is what makes it reasonable to install a plugin written by a stranger, or
by an agent.

**One log.** Every request, confirmation, refusal, crash and device-side change is one append-only record,
with people as IDs. Undo, audit, habits, reports and anything an agent does later all read from it.

## Roles and home screens

The hub keeps a table of which screen each role lands on. A musician opens the hub and sees ear mixes; someone
running lights would see a lighting screen. A screen can suggest roles in its manifest (`home`), and the hub's
own settings decide.

Sign-in is not built yet, so today everyone is the default role.

## What is deliberately not here

- **A general app builder.** Screens are written, not assembled.
- **Plugins talking to each other.** They talk to the hub.
- **Code in capabilities or skills.** Data and text only.
- **A second way in.** There is no private path for "trusted" plugins. The simulated board in this repository
  gets the same sandbox as anything else.

## Planned, not built

| Piece                                    | What it would be                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Service**                              | A background program that uses capabilities the way a screen does: automation, scheduling, an agent's own process. Same `uses` rule, same driver-style sandbox               |
| **Rule**                                 | "When this, do that" as data, switched on by a person                                                                                                                        |
| **Screens described as data**            | A screen given as a description and drawn from trusted components, so an agent can author one without writing code. It would be one more screen, running in the same sandbox |
| **Agent access**                         | A thin MCP server over the catalog and the log, so an agent sees what a screen can see and is held to a `uses` list like a screen is                                         |
| **Install, update, rollback, uninstall** | Today plugins are folders the hub scans at start                                                                                                                             |
| **Sign-in and roles**                    | Today the shell says who the person is                                                                                                                                       |

See `docs/decisions.md` for what was decided, tested and left open, and `CONTRIBUTING.md` for how to write
each kind of plugin.

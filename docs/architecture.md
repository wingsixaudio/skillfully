# Architecture

Skillfully is a small hub with everything else plugged into it. The hub knows about plugins, capabilities,
values, commands, people and the log. It does not know what a soundboard, a fader, a light or an ear mix is.
Those arrive as plugins.

The first use is ear mixes for a band or production team. Nothing in the hub is written for that use.

## The pieces

| Piece          | What it is                                                                                    | Who writes one                                  | Can it run code?                    |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| **Capability** | A definition file: the values one kind of device has, what kind each is, and which can be set | Anyone who wants a new kind of device supported | No. It is data                      |
| **Driver**     | A program that talks to one device and implements one or more capabilities                    | Someone who knows a device's protocol           | Yes, as its own locked-down process |
| **Screen**     | A web page a person uses                                                                      | Any web developer, with any tools               | Yes, inside a browser sandbox       |
| **Skill**      | Instructions that teach an agent one procedure                                                | Anyone who can write the procedure down         | No. It is text                      |

Every plugin is a folder with a `plugin.json`. The hub reads that file before it runs or serves anything from
the folder.

### Drivers the hub did not have to wait for

A driver's manifest names what runs it. `deno` means the entry is a program that speaks the contract.
`companion` means the entry is a built [Bitfocus Companion](https://bitfocus.io/companion) module, unchanged,
and the hub runs it inside its own bridge (`runtimes/companion.ts`). The bridge looks like Companion to the
module and like an ordinary driver to the hub.

A Companion module describes itself: it tells its host what it calls its variables and its actions. The bridge
passes those on under the `generic` capability, so nobody has to describe a module to the hub before it works:

| The module has  | The hub shows                                             |
| --------------- | --------------------------------------------------------- |
| A variable `x`  | `generic/reading/x`, read-only text, and its title        |
| An action `x`   | `generic/action/x`, a trigger, with its title and options |
| A status        | The driver's health, with the module's own words          |
| A settings form | Settings handed to it at start, over its own defaults     |

`deno task add-module <package.tgz>` adds one. The package is the same file Companion installs.

An action is a **trigger**: something to do, not a value to hold. The hub cannot read a trigger back, so the
log says `command.done`, never `command.confirmed`, and two presses in a row are both sent, in order.

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

## Connections

Every driver the hub runs is a **connection**. Screens never talk to a device or to a driver. They ask the
hub, and the hub decides. Three things have to agree before a request goes anywhere:

1. **The screen's manifest** says what kinds of device it works with. That is a request, not a grant.
2. **A superuser** gives the screen specific connections. A screen that has been given none reaches none.
3. **The person's roles** switch on some of the screen's abilities.

A screen is never more than all three. A screen may ask to work with `any` kind of device, which is how one
screen can show devices nobody wrote a screen for. It still reaches only the connections it was given, and
`any` never includes the hub's log.

The **Controls** screen is that screen: every reading, value and action of its connections as one plain list,
drawn from the definitions the hub hands it. It is for setting equipment up, not for running a service.

## People, roles and abilities

The hub owns one list of people. Every plugin that needs to know who someone is reads that list; none keeps
its own. Signing in belongs to the hub's own pages, so a plugin never sees a PIN or a password.

What a person can do is worked out from four things and is never more than any of them:

|                             | Who sets it                          | Example                                                  |
| --------------------------- | ------------------------------------ | -------------------------------------------------------- |
| What a screen **uses**      | The screen's author, in its manifest | "soundboard: write, log: read"                           |
| The **abilities** it offers | The screen's author                  | "Adjust my own ear mix"                                  |
| The **roles** a person has  | A superuser                          | Musician = see, adjust and history on the ear-mix screen |
| The person's own **slots**  | A superuser                          | Evan's ears are bus 7                                    |

An ability spells out exactly which values it covers, so the hub can enforce it. `input/*/bus/{ears}/level`
means "the sends into this person's own bus": the part in braces is filled from the person. The screen is not
trusted to hold itself to any of this. It is told only about values the person may see, and a request for
anything else is refused and logged with the person's ID.

**Superuser** is the only role the hub is born with. A superuser has every ability of every screen, without
the per-person limit, and manages people, roles and devices. Any person can be made a superuser by another
superuser, and a hub can never be left without one. Every other role is data: a name and a set of abilities,
made on the People page. A screen can suggest starter roles so a new team is not starting from a blank page.

Changes take effect at once. When a person's roles or slots change, or they are signed out or turned off,
their open screens are disconnected and come back under the new rules or not at all.

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
| **A place for plugins to keep data**     | The team roster and saved mixes need somewhere to live. Screens cannot store anything yet                                                                                    |
| **Abilities for skills**                 | A skill would declare abilities the same way a screen does, and an agent would get them through a role                                                                       |
| **HTTPS**                                | Sign-in is unprotected on the network today                                                                                                                                  |

See `docs/decisions.md` for what was decided, tested and left open, and `CONTRIBUTING.md` for how to write
each kind of plugin.

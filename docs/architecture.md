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
and the hub runs it inside its own bridge (`runtimes/companion/`). The bridge looks like Companion to the
module and like an ordinary driver to the hub.

A runtime is a folder in `runtimes/` and a few fields that say how its plugins differ from an ordinary one:
what program runs the entry, whether it may read its own folder, and how to read a package of its kind. The
hub's own code names no runtime, just as it names no kind of device. Whatever a runtime says, the hub writes
the command line, and the permissions on it are only the network a superuser allowed and, at most, the
plugin's own folder to read.

A Companion module describes itself: it tells its host what it calls its variables and its actions. The bridge
passes those on under the `generic` capability, so nobody has to describe a module to the hub before it works:

| The module has  | The hub shows                                             |
| --------------- | --------------------------------------------------------- |
| A variable `x`  | `generic/reading/x`, read-only text, and its title        |
| An action `x`   | `generic/action/x`, a trigger, with its title and options |
| A status        | The driver's health, with the module's own words          |
| A settings form | Settings handed to it at start, over its own defaults     |

A superuser adds one from the admin page, either from the store or from the module's package file (the same
file Companion installs): see what it is, name the device, and decide. The hub then asks the module what
settings it takes and shows them as a form. The same module can be added once for each device.
`deno task add-module <package.tgz>` does the same from a command line.

A device added this way starts with **no access to the network**. When it tries to reach something, the hub
shows a superuser exactly what, in plain words, and it gets only what they allow. It works like a phone asking
before an app uses the camera, and it means a module needs no description written for it in advance.

### What the hub holds for a driver

The rule above is the rule for every driver. A manifest's `permissions.network` is what the driver **asks
for**. What it holds is in the hub's own record of it, one per driver, in the hub's database:

| In the record | Decided by                                                                      |
| ------------- | ------------------------------------------------------------------------------- |
| Mode          | A superuser, with their PIN. Listen until then                                  |
| Settings      | A superuser, in the form the driver describes                                   |
| Granted       | A superuser's answers. The store can answer in advance for what it lists        |
| Denied        | A superuser's "do not ask again"                                                |
| Origin        | Where an added device came from: a file or the store, with its checksum and pin |

A driver is always started from its record. Nothing in a plugin's folder is ever changed by the hub: a folder
says what the plugin is, and the record says what this hub decided about it.

Whoever starts a hub with a plugin folder has chosen that plugin, so the first time the hub sees it, it holds
what its manifest asks for. After that the record stands. A newer version that asks for more is not given it:
the admin page shows the new request beside anything else the driver tried, and a superuser answers.

An action is a **trigger**: something to do, not a value to hold. The hub cannot read a trigger back, so the
log says `command.done`, never `command.confirmed`, and two presses in a row are both sent, in order.

## The hub's own code

| File                 | What it holds                                                              |
| -------------------- | -------------------------------------------------------------------------- |
| `core/hub.ts`        | Puts the parts together and answers the door                               |
| `core/devices.ts`    | The drivers a hub runs, each started from its record                       |
| `core/registry.ts`   | The one record per driver                                                  |
| `core/host.ts`       | One running driver: its state, its writes, its limits, what it asks for    |
| `core/source.ts`     | The one door for anything that holds values: a driver, or the hub's device |
| `core/hub_device.ts` | The hub's own device: tags, and how each driver is doing                   |
| `core/process.ts`    | The command line a driver runs under, and the one door it connects through |
| `core/runtimes.ts`   | What a runtime may say about its plugins                                   |
| `core/packages.ts`   | Reading and unpacking a package. Runs none of it                           |
| `core/screens.ts`    | Screens, who may use each, and the phones connected through them           |
| `core/admin.ts`      | A superuser's tools                                                        |
| `core/accounts.ts`   | People, roles and signing in                                               |
| `core/store.ts`      | Reading the store's list and checking what it downloads                    |
| `core/web/`          | The hub's own pages, as ordinary HTML, CSS and JavaScript files            |
| `mod.ts`             | The only file a tool outside this repository may import                    |

The hub's own pages load their scripts from `core/web/` and run nothing else: a script written into a page
does not run, whoever wrote it there. A page is read from its file each time it is asked for, so a change
shows on the next reload.

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
with people as IDs. Undo, audit, habits, reports and anything an agent does later all read from it. It says
who changed what, from what to what, and when. It does not hold every position a value passed through: a fader
being moved is written as its first step and where it came to rest.

## Connections

Every driver the hub runs is a **connection**. Screens never talk to a device or to a driver. They ask the
hub, and the hub decides. Three things have to agree before a request goes anywhere:

1. **The screen's manifest** says what kinds of device it works with. That is a request, not a grant.
2. **A superuser** gives the screen specific connections. A screen that has been given none reaches none.
3. **The person's roles** switch on some of the screen's abilities.

A screen is never more than all three. A screen may ask to work with `any` kind of device, which is how one
screen can show devices nobody wrote a screen for. It still reaches only the connections it was given, and
`any` never includes the hub's log.

### The hub's own device

Some values belong to no driver: a flag that says the service is live, which part of the show is running,
whether the console is still connected. The hub holds these itself, as a connection called **Hub** with the id
`hub`. It is given to a screen like any other connection and limited by roles in the same way.

| Kind     | Values                                                                                  | Set by                       |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| `tag`    | `tag/flag/<name>`, `tag/number/<name>`, `tag/text/<name>`, `tag/choice/<name>`          | Anyone a role allows         |
| `device` | `device/connected/<id>` (true or false) and `device/status/<id>` (one word), per driver | Nobody. The hub works it out |

A superuser makes tags under **Settings**. A tag keeps its value across a restart. A choice takes only the
options it was given, so a misspelled value is refused instead of quietly never matching. The tags are also
written to `config/tags.json` for people and agents to read. That file is not read back.

A driver's host and the hub's device are both a `Source` (`core/source.ts`): the same `state`, `set` and
`onChange`. Screens and the agent are written against that, so neither knows which one it is talking to. Every
change a source reports carries its **cause** when the hub knows it: who asked, through what, under which
trace, and how many reactions deep. A change with no cause happened at the device itself.

The **Controls** screen is the screen that works with `any` kind of device: every reading, value and action of
its connections as one plain list, drawn from the definitions the hub hands it. It is for setting equipment
up, not for running a service.

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

## Automations

An automation is a rule the hub runs by itself: **when** something happens, **if** conditions hold, **do** a
list of steps. A rule is one JSON document. It is data the hub checks word by word before it runs any of it,
and it is never a program.

```json
{
  "kind": "automation",
  "name": "Go live when the music starts",
  "group": "sound",
  "when": [{ "key": "tag/choice/phase", "becomes": "music" }],
  "if": { "key": "tag/flag/service-live", "is": false },
  "do": [
    { "key": "tag/flag/service-live", "value": true },
    { "wait": 2 },
    { "key": "console/input/3/bus/1/level", "add": 2, "max": 0 }
  ]
}
```

| Part    | What it can say                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `when`  | Up to 8 triggers: `rises_past`, `falls_past` (with `within`), `becomes`, `changes`, or `holds` a condition, optionally `for` some seconds. With none, the rule runs only when it is run |
| `if`    | Compares (`is`, `is_not`, `>`, `>=`, `<`, `<=`, `between`) joined by `all`, `any` and `not`. Any part can say `for`                                                                     |
| `do`    | Up to 32 steps: set a `value`, copy `from` another value, `add`, `multiply`, with `min` and `max`, or `wait`                                                                            |
| `mode`  | What a new firing does while it is running: `single` ignores it, `restart` starts over, `queue` runs it after                                                                           |
| `group` | Rules of one group are paused together                                                                                                                                                  |

How a rule comes to run:

1. **It is proposed.** A person or an agent writes `config/automations/<id>.json`. A file is a proposal and
   runs nothing.
2. **It is checked.** Every value it names is looked up. A device the hub does not have, a value that cannot
   be set, a word a choice cannot be: each is refused with the reason. What comes out is the rule as a
   sentence and its reach, every value it reads and every value it can set, worked out from the text alone.
3. **A superuser approves that exact text.** The approval names the text by its hash, so a yes cannot be spent
   on a file that has since changed. The hub runs rules from its database, never from the file.
4. **It is turned on,** or put in **Test**, where it watches the real hub and logs what it would have sent.

What keeps it safe:

- **Unknown means no.** A value is unknown when its device is not connected or has never reported it. A
  trigger fires only on false to true, so starting the hub, turning a rule on, or a device coming back fires
  nothing.
- **A rule acts through the same door as a person,** under its own name, `automation/<id>`. Every write is in
  the log on the trace of what set it off.
- **Chains end.** Every change carries how many reactions deep it is. Past 8, the rule is stopped.
- **A rule that runs more than 10 times in 10 seconds is stopped** until a person turns it back on.
- **Pause all** stops every rule, and one in the middle of its steps stops there. A group's pause stops that
  group.

Rules are values too. The hub's device offers `automation/run/<id>`, `automation/enabled/<id>`,
`automation/active/<id>`, `automation/paused` and `automation/paused/<group>`, so a canvas button can run a
rule and a canvas switch can pause a group. Running a rule that does not run says why.

The code is in `core/automations/`: `format.ts` (what a rule may say), `compile.ts` (settling names and
working out reach), `evaluate.ts` (true, false, unknown), `engine.ts` (running them), `store.ts` (proposals
and approvals) and `words.ts` (a rule as a sentence).

The agent has tools for rules (`core/agent_rules.ts`): list and read the ones in reach, read how a rule is
written, try a draft against how the hub stands right now, and ask for one to be proposed. A proposal needs
the person's yes to be written down and a superuser's approval to run. A rule may be proposed only if both the
agent and the person asking could do each of its steps by hand.

Still to come: schedules, fades, and the `while` and `follow` forms.

## What is deliberately not here

- **A general app builder.** Screens are written, not assembled.
- **Plugins talking to each other.** They talk to the hub.
- **Code in capabilities or skills.** Data and text only.
- **A second way in.** There is no private path for "trusted" plugins. The simulated board in this repository
  gets the same sandbox as anything else.

## Planned, not built

| Piece                                    | What it would be                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Service**                              | A background program that uses capabilities the way a screen does: automation, scheduling, an agent's own process. Same `uses` rule, same driver-style sandbox                                                      |
| **An agent from outside**                | The hub has an agent of its own, which looks and answers (`core/engine.ts`). Still planned: a way in for an agent that runs somewhere else, such as an MCP server, held to an account and its roles in the same way |
| **Install, update, rollback, uninstall** | Today plugins are folders the hub scans at start                                                                                                                                                                    |
| **A place for plugins to keep data**     | The team roster and saved mixes need somewhere to live. Screens cannot store anything yet                                                                                                                           |
| **Abilities for skills**                 | A skill would declare abilities the same way a screen does, and an agent would get them through a role                                                                                                              |
| **HTTPS**                                | Sign-in is unprotected on the network today                                                                                                                                                                         |

See `docs/decisions.md` for what was decided, tested and left open, and `CONTRIBUTING.md` for how to write
each kind of plugin.

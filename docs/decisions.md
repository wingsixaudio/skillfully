# Decisions and open items

## Decided in this slice

**Deno runs the hub and its plugins.** The deciding test was whether a runtime can hold a plugin to its
declared permissions. Deno refuses, by default, every file read and write, environment read, subprocess,
outbound connection, listener, system query and native library, and grants only the addresses on the command
line. Node 22, the version tested, has a permission system for files and subprocesses but nothing for the
network, so a plugin could reach any address. The evidence is `tests/isolation_test.ts`.

**Plugins and phones use different ports.** Phones connect on a public port. Plugins connect on a second port
bound to this computer only, and a plugin's permission covers that port alone. A plugin therefore cannot pose
as a phone or read the log over HTTP.

**A one-time token ties a process to its manifest.** The hub gives each process a token at start. A hello
without it, or with an identity that differs from the manifest, is refused.

**The log records one entry per value, not per message.** A drag of 200 moves may need only a dozen commands.
It is logged as a dozen sent and a dozen confirmed entries, and each sent entry carries a count of the moves
it replaced. Every move is accounted for without 200 rows.

**People are IDs in the log.** Entries carry `person:p1`, never a name, so the log can be scrubbed or shared
later without rewriting it.

**A plugin's imports are checked before it runs.** Deno loads a program's imports without asking for file
permission, so a plugin could read any JSON or code file on the computer by importing it. The hub now lists a
plugin's imports first and refuses the plugin if any resolve outside its own folder or the hub's `sdk/`,
following links to where they really point. Found by testing, after the first version shipped without it.

**Memory, processor and message limits are enforced by the hub watching, not by the operating system.** Deno's
own memory flag covers the script heap only; a plugin held 600 MB in buffers under a 32 MB cap. The hub now
reads each plugin's real memory and processor time four times a second and stops one that is over. This is a
soft limit: a plugin can overshoot for up to a quarter of a second. On Linux a hard limit is possible
(`prlimit --data` stopped the same test), but it needs a floor of several hundred megabytes for Deno itself,
so it was left out for now.

**Three strikes, then held.** A plugin stopped for a limit three times in ten minutes is not restarted until a
person releases it. The release is logged with who did it.

**A plugin has a log budget.** Entries a plugin causes directly (events, bad messages, health changes, changes
at the device) are limited to 100 at once and 20 a second. Past that the hub writes one entry saying how many
were left out. Entries for commands the hub sent are not limited, because the hub already limits those.

**One log entry per board-side message.** A scene recall that moves 1,500 values is one entry holding all of
them.

**The hub names no capability.** A capability is a definition file. Drivers are checked against it, screens
are scoped by it, and the conformance test reads it. The first version had the soundboard written into the hub
and the contract; that was a sound hub with plugins, not a plugin hub.

**Keys carry their capability.** A value is named `console/input/3/bus/5/level`, so a driver with two
capabilities needs no extra bookkeeping and the hub can scope a screen by looking at the first part of the
key.

**A screen is a real web page in a sandbox, not a description drawn from fixed components.** This lets any web
developer contribute with any tools, and keeps the ear-mix gestures possible. The sandbox pays for it: the
page is served with a policy that gives it no origin and no network, it is framed by the hub's own page, and
the hub refuses any browser connection that is not from its own page. Screens described as data can be added
later as one more screen. The evidence is `tests/browser/screen_sandbox.py`, run in Chrome.

**A screen never says who the person is.** The hub's shell page does. A screen that tries is ignored.

**Skills are listed, never run.** A skill is a folder in the Agent Skills format with a manifest. The hub
checks its shape and puts it in the catalog.

**The conformance test is generic.** It is written against capability definitions, so a driver for a kind of
device nobody has thought of yet can be proven without new test code.

**The hub owns people and sign-in.** One list of people, read by every plugin and kept by none. Signing in
belongs to the hub's own pages; a plugin never sees a PIN, a password or a session. PINs and passwords are
stored through scrypt, sessions and invitations as hashes, so nothing in the database can be read back or
replayed.

**A new hub is claimed with a code shown only where it runs.** Whoever enters it becomes the first superuser.
The code is not in the log and stops working once used.

**The team chooses PIN or password.** A superuser sets the kind and the shortest length, and may hold
superusers to a stricter rule. Easy PINs (one digit repeated, a run) are refused. Five wrong tries start a
wait that doubles up to 15 minutes. A wrong PIN and an unknown name get the same answer.

**People join by invitation.** A superuser adds a name and hands over a one-time code. The person chooses
their own PIN or password, and that device is remembered until someone revokes it. A superuser can reset a
sign-in to a temporary one that must be changed at next use; the log records who reset whom and never the
secret.

**Superuser is the only built-in role, and a hub always has one.** Any person can be made a superuser by
another. The last one cannot be demoted, turned off or removed. Handing out roles, changing the sign-in rule,
resetting someone's sign-in and taking a device out of Listen each ask for the superuser's own PIN again.

**Every other role is data.** Plugins declare abilities; a role is a name and a set of them. An ability lists
the capabilities and values it covers, so the hub enforces it without knowing what the screen is for.

**Abilities can be limited to a person's own values.** A key such as `input/*/bus/{ears}/level` is filled from
the person's slots, set by a superuser. The hub filters what a screen is told and refuses what it may not set.
A screen is never trusted to hide or disable anything.

**A superuser gets everything a screen uses, and nothing beyond it.** Even a superuser cannot make a screen do
what its manifest did not declare.

**Access changes at once.** Changing a person's roles or slots, signing them out, or turning them off closes
their open connections.

**The hub's own API is for its own pages.** Requests must be JSON from the hub's own origin, the session
cookie is hidden from scripts and never sent from other sites, and screens, which have no origin, cannot call
it at all.

**A Companion module runs unchanged, inside the same sandbox as any driver.** The bridge and the module share
one process with the permissions on its command line: the network a superuser allowed and read access to its
own folder. No write, no environment, no subprocess. The module is shown an empty environment and its messages
to "Companion" are answered by the bridge. A test module tries all of it and is refused each time. Where
Companion would give a module the whole network, this hub makes the grant visible.

**Two wide network grants exist, and both are named.** `lan` is any private address plus the addresses devices
use to find each other, and never the internet or the hub's own computer. `listen` is ports on the hub's
computer for devices to answer on. A device added from the admin page is given neither by default: it asks for
the exact addresses it uses. The checker and the pull request report spell both out in words.

**What a module names is kept as it named it.** Keys may now carry capitals, underscores and dots in the parts
a driver chooses, because module authors already use them and renaming would make two names collide.

**A manifest asks. The hub's record grants.** There used to be two rules: a device added from the admin page
asked before reaching anything, and a driver in the plugins folder was simply given what its manifest listed.
And when a superuser allowed something, the hub rewrote the device's own `plugin.json`. Now there is one rule
and one place. Every driver is started from the hub's record of it, the manifest is only ever a request, and
the hub never writes to a plugin's folder. A plugin the hub is started with holds what it asks for the first
time it is seen, because whoever started the hub chose it. A later version that asks for more waits for an
answer, so an update cannot widen its own reach.

**One record per driver, in the hub's database.** Mode, settings, what it may reach, what it was refused and
where it came from were spread over a file beside the plugin, the plugin's manifest, and a list in the code
that put the simulators in Act. They are one record now, and the mode a superuser chooses is kept for every
driver. The simulators are put in Act by the `hub` task's `--act` flag, which only applies the first time a
hub sees a driver.

**Runtimes are named, not built in.** The hub's core had four files that asked whether a driver was a
Companion module. A runtime now says in a few fields how its plugins differ, and lives with its bridge and its
package reader under `runtimes/`. The contract takes a runtime name instead of a fixed list, and a hub refuses
a plugin that names one it does not have. A runtime cannot widen the sandbox: the hub still writes the command
line.

**The hub's own pages are files, and run only the hub's own scripts.** The admin page was nine hundred lines
of JavaScript inside a string, which nobody could lint, format or read comfortably. The pages are ordinary
files in `core/web/` now, and their policy no longer allows a script written into a page to run at all.

**A screen is given its address only once its frame is listening.** A screen says "ready" once, and the frame
opens its connection when it hears that. When the frame's script became a file of its own, a screen could
finish loading first and say "ready" to nobody, and then sat on "Connecting" for good. The frame's script now
hands the screen its address after it has started listening, so the order cannot go wrong, and a browser check
holds each side back in turn to prove it.

**One file for outside tools.** The plugin store checks and builds packages with the platform's own code, so
the two can never disagree. It used to import five internal files by path. `mod.ts` is now the whole of what a
tool outside this repository may import, and everything behind it can be rearranged freely.

**Only a signed list can answer for a superuser.** The store signs the exact bytes of its list, and a hub that
has the store's public key reads nothing from a list that was not signed with it: not unsigned, not signed by
someone else, not changed afterwards. Every package's checksum is in the list, so the signature covers the
packages too. A hub with no key for a store still reads its list, as nobody's word: a device can be added from
it, because the sandbox does not depend on trusting the list, but nothing is allowed in advance and no
recommendation to allow anything is passed on. A signature file can carry two signatures, so a key can be
replaced without a day on which hubs with the old key or the new one are locked out.

**The store advises; it does not decide.** Besides "allow this in advance", a store entry can say "we expect
this" or "we advise against this" about a kind of place or one address, with a reason, and the store can say
the same about everything it lists. A hub shows that beside the question when a device asks. Advice about the
exact address comes before advice about the kind of place, and an entry's own advice before the store's
general advice. "We expect this" starts the box ticked and "we advise against" starts it unticked. Either way
the superuser confirms with their own PIN, and nothing is allowed by advice alone.

**A signed list says when it was made, and a hub does not go backwards.** A hub remembers the date of the
newest signed list it has read, across restarts, and refuses one made before it. Without that, someone who
could change what the store's address serves could hand out last month's list with last month's real
signature, and bring back whatever it allowed.

**An update replaces the package and nothing else.** A device from the store is offered the version the store
lists now. Taking it asks for the superuser's PIN. The device keeps its id, its name, its settings, its mode,
the screens it was given to, and everything allowed or refused; it gains only what a signed list now allows in
advance, and that is said before the PIN is asked for. The new version is unpacked and checked beside the
running one first, so a version this hub cannot run never stops a device that works.

**A package is its source at one commit, built one way.** A hub used to decide that the store had another
version by comparing the bytes of the package. Builds do not come out byte for byte the same twice, so a store
that only built the same thing again looked like an update to every hub. A hub now compares the source commit
and the store's recipe number, which says which way of building made the package. The same commit built the
same way is the same package for good. A higher recipe for the same commit is offered, and said for what it
is: the same module, packaged again.

**A signed list may say where its packages are kept.** Packages used to have to sit beside the list. A list
the store signed may now name any https address for one, and the hub may be passed on from there to where the
file really is. What arrives is held to the checksum in the signed list either way, so it does not matter
whose computer handed it over. A list nobody signed still cannot send a hub anywhere but beside itself.

**The shelf is searched, not sent.** The store's list can run to thousands. The hub answers the admin page
with thirty at a time and finds the rest by the words typed, against a thing's name, what it does and who
makes it.

**A dropped-in module starts in Listen mode.** It connects and reports, and the hub sends it nothing until
someone decides it may act.

**Modules come from a file a person supplies, not from a catalog.** The hub does not call Bitfocus's store or
copy their list. A team downloads a module's package and adds it. A list of reviewed modules, each pinned to
its source and to the narrow permissions it needs, is the next layer and is not built.

**A screen reaches only the connections a superuser gives it.** A screen's manifest says what kinds of device
it works with; a superuser then chooses the exact drivers, confirming with their own PIN or password. Nothing
is given by default, so a new hub's screens reach nothing until someone decides. Changing the choice closes
that screen's open connections so they start again under it. The decision is in the log with who made it.

**A screen may ask for any kind of device, and the request is loud.** `any` in `uses` and in an ability stands
for every kind of device on the connections the screen is given. The checker and the pull request report spell
it out. It never covers the log, and no capability may be named `any` or `log`.

**A screen is handed the definitions of what it can see.** With them a screen can draw a value it was never
written for: a switch, a number with its range, an action with its options.

**A new owner lands where the setting up is.** A superuser with no screen that has anything to show is sent to
the admin page. Everyone else lands on their role's home screen.

**Adding a device is two steps: look, then decide.** Choosing a package sends it to the hub, which checks it
and answers with what it is and what each choice of reach would let it do. Nothing is written until the
superuser confirms with their own PIN or password. A device added this way arrives listening, lives in the
hub's data folder, and comes back after a restart with the mode and settings it was left in.

**A driver can say what settings it takes.** The contract has a `settings` message for drivers that only know
once they are running. The Companion bridge fills it from the module's own form. The words in it are shown as
text and nothing else is done with them.

**A secret setting goes one way.** It is kept and handed to the module. The admin page is told only that it is
set, a blank field means "keep it", and the log records which settings changed, never their values.

**Changing a device's settings restarts it.** What a driver may reach can depend on its settings, and its
permissions are fixed when its process starts.

**The store is its own repository on GitHub.** Plugins arrive at
[skillfully-plugins](https://github.com/wingsixaudio/skillfully-plugins) by pull request and are checked there
by this repository's own code. People who merge plugins cannot change the hub that confines them. A Companion
module is an entry pointing at a pinned commit of its author's source; the store builds it, completes its
license notices, and publishes the package with a checksum.

**A hub trusts the store for one thing: answers given in advance.** It reads the published list, downloads the
package a superuser picks, and throws it away unless it matches the list's checksum. What the entry allows in
advance becomes the device's starting permission. Everything else is still asked. Being in the store does not
take a device out of Listen, and does not skip the superuser's PIN.

**A grant can wait on a setting.** `{host}:9999` means the address a superuser types in. A Companion module
can only say what settings it takes once it is running, so it starts with such a grant giving nothing, and
gets it when the setting is filled in.

**Everything in the store's list is treated as data.** An entry whose package would be fetched from anywhere
but beside the list, whose grants are not ones the contract knows, or whose source is not a pinned commit is
left out, not repaired.

**A device a superuser adds asks before it reaches anything.** It starts with no access to the network. The
runtime keeps an exact note of everything a plugin uses or is refused, in a file the plugin cannot read. The
hub reads it and turns each refused address into a question in plain words: reach this device, open ports on
this computer, send to everything on the network, reach the internet. A superuser ticks what makes sense and
confirms with their own PIN or password, and the device restarts holding exactly that. Only the ordinary case,
one device on the local network, is ticked for them. A no can be remembered, and anything allowed can be taken
away. Nobody has to describe a module to the hub before it can be used safely.

**What the hub never allows is noted, not asked.** Reading files outside its folder, writing, the environment,
starting programs: these are counted and shown beside the device, and there is no way to say yes to them.

**A reviewed list is advice on top, not a gate.** The store's entries are answers given in advance: allow this
without asking. A module needs no entry to be used.

**Every change arrives as a pull request.** `main` is protected: no direct pushes, no force pushes, no
deleting it, and nothing merges until the `checks` job passes. This applies to maintainers too. The first six
commits were pushed straight to `main` before the rule existed.

**The checks run where the author has no say.** Every pull request is tested on Linux and macOS, driven
through a real browser in Chrome and WebKit, and summarized in plain words: what each changed plugin asks for,
and what it asks for that it did not before. They run with no secrets and a token that can only read, which is
what makes it safe to run them on a pull request from a stranger. A nightly run repeats the suite five times
on each system, because a test that fails one time in twenty is found by repetition and by nothing else.

**The admin is five places, each at its own address.** Home says whether everything is working and lists what
is waiting on a superuser, with the answer beside it. Devices, Screens, People and Hub hold what their names
say, and each device has an address of its own. One page draws all of them and moves between them without
loading again, so nothing a person was in the middle of is lost. On a phone the places run along the bottom,
where a thumb is; on a wide screen, down the side. Nothing was taken away: every control on the old single
page is in one of the five.

**One confirmation holds for five minutes, for one session.** A change that hands out power used to ask for
the superuser's own PIN or password every time, which in one evening of setting up was a dozen times. Now it
is asked once, the hub remembers it for that one browser for five minutes, and the page says so with a way to
lock again at once. It is kept in memory only, so a restart locks everything. It belongs to the session and
not the person: the same superuser on another device is still locked. A secret that is sent with a change is
still checked, so a wrong one is refused even while unlocked. Each unlock and lock is in the log. What this
gives up: someone who picks up a signed-in, just-unlocked laptop has up to five minutes.

**What the hub decides is also kept as text.** Each device has a JSON file under `config/devices/` in the data
folder, in one stable form (keys in order, two spaces), checked against a schema that is published with the
contract. The database is still the one place the hub acts from; the file is how a person or an agent reads a
decision, compares two versions of it, and proposes a change. Three rules hold for every file: a key that is
left out means "leave that as it is", so half a file can never take something away; no secret is written, and
a setting is written only once the device has said which of its settings are secrets; and a file is data,
checked and never followed. This follows Ignition 8.3, which moved its gateway configuration from an internal
database to readable files.

**A file edit is a proposal.** The hub says what an edited file would change, in words, and marks each change
as one that hands out power or one that does not. Letting people control a device and letting a device reach
something are power. Taking either away is not, and neither is a setting, because a device pointed somewhere
new still has to ask before it reaches it. When the hub itself changes a device, it rewrites only the part of
the file it changed, so an edit somebody is in the middle of is not lost. JSON was chosen over a format with
comments because the hub already checks JSON against schemas; every file takes a `note` instead.

**Applying is a superuser's act, and power needs a yes by name.** Nothing in a file takes effect until a
superuser who has just confirmed who they are applies it, from the Hub place. Changes that hand out nothing
are then made. A change that hands out power is made only when its exact key was said yes to: the key names
the device, the kind of change and the thing given, so a yes cannot be spent on a file that changed after it
was read. One file that cannot be read stops everything, so a hub never holds half of what somebody meant.
Every change goes through the same door the admin page uses, so the same checks run and the same lines are
logged, marked as coming from the config folder. What may be allowed from a file has the same shape a driver's
manifest asks in: an address and a port, `lan` or `listen`, and nothing else.

**Strict or trusting is a switch the files cannot reach.** A hub starts strict. A superuser can make it
trusting, where applying does everything the files say, either for an hour, after which it is strict again by
itself, or always. The choice is kept in the hub's database and each change to it is logged. It is not in any
file, because a file that could turn it could approve itself. The hour exists because a hub left trusting by
accident is the mistake most worth preventing.

## Open, and worth deciding before the next stage

- **Plugin dependencies.** Plugins run with no access to the internet or npm at start. The in-repo plugins
  import the SDK by relative path. A real install step must copy a plugin's dependencies into place first.
  This is also where Companion modules, which are written for Node, need testing.
- **UDP.** A WING driver using OSC needs to send and listen on UDP. Deno gates this with the same network
  permission, including the local address it binds, so the manifest format may need a way to declare a
  listening port.
- **Hard limits.** Memory and processor limits are soft (see above). Whether to add operating-system limits on
  Linux, and what to do on Windows, where neither is read yet.
- **A very large single message.** The hub drops a message over 8 MB, but only after receiving all of it.
- **The hub itself.** Nothing restarts the hub if it stops. That belongs to how it is installed (a system
  service).
- **Log retention.** The log grows forever. No rule yet for how long to keep what.
- **HTTPS.** Sign-in crosses the network unprotected, and phones hold back their best features (a proper
  install, keeping the screen awake) from pages that are not served securely. The domain `skillfully.live` is
  registered, which makes one option possible: each hub gets a name under it with a real certificate.
- **The storage interface.** The log and the people list share one SQLite file on the hub's own disk. Pointing
  a hub at a database on the network, or copying between two hubs, needs storage behind one interface first.
- **A place for plugins to keep data.** The team roster and saved mixes need it. Nothing a screen does today
  outlives the page.
- **A ceiling on what others can do to your ears.** A superuser can raise a send into anyone's bus without
  limit. Hearing safety needs a cap and a ramp that apply to everyone but the bus's owner, and a limiter at
  the board itself.
- **The People page is part of the hub, not a plugin.** That keeps PINs and the power to grant roles away from
  plugin code. Whether a plugin should ever be able to ask for people to be added or granted, with a superuser
  approving, is undecided.
- **Slots are flat.** A person has one `ears`. A team with two boards, or a person with two mixes, needs slots
  that say which device they belong to.
- **Sign-in tries are counted per person and per network address.** Behind a shared address, one person's
  mistakes could make others wait.
- **Capabilities from outside this repository.** Definitions live in `capabilities/`. There is no rule yet for
  a plugin that brings its own, or for naming them so two authors do not collide.
- **Browser coverage.** The screen sandbox was proven in Chrome only. Safari on a phone matters most and has
  not been run.
- **Record and replay.** The spec calls for recording plugin traffic and replaying it as tests. Not built.
- **The store's key has one keeper.** The private half is a secret of the store repository's publishing
  environment, made on its owner's computer. Nobody else can sign a list, and if it is lost a new key has to
  reach every hub through a new version of the hub.
- **Advice is about where, not what.** The store can advise on a kind of place or one address. It cannot yet
  say "this action is the dangerous one".
- **Updating is one device at a time, by hand.** A hub notices a newer version and offers it. Nothing updates
  by itself, and a device added from a file has no update except adding it again.
- **A version cannot be gone back to.** The hub keeps no copy of the version it replaced. If the store lists
  an older one again, that can be taken; otherwise the newer one stays.
- **The first real download has not happened.** The tests use a stand-in store on the same computer.
- **A question an admin cannot judge.** "Send to every device on your network, port 9999" is worded plainly
  and carries a warning, but someone still has to decide. The reviewed list is what will answer it for them.
- **Several rounds.** A device may ask, restart, get further, and ask again. Each round is a restart.
- **Starting another program shows up as reading the environment.** The runtime stops it one step earlier than
  the attempt itself, so that is what is noted.
- **Updating a device's module.** A newer package can only be added as a new device. There is no update that
  keeps the settings, and no way back to the version before.
- **Secrets on disk.** A device's settings, secrets included, are kept as plain text in the hub's data folder.
  They are out of the log and off the page, and they are not encrypted at rest.
- **Parts of a module's settings form.** A setting that picks several things at once is not shown, and a
  module's rule for when to show a setting is ignored: every setting is always shown.
- **An agent that guides a contributor.** Checking a plugin, proving a driver, reporting what it asks for and
  adding it are each one command. A skill that chains them, from an idea to a pull request on the store, is
  the intended way in for someone who has never contributed.
- **Roles cannot name a connection.** A person allowed to operate Controls can operate every connection
  Controls was given. An ability can be limited to certain values, but not to one device among several of the
  same kind.
- **Controls shows the first 150 values of a connection.** A soundboard has thousands. The search box narrows
  them, and that is all the organizing there is.
- **Automations.** "When this reading becomes that, do this action" needs something that watches and acts with
  nobody at a screen. It would be a new kind of plugin with its own approved connections. Not designed yet.
- **Packages of several plugins.** A screen and the driver it was written for cannot ship as one thing yet.
- **Newer Companion modules.** The bridge runs modules built on `@companion-module/base` 1.x. Modules built on
  2.x load differently and are refused at install with a plain reason.
- **What Companion does on a module's behalf.** Sending OSC and sharing a UDP port are asked of the host, not
  done by the module. The bridge refuses both and records that the module asked.
- **A module's stored settings.** Companion keeps a module's settings and upgrades them between versions. The
  hub hands settings over fresh at each start, so a module's upgrade scripts never run.
- **License.** Not chosen.

## Not tested

- Any real soundboard. Everything here runs against the simulated board.
- Windows, on a real machine. The tests pass on Linux, macOS and Windows on GitHub's machines, and the
  real-browser test passes in Chrome and WebKit there. On Windows the hub cannot yet read a plugin's memory or
  processor use, so those limits are not enforced and their tests are skipped. Windows does not yet block a
  merge.
- Safari on a real phone. WebKit on Linux is the same engine, not the same browser.
- More than two Companion modules. A module written for the tests runs in every check, and the real TP-Link
  Kasa module is built from its source and run against a pretend plug in a check that reports and does not
  block. No module has driven real equipment through the hub.
- More than a handful of phones at once.
- Meters. The contract has no message for them yet.

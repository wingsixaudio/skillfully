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

**A module is told no in a way it can take.** Modules are written for a place where they may run programs and
ask the computer about itself, and the libraries they use do both without a second thought: to learn a
device's network card, or to tell a device who is calling. The sandbox refuses all of it, and that does not
change. But it refused in the middle of the attempt, in words about something else, where no module could
catch it, and a module that only wanted to be polite to a television stopped working. So the bridge answers
first, for every module alike. Running a program fails the way it does on a computer that lacks the program,
with an error handed to the module where it expects one, and the program's name, never what was passed to it,
is noted once. Questions about the computer get the same plain answers on every hub. Whether a file outside
the module's folder is there is answered no. A refusal that still gets through is said in words about what the
module tried, and the device is called less than it could be, not down: the module is still running.

**A driver can ask the hub to keep something for it, and nothing else can read it.** A driver stores nothing:
it cannot write a file, and that does not change. But a device that is paired hands over something to show
next time, and a driver that forgot it would have to be paired again after every restart, which is every time
someone saves its settings. So a driver may send the hub one thing to keep, and is handed it back when it next
starts. It is kept apart from the device's record, because the record is shown on pages, written to the
device's file and told to anything listening, and this is where a pairing lives. The log says that something
was kept and how large, never what. It goes when the device is removed.

**A driver may fill in its own settings, and not the ones that decide what it reaches.** A module that pairs
ticks its own Paired box and fills in the network card it found, and Companion shows that in the form. If the
hub did not, the form would say Unpaired about a paired device, and saving it would unpair it. So a driver may
fill in settings from its own form, held to what a person could type there. Two things a person may do and a
driver may not: fill in a secret, and change a setting that a network grant is written in terms of. A driver
that could move its own `host` would be granting itself the network. The log says which settings a driver
filled in, as it does for a person, and which it was refused.

**For a Companion module, both are what `saveConfig` becomes.** A module saves its whole settings as one
thing. The bridge keeps all of it for the module, and fills in the form with the parts a person could have
typed. When the module starts, the form's settings are the hub's and everything else is what the module kept.
What a module saves as it starts, before it has been told anything, is only its defaults, and replaces
nothing.

**An action is taken as begun, not waited on.** A press waited for the module to finish the action, and gave
up after a second and a half. An action that pairs does not finish until someone has typed a code, so pressing
it looked like a failure while it was working. Companion does not wait on an action. After that second and a
half a press is now answered as begun, and an action that fails later is noted in the log.

**A slider can do an action that takes a number.** Many devices take a volume or a level as an action with a
number in it, not as a value that can be set. A slider could only set a value, so the agent, asked for a
volume slider on a television, had to say it could not. A slider can now name the action's option its number
goes in. It does the action once, when it is let go: doing it at every step of a drag would be the device told
to do something thirty times a second. Where it rests comes from a reading it is pointed at, usually the
device's own report of what the action sets, and a number reported as words is still a number.

**Canvas has a piece for each thing a team keeps building by hand.** An agent asked for a remote, a status
board or a run sheet reached for buttons with lights to make a choice of input, a readout to show a level, and
had nothing for a countdown or for going between pages. Six pieces were added, each one small and each written
the way the others are, so an agent learns them from the same guide: a stepper (down and up by a step), a
choice (one of a few, the one in use lit), a meter (a number as a bar), a light (on air, recording), a
countdown to a time of day, and a goto button for the pages of a canvas. A stepper and a choice can do an
action, as a slider can. A countdown is the same on every phone, because it counts to a time of day and not
from when someone pressed it. The options of a choice and where a goto button goes are written by the agent or
in the canvas's file: Arrange shows them and can move, resize or remove the piece, and has no list editor.

**A canvas uses the room a wide screen has.** Canvases are drawn for a phone, a few columns of thumb-sized
pieces. On a computer's screen that was a narrow strip down the middle. A canvas is now drawn larger to fill
the room there is, everything on it together, up to one and three quarters its size, so its proportions are
the ones it was drawn with. It is never made smaller than it was drawn.

**A device that cannot be reached says why.** A module that cannot reach its device usually says only "check
the address". The reason is an error its library prints, which nothing kept, so a person had nowhere to read
it and could only guess. An error a module prints is now put beside what the module says is wrong, and noted
in the log: the kind of error and its message, and nothing else, because what a module prints as plain words
could be anything.

**A secure connection hands a module one message at a time, as where modules were written to run.** Where
modules were written to run, each record arriving on a secure connection is one "data" event. Libraries lean
on that without knowing it and take each event for one whole message. This runtime hands over whatever is
waiting joined together. A television that says four short things as a remote arrives was heard as one broken
message, nothing after it was understood, the television's "are you there" went unanswered, and it hung up:
paired, working, and gone ten seconds after the last press. The bridge now makes a module's secure connections
over a stream of its own that gives the secure layer one record at a time. This is the third place a module
met a runtime that is not the one it was written for, after files and programs. It is evidence for the
question still open: whether Companion modules should run on the runtime they were written for.

**A module's own rules for its settings are held to, in the module's process.** A module can say how a setting
must be written, as a pattern. The hub's form ignored that, so an address typed wrongly reached the module and
failed in the module's words or none. The pattern is the module's code, and a pattern can be written to take
for ever, so it is never run in the hub or sent to a page. The bridge tries it beside the module. A setting
that does not fit is not handed over, and the device says which one until it is put right. The box Companion
fills in by searching the network is not shown, because the hub does not search.

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

**The catalog is a page, and Bitfocus Companion modules are a section of it.** "Add a device" opens the
catalog at its own address. It is searched first: one box that looks through names, makers, products and
kinds. Below it are two sections. What was written for this hub is short and shown whole. Bitfocus Companion
modules are many, so that section is browsed by maker, in order, with a count beside each, and by kind once
the store files entries under kinds. The section credits Bitfocus and says what running a module here means.
The hub never sends the whole list to the page: it sends a page of entries and the counts. Until the store's
list names a maker for each entry, the hub works the name out from the entry's id and what it says it makes.
Choosing an entry opens the same few questions as before, and adding ends at the new device's own address.

**A device has a page, not a card and five dialogs.** At a device's own address everything about it is on one
page, top to bottom in the order the work happens: whether it is connected, its settings, what it may reach,
whether people can control it, which screens use it, and where it came from. Nothing waits on anything else.
Settings are filled in on the page. What it asks to reach is answered on the page, with the store's advice
beside each request. Updating and removing still ask in a dialog, because each is one question that deserves
to be read alone. The page keeps itself current every few seconds, part by part, and never draws over a part
somebody is typing in or has ticked. Something that hands out power is done at once while the superuser's
confirmation holds, and otherwise asks for it once. The admin now says "People can control it" and "watched
only" where it said Act and Listen. The contract, the log and the code keep their words.

**A device can be tried from its own page.** The page shows a few of what the device reports, as it changes,
and its plain "do this" actions. A large device has hundreds, so the page asks the hub for a handful, or for
what was typed, and is told how many there are in all. Reading needs a superuser. Telling the device to do
something needs a superuser who has just confirmed who they are, a device people can control, and an action
the device itself offers with nothing to fill in. It goes through the same door a screen's command does, so
the same checks run and it is logged with who asked and that it came from the admin. Anything with options,
and anything that sets a value, is still done from a screen.

**A module's presets become ready-made buttons, without their looks.** A Companion preset is a button for
Companion's grid: a look, and what pressing it does. The hub has no grid, so it used to drop presets whole. It
now keeps the half that is useful anywhere: the name, the heading its author filed it under, and the press,
when the press is exactly one of the module's own actions. A press that does several things, or does something
on release or after a delay, is left out, because doing half of it would be worse than not offering it. A
ready-made button is published like everything else a generic device has (`generic/ready/<id>`), so any screen
can show it, and pressing it goes through the same path as any command: same checks, same log. The device page
and the Controls screen show them first, under the author's headings, with everything else after. For a device
with hundreds of actions this is what makes the first look usable: the person who knows the device best
already chose what matters.

**A screen can keep documents, and the hub does not read them.** A screen runs in a sandbox with nowhere to
keep anything. A screen made of something a person or an agent puts together needs somewhere, so the hub keeps
small JSON documents for it, as files under `config/screens/<screen>/`. The hub checks that a document is a
JSON object of a sensible size and nothing more: what is in it is the screen's business. Who may read and who
may change them is decided the way everything about a screen is, by `documents` in what the screen uses and in
what its abilities allow, so there is no second set of rules. "any" never covers documents, as it never covers
the log. Saving one is not handing out power: a document can only ever ask the screen to do what that screen
and that person may already do.

**Canvas is a screen like any other, and a canvas is one of its documents.** Canvas draws screens from JSON:
pages of pieces on a grid, each tied to a value or an action of any device. It got nothing the contract does
not give every screen. What a canvas is, is the Canvas plugin's business: its checker, its schema and its
format reference live in `plugins/canvas/`, and the hub still does not read a document for meaning. A canvas
is checked before it is drawn, and one that fails is not half drawn: whoever may change canvases is shown what
is wrong in words, which is what a person or an agent writing the file needs. Placement is a grid and not free
pixels, so one canvas works on a phone and on a tablet, and a group that repeats is how eight channel strips
are one strip written once.

**A canvas never widens anyone's reach.** What a canvas has on it and what a person may do are separate
things. A canvas is written by whoever may add canvases; what each person in front of it can change is still
their roles and their own slots, enforced by the hub on every command. So one ear-mix canvas with `{ears}` in
its keys is every musician's own mix, and a musician who is shown a canvas of the whole board can move nothing
on it that is not theirs.

**Arranging a canvas is a set of small changes to its file, and nothing else.** The screen draws a canvas
being arranged with the same code that draws one in use, so what is arranged is what will be seen. Every
change (move, size, add, remove, copy, group, ungroup) is a function from one canvas to the next with no page
in it, which is what makes undo simple and lets the changes be tested without a browser. Nothing reaches the
hub until Done, the result is checked the same way a hand-written file is, and what comes out has nothing in
it that says how it was made. An agent editing the file and a person dragging on the screen are doing the same
thing to the same document.

**A screen is told its person's own reach.** The hello now carries `reach`: what this person may read and may
change, as key patterns with their slots already filled in. It is theirs and nobody else's, so telling the
screen gives nothing away, and it lets any screen dim what is not a person's to touch and say why, without
trying and being refused. It decides nothing. The hub checks every command as before.

**Performance is measured, and the measurement is kept.** `deno task bench` starts a hub, puts a room's worth
of load on it from another process and reports what a person would feel and how long the hub's own loop was
held up. `docs/performance.md` has what it showed and what is still true. The rule that came out of it: what
is asked for every value, for every phone, on every change has to cost almost nothing, and anything worked out
for one person that holds for everyone like them is worked out once.

**What the hub keeps has a numbered shape.** Each part of the hub made its own tables if they were missing,
which is enough for a new hub and does nothing for one already running: the first added column would have left
every existing hub behind. The database now carries the number of the shape it is in. A change to the shape is
a step from one number to the next, a hub brings older data forward before any part reads a row, each step
happens whole or not at all, and data in a shape newer than the hub knows is refused untouched with a plain
message. It is shape 1 and there are no steps yet. This is here before the first hub is in anyone's hands,
because afterwards is too late to add it cleanly. `core/shape.ts` says how to add a step.

**The agent is someone, not a second kind of permission.** It has an account like a person's, with a name of
its own, and it is given roles under People like anyone on the team. What it may see and do is worked out from
those roles by the same code that works it out for a person, so there is one set of rules and one place to
look. Two things are different, and the hub holds both: nobody can sign in as it (it has no PIN or password,
cannot be given one, and cannot be invited), and it is never a superuser. It starts with no roles, so a new
agent can see and do nothing. Everything it does goes in the log under its own ID.

**The agent's key goes one way.** The agent thinks with a model that runs somewhere else, reached with a key a
superuser pastes in. The key is kept in the database, in a table nothing else reads, and nowhere else. It is
not written to a config file, it is not in the log (which records who set it and when), and it is never sent
back to a page, not even to the superuser who typed it: the hub says only whether one is set. It is handed to
the part of the hub that talks to the model only while the agent is on, has a key and has not been turned off.
There is one other use: when a superuser opens the list of models to choose from, the hub asks the model's
service which models that key can use, at the same address, and that asking is logged. A model's name can
still be typed, for a service that has no such list. Where the model is can be changed, and since the key is
sent there, only to an address that starts with https, or one on the hub's own computer. Making the agent,
giving it a key, switching it on, letting it read the log and pointing it somewhere else each need the
superuser's own PIN. Taking any of those away never does.

**The agent's engine runs inside the hub, and the model is trusted with nothing.** A question goes to the
agent's model with the tools it may ask for. The model asks to look at something, the hub looks on its behalf
and tells it what it found, and so on until there is an answer. The model chooses what to ask for. It never
chooses what it is told: that is decided by the hub, each time, in `core/agent_tools.ts`. For now every tool
only reads: the devices, their values, and the log. A run is stopped after eight turns of the model or ninety
seconds, and two questions are worked on at once at most. The engine speaks one way of asking a model, the
Messages API, from one file (`core/model.ts`), so another way of asking is one more file and no change to the
rest. The key is sent to the address a superuser chose and nowhere that address points on to: a redirect is
refused.

**The agent is never told more than the person asking may see.** What a run may look at is what the agent's
own roles let it see, and of that, only what the person asking may see for themselves. An agent given the
whole board does not become a way round the limits of a musician who is given one mix: asked by the musician,
it sees one mix. A superuser already sees everything, so their questions are held only to the agent's own
reach. Something out of reach is answered exactly as if it did not exist. The agent has no screen in front of
it, so its reach is all its screens put together: for each screen its roles give it something on, the
connections approved for that screen, as far as its abilities there go (`core/reach.ts`). It is not another
way of being allowed something.

**What the agent reads is data.** Names typed into equipment, messages from drivers and entries of the log go
to the model as the result of a tool. What the hub itself says to the model is written by the hub and holds
nothing a device, a plugin or another person wrote, and it is the same from the first turn to the last. That
does not make a model immune to a name that gives orders. What makes it harmless is the rest: the model can
ask only for the tools it was offered, each is checked against the run's reach when it is asked for, and
asking for anything else is refused and written down. The hub's own code names no kind of device, so the
examples in the tools' descriptions are made from the kinds of value the run can see.

**People stay IDs, and names never leave the hub.** The model is told who is asking and who it is as IDs. The
log it reads has IDs. It answers with IDs, and the hub puts names in their place on the way back: every name
for a superuser, "you" and "someone else" for anyone else. Reading the log is a switch of the agent's own that
starts off. With it on, the agent reads only entries about values and devices it can already see, and a person
who asks comes by the log through the agent only if one of their own screens already shows it to them.

**What a run did is in the log. What was said is not.** Under one trace: who asked and from where, each time
the model was asked with how long it took and how many tokens it used, each thing looked at with how much came
back, and how it ended, with the reason in words when it failed. Each of those is the agent's own entry, under
its own ID. The question and the answer are not written there, and neither is anything that was read.

**Asking the agent is an ability, on a screen, like anything else.** `agent` is a name a screen may list under
`uses`, beside `log` and `documents`, and an ability may allow it. So who may talk to the agent is decided
where everything else is decided: a role switches the ability on. The screen that ships with the hub for this
is Ask (`plugins/ask`), and it is a plugin like any other: sandboxed, with no network, told only what the hub
passes it. Another screen could offer the agent too, by listing it. `any` never covers it.

**Ask opens beside the screen you are on.** Talking to the agent is mostly about what is on another screen,
and soon about changing it, so the two have to be in view together. A screen can say `"opens": "beside"`. The
hub then puts its name in the bar above every screen, as a word and not a floating button, and opens it in a
panel next to the screen: below on a phone, to the right with room. Nothing covers anything. Each is a
sandboxed frame with a connection of its own, held to its own abilities, so being beside a screen gives
neither any of the other's reach. Left open, it is open on the next screen too, and because the hub keeps the
conversation, it is the same conversation. This is the hub's doing for any screen that asks for it, not
something special about Ask.

**The conversation is AG-UI.** A screen sends a run's input and is told what happens as AG-UI events: the run
starting and ending, the agent's words as they are written, each thing it looks at. It is carried over the
connection a screen already has, not a second one, because a screen has no network of its own. The words are
passed on as the model writes them, with names put where the IDs are as they go by. What a person is told
about a look is what was looked at, in a few words, not what was found: that is the agent's to say.

**A conversation is one person's, kept in memory, and the hub's record is the one that counts.** A person has
one conversation with the agent, on every phone they are signed in on, until they start over. A second phone
opened part way through an answer is told what has happened so far and hears the rest. It is held in the hub's
memory: not in the database, the log or a file, gone when the hub restarts or after half a day untouched.
Nobody else is shown it, the superuser included. What is kept is what was asked and what was answered. What
the agent looked at is not: asked again, it looks again, as far as it may look then, so a role taken away is
not outlived by an old answer's working. Whatever history a screen sends is ignored.

**The agent changes something only after a yes, and the yes is the hub's to check.** The model never changes
anything. It may ask for one value to be set or one button to be pressed. The hub checks that against what the
agent may change and what the person asking may change, and if it could be done, stops the run and asks that
person, as an AG-UI interrupt. The question is in the hub's own words, made from the device's name, the
value's title and what it holds now, and never from anything the model wrote. Only that person's yes, from
their own screen, goes on to do it, and what is done is what was shown. It is checked again at the yes,
because what someone may do can change while a question waits. A no, an answer that is not exactly yes, a
stop, an answer after five minutes, or an answer to only some of what was asked: nothing is done. Nothing the
model read can say yes, and neither can the model: a yes can only arrive on the connection of the person who
was asked.

**Having the agent do things is a second ability, and is no new reach.** A screen says it goes that far with
`"agent": "write"`, and a role switches it on. Even then the agent can change, for a person, only what that
person could already change themselves on their other screens, and only what its own roles let it change. A
device the hub is only watching is not changed by anyone, the agent included. The change is on the record as
the agent's, made through the screen that lets the agent make it, with the person's yes beside it as theirs.

**The agent writes a screen's documents the way it changes anything: it asks, and the person sees it first.**
A canvas is a document the hub keeps for the Canvas screen, so building one is saving a document. The agent
can list and read the documents of screens in reach, and where it may act, ask for one to be kept. The hub
checks it against the schema the screen ships, and a document that is not right goes back to the agent with
what is wrong, without troubling anyone. One that is right is put to the person as a yes or no, and for as
long as the question is open the hub shows it to that person, on the screen it is for, marked as not saved and
with nothing on it able to act. With Ask open beside Canvas that is a canvas appearing next to the
conversation. Yes keeps it, as the agent's doing through that screen, and everyone looking at the screen is
told as for any save. No, or no answer, and it is gone.

**How a screen's documents are written is the screen's to say, and reaches the model as data.** A screen may
name a JSON Schema and a description in words in its manifest. The hub gives both to an agent that asks, as
the result of a tool, never as part of what the hub itself tells the model. The hub's own code still knows
nothing about canvases: the tools are about "documents of a screen", and Canvas is one screen that has them.

**A screen's documents are reached only through that screen.** To read a canvas for someone, the agent needs
an ability on Canvas that reads documents and so does that person. To save one, both need the ability that
writes them. A canvas never widens reach: a control on it works for whoever is looking only as far as their
own abilities go, so an agent cannot hand anyone a button they could not already press.

**A hub is updated by one button, and believes only what was signed for it.** A team's hub is installed, not
cloned. Every change to `main` is packed whole, with everything it needs to start, and published with a signed
note. The hub looks for a newer note a few times a day, believes it only if it was signed with a key the hub
carries, and tells a superuser what is in it. It never updates by itself: someone says when, with their own
PIN, and not during a service. The new version is unpacked beside the old one, the data is copied first, and
the hub stops with a code that tells whatever started it to start the new one. If that version will not start,
whatever started it goes back to the one before, with the data as it was. `docs/updates.md` has the whole of
it.

**What starts the hub is small, fixed, and the same on every kind of computer.** The part that is not itself
updated does three things: run the current version, move on when asked, go back when a version will not start.
Everything else about updating is in the hub, where it is tested. A Mac app, a Windows app and a script for a
computer with neither all do those three things and nothing more, so the next kind of computer is a small job.
The runtime travels with the app, and a version that needs a newer one says so.

**On a Mac the hub is an icon.** A team downloads one file, drags it to Applications and opens it. The app
starts the hub, opens it in a browser, shows a first owner their code in a window, and sits in the menu bar
saying whether the hub is running and what address phones use. Quitting it stops the hub. It is one file of
Swift with one small window: how the hub is, and Open, Stop, Start, Restart and Quit. The first version had no
window, only the mark in the menu bar, on the thought that everything a person does is in the browser. The
first person to open it could not find how to stop it. A thing that is running needs an obvious place that
says so and stops it. Closing the window leaves the hub running behind the mark in the menu bar, and the
window says that.

**A hub never outlives the app that started it.** The app holds the hub's input open and says nothing through
it. When the app is gone, however it went, that closes, and the hub stops. An app that is forced to quit
cannot tidy up, so the tidying cannot be the app's job. A hub that stops by itself is started again by the
app, up to a few times in ten minutes. It carries the runtime for both kinds of Mac and one version of the
hub, so it starts with no internet and nothing is installed first. The hub's data is kept outside the app, so
a newer app is dragged over the old one and nothing is lost. The hub keeps the port it had, since phones
remember the address. Every pull request builds the app on a Mac, starts the hub from inside it, and proves it
moves on and goes back, because nobody can click an icon in a check.

**Looking through a large board takes turns.** Going through thirty thousand values to list what a device
holds would keep everything else on the hub waiting. Whatever goes through a lot stops every few thousandths
of a second and lets a fader move. `docs/performance.md` has the numbers.

**A screen can say which values it is showing, and is then sent only those.** The hub holds every value of
every device and decides what each phone is sent, so narrowing that can only be done by the hub: a screen
could otherwise only ignore what had already crossed the wifi. A screen's manifest may say
`"values":
"asked"`. It is then sent nothing when it connects, sends a `watch` naming the values on the page
in view, and is sent those and changes to those. Asking for something that is not the person's to see gets
nothing: a watch narrows and never widens. Any screen may send a `watch`, and a screen that never does is sent
everything as before, so nothing already written breaks. The hub matches value names and knows nothing about
what a screen is. Canvas asks for exactly what the pieces it just drew are tied to. This is the platform's job
and not a plugin's for the same reason permissions are: it is the hub that sends.

**The log says where a value went, not every place it passed through.** A fader being dragged is thirty
changes a second, and each was two log entries. The log is there to say who changed what, from what to what,
when, and what went wrong, for a person or an agent asking afterwards. Nobody asking that needs the forty
positions in between. So a move is written as its first step, in full and at once, and one closing entry when
the value has been still for half a second: where it started, where it rested, how many steps reached the
device, how many were overtaken, and how long it took. The first step is written as it happens so that a hub
that stops mid-move still has a record that it began. Only steps by the same person through the same screen
are one move. Anyone else touching the value, a failure, a switch to watched-only or the device stopping ends
it at once, and what ended it is written in full after it. A move longer than five seconds is written and
begun again, so the log is never far behind. Actions are never folded: every press counts. A fader ridden at
the desk is written the same way. What screens are told has not changed: every step still reaches every phone.

**A device is paced from its first command, not by a clock.** A device is still sent commands no faster than
it said it can take them. But the first change after a quiet moment goes at once and the pacing starts from
it, so a press is not held for the rest of a tick it had no part in.

**A screen is told which document changed, not sent all of them again.** When anyone keeps or removes a
document, everyone on the screen who may read it gets `doc` with that one document. Sending everything again
was the simplest thing and grew with the number of documents times the number of phones.

## Open, and worth deciding before the next stage

- **How long the log is kept.** It is append-only and nothing is removed. Now that a move is written as two or
  three entries and not sixty a second, it grows by what people do, not by how long a thumb is down, and a
  year is far smaller than it was (`docs/performance.md` has the measure). It still has no end. Starting a new
  log file each month, with older months as files that can be moved off the hub, would give it one. Not done:
  it is no longer pressing, and it touches every reader of the log.
- **Giving a role one canvas and not another.** Canvas's abilities are for the whole screen: "use everything
  on a canvas" reaches every connection Canvas was given, and a person is shown every canvas that has
  something of theirs on it. A video volunteer who should have the switcher canvas and nothing else cannot be
  given exactly that yet. It needs a role to be able to name a canvas, and the hub to hold that person to what
  the canvas is tied to.

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
- **The agent sets values, presses buttons and writes screens' documents, and that is all it does.** It cannot
  remove a document, propose a change to a device's settings, add a device, or do several things as one step.
- **A canvas the agent writes is checked against the schema, not against the screen's own deeper rules.** One
  that passes the schema and still cannot be drawn is shown as such in the preview, with what is wrong, and
  the person can say no. The agent is not told why unless the person tells it.
- **Every yes is asked for, every time.** There is no "yes to this kind of thing from now on".
- **Nothing limits what the agent spends.** Every use of its model is in the log with its tokens, and one
  question is at most eight turns. There is no cap by the day or the month.
- **Skills are not yet given to the agent.** A skill is text that teaches an agent one procedure, and the hub
  loads them. The engine does not offer them to the model yet. When it does, a skill will be something the
  agent can read, and never a way to reach more.
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
- **A module's upgrade scripts.** Companion upgrades a module's saved settings between versions of the module.
  The hub keeps what a module saves and hands it back, but starts every module as new, so its upgrade scripts
  never run. A module whose settings changed shape between versions may need them filled in again.
- **The Mac app is not signed.** Without an Apple developer account, a Mac has to be told once to open it
  anyway, under Privacy & Security. Signing is in the build already. Having Apple check each build, which is
  what removes that step, needs the account and is not wired up.
- **A Windows app.** The same three things in another language. Not started.
- **License.** Not chosen.

## Not tested

- Any real soundboard. Everything here runs against the simulated board.
- The Mac app, beyond what a check can do. Every check builds it on a Mac, opens it the way a person does,
  takes a picture of its window, claims the hub, reads the real store through it, quits it and forces it to
  quit. No check presses a button in the window, starts it at login, or sees what the Mac asks the first time
  an unsigned app is opened. One person has run it, on an Intel Mac.
- Windows, on a real machine. The tests pass on Linux, macOS and Windows on GitHub's machines, and the
  real-browser test passes in Chrome and WebKit there. On Windows the hub cannot yet read a plugin's memory or
  processor use, so those limits are not enforced and their tests are skipped. Windows does not yet block a
  merge.
- Safari on a real phone. WebKit on Linux is the same engine, not the same browser.
- More than a few Companion modules. A module written for the tests runs in every check. Two real ones are
  built from their source in a check that reports and does not block: the TP-Link Kasa module drives a pretend
  plug, and the Android TV module, whose library asks a great deal of the computer it is on, is shown to start
  and report for itself on Linux and on a Mac, and is paired with a pretend television that speaks a
  television's own messages: a code read off its screen and typed in, a key sent, the hub stopped and started,
  and still paired. No module has driven real equipment through the hub in a check, and nobody has yet paired
  the Android TV module with a real television through the hub.
- More than a handful of phones at once.
- Meters. The contract has no message for them yet.

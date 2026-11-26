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
- **Install, update, rollback, uninstall.** Plugins are listed in `core/main.ts` for now.
- **License.** Not chosen.

## Not tested

- Any real soundboard. Everything here runs against the simulated board.
- Windows and macOS. The tests ran on Linux.
- More than a handful of phones at once.
- Meters. The contract has no message for them yet.

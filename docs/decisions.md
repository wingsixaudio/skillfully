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
- **Sign-in and roles.** None yet. The phone states who it is.
- **Record and replay.** The spec calls for recording plugin traffic and replaying it as tests. Not built.
- **Install, update, rollback, uninstall.** Plugins are listed in `core/main.ts` for now.
- **License.** Not chosen.
- **Whether the name `skillfully.live` is registered.** The page shows it as a wordmark only.

## Not tested

- Any real soundboard. Everything here runs against the simulated board.
- Windows and macOS. The tests ran on Linux.
- More than a handful of phones at once.
- Meters. The contract has no message for them yet.

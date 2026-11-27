# How a hub is installed and kept up to date

A team does not use git and does not open a terminal. This is how the hub gets onto their computer and stays
current, and what anyone writing an installer or a launcher for another kind of computer has to do.

## Versions

Every change that reaches `main` is packed as a version: the hub's own code with everything that code needs to
start, so that nothing is fetched when it runs. A version has a number, which is how many changes `main` has
had. It only goes up.

The release step (`.github/workflows/release.yml`) publishes each version as a GitHub release with three
files:

| File                     | What it is                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `skillfully-hub-<n>.tgz` | The pack                                                                                                                       |
| `latest.json`            | The note about it: its number, its change, the pack's checksum and size, the runtime it needs, and a few lines on what changed |
| `latest.json.sig`        | The note's signature                                                                                                           |

A hub reads the note of the newest release, and only believes it if it was signed with a key the hub carries
(`HUB_KEYS` in `core/update.ts`). It only believes a pack that has the checksum the note gives. A hub never
moves to a lower number.

## What the Update button does

A superuser sees, on the Hub place, which version is running and whether there is a newer one, with what
changed. **Update** asks for their own PIN, then:

1. fetches the pack and checks it against the signed note,
2. unpacks it beside the version that is running,
3. copies the hub's data to `backups/before-<n>.db`, keeping the newest five,
4. writes the new version's name to `next`, and stops with exit code 75.

Nothing that is running is touched until the last step. The hub never updates by itself.

## The folder an installer makes

```
home/
  versions/<number>-<change>/   each version, unpacked
  current                       the name of the version to run
  next                          written by a hub that wants a newer version started
  status.json                   written by the running hub: its address, its version, and the code
                                its first owner needs
  went-back                     written when a version would not start and the one before was put back
  data/                         what the hub knows: people, devices, log, screens' documents
  backups/                      the data as it was before each update
```

## What a launcher does

A launcher is the small fixed part that is not itself updated: the Mac app, the Windows app, or
`launcher/launch.ts` for a computer with neither. It does three things.

1. **Run** the version named in `current`:
   `deno run --cached-only --no-prompt --allow-net --allow-read --allow-env=HOME,DENO_DIR,SYSTEMROOT,LOCALAPPDATA,USERPROFILE --allow-write=<home> --allow-run <home>/versions/<current>/core/main.ts --home=<home>`
2. **Move on** when it stops with code 75 and `next` names a version that is there: make that the current one,
   remove `next`, and run again.
3. **Go back** when a version it just moved to stops with an error within twenty seconds: put the data back
   from `backups/before-<n>.db`, make the version before the current one again, write `went-back`, and run.

It reads `status.json` to learn the hub is up, where to point a browser, and what code to show the first
owner. Started with `--stay-with-app`, the hub stops when its input closes, so an app holds that open for as
long as it lives and a hub is never left running by an app that died. It bundles the runtime. The Mac app is
`apps/mac/main.swift`, and `docs/mac.md` is what it is like to use. A version that needs a newer runtime than
the app has says so on the Update button, and the answer is a newer app.

## Setting up the key

Once, on the maintainer's own computer: `deno run --allow-read=. --allow-write=. tools/new_key.ts`. It says
what to do with the two halves. Until that is done, versions are packed and checked on every change to `main`
and none is published, and hubs say updates are not set up.

## For now, and later

Every change to `main` is offered to every hub. That is right while one team uses it. When more do, changes
will gather on another branch and reach `main` when they are ready together.

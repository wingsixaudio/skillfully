# Skillfully on a Mac

One download, one icon. Nobody opens a terminal.

## Installing

1. Download `Skillfully.dmg` from the
   [latest release](https://github.com/wingsixaudio/skillfully/releases/latest/download/Skillfully.dmg).
2. Open it and drag Skillfully to Applications.
3. Open Skillfully.

The first time, the Mac says it cannot check the app, because the app is not yet signed with an Apple
developer account. Open **System Settings**, then **Privacy & Security**, scroll down, and press **Open
Anyway** next to Skillfully. It asks once. This step goes away when the app is signed.

The Mac may also ask whether Skillfully may find devices on your network, and whether it may accept
connections. Say yes to both: the first is how it reaches your team's equipment, the second is how phones
reach it.

## What the icon does

Opening Skillfully starts your team's hub and shows one small window:

- whether the hub is **Running**, **Starting**, **Stopped** or **Not running**, and which version it is;
- the first time, the code that makes you the hub's first owner, with a button that copies it and opens the
  page that asks for it;
- **Open Skillfully**, which opens the hub in your browser;
- **Stop** and **Start**, and **Restart**;
- the address phones on the same network open, with a button that copies it;
- **Start when I log in**, for a computer that is the hub and nothing else;
- **Show the log**, the file to send when asking for help;
- **Quit and stop the hub**.

Closing the window does not stop the hub. It keeps running in the background, and the Skillfully mark among
the icons at the top right of the screen brings the window back and has Stop, Restart and Quit under it. So
does opening Skillfully again.

Quitting stops the hub. If the app is ever forced to quit, the hub stops with it, so there is never a hub
running with nothing to stop it. If the hub stops by itself, the app starts it again.

Nothing has to be installed first. The app carries what the hub runs on and one version of the hub, so it
starts with no internet.

## Updates

The hub updates itself from the Hub place, with one button (`docs/updates.md`). The app is only replaced when
an update says it needs a newer app: download the new one and drag it over the old one. Your hub's people,
devices and log are not in the app, so they are still there.

## Where things are

Everything the hub knows is in `~/Library/Application Support/Skillfully`: the data, the versions, a copy of
the data from before each update, and the log. To move a hub to another Mac, quit Skillfully and copy that
folder. To remove Skillfully altogether, delete the app and that folder.

The hub listens on port 8080, or the next free one, and keeps the port it had so the address phones use does
not change.

## Building it

On a Mac with Xcode's command line tools and Deno:

```sh
deno run --allow-read --allow-write=dist --allow-run --allow-env --allow-net tools/bundle.ts
apps/mac/build.sh dist/skillfully-hub-*.tgz /tmp/skillfully-mac
```

Every pull request builds the app on a Mac, starts the hub from inside it, and proves it moves to a newer
version and goes back from a broken one. It then opens the app the way a person does, takes a picture of the
screen, quits it and checks the hub stopped, and forces it to quit and checks the hub stopped then too. The
disk image and the pictures are kept with the run, so a change to the app can be looked at and tried from the
pull request's checks.

Set `MAC_SIGN_IDENTITY` to a Developer ID to sign it properly. Having Apple check it (notarizing), which is
what removes the Open Anyway step, is not wired up yet: it needs an Apple developer account.

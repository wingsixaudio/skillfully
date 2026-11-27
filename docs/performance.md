# How the hub holds up under load

What was measured, what it showed, what was changed, and what is still true. Measured on a two-core Linux
machine with the hub in one process and the load coming from another. Every number here can be had again with
`deno task bench`.

## How to measure

```sh
deno task bench                                  # every scenario, against the 1,584-value simulated board
deno task bench --big -- connect faders          # against a 33,024-value board: 256 inputs into 64 buses
deno run -A tools/bench/micro.ts                 # what single steps cost
```

| Scenario     | What it does                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `connect`    | One Controls phone connects, then fifty at once, then one musician                              |
| `tap`        | One change after a quiet moment, sixty times: a button pressed, or a fader first touched        |
| `roundtrip`  | 1,500 changes, each sent when the one before is answered                                        |
| `faders`     | Sixteen musicians each moving their own fader 30 times a second for ten seconds, fifty watching |
| `faders+log` | The same, with each musician's screen asking for the recent log as the ear-mix screen does      |
| `docs`       | Twenty phones on Canvas, forty canvases kept, one more saved                                    |
| `admin`      | The admin page's own request for everything                                                     |

The hub reports, once a second, the longest its own loop was held up. That is the number that says whether
everyone else was kept waiting.

## What it showed, and what changed

| What a person feels                                    | Before              | After               |
| ------------------------------------------------------ | ------------------- | ------------------- |
| A press after a quiet moment, until the device has it  | 21 ms (34 at times) | 3.6 ms (7 at times) |
| Sixteen faders moving, the slowest 1 in 20 changes     | 99 ms               | 41 ms               |
| The same, the slowest 1 in 100                         | 131 ms              | 61 ms               |
| Changes dropped because a newer one overtook them      | 1,474 of 4,711      | 69 of 4,705         |
| How often a watcher's screen is brought up to date     | 22 a second         | 29 a second         |
| The hub's loop held up while sixteen faders move       | 80 ms               | 9 ms                |
| Fifty phones connecting at once, small board           | 197 ms              | 50 ms               |
| Fifty phones connecting at once, 33,024-value board    | 3.1 s               | 0.7 s               |
| The hub's loop held up while they connect, large board | 1.7 s               | 39 ms               |
| A musician connecting, large board                     | 58 ms               | 25 ms               |

The rows from "Sixteen faders" to "held up" are `faders+log`, which is what a room of musicians really does.

Five changes did that:

1. **The newest of the log is answered from memory.** Every screen that shows what just happened asks for the
   recent log after every change. Each ask read a thousand rows from the database and unpacked them. With
   sixteen musicians that was the most expensive thing the hub did. The newest thousand entries are now also
   kept in memory, and that question never touches the database.
2. **Entries that belong together are written together.** Each entry was its own trip to the disk. Everything
   sent to a device in one go, and everything it answers in one go, is now one trip. Nothing about how safely
   an entry is kept has changed.
3. **The first change after a quiet moment goes at once.** A device is sent commands no faster than it said it
   can take them, thirty a second unless it says otherwise. That was done with a tick, so a press waited for
   the next tick even with nothing ahead of it. Now it goes at once and the pacing starts from it.
4. **People who may read the same things are told once.** What a phone is told was worked out and put into
   words separately for every phone. Fifty people with the same role now share one working-out. The whole of
   what a device holds, as sent to a phone that connects, is kept until the device changes.
5. **Checking whether a value is someone's to read makes nothing it does not need.** It is asked for every
   value, for every phone, on every change.

Saving a document also told every phone on the screen about every document the screen keeps. It now tells them
about the one that changed (`doc`, see the contract).

## What is still true

These are not fixed. They are in the order they would bite.

- **The log grows without end.** An entry is about 700 bytes. A fader being moved writes sixty a second, two
  for each of thirty changes. One musician moving faders for a minute is 2.5 MB. Nothing is ever removed, by
  design. A year of services is several gigabytes, which fills a small computer's card. This needs a decision:
  see `docs/decisions.md`.
- **A phone is sent everything it may see.** A Controls or Canvas phone on a 33,024-value board is sent 1.1 MB
  when it connects, though a canvas shows a few dozen values. Sharing the working-out made this cheap for the
  hub. It is still a lot for a phone on poor wifi. The answer is for a screen to say which values it is
  showing. That is a change to the contract.
- **Every role change reconnects every phone.** It is simple and it is right: nobody keeps reach they no
  longer have. With a large board and many phones it is a burst of work, 0.7 s for fifty.
- **A device's whole state has to fit in one 8 MB message.** That is roughly 190,000 values.
- **Each device's memory and processor use is read by starting a small program, four times a second.** It is
  under 1% of the hub's time with two devices and grows with the number of devices. Twenty would be worth
  reading together.
- **One hub is one process on one computer.** There is no second hub to take over. For one venue that is the
  right size. It does mean the hub's computer is the thing to keep healthy.

## Not measured

- A real board. Every number here has a simulated one that answers at once.
- Real phones on real wifi. The load came from the same computer.
- More than two devices at once, or any Companion module under load.
- A small computer such as a Raspberry Pi. Disk writes there are slower, which is what change 2 is for.
- More than 66 phones.

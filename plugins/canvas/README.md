# Canvas

Screens you put together yourself. A canvas is pages of pieces on a grid, and each piece is tied to a value or
an action of a device. If you can think of a sound, video or lighting screen you would want, the aim is that
you can build it here.

A canvas is a JSON document. A person can write one, an agent can write one, and the hub keeps each as a file:

```
<the hub's data folder>/config/screens/canvas/<id>.json
```

The name of the file is the canvas's id: lower-case letters, digits and dashes. The screen picks up a new file
the next time someone opens it or taps Canvases.

To a canvas, everything in the file is data. Every word is shown as text and nothing is run. What the person
in front of a canvas may see and change is decided by the hub from their roles, whatever the canvas has on it.

## A small one

```json
{
  "kind": "canvas",
  "name": "My ears",
  "columns": 4,
  "pages": [
    {
      "name": "Mix",
      "pieces": [
        {
          "type": "group",
          "at": [1, 1, 4],
          "repeat": { "as": "n", "from": 1, "to": 8 },
          "pieces": [
            {
              "type": "slider",
              "at": [1, 1, 1, 4],
              "key": "console/input/{n}/bus/{ears}/level",
              "title": { "key": "console/input/{n}/name" }
            }
          ]
        }
      ]
    }
  ]
}
```

Eight strips, four across, each named by the board. `{n}` is the input the group is repeating for. `{ears}` is
filled in from the person looking, so one canvas is everybody's own mix.

## The grid

- `columns` is how many columns the canvas has, 1 to 24. Left out, it is 4. Every row is the same height.
- `at` says where a piece is: `[column, row]`, or `[column, row, wide, tall]`. Counting starts at 1.
- On a narrow screen the columns get narrower. A canvas with many columns scrolls sideways before its pieces
  get too small to touch.

## The pieces

Every piece has `type` and `at`. A piece tied to a device has a `key`, and may name a `device`.

| Type      | What it is                                                              | Its own words                                                    |
| --------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `label`   | Words on the canvas                                                     | `text`, `size` (`small`, `normal`, `large`)                      |
| `readout` | A value, shown                                                          | `key`, `device`, `title`                                         |
| `button`  | Triggers an action, or sets a value to one thing                        | `key`, `device`, `title`, `value`, `lit`, `color`                |
| `toggle`  | A switch between two values                                             | `key`, `device`, `title`, `on`, `off`, `color`                   |
| `slider`  | A value you drag. Taller than wide it stands up, otherwise it lies down | `key`, `device`, `title`, `min`, `max`, `step`, `sends`, `shows` |
| `clock`   | The time                                                                | `title`, `seconds`                                               |
| `group`   | Pieces placed together, which can repeat                                | `title`, `pieces`, `repeat`                                      |

- **`key`** is a value or an action of a device, as the Controls screen lists them: the kind of device, a
  slash, then the value. `console/input/1/bus/2/level`, `switch/outlet/3/on`, `generic/ready/lamp_on`.
- **`device`** is the id of a device. Left out, it is the first device the screen has been given that has that
  kind of value. Name it when the screen has two of a kind.
- **`title`** and a label's **`text`** are words, or `{ "key": ... }` to show a value as words. A piece with
  no title uses what the device calls it.
- **`value`** is what a button sends. Left out, the button triggers. An object is the options of an action.
- **`lit`** lights a button while a value is something: `{ "key": "generic/reading/power", "is": "on" }`. This
  is how a row of sources shows which one is live.
- **`on`** and **`off`** are the two values of a toggle. Left out, they are `true` and `false`.
- **`color`** is one of `orange`, `red`, `green`, `blue`, `yellow`, `white`.
- A slider takes its range from the device. `min`, `max` and `step` are for when the device does not say. A
  level in decibels gets the travel a fader has: most of it is the part people mix in.
- A slider can also be tied to **an action that takes a number**, which is how many devices take a volume or a
  level. Give the action as `key`, and in **`sends`** the id of the action's option the number goes in. The
  action is done once, with the number, when the slider is let go, not while it is moving. Give `min` and
  `max`, since an action has no range of its own. **`shows`** is the value that says where the slider rests,
  usually the device's own reading of what the action sets. A reading that is a number written as words still
  works.

  ```json
  {
    "type": "slider",
    "at": [1, 5, 4, 1],
    "key": "generic/action/volume",
    "sends": "volume",
    "min": 0,
    "max": 100,
    "shows": { "key": "generic/reading/volume_level" },
    "title": "Volume"
  }
  ```

## Groups

A group places its pieces from its own corner, so a group can be moved as one thing. With a `title` it is
drawn as a card with that title on its first row. Left without a height, it is as tall as what is in it.

With `repeat`, the pieces inside are laid out once for each item, left to right, starting a new row when the
group's width runs out:

```json
{ "as": "n", "from": 1, "to": 8 }
{ "as": "cam", "each": ["left", "centre", "right"] }
```

Inside, `{n}` or `{cam}` stands for the item, in a `key`, a `device`, a `title` or a label's `text`.

## Names in braces

A name in braces is filled in when the canvas is shown: first from the group a piece is inside, then from the
slots of the person looking (the same slots a superuser sets under People, such as `ears`). A piece whose key
needs a slot nobody has set for that person says so, and sends nothing.

## Arranging on the screen

Someone who may arrange canvases has an Arrange button on each one, and "An empty canvas" to start from.

- **Choose, then drag.** A first touch chooses a piece. Dragging a chosen piece moves it by whole cells, and
  dragging its corner sizes it. The arrow keys move it, and with Shift they size it.
- **Add** asks what the new piece is tied to, from a list of what the screen's devices have. Type to narrow
  it: "input 3 bus 2".
- **The sheet** for a chosen piece holds everything the file can say about it. A number in its key can be
  switched to "each item of the group" or "each person's own" without typing braces.
- **Put in a group**, then set the group to repeat, to turn one strip into eight.
- **Nothing is kept until Done.** Undo steps back one change at a time, and Cancel loses them all after
  asking. What Done keeps is checked first, and is the same file a person or an agent could have written.

While arranging, pieces show what the devices hold and do nothing when touched.

## Who can do what

| Ability                           | What it lets a person do                                        |
| --------------------------------- | --------------------------------------------------------------- |
| See canvases                      | Open them and see every value on the screen's connections       |
| Use everything on a canvas        | Press and drag anything, on any of the screen's connections     |
| See my own ear mix on a canvas    | Open them, and see input names and the sends into their own bus |
| Adjust my own ear mix on a canvas | Change the sends into their own bus, and nothing else           |
| Arrange canvases                  | Start a canvas, arrange what is on one, and remove one          |

A canvas does not widen anyone's reach. A piece that is not a person's to change is drawn dimmed and says why
when touched, and the hub refuses it whatever the screen sends.

A person is shown the canvases that have something of theirs on them. Someone who may add and remove canvases
is shown them all, including one that cannot be drawn, with what is wrong with it in words.

## Checking one

`canvas.schema.json` in this folder describes a canvas for editors and agents. `canvas.js` holds the checker
the screen itself uses, with no page in it:

```js
import "./canvas.js";
const problems = globalThis.SkillfullyCanvas.check(doc); // [] when it can be drawn
```

`tests/fixtures/canvas/` has five canvases the tests draw: an ear mix, eight channel strips over two pages, a
row of sources with the live one lit, camera presets, and a run sheet across three devices.

## What it cannot do yet

- **Meters.** The hub has no message for them yet.
- **A button that acts on press and again on release**, for moving a camera while it is held.
- **Companion's own button feedback.** A button is lit from a reading, with `lit`.
- **Giving a role one canvas and not another.** Reach is set by the abilities above, for the whole screen.

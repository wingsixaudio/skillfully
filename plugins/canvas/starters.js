// Canvases to start from. Each is an ordinary canvas, the same JSON a person or an agent would write, and
// is offered when the screen has been given a device of the kind it is about.
globalThis.SkillfullyCanvasStarters = [
  {
    id: "my-ears",
    needs: "console",
    about:
      "Eight inputs into the ear mix that is yours. One canvas serves everyone: each person gets their own.",
    doc: {
      kind: "canvas",
      name: "My ears",
      columns: 4,
      pages: [
        {
          name: "Mix",
          pieces: [
            {
              type: "group",
              at: [1, 1, 4],
              repeat: { as: "n", from: 1, to: 8 },
              pieces: [
                {
                  type: "slider",
                  at: [1, 1, 1, 4],
                  key: "console/input/{n}/bus/{ears}/level",
                  title: { key: "console/input/{n}/name" },
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: "channel-strips",
    needs: "console",
    about: "Sixteen inputs into bus 1 as two pages of eight strips, each with its pan.",
    doc: {
      kind: "canvas",
      name: "Channel strips",
      columns: 8,
      pages: [[1, 8], [9, 16]].map(([from, to]) => ({
        name: `${from} to ${to}`,
        pieces: [
          {
            type: "group",
            at: [1, 1, 8],
            title: "Into bus 1",
            repeat: { as: "n", from, to },
            pieces: [
              {
                type: "slider",
                at: [1, 1, 1, 5],
                key: "console/input/{n}/bus/1/level",
                title: { key: "console/input/{n}/name" },
              },
              { type: "slider", at: [1, 6], key: "console/input/{n}/bus/1/pan", title: "Pan" },
            ],
          },
        ],
      })),
    },
  },
  {
    id: "power",
    needs: "switch",
    about: "Four outlets, each with a switch and its brightness, under a clock.",
    doc: {
      kind: "canvas",
      name: "Power and lights",
      columns: 4,
      pages: [
        {
          name: "Outlets",
          pieces: [
            { type: "clock", at: [1, 1, 4, 2] },
            {
              type: "group",
              at: [1, 3, 4],
              repeat: { as: "n", from: 1, to: 4 },
              pieces: [
                {
                  type: "toggle",
                  at: [1, 1, 2, 1],
                  key: "switch/outlet/{n}/on",
                  title: { key: "switch/outlet/{n}/name" },
                },
                {
                  type: "slider",
                  at: [3, 1, 2, 1],
                  key: "switch/outlet/{n}/brightness",
                  title: "Brightness",
                },
              ],
            },
          ],
        },
      ],
    },
  },
];

/* Named rules, as seed data for the store.
 *
 * Names and attributions are the standard ones from the life-like automata
 * literature (LifeWiki, Eppstein's survey), recalled rather than fetched —
 * verify before citing. The B/S strings are checkable by running them.
 *
 * No classification here on purpose: these are labels, not verdicts.
 */

export const CATALOG = [
  { rule: "B3/S23", name: "Conway's Life", note: "The reference case. Sparse debris, still lifes, and gliders that carry information across the lattice." },
  { rule: "B36/S23", name: "HighLife", note: "Conway plus birth on 6, which buys a 12-cell self-replicator." },
  { rule: "B2/S", name: "Seeds", note: "Nothing ever survives; every pattern is rebuilt from births alone. Almost anything detonates." },
  { rule: "B3678/S34678", name: "Day & Night", note: "Symmetric under swapping live and dead. Supports gliders in both phases." },
  { rule: "B1357/S1357", name: "Replicator", note: "Parity rule: alive if the neighbour sum is odd. Copies itself into a Sierpinski array. Cancels itself on a power-of-two torus." },
  { rule: "B3/S12345", name: "Maze", note: "Grows corridors from any seed until the lattice is a static labyrinth." },
  { rule: "B37/S12345", name: "Mazectric", note: "Maze with birth on 7; corridors run longer and straighter." },
  { rule: "B3/S012345678", name: "Life without Death", note: "Nothing ever dies. Patterns grow ladders outward and freeze behind them." },
  { rule: "B35678/S5678", name: "Diamoeba", note: "Solid blobs with boiling coastlines. Has a survival threshold near density 0.45." },
  { rule: "B4678/S35678", name: "Anneal", note: "A majority vote with noise. Domains coarsen and boundaries straighten — a model of surface tension." },
  { rule: "B45678/S2345", name: "Coagulations", note: "Grows indefinitely from almost any seed, leaving thick clotted deposits." },
  { rule: "B34/S34", name: "34 Life", note: "Briefly popular as a Life alternative before it was clear it explodes from most seeds." },
  { rule: "B368/S238", name: "Morley", note: "Also called Move. Conway-like debris with a distinctive slow glider." },
  { rule: "B/S012345678", name: "Frozen", note: "No births, universal survival. Whatever you seed is what you get, forever." },
  { rule: "B012345678/S012345678", name: "Saturate", note: "Birth on zero neighbours: the lattice is solid within one generation." }
];

/* Patterns for the bench. */
export const PATTERNS = {
  Point: [[0, 0]],
  Glider: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]],
  "R-pentomino": [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
  Acorn: [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]],
  "Gosper gun": [
    [0, 4], [0, 5], [1, 4], [1, 5], [10, 4], [10, 5], [10, 6], [11, 3], [11, 7],
    [12, 2], [12, 8], [13, 2], [13, 8], [14, 5], [15, 3], [15, 7], [16, 4],
    [16, 5], [16, 6], [17, 5], [20, 2], [20, 3], [20, 4], [21, 2], [21, 3],
    [21, 4], [22, 1], [22, 5], [24, 0], [24, 1], [24, 5], [24, 6], [34, 2],
    [34, 3], [35, 2], [35, 3]
  ]
};

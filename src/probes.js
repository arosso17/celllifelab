/* Probes: named initial conditions, each producing a trace.
 *
 * A trace is the raw history of one run — population and activity per
 * generation, the final lattice, and any cycle detected. Features are pure
 * functions of traces, so adding a feature never means touching the runner,
 * and adding a probe makes a whole new class of question askable.
 *
 * The set below varies two things independently:
 *   density  — 0.35 / 0.50 / 0.65 soups, to locate survival thresholds
 *              rather than merely detect them
 *   geometry — a point, a hollow outline, a half-filled patch, a solid
 *              block, all at the same footprint
 * plus one bounded run, so the torus itself can be measured as a variable.
 *
 * To add a probe: append to PROBES. Anything referencing it by id gets it.
 */

import {
  TORUS, EDGE_DEAD, makeGrid, randomise, seedBlob, seedOutline, seedPoint,
  step, hashGrid, boundingBox, borderLive, perturb, hammingOf
} from "./engine.js";

/* Fixed seed so every run of the same probe is byte-identical. */
export const PROBE_SEED = 0x5eed11fe;

/* Soups need only enough room to be statistical. Seeded runs need room to
   grow before they hit the wall and stop meaning anything. */
const SOUP_SIZE = 64, SOUP_GENS = 240;
const OPEN_SIZE = 80, OPEN_GENS = 250;
export const BLOB_SIZE = 12;

/* The long horizon. Coarsening rules are still visibly reorganising well past
   the 240 generations every other probe stops at, so measuring only there
   describes a transient and calls it the rule's behaviour. */
export const SETTLE_GENS = 1600;

/* A lattice with no power of two in it. Parity rules such as B1357/S1357
   cancel themselves on a 64-wide torus — their copies land on each other —
   and `wallEffect` can only flag that, not attribute it. Running the same
   soup at 66 separates "the rule did that" from "the lattice did that". */
const ODD_SIZE = 67;

/* Profiles scale every probe at once. `fast` is for sweeping thousands of
   rules; `full` is for anything you intend to look at closely. */
export const PROFILES = {
  full: { scale: 1.0, gens: 1.0 },
  fast: { scale: 0.7, gens: 0.65 }
};

function runTrace({ rule, w, h, gens, boundary, init, detectCycles = true, checkpoints = [] }) {
  const g = makeGrid(w, h);
  init(g);

  const pop = [g.pop];
  const act = [0];
  const seen = detectCycles ? new Map([[hashGrid(g), 0]]) : null;
  let cycle = null;

  /* Over the last stretch of the run, remember how often each cell changed
     and what the lattice looked like when that stretch began. Spatial
     features need to know *where* the activity was, not just how much. */
  const window = Math.max(10, Math.min(50, Math.round(gens * 0.2)));
  const windowStart = gens - window;
  const changes = new Uint16Array(w * h);
  let maskBefore = null;

  /* Snapshots at named generations, so a long run can be compared against
     itself: what the lattice looked like at the short probes' horizon, and
     what it looked like once it had had time to settle. */
  const wanted = new Set(checkpoints.filter(c => c >= 1 && c <= gens));
  const marks = new Map();

  for (let i = 1; i <= gens; i++) {
    const prev = i > windowStart ? g.cur.slice() : null;
    step(g, rule.B, rule.S, boundary);
    pop.push(g.pop);
    act.push(g.act);

    if (i === windowStart) maskBefore = g.cur.slice();
    if (wanted.has(i)) marks.set(i, { gen: i, w, h, cur: g.cur.slice(), pop: g.pop });
    if (prev) {
      for (let k = 0; k < prev.length; k++) if (prev[k] !== g.cur[k]) changes[k]++;
    }
    if (seen && !cycle) {
      const hash = hashGrid(g);
      const at = seen.get(hash);
      if (at !== undefined) cycle = { start: at, period: i - at };
      else seen.set(hash, i);
    }
  }

  return {
    w, h, gens, boundary, pop, act, cycle,
    grid: g, bbox: boundingBox(g), cells: w * h,
    changes, maskBefore, window, marks
  };
}

const soup = (density, salt) => (rule, p) => runTrace({
  rule,
  w: Math.round(SOUP_SIZE * p.scale), h: Math.round(SOUP_SIZE * p.scale),
  gens: Math.round(SOUP_GENS * p.gens), boundary: TORUS,
  init: g => randomise(g, density, PROBE_SEED ^ salt)
});

const open = (init, boundary = TORUS) => (rule, p) => runTrace({
  rule,
  w: Math.round(OPEN_SIZE * p.scale), h: Math.round(OPEN_SIZE * p.scale),
  gens: Math.round(OPEN_GENS * p.gens), boundary,
  init
});

export const PROBES = [
  {
    id: "soup35", label: "Soup 0.35", group: "density",
    note: "Sparse soup on a torus. Rules with a survival threshold die here.",
    run: soup(0.35, 0)
  },
  {
    id: "soup50", label: "Soup 0.50", group: "density",
    note: "The canonical probe: period, entropy and texture are all read from this run.",
    run: soup(0.50, 0x9e37)
  },
  {
    id: "soup65", label: "Soup 0.65", group: "density",
    note: "Dense soup. Together with the other two this gives a response curve, not a single point.",
    run: soup(0.65, 0x2f1b)
  },
  {
    id: "point", label: "Single point", group: "geometry",
    note: "One live cell on an empty lattice. The minimal seed; the only probe that catches B0 and B1 rules honestly.",
    run: open(g => seedPoint(g))
  },
  {
    id: "outline", label: "Blob outline", group: "geometry",
    note: "A hollow 12x12 square. Same footprint as the filled blobs, no interior.",
    run: open(g => seedOutline(g, BLOB_SIZE, BLOB_SIZE))
  },
  {
    id: "half", label: "Blob 0.5", group: "geometry",
    note: "A 12x12 patch filled at random, half alive.",
    run: open(g => seedBlob(g, BLOB_SIZE, BLOB_SIZE, 0.5, PROBE_SEED ^ 0x1234))
  },
  {
    id: "solid", label: "Blob solid", group: "geometry",
    note: "A solid 12x12 block. Differences from the outline isolate what the interior was doing.",
    run: open(g => seedBlob(g, BLOB_SIZE, BLOB_SIZE, 1, 0))
  },
  {
    id: "walled", label: "Soup 0.50, dead edges", group: "boundary",
    note: "The 0.50 soup on a bounded rectangle. Differences from `soup50` isolate what the wrapping was doing.",
    run: (rule, p) => runTrace({
      rule,
      w: Math.round(SOUP_SIZE * p.scale), h: Math.round(SOUP_SIZE * p.scale),
      gens: Math.round(SOUP_GENS * p.gens), boundary: EDGE_DEAD,
      init: g => randomise(g, 0.50, PROBE_SEED ^ 0x9e37)
    })
  }
];

/* Densities tested by the `scan` probe, low to high. */
export const SCAN_DENSITIES = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];

/* A threshold cannot be located by three fixed soups — they can only bracket
   it. This runs a short, small pass at ten densities and reports the final
   density of each, so `criticalDensity` can say 0.42 rather than "somewhere
   between 0.35 and 0.50". Deliberately coarse: it is looking for the
   crossing, not measuring anything precisely. */
/* Three probes now need the rule's critical density before they can start,
   and the scan is deterministic, so running it three times gives three
   identical answers at three times the price. Records are measured one rule
   at a time, so a single-entry memo hits every time. Nothing observable
   changes: clearing it gives the same numbers. */
let scanMemo = null;
function scanFor(rule, p) {
  const key = `${rule.B}/${rule.S}/${p.scale}/${p.gens}`;
  if (scanMemo?.key === key) return scanMemo.value;
  const value = computeScan(rule, p);
  scanMemo = { key, value };
  return value;
}

function computeScan(rule, p) {
  const size = Math.max(24, Math.round(40 * p.scale));
  const gens = Math.max(40, Math.round(90 * p.gens));
  const finals = SCAN_DENSITIES.map((d, i) => {
    const t = runTrace({
      rule, w: size, h: size, gens, boundary: TORUS,
      init: g => randomise(g, d, PROBE_SEED ^ (0x51 * (i + 1))),
      detectCycles: false
    });
    /* mean of the last few generations, so a blinker does not read as 0
       or 1 depending on which parity the run stopped on */
    const tailLen = Math.max(3, Math.round(t.pop.length * 0.1));
    const tail = t.pop.slice(-tailLen);
    return tail.reduce((a, b) => a + b, 0) / tail.length / t.cells;
  });
  return { densities: SCAN_DENSITIES, finals, cells: size * size };
}

/* Lowest scanned density that sustains life, or null if none do. */
export function criticalFrom(scan) {
  for (let i = 0; i < scan.finals.length; i++) {
    if (scan.finals[i] > 0.02) return scan.densities[i];
  }
  return null;
}

/* Where the response curve steps: the scanned density at the top of the
 * largest jump in final density, or null if the curve has no jump.
 *
 * This is a different question from `criticalFrom`, and the difference
 * matters. "Sustains life" is satisfied by 4% of the lattice sitting frozen
 * as debris, so for B45/S14567 it answers 0.15 — while the rule's actual
 * change of character is between 0.25 and 0.35, where the final density goes
 * from 0.05 to 0.50. Starting the threshold-band probes just above 0.15 ran
 * them in the frozen-debris regime and reported no structure at all for a
 * rule that plainly has some.
 *
 * MIN_STEP keeps flat curves honest: a rule that behaves the same at every
 * density has no transition, and gets null rather than the largest ripple. */
const MIN_STEP = 0.15;
export function transitionFrom(scan) {
  let best = 0, at = null;
  for (let i = 1; i < scan.finals.length; i++) {
    const rise = scan.finals[i] - scan.finals[i - 1];
    if (rise > best) { best = rise; at = scan.densities[i]; }
  }
  return best >= MIN_STEP ? at : null;
}

PROBES.push({
  id: "scan",
  label: "Density scan",
  group: "density",
  note: "Ten short runs from 0.05 to 0.95, reporting the final density of each. Locates a survival threshold rather than merely bracketing it.",
  run: (rule, p) => scanFor(rule, p)
});

/* The density the threshold-band probes start from, in order of preference:
 *
 *   1. the density at the top of the rule's transition, where its behaviour
 *      changes character — this is the band the spatial features describe;
 *   2. failing that, just above the density at which it merely persists;
 *   3. failing that, the canonical 0.50, so the features still mean
 *      something rather than going null for every rule without a threshold.
 *
 * `zoneStart` records which of these a given record actually used. */
function zoneStartFor(rule, p) {
  const scan = scanFor(rule, p);
  const critical = criticalFrom(scan);
  const transition = transitionFrom(scan);
  const start = transition !== null ? transition
    : critical !== null ? Math.min(0.95, critical + 0.05)
    : 0.5;
  return { start, critical, transition, scan };
}

/* Threshold behaviour — blobs, zones, semi-stable structure — exists in a
   band just above a rule's critical density and vanishes above it, where the
   lattice simply fills. Measuring spatial structure at a fixed density
   therefore misses it for exactly the rules it was meant to describe.
   This probe locates the threshold first, then runs there. */
PROBES.push({
  id: "zone",
  label: "Just above threshold",
  group: "geometry",
  note: "A full-length run seeded just above the rule's own critical density. All spatial structure features are read from here, not from a fixed soup.",
  run(rule, p) {
    const { start, critical, transition } = zoneStartFor(rule, p);
    const size = Math.round(SOUP_SIZE * p.scale);
    const trace = runTrace({
      rule, w: size, h: size, gens: Math.round(SOUP_GENS * p.gens), boundary: TORUS,
      init: g => randomise(g, start, PROBE_SEED ^ 0x7a11)
    });
    trace.startDensity = start;
    trace.critical = critical;
    trace.transition = transition;
    return trace;
  }
});

/* Every other probe stops at 240 or 250 generations. Rules whose structure
   coarsens — domains merging, blobs consolidating — are still visibly
   reorganising thousands of generations later, so those probes describe a
   transient and the record calls it the rule's behaviour.
 *
 * This runs at the same density as `zone` for far longer, and keeps a
 * snapshot at exactly the short probes' horizon. That makes the honest
 * comparison possible: not just what the settled lattice looks like, but how
 * much of the short-horizon measurement survived getting there. */
PROBES.push({
  id: "settle",
  label: "Long horizon",
  group: "horizon",
  note: `A ${SETTLE_GENS}-generation run at the rule's own threshold density, with a snapshot taken at the ${SOUP_GENS}-generation horizon the other probes stop at. Says whether those probes were measuring the settled state or a transient.`,
  run(rule, p) {
    const { start, critical } = zoneStartFor(rule, p);
    const size = Math.round(SOUP_SIZE * p.scale);
    const gens = Math.round(SETTLE_GENS * p.gens);
    const horizon = Math.min(gens, Math.round(SOUP_GENS * p.gens));
    const mid = Math.round(gens / 2);
    const trace = runTrace({
      rule, w: size, h: size, gens, boundary: TORUS,
      init: g => randomise(g, start, PROBE_SEED ^ 0x5e77),
      /* Cycle detection over 1600 generations of hashes costs more than it
         buys here — `soup50` already answers whether the rule cycles. */
      detectCycles: false,
      checkpoints: [horizon, mid]
    });
    trace.startDensity = start;
    trace.critical = critical;
    trace.horizon = horizon;
    trace.midGen = mid;
    return trace;
  }
});

/* Damage spreading: the standard order/chaos separation, and a measured
   answer to the question `churns` and `structured` currently put a tuned
   activity threshold on. Two lattices from the same soup, one cell apart.
   In an ordered rule the difference stays local or dies; in a chaotic one it
   floods the lattice. */
PROBES.push({
  id: "damage",
  label: "One-cell damage",
  group: "perturbation",
  note: "Two copies of the same 0.50 soup differing in a single cell, run side by side. Reports how far that one-cell difference had spread by the end — a direct measurement of sensitivity to initial conditions rather than a threshold on activity.",
  run(rule, p) {
    const size = Math.round(SOUP_SIZE * p.scale);
    const gens = Math.round(SOUP_GENS * p.gens);
    const a = makeGrid(size, size);
    const b = makeGrid(size, size);
    randomise(a, 0.50, PROBE_SEED ^ 0x9e37);
    b.cur.set(a.cur);
    b.pop = a.pop;

    /* One cell, at the centre, chosen rather than random so the perturbation
       is identical for every rule. */
    const seedCell = (size >> 1) * size + (size >> 1);
    b.cur[seedCell] ^= 1;

    const divergence = [hammingOf(a.cur, b.cur) / (size * size)];
    for (let i = 1; i <= gens; i++) {
      step(a, rule.B, rule.S, TORUS);
      step(b, rule.B, rule.S, TORUS);
      divergence.push(hammingOf(a.cur, b.cur) / (size * size));
    }
    return { divergence, gens, cells: size * size, w: size, h: size };
  }
});

/* Whether structure repairs itself. A rule can hold a shape because it is
   genuinely stable, or because nothing has disturbed it; those look identical
   in a still frame. This lets a settled lattice run on, damages 1% of it, and
   asks whether the damage is absorbed or kept. */
PROBES.push({
  id: "heal",
  label: "Damage at threshold",
  group: "perturbation",
  note: "A run at the rule's threshold density is allowed to settle, then 1% of cells are flipped in a copy and both run on. Reports how much of that damage survived. Distinguishes structure that repairs itself from structure that merely has not been disturbed.",
  run(rule, p) {
    const { start } = zoneStartFor(rule, p);
    const size = Math.round(SOUP_SIZE * p.scale);
    const half = Math.round(SOUP_GENS * p.gens);

    const a = makeGrid(size, size);
    randomise(a, start, PROBE_SEED ^ 0x11ea1);
    for (let i = 0; i < half; i++) step(a, rule.B, rule.S, TORUS);

    const b = makeGrid(size, size);
    b.cur.set(a.cur);
    b.pop = a.pop;
    const injected = perturb(b, 0.01, PROBE_SEED ^ 0xda3e) / (size * size);

    for (let i = 0; i < half; i++) {
      step(a, rule.B, rule.S, TORUS);
      step(b, rule.B, rule.S, TORUS);
    }
    return {
      injected,
      residual: hammingOf(a.cur, b.cur) / (size * size),
      settleGens: half, gens: half * 2, cells: size * size,
      startDensity: start
    };
  }
});

/* The lattice as a variable in its own right. Every other probe runs at 64 or
   80 cells wide, and a rule that only behaves that way because 64 is a power
   of two is indistinguishable from one that behaves that way everywhere. */
PROBES.push({
  id: "odd",
  label: `Soup 0.50, ${ODD_SIZE} wide`,
  group: "boundary",
  note: `The canonical soup on a ${ODD_SIZE}x${ODD_SIZE} torus, which has no power of two in it. Differences from soup50 are the lattice size talking, not the rule — parity rules cancel themselves on a 64-wide torus and would otherwise read as dead.`,
  run: (rule, p) => runTrace({
    rule,
    w: Math.round(ODD_SIZE * p.scale) | 1, h: Math.round(ODD_SIZE * p.scale) | 1,
    gens: Math.round(SOUP_GENS * p.gens), boundary: TORUS,
    init: g => randomise(g, 0.50, PROBE_SEED ^ 0x0dd5)
  })
});

export const PROBE_BY_ID = Object.fromEntries(PROBES.map(p => [p.id, p]));

export function runProbes(rule, ids, profile = PROFILES.full) {
  const traces = {};
  for (const id of ids) {
    const probe = PROBE_BY_ID[id];
    if (!probe) throw new Error(`unknown probe: ${id}`);
    traces[id] = probe.run(rule, profile);
  }
  return traces;
}

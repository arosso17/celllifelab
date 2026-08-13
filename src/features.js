/* Features: numbers measured from traces.
 *
 * Each feature is a pure function of the traces it declares. Nothing here
 * decides anything — features are evidence, checks (checks.js) are the
 * questions you ask of it.
 *
 * To add one:
 *   { id, label, probes: ["soup50"], unit, compute(t) { ... } }
 * where `t` is an object of traces keyed by probe id. Declaring probes
 * matters: the runner only executes the probes something actually needs.
 *
 * A feature may return null to mean "not measurable for this rule". That is
 * different from zero, and everything downstream keeps the distinction.
 */

import {
  blockEntropy, lambda, components, interfaceMask, tileDensities, persistenceOf,
  borderLive
} from "./engine.js";
/* The one place a feature borrows from the probe layer: the transition is a
   property of the scan's response curve, and the band probes have to agree
   with the feature about where it is. */
import { transitionFrom } from "./probes.js";

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const tail = (a, n) => a.slice(Math.max(0, a.length - n));

/* The sample window: the last quarter of a run, so profiles scale with it. */
const windowOf = arr => tail(arr, Math.max(8, Math.round(arr.length * 0.25)));

const densityOf = t => mean(windowOf(t.pop)) / t.cells;
const activityOf = t => mean(windowOf(t.act));

/* Mass-weighted mean component size, as a fraction of all live cells.
 *
 * sum(s^2)/live^2 — the chance two live cells picked at random belong to the
 * same body. Weighting by mass is the point: a field of real blobs and a
 * lattice of scattered debris give the same large `clusterCount`, and the
 * same small `largestCluster` when the blobs are all of a size. This
 * separates them, and one stray cell barely moves it. */
function clusterScaleOf(g) {
  const { sizes } = components(g);
  const live = sizes.reduce((a, b) => a + b, 0);
  if (!live) return null;
  return sizes.reduce((a, s) => a + s * s, 0) / (live * live);
}

/* A mask snapshot from a trace, in the shape `components` and friends want. */
const maskGrid = (w, h, cur) => ({ w, h, cur });

/* Growth from a seeded run: population over initial.
 *
 * Averaged over the tail rather than read off the final frame. Many rules
 * alternate between two populations every generation — B0 rules most
 * violently — and a single frame reports whichever phase the run happened to
 * stop on, which made these features flip between two answers for reasons
 * that had nothing to do with the rule. */
const growthOf = t => mean(windowOf(t.pop)) / Math.max(1, t.pop[0]);

/* Growth on a log scale, floored at the probe's own resolution: a run that
   ended empty is recorded as "fewer than one cell of what it started with",
   not as an arbitrary epsilon that would then dominate any comparison. */
const logGrowthOf = t => {
  const start = Math.max(1, t.pop[0]);
  return Math.log2(Math.max(growthOf(t), 1 / start));
};

/* Did the pattern reach the lattice edge? Past that the run stops telling
   you about the rule and starts telling you about the box.
 *
 * Asked as "is anything alive near the border", not "does the bounding box
 * touch it". The seeded probes run on a torus, where a pattern straddling
 * the seam has a bounding box spanning the whole lattice while occupying
 * almost none of it — that reads as reaching the edge when it has not. */
const reachedOf = t => (borderLive(t.grid, 2) ? 1 : 0);

export const FEATURES = [
  {
    id: "lambda", label: "λ", unit: "0–1", probes: [],
    note: "Langton's parameter. A property of the rule alone — no simulation involved.",
    compute: (_t, rule) => lambda(rule.B, rule.S)
  },

  /* ---- density response ---- */
  {
    id: "density35", label: "dens@.35", unit: "0–1", probes: ["soup35"],
    note: "Final density from a sparse soup.",
    compute: t => densityOf(t.soup35)
  },
  {
    id: "density50", label: "dens@.50", unit: "0–1", probes: ["soup50"],
    note: "Final density from a half-filled soup. The canonical density.",
    compute: t => densityOf(t.soup50)
  },
  {
    id: "density65", label: "dens@.65", unit: "0–1", probes: ["soup65"],
    note: "Final density from a dense soup.",
    compute: t => densityOf(t.soup65)
  },
  {
    id: "densitySpread", label: "dens spread", unit: "0–1", probes: ["soup35", "soup50", "soup65"],
    note: "Largest minus smallest final density across the three soups. High means the outcome depends on how you started.",
    compute: t => {
      const d = [densityOf(t.soup35), densityOf(t.soup50), densityOf(t.soup65)];
      return Math.max(...d) - Math.min(...d);
    }
  },
  {
    id: "activity35", label: "act@.35", unit: "0–1", probes: ["soup35"],
    note: "Mean fraction of cells changing per generation, sparse start.",
    compute: t => activityOf(t.soup35)
  },
  {
    id: "activity50", label: "act@.50", unit: "0–1", probes: ["soup50"],
    note: "Mean fraction of cells changing per generation. The canonical activity.",
    compute: t => activityOf(t.soup50)
  },
  {
    id: "activity65", label: "act@.65", unit: "0–1", probes: ["soup65"],
    note: "Mean fraction of cells changing per generation, dense start.",
    compute: t => activityOf(t.soup65)
  },

  /* ---- trajectory, read from the canonical soup ---- */
  {
    id: "drift", label: "drift", unit: "0–1", probes: ["soup50"],
    note: "Std. dev. of density across the window. High means it has not converged.",
    compute: t => {
      const w = windowOf(t.soup50.pop).map(p => p / t.soup50.cells);
      const m = mean(w);
      return Math.sqrt(mean(w.map(d => (d - m) ** 2)));
    }
  },
  {
    id: "entropy", label: "entropy", unit: "0–1", probes: ["soup50"],
    note: "2x2 block entropy of the final lattice. Noise scores high, blank or striped fields low.",
    compute: t => blockEntropy(t.soup50.grid)
  },
  {
    id: "period", label: "period", unit: "gens", probes: ["soup50"],
    note: "Detected cycle length; 1 means a fixed point. null means no state repeated within the run — which is not the same as never repeating.",
    compute: t => t.soup50.cycle ? t.soup50.cycle.period : null
  },
  {
    id: "transient", label: "transient", unit: "gens", probes: ["soup50"],
    note: "Generations before the cycle began. null when no cycle was found, since the transient is then unknown.",
    compute: t => t.soup50.cycle ? t.soup50.cycle.start : null
  },
  {
    id: "runGens", label: "run", unit: "gens", probes: ["soup50"],
    note: "How long the canonical soup ran. The horizon every 'never' in a check is really relative to.",
    compute: t => t.soup50.gens
  },

  /* ---- geometry response ---- */
  {
    id: "birthOnZero", label: "B0", unit: "0/1", probes: [],
    note: "Whether the rule births on zero neighbours. Such rules fill an empty lattice on their own, so nothing a seeded probe grows can be credited to the seed. A property of the rule — no simulation needed.",
    compute: (_t, rule) => (rule.B & 1) ? 1 : 0
  },
  {
    id: "pointGrowth", label: "point", unit: "cells", probes: ["point"],
    note: "Population after seeding a single live cell, averaged over the tail so an alternating rule does not report whichever phase the run stopped on. Read together with birthOnZero: for a B0 rule this counts the background filling in, not growth from the seed.",
    compute: t => mean(windowOf(t.point.pop))
  },
  {
    id: "pointDensity", label: "point dens", unit: "0–1", probes: ["point"],
    note: "Mean density over the tail of the single-point run. Near 1 means the lattice was flooded rather than structured. Averaged rather than read off the last frame because many B0 rules alternate between full and empty every generation, so a single frame reports whichever phase the run stopped on.",
    compute: t => densityOf(t.point)
  },
  {
    id: "pointReach", label: "point→wall", unit: "0/1", probes: ["point"],
    note: "Growth from one cell reached the lattice edge.",
    compute: t => reachedOf(t.point)
  },
  {
    id: "outlineGrowth", label: "outline", unit: "ratio", probes: ["outline"],
    note: "Final over initial population from a hollow 12x12 square.",
    compute: t => growthOf(t.outline)
  },
  {
    id: "halfGrowth", label: "blob½", unit: "ratio", probes: ["half"],
    note: "Final over initial population from a half-filled 12x12 patch.",
    compute: t => growthOf(t.half)
  },
  {
    id: "halfReach", label: "blob½→wall", unit: "0/1", probes: ["half"],
    note: "The half-filled blob reached the lattice edge.",
    compute: t => reachedOf(t.half)
  },
  {
    id: "solidGrowth", label: "solid", unit: "ratio", probes: ["solid"],
    note: "Final over initial population from a solid 12x12 block.",
    compute: t => growthOf(t.solid)
  },
  {
    id: "shapeSpread", label: "shape spread", unit: "ratio", probes: ["outline", "half", "solid"],
    note: "Largest minus smallest growth across the three 12x12 seeds. High means the rule responds to shape, not just to how many cells you gave it. A difference of unbounded ratios, so it has a long tail — shapeContrast is the same comparison on a log scale, and is the better plot axis.",
    compute: t => {
      const g = [growthOf(t.outline), growthOf(t.half), growthOf(t.solid)];
      return Math.max(...g) - Math.min(...g);
    }
  },
  {
    id: "shapeContrast", label: "shape contrast", unit: "log ratio", probes: ["outline", "half", "solid"],
    note: "The ratio between the largest and smallest of the three 12x12 growths, as a base-2 log: 1 means one seed grew twice as far as another, 10 means a thousandfold. Unlike shapeSpread this does not let one explosive seed swamp the axis, so classes stay visible on a plot. A seed that died is floored at one cell of its own starting population — the finest growth the probe can resolve — rather than at an arbitrary epsilon.",
    compute: t => {
      const g = [t.outline, t.half, t.solid].map(logGrowthOf);
      return Math.max(...g) - Math.min(...g);
    }
  },

  /* ---- spatial structure ----
     Everything above is a lattice-wide average, and averages cannot tell a
     partitioned lattice from a uniform one of the same density.

     These are read from the `zone` probe — a run seeded just above the rule's
     own critical density — not from the fixed 0.50 soup. Blob and zone
     behaviour lives in a narrow band above threshold and disappears above it,
     so a fixed density measures the wrong regime for exactly the rules these
     features exist to describe. */
  {
    id: "clusterCount", label: "clusters", unit: "n", probes: ["zone"],
    note: "Connected components of live cells, 8-connectivity, wrapping. Debris fragments into many; blobs consolidate into few.",
    compute: t => components(t.zone.grid).count
  },
  {
    id: "largestCluster", label: "largest", unit: "0–1", probes: ["zone"],
    note: "Biggest component as a fraction of all live cells. Near 1 means one structure holds everything; near 0 means scattered debris.",
    compute: t => {
      const g = t.zone.grid;
      const live = g.cur.reduce((a, b) => a + b, 0);
      if (!live) return null;
      return components(g).largest / live;
    }
  },
  {
    id: "interfaceRatio", label: "interface", unit: "0–1", probes: ["zone"],
    note: "Live cells having at least one dead neighbour, over all live cells. Compact blobs are mostly interior and score low; debris is all surface and scores high.",
    compute: t => {
      const g = t.zone.grid;
      const live = g.cur.reduce((a, b) => a + b, 0);
      if (!live) return null;
      const mask = interfaceMask(g);
      let n = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i] && g.cur[i]) n++;
      return n / live;
    }
  },
  {
    id: "emptyTiles", label: "empty tiles", unit: "0–1", probes: ["zone"],
    note: "Fraction of 8x8 tiles that are essentially empty. A uniform soup has none; a lattice split into occupied and vacant zones has many.",
    compute: t => {
      const tiles = tileDensities(t.zone.grid, 8);
      if (!tiles.length) return null;
      return tiles.filter(d => d < 0.02).length / tiles.length;
    }
  },
  {
    id: "zoneDensity", label: "zone dens", unit: "0–1", probes: ["zone"],
    note: "Mean density of the non-empty tiles only. Read with `emptyTiles`: together they describe a two-mode lattice that a single global density averages away.",
    compute: t => {
      const occupied = tileDensities(t.zone.grid, 8).filter(d => d >= 0.02);
      if (!occupied.length) return null;
      return occupied.reduce((a, b) => a + b, 0) / occupied.length;
    }
  },
  {
    id: "liveFrozen", label: "live frozen", unit: "0–1", probes: ["zone"],
    note: "Fraction of live cells that never changed during the sampled window. Conditioned on live cells — unconditioned, every mostly-empty lattice scores high for uninteresting reasons.",
    compute: t => {
      const { grid, changes } = t.zone;
      let live = 0, frozen = 0;
      for (let i = 0; i < grid.cur.length; i++) {
        if (!grid.cur[i]) continue;
        live++;
        if (changes[i] === 0) frozen++;
      }
      return live ? frozen / live : null;
    }
  },
  {
    id: "activityAtEdge", label: "act at edge", unit: "0–1", probes: ["zone"],
    note: "Of the cells that changed recently, the fraction sitting on a live/dead interface. Near 1 is a static interior with a boiling coastline; near the interface ratio itself means the churn is everywhere.",
    compute: t => {
      const { grid, changes } = t.zone;
      const mask = interfaceMask(grid);
      let changed = 0, atEdge = 0;
      for (let i = 0; i < changes.length; i++) {
        if (!changes[i]) continue;
        changed++;
        if (mask[i]) atEdge++;
      }
      return changed ? atEdge / changed : null;
    }
  },
  {
    id: "persistence", label: "persistence", unit: "0–1", probes: ["zone"],
    note: "Overlap between the live cells now and one window ago, normalised against chance. 1 is frozen in place, 0 is no more overlap than two random lattices of the same density.",
    compute: t => {
      const { grid, maskBefore } = t.zone;
      return maskBefore ? persistenceOf(maskBefore, grid.cur) : null;
    }
  },

  {
    id: "clusterScale", label: "cluster scale", unit: "0–1", probes: ["zone"],
    note: "Mass-weighted mean component size as a fraction of live cells: the chance two live cells belong to the same body. Near 1 is one structure holding everything; a field of n equal blobs gives about 1/n. Unlike clusterCount, scattered debris barely moves it.",
    compute: t => clusterScaleOf(t.zone.grid)
  },
  {
    id: "edgeRoughness", label: "roughness", unit: "ratio", probes: ["zone"],
    note: "Component perimeter over the perimeter a compact square of the same area would have, mass-weighted. 1 is a smooth-edged solid body; large values mean lacy or dithered fill, where almost every cell is on a boundary.",
    compute: t => {
      const { parts } = components(t.zone.grid);
      const live = parts.reduce((a, p) => a + p.size, 0);
      if (!live) return null;
      /* A solid square of area s has perimeter 4*sqrt(s); weight each body by
         its mass so a thousand single cells cannot outvote one real blob. */
      const sum = parts.reduce((a, p) => a + p.size * (p.perimeter / (4 * Math.sqrt(p.size))), 0);
      return sum / live;
    }
  },
  {
    id: "tileClumping", label: "clumping", unit: "ratio", probes: ["zone"],
    note: "Spread of 8x8 tile densities against what a uniform random lattice of the same density would give. 1 is indistinguishable from a uniform soup; above 1 means the live cells are gathered into some regions and absent from others. A single number for what emptyTiles and zoneDensity say together.",
    compute: t => {
      const tiles = tileDensities(t.zone.grid, 8);
      if (tiles.length < 2) return null;
      const p = mean(tiles);
      if (p <= 0 || p >= 1) return null;
      const sd = Math.sqrt(mean(tiles.map(d => (d - p) ** 2)));
      /* A uniform random lattice tiles binomially: sd = sqrt(p(1-p)/n). */
      const expected = Math.sqrt(p * (1 - p) / 64);
      return sd / expected;
    }
  },

  {
    id: "zoneStart", label: "zone @", unit: "0–1", probes: ["zone"],
    note: "The starting density the spatial features above were measured at: this rule's transition density, or just above its critical density if the response curve has no step, or 0.50 if it has neither.",
    compute: t => t.zone.startDensity
  },

  /* ---- survival threshold ---- */
  {
    id: "criticalDensity", label: "critical", unit: "0–1", probes: ["scan"],
    note: "Lowest scanned starting density at which the rule sustains life. null if it dies at every density; equal to the lowest scanned value when it needs no threshold at all.",
    compute: t => {
      const { densities, finals } = t.scan;
      for (let i = 0; i < finals.length; i++) if (finals[i] > 0.02) return densities[i];
      return null;
    }
  },
  {
    id: "transitionDensity", label: "transition", unit: "0–1", probes: ["scan"],
    note: "The scanned density at the top of the largest jump in the response curve — where the rule changes character, as opposed to where it merely stops dying. null when the curve has no jump, which is itself informative: the rule does the same thing at every density. This is what the threshold-band probes start from.",
    compute: t => transitionFrom(t.scan)
  },
  {
    id: "sustainRange", label: "sustains", unit: "0–1", probes: ["scan"],
    note: "Fraction of the ten scanned densities at which the rule sustains life. 1 means it never needs a threshold; a middling value means it is fussy about how it starts.",
    compute: t => t.scan.finals.filter(d => d > 0.02).length / t.scan.finals.length
  },

  /* ---- the long horizon ----
     Every feature above is read at 240 or 250 generations. These say whether
     that horizon was long enough for this rule, and what it looks like once
     it has had time to settle. */
  {
    id: "lateDensity", label: "late dens", unit: "0–1", probes: ["settle"],
    note: "Density at the end of the long run, at the rule's own threshold density.",
    compute: t => densityOf(t.settle)
  },
  {
    id: "lateActivity", label: "late act", unit: "0–1", probes: ["settle"],
    note: "Activity at the end of the long run. Compare with act@.50: a rule still churning after 1600 generations is not merely slow to settle.",
    compute: t => activityOf(t.settle)
  },
  {
    id: "horizonShift", label: "horizon shift", unit: "0–1", probes: ["settle"],
    note: "How far the density moved between the short probes' horizon and the end of the long run. Near zero means the short probes measured the settled state; large means every other feature in this record describes a transient.",
    compute: t => {
      const mark = t.settle.marks.get(t.settle.horizon);
      if (!mark) return null;
      return Math.abs(mark.pop / t.settle.cells - densityOf(t.settle));
    }
  },
  {
    id: "lateClusterScale", label: "late scale", unit: "0–1", probes: ["settle"],
    note: "Mass-weighted mean component size at the end of the long run. Read against clusterScale: the same quantity measured 1360 generations earlier.",
    compute: t => clusterScaleOf(t.settle.grid)
  },
  {
    id: "coarsening", label: "coarsening", unit: "ratio", probes: ["settle"],
    note: "Late cluster scale over the cluster scale at the short horizon. Above 1 means bodies were still merging after the other probes had stopped watching — the signature of a coarsening rule. null when nothing was alive at either point.",
    compute: t => {
      const mark = t.settle.marks.get(t.settle.horizon);
      if (!mark) return null;
      const early = clusterScaleOf(maskGrid(mark.w, mark.h, mark.cur));
      const late = clusterScaleOf(t.settle.grid);
      if (early === null || late === null || early === 0) return null;
      return late / early;
    }
  },
  {
    id: "holdLate", label: "hold", unit: "0–1", probes: ["settle"],
    note: "Overlap between the live cells halfway through the long run and at its end, normalised against chance. 1 means the structure stopped moving; 0 means the lattice at the end has no more in common with the middle than two random lattices would.",
    compute: t => {
      const mark = t.settle.marks.get(t.settle.midGen);
      return mark ? persistenceOf(mark.cur, t.settle.grid.cur) : null;
    }
  },

  /* ---- sensitivity to perturbation ----
     Whether a rule keeps or forgets a small difference. This is what the
     order/chaos distinction actually rests on; activity is only a proxy. */
  {
    id: "damageSpread", label: "damage", unit: "0–1", probes: ["damage"],
    note: "Fraction of the lattice differing at the end between two runs of the same soup that began one cell apart. Zero means the difference was forgotten; large means it reached everywhere. Measured, not inferred from an activity threshold.",
    compute: t => mean(windowOf(t.damage.divergence))
  },
  {
    id: "damageOnset", label: "damage @", unit: "gens", probes: ["damage"],
    note: "Generation at which the one-cell difference first covered 1% of the lattice. null means it never did within the run — which includes rules that swallow it entirely.",
    compute: t => {
      const d = t.damage.divergence;
      for (let i = 0; i < d.length; i++) if (d[i] > 0.01) return i;
      return null;
    }
  },
  {
    id: "healing", label: "healing", unit: "0–1", probes: ["heal"],
    note: "How much of a 1% injury to a settled lattice was repaired: 1 means the damage vanished, 0 means it survived at its original size or grew. Structure that holds because it is stable scores high; structure that merely has not been disturbed does not. Clamped at 0 — a rule that amplifies the injury has no more healing than one that merely keeps it, and damageSpread is where amplification shows.",
    compute: t => {
      const { injected, residual } = t.heal;
      if (!injected) return null;
      return Math.max(0, 1 - residual / injected);
    }
  },

  /* ---- boundary and lattice ---- */
  {
    id: "wallEffect", label: "wall effect", unit: "0–1", probes: ["soup50", "walled"],
    note: "How much the activity changes when the torus is replaced by dead edges. Large means the topology was doing the work.",
    compute: t => Math.abs(activityOf(t.soup50) - activityOf(t.walled))
  },
  {
    id: "sizeEffect", label: "size effect", unit: "0–1", probes: ["soup50", "odd"],
    note: "How much the final density changes on a torus whose width has no power of two in it. Large means the 64-wide lattice was doing the work, not the rule — parity rules cancel themselves on a power of two and read as dead. Density rather than activity, because that is where the cancellation shows.",
    compute: t => Math.abs(densityOf(t.soup50) - densityOf(t.odd))
  }
];

export const FEATURE_BY_ID = Object.fromEntries(FEATURES.map(f => [f.id, f]));

/* Every probe any feature needs. */
export function requiredProbes(features = FEATURES) {
  return [...new Set(features.flatMap(f => f.probes))];
}

/* A cheap subset for sweeping thousands of rules: the canonical soup and the
   single point. Checks needing anything else report n/a on these records
   rather than guessing — see `needs` in checks.js. */
export const SWEEP_FEATURES = FEATURES.filter(f =>
  f.probes.every(p => p === "soup50" || p === "point"));

/* A feature may return null ("not measurable"). Anything else non-finite is
   a bug in the feature — NaN from a division by zero on a dead lattice —
   so it collapses to 0 rather than propagating. */
export function computeFeatures(traces, rule, features = FEATURES) {
  const out = {};
  for (const f of features) {
    const value = f.compute(traces, rule);
    out[f.id] = value === null ? null : (Number.isFinite(value) ? value : 0);
  }
  return out;
}

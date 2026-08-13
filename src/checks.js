/* Checks: the explicit tests you run against a rule.
 *
 * ==========================================================================
 *  THIS IS THE FILE TO EDIT. Everything else is plumbing.
 * ==========================================================================
 *
 * A check is one named question with a definite answer. It gets the feature
 * vector `f` (see features.js) and returns:
 *
 *   - a boolean          -> shown as yes / no
 *   - a number           -> shown as a number
 *   - a string           -> shown as a label
 *   - null or undefined  -> shown as "n/a", meaning the question does not
 *                           apply to this rule
 *
 * Declare `needs: [...]` listing the features the check reads. If a record
 * was measured without them — a cheap sweep, or an import from an older
 * feature set — the check reports n/a instead of answering from absent data.
 * A missing measurement must never read as a "no".
 *
 * Checks are independent. There is deliberately no ordering, no first-match
 * rule, and no single verdict — a rule is just the set of answers it gave.
 * If you later want a higher-level classification on top of these results,
 * it can read the check results the same way checks read features.
 *
 * To add one: append to CHECKS. It appears as a column in the results table
 * and as a colouring option on the scatter plot. Nothing else needs changing.
 */

/* An empty lattice answers "no" to every question about dynamics, which
   reads as evidence when it is really an absence of it. Questions about how
   a living lattice behaves return n/a when there is nothing left alive. */
const isDead = f => f.density50 < 0.002;

/* No state repeated within the run. Not the same as "never repeats" — the
   run just ended first. Every "never" below is relative to `runGens`. */
const noCycleFound = f => f.period === null || f.period === undefined;

export const CHECKS = [
  {
    id: "extinct",
    label: "extinct",
    note: "Nothing survives the canonical 0.50 soup.",
    needs: ["density50"],
    run: f => isDead(f)
  },
  {
    id: "extinctAtAny",
    label: "dies at any density",
    note: "Dies from at least one of the three soups. Combined with `extinctAtAll` this locates a threshold rather than merely detecting one.",
    needs: ["density35", "density50", "density65"],
    run: f => f.density35 < 0.002 || f.density50 < 0.002 || f.density65 < 0.002
  },
  {
    id: "extinctAtAll",
    label: "dies at every density",
    note: "Dies from all three soups. This is a genuinely dead rule, not a threshold.",
    needs: ["density35", "density50", "density65"],
    run: f => f.density35 < 0.002 && f.density50 < 0.002 && f.density65 < 0.002
  },
  {
    id: "densityGated",
    label: "density-gated",
    note: "Dies sparse but lives dense: there is a survival threshold between 0.35 and 0.65.",
    needs: ["density35", "density65"],
    run: f => f.density35 < 0.01 && f.density65 > 0.05
  },
  {
    id: "densitySensitive",
    label: "density-sensitive",
    note: "The final density depends substantially on the starting density — the rule does not forget how it began.",
    needs: ["densitySpread"],
    run: f => f.densitySpread > 0.1
  },
  {
    id: "saturated",
    label: "saturated",
    note: "The lattice fills solid and stays there.",
    needs: ["density50"],
    run: f => f.density50 > 0.998
  },
  {
    id: "frozen",
    label: "frozen",
    note: "Reaches a fixed point with something still alive. n/a for extinct rules, where zero activity means zero cells, not a frozen structure.",
    needs: ["density50", "activity50"],
    run: f => (isDead(f) ? null : f.activity50 < 0.001)
  },
  {
    id: "settles",
    label: "settles",
    note: "A state repeated within the run, so the trajectory is now periodic. `period` says how long.",
    needs: ["period"],
    run: f => !noCycleFound(f)
  },
  {
    id: "shortPeriod",
    label: "short period",
    note: "Cycles with a period of 8 or less — still lifes and small oscillators. n/a if no cycle was found.",
    needs: ["period", "density50"],
    run: f => (noCycleFound(f) || isDead(f) ? null : f.period <= 8)
  },
  {
    id: "churns",
    label: "churns",
    note: "Did not settle within the run and keeps a large fraction of the lattice changing.",
    needs: ["period", "activity50", "density50"],
    run: f => (isDead(f) ? null : noCycleFound(f) && f.activity50 > 0.14)
  },
  {
    id: "structured",
    label: "structured",
    note: "Did not settle within the run, but is changing slowly — the interesting middle. A statement about `runGens` generations, not about forever.",
    needs: ["period", "activity50", "density50"],
    run: f => (isDead(f) ? null : noCycleFound(f) && f.activity50 >= 0.006 && f.activity50 <= 0.14)
  },
  {
    id: "fillsFromEmpty",
    label: "fills from empty",
    note: "Births on zero neighbours, so an empty lattice fills on its own. Nothing a seeded probe grows can be credited to the seed.",
    needs: ["birthOnZero"],
    run: f => f.birthOnZero === 1
  },
  {
    id: "buildsFromNothing",
    label: "builds from a point",
    note: "A single live cell grows into substantial structure. n/a for B0 rules, where the lattice fills with or without the seed, and false when the result is a flood rather than structure.",
    needs: ["birthOnZero", "pointGrowth", "pointDensity"],
    run: f => (f.birthOnZero === 1 ? null : f.pointGrowth > 10 && f.pointDensity < 0.9)
  },
  {
    id: "floodsFromPoint",
    label: "floods from point",
    note: "The single-point run ends with the lattice almost solid — growth without structure, whatever caused it.",
    needs: ["pointDensity"],
    run: f => f.pointDensity > 0.9
  },
  {
    id: "growsFromBlob",
    label: "grows from blob",
    note: "The half-filled 12x12 patch expands rather than evaporating.",
    needs: ["halfGrowth"],
    run: f => f.halfGrowth > 1.5
  },
  {
    id: "unbounded",
    label: "unbounded",
    note: "Growth from a seed reached the lattice edge — it was still expanding when the run stopped.",
    needs: ["pointReach", "halfReach"],
    run: f => f.pointReach === 1 || f.halfReach === 1
  },
  {
    id: "sparseOnly",
    label: "sparse-only",
    note: "Dies from a soup but grows from a small seed. A soup probe alone would misread this.",
    needs: ["density50", "halfGrowth", "pointGrowth"],
    run: f => isDead(f) && (f.halfGrowth > 1.5 || f.pointGrowth > 10)
  },
  {
    id: "shapeSensitive",
    label: "shape-sensitive",
    note: "Outline, half-filled and solid 12x12 seeds grow very differently — the rule responds to shape, not just to cell count.",
    needs: ["shapeSpread"],
    run: f => f.shapeSpread > 2
  },
  {
    id: "interiorMatters",
    label: "interior matters",
    note: "A solid block behaves differently from a hollow one of the same footprint.",
    needs: ["solidGrowth", "outlineGrowth"],
    run: f => Math.abs(f.solidGrowth - f.outlineGrowth) > 1
  },
  {
    id: "wallSensitive",
    label: "wall-sensitive",
    note: "Behaves measurably differently on a bounded lattice than on a torus.",
    needs: ["wallEffect"],
    run: f => f.wallEffect > 0.02
  },
  {
    id: "texture",
    label: "texture",
    note: "Coarse description of the final lattice from its block entropy.",
    needs: ["density50", "entropy"],
    run: f => {
      if (f.density50 < 0.002 || f.density50 > 0.998) return "uniform";
      if (f.entropy > 0.85) return "noise";
      if (f.entropy > 0.4) return "mixed";
      return "sparse";
    }
  }
];

export const CHECK_BY_ID = Object.fromEntries(CHECKS.map(c => [c.id, c]));

const measured = (features, id) => features[id] !== undefined;

export function runChecks(features, checks = CHECKS) {
  const out = {};
  for (const c of checks) {
    /* A check whose inputs were never measured has no answer — saying "no"
       would turn a gap in the data into a claim about the rule. */
    if (c.needs && !c.needs.every(id => measured(features, id))) {
      out[c.id] = null;
      continue;
    }
    let value;
    try {
      value = c.run(features);
    } catch (err) {
      value = null;
      if (typeof console !== "undefined") console.warn(`check "${c.id}" threw:`, err);
    }
    out[c.id] = value === undefined ? null : value;
  }
  return out;
}

/* How a check's answers should be displayed and filtered. */
export function checkKind(id, records) {
  for (const r of records) {
    const v = r.checks?.[id];
    if (v === null || v === undefined) continue;
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number") return "number";
    return "string";
  }
  return "unknown";
}

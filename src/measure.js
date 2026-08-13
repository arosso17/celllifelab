/* Runs a rule: probes -> traces -> features -> check results.
 *
 * The only thing stored is evidence. No verdict is computed here, and none is
 * stored on the record — check results are derived from features on demand,
 * so editing checks.js reclassifies everything already measured without
 * re-running a single generation.
 */

import { formatRule } from "./engine.js";
import { PROFILES, runProbes } from "./probes.js";
import { FEATURES, computeFeatures, requiredProbes } from "./features.js";
import { CHECKS, runChecks } from "./checks.js";

export function measureRule(rule, {
  profile = "full",
  features = FEATURES,
  checks = CHECKS
} = {}) {
  const p = PROFILES[profile] ?? PROFILES.full;
  const probesRun = requiredProbes(features);
  const traces = runProbes(rule, probesRun, p);
  const f = computeFeatures(traces, rule, features);
  return {
    rule: formatRule(rule.B, rule.S),
    B: rule.B,
    S: rule.S,
    profile,
    /* Which probes actually ran. A record measured with fewer is not wrong,
       but it can only answer the checks whose features it has — the table
       shows this as a coverage fraction so partial data is never silent. */
    probesRun,
    features: f,
    checks: runChecks(f, checks),
    measuredAt: Date.now()
  };
}

/* How complete a record is, for deciding which of two to keep. */
export function coverage(record) {
  return (record.probesRun?.length ?? 0) * 10 + (record.profile === "full" ? 1 : 0);
}

/* Re-derive check results for an already-measured record. Cheap: it only
   re-runs the predicates over the stored feature vector. */
export function rechecked(record, checks = CHECKS) {
  return { ...record, checks: runChecks(record.features, checks) };
}

/* Which features a record does not have yet.
 *
 * Absent means `undefined` — never computed. A stored `null` means the
 * feature ran and reported "not measurable for this rule", which is an
 * answer, so it is left alone rather than recomputed on every backfill. */
export function missingFeatures(record, features = FEATURES) {
  return features.filter(f => record.features?.[f.id] === undefined);
}

/* Run only the probes the missing features need, and return just those
   values. Existing measurements are never re-run: adding a feature or a
   probe costs you the new probes, not the whole set again.
   Returns null when the record is already complete. */
export function measureMissing(record, features = FEATURES) {
  const missing = missingFeatures(record, features);
  if (!missing.length) return null;

  /* Measure at the profile the record was originally taken at, so the new
     numbers are comparable with the ones already sitting beside them. */
  const p = PROFILES[record.profile] ?? PROFILES.full;
  const probes = requiredProbes(missing);
  const rule = { B: record.B, S: record.S };
  const traces = runProbes(rule, probes, p);

  return {
    features: computeFeatures(traces, rule, missing),
    probes,
    ids: missing.map(f => f.id)
  };
}

/* The measurement store.
 *
 * Records hold features only. Check results are re-derived on read, so
 * editing checks.js updates every stored record immediately.
 */

import { rechecked, coverage } from "./measure.js";
import { parseRule } from "./engine.js";

/* Bumped when the feature set changes shape: v2 records key their features
   by ids that no longer exist, and checks would report n/a for all of them.
   Export before bumping if you want the old numbers.
 *
 * v4: several features were redefined rather than added — the growth
 * features and pointGrowth now average the tail instead of reading the final
 * frame, the reach features ask whether anything is near the border instead
 * of trusting a bounding box on a torus, and the threshold-band probes start
 * from the rule's transition rather than just above where it stops dying,
 * which moves every spatial feature. A v3 value under those ids is not
 * wrong so much as answering a different question, and backfill would leave
 * it alone because it is present. Re-measure rather than backfill. */
const KEY = "ca-lab.records.v4";
const CAP = 20000;

/* Bumping the key changes which key is read. It never deletes the old one, so
   everything written under a previous version is still there. Newest first. */
const LEGACY_KEYS = ["ca-lab.records.v3", "ca-lab.records.v2"];

/* Set once the carry-forward below has run, so a class you deliberately
   cleared afterwards does not come back on every reload. */
const CARRIED_KEY = "ca-lab.carried.v4";

/* localStorage may be unavailable (private mode, some embeddings). Fall back
   to memory rather than failing, and say which is in use. It is now only the
   fallback: the store proper lives on disk, behind the server. */
const backing = (() => {
  try {
    localStorage.setItem("__probe", "1");
    localStorage.removeItem("__probe");
    return { persistent: true, get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
  } catch {
    const mem = new Map();
    return { persistent: false, get: k => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  }
})();

export const persistent = backing.persistent;

/* Records on disk, as JSON lines: one record per line, later lines winning.
 *
 * Appending is the point. A sweep writing thousands of rules costs its own
 * bytes rather than rewriting the whole store on every batch, and there is no
 * size ceiling to bump into — which is the difference between "20,000
 * records" and "all 262,144 rules". Duplicates accumulate as records are
 * re-measured; `compact` folds them away. */
export function parseJSONL(text) {
  const map = new Map();
  let lines = 0, bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    try {
      const rec = JSON.parse(line);
      /* Later wins: re-measuring a rule appends rather than overwrites. */
      if (rec?.rule) map.set(rec.rule, rec);
    } catch {
      bad++;                  // a truncated last line survives as a skipped line
    }
  }
  return { records: [...map.values()], lines, bad };
}

const disk = {
  available: false,
  path: null,
  lines: 0,

  async probe() {
    try {
      const res = await fetch("/api/stats", { cache: "no-store" });
      if (!res.ok) return false;
      const s = await res.json();
      this.available = true;
      this.path = s.path;
      this.lines = s.lines;
      return true;
    } catch {
      return false;           // opened without the server, or a static host
    }
  },

  /* Read the response as it arrives rather than as one string.
     `await res.text()` on a store of a quarter of a million rules is a few
     hundred megabytes in a single string, and `split("\n")` then makes a
     second copy of all of it as an array of substrings before a single record
     exists. Both fit in the numbers on paper and neither fits in a renderer:
     this is what took the tab down with STATUS_BREAKPOINT. Streaming holds one
     chunk and the parsed records, and nothing in between. */
  async load(onProgress) {
    const res = await fetch("/api/records", { cache: "no-store" });
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body?.getReader) return parseJSONL(await res.text());   // no streams; tests, old browsers

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const map = new Map();
    let rest = "", lines = 0, bad = 0, seen = 0;

    const take = line => {
      if (!line.trim()) return;
      lines++;
      try {
        const rec = JSON.parse(line);
        if (rec?.rule) map.set(rec.rule, rec);   // later wins, as in parseJSONL
      } catch {
        bad++;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      rest += decoder.decode(value, { stream: true });
      let nl, from = 0;
      while ((nl = rest.indexOf("\n", from)) !== -1) {
        take(rest.slice(from, nl));
        from = nl + 1;
      }
      rest = rest.slice(from);
      onProgress?.(seen, total);
    }
    take(rest + decoder.decode());

    return { records: [...map.values()], lines, bad };
  },

  async append(records) {
    if (!records.length) return;
    const res = await fetch("/api/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(records.map(stripDerived))
    });
    if (res.ok) this.lines = (await res.json()).lines;
  },

  /* Fold duplicates on the server, which reads the file it already has.
     Sending a snapshot instead means serialising the whole store in the page
     first — the same few hundred megabytes in one string that loading used to
     build, and the same crash. */
  async compactInPlace() {
    const res = await fetch("/api/compact", { method: "POST" });
    if (res.ok) this.lines = (await res.json()).lines;
  },

  /* Rewrite from a snapshot. For emptying or replacing the store, where the
     file must end up matching what the caller holds — folding in place would
     keep every record the caller just dropped. */
  async compact(records) {
    const res = await fetch("/api/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(records.map(stripDerived))
    });
    if (res.ok) this.lines = (await res.json()).lines;
  }
};

/* What goes to disk. Check results are re-derived from checks.js on every
   read, so a stored copy is never read — and it was 145 MB of a 682 MB
   store here. */
function stripDerived(rec) {
  if (!rec?.checks) return rec;
  const { checks, ...rest } = rec;
  return rest;
}

export class RecordStore {
  constructor(load = true) {
    this.map = new Map();
    this.listeners = new Set();
    /* Rules changed since the last flush. Only these get written, so labelling
       one rule does not rewrite a store of a quarter of a million. */
    this.dirty = new Set();
    this.mode = "memory";
    this.flushTimer = null;
    if (load) this.load();
  }

  /* Synchronous localStorage load, kept for the fallback and for tests. */
  load() {
    try {
      const raw = backing.get(KEY);
      if (!raw) return;
      for (const rec of JSON.parse(raw)) this.map.set(rec.rule, rec);
      this.mode = backing.persistent ? "localStorage" : "memory";
    } catch {
      /* corrupt or unreadable; start clean rather than throwing */
    }
  }

  /* Open the disk store, falling back to localStorage if the server is not
     there. Returns a description of what happened, for the status line. */
  async open({ readonly = false, dataURL = "data/index.json" } = {}) {
    if (readonly) return this.openPublished(dataURL);

    if (!(await disk.probe())) {
      this.load();
      return { mode: this.mode, migrated: 0, path: null };
    }

    const { records, lines, bad } = await disk.load();
    for (const rec of records) this.map.set(rec.rule, rec);
    this.mode = "disk";

    /* First run against a fresh file: bring across whatever localStorage was
       holding, so switching to disk does not look like losing everything. */
    let migrated = 0;
    if (!records.length) {
      const before = this.map.size;
      this.load();                        // reads the localStorage copy in
      this.mode = "disk";
      migrated = this.map.size - before;
      if (migrated) {
        for (const rule of this.map.keys()) this.dirty.add(rule);
        await this.flush();
      }
    }

    /* Re-measuring appends, so duplicate lines pile up. Fold them away when
       they outnumber the records by half again. */
    if (lines > this.map.size * 1.5 + 32) await this.compact();

    return { mode: this.mode, migrated, path: disk.path, lines: disk.lines, bad };
  }

  /* A published dataset: one static JSONL file, no server behind it.
   *
   * Nothing is written anywhere — not to disk, not to localStorage — so every
   * visitor sees the same rules and the page carries no state between visits.
   * `save`, `flush` and `compact` all no-op in this mode, which is what makes
   * it safe to leave the rest of the pipeline untouched: measuring a rule
   * still works and still shows, it just never persists.
   *
   * The dataset is a manifest naming one or more JSONL parts, not a single
   * file. Splitting it is not premature: measured rules run about 2 KB each,
   * so all 262,144 would be some hundreds of megabytes — past what a static
   * host will serve as one object. One part today, many later, and the loader
   * does not change when that happens.
   *
   * A missing or unreachable file is reported rather than thrown, so the page
   * still comes up with a working bench and an empty table. */
  async openPublished(url) {
    this.mode = "published";
    const base = url.slice(0, url.lastIndexOf("/") + 1);
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const manifest = await res.json();
      const parts = manifest?.parts ?? [];
      if (!Array.isArray(parts) || !parts.length) throw new Error("manifest names no parts");

      let lines = 0, bad = 0;
      for (const part of parts) {
        const r = await fetch(base + part, { cache: "no-cache" });
        if (!r.ok) throw new Error(`${part}: ${r.status} ${r.statusText}`);
        const got = parseJSONL(await r.text());
        for (const rec of got.records) this.map.set(rec.rule, rec);
        lines += got.lines;
        bad += got.bad;
      }
      return { mode: this.mode, migrated: 0, path: url, lines, bad,
               parts: parts.length, generated: manifest.generated ?? null };
    } catch (err) {
      return { mode: this.mode, migrated: 0, path: url, lines: 0, bad: 0,
               error: String(err?.message ?? err) };
    }
  }

  /* Rewrite the file from what is in memory, dropping superseded lines. */
  async compact() {
    if (this.mode !== "disk") return null;
    await disk.compactInPlace();
    return disk.lines;
  }

  stats() {
    return { mode: this.mode, path: disk.path, lines: disk.lines, records: this.map.size };
  }

  /* Carry hand-made work forward from a previous storage version.
   *
   * Only the things you wrote — class, note, name — and never the numbers:
   * the whole reason for a key bump is that stored features answer a question
   * the current code no longer asks, and a stale number that looks measured
   * is worse than an absent one. What arrives is a record with no features at
   * all, which reads as 0/14 probes and n/a everywhere until Backfill runs.
   *
   * Never overwrites a label or note already here, so it is safe to run
   * repeatedly, and it marks itself done so a class you clear afterwards
   * stays cleared. Returns what it found. */
  carryForward(keys = LEGACY_KEYS, { force = false } = {}) {
    const result = { rules: 0, labels: 0, notes: 0, from: null, alreadyRun: false };
    if (this.mode === "published") { result.alreadyRun = true; return result; }
    if (!force && backing.get(CARRIED_KEY)) { result.alreadyRun = true; return result; }

    for (const key of keys) {
      let list;
      try {
        const raw = backing.get(key);
        if (!raw) continue;
        list = JSON.parse(raw);
        if (!Array.isArray(list)) continue;
      } catch {
        continue;                       // unreadable; try the next one
      }

      const found = this.mergeAnnotations(list, key);
      result.rules += found.rules;
      result.labels += found.labels;
      result.notes += found.notes;
      if (found.rules) { result.from = key; break; }
    }

    if (result.rules) { this.save(); this.emit(); }
    try { backing.set(CARRIED_KEY, "1"); } catch { /* no storage; it will retry next load */ }
    return result;
  }

  /* The merge itself, taking the old records directly — which is also how an
     exported file from any version can be stripped down to just the parts you
     wrote by hand. Does not save or emit; the callers do. */
  mergeAnnotations(list, from = "import") {
    const result = { rules: 0, labels: 0, notes: 0 };
    for (const old of list) {
      /* A sweep row with nothing of yours on it carries nothing worth
         keeping — its numbers are stale and its identity is just a rule. */
      if (!old?.rule || (!old.label && !old.note && !old.name)) continue;
      const rec = this.map.get(old.rule);
      if (rec) {
        if (old.label && !rec.label) { rec.label = old.label; result.labels++; }
        if (old.note && !rec.note) { rec.note = old.note; result.notes++; }
        if (old.name && !rec.name) { rec.name = old.name; rec.named = true; }
      } else {
        /* B/S have always been stored, but a record old enough to lack them
           would be un-backfillable, and the rule string is authoritative. */
        const bs = (old.B === undefined || old.S === undefined) ? parseRule(old.rule) : old;
        if (!bs) continue;
        this.map.set(old.rule, {
          rule: old.rule, B: bs.B, S: bs.S,
          profile: old.profile ?? "full",
          features: {}, checks: {}, probesRun: [],
          label: old.label, note: old.note, name: old.name, named: !!old.name,
          carriedFrom: from, measuredAt: old.measuredAt ?? Date.now()
        });
        if (old.label) result.labels++;
        if (old.note) result.notes++;
      }
      this.touch(old.rule);
      result.rules++;
    }
    return result;
  }

  /* Whatever a previous version left behind, exactly as stored. The escape
     hatch when carryForward is not enough — this is the raw v3 file you would
     have exported had you exported. */
  legacyDump(keys = LEGACY_KEYS) {
    const out = {};
    for (const key of keys) {
      const raw = backing.get(key);
      if (!raw) continue;
      try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
    }
    return out;
  }

  /* Mark a rule as needing writing. Callers that mutate a record in place —
     mergeFeatures, setLabel, setNote — have to say so, since nothing else can
     tell that the object changed. */
  touch(rule) {
    this.dirty.add(rule);
  }

  /* Every call site still calls save(); on disk it schedules a flush of only
     what changed, and a sweep's many small saves coalesce into few writes.
     On localStorage it is the old whole-store write. */
  save() {
    if (this.mode === "published") return;   // a published dataset is read-only
    if (this.mode !== "disk") return this.saveLocal();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => { /* reported by the next flush or on unload */ });
    }, 300);
  }

  async flush() {
    if (this.mode !== "disk" || !this.dirty.size) return 0;
    const batch = [];
    for (const rule of this.dirty) {
      const rec = this.map.get(rule);
      if (rec) batch.push(rec);
    }
    this.dirty.clear();
    await disk.append(batch);
    return batch.length;
  }

  saveLocal() {
    try {
      let all = [...this.map.values()];
      if (all.length > CAP) {
        all.sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0) || b.measuredAt - a.measuredAt);
        all = all.slice(0, CAP);
        this.map = new Map(all.map(r => [r.rule, r]));
      }
      backing.set(KEY, JSON.stringify(all));
    } catch {
      /* over quota; keep the in-memory copy */
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  /* The more complete measurement wins — more probes first, then a full
     profile over a fast one — so a rule a quick sweep happens to hit is never
     downgraded from a thorough run. Labels survive either way. */
  put(record, meta = {}) {
    const prev = this.map.get(record.rule);
    const next = { ...record, ...meta };
    if (prev) {
      next.name = meta.name ?? prev.name;
      next.note = meta.note ?? prev.note;
      next.label = meta.label ?? prev.label;   // a hand label always survives re-measurement
      next.named = !!next.name;
      if (coverage(prev) > coverage(record)) {
        this.map.set(record.rule, {
          ...prev, name: next.name, note: next.note, label: next.label, named: next.named
        });
        this.touch(record.rule);
        return this.map.get(record.rule);
      }
    }
    next.named = !!next.name;
    this.map.set(record.rule, next);
    this.touch(record.rule);
    return next;
  }

  /* Fold newly measured features into an existing record, leaving everything
     already there untouched. Used by the backfill: adding a feature or probe
     should cost only the new work. */
  mergeFeatures(rule, added, probes) {
    const rec = this.map.get(rule);
    if (!rec) return null;
    rec.features = { ...rec.features, ...added };
    rec.probesRun = [...new Set([...(rec.probesRun ?? []), ...probes])];
    this.touch(rule);
    return rec;
  }

  /* Your prose note on a rule — what you saw on the bench, in your own words.
     Like the label it is yours, not measured, and survives re-measurement.
     Named rules start from the catalog blurb; editing replaces it. Setting it
     to "" clears it, and the catalog text comes back for named rules. */
  setNote(rule, note) {
    const rec = this.map.get(rule);
    if (!rec) return null;
    const clean = String(note ?? "").trim();
    if (clean) rec.note = clean;
    else delete rec.note;
    this.touch(rule);
    this.save();
    this.emit();
    return rec;
  }

  /* Your hand-assigned class for a rule. Kept separate from everything the
     machine measured: this is ground truth to fit checks against, not a
     result. Setting it to "" clears it. */
  setLabel(rule, label) {
    const rec = this.map.get(rule);
    if (!rec) return null;
    const clean = String(label ?? "").trim();
    if (clean) rec.label = clean;
    else delete rec.label;
    this.touch(rule);
    this.save();
    this.emit();
    return rec;
  }

  /* Every distinct label in use, for the filter and colour menus. */
  labels() {
    return [...new Set([...this.map.values()].map(r => r.label).filter(Boolean))].sort();
  }

  get(rule) { return this.map.get(rule); }
  has(rule) { return this.map.has(rule); }
  get size() { return this.map.size; }

  /* Records with current check results derived from the current checks.js. */
  all() { return [...this.map.values()].map(r => rechecked(r)); }

  /* Emptying the store cannot be an append — the file has to be rewritten,
     or every deleted record would still be in it. */
  clear() {
    this.map.clear();
    this.dirty.clear();
    if (this.mode === "published") { /* nothing to write back to */ }
    /* A snapshot rewrite, not a fold: folding in place reads the file, and the
       file still holds everything just cleared. */
    else if (this.mode === "disk") disk.compact([...this.map.values()]);
    else this.saveLocal();
    this.emit();
  }

  toJSON() {
    return {
      exported: new Date().toISOString(),
      note: "Features are measurements; checks are derived and can be recomputed from checks.js.",
      records: this.all()
    };
  }

  /* Merge an exported file back in. Returns how many were added. */
  import(json) {
    const list = Array.isArray(json) ? json : json.records;
    if (!Array.isArray(list)) throw new Error("no records array found");
    let n = 0;
    for (const rec of list) {
      if (!rec?.rule || !rec.features) continue;
      this.put(rec);
      n++;
    }
    this.save();
    this.emit();
    return n;
  }
}

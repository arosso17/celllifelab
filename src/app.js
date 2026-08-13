import {
  TORUS, BOUNDARIES, parseRule, formatRule, makeGrid, randomise, seedBlob,
  clearGrid, step, rng
} from "./engine.js";
import { PROBES } from "./probes.js";
import { FEATURES, FEATURE_BY_ID, SWEEP_FEATURES, requiredProbes } from "./features.js";
import { CHECKS, CHECK_BY_ID } from "./checks.js";
import { measureRule, measureMissing, missingFeatures } from "./measure.js";
import { RecordStore } from "./records.js";
import { CATALOG, PATTERNS } from "./catalog.js";

const $ = sel => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

/* The published build serves the same code against a static dataset, with the
   controls that write anything left out of its page. Marked on <html> so it is
   known before any of the wiring runs, and so the page itself declares it
   rather than the code guessing from a hostname.

   Everything that binds a control goes through `on`, which tolerates a missing
   element. That is what lets one app.js drive both pages: the read-only build
   omits the control, the handler is never bound, and nothing throws. */
const READONLY = document.documentElement.dataset.mode === "readonly";
const on = (sel, handler, ev = "onclick") => {
  const node = $(sel);
  if (node) node[ev] = handler;
  return node;
};

/* Constructed empty; `open()` below decides between the file on disk, the
   localStorage fallback and a published dataset, and has to await I/O either
   way. */
const store = new RecordStore(false);
const opened = await store.open({ readonly: READONLY });

/* ============================ bench ============================ */

const SIM_W = 160, SIM_H = 120;
const sim = makeGrid(SIM_W, SIM_H);
let rule = parseRule("B3/S23");
let boundary = TORUS;
let playing = true;
let speed = 30;
let lastTick = 0;

const canvas = $("#sim");
canvas.width = SIM_W * 4;
canvas.height = SIM_H * 4;
const ctx = canvas.getContext("2d");
const off = Object.assign(document.createElement("canvas"), { width: SIM_W, height: SIM_H });
const octx = off.getContext("2d");
const img = octx.createImageData(SIM_W, SIM_H);

let colours = readColours();
function readColours() {
  const cs = getComputedStyle(document.documentElement);
  const rgb = name => {
    const h = cs.getPropertyValue(name).trim().replace("#", "");
    const s = h.length === 3 ? [...h].map(c => c + c).join("") : h;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  };
  return { on: rgb("--cell-on"), off: rgb("--grid-bg") };
}

function drawSim() {
  const d = img.data;
  for (let i = 0; i < sim.cur.length; i++) {
    const c = sim.cur[i] ? colours.on : colours.off;
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

function setRule(str) {
  const p = parseRule(str);
  if (!p) return false;
  rule = p;
  $("#t-rule").value = str;
  $("#t-rule").classList.remove("bad");
  syncRuleTable();
  return true;
}

function syncRuleTable() {
  for (const row of ["B", "S"]) {
    for (let c = 0; c < 9; c++) {
      const btn = $(`#rb-${row}${c}`);
      btn.setAttribute("aria-pressed", ((rule[row] >> c) & 1) ? "true" : "false");
    }
  }
  const str = formatRule(rule.B, rule.S);
  $("#t-rule").value = str;
  $("#r-rule").textContent = str;
  $("#r-lambda").textContent = FEATURE_BY_ID.lambda.compute(null, rule).toFixed(3);
  showKnownFor(str);
  /* Here rather than in setRule: the B/S buttons change the rule without
     going through setRule, and the label and note must follow the rule. */
  syncLabelUI();
  syncNoteUI();
}

function buildRuleTable() {
  const host = $("#ruletable");
  for (const row of ["B", "S"]) {
    const line = el("div", { className: "rrow" }, [
      el("span", { className: "rlab", textContent: row, title: row === "B" ? "Birth" : "Survival" })
    ]);
    for (let c = 0; c < 9; c++) {
      const b = el("button", {
        className: "cellbtn", id: `rb-${row}${c}`, textContent: String(c),
        ariaLabel: `${row === "B" ? "birth" : "survival"} on ${c} neighbours`
      });
      b.setAttribute("aria-pressed", "false");
      b.onclick = () => { rule[row] ^= 1 << c; syncRuleTable(); };
      line.append(b);
    }
    host.append(line);
  }
}

let soupDensity = 0.28;

/* Matches the `blob` probe's geometry (a 12x12 patch on an empty lattice) so
   what the bench shows is what that probe measured. The probe fixes its
   density at 0.5; here it follows the slider. */
export const BLOB_SIZE = 12;

function loadPattern(name) {
  if (name === "Soup") {
    randomise(sim, soupDensity, (Math.random() * 1e9) | 0);
  } else if (name === "Blob") {
    seedBlob(sim, BLOB_SIZE, BLOB_SIZE, soupDensity, (Math.random() * 1e9) | 0);
  } else {
    clearGrid(sim);
    const cells = PATTERNS[name];
    const maxX = Math.max(...cells.map(c => c[0]));
    const maxY = Math.max(...cells.map(c => c[1]));
    const ox = (SIM_W - maxX) >> 1, oy = (SIM_H - maxY) >> 1;
    for (const [x, y] of cells) sim.cur[(oy + y) * SIM_W + ox + x] = 1;
    sim.pop = cells.length;
  }
  refreshReadout();
  drawSim();
}

function refreshReadout() {
  $("#r-gen").textContent = sim.gen;
  $("#r-density").textContent = (sim.pop / (SIM_W * SIM_H)).toFixed(3);
  $("#r-activity").textContent = sim.act.toFixed(3);
}

function tick() {
  step(sim, rule.B, rule.S, boundary);
  refreshReadout();
  drawSim();
}

function setPlaying(v) {
  playing = v;
  $("#b-play").textContent = v ? "Pause" : "Play";
  $("#b-play").setAttribute("aria-pressed", String(v));
}

/* painting */
let painting = false, paintValue = 1;
const cellAt = ev => {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - r.left) / r.width * SIM_W);
  const y = Math.floor((ev.clientY - r.top) / r.height * SIM_H);
  return (x < 0 || y < 0 || x >= SIM_W || y >= SIM_H) ? -1 : y * SIM_W + x;
};
canvas.addEventListener("pointerdown", ev => {
  const i = cellAt(ev);
  if (i < 0) return;
  canvas.setPointerCapture(ev.pointerId);
  painting = true;
  paintValue = sim.cur[i] ? 0 : 1;
  sim.cur[i] = paintValue;
  drawSim();
  ev.preventDefault();
});
canvas.addEventListener("pointermove", ev => {
  if (!painting) return;
  const i = cellAt(ev);
  if (i >= 0) { sim.cur[i] = paintValue; drawSim(); }
});
addEventListener("pointerup", () => { painting = false; });

/* ============================ known rules ============================ */

const NAMES = new Map(CATALOG.map(c => [c.rule, c]));

/* The catalog blurb is only a starting point. Once a record carries a note it
   wins, for named and unnamed rules alike — the note under the bench is yours. */
function noteFor(str) {
  return store.get(str)?.note ?? NAMES.get(str)?.note ?? "";
}

function showKnownFor(str) {
  const known = NAMES.get(str);
  const box = $("#known");
  if (known) {
    box.hidden = false;
    box.innerHTML = "";
    box.append(el("b", { textContent: known.name }));
  } else {
    box.hidden = true;
  }

  const note = noteFor(str);
  const noteBox = $("#rule-note");
  noteBox.hidden = !note;
  noteBox.textContent = note;
}

/* ============================ measurement ============================ */

function measureAndStore(ruleObj, profile, meta = {}, features) {
  const rec = measureRule(ruleObj, features ? { profile, features } : { profile });
  const known = NAMES.get(rec.rule);
  /* A note you wrote outranks the catalog blurb and must survive
     re-measurement; the blurb only seeds a rule you have never noted. */
  const note = store.get(rec.rule)?.note ?? known?.note;
  const stored = store.put(rec, { ...meta, name: known?.name, note });
  return stored;
}

on("#b-measure", () => {
  const rec = measureAndStore(rule, "full", { source: "bench" });
  store.save();
  store.emit();
  $("#table-filter").value = rec.rule;
  renderTable();
  $("#records").scrollIntoView({ behavior: "smooth", block: "start" });
});

on("#b-catalog", async () => {
  const btn = $("#b-catalog");
  btn.disabled = true;
  for (const entry of CATALOG) {
    const p = parseRule(entry.rule);
    measureAndStore(p, "full", { source: "catalog" });
    setStatus(`measuring ${entry.name}…`);
    await frame();
  }
  store.save();
  store.emit();
  setStatus("");
  btn.disabled = false;
});

/* random sweep, time-sliced so the page stays responsive */
let sweeping = false;
on("#b-sweep", async () => {
  if (sweeping) { sweeping = false; return; }
  sweeping = true;
  $("#b-sweep").textContent = "Stop";
  const n = +$("#sweep-n").value;
  /* Quick mode runs only the probes SWEEP_FEATURES needs. Checks depending on
     the others report n/a on those records rather than guessing — which is
     why the coverage column exists. */
  const quick = $("#sweep-depth").value === "quick";
  const featureSet = quick ? SWEEP_FEATURES : FEATURES;
  const profile = quick ? "fast" : "full";
  const r = rng((Math.random() * 1e9) | 0);
  let done = 0;
  const t0 = performance.now();
  while (sweeping && done < n) {
    const budget = performance.now();
    while (sweeping && done < n && performance.now() - budget < 60) {
      const B = Math.floor(r() * 512), S = Math.floor(r() * 512);
      measureAndStore({ B, S }, profile, { source: "sweep" }, featureSet);
      done++;
    }
    /* Write as we go: a sweep of thousands should not hold every record in
       memory until the end, and a browser crash mid-sweep should cost the
       last slice rather than the lot. */
    store.save();
    const per = (performance.now() - t0) / done;
    const left = Math.max(0, (n - done) * per / 1000);
    setStatus(`swept ${done} / ${n} · ${per.toFixed(0)} ms each · ${left.toFixed(0)}s left`);
    await frame();
  }
  store.save();
  store.emit();
  sweeping = false;
  $("#b-sweep").textContent = "Sweep";
  setStatus(`swept ${done} rules`);
});

/* Backfill: bring old records up to the current feature set by running only
   the probes they are missing. Adding a probe should not mean re-measuring
   everything that came before it. */
let backfilling = false;
on("#b-backfill", async () => {
  if (backfilling) { backfilling = false; return; }

  const todo = [...store.map.values()].filter(r => missingFeatures(r).length);
  if (!todo.length) {
    setStatus("every record already has every feature");
    return;
  }

  backfilling = true;
  $("#b-backfill").textContent = "Stop";
  let done = 0;
  const t0 = performance.now();

  while (backfilling && done < todo.length) {
    const budget = performance.now();
    while (backfilling && done < todo.length && performance.now() - budget < 60) {
      const rec = todo[done++];
      const result = measureMissing(rec);
      if (result) store.mergeFeatures(rec.rule, result.features, result.probes);
    }
    store.save();
    const per = (performance.now() - t0) / done;
    const left = Math.max(0, (todo.length - done) * per / 1000);
    setStatus(`backfilling ${done} / ${todo.length} · ${per.toFixed(0)} ms each · ${left.toFixed(0)}s left`);
    await frame();
  }

  store.save();
  store.emit();
  const stopped = done < todo.length;
  setStatus(`backfilled ${done} record${done === 1 ? "" : "s"}${stopped ? " (stopped early)" : ""}`);
  backfilling = false;
  updateBackfillButton();
});

/* Re-measure: run every stored rule again from scratch.
 *
 * Backfill deliberately leaves present values alone, so it cannot help when a
 * feature was *redefined* rather than added — the old number is still there,
 * still answering the question it was written for. This is the escape hatch
 * for that, and the only thing that costs a full re-run. Names, notes and
 * hand labels survive, since `put` carries them across. */
let remeasuring = false;
on("#b-remeasure", async () => {
  if (remeasuring) { remeasuring = false; return; }

  const todo = [...store.map.values()];
  if (!todo.length) { setStatus("nothing measured yet"); return; }
  if (!confirm(`Re-run every probe for all ${todo.length} rules? Labels and notes are kept.`)) return;

  remeasuring = true;
  const btn = $("#b-remeasure");
  btn.textContent = "Stop";
  let done = 0;
  const t0 = performance.now();

  while (remeasuring && done < todo.length) {
    const budget = performance.now();
    while (remeasuring && done < todo.length && performance.now() - budget < 60) {
      const rec = todo[done++];
      /* At the record's own profile and its own coverage: a row measured
         fast with two probes is refreshed as it was, not quietly upgraded to
         the full set — that is what Backfill is for, and a quick sweep of
         thousands would otherwise turn into hours here. */
      const ran = rec.probesRun ?? [];
      const featureSet = ran.length ? FEATURES.filter(f => f.probes.every(p => ran.includes(p))) : FEATURES;
      measureAndStore({ B: rec.B, S: rec.S }, rec.profile ?? "full", { source: rec.source ?? "remeasure" }, featureSet);
    }
    store.save();
    const per = (performance.now() - t0) / done;
    const left = Math.max(0, (todo.length - done) * per / 1000);
    setStatus(`re-measuring ${done} / ${todo.length} · ${per.toFixed(0)} ms each · ${left.toFixed(0)}s left`);
    await frame();
  }

  store.save();
  store.emit();
  const stopped = done < todo.length;
  setStatus(`re-measured ${done} record${done === 1 ? "" : "s"}${stopped ? " (stopped early)" : ""}`);
  remeasuring = false;
  btn.textContent = "Re-measure";
});

function updateBackfillButton() {
  if (backfilling) return;
  const btn = $("#b-backfill");
  if (!btn) return;                    // read-only build cannot backfill
  const n = [...store.map.values()].filter(r => missingFeatures(r).length).length;
  btn.textContent = n ? `Backfill ${n}` : "Backfill";
  btn.disabled = n === 0;
  btn.title = n
    ? `${n} record${n === 1 ? "" : "s"} are missing features added since they were measured. Runs only the probes they lack.`
    : "Every record has every current feature";
}

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const setStatus = msg => { $("#status").textContent = msg; };

/* ============================ criterion menus ============================ */

/* Both the filter menu and the plot's highlight menu offer the same things:
   every check, plus every class you have assigned by hand. Rebuilt whenever
   the set of labels changes. */
function rebuildCriterionMenus() {
  const labels = store.labels();
  for (const [sel, firstLabel] of [[$("#filter-add"), "add filter…"], [$("#plot-c"), "none"]]) {
    const keep = sel.value;
    sel.innerHTML = "";
    sel.append(el("option", { value: "", textContent: firstLabel }));

    const checks = el("optgroup", { label: "checks" });
    for (const c of CHECKS) checks.append(el("option", { value: c.id, textContent: c.label }));
    sel.append(checks);

    if (labels.length) {
      const group = el("optgroup", { label: "your classes" });
      for (const l of labels) group.append(el("option", { value: `label:${l}`, textContent: l }));
      group.append(el("option", { value: "label:", textContent: "unlabelled" }));
      sel.append(group);
    }
    sel.value = keep;
  }
}

/* ============================ labelling ============================ */

/* Your classes are the ground truth the checks get fitted against, so they
   live on the record but never mix with measured values. */
function currentRuleString() {
  return formatRule(rule.B, rule.S);
}

function syncLabelUI() {
  const box = $("#t-label");
  if (!box) return;                    // read-only build has no labelling
  const rec = store.get(currentRuleString());
  $("#l-label").textContent = rec?.label ?? "";
  box.value = rec?.label ?? "";

  const list = $("#known-labels");
  list.innerHTML = "";
  for (const l of store.labels()) list.append(el("option", { value: l }));
}

/* Both the label and the note hang off a record, so there has to be one. */
function ensureRecord(key) {
  if (store.has(key)) return;
  setStatus("measuring this rule first…");
  measureAndStore(rule, "full", { source: "bench" });
}

function syncNoteUI() {
  const box = $("#t-note");
  if (!box) return;                    // read-only build has no note editor
  const key = currentRuleString();
  const rec = store.get(key);
  const own = rec?.note;
  /* Show whatever is on screen under the bench, so editing starts from the
     text you can see — including the catalog blurb for a named rule. */
  box.value = own ?? NAMES.get(key)?.note ?? "";
  $("#l-note").textContent = own ? "yours" : (NAMES.get(key)?.note ? "from catalog" : "");
}

function applyNote(value) {
  const key = currentRuleString();
  ensureRecord(key);
  /* Saving the catalog blurb unchanged would store it as if you had written
     it; clearing then puts the blurb back, so nothing is lost either way. */
  store.setNote(key, value);
  setStatus(value.trim() ? `note saved on ${key}` : `note cleared on ${key}`);
  syncNoteUI();
  showKnownFor(key);
  renderTable();
}

function applyLabel(value) {
  const key = currentRuleString();
  ensureRecord(key);
  store.setLabel(key, value);
  setStatus(value ? `labelled ${key} as "${value}"` : `cleared label on ${key}`);
  syncLabelUI();
  renderTable();
}

/* ============================ results table ============================ */

/* Columns come from the registries, not from a list written out by hand —
   every feature and every check has one, whether or not it is on screen. */
const COLUMNS = [
  { key: "rule", label: "rule", group: "record", pinned: true },
  { key: "name", label: "name", group: "record" },
  /* Hand labels are stripped from the published dataset, so the column would
     be an empty one that can never fill — it is left out rather than shown
     blank, which would read as "no rule has a class" instead of "classes are
     not part of this build". */
  ...(READONLY ? [] : [{ key: "label", label: "your class", group: "record", cls: "lbl",
    title: "The class you assigned by hand. Ground truth for fitting checks." }]),
  { key: "probes", label: "probes", group: "record", cls: "cov",
    title: "How many of the probes this record was measured with. Fewer means some checks read n/a." },
  ...FEATURES.map(f => ({ key: `f.${f.id}`, label: f.label, group: "feature", cls: "feat", title: f.note })),
  ...CHECKS.map(c => ({ key: `c.${c.id}`, label: c.label, group: "check", cls: "chk", title: c.note }))
];

/* Hidden by default: the features that were left out of the table before it
   was configurable — diagnostics and horizon-recording numbers rather than
   things you compare rules on. One tick away either way. */
const DEFAULT_HIDDEN = [
  "f.activity35", "f.activity65", "f.drift", "f.transient", "f.runGens",
  "f.pointReach", "f.halfReach", "f.zoneStart"
];

/* What is *hidden* is stored, not what is shown: a feature or check added
   later then appears on its own rather than being silently withheld because
   it was not in a list saved before it existed. */
const COLS_KEY = "ca-lab.columns.v1";
function loadHidden() {
  try {
    const raw = localStorage.getItem(COLS_KEY);
    return new Set(raw ? JSON.parse(raw) : DEFAULT_HIDDEN);
  } catch {
    return new Set(DEFAULT_HIDDEN);
  }
}
let hiddenCols = loadHidden();
function saveHidden() {
  try { localStorage.setItem(COLS_KEY, JSON.stringify([...hiddenCols])); } catch { /* no storage; session only */ }
}
const shownColumns = () => COLUMNS.filter(c => c.pinned || !hiddenCols.has(c.key));

let sortKey = "rule", sortDir = 1;

function cellText(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}

function cellClass(v) {
  if (v === null || v === undefined) return "na";
  if (v === true) return "yes";
  if (v === false) return "no";
  return "";
}

function buildTableHead() {
  const tr = $("#thead-row");
  tr.innerHTML = "";
  for (const col of shownColumns()) {
    const th = el("th", { textContent: col.label, title: col.title ?? "", className: col.cls ?? "" });
    th.dataset.sort = col.key;
    th.onclick = () => {
      if (sortKey === col.key) sortDir = -sortDir;
      else { sortKey = col.key; sortDir = col.key === "rule" || col.key === "name" ? 1 : -1; }
      showFirstPage();
    };
    tr.append(th);
  }
}

/* Which parts of the column menu are open. The panel is tall — 49 features
   and 21 checks — so it remembers what you folded away rather than making you
   collapse the same groups on every reload. */
const UI_KEY = "ca-lab.columns.ui.v1";
const DEFAULT_UI = { open: false, groups: { record: true, feature: false, check: false } };
function loadColumnUI() {
  try {
    const raw = localStorage.getItem(UI_KEY);
    return raw ? { ...DEFAULT_UI, ...JSON.parse(raw) } : { ...DEFAULT_UI };
  } catch {
    return { ...DEFAULT_UI };
  }
}
let colUI = loadColumnUI();
function saveColumnUI() {
  try { localStorage.setItem(UI_KEY, JSON.stringify(colUI)); } catch { /* session only */ }
}

function setColumnMenuOpen(open) {
  colUI.open = open;
  saveColumnUI();
  $("#col-menu").hidden = !open;
  $("#b-columns").setAttribute("aria-expanded", String(open));
}

/* Hiding a column must not silently change the order: a sort on a column you
   have just hidden falls back to the rule. */
function buildColumnMenu() {
  const host = $("#col-menu");
  host.innerHTML = "";

  const apply = () => {
    saveHidden();
    if (hiddenCols.has(sortKey)) { sortKey = "rule"; sortDir = 1; }
    buildTableHead();
    renderTable();
  };

  for (const [group, title] of [["record", "record"], ["feature", "features"], ["check", "checks"]]) {
    const inGroup = COLUMNS.filter(c => c.group === group);
    const shown = inGroup.filter(c => c.pinned || !hiddenCols.has(c.key)).length;

    /* <details> rather than a click handler: it collapses without script,
       and the disclosure state is the element's own. */
    const box = el("details", { className: "colgroup", open: colUI.groups[group] !== false });
    box.ontoggle = () => {
      colUI.groups[group] = box.open;
      saveColumnUI();
    };
    const count = el("em", { textContent: `${shown}/${inGroup.length}` });
    box.append(el("summary", {}, [el("span", { textContent: title }), count]));
    /* Updated in place rather than by rebuilding the menu, which would move
       focus out of the checkbox you are still ticking down the list. */
    const recount = () => {
      count.textContent = `${inGroup.filter(c => c.pinned || !hiddenCols.has(c.key)).length}/${inGroup.length}`;
    };

    for (const col of inGroup) {
      const cb = el("input", { type: "checkbox", checked: col.pinned || !hiddenCols.has(col.key), disabled: !!col.pinned });
      cb.onchange = () => {
        if (cb.checked) hiddenCols.delete(col.key); else hiddenCols.add(col.key);
        apply();
        recount();
      };
      box.append(el("label", { className: "colopt", title: col.title ?? "" },
        [cb, el("span", { textContent: col.label })]));
    }
    host.append(box);
  }

  const set = keys => {
    hiddenCols = new Set(keys);
    apply();
    buildColumnMenu();
  };
  host.append(el("div", { className: "colgroup actions" }, [
    el("button", { textContent: "show all", onclick: () => set([]) }),
    el("button", { textContent: "collapse", title: "Fold every group", onclick: () => {
      for (const d of host.querySelectorAll("details")) d.open = false;
    } }),
    el("button", { textContent: "close", onclick: () => setColumnMenuOpen(false) }),
    el("button", {
      textContent: "features off",
      onclick: () => set([...hiddenCols, ...FEATURES.map(f => `f.${f.id}`)])
    }),
    el("button", {
      textContent: "checks off",
      onclick: () => set([...hiddenCols, ...CHECKS.map(c => `c.${c.id}`)])
    }),
    el("button", { textContent: "reset", onclick: () => set(DEFAULT_HIDDEN) })
  ]));
}

function valueOf(rec, key) {
  if (key === "rule") return rec.rule;
  if (key === "name") return rec.name ?? "";
  if (key === "label") return rec.label ?? "";
  if (key === "probes") return rec.probesRun?.length ?? 0;
  if (key.startsWith("f.")) return rec.features[key.slice(2)];
  const v = rec.checks[key.slice(2)];
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

/* Active check filters: {id, mode} where mode is "hide" or "only".
   A check answering n/a counts as not passing, so `hide` keeps it and
   `only` drops it. */
const filters = [];

/* A filter id is either a check id, or "label:<name>" / "label:" for the
   unlabelled. Labels are matched as equality, checks as truthiness. */
const isLabelFilter = id => id.startsWith("label:");

function matches(rec, id) {
  if (!isLabelFilter(id)) return truthy(rec.checks[id]);
  const want = id.slice(6);
  return want ? rec.label === want : !rec.label;
}

function filterLabel(id) {
  if (!isLabelFilter(id)) return CHECK_BY_ID[id]?.label ?? id;
  const want = id.slice(6);
  return want ? `class: ${want}` : "unlabelled";
}

function addFilter(id) {
  if (!id || filters.some(f => f.id === id)) return;
  filters.push({ id, mode: "hide" });
  renderFilters();
  showFirstPage();
}

function renderFilters() {
  const host = $("#filter-chips");
  host.innerHTML = "";
  for (const f of filters) {
    const label = filterLabel(f.id);
    const chip = el("span", { className: `chip ${f.mode}` });

    const toggle = el("button", {
      className: "chip-mode",
      textContent: f.mode === "hide" ? "hide" : "only",
      title: "Switch between hiding and showing only these"
    });
    toggle.onclick = () => {
      f.mode = f.mode === "hide" ? "only" : "hide";
      renderFilters();
      showFirstPage();
    };

    const drop = el("button", { className: "chip-x", textContent: "×", ariaLabel: `Remove ${label} filter` });
    drop.onclick = () => {
      filters.splice(filters.indexOf(f), 1);
      renderFilters();
      showFirstPage();
    };

    chip.append(toggle, el("span", { className: "chip-label", textContent: label }), drop);
    host.append(chip);
  }
  host.hidden = filters.length === 0;
}

function filteredRecords() {
  const q = $("#table-filter").value.trim().toUpperCase();
  let rows = store.all();
  if (q) rows = rows.filter(r => r.rule.toUpperCase().includes(q) || (r.name ?? "").toUpperCase().includes(q));
  for (const f of filters) {
    rows = f.mode === "hide"
      ? rows.filter(r => !matches(r, f.id))
      : rows.filter(r => matches(r, f.id));
  }
  rows.sort((a, b) => {
    const x = valueOf(a, sortKey), y = valueOf(b, sortKey);
    if (x === y) return a.rule.localeCompare(b.rule);
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * sortDir;
  });
  return rows;
}

const truthy = v => v !== null && v !== undefined && v !== false;
const plottable = (rec, id) => Number.isFinite(rec.features[id]);

function cellFor(rec, col) {
  if (col.key === "rule") {
    const td = el("td", { className: "rulecell", textContent: rec.rule });
    td.onclick = () => {
      setRule(rec.rule);
      loadPattern("Soup");
      $("#bench").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    return td;
  }
  if (col.key === "name") return el("td", { className: "namecell", textContent: rec.name ?? "" });
  if (col.key === "label") {
    return el("td", {
      className: "lbl",
      textContent: rec.label ?? "",
      title: rec.label ? "Click to load this rule and edit its class" : ""
    });
  }
  if (col.key === "probes") {
    const ran = rec.probesRun?.length ?? 0;
    return el("td", {
      className: `cov num${ran < PROBES.length ? " partial" : ""}`,
      textContent: `${ran}/${PROBES.length}`,
      title: ran < PROBES.length
        ? `Measured with ${rec.probesRun?.join(", ")}. Checks needing the others read n/a.`
        : "Fully measured"
    });
  }
  if (col.key.startsWith("f.")) {
    return el("td", { className: "num", textContent: cellText(rec.features[col.key.slice(2)]) });
  }
  const v = rec.checks[col.key.slice(2)];
  return el("td", { className: `chk ${cellClass(v)}`, textContent: cellText(v) });
}

/* The plot draws every matching rule; the table builds a page of them. With a
   cap and no way past it, the two disagreed about how much data there was —
   a plot of thousands of points above a table that stopped at 300 and said so
   in a parenthesis. Paging makes the rest reachable and the number honest. */
const PAGE = 300;
let page = 0;

const pager = el("div", { className: "pager" });
const pagePrev = el("button", { textContent: "‹", ariaLabel: "Previous page" });
const pageNext = el("button", { textContent: "›", ariaLabel: "Next page" });
const pageLabel = el("span", { className: "pagelabel" });
pagePrev.onclick = () => { page--; renderTable(); };
pageNext.onclick = () => { page++; renderTable(); };
pager.append(pagePrev, pageLabel, pageNext);

/* Anything that changes which rules match starts again at the first page.
   Staying on page 9 of a filter that now matches two rules shows an empty
   table and looks like a bug in the filter. */
function showFirstPage() {
  page = 0;
  renderTable();
}

function renderTable() {
  const rows = filteredRecords();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const start = page * PAGE;
  const shown = rows.slice(start, start + PAGE);

  const body = $("#tbody");
  body.innerHTML = "";
  const cols = shownColumns();
  for (const rec of shown) {
    const tr = el("tr");
    for (const col of cols) tr.append(cellFor(rec, col));
    body.append(tr);
  }

  pageLabel.textContent = rows.length
    ? `${start + 1}–${start + shown.length} of ${rows.length}` +
      (pages > 1 ? ` · page ${page + 1} of ${pages}` : "")
    : "no rules match";
  pagePrev.disabled = page === 0;
  pageNext.disabled = page >= pages - 1;
  rebuildCriterionMenus();
  syncLabelUI();
  updateBackfillButton();
  const nCols = shownColumns().length;
  const s = store.stats();
  /* Where the records came from matters when there is a choice about it. In a
     published build there is none, and saying so only repeats the count. */
  const where = s.mode === "disk"
    ? ` · disk · ${s.lines} lines`
    : s.mode === "localStorage" ? " · browser storage (no server)"
    : s.mode === "published" ? "" : " · session only";
  /* How many are on screen is the pager's job, right above the table. */
  $("#count").textContent =
    `${store.size} measured · ${nCols}/${COLUMNS.length} columns${where}`;
  drawPlot();
}

/* ============================ scatter ============================ */

const plot = $("#plot");
const pctx = plot.getContext("2d");

const PLOT_PAD = { l: 64, r: 16, t: 16, b: 44 };

/* Axis domains come from every stored record, not from the filtered subset.
   Scaling to what is visible would make the plot zoom whenever a filter
   changes, so points would appear to move when only the selection did. */
function plotScales(xid, yid) {
  const all = store.all();
  const maxOf = id => {
    let m = 0;
    for (const r of all) {
      const v = r.features[id];
      if (Number.isFinite(v) && v > m) m = v;
    }
    return m || 1;
  };
  const xmax = maxOf(xid), ymax = maxOf(yid);
  return {
    xmax, ymax,
    sx: v => PLOT_PAD.l + (v / xmax) * (plot.width - PLOT_PAD.l - PLOT_PAD.r),
    /* sqrt on y: activity-like features bunch hard against zero */
    sy: v => plot.height - PLOT_PAD.b
      - Math.sqrt(Math.max(0, v) / ymax) * (plot.height - PLOT_PAD.t - PLOT_PAD.b)
  };
}

function drawPlot() {
  const W = plot.width, H = plot.height;
  const cs = getComputedStyle(document.documentElement);
  const line = cs.getPropertyValue("--line").trim();
  const ink3 = cs.getPropertyValue("--ink-3").trim();
  const accent = cs.getPropertyValue("--accent").trim();
  const muted = cs.getPropertyValue("--surface-3").trim();

  pctx.clearRect(0, 0, W, H);
  const xid = $("#plot-x").value, yid = $("#plot-y").value, cid = $("#plot-c").value;
  const all = filteredRecords();
  /* A null feature is an absence, not a zero — plotting it on the axis would
     invent a measurement. Those rows are dropped and counted instead. */
  const rows = all.filter(r => plottable(r, xid) && plottable(r, yid));
  const dropped = all.length - rows.length;

  const PAD = PLOT_PAD;
  const { xmax, ymax, sx, sy } = plotScales(xid, yid);

  pctx.strokeStyle = line;
  pctx.fillStyle = ink3;
  pctx.font = '600 14px ui-monospace, Consolas, monospace';
  pctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const X = Math.round(sx(xmax * i / 4)) + 0.5;
    pctx.beginPath(); pctx.moveTo(X, PAD.t); pctx.lineTo(X, H - PAD.b); pctx.stroke();
    pctx.textAlign = "center";
    pctx.fillText((xmax * i / 4).toFixed(2), X, H - PAD.b + 20);

    const yv = ymax * (i / 4) ** 2;
    const Y = Math.round(sy(yv)) + 0.5;
    pctx.beginPath(); pctx.moveTo(PAD.l, Y); pctx.lineTo(W - PAD.r, Y); pctx.stroke();
    pctx.textAlign = "right";
    pctx.fillText(yv.toFixed(3), PAD.l - 10, Y + 5);
  }
  pctx.textAlign = "center";
  pctx.fillText(FEATURE_BY_ID[xid].label, (PAD.l + W - PAD.r) / 2, H - 8);
  pctx.save();
  pctx.translate(16, (PAD.t + H - PAD.b) / 2);
  pctx.rotate(-Math.PI / 2);
  pctx.fillText(`${FEATURE_BY_ID[yid].label}  (√ scale)`, 0, 0);
  pctx.restore();

  for (const rec of rows) {
    const hit = cid ? matches(rec, cid) : false;
    pctx.fillStyle = cid ? (hit ? accent : muted) : accent;
    pctx.globalAlpha = cid && !hit ? 0.45 : 0.75;
    pctx.beginPath();
    pctx.arc(sx(rec.features[xid]), sy(rec.features[yid]), rec.named ? 5.5 : 3, 0, Math.PI * 2);
    pctx.fill();
    if (rec.named) {
      pctx.globalAlpha = 1;
      pctx.lineWidth = 2;
      pctx.strokeStyle = cs.getPropertyValue("--grid-bg").trim();
      pctx.stroke();
    }
  }
  pctx.globalAlpha = 1;

  const hidden = store.size - all.length;
  const filtered = hidden ? ` · ${hidden} filtered out` : "";
  const skipped = dropped ? ` · ${dropped} not measurable on these axes` : "";
  if (cid) {
    const n = rows.filter(r => matches(r, cid)).length;
    $("#plot-note").textContent =
      `${n} of ${rows.length} pass "${filterLabel(cid)}" (${(n / Math.max(1, rows.length) * 100).toFixed(1)}%)${filtered}${skipped}`;
  } else {
    $("#plot-note").textContent = `${rows.length} rules plotted${filtered}${skipped}`;
  }
}

plot.onclick = ev => {
  const r = plot.getBoundingClientRect();
  const mx = (ev.clientX - r.left) * (plot.width / r.width);
  const my = (ev.clientY - r.top) * (plot.height / r.height);
  const xid = $("#plot-x").value, yid = $("#plot-y").value;
  const rows = filteredRecords().filter(r => plottable(r, xid) && plottable(r, yid));
  if (!rows.length) return;
  const { sx, sy } = plotScales(xid, yid);
  let best = null, bestD = 400;
  for (const rec of rows) {
    const dx = sx(rec.features[xid]) - mx, dy = sy(rec.features[yid]) - my;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = rec; }
  }
  if (best) {
    setRule(best.rule);
    loadPattern("Soup");
    $("#bench").scrollIntoView({ behavior: "smooth", block: "start" });
  }
};

/* ============================ wiring ============================ */

function buildControls() {
  buildRuleTable();

  /* Built here rather than written into the markup: there are two pages, and
     a control created in code lands on both without either having to declare
     an id for it. */
  $(".tablewrap")?.before(pager);

  /* Derived from the registries, never written by hand — these counts have
     already drifted once when a probe was added. */
  const quickProbes = requiredProbes(SWEEP_FEATURES).length;
  const depth = $("#sweep-depth");
  if (depth) {
    depth.options[0].textContent = `all ${PROBES.length} probes`;
    depth.options[1].textContent = `quick: ${quickProbes} probe${quickProbes === 1 ? "" : "s"}`;
    depth.options[0].title = `Every probe: ${PROBES.map(p => p.id).join(", ")}`;
    depth.options[1].title =
      `Only ${requiredProbes(SWEEP_FEATURES).join(", ")}. Checks needing the rest report n/a.`;
  }

  const seeds = $("#seeds");
  for (const name of ["Soup", "Blob", ...Object.keys(PATTERNS)]) {
    seeds.append(el("button", { textContent: name, onclick: () => loadPattern(name) }));
  }

  const bnd = $("#boundary");
  for (const b of BOUNDARIES) {
    const btn = el("button", { textContent: b.label });
    btn.setAttribute("aria-pressed", String(b.id === TORUS));
    btn.onclick = () => {
      boundary = b.id;
      for (const other of bnd.children) other.setAttribute("aria-pressed", String(other === btn));
      $("#boundary-note").textContent = b.note;
      canvas.parentElement.className = `screen b${b.id}`;
    };
    bnd.append(btn);
  }
  $("#boundary-note").textContent = BOUNDARIES[0].note;

  for (const id of ["plot-x", "plot-y"]) {
    const sel = $(`#${id}`);
    for (const f of FEATURES) sel.append(el("option", { value: f.id, textContent: f.label }));
    sel.onchange = drawPlot;
  }
  $("#plot-x").value = "lambda";
  $("#plot-y").value = "activity50";

  const cSel = $("#plot-c");
  const addSel = $("#filter-add");
  cSel.onchange = drawPlot;
  addSel.onchange = ev => {
    addFilter(ev.target.value);
    ev.target.value = "";       // the select is an action, not a state
  };
  rebuildCriterionMenus();
  renderFilters();

  on("#b-label", () => applyLabel($("#t-label").value));
  on("#t-label", ev => { if (ev.key === "Enter") applyLabel(ev.target.value); }, "onkeydown");
  on("#b-unlabel", () => applyLabel(""));

  on("#b-columns", () => setColumnMenuOpen($("#col-menu").hidden));

  on("#b-note", () => applyNote($("#t-note").value));
  on("#b-unnote", () => applyNote(""));
  /* Enter inside a textarea is a newline; ctrl/cmd-enter saves. */
  on("#t-note", ev => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) applyNote(ev.target.value);
  }, "onkeydown");

  on("#t-rule", ev => {
    if (!setRule(ev.target.value)) ev.target.classList.add("bad");
  }, "oninput");
  on("#b-play", () => setPlaying(!playing));
  on("#b-step", () => { setPlaying(false); tick(); });
  on("#s-speed", ev => { speed = +ev.target.value; $("#l-speed").textContent = speed; }, "oninput");
  on("#s-soup", ev => {
    soupDensity = +ev.target.value;
    $("#l-soup").textContent = soupDensity.toFixed(2);
  }, "oninput");
  on("#table-filter", showFirstPage, "oninput");

  on("#b-export", () => {
    const blob = new Blob([JSON.stringify(store.toJSON(), null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "ca-records.json" });
    document.body.append(a); a.click(); a.remove();
  });
  on("#b-import", () => $("#file-import").click());
  on("#file-import", async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const n = store.import(JSON.parse(await file.text()));
      setStatus(`imported ${n} records`);
    } catch (err) {
      setStatus(`import failed: ${err.message}`);
    }
    ev.target.value = "";
  }, "onchange");
  on("#b-clear", () => {
    if (confirm(`Delete all ${store.size} measurements?`)) store.clear();
  });

  addEventListener("keydown", ev => {
    if (ev.target.matches("input, textarea, select")) return;
    const k = ev.key.toLowerCase();
    if (ev.code === "Space") { ev.preventDefault(); setPlaying(!playing); }
    else if (k === "n") { setPlaying(false); tick(); }
    else if (k === "c") { clearGrid(sim); refreshReadout(); drawSim(); }
    else if (k === "r") loadPattern("Soup");
    else if (k === "i") {
      for (let i = 0; i < sim.cur.length; i++) sim.cur[i] ^= 1;
      sim.pop = sim.cur.length - sim.pop;
      refreshReadout(); drawSim();
    }
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    colours = readColours();
    drawSim();
    drawPlot();
  });
}

function loop(now) {
  if (playing && now - lastTick >= 1000 / speed) {
    lastTick = now;
    tick();
  }
  requestAnimationFrame(loop);
}

buildControls();
buildColumnMenu();
setColumnMenuOpen(colUI.open);
buildTableHead();
store.onChange(renderTable);
/* A measurement can seed a note (catalog) or a record the note field needs. */
store.onChange(() => { showKnownFor(currentRuleString()); syncNoteUI(); });
setRule("B3/S23");
randomise(sim, 0.28, 0xc0ffee);
refreshReadout();
drawSim();
renderTable();
requestAnimationFrame(loop);

/* Anything still queued when the tab goes away. `keepalive` lets the request
   outlive the page; without it a label set in the last moment is lost. */
addEventListener("pagehide", () => {
  if (store.mode !== "disk" || !store.dirty.size) return;
  const batch = [...store.dirty].map(r => store.map.get(r)).filter(Boolean);
  store.dirty.clear();
  try {
    navigator.sendBeacon("/api/records", new Blob([JSON.stringify(batch)], { type: "application/json" }));
  } catch { /* nothing more to try at this point */ }
});

if (opened.mode === "published") {
  /* Only if something went wrong. A successful load has nothing to say that
     the count line has not already said. */
  if (opened.error) setStatus(`could not load ${opened.path}: ${opened.error}`);
} else if (opened.mode === "disk") {
  setStatus(
    `records on disk: ${opened.path}` +
    (opened.migrated ? ` · migrated ${opened.migrated} record${opened.migrated === 1 ? "" : "s"} out of browser storage` : "")
  );
} else {
  setStatus("no server: records are in browser storage only. Run `node serve.mjs` to keep them on disk.");
}

/* Bumping the storage key does not delete what was under the old one. Pull
   the hand-made part of it — classes, notes, names — across on first load,
   without the numbers, which is what the bump was for. Runs once. */
{
  const carried = store.carryForward();
  if (carried.rules) {
    renderTable();
    setStatus(
      `carried ${carried.labels} class${carried.labels === 1 ? "" : "es"} and ` +
      `${carried.notes} note${carried.notes === 1 ? "" : "s"} forward from ${carried.from}. ` +
      `Those rules have no measurements yet — Backfill will run them.`
    );
  }
}

/* Handy from the devtools console while editing checks.js. `legacyDump` is
   the raw contents of any older storage version, for when carryForward is
   not enough: copy(JSON.stringify(store.legacyDump())). */
Object.assign(globalThis, { store, measureRule, parseRule, FEATURES, CHECKS });

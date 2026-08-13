/* Life-like cellular automata: rules, lattices, and the step function.
 *
 * A rule is two 9-bit masks. Bit c of B means "a dead cell with c live
 * neighbours becomes alive"; bit c of S means "a live cell with c survives".
 * That is the whole of the outer-totalistic rule space: 2^18 = 262,144 rules.
 */

export const TORUS = 0;
export const EDGE_DEAD = 1;
export const EDGE_ALIVE = 2;

export const BOUNDARIES = [
  { id: TORUS, label: "Torus", note: "Opposite edges wrap. No boundary exists." },
  { id: EDGE_DEAD, label: "Edges off", note: "Cells outside the rectangle are permanently dead." },
  { id: EDGE_ALIVE, label: "Edges on", note: "Cells outside are permanently alive: every edge cell gains 3 neighbours, every corner 5." }
];

export function parseRule(str) {
  const m = /^\s*B([0-8]*)\s*\/\s*S([0-8]*)\s*$/i.exec(str ?? "");
  if (!m) return null;
  let B = 0, S = 0;
  for (const ch of m[1]) B |= 1 << +ch;
  for (const ch of m[2]) S |= 1 << +ch;
  return { B, S };
}

export function formatRule(B, S) {
  let b = "", s = "";
  for (let c = 0; c < 9; c++) {
    if ((B >> c) & 1) b += c;
    if ((S >> c) & 1) s += c;
  }
  return `B${b}/S${s}`;
}

/* Langton's lambda: probability a cell is alive next generation given a
   random lattice at density 1/2. Weighted by how often each neighbour count
   actually occurs, not by treating all nine columns as equally likely. */
const BINOM = [1, 8, 28, 56, 70, 56, 28, 8, 1];
export function lambda(B, S) {
  let sum = 0;
  for (let c = 0; c < 9; c++) {
    sum += (BINOM[c] / 256) * 0.5 * (((B >> c) & 1) + ((S >> c) & 1));
  }
  return sum;
}

/* xorshift32. Deterministic, so every measurement is reproducible. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function makeGrid(w, h) {
  return { w, h, cur: new Uint8Array(w * h), nxt: new Uint8Array(w * h), gen: 0, act: 0, pop: 0 };
}

export function clearGrid(g) {
  g.cur.fill(0);
  g.gen = 0; g.act = 0; g.pop = 0;
}

export function randomise(g, density, seed) {
  const r = rng(seed);
  let pop = 0;
  for (let i = 0; i < g.cur.length; i++) {
    const v = r() < density ? 1 : 0;
    g.cur[i] = v; pop += v;
  }
  g.gen = 0; g.act = 0; g.pop = pop;
}

/* Fill a centred rectangle at the given density, leaving the rest empty.
   The sparse-seed probes need this: many rules die from a dense soup but
   grow without bound from a small blob. */
export function seedBlob(g, boxW, boxH, density, seed) {
  clearGrid(g);
  const r = rng(seed);
  const ox = (g.w - boxW) >> 1, oy = (g.h - boxH) >> 1;
  let pop = 0;
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      const v = r() < density ? 1 : 0;
      g.cur[(oy + y) * g.w + ox + x] = v;
      pop += v;
    }
  }
  g.pop = pop;
}

/* A hollow rectangle: the border cells only. Same footprint as seedBlob, no
   interior — which is what separates rules that care about the inside of a
   shape from rules that only care about its edge. */
export function seedOutline(g, boxW, boxH) {
  clearGrid(g);
  const ox = (g.w - boxW) >> 1, oy = (g.h - boxH) >> 1;
  let pop = 0;
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      if (y !== 0 && y !== boxH - 1 && x !== 0 && x !== boxW - 1) continue;
      g.cur[(oy + y) * g.w + ox + x] = 1;
      pop++;
    }
  }
  g.pop = pop;
}

/* One live cell, centred. The minimal seed. */
export function seedPoint(g) {
  clearGrid(g);
  g.cur[(g.h >> 1) * g.w + (g.w >> 1)] = 1;
  g.pop = 1;
}

export function step(g, B, S, mode = TORUS) {
  return mode ? stepBounded(g, B, S, mode === EDGE_ALIVE ? 1 : 0) : stepTorus(g, B, S);
}

export function stepTorus(g, B, S) {
  const { w, h, cur, nxt } = g;
  let act = 0, pop = 0;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w, y0 = y * w, yp = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const xm = x === 0 ? w - 1 : x - 1;
      const xp = x === w - 1 ? 0 : x + 1;
      const n = cur[ym + xm] + cur[ym + x] + cur[ym + xp]
              + cur[y0 + xm]              + cur[y0 + xp]
              + cur[yp + xm] + cur[yp + x] + cur[yp + xp];
      const alive = cur[y0 + x];
      const next = alive ? ((S >> n) & 1) : ((B >> n) & 1);
      nxt[y0 + x] = next;
      if (next !== alive) act++;
      pop += next;
    }
  }
  g.cur.set(nxt);
  g.gen++; g.act = act / (w * h); g.pop = pop;
}

/* Bounded lattice. Cells outside are held permanently at `outside`. */
export function stepBounded(g, B, S, outside) {
  const { w, h, cur, nxt } = g;
  let act = 0, pop = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        const oobY = yy < 0 || yy >= h;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          n += (oobY || xx < 0 || xx >= w) ? outside : cur[yy * w + xx];
        }
      }
      const i = y * w + x;
      const alive = cur[i];
      const next = alive ? ((S >> n) & 1) : ((B >> n) & 1);
      nxt[i] = next;
      if (next !== alive) act++;
      pop += next;
    }
  }
  g.cur.set(nxt);
  g.gen++; g.act = act / (w * h); g.pop = pop;
}

/* FNV-1a over the lattice bytes. Used for cycle detection. */
export function hashGrid(g) {
  let hash = 0x811c9dc5;
  const cur = g.cur;
  for (let i = 0; i < cur.length; i++) {
    hash ^= cur[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/* Tight bounding box of live cells, or null if nothing is alive. */
export function boundingBox(g) {
  let minX = g.w, minY = g.h, maxX = -1, maxY = -1;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (!g.cur[y * g.w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ---------------- spatial statistics ----------------
 * Everything above measures the lattice as a whole. These measure how it is
 * arranged — which is the only thing that separates a lattice partitioned
 * into zones from a uniform soup of the same density and activity.
 */

/* Connected components of live cells, 8-connectivity, wrapping on a torus.
   Returns { count, largest, sizes, parts } with sizes descending; `parts`
   pairs each size with its perimeter (dead 4-neighbours of its cells), which
   is what separates a compact body from a lacy one of the same area. */
export function components(g, wrap = true) {
  const { w, h, cur } = g;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const parts = [];

  for (let start = 0; start < cur.length; start++) {
    if (!cur[start] || seen[start]) continue;
    let top = 0, size = 0, perimeter = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const y = (i / w) | 0, x = i % w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          let ny = y + dy, nx = x + dx;
          const oob = ny < 0 || ny >= h || nx < 0 || nx >= w;
          if (wrap) { ny = (ny + h) % h; nx = (nx + w) % w; }
          else if (oob) {
            /* Off a bounded lattice counts as dead for the perimeter. */
            if (dx === 0 || dy === 0) perimeter++;
            continue;
          }
          const j = ny * w + nx;
          /* Perimeter is edge-length, so only the four orthogonal sides. */
          if (dx === 0 || dy === 0) { if (!cur[j]) perimeter++; }
          if (cur[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    parts.push({ size, perimeter });
  }
  parts.sort((a, b) => b.size - a.size);
  return {
    count: parts.length,
    largest: parts[0]?.size ?? 0,
    sizes: parts.map(p => p.size),
    parts
  };
}

/* Mask of cells sitting on a live/dead interface — a live cell with at least
   one dead neighbour, or a dead cell with at least one live one. */
export function interfaceMask(g, wrap = true) {
  const { w, h, cur } = g;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const self = cur[i];
      let differs = false;
      for (let dy = -1; dy <= 1 && !differs; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          let ny = y + dy, nx = x + dx;
          if (wrap) { ny = (ny + h) % h; nx = (nx + w) % w; }
          else if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          if (cur[ny * w + nx] !== self) { differs = true; break; }
        }
      }
      mask[i] = differs ? 1 : 0;
    }
  }
  return mask;
}

/* Per-tile live density. Zoned lattices give a bimodal distribution here;
   uniform ones give a single narrow peak. */
export function tileDensities(g, tile = 8) {
  const { w, h, cur } = g;
  const out = [];
  for (let ty = 0; ty + tile <= h; ty += tile) {
    for (let tx = 0; tx + tile <= w; tx += tile) {
      let n = 0;
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) n += cur[(ty + y) * w + tx + x];
      }
      out.push(n / (tile * tile));
    }
  }
  return out;
}

/* Jaccard overlap of two live masks, normalised against what two random
   masks of the same densities would score. 1 is unchanged, 0 is chance. */
export function persistenceOf(a, b) {
  let inter = 0, union = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x) na++;
    if (y) nb++;
    if (x && y) inter++;
    if (x || y) union++;
  }
  if (!union) return null;
  const j = inter / union;
  const da = na / a.length, db = nb / b.length;
  const expectedUnion = da + db - da * db;
  const expected = expectedUnion > 0 ? (da * db) / expectedUnion : 0;
  if (expected >= 1) return 1;
  return Math.max(0, Math.min(1, (j - expected) / (1 - expected)));
}

/* Live cells within `margin` of the lattice border.
 *
 * The seeded probes run on a torus, where a bounding box is a lie: a pattern
 * straddling the seam has a box spanning the whole lattice while occupying
 * very little of it. Asking whether anything is actually near the border is
 * true on either topology, and is what "it was still growing when the run
 * ended" really rests on. */
export function borderLive(g, margin = 2) {
  const { w, h, cur } = g;
  for (let y = 0; y < h; y++) {
    const nearY = y < margin || y >= h - margin;
    for (let x = 0; x < w; x++) {
      if (!nearY && x >= margin && x < w - margin) continue;
      if (cur[y * w + x]) return true;
    }
  }
  return false;
}

/* Flip a deterministic random fraction of cells in place, returning how many
   were flipped. Used to damage a running lattice and watch what happens. */
export function perturb(g, fraction, seed) {
  const r = rng(seed);
  let flipped = 0, pop = 0;
  for (let i = 0; i < g.cur.length; i++) {
    if (r() < fraction) { g.cur[i] ^= 1; flipped++; }
    pop += g.cur[i];
  }
  g.pop = pop;
  return flipped;
}

/* How many cells two lattices disagree on. */
export function hammingOf(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/* Shannon entropy of 2x2 block patterns, normalised to [0,1]. */
export function blockEntropy(g) {
  const { w, h, cur } = g;
  const counts = new Uint32Array(16);
  let total = 0;
  for (let y = 0; y < h - 1; y += 2) {
    for (let x = 0; x < w - 1; x += 2) {
      const i = y * w + x;
      counts[cur[i] | (cur[i + 1] << 1) | (cur[i + w] << 2) | (cur[i + w + 1] << 3)]++;
      total++;
    }
  }
  let H = 0;
  for (let i = 0; i < 16; i++) {
    if (!counts[i]) continue;
    const p = counts[i] / total;
    H -= p * Math.log2(p);
  }
  return H / 4;
}

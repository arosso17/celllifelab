# CA Lab

Two-dimensional outer-totalistic ("life-like") cellular automata, run in the
browser and measured.

**→ https://arosso17.github.io/ca-lab/**

A rule gives each cell two rules of thumb: how many live neighbours bring a
dead cell to life, and how many keep a live one alive. Conway's Life is
`B3/S23` — born on 3, survives on 2 or 3. There are 2<sup>18</sup> = 262,144
such rules. This page runs any of them, and shows what a fixed set of
measurements says about the ones measured so far.

## What is here

**A bench.** Type a rule, or click the birth/survival buttons. Pick a seed,
paint cells, change the boundary between a torus and a wall. It runs at
whatever speed you set.

**A table of measurements.** Each measured rule was run against a set of
probes — a random soup at three densities, a single point, a half-filled
lattice, a damage test, a long-horizon run, a scan for the density at which
the rule stops dying. Features are numbers computed from those runs. Checks
are explicit tests over the features, each with a definite answer.

**A plot.** Any feature against any other. This is what the measurements are
for: classes of behaviour separate on some pairs of axes and not others, and
the plot is how you find which.

## What is deliberately not here

**No classification.** There is no overall verdict, no Wolfram class, no
score. A rule is the set of answers its checks gave, nothing more. An earlier
version did sort rules into four classes and it was removed on purpose — the
classes were doing the thinking instead of describing the data.

**`null` is not `false`.** A feature reads `null` when the question has no
answer for that rule — no cycle was found, so there is no period. A check
reads n/a when the record lacks the features it needs, rather than evaluating
a missing number and reporting "no". A gap in the data never becomes a claim
about a rule.

## Measurement is not the bench

The probes always run on a torus at their own fixed densities, so the stored
numbers stay comparable between rules. The bench is free — any boundary, any
density. So the bench and the table will sometimes disagree. That is intended.

Where a rule's behaviour lives in a narrow band of density, measuring it at a
fixed density measures the wrong regime. The spatial features are read from a
probe that scans for the rule's *own* transition density first and measures
there. This was a correction: at a fixed 0.50 soup, a rule whose whole
character is dense zones beside empty ones reported no zones at all, because
0.50 is well above where it forms them.

## The data

`data/index.json` names the parts; each part is JSON Lines, one measured rule
per line. Take it and do what you like with it.

```
{"rule":"B3/S23","B":8,"S":12,"profile":"full","probesRun":[...],"features":{...}}
```

Records store feature values only. Check results are derived on read, so
changing a check re-answers every question about every rule already measured
without re-simulating anything.

The dataset grows as more of rule space gets swept.

## Running it

It is static: any file server will do. ES modules will not load over `file://`,
so it does need to be served rather than opened.

```sh
python -m http.server 8080
```

No dependencies, no build step.

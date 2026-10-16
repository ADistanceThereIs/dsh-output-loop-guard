# dsh-output-loop-guard

An **output self-repetition watchdog** for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/).
When a model starts cycling the same short block instead of producing a tool call, the guard
aborts that generation and wakes the agent with a corrective notice — no human stop button,
and no human typing "continue".

- Bundle for DSH `>= 0.2.0-rc.2`, ESM, zero runtime dependencies.
- 21 self-contained regression checks (`npm test`).
- Calibrated against 27 real sessions / 1,783 assistant steps: **24 detections, 0 false positives**.

## The gap it fills

DSH ships `@deepseek-ai/dsh-repeat-tool-reminder`, which only sees **duplicate tool calls**
(same tool, same arguments, 3/5/8 times in a row). A degeneration loop in the *reasoning
channel* is invisible to it. In the session that motivated this plugin:

- the model repeated `好。→（执行）→好。→Write.→…` in its reasoning for **112,109 characters**,
  emitted in **50,196 stream chunks over 126 seconds of continuous decoding**, and produced
  **zero tool calls** — so `repeat-tool-reminder` could not fire;
- automatic compaction never ran either: its trigger is
  `floor(min(W × 0.8, W − O − B))` ≈ 678k tokens for a 1M window with a 256k output cap,
  while the session peaked around 508k tokens;
- the loop only ended when the human pressed stop, and the polluted text stayed in the
  transcript, which made further loops more likely (self-imitation).

`output-loop-guard` listens on the live `agent/assistant-stream` frames and looks at the text itself.

## How it works

A sliding window over streamed output (1,200 characters by default, inspected every 64 new
characters) feeds four signals:

| Signal | Rule | Catches |
|---|---|---|
| `repeated-block` | **Shortest-period** block (≥2 newlines, ≥2 distinct non-whitespace chars) repeated ≥6 times | Multi-line cycles, e.g. the 106-character `好。→（执行）→Write.` cycle |
| `dominant-gram` | One n-gram covers ≥55% of the window with ≥24 occurrences and spans ≥2 lines | Loops whose tail is ragged but where repetition already dominates |
| `repeated-line` | Single-line runs: ≥40 in the reasoning channel, ≥60 in visible text (`singleLineTextMinRepeats`, `0` disables) | Reasoning spinning on one line, runaway line duplication in answers |
| `flat-tic` | Whitespace-free short gram covering ≥25% of the window with ≥48 occurrences, **reasoning only** | Line-less tics (`好。好。好。…`) |

Two design rules keep it precise:

- **Only the shortest period counts.** When one line repeats, 2× and 3× the line length are also
  "periods"; judging on an arbitrary period turned an ordinary bullet list into a "multi-line
  cycle" during calibration. The guard therefore looks only at the shortest period and requires
  that block itself to span ≥2 newlines.
- **Channel awareness.** Repeated lines in visible output are usually legitimate content
  (generated fixtures, config files, lists), so the visible-text single-line threshold is higher
  (60) than the reasoning one (40), and line-less tics are only judged in the reasoning channel.
  Indentation runs, `====` / `----` rule lines and blank-line runs never trip the guard.

On detection the guard:

1. calls `agent.cancel({ kind: 'hook', reason: 'output-loop-guard: …' })` — the in-flight
   generation is aborted and recorded as interrupted, so the degenerate text stops growing;
2. calls `agent.steer(<notice>)` — because the signal is already aborted, `steer` upgrades to a
   **fresh turn** and wakes the driver, so the agent immediately continues with an explicit
   correction (stop restating, emit the next action or finish);
3. after `maxTripsPerTurn` trips in one turn it stops auto-continuing and only `inject`s the
   notice, so a genuinely broken model cannot spin forever.

## Install

The package is a DSH **bundle** (`dsh.bundle.patch` → `cordis.patch.yml`, which inserts the
`output-loop-guard` row). Install it into a profile with the official plugin manager:

```sh
# from a local checkout
dsh plugin --profile <profile> add /path/to/dsh-output-loop-guard

# or from a git host (plain JS, so no build step is required)
dsh plugin --profile <profile> add github:ADistanceThereIs/dsh-output-loop-guard
```

The command links the package into the profile, appends it to `dsh.profile.bundles` and composes
the bundle's patch layer. **Restart DSH for the row to activate.**

Uninstall:

```sh
dsh plugin --profile <profile> remove dsh-output-loop-guard
```

## Configuration

Override the row in the profile's `cordis.patch.yml` (a patch replaces the row's whole `config`,
so restate every key you want to keep):

```yaml
- id: output-loop-guard
  name: dsh-output-loop-guard
  config:
    dryRun: false                 # true = detect and log only, never cancel
    autoContinue: true            # wake the agent with the corrective notice
    maxTripsPerTurn: 2            # auto-continue budget per turn
    windowChars: 1200
    checkEveryChars: 64
    minPeriodRepeats: 6           # repeats required for a multi-line cycle
    singleLineMinRepeats: 40      # reasoning-channel single-line threshold
    singleLineTextMinRepeats: 60  # visible-text single-line threshold (0 = off)
    useDominantGram: true
    dominantGramCoverage: 0.55
    dominantGramMinCount: 24
    useFlatTic: true
    ticMinCount: 48
    ticMinCoverage: 0.25
    verbose: false
```

Start with `dryRun: true` if you want to observe detections in your own sessions before letting
the guard abort anything.

## Evidence

### Corpus calibration

Replayed over 27 real sessions / 1,783 assistant steps (a corpus containing both healthy and
degenerate real output):

- 24 detections, **0 false positives**;
- every loop step of the motivating session was caught, plus a same-pattern loop in an unrelated
  session;
- detection latency: the 112,109-character runaway was caught after **2,944 characters (2.6 %)**;
  other loops were caught within 1,152–7,808 characters — hundreds of milliseconds instead of
  20–126 seconds of spinning.

### Runtime verification

End-to-end check in a live DSH runtime, on a task engineered to repeat two lines 300 times. The
session log of that run contains:

```json
{"type":"turn/end","data":{"turn":1,"reason":{"kind":"aborted","reason":{"kind":"hook","reason":"output-loop-guard: repeated output (repeated-block)"}}}}
{"type":"assistant/message","interrupted":true}          // cut off after 9 repetitions, not 300
{"type":"user/message","source":{"kind":"output-loop-guard","form":"notice"}}
```

The agent then delivered the same content as a **file** instead of continuing to repeat it, which
is exactly the intended outcome: the guard stops runaway output, it does not kill the task.

### Regression suite

`npm test` runs 21 self-contained checks (no corpus needed): the real degeneracy must be aborted
(24,180-character stream caught after 576 characters), healthy long documents must be untouched,
realistic written output (lists, code blocks, tables, rule lines, fixtures) must not trip,
runaway written lines must trip, `dryRun` must not cancel, a disabled plugin must attach nothing,
and a throwing agent handle must not break the stream.

## Limitations

- Visible-text single-line repetition needs ≥60 identical consecutive lines (that protects
  legitimate fixtures and lists); disable with `singleLineTextMinRepeats: 0`.
- Detection is structural (periodicity and density), not semantic: a modified near-repeat may
  escape `repeated-block`, though `dominant-gram` / `flat-tic` usually covers it.
- Trips are counted per agent and per attempt; subagents do not share counters.
- A trip discards the tool call that step had not emitted yet — one retry is the price for not
  spinning for minutes. Use `dryRun` to observe first.

## Event contract used

- `agent/assistant-stream` with payload `{ agent, frame }`, where
  `frame = { type: 'start' | 'chunk' | 'end', attemptId, revision, …, chunk }` and `chunk` is a
  `StreamChunk` (`reasoning-delta` / `text-delta` / …).
- `Agent.cancel(cause, options)` — the closed cause union is `user | parent | disposed | hook`;
  `hook` records its reason in `turn/end`, which is what this guard uses.
- `Agent.steer()` is `send(message, 'next-step', true)`; when the active signal is already
  aborted, `send` upgrades the target to `next-turn` and wakes the driver — hence
  `cancel(); steer(notice)` means "abort this generation, then continue in a new turn".

## Troubleshooting

**`dsh plugin add github:…` fails with `resolveGit` / `resolveRef` errors.**
pnpm resolves git dependencies with the `git` executable, and DSH inherits the environment of
the process that started it. If you installed Git *after* starting DSH, the new `PATH` entry is
not visible to it. Put Git on the `PATH` of the shell you use (or restart DSH) and retry, e.g.:

```powershell
$env:PATH = 'C:\Program Files\Git\cmd;' + $env:PATH
dsh plugin --profile <profile> add "github:ADistanceThereIs/dsh-output-loop-guard#<commit>"
```

Pin an exact commit (or tag) so a later push cannot silently change what runs on your machine.

**The guard tripped on output you wanted.**
Set `dryRun: true` to keep detection but stop the cancellation, raise the thresholds, or set
`singleLineTextMinRepeats: 0` to stop judging single-line repetition in visible text.

**The guard seems inactive.**
The bundle's row only activates after a DSH restart, and the row must appear in the composed
profile — for a non-application profile you can check it with
`dsh --profile <profile> --dump-config | Select-String output-loop-guard`.

## Development

```sh
node test/guard.test.mjs   # or: npm test
```

`detector.mjs` is dependency-free and importable on its own (`dsh-output-loop-guard/detector`),
so the detection logic can be reused or calibrated outside DSH.

## License

MIT — see [LICENSE](./LICENSE).

# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-17

### Added

- `output-loop-guard` bundle for DeepSeek Harness: watches the live
  `agent/assistant-stream` frames and detects self-repetition in model output.
- Four detection signals: `repeated-block` (shortest-period multi-line cycle),
  `dominant-gram` (one n-gram dominating the window), `repeated-line`
  (channel-aware single-line runs) and `flat-tic` (whitespace-free tic runs).
- On detection: `agent.cancel({ kind: 'hook' })` aborts the runaway generation
  and `agent.steer(notice)` wakes the agent into a fresh turn carrying a
  corrective notice; after `maxTripsPerTurn` trips the guard stops
  auto-continuing and only injects the notice.
- Configuration for every threshold, plus `dryRun` (observe-only) and
  `autoContinue` switches.
- Self-contained regression suite (`test/guard.test.mjs`, 21 checks) built from
  the real aborted stream that motivated the plugin.

### Notes

- Requires DeepSeek Harness `>=0.2.0-rc.2` (uses `agent/assistant-stream`,
  `Agent.cancel`, `Agent.steer`).
- Calibrated against 27 real sessions / 1,783 assistant steps: 24 detections,
  0 false positives.

[0.1.0]: https://github.com/ADistanceThereIs/dsh-output-loop-guard/releases/tag/v0.1.0

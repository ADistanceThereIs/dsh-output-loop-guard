/**
 * Repetition detection for streamed model output.
 *
 * Pure logic, no imports: used by the DSH plugin and by the offline evaluator.
 * The failure mode it targets is token-level degeneration — the model cycling
 * a short multi-line block ("好。→（执行）→好。→Write.→…") instead of producing
 * a tool call, burning minutes of decode time until a human presses stop.
 *
 * Signals, each requiring "informative" content so that legitimate repetition
 * (indentation, markdown rules, identical code lines in written output) never
 * trips the guard:
 *  1. cycle        — the tail is N consecutive copies of one multi-line block.
 *  2. dominantGram — one multi-line n-gram covers an implausible share of the window.
 *  3. flatTic      — a short whitespace-free gram repeated at a density no
 *                    human-readable text reaches ("好。好。好。…").
 *
 * Channel awareness: repeating a single identical line is only treated as
 * degeneration inside the *reasoning* channel (and only at a high repeat
 * count). The same pattern in visible text is legitimate — a written file, a
 * fixture or a list may contain many identical lines.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** Characters of recent output kept for inspection. */
  windowChars: 1200,
  /** How often (in newly produced characters) the window is inspected. */
  checkEveryChars: 64,
  /** Informative-character floor for a candidate block/gram. */
  minDistinctNonSpaceChars: 2,
  /** Smallest block length considered a period. */
  minPeriod: 2,
  /** Largest block length considered a period. */
  maxPeriod: 512,
  /** Consecutive identical periods required to declare a multi-line cycle. */
  minPeriodRepeats: 6,
  /**
   * Consecutive identical single lines required in the reasoning channel
   * before a single-line cycle counts as degeneration.
   */
  singleLineMinRepeats: 40,
  /**
   * Same threshold for the *visible text* channel. Higher, because written
   * output legitimately contains repeated lines (fixtures, lists, configs).
   * `0` disables single-line detection in visible text entirely.
   */
  singleLineTextMinRepeats: 60,
  /** n-gram lengths probed by the density signal. */
  gramLengths: [2, 3, 4, 6, 8, 12, 16],
  /** Share of the window one n-gram must cover to declare a loop. */
  dominantGramCoverage: 0.55,
  /** Absolute occurrence count an n-gram needs before it counts as dominant. */
  dominantGramMinCount: 24,
  /** Kill switch for the density signal. */
  useDominantGram: true,
  /** n-gram lengths probed by the flat-tic signal. */
  ticGramLengths: [2, 3, 4],
  /** Occurrences of one whitespace-free gram that prove a flat tic. */
  ticMinCount: 48,
  /** Share of the window a flat tic gram must cover. */
  ticMinCoverage: 0.25,
  /** Kill switch for the flat-tic signal. */
  useFlatTic: true,
})

const BASE = 0x01000193 >>> 0 // FNV-1a prime

/** Rolling-hash prefix table: hash(l, r) over text[l..r) in O(1). */
function rollingHashes(text) {
  const n = text.length
  const prefix = new Uint32Array(n + 1)
  const pow = new Uint32Array(n + 1)
  pow[0] = 1
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = (Math.imul(prefix[i], BASE) + text.charCodeAt(i)) >>> 0
    pow[i + 1] = Math.imul(pow[i], BASE) >>> 0
  }
  return {
    hash(l, r) {
      return (prefix[r] - Math.imul(prefix[l], pow[r - l])) >>> 0
    },
  }
}

/** Distinct non-whitespace characters in a block (informativeness measure). */
export function distinctNonSpace(block) {
  const seen = new Set()
  for (const ch of block) if (!/\s/.test(ch)) seen.add(ch)
  return seen.size
}

/** Line structure and information content of a candidate block. */
export function blockInformation(block) {
  let newlines = 0
  let whitespaceOnly = true
  for (const ch of block) {
    if (ch === '\n') newlines++
    if (!/\s/.test(ch)) whitespaceOnly = false
  }
  return { newlines, distinct: distinctNonSpace(block), whitespaceOnly }
}

/**
 * Every trailing period of `text` (shortest first): a period p qualifies when
 * the last `minPeriodRepeats` blocks of length p are identical. No
 * informativeness filtering — the caller decides.
 *
 * Only the SHORTEST qualifying period is meaningful: if a single line repeats,
 * then 2×, 3× … the line length are periods too, but they are artifacts of the
 * same line repetition, not a multi-line cycle.
 * @param text - window.
 * @param options - minPeriod / maxPeriod / minPeriodRepeats.
 * @returns array of `{ period, repeats, block }`, ascending by period.
 */
export function trailingPeriods(text, { minPeriod = 2, maxPeriod = 512, minPeriodRepeats = 6 } = {}) {
  const n = text.length
  const limit = Math.min(maxPeriod, Math.floor(n / minPeriodRepeats))
  const out = []
  if (limit < minPeriod) return out
  const { hash } = rollingHashes(text)
  for (let p = minPeriod; p <= limit; p++) {
    let ok = true
    const last = hash(n - p, n)
    for (let k = 1; k < minPeriodRepeats; k++) {
      const end = n - k * p
      if (end < p) {
        ok = false
        break
      }
      if (hash(end - p, end) !== last) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const block = text.slice(n - p)
    let repeats = minPeriodRepeats
    while ((repeats + 1) * p <= n && text.slice(n - (repeats + 1) * p, n - repeats * p) === block) repeats++
    out.push({ period: p, repeats, block })
    break // shortest qualifying period only
  }
  return out
}

/** Backwards-compatible single-result helper. */
export function findTrailingPeriod(text, options) {
  return trailingPeriods(text, options)[0] || null
}

/**
 * Most frequent n-gram in the window, with its coverage of the window.
 * @param text - window.
 * @param lengths - n-gram lengths to probe.
 * @returns `{ length, gram, count, coverage }` for the best (count × coverage) candidate.
 */
export function dominantGram(text, lengths = DEFAULTS.gramLengths) {
  let best = null
  for (const length of lengths) {
    if (text.length < length * 6) continue
    const counts = new Map()
    let bestLocal = null
    for (let i = 0; i + length <= text.length; i++) {
      const gram = text.substr(i, length)
      const count = (counts.get(gram) || 0) + 1
      counts.set(gram, count)
      if (bestLocal === null || count > bestLocal.count) bestLocal = { length, gram, count }
    }
    if (!bestLocal) continue
    const candidate = { ...bestLocal, coverage: (bestLocal.count * length) / text.length }
    if (best === null || candidate.coverage * candidate.count > best.coverage * best.count) best = candidate
  }
  return best
}

/**
 * Flat tic: a short whitespace-free gram repeated at a density no
 * human-readable text reaches.
 * @param text - window.
 * @param lengths - short gram lengths to probe.
 * @param minCount - occurrences required.
 * @param minCoverage - share of the window the gram must cover.
 * @returns the best qualifier, or null.
 */
export function flatTic(text, lengths = DEFAULTS.ticGramLengths, minCount = DEFAULTS.ticMinCount, minCoverage = DEFAULTS.ticMinCoverage) {
  let best = null
  for (const length of lengths) {
    if (text.length < length * 8) continue
    const counts = new Map()
    for (let i = 0; i + length <= text.length; i++) {
      const gram = text.substr(i, length)
      if (/\s/.test(gram)) continue
      if (distinctNonSpace(gram) < 2) continue
      const count = (counts.get(gram) || 0) + 1
      counts.set(gram, count)
      if (best === null || count * length > best.count * best.length) best = { length, gram, count, coverage: (count * length) / text.length }
    }
  }
  if (!best || best.count < minCount || best.coverage < minCoverage) return null
  return best
}

/** Streaming detector: feed deltas, get a verdict when output degenerates. */
export class RepetitionDetector {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options }
    this.reset()
  }

  reset() {
    this.tail = ''
    this.pending = 0
    this.chars = 0
    this.tripped = null
    this.channels = new Set()
  }

  /** True while every observed delta came from the reasoning channel. */
  get reasoningOnly() {
    return this.channels.size > 0 && !this.channels.has('text')
  }

  /**
   * Feed one delta of model output.
   * @param text - delta text.
   * @param channel - `'reasoning'` or `'text'`.
   * @returns null, or a verdict `{ reason, detail, chars }`.
   */
  push(text, channel = 'reasoning') {
    if (this.tripped || !text) return null
    this.channels.add(channel === 'text' ? 'text' : 'reasoning')
    this.tail += text
    this.chars += text.length
    this.pending += text.length
    const { windowChars } = this.options
    if (this.tail.length > windowChars) this.tail = this.tail.slice(-windowChars)
    if (this.pending < this.options.checkEveryChars) return null
    this.pending = 0
    return this.check()
  }

  /** Inspect the current window immediately. */
  check() {
    if (this.tripped) return null
    const window = this.tail
    const floor = this.options.minDistinctNonSpaceChars
    const reasoningOnly = this.reasoningOnly

    // 1. trailing repetition. Only the shortest period counts: a repeated
    //    single line also has 2×/3× periods, so a "multi-line" verdict must
    //    come from the shortest block itself.
    const period = trailingPeriods(window, this.options)[0] || null
    if (period) {
      const info = blockInformation(period.block)
      if (!info.whitespaceOnly && info.distinct >= floor) {
        if (info.newlines >= 2) {
          return this.trip('repeated-block', {
            period: period.period,
            repeats: period.repeats,
            block: period.block.slice(0, 60),
            distinct: info.distinct,
            lines: info.newlines + 1,
          })
        }
        // Single-line repetition: less tolerated in the reasoning channel, and
        // only pathological in written output once it really runs away.
        const threshold = reasoningOnly ? this.options.singleLineMinRepeats : this.options.singleLineTextMinRepeats
        if (threshold > 0 && period.repeats >= threshold) {
          return this.trip('repeated-line', {
            period: period.period,
            repeats: period.repeats,
            block: period.block.slice(0, 60),
            distinct: info.distinct,
            lines: 1,
            channel: reasoningOnly ? 'reasoning' : 'text',
          })
        }
      }
      // A repeating line is not a cycle; skip the density signal entirely so a
      // multi-line window over one repeated line cannot masquerade as one.
      return this.checkFlatTic(window, reasoningOnly)
    }

    // 2. dominant multi-line gram (no clean trailing run, but repetition dominates)
    if (this.options.useDominantGram) {
      const gram = dominantGram(window, this.options.gramLengths)
      if (gram && gram.count >= this.options.dominantGramMinCount && gram.coverage >= this.options.dominantGramCoverage) {
        const info = blockInformation(gram.gram)
        const multiLine = info.newlines >= 2 && !info.whitespaceOnly && info.distinct >= floor
        const richSingleLineLoop =
          info.newlines <= 1 && !info.whitespaceOnly && info.distinct >= 4 && reasoningOnly && gram.count >= this.options.singleLineMinRepeats
        if (multiLine || richSingleLineLoop) {
          return this.trip('dominant-gram', {
            length: gram.length,
            gram: gram.gram.slice(0, 60),
            count: gram.count,
            coverage: Number(gram.coverage.toFixed(3)),
            lines: info.newlines + 1,
          })
        }
      }
    }

    return this.checkFlatTic(window, reasoningOnly)
  }

  /** Signal 3: no line structure at all — reasoning channel only. */
  checkFlatTic(window, reasoningOnly) {
    if (!this.options.useFlatTic || !reasoningOnly) return null
    const tic = flatTic(window, this.options.ticGramLengths, this.options.ticMinCount, this.options.ticMinCoverage)
    if (tic) {
      return this.trip('flat-tic', {
        length: tic.length,
        gram: tic.gram.slice(0, 60),
        count: tic.count,
        coverage: Number(tic.coverage.toFixed(3)),
      })
    }
    return null
  }

  trip(reason, detail) {
    this.tripped = { reason, detail, chars: this.chars }
    return this.tripped
  }
}

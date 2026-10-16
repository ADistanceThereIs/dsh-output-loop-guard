/**
 * output-loop-guard — DSH guard against self-repetition in streamed model output.
 *
 * The framework ships `repeat-tool-reminder`, which only sees *duplicate tool
 * calls*. The failure mode this guard targets is different: the model keeps
 * emitting the same short block in its reasoning channel ("好。→（执行）→好。→
 * Write.→…") and never produces a tool call, so the step burns minutes of
 * decode time until the human presses stop.
 *
 * This guard watches the live `agent/assistant-stream` frames, detects the
 * repetition, aborts the in-flight turn (`Agent.cancel({ kind: 'hook' })`) and
 * wakes the agent with a corrective notice so the task continues without the
 * human having to type "继续".
 *
 * Zero hard dependencies: the harness message helper is loaded opportunistically
 * and a structurally equivalent fallback is used when it is unavailable.
 *
 * @module dsh-output-loop-guard
 */

import { randomUUID } from 'node:crypto'
import { RepetitionDetector, DEFAULTS } from './detector.mjs'

export const name = 'output-loop-guard'
export const inject = []

/** Structurally equivalent stand-in for the harness `createUserMessage`. */
function fallbackUserMessage(input) {
  return { id: randomUUID(), role: 'user', ...input }
}

/** Unresolved until the first fire(); resolved once per process. */
let userMessageFactory = null
async function resolveUserMessageFactory(log) {
  if (userMessageFactory) return userMessageFactory
  try {
    const llm = await import('@deepseek-ai/dsh-llm')
    userMessageFactory = typeof llm.createUserMessage === 'function' ? llm.createUserMessage : fallbackUserMessage
  } catch (error) {
    log.warn(`@deepseek-ai/dsh-llm unavailable (${String(error)}); using local message builder`)
    userMessageFactory = fallbackUserMessage
  }
  return userMessageFactory
}

const RULES = [
  '立即执行下一步动作（发出工具调用）或直接结束任务，不要再复述计划。',
  '不要使用「好。」「（执行）」「Write.」这类零信息填充句。',
  '如果你确实无法继续，用一句话说明卡在哪里然后结束，不要重复同一段说明。',
].join('\n')

function noticeText(summary, willContinue) {
  return [
    `[output-loop-guard] 检测到你的输出在原地重复（${summary}），本步骤已被中止。`,
    '',
    '接下来必须遵守：',
    RULES,
    '',
    willContinue
      ? '请从中断处继续完成任务：直接产出下一个动作或最终答复。'
      : '本回合已停止自动继续，请等待用户指示。',
  ].join('\n')
}

function summarize(verdict) {
  const d = verdict.detail || {}
  if (verdict.reason === 'repeated-block') {
    return `同一 ${d.period} 字符片段连续重复 ${d.repeats} 次：${JSON.stringify(d.block)}`
  }
  if (verdict.reason === 'dominant-gram') {
    return `${d.length} 字符片段占最近输出的 ${Math.round((d.coverage || 0) * 100)}%（出现 ${d.count} 次）：${JSON.stringify(d.gram)}`
  }
  return String(verdict.reason)
}

function number(value, fallback, min) {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return min === undefined ? parsed : Math.max(min, parsed)
}

/** Last installed guard state, exposed for tests (one plugin instance per process). */
let lastGuard = null

/**
 * Read the most recently installed guard instance.
 * @returns `{ stats, detectorOptions, attempts, turnTrips }` or null.
 */
export function guardState() {
  return lastGuard
}

/**
 * Install the guard.
 *
 * Never returns a value: Cordis treats an async `apply`'s resolution as an
 * effect, and a non-disposer object fails the plugin with `Invalid effect`.
 *
 * @param ctx - plugin context (uses `ctx.on`, `ctx.logger`, `ctx.effect`).
 * @param config - plugin configuration; every key is optional (see README).
 */
export async function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const log = typeof ctx.logger === 'function' ? ctx.logger(name) : console
  if (settings.enabled === false) {
    log.info('disabled by config')
    return
  }

  const detectorOptions = {
    windowChars: number(settings.windowChars, DEFAULTS.windowChars, 64),
    checkEveryChars: number(settings.checkEveryChars, DEFAULTS.checkEveryChars, 8),
    minPeriodRepeats: number(settings.minPeriodRepeats, DEFAULTS.minPeriodRepeats, 2),
    singleLineMinRepeats: number(settings.singleLineMinRepeats, DEFAULTS.singleLineMinRepeats, 2),
    singleLineTextMinRepeats: number(settings.singleLineTextMinRepeats, DEFAULTS.singleLineTextMinRepeats, 0),
    maxPeriod: number(settings.maxPeriod, DEFAULTS.maxPeriod, 2),
    minDistinctNonSpaceChars: number(settings.minDistinctNonSpaceChars, DEFAULTS.minDistinctNonSpaceChars, 1),
    useDominantGram: settings.useDominantGram !== false,
    dominantGramCoverage: number(settings.dominantGramCoverage, DEFAULTS.dominantGramCoverage, 0.05),
    dominantGramMinCount: number(settings.dominantGramMinCount, DEFAULTS.dominantGramMinCount, 2),
    useFlatTic: settings.useFlatTic !== false,
    ticMinCount: number(settings.ticMinCount, DEFAULTS.ticMinCount, 2),
    ticMinCoverage: number(settings.ticMinCoverage, DEFAULTS.ticMinCoverage, 0.05),
  }
  const dryRun = settings.dryRun === true
  const autoContinue = settings.autoContinue !== false
  const maxTripsPerTurn = number(settings.maxTripsPerTurn, 2, 0)
  const verbose = settings.verbose === true

  const attempts = new Map()
  const turnTrips = new Map()
  const stats = { chunks: 0, trips: 0, cancelled: 0, notices: 0, noticeFailed: 0, dryRuns: 0 }

  /** Abort one runaway generation and hand the agent a corrective notice. */
  function fire(attempt, verdict) {
    stats.trips++
    const summary = summarize(verdict)
    log.warn(`repetition detected after ${verdict.chars} chars: ${summary}`)

    if (dryRun) {
      stats.dryRuns++
      log.warn('dryRun is on: not cancelling')
      return
    }
    const agent = attempt.agent
    if (!agent || typeof agent.cancel !== 'function') {
      log.warn('agent handle unavailable: cannot cancel')
      return
    }

    const key = String(agent.id ?? 'unknown')
    const previous = turnTrips.get(key)
    const trips = previous && previous.turn === attempt.turn ? previous.trips + 1 : 1
    turnTrips.set(key, { turn: attempt.turn, trips })
    const willContinue = autoContinue && trips <= maxTripsPerTurn

    try {
      agent.cancel({ kind: 'hook', reason: `output-loop-guard: repeated output (${verdict.reason})` })
      stats.cancelled++
    } catch (error) {
      log.warn(`cancel failed: ${String(error)}`)
      return
    }

    const build = userMessageFactory || fallbackUserMessage
    let message
    try {
      message = build({
        content: [{ type: 'text', text: noticeText(summary, willContinue) }],
        source: { kind: 'output-loop-guard', form: 'notice', summary },
      })
    } catch (error) {
      log.warn(`notice construction failed: ${String(error)}`)
      return
    }

    try {
      // steer() upgrades to a fresh turn when the active signal is already aborted.
      if (willContinue) agent.steer(message)
      else agent.inject(message)
      stats.notices++
    } catch (error) {
      stats.noticeFailed++
      log.warn(`notice delivery failed: ${String(error)}`)
    }
  }

  /** Inspect one live stream frame; never throws into the stream. */
  function onFrame(payload) {
    try {
      const agent = payload?.agent
      const frame = payload?.frame
      if (!frame || !agent) return

      if (frame.type === 'start') {
        if (attempts.size >= 64) attempts.clear()
        attempts.set(frame.attemptId, {
          agent,
          turn: frame.turn,
          step: frame.step,
          tripped: false,
          detector: new RepetitionDetector(detectorOptions),
        })
        return
      }
      if (frame.type === 'end') {
        attempts.delete(frame.attemptId)
        return
      }

      const attempt = attempts.get(frame.attemptId)
      if (!attempt || attempt.tripped) return
      const chunk = frame.chunk
      if (!chunk) return
      if (chunk.type !== 'reasoning-delta' && chunk.type !== 'text-delta') return

      stats.chunks++
      const channel = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      const verdict = attempt.detector.push(chunk.text || '', channel)
      if (!verdict) {
        if (verbose && stats.chunks % 200 === 0) {
          log.debug(`clean after ${attempt.detector.chars} chars (attempt ${frame.attemptId})`)
        }
        return
      }
      attempt.tripped = true
      fire(attempt, verdict)
    } catch (error) {
      try {
        log.warn(`guard handler failed: ${String(error)}`)
      } catch {
        /* logging must never break the stream */
      }
    }
  }

  await resolveUserMessageFactory(log)
  ctx.on('agent/assistant-stream', onFrame)
  ctx.effect(() => () => {
    attempts.clear()
    turnTrips.clear()
  })
  lastGuard = { stats, detectorOptions, attempts, turnTrips }

  log.info(
    `armed: window=${detectorOptions.windowChars} every=${detectorOptions.checkEveryChars} ` +
      `repeats=${detectorOptions.minPeriodRepeats} gram=${detectorOptions.useDominantGram} ` +
      `dryRun=${dryRun} autoContinue=${autoContinue} maxTripsPerTurn=${maxTripsPerTurn}`
  )
}

// Self-contained control-flow tests for the output-loop guard.
//
// The degeneracy samples are reconstructed from the real aborted stream of
// session-60017eba (TwilightEcho install, 2026-10-17): its 112,109-character
// reasoning collapsed into a fixed cycle. The cycle below is the exact block
// recovered from that session log, repeated to the lengths the tests need.
import { apply, name, guardState } from '../index.js'

/** The exact 106-character cycle recovered from the aborted seq=937 stream. */
const CYCLE =
  '。\n\n（执行）\n\n好。\n\nWrite.\n\n好。\n\n好。\n\nOK.\n\n好。\n\n（执行）\n\n好。\n\nWrite.\n\n好。\n\n'

const loop937 = { seq: 937, turn: 8, step: 4, text: CYCLE.repeat(40) }
const loop930 = { seq: 930, turn: 8, step: 3, text: CYCLE.repeat(12) }
const loop969 = { seq: 969, turn: 9, step: 1, text: CYCLE.repeat(12) }

/** A realistic, non-repetitive long analysis (mixed CJK, identifiers, paths). */
const HEALTHY = Array.from({ length: 60 }, (_, i) => {
  const topics = [
    `第 ${i + 1} 步：检查 app.asar 中 installPlugin(source) 的分支，确认 plugin-state.json 的 source 必须在 PLUGIN_SOURCES 集合内。`,
    `清单里 version=${i}.0.${i} 的条目 checksumSha256 与本地包不一致，说明索引更新滞后于 release。`,
    `把 resources/plugin-index/plugins.json 的默认 URL 与用户给的仓库做对比，二者指向同一个 raw.githubusercontent 路径。`,
    `注意卡巴斯基 PDM 风险：避免 Get-ChildItem -Recurse 扫全盘，改用注册表定向查询。`,
  ]
  return topics[i % topics.length]
}).join('\n')

/** Minimal Cordis-ish context capturing listeners and effects. */
function makeCtx(logs) {
  const listeners = new Map()
  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: () => ({
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      debug: (m) => logs.push(`debug ${m}`),
    }),
  }
  return { ctx, listeners }
}

function makeAgent(id) {
  const calls = { cancel: [], steer: [], inject: [] }
  return {
    id,
    status: 'running',
    cancel: (cause, options) => calls.cancel.push({ cause, options }),
    steer: (message) => calls.steer.push(message),
    inject: (message) => calls.inject.push(message),
    calls,
  }
}

/** Stream a step through the guard the way the agent loop does. */
function stream(listeners, agent, step, channel = 'reasoning-delta', chunkSize = 8) {
  const emit = (frame) => {
    for (const handler of listeners.get('agent/assistant-stream') || []) handler({ agent, frame })
  }
  const before = agent.calls ? agent.calls.cancel.length : 0
  const attemptId = `attempt-${step.seq}-${Math.random().toString(36).slice(2, 7)}`
  emit({ type: 'start', attemptId, revision: 1, turn: step.turn, step: step.step })
  const body = step.text
  for (let i = 0; i < body.length; i += chunkSize) {
    emit({
      type: 'chunk',
      attemptId,
      revision: 1,
      index: i,
      time: Date.now(),
      chunk: { type: channel, index: 0, text: body.slice(i, i + chunkSize) },
    })
    if (agent.calls && agent.calls.cancel.length > before) break // the loop stops pushing after cancellation
  }
  emit({ type: 'end', attemptId, revision: 1, index: 0, outcome: { kind: 'committed' } })
}

let failures = 0
function check(label, condition, extra = '') {
  if (condition) console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  else {
    failures++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// --- scenario 1: the real degeneracy is aborted and the agent is woken
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, loop937)
  check('loop sample cancels the turn', agent.calls.cancel.length === 1)
  check('cancel cause is the hook kind', agent.calls.cancel[0]?.cause?.kind === 'hook', JSON.stringify(agent.calls.cancel[0]?.cause || {}))
  check('corrective notice is steered (auto-continue)', agent.calls.steer.length === 1 && agent.calls.inject.length === 0)
  const notice = agent.calls.steer[0]
  check('notice is a user message with plugin source', notice?.role === 'user' && notice?.source?.kind === 'output-loop-guard')
  check('notice text names the guard', String(notice?.content?.[0]?.text || '').includes('output-loop-guard'))
  check('apply resolves to undefined (Cordis effect contract)', (await apply(ctx, {})) === undefined)
  console.log(`      stats=${JSON.stringify(guardState().stats)}`)
}

// --- scenario 2: healthy long output is never touched
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  for (let i = 0; i < 6; i++) stream(listeners, agent, { seq: 600 + i, turn: 20 + i, step: 1, text: HEALTHY })
  check('six healthy long documents stay untouched', agent.calls.cancel.length === 0, `chars=${HEALTHY.length}`)
}

// --- scenario 3: repeated trips inside one turn stop auto-continuing
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, { maxTripsPerTurn: 1 })
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, loop930) // turn 8
  stream(listeners, agent, loop937) // turn 8 again
  check(
    'first trip in a turn steers, the second only injects',
    agent.calls.steer.length === 1 && agent.calls.inject.length === 1,
    `steer=${agent.calls.steer.length} inject=${agent.calls.inject.length}`
  )
}

// --- scenario 3b: a new turn resets the trip budget
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, { maxTripsPerTurn: 1 })
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, loop930) // turn 8
  stream(listeners, agent, loop969) // turn 9
  check('trip budget resets per turn', agent.calls.steer.length === 2, `steer=${agent.calls.steer.length}`)
}

// --- scenario 4: dryRun observes without touching the turn
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, { dryRun: true })
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, loop937)
  check('dryRun never cancels', agent.calls.cancel.length === 0 && agent.calls.steer.length === 0)
  check('dryRun still logs the detection', logs.some((l) => l.startsWith('warn repetition detected')))
}

// --- scenario 5: disabled plugin attaches nothing
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, { enabled: false })
  check('disabled plugin registers no listener', (listeners.get('agent/assistant-stream') || []).length === 0)
}

// --- scenario 6: multi-line repetition in visible text is caught too
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, { seq: 901, turn: 30, step: 1, text: '让我们开始吧。\n\n（继续）\n\n'.repeat(200) }, 'text-delta')
  check('visible-text multi-line repetition is caught', agent.calls.cancel.length === 1)
}

// --- scenario 7: realistic written output is not a loop
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  const written = [
    '## Heading\n\n' + '================\n'.repeat(60),
    '```\n' + '    indented line\n'.repeat(50) + '```\n',
    Array.from({ length: 80 }, (_, i) => `- 第 ${i + 1} 项检查完成\n`).join(''),
    '----------\n'.repeat(100),
    'print("x")\n'.repeat(30),
    '| 名称 | 值 |\n| --- | --- |\n' + Array.from({ length: 40 }, (_, i) => `| key${i} | ${i} |\n`).join(''),
  ]
  written.forEach((text, i) => stream(listeners, agent, { seq: 500 + i, turn: 40 + i, step: 1, text }, 'text-delta'))
  check('realistic written output never trips', agent.calls.cancel.length === 0, `cancels=${agent.calls.cancel.length}`)
}

// --- scenario 7a: runaway identical lines in written output ARE caught
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, { seq: 800, turn: 50, step: 1, text: '（执行）好。\n'.repeat(300) }, 'text-delta')
  check('300 identical written lines are caught', agent.calls.cancel.length === 1)
}

// --- scenario 7b: modest single-line repetition in reasoning is tolerated
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, { seq: 700, turn: 60, step: 1, text: '检查第 3 项。\n'.repeat(20) })
  check('20 identical reasoning lines stay under the radar', agent.calls.cancel.length === 0)
}

// --- scenario 7c: runaway single-line repetition in reasoning is caught
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, { seq: 701, turn: 61, step: 1, text: '我再确认一下。\n'.repeat(200) })
  check('200 identical reasoning lines are caught', agent.calls.cancel.length === 1)
}

// --- scenario 8: a throwing agent handle cannot break the stream
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = {
    id: 'broken',
    status: 'running',
    calls: { cancel: [], steer: [], inject: [] },
    cancel: () => {
      throw new Error('boom')
    },
    steer: () => {},
    inject: () => {},
  }
  stream(listeners, agent, loop937)
  check('throwing cancel is contained and logged', logs.some((l) => l.includes('cancel failed')))
}

// --- scenario 9: flat tic with no line structure is caught
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  stream(listeners, agent, { seq: 900, turn: 70, step: 1, text: '好。'.repeat(800) })
  check('flat tic without newlines is caught', agent.calls.cancel.length === 1)
}

// --- scenario 10: the cycle is caught within a small prefix of the stream
{
  const logs = []
  const { ctx, listeners } = makeCtx(logs)
  await apply(ctx, {})
  const agent = makeAgent('session-under-test')
  const emit = (frame) => {
    for (const handler of listeners.get('agent/assistant-stream') || []) handler({ agent, frame })
  }
  const body = '前置的合法分析。\n'.repeat(20) + CYCLE.repeat(400)
  const attemptId = 'bounded'
  let consumed = 0
  emit({ type: 'start', attemptId, revision: 1, turn: 80, step: 1 })
  for (let i = 0; i < body.length && agent.calls.cancel.length === 0; i += 8) {
    emit({ type: 'chunk', attemptId, revision: 1, index: i, time: Date.now(), chunk: { type: 'reasoning-delta', index: 0, text: body.slice(i, i + 8) } })
    consumed = i + 8
  }
  check(
    `detected after ${consumed} of ${body.length} chars`,
    agent.calls.cancel.length === 1 && consumed < body.length / 10,
    `consumed=${consumed}`
  )
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1

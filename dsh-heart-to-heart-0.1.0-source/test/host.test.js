import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { apply } from '../src/host.js'
import { FINISH_TEXT, requestId } from '../src/wire.js'

function fixture() {
  const handlers = new Map()
  const calls = []
  const effects = []
  let active = true
  let toolAvailable = true
  let context
  let guard
  const session = {}
  const agent = {
    id: 'test', session,
    whenIdle: async () => {},
    runMaintenance: job => job(new AbortController().signal),
  }
  const ctx = {
    on: (event, listener) => handlers.set(event, listener),
    effect: setup => effects.push(setup()),
    loader: { entries: () => active ? [{ options: { name: '@kenz1117/dsh-engram' }, fiber: { state: 2 } }] : [] },
    agents: { get: () => agent, withInitiator: (_agent, run) => run() },
    systemPrompt: { context: section => { context = section } },
    tools: {
      guard: check => { guard = check },
      executable: () => toolAvailable ? { execute() {} } : undefined,
      execute: async batch => {
        calls.push(...batch.calls)
        return { results: [{ result: { isError: false } }] }
      },
    },
    logger: { warn: assert.fail },
  }
  apply(ctx)
  return {
    calls, agent, guidance: () => context.text({ agent }), guard: () => guard({ agent }),
    withoutEngram: () => { active = false },
    denyTool: () => { toolAvailable = false },
    dispose: () => effects.forEach(dispose => dispose()),
    claim(text, mode, turn, principal) {
      handlers.get('agent/inbox/claimed')({ agent, turn, message: {
        source: { kind: 'user', rpcId: mode ? requestId(mode, randomUUID()) : randomUUID(), principal },
        content: [{ type: 'text', text }],
      } })
    },
    async end(turn, kind = 'completed') {
      handlers.get('session/event')(session, { type: 'turn/end', data: { turn, reason: { kind } } })
      await setImmediate()
    },
  }
}
const preference = '以后我难过时，希望你先听我说完。'

test('only writes an opted-in finished turn, using the user scope and a scoped tool', async () => {
  const f = fixture()
  f.claim(preference, 'briefWithMemory', 1)
  assert.match(f.guidance(), /still telling/)
  assert.ok(f.guard())
  await f.end(1)
  assert.equal(f.calls.length, 0)
  f.claim(FINISH_TEXT, 'finishWithMemory', 2)
  assert.match(f.guidance(), /handed you the floor/)
  await f.end(2)
  assert.equal(f.guidance(), '')
  assert.equal(f.guard(), undefined)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].name, 'engram_save')
  assert.deepEqual(JSON.parse(f.calls[0].arguments), {
    scope: 'user',
    items: [{ kind: 'preference', content: '用户倾诉时，希望先把话说完，再听对方展开回应。' }],
  })
})

test('missing, restricted, disabled, cancelled, and non-owner cases skip Engram', async () => {
  for (const mode of ['missing', 'restricted', 'disabled', 'cancelled', 'non-owner']) {
    const f = fixture()
    if (mode === 'missing') f.withoutEngram()
    if (mode === 'restricted') f.denyTool()
    f.claim(preference, mode === 'disabled' ? 'final' : 'finalWithMemory', 1,
      mode === 'non-owner' ? { kind: 'guest' } : undefined)
    await f.end(1, mode === 'cancelled' ? 'aborted' : 'completed')
    assert.equal(f.calls.length, 0, mode)
  }
})

test('an explicit opt-out in an earlier brief turn suppresses the whole round', async () => {
  const f = fixture()
  f.claim('这段别记。', 'briefWithMemory', 1)
  await f.end(1)
  f.claim(preference, 'finalWithMemory', 2)
  await f.end(2)
  assert.equal(f.calls.length, 0)
})

test('opting in at the end does not include fragments sent while memory was off', async () => {
  const f = fixture()
  f.claim(preference, 'brief', 1)
  await f.end(1)
  f.claim(FINISH_TEXT, 'finishWithMemory', 2)
  await f.end(2)
  assert.equal(f.calls.length, 0)
})

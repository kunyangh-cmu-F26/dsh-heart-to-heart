import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { automaticReply, batchFor, pauseDecision, PAUSES } from '../src/listening.js'
import { extractPreferences } from '../src/preferences.js'
import { FINISH_TEXT, listenMode, requestId } from '../src/wire.js'

test('holds an unfinished story, replies to a direct cue, and recognizes a natural close', () => {
  assert.equal(pauseDecision('我还没说完。', 3), undefined)
  assert.equal(pauseDecision('今天发生了一件事。', 1), undefined)
  assert.deepEqual(pauseDecision('还有一件事……', 3), { kind: 'brief', delay: PAUSES.continuing })
  assert.deepEqual(pauseDecision('你还在听吗？', 1), { kind: 'brief', delay: PAUSES.asked })
  assert.deepEqual(pauseDecision('你觉得呢？', 1), { kind: 'final', delay: PAUSES.asked })
  assert.deepEqual(pauseDecision('后来我们就没再联系了。', 2), { kind: 'final', delay: PAUSES.ending })
})

test('limits the frequency of interjections and permits a final reply during cooldown', () => {
  const state = { enabled: true, pending: false, failed: null, parts: ['还有一件事'], partCount: 2, lastBrief: 0, lastPart: 5_000 }
  assert.deepEqual(automaticReply(state, 10_000), { kind: 'brief', delay: 30_000 })
  assert.deepEqual(automaticReply(state, 40_000), { kind: 'brief', delay: PAUSES.continuing })
  assert.deepEqual(automaticReply({ ...state, parts: ['你怎么看？'] }, 10_000), { kind: 'final', delay: PAUSES.asked })
  assert.equal(automaticReply({ ...state, pending: true }, 40_000), undefined)
  assert.equal(automaticReply({ ...state, failed: {} }, 40_000), undefined)
})

test('groups fragments without adding prompt instructions to the visible message', () => {
  const state = { parts: ['第一段', '第二段'], remember: false }
  assert.deepEqual(batchFor(state, 'final'), { text: '第一段\n\n第二段', mode: 'final' })
  assert.deepEqual(batchFor({ ...state, remember: true }, 'brief'), { text: '第一段\n\n第二段', mode: 'briefWithMemory' })
  assert.deepEqual(batchFor({ parts: [], remember: true }, 'final'), { text: FINISH_TEXT, mode: 'finishWithMemory' })
})

test('round-trips intent in UUID-shaped receipts and ignores normal messages', () => {
  for (const mode of ['brief', 'final', 'finalWithMemory', 'finish', 'finishWithMemory', 'briefWithMemory']) {
    const original = randomUUID()
    const encoded = requestId(mode, original)
    assert.equal(encoded.slice(8), original.slice(8))
    assert.equal(listenMode(encoded), mode)
  }
  assert.equal(listenMode('00000000-0000-4000-8000-000000000000'), undefined)
  assert.equal(listenMode('f2c4e781'), undefined)
})

test('only extracts controlled preference phrases and honors a memory opt-out', () => {
  const text = '张三的私人事情我还记得。以后我难受时，我希望你先听我说完。'
  const result = extractPreferences(text)
  assert.equal(result.items.length, 1)
  assert.doesNotMatch(result.items[0].content, /张三|私人事情/)
  assert.deepEqual(extractPreferences(text + '这段别记。'), { blocked: true, items: [] })
  assert.deepEqual(extractPreferences('她说她希望我让她说完。'), { blocked: false, items: [] })
})

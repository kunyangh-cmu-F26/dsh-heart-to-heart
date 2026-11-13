import { FINISH_TEXT } from './wire.js'

export const PAUSES = { asked: 4_000, ending: 16_000, middle: 12_000, continuing: 27_000 }
export const MAX_BATCH = 24_000
const BRIEF_COOLDOWN = 35_000

const clearlyFinished = /(?:我说完了|就这些(?:了)?|大概就是这样|事情就是这样|我想说的就这些|这就是(?:整件事|事情的经过)|that's (?:all|it)|that's what happened|i'm done)[。！？.!?…\s]*$/iu
const asksForView = /(?:你怎么看|你怎么想|你觉得呢|你有什么想法|你觉得我该怎么办|你说我该怎么办|what do you think|any thoughts|what should i do)[。！？.!?…\s]*$/iu
const asksForCheckIn = /(?:你懂我意思吗|你能理解吗|你明白吗|你有在听吗|你还在听吗|do you (?:get what i mean|see what i mean|understand)|are you (?:still )?listening)[。！？.!?…\s]*$/iu
const unfinished = /(?:还有(?:一件事|一点|个事|呢)?|让我想想(?:怎么说)?|我想想(?:怎么说)?|我还没说完|听我说完|先别(?:回|回复|说话)|等我说完|等我一下|我继续说|后面还有|话还没说完|然后|但是|不过|而且|因为|其实|接下来|let me think|there's more|i'm not done|let me finish|don't (?:reply|respond) yet|but|and then)[，、。,.…\s]*$/iu
const naturalEnding = /(?:后来.{0,24}(?:没再联系|没再说话|各走各的|就结束了)|最后.{0,22}(?:结束了|过去了|分开了|我就走了|没再提过)|反正.{0,18}(?:就是这样|已经过去了)|这件事.{0,16}(?:到此为止|就结束了)|后来我们就.{0,14}了|we never (?:spoke|talked) again|that was the end of it)[。！？.!?…\s]*$/iu
const hold = /(?:先别(?:回|回复|说话)|等我说完|听我说完|我还没说完|let me finish|don't (?:reply|respond) yet|i'm not done)[。！？.!?…\s]*$/iu

export function pauseDecision(last, count) {
  if (hold.test(last)) return undefined
  if (clearlyFinished.test(last) || asksForView.test(last)) return { kind: 'final', delay: PAUSES.asked }
  if (asksForCheckIn.test(last)) return { kind: 'brief', delay: PAUSES.asked }
  if (naturalEnding.test(last)) return { kind: 'final', delay: PAUSES.ending }
  if (count < 2) return undefined
  return { kind: 'brief', delay: unfinished.test(last) ? PAUSES.continuing : PAUSES.middle }
}

export function automaticReply(state, now) {
  if (!state.enabled || state.pending || state.failed || state.parts.length === 0) return undefined
  const decision = pauseDecision(state.parts.at(-1), state.partCount)
  if (!decision) return undefined
  if (decision.kind !== 'brief' || now - state.lastBrief >= BRIEF_COOLDOWN) return decision
  const nextBriefAt = state.lastBrief + BRIEF_COOLDOWN
  return { ...decision, delay: Math.max(decision.delay, nextBriefAt - state.lastPart) }
}

export function batchFor(state, kind) {
  const text = state.parts.join('\n\n')
  if (kind === 'brief') return { text, mode: state.remember ? 'briefWithMemory' : 'brief' }
  return text
    ? { text, mode: state.remember ? 'finalWithMemory' : 'final' }
    : { text: FINISH_TEXT, mode: state.remember ? 'finishWithMemory' : 'finish' }
}

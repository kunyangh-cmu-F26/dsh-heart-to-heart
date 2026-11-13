import { randomUUID } from 'node:crypto'
import { extractPreferences } from './preferences.js'
import { FINISH_TEXT, listenMode } from './wire.js'

export const name = 'heart-to-heart'
export const inject = ['agents', 'loader', 'systemPrompt', 'tools']

const ENGRAM_PACKAGE = '@kenz1117/dsh-engram'
const SAVE = 'engram_save'
const ACTIVE_FIBER = 2

const guidance = {
  brief: 'The user is still telling their story. Give at most one short, natural spoken line, such as a specific acknowledgment OR one relevant, gentle question. Then yield the floor. No recap, diagnosis, advice, tools, or memory writes.',
  final: 'The user has handed you the floor. Respond in the established persona and in the user’s language. First acknowledge the feeling using a concrete detail they shared, then offer your perspective gently if it fits. Ask whether they want advice before giving it, unless they have just explicitly asked for advice. Do not call tools or mention the mode. If the latest user message is only the “我说完了” marker, respond to what they shared before it.',
}

function engramAvailable(ctx, agent) {
  return [...ctx.loader.entries()].some(entry =>
    entry.options.name === ENGRAM_PACKAGE && !entry.disabled && entry.fiber?.state === ACTIVE_FIBER)
    && typeof ctx.tools.executable(SAVE, agent)?.execute === 'function'
}

function rememberBatch(ctx, agent, items, signal) {
  return ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    agent, signal,
    calls: [{
      type: 'tool-call', id: randomUUID(), name: SAVE,
      arguments: JSON.stringify({ scope: 'user', items }),
    }],
  }))
}

export function apply(ctx) {
  const rounds = new WeakMap()
  const pendingPreferences = new WeakMap()
  const pluginLifetime = new AbortController()
  ctx.effect(() => () => pluginLifetime.abort())

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (message.source.kind !== 'user' || message.source.principal !== undefined
        || message.content.length !== 1 || message.content[0]?.type !== 'text') return
    const mode = listenMode(message.source.rpcId)
    if (!mode) {
      pendingPreferences.delete(agent.session)
      return
    }
    const { text } = message.content[0]
    const isFinishMarker = mode === 'finish' || mode === 'finishWithMemory'
    if (isFinishMarker && text !== FINISH_TEXT) return
    const state = pendingPreferences.get(agent.session) ?? { blocked: false, items: new Map() }
    const isBrief = mode === 'brief' || mode === 'briefWithMemory'
    const wantsMemory = mode.endsWith('WithMemory')
    if (!isFinishMarker && wantsMemory) {
      const detected = extractPreferences(text)
      state.blocked ||= detected.blocked
      for (const item of detected.items) state.items.set(item.content, item)
    }
    if (mode === 'briefWithMemory') {
      pendingPreferences.set(agent.session, state)
    } else {
      pendingPreferences.delete(agent.session)
    }
    rounds.set(agent.session, {
      turn, agent, kind: isBrief ? 'brief' : 'final',
      items: wantsMemory && !isBrief && !state.blocked ? [...state.items.values()] : [],
    })
  })

  ctx.systemPrompt.context({
    name: 'heart-to-heart', order: 900, required: true, interpolate: false,
    text: ({ agent }) => {
      const round = agent && rounds.get(agent.session)
      return round ? 'Listening mode. ' + guidance[round.kind] : ''
    },
  })

  // A listening reply has no tool side effects. The optional preference write
  // is a separate, scoped invocation using DSH's normal tool policy pipeline.
  ctx.tools.guard(({ agent }) => agent && rounds.has(agent.session)
    ? 'Listening mode is a conversation-only turn.' : undefined)

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const round = rounds.get(session)
    if (!round || round.turn !== event.data.turn) return
    rounds.delete(session)
    if (event.data.reason.kind !== 'completed' || round.items.length === 0 || !engramAvailable(ctx, round.agent)) return

    const save = async () => {
      const { agent, items } = round
      await agent.whenIdle()
      if (pluginLifetime.signal.aborted || ctx.agents.get(agent.id) !== agent || !engramAvailable(ctx, agent)) return
      await agent.runMaintenance(async maintenance => {
        const signal = AbortSignal.any([maintenance, pluginLifetime.signal])
        const batch = await rememberBatch(ctx, agent, items, signal)
        if (batch.results[0]?.result.isError !== false && !signal.aborted) {
          ctx.logger.warn('[heart-to-heart] Engram did not accept a preference write')
        }
      })
    }
    void save().catch(() => {
      if (!pluginLifetime.signal.aborted) ctx.logger.warn('[heart-to-heart] Could not save preferences through Engram')
    })
  })
}

import { browserUuid, requestId } from './wire.js'
import { automaticReply, batchFor, MAX_BATCH } from './listening.js'

const PACKAGE = 'dsh-heart-to-heart'
const ENGRAM = '@kenz1117/dsh-engram'
const CARD = '[data-composer-card]'
const EDITOR = '[data-composer-input]'
const INPUT_LEFT = 'conversation.input.left'
const INPUT_DOCK = 'conversation.input.dock'
const SEND_LABELS = ['input.send', 'input.send.queue', 'input.send.steer']
const IDLE = 0

const zh = {
  listen: '倾听', listenHint: '开启倾听后，可以分段发消息', closeHint: '关闭倾听，有未说完的内容时先请 DSH 接话',
  finish: '我说完了', remember: '记住长期偏好',
  rememberHint: '允许把你明确说过的长期聊天偏好自动写入记忆宫殿',
  waiting: '在听，你可以继续讲', pending: '正在发送…', retry: '重试发送',
  failed: '发送失败，刚才的内容还在这里。', buffered: '待发送的倾诉片段',
  limit: '这段已经比较长了。先点「我说完了」发送已收下的片段，当前输入会保留。',
}
const en = {
  listen: 'Listen', listenHint: 'Turn on listening to send your thought in parts',
  closeHint: 'Turn off listening and send any remaining parts for a reply',
  finish: 'I’m done', remember: 'Remember preferences',
  rememberHint: 'Allow explicitly stated, lasting conversation preferences to be saved to Engram',
  waiting: 'Listening. Take your time.', pending: 'Sending…', retry: 'Retry send',
  failed: 'Could not send. Your messages are still here.', buffered: 'Unsent listening messages',
  limit: 'This batch is long. Choose “I’m done” to send the buffered parts and keep your current draft.',
}

function newState(sessionId) {
  const key = PACKAGE + ':' + sessionId
  let settings
  try {
    settings = JSON.parse(localStorage.getItem(key) ?? '{}')
  } catch {
    settings = {}
  }
  const initial = {
    enabled: settings?.enabled === true, remember: settings?.remember === true, parts: [],
    partCount: 0, heardBrief: false, lastBrief: -Infinity, lastPart: IDLE,
    pending: false, failed: null,
  }
  let current = initial
  const listeners = new Set()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(patch) {
      const old = current
      current = { ...old, ...patch }
      if (current.enabled !== old.enabled || current.remember !== old.remember) {
        try {
          localStorage.setItem(key, JSON.stringify({ enabled: current.enabled, remember: current.remember }))
        } catch {
          // Storage may be disabled. The settings still apply until this page closes.
        }
      }
      for (const listener of listeners) listener()
    },
  }
}

function addPart(state, shell, text, t) {
  const previous = state.getSnapshot()
  const size = previous.parts.reduce((sum, part) => sum + part.length + 2, 0)
  if (size + text.length > MAX_BATCH && previous.parts.length > 0) {
    shell.notify('error', t('limit'))
    return false
  }
  state.set({ parts: [...previous.parts, text], partCount: previous.partCount + 1, lastPart: Date.now() })
  shell.actions.setDraft('')
  shell.actions.persistDraft()
  return true
}

async function sendBatch(state, session, kind, close, retry, hasEngram) {
  const previous = state.getSnapshot()
  if (previous.pending) return
  if (!retry && previous.failed) return
  const batch = retry ? { ...previous.failed, close: previous.failed.close || close } : {
    ...batchFor({ ...previous, remember: previous.remember && hasEngram }, kind),
    kind, close, size: previous.parts.length,
  }
  if (!batch.text) return
  // Reuse the receipt if the server accepted a prompt but its response was lost.
  const id = batch.id ?? requestId(batch.mode, browserUuid())
  state.set({ pending: true, failed: null })
  try {
    const result = await session.prompt([{ type: 'text', text: batch.text }], 'queue', undefined, id)
    if (!result.ok) throw new Error('DSH did not accept the listening batch')
    const current = state.getSnapshot()
    const remaining = current.parts.slice(batch.size)
    const isFinal = batch.kind === 'final'
    state.set({
      parts: remaining, pending: false, failed: null,
      enabled: batch.close && remaining.length === 0 ? false : current.enabled,
      heardBrief: !isFinal, lastBrief: isFinal ? -Infinity : Date.now(),
      partCount: isFinal ? remaining.length : current.partCount,
      lastPart: remaining.length === 0 ? IDLE : current.lastPart,
    })
  } catch {
    state.set({ pending: false, failed: { ...batch, id } })
  }
}

function plainDraft(shell, card) {
  const input = shell.state.getSnapshot()
  const editor = card.querySelector(EDITOR)
  if (!editor?.isContentEditable || input.phase !== 'plain' || input.attachmentIds.length
      || input.occurrences.length || editor.querySelector('[data-composer-quote]')) return ''
  const draft = input.draft.trim()
  return draft.startsWith('/') ? '' : draft
}

function attachComposer(card, shell, state, t, conversationT) {
  const editor = card.querySelector(EDITOR)
  if (!editor) return undefined
  let compositionEnd = -Infinity
  const onCompositionEnd = () => { compositionEnd = performance.now() }
  const acceptPart = event => {
    const text = plainDraft(shell, card)
    if (!text || !state.getSnapshot().enabled) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (state.getSnapshot().failed) {
      shell.notify('error', t('failed'))
      return
    }
    // Let the native key/input dispatch finish before committing a Lexical edit.
    const revision = shell.state.getSnapshot().draftRev
    queueMicrotask(() => {
      if (!card.isConnected || !state.getSnapshot().enabled
          || shell.state.getSnapshot().draftRev !== revision) return
      addPart(state, shell, text, t)
    })
  }
  const onKeyDown = event => {
    if (event.target.closest?.(EDITOR) !== editor || event.key !== 'Enter' || event.repeat
        || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented
        || event.isComposing || event.keyCode === 229 || editor.hasAttribute('data-composer-composing')
        || performance.now() - compositionEnd < 25
        || card.querySelector('[aria-expanded="true"][aria-haspopup="listbox"], [role="listbox"]')) return
    acceptPart(event)
  }
  const onClick = event => {
    const button = event.target.closest?.('button')
    if (!button || button.disabled || !SEND_LABELS.some(label => conversationT(label) === button.getAttribute('aria-label'))) return
    acceptPart(event)
  }
  card.addEventListener('keydown', onKeyDown, true)
  card.addEventListener('click', onClick, true)
  editor.addEventListener('compositionend', onCompositionEnd)
  return () => {
    card.removeEventListener('keydown', onKeyDown, true)
    card.removeEventListener('click', onClick, true)
    editor.removeEventListener('compositionend', onCompositionEnd)
  }
}

const control = {
  background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, #8886)',
  borderRadius: 8, padding: '3px 7px', font: 'inherit', fontSize: 12,
  lineHeight: '18px', whiteSpace: 'nowrap',
}
const activeControl = {
  ...control, borderColor: 'var(--dsw-alias-state-business-primary, #5879eb)',
  color: 'var(--dsw-alias-state-business-primary, #5879eb)',
}
const bufferStyle = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, padding: '5px 8px',
  maxHeight: 164, overflowY: 'auto', fontSize: 13,
}
const bubbleStyle = {
  maxWidth: '90%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  background: 'var(--dsw-alias-bg-layer-2, #8881)', borderRadius: 12, padding: '5px 10px',
}

function apply(ctx) {
  const { slots, sessions, conversation, locale, modules } = ctx
  const { createElement: h, useEffect, useRef, useSyncExternalStore } = React
  const states = new Map()
  const stateFor = id => {
    if (!states.has(id)) states.set(id, newState(id))
    return states.get(id)
  }
  const conversationT = locale.bind('conversation')
  ctx.effect(() => locale.register(PACKAGE, { zh, en }))

  function Toolbar({ sessionId, useInput, useSession, useAccess, t }) {
    const anchor = useRef(null)
    const state = stateFor(sessionId)
    const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot)
    const input = useInput(value => value)
    const session = useSession(value => value)
    const allowed = useAccess('session/prompt') !== false && session?.subagent === null && !session.removed
    const hasEngram = useSyncExternalStore(
      listener => modules.entries.state.subscribe(listener),
      () => modules.manifest.modules.some(row => row.id === ENGRAM),
    )

    useEffect(() => {
      const card = anchor.current?.closest(CARD)
      const binding = sessions.binding(sessionId)
      if (!allowed || !card || !binding || !snapshot.enabled) return
      return attachComposer(card, conversation.input.for(binding.ctx), state, t, conversationT)
    }, [sessionId, allowed, snapshot.enabled, state, t])

    useEffect(() => {
      const decision = automaticReply(snapshot, Date.now())
      const card = anchor.current?.closest(CARD)
      const binding = sessions.binding(sessionId)
      if (!allowed || !card || !binding || !decision || session.running || session.openState !== 'open'
          || input.draft.trim() || input.attachmentIds.length || input.phase !== 'plain') return
      let timer
      const attempt = () => {
        const editor = card.querySelector(EDITOR)
        const live = binding.session.getSnapshot()
        const latest = conversation.input.for(binding.ctx).state.getSnapshot()
        if (!card.isConnected || !editor?.isContentEditable || editor.hasAttribute('data-composer-composing')
            || document.visibilityState === 'hidden' || live.running || live.removed || live.openState !== 'open'
            || latest.draft.trim() || latest.attachmentIds.length || latest.phase !== 'plain'
            || state.getSnapshot() !== snapshot) return
        void sendBatch(state, binding.session, decision.kind, false, false, hasEngram)
      }
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(attempt, Math.max(30, decision.delay - (Date.now() - snapshot.lastPart)))
      }
      arm()
      document.addEventListener('visibilitychange', arm)
      card.addEventListener('compositionend', arm)
      return () => {
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', arm)
        card.removeEventListener('compositionend', arm)
      }
    }, [sessionId, allowed, session?.running, session?.openState, input.draft, input.draftRev,
      input.attachmentIds.length, input.phase, state, snapshot, hasEngram])

    if (!allowed) return null
    const button = (label, onClick, options = {}) => h('button', {
      type: 'button', style: options.pressed ? activeControl : control,
      title: options.title, 'aria-pressed': options.pressed, disabled: options.disabled,
      onMouseDown: event => event.preventDefault(), onClick,
    }, label)
    const canFinish = snapshot.parts.length > 0 || snapshot.heardBrief
    const finish = close => {
      const card = anchor.current?.closest(CARD)
      const binding = sessions.binding(sessionId)
      if (!card || !binding || state.getSnapshot().pending) return
      if (state.getSnapshot().failed) {
        void sendBatch(state, binding.session, 'final', close, true, hasEngram)
        return
      }
      const shell = conversation.input.for(binding.ctx)
      const draft = plainDraft(shell, card)
      if (draft) addPart(state, shell, draft, t)
      if (state.getSnapshot().parts.length || state.getSnapshot().heardBrief) {
        void sendBatch(state, binding.session, 'final', close, false, hasEngram)
      } else if (close) {
        state.set({ enabled: false })
      }
    }
    const toggle = () => {
      const current = state.getSnapshot()
      if (!current.enabled) {
        state.set({ enabled: true })
      } else if (current.parts.length || current.heardBrief) {
        finish(true)
      } else {
        state.set({ enabled: false })
      }
    }
    return h('span', {
      ref: anchor, style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
    },
    button(t('listen'), toggle, {
      pressed: snapshot.enabled, title: t(snapshot.enabled ? 'closeHint' : 'listenHint'), disabled: snapshot.pending,
    }),
    snapshot.enabled && button(t(snapshot.failed ? 'retry' : 'finish'), () => finish(false), {
      disabled: snapshot.pending || (!canFinish && !input.draft.trim()),
    }),
    snapshot.enabled && hasEngram && button(t('remember'), () => state.set({ remember: !state.getSnapshot().remember }), {
      pressed: snapshot.remember, title: t('rememberHint'), disabled: snapshot.pending || Boolean(snapshot.failed),
    }))
  }

  function BufferedParts({ sessionId, t }) {
    const state = stateFor(sessionId)
    const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot)
    if (!snapshot.enabled || (!snapshot.parts.length && !snapshot.heardBrief && !snapshot.failed)) return null
    const message = snapshot.failed ? 'failed' : snapshot.pending ? 'pending' : 'waiting'
    return h('div', { style: bufferStyle, 'aria-label': t('buffered') },
      ...snapshot.parts.map((part, index) => h('div', { key: index, style: bubbleStyle }, part)),
      h('span', { role: 'status', style: { opacity: 0.72, fontSize: 12 } }, t(message)))
  }

  slots.inject(INPUT_LEFT, () => slots.register({ name: INPUT_LEFT, id: PACKAGE, order: 60, locale: PACKAGE }, Toolbar))
  slots.inject(INPUT_DOCK, () => slots.register({ name: INPUT_DOCK, id: PACKAGE, order: 35, locale: PACKAGE }, BufferedParts))
}

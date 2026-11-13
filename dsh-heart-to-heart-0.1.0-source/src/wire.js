// SessionFace uses an opaque request UUID for correlation and retry deduplication.
// Keep a v4 UUID shape and encode only this plugin's per-submission intent.
const marks = {
  brief: 'f2c4e780',
  final: 'f2c4e781',
  finalWithMemory: 'f2c4e782',
  finish: 'f2c4e783',
  finishWithMemory: 'f2c4e784',
  briefWithMemory: 'f2c4e785',
}
export const FINISH_TEXT = '（倾听模式：我说完了）'

export function browserUuid() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function requestId(mode, uuid) {
  return marks[mode] + uuid.slice(8)
}

export function listenMode(id) {
  if (typeof id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) return undefined
  const mark = id.slice(0, 8)
  return Object.keys(marks).find(mode => marks[mode] === mark)
}

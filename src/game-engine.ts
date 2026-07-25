import type { Message } from './types'

let messageSequence = 0

const id = () => globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${++messageSequence}`
const time = () => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date())

/** Presentation-only helper. Mechanical interpretation and random outcomes are
 * intentionally absent from the browser after the enforce-only cutover. */
export function playerMessage(author: string, text: string): Message {
  return { id: id(), speaker: 'player', author, text, timestamp: time() }
}

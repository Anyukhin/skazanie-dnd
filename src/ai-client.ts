import type { AiHealth, AiTurnResult, DiceRollEvent, GameState, PendingCheck, RollResult } from './types'

type SharedDiceRollResponse = {
  roll: DiceRollEvent
  version: number
  state: GameState
}

export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

export class ApiRequestError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

export function isStateVersionConflictError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.code === 'STATE_VERSION_CONFLICT'
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
  timeoutMessage = 'Сервер слишком долго не отвечает.',
): Promise<Response> {
  const controller = new AbortController()
  const externalSignal = init.signal
  let timedOut = false
  const relayAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) relayAbort()
  else externalSignal?.addEventListener('abort', relayAbort, { once: true })
  const timeout = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, timeoutMs))
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(timeoutMessage)
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', relayAbort)
  }
}

export async function getAiHealth(): Promise<AiHealth> {
  const response = await fetchWithTimeout('/api/health', {}, 10_000, 'Сервер рассказчика не ответил вовремя')
  if (!response.ok) throw new Error('Сервер рассказчика недоступен')
  return response.json() as Promise<AiHealth>
}

function newIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error('Браузер не поддерживает безопасные ключи запросов')
  return globalThis.crypto.randomUUID()
}

export interface NarrateOptions {
  confirmedProposalId?: string
  npcId?: string
  onNarrationPreview?: (preview: NarrationPreview) => void
}

export type NarrationPreviewPhase = 'start' | 'streaming' | 'complete' | 'replaced' | 'aborted'

export interface NarrationPreview {
  messageId: string
  text: string
  phase: NarrationPreviewPhase
  replayed?: boolean
}

type NarrationPreviewListener = (preview: NarrationPreview) => void
const narrationPreviewListeners = new Map<string, Set<NarrationPreviewListener>>()

function narrationPreviewCampaignId(value: string) {
  return String(value || '').toUpperCase()
}

function subscribeNarrationPreview(campaignId: string, listener: NarrationPreviewListener) {
  const key = narrationPreviewCampaignId(campaignId)
  const listeners = narrationPreviewListeners.get(key) ?? new Set()
  listeners.add(listener)
  narrationPreviewListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) narrationPreviewListeners.delete(key)
  }
}

export function publishNarrationPreview(campaignId: string, preview: NarrationPreview) {
  for (const listener of narrationPreviewListeners.get(narrationPreviewCampaignId(campaignId)) ?? []) {
    listener(preview)
  }
}

/**
 * Единый ключ настройки автоброска. Значение читается в момент запроса:
 * сервер по нему решает, бросать d20 самому или предложить бросок игроку.
 */
export const AUTO_ROLL_STORAGE_KEY = 'skazanie-auto-attack-roll'
export function autoRollEnabled() {
  try { return window.localStorage.getItem(AUTO_ROLL_STORAGE_KEY) === 'true' } catch { return false }
}

async function expectedNarrationMessageId(idempotencyKey: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(idempotencyKey),
  )
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return `narration-${hex.slice(0, 20)}`
}

export async function narrateWithAgent(
  state: GameState,
  action: string,
  _player: string,
  roll?: RollResult,
  idempotencyKey: string = newIdempotencyKey(),
  actorId?: string,
  options: NarrateOptions = {},
): Promise<AiTurnResult> {
  const previewState: { current: NarrationPreview | null } = { current: null }
  const expectedMessageId = options.onNarrationPreview
    ? await expectedNarrationMessageId(idempotencyKey)
    : null
  const unsubscribe = options.onNarrationPreview && expectedMessageId
    ? subscribeNarrationPreview(state.sessionCode, (preview) => {
        if (preview.messageId !== expectedMessageId) return
        previewState.current = preview
        options.onNarrationPreview?.(preview)
      })
    : () => {}
  try {
    const response = await fetchWithTimeout('/api/narrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        campaign_id: state.sessionCode,
        idempotency_key: idempotencyKey,
        ...(actorId ? { actor_id: actorId } : {}),
        ...(options.npcId ? { npc_id: options.npcId } : {}),
        ...(options.confirmedProposalId ? { confirmed_proposal_id: options.confirmedProposalId } : {}),
        ...(roll?.roll_id ? { roll: { roll_id: roll.roll_id } } : {}),
        // Ручной режим: сервер не бросает d20 за игрока, а возвращает карточку
        // проверки; ход завершится повторным запросом с roll_id.
        ...(autoRollEnabled() ? {} : { manual_roll: true }),
      }),
    }, 48_000, 'Рассказчик не ответил вовремя. Попробуйте обновить состояние кампании.')
    if (!response.ok) {
      const details = await response.json().catch(() => ({})) as { error?: string; code?: string }
      throw new ApiRequestError(details.error || `Ошибка рассказчика: ${response.status}`, response.status, details.code)
    }
    const result = await response.json() as AiTurnResult
    if (options.onNarrationPreview && expectedMessageId
      && result.narration_message_id === expectedMessageId) {
      const finalText = String(result.narration ?? '')
      const phase: NarrationPreviewPhase = previewState.current?.text
        && !finalText.startsWith(previewState.current.text)
        ? 'replaced'
        : 'complete'
      const finalPreview: NarrationPreview = {
        messageId: expectedMessageId,
        text: finalText,
        phase,
        replayed: Boolean(result.idempotent_replay),
      }
      if (previewState.current?.phase !== phase || previewState.current?.text !== finalText
        || Boolean(previewState.current?.replayed) !== Boolean(finalPreview.replayed)) {
        options.onNarrationPreview(finalPreview)
      }
    }
    return result
  } finally {
    unsubscribe()
  }
}

export async function rollDice(check: Pick<PendingCheck, 'check_id' | 'label' | 'modifier' | 'difficulty' | 'playerId'>, campaignId: string): Promise<RollResult> {
  const response = await fetch('/api/roll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...check, checkId: check.check_id, campaignId }),
  })
  if (!response.ok) throw new Error('Кость укатилась со стола')
  return response.json() as Promise<RollResult>
}

export async function rollSharedDie(sessionCode: string, playerId: string, sides = 20): Promise<SharedDiceRollResponse> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(sessionCode)}/dice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, sides }),
  })
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { error?: string; code?: string }
    throw new ApiRequestError(details.error || 'Кость укатилась со стола', response.status, details.code)
  }
  return response.json() as Promise<SharedDiceRollResponse>
}

export async function generateItemImage(prompt: string, landscape = false): Promise<{ url: string; model: string; cost?: number }> {
  const response = await fetch('/api/items/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, aspectRatio: landscape ? '16:9' : '1:1' }),
  })
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(details.error || 'Не удалось создать изображение предмета')
  }
  return response.json() as Promise<{ url: string; model: string; cost?: number }>
}

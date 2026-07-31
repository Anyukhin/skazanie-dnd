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

export async function narrateWithAgent(state: GameState, action: string, _player: string, roll?: RollResult, idempotencyKey = newIdempotencyKey(), actorId?: string): Promise<AiTurnResult> {
  const response = await fetchWithTimeout('/api/narrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      campaign_id: state.sessionCode,
      idempotency_key: idempotencyKey,
      ...(actorId ? { actor_id: actorId } : {}),
      ...(roll?.roll_id ? { roll: { roll_id: roll.roll_id } } : {}),
    }),
  }, 48_000, 'Рассказчик не ответил вовремя. Попробуйте обновить состояние кампании.')
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { error?: string; code?: string }
    throw new ApiRequestError(details.error || `Ошибка рассказчика: ${response.status}`, response.status, details.code)
  }
  return response.json() as Promise<AiTurnResult>
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

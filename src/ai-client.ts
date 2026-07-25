import type { AiHealth, AiTurnResult, DiceRollEvent, GameState, PendingCheck, RollResult } from './types'

type SharedDiceRollResponse = {
  roll: DiceRollEvent
  version: number
  state: GameState
}

export async function getAiHealth(): Promise<AiHealth> {
  const response = await fetch('/api/health')
  if (!response.ok) throw new Error('Сервер рассказчика недоступен')
  return response.json() as Promise<AiHealth>
}

function newIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error('Браузер не поддерживает безопасные ключи запросов')
  return globalThis.crypto.randomUUID()
}

export async function narrateWithAgent(state: GameState, action: string, _player: string, roll?: RollResult, idempotencyKey = newIdempotencyKey()): Promise<AiTurnResult> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 48_000)
  try {
    const response = await fetch('/api/narrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        campaign_id: state.sessionCode,
        idempotency_key: idempotencyKey,
        ...(roll?.roll_id ? { roll: { roll_id: roll.roll_id } } : {}),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const details = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(details.error || `Ошибка рассказчика: ${response.status}`)
    }
    return response.json() as Promise<AiTurnResult>
  } finally {
    window.clearTimeout(timeout)
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

export async function rollSharedDie(sessionCode: string, playerId: string): Promise<SharedDiceRollResponse> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(sessionCode)}/dice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, sides: 20 }),
  })
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(details.error || 'Кость укатилась со стола')
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

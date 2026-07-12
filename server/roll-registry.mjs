export class RollRegistryError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RollRegistryError'
    this.code = code
  }
}

export class RollRegistry {
  constructor({ diceService, ttlMs = 10 * 60 * 1000, now = () => Date.now(), checkIdFactory = randomUUID } = {}) {
    if (!diceService) throw new TypeError('RollRegistry требует DiceService')
    this.diceService = diceService
    this.ttlMs = ttlMs
    this.now = now
    this.checkIdFactory = checkIdFactory
    this.rolls = new Map()
    this.checks = new Map()
  }

  cleanup() {
    const now = this.now()
    for (const [id, entry] of this.rolls) if (entry.expires_at <= now) this.rolls.delete(id)
    for (const [id, entry] of this.checks) if (entry.expires_at <= now) this.checks.delete(id)
  }

  registerCheck({ campaignId, actorId, label = 'Проверка', modifier = 0, difficulty = 10, ability = null, advantage = false, disadvantage = false, visibility = 'public' }) {
    this.cleanup()
    const check_id = String(this.checkIdFactory())
    const check = {
      check_id,
      campaign_id: String(campaignId || ''),
      actor_id: String(actorId || ''),
      label: String(label).slice(0, 80),
      modifier: Number(modifier),
      difficulty: Number(difficulty),
      ability: ability == null ? null : String(ability),
      advantage: Boolean(advantage),
      disadvantage: Boolean(disadvantage),
      visibility,
      expires_at: this.now() + this.ttlMs,
    }
    this.checks.set(check_id, check)
    return structuredClone(check)
  }

  issue({ checkId, check_id, campaignId, actorId, label = 'Проверка', modifier = 0, difficulty = 10, ability = null, advantage = false, disadvantage = false, visibility = 'public' }) {
    this.cleanup()
    const registeredId = checkId ?? check_id
    if (registeredId) {
      const registered = this.checks.get(String(registeredId))
      if (!registered) throw new RollRegistryError('Проверка не найдена или истекла', 'CHECK_NOT_FOUND')
      if (registered.campaign_id !== String(campaignId || '') || registered.actor_id !== String(actorId || '')) {
        throw new RollRegistryError('Проверка принадлежит другому ходу или персонажу', 'CHECK_FORBIDDEN')
      }
      this.checks.delete(String(registeredId))
      ;({ label, modifier, difficulty, ability, advantage, disadvantage, visibility } = registered)
    }
    const result = this.diceService.rollCheck({
      modifier: Number(modifier), difficulty: Number(difficulty), purpose: String(label).slice(0, 80),
      actorId: String(actorId), advantage, disadvantage, visibility,
    })
    const entry = {
      result: { ...result, label: String(label).slice(0, 80), ability },
      campaign_id: String(campaignId || ''),
      actor_id: String(actorId || ''),
      expires_at: this.now() + this.ttlMs,
      consumed_by: null,
    }
    this.rolls.set(result.roll_id, entry)
    return structuredClone(entry.result)
  }

  consume(rollId, { campaignId, actorId, idempotencyKey }) {
    this.cleanup()
    const entry = this.rolls.get(String(rollId || ''))
    if (!entry) throw new RollRegistryError('Бросок не найден или истёк', 'ROLL_NOT_FOUND')
    if (entry.campaign_id !== String(campaignId || '') || entry.actor_id !== String(actorId || '')) {
      throw new RollRegistryError('Бросок принадлежит другому ходу или персонажу', 'ROLL_FORBIDDEN')
    }
    const key = String(idempotencyKey || '')
    if (entry.consumed_by && entry.consumed_by !== key) throw new RollRegistryError('Бросок уже использован', 'ROLL_ALREADY_USED')
    entry.consumed_by = key || `used:${this.now()}`
    return structuredClone(entry.result)
  }
}
import { randomUUID } from 'node:crypto'

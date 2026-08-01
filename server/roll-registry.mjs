import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export class RollRegistryError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RollRegistryError'
    this.code = code
  }
}

export class RollRegistry {
  constructor({
    diceService,
    ttlMs = 10 * 60 * 1000,
    now = () => Date.now(),
    checkIdFactory = randomUUID,
    storageFile = null,
  } = {}) {
    if (!diceService) throw new TypeError('RollRegistry требует DiceService')
    this.diceService = diceService
    this.ttlMs = ttlMs
    this.now = now
    this.checkIdFactory = checkIdFactory
    this.storageFile = storageFile ? resolve(storageFile) : null
    this.rolls = new Map()
    this.checks = new Map()
    this._load()
    this.cleanup()
  }

  _load() {
    if (!this.storageFile || !existsSync(this.storageFile)) return
    let payload
    try {
      payload = JSON.parse(readFileSync(this.storageFile, 'utf8'))
    } catch (error) {
      throw new RollRegistryError(`Повреждено durable-хранилище бросков: ${error instanceof Error ? error.message : error}`, 'ROLL_REGISTRY_CORRUPT')
    }
    if (payload?.schema_version !== 1 || !Array.isArray(payload.rolls) || !Array.isArray(payload.checks)) {
      throw new RollRegistryError('Некорректная схема durable-хранилища бросков', 'ROLL_REGISTRY_CORRUPT')
    }
    this.rolls = new Map(payload.rolls.map(([id, entry]) => [String(id), entry]))
    this.checks = new Map(payload.checks.map(([id, entry]) => [String(id), entry]))
  }

  _persist() {
    if (!this.storageFile) return
    mkdirSync(dirname(this.storageFile), { recursive: true })
    const temporary = `${this.storageFile}.${process.pid}.${randomUUID()}.tmp`
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(descriptor, JSON.stringify({
        schema_version: 1,
        rolls: [...this.rolls.entries()],
        checks: [...this.checks.entries()],
      }), 'utf8')
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, this.storageFile)
  }

  cleanup() {
    const now = this.now()
    let changed = false
    for (const [id, entry] of this.rolls) if (entry.expires_at <= now) {
      this.rolls.delete(id)
      changed = true
    }
    for (const [id, entry] of this.checks) if (entry.expires_at <= now) {
      this.checks.delete(id)
      changed = true
    }
    if (changed) this._persist()
  }

  registerCheck({ campaignId, actorId, label = 'Проверка', modifier = 0, difficulty = 10, ability = null, advantage = false, disadvantage = false, visibility = 'public', context = null }) {
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
      // Служебный контекст хода (например, судейское прочтение свободного
      // действия): не показывается игроку, а возвращается серверу при consume,
      // чтобы вторая фаза хода не выводила решение заново.
      ...(context ? { context: structuredClone(context) } : {}),
      expires_at: this.now() + this.ttlMs,
    }
    this.checks.set(check_id, check)
    this._persist()
    const { context: _hidden, ...visible } = check
    return structuredClone(visible)
  }

  issue({ checkId, check_id, campaignId, actorId, label = 'Проверка', modifier = 0, difficulty = 10, ability = null, advantage = false, disadvantage = false, visibility = 'public' }) {
    this.cleanup()
    const registeredId = checkId ?? check_id
    let context = null
    if (registeredId) {
      const registered = this.checks.get(String(registeredId))
      if (!registered) throw new RollRegistryError('Проверка не найдена или истекла', 'CHECK_NOT_FOUND')
      if (registered.campaign_id !== String(campaignId || '') || registered.actor_id !== String(actorId || '')) {
        throw new RollRegistryError('Проверка принадлежит другому ходу или персонажу', 'CHECK_FORBIDDEN')
      }
      this.checks.delete(String(registeredId))
      context = registered.context ?? null
      ;({ label, modifier, difficulty, ability, advantage, disadvantage, visibility } = registered)
    }
    const result = this.diceService.rollCheck({
      modifier: Number(modifier), difficulty: Number(difficulty), purpose: String(label).slice(0, 80),
      actorId: String(actorId), advantage, disadvantage, visibility,
    })
    const entry = {
      result: { ...result, label: String(label).slice(0, 80), ability },
      ...(context ? { context } : {}),
      campaign_id: String(campaignId || ''),
      actor_id: String(actorId || ''),
      expires_at: this.now() + this.ttlMs,
      consumed_by: null,
    }
    this.rolls.set(result.roll_id, entry)
    this._persist()
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
    this._persist()
    return structuredClone({ ...entry.result, ...(entry.context ? { context: entry.context } : {}) })
  }
}

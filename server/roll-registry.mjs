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

  getCheck(checkId, { campaignId, actorId, includeContext = false } = {}) {
    this.cleanup()
    const check = this.checks.get(String(checkId ?? ''))
    if (!check) throw new RollRegistryError('Проверка не найдена или истекла', 'CHECK_NOT_FOUND')
    if (check.campaign_id !== String(campaignId || '') || check.actor_id !== String(actorId || '')) {
      throw new RollRegistryError('Проверка принадлежит другому ходу или персонажу', 'CHECK_FORBIDDEN')
    }
    if (check.invalidated_at != null) throw new RollRegistryError('Эта проверка отменена: заявка была изменена', 'CHECK_INVALIDATED')
    const { context, ...visible } = check
    if (includeContext && context) visible.context = structuredClone(context)
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
      if (registered.invalidated_at != null) throw new RollRegistryError('Эта проверка отменена: заявка была изменена', 'CHECK_INVALIDATED')
      // Повтор HTTP-запроса после потери ответа возвращает ту же кость.
      // Связь хранится вместе с реестром и переживает перезапуск.
      if (registered.issued_roll_id) {
        const issued = this.rolls.get(registered.issued_roll_id)
        if (!issued) throw new RollRegistryError('Выданный бросок истёк', 'ROLL_NOT_FOUND')
        return structuredClone(issued.result)
      }
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
    if (registeredId) this.checks.get(String(registeredId)).issued_roll_id = result.roll_id
    this._persist()
    return structuredClone(entry.result)
  }

  consume(rollId, { campaignId, actorId, idempotencyKey, validateContext }) {
    this.cleanup()
    const entry = this.rolls.get(String(rollId || ''))
    if (!entry) throw new RollRegistryError('Бросок не найден или истёк', 'ROLL_NOT_FOUND')
    if (entry.campaign_id !== String(campaignId || '') || entry.actor_id !== String(actorId || '')) {
      throw new RollRegistryError('Бросок принадлежит другому ходу или персонажу', 'ROLL_FORBIDDEN')
    }
    if (entry.invalidated_at != null) throw new RollRegistryError('Этот бросок отменён: заявка была изменена', 'ROLL_INVALIDATED')
    const key = String(idempotencyKey || '')
    if (entry.consumed_by && entry.consumed_by !== key) throw new RollRegistryError('Бросок уже использован', 'ROLL_ALREADY_USED')
    if (validateContext) validateContext(structuredClone(entry.context ?? null))
    entry.consumed_by = key || `used:${this.now()}`
    this._persist()
    return structuredClone({ ...entry.result, ...(entry.context ? { context: entry.context } : {}) })
  }

  /**
   * Отменяет карточку до выдачи кости. После выдачи редактирование запрещено:
   * потерянный ответ возвращает прежнюю кость и не даёт бесплатного переброса.
   */
  invalidateCheck(checkId, { campaignId, actorId, reason = 'proposal-edited' } = {}) {
    this.cleanup()
    const id = String(checkId ?? '')
    const check = this.checks.get(id)
    if (!check) throw new RollRegistryError('Проверка не найдена или истекла', 'CHECK_NOT_FOUND')
    if (check.campaign_id !== String(campaignId || '') || check.actor_id !== String(actorId || '')) {
      throw new RollRegistryError('Проверка принадлежит другому ходу или персонажу', 'CHECK_FORBIDDEN')
    }
    if (check.invalidated_at != null) return false
    if (check.issued_roll_id) {
      throw new RollRegistryError('Кость уже брошена: изменить эту заявку нельзя. Повторите отправку прежнего результата.', 'CHECK_ALREADY_ROLLED')
    }
    check.invalidated_at = this.now()
    check.invalidated_reason = String(reason).slice(0, 80)
    this._persist()
    return true
  }

  /** Отменяет карточку по её публичному proposal_id или check_id. */
  invalidateProposal(proposalId, { campaignId, actorId, reason = 'proposal-edited' } = {}) {
    this.cleanup()
    const wanted = String(proposalId ?? '')
    const matches = [...this.checks.entries()]
      .filter(([id, check]) => (
        id === wanted || String(check.context?.proposal_id ?? '') === wanted
      ))
    if (!matches.length) throw new RollRegistryError('Предложение проверки не найдено или истекло', 'CHECK_NOT_FOUND')
    let changed = false
    for (const [id] of matches) {
      changed = this.invalidateCheck(id, { campaignId, actorId, reason }) || changed
    }
    return changed
  }
}

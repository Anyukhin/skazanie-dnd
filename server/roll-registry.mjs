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
    // Аудит PR #131, SEC-04: сколько запросов этого процесса держат резерв
    // броска (потребили его и ещё не узнали исход commit). Только в памяти:
    // после перезапуска держателей нет по определению.
    this.reservationHolders = new Map()
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

  /**
   * Есть ли у кампании открытая проверка на этой версии состояния: заявленная,
   * не отменённая и ещё не брошенная. Перестройка карты ждёт её завершения.
   */
  hasOpenCheck({ campaignId, stateVersion } = {}) {
    this.cleanup()
    return [...this.checks.values()].some((check) => check.campaign_id === String(campaignId)
      && check.invalidated_at == null
      && Number(check.context?.state_version) === Number(stateVersion)
      && (!check.issued_roll_id || !this.rolls.get(check.issued_roll_id)?.consumed_by))
  }

  pendingNarrationCheck({ campaignId, actorId, stateVersion } = {}) {
    this.cleanup()
    const entry = [...this.checks.values()].reverse().find(check => check.campaign_id === String(campaignId)
      && check.actor_id === String(actorId) && check.invalidated_at == null
      && ['free_action', 'ability_action'].includes(check.context?.kind) && check.context.action
      && Number(check.context.state_version) === Number(stateVersion)
      && (!check.issued_roll_id || !this.rolls.get(check.issued_roll_id)?.consumed_by))
    if (!entry) return null
    return { check_id: entry.check_id, label: entry.label, modifier: entry.modifier, difficulty: entry.difficulty,
      sides: 20, ability: entry.ability, skill: entry.context.reading?.skill ?? entry.context.skill,
      advantage: entry.advantage, disadvantage: entry.disadvantage,
      action: entry.context.action, proposal: structuredClone(entry.context.proposal),
    }
  }

  /**
   * Выдаёт кость для объявленной проверки. Аудит PR #131, SEC-01: прежде
   * `check_id` был необязательным, и реестр выдавал «ничейный» бросок с
   * параметрами клиента; обычная проверка принимала его `roll_id`, так что
   * игрок мог бросать серию и подставить лучший. Теперь кость рождается только
   * под зарегистрированную карточку, одна на карточку, и параметры берутся из
   * неё. Свободный кубик стола — отдельный путь `/api/rooms/:code/dice`, в
   * механику он не попадает.
   */
  issue({ checkId, check_id, campaignId, actorId }) {
    this.cleanup()
    const registeredId = checkId ?? check_id
    if (!registeredId) {
      throw new RollRegistryError('Механический бросок выдаётся только для объявленной проверки', 'CHECK_REQUIRED')
    }
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
    const { label, modifier, difficulty, ability, advantage, disadvantage, visibility } = registered
    const context = registered.context ?? null
    const result = this.diceService.rollCheck({
      modifier: Number(modifier), difficulty: Number(difficulty), purpose: String(label).slice(0, 80),
      actorId: String(actorId), advantage, disadvantage, visibility,
    })
    const entry = {
      result: { ...result, label: String(label).slice(0, 80), ability },
      ...(context ? { context } : {}),
      // Обратная связь «бросок → карточка»: по ней `consume` отличает
      // механический бросок от ничейного (аудит PR #131, SEC-01).
      check_id: String(registeredId),
      campaign_id: String(campaignId || ''),
      actor_id: String(actorId || ''),
      expires_at: this.now() + this.ttlMs,
      consumed_by: null,
    }
    this.rolls.set(result.roll_id, entry)
    registered.issued_roll_id = result.roll_id
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
    // Аудит PR #131, SEC-01: ничейный бросок механикой не потребляется. Такие
    // записи могли остаться в durable-файле от выдачи до исправления; у
    // привязанных записей того времени нет поля `check_id`, и связь ищется по
    // карточке. Повтор того же ключа по уже потреблённой записи не трогаем:
    // он лишь возвращает прежний commit.
    if (!entry.consumed_by && !this._boundCheckId(String(rollId), entry)) {
      throw new RollRegistryError('Бросок не относится ни к одной объявленной проверке', 'ROLL_UNBOUND')
    }
    if (validateContext) validateContext(structuredClone(entry.context ?? null))
    entry.consumed_by = key || `used:${this.now()}`
    // Аудит PR #131, SEC-04: исход хода ещё не известен (см. finishReservation).
    entry.commit_pending = true
    this._persist()
    const id = String(rollId)
    this.reservationHolders.set(id, (this.reservationHolders.get(id) ?? 0) + 1)
    return structuredClone({ ...entry.result, ...(entry.context ? { context: entry.context } : {}) })
  }

  /**
   * Аудит PR #131, SEC-04: `consume` помечает бросок потреблённым раньше, чем
   * ход фиксируется в журнале. Если commit не состоялся (отказ движка, конфликт
   * версии, сбой записи), пометка оставалась навсегда: другой ключ получал
   * `ROLL_ALREADY_USED`, карточка проверки пропадала, а повтор с тем же ключом
   * зависел от того, не сдвинулась ли обстановка.
   *
   * Теперь `consume` — резерв (`commit_pending`), а исход сообщает маршрут.
   * `committed: true` — запрос завершён (ход в журнале, отвергнут по существу
   * или исход неизвестен): бросок окончательно потреблён. `committed: false` —
   * commit по этому ключу не состоялся: когда последний держатель резерва в
   * процессе его отпустил, бросок снова доступен. Кость при этом та же —
   * переброса нет, а применить её можно только одним commit. Резерв другого
   * ключа и уже закреплённый резерв не трогаются.
   *
   * @returns {boolean} снят ли резерв
   */
  finishReservation(rollId, { idempotencyKey, committed = true } = {}) {
    const id = String(rollId || '')
    const holders = this.reservationHolders.get(id) ?? 0
    if (holders <= 1) this.reservationHolders.delete(id)
    else this.reservationHolders.set(id, holders - 1)
    const key = String(idempotencyKey || '')
    const entry = this.rolls.get(id)
    if (!entry || !key || entry.consumed_by !== key || entry.commit_pending !== true) return false
    if (committed) {
      delete entry.commit_pending
      this._persist()
      return false
    }
    // Пока резерв держит другой запрос того же ключа, его commit ещё возможен.
    if (holders > 1) return false
    entry.consumed_by = null
    delete entry.commit_pending
    this._persist()
    return true
  }

  /**
   * Аудит PR #131, SEC-04: восстановление после остановки процесса между
   * `consume` и исходом хода. На старте держателей нет, поэтому незакреплённый
   * резерв, чей ключ не дал commit, — осиротевший, и он снимается; с commit —
   * закрепляется. Резерв с неизвестным исходом (ошибка чтения журнала) остаётся
   * как есть: при сомнении защита от двойного применения важнее. Завершённые
   * запросы (в том числе отвергнутые без commit) не пересматриваются.
   *
   * @param {(campaignId: string, idempotencyKey: string) => Promise<boolean>} hasCommit
   * @returns {Promise<string[]>} идентификаторы освобождённых бросков
   */
  async releaseOrphanReservations(hasCommit) {
    this.cleanup()
    const released = []
    let changed = false
    for (const [id, entry] of [...this.rolls]) {
      const key = String(entry.consumed_by ?? '')
      // Потребление без ключа (`used:<время>`) с журналом не сверить.
      if (entry.commit_pending !== true || !key || key.startsWith('used:') || this.reservationHolders.has(id)) continue
      let committed
      try {
        committed = Boolean(await hasCommit(String(entry.campaign_id ?? ''), key))
      } catch {
        continue
      }
      // Пока шла проверка, резерв мог снова взять запрос того же ключа.
      if (entry.consumed_by !== key || entry.commit_pending !== true || this.reservationHolders.has(id)) continue
      delete entry.commit_pending
      changed = true
      if (committed) continue
      entry.consumed_by = null
      released.push(id)
    }
    if (changed) this._persist()
    return released
  }

  /** Карточка, под которую выдана кость, либо `null` для ничейного броска. */
  _boundCheckId(rollId, entry) {
    if (entry.check_id) return String(entry.check_id)
    for (const [id, check] of this.checks) if (check.issued_roll_id === rollId) return id
    return null
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

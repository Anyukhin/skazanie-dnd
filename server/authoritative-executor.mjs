import { IdempotencyConflictError } from './event-store.mjs'
import { normalizeCampaignState } from './rules-engine.mjs'

/**
 * Единственный исполнитель записи в журнал — шаг 3
 * `docs/agent-architecture-plan.md`.
 *
 * Сегодня в журнал пишут шестнадцать мест с разными политиками устойчивости:
 * ход игрока переживает конфликт версии прозрачно, а планировщик NPC теряет
 * ход целиком (зафиксировано в `test/writers-conflict-characterization.test.mjs`).
 * Модуль даёт один путь с одной политикой и **два входа**, потому что восемь из
 * девяти производных путей `index.mjs` производят события, а не команды, и
 * прохода через `resolvePlan` у них нет:
 *
 * - `executeCommands` — план → `resolvePlan` → optimistic retry → проверка
 *   повторного ключа → `commit` → перезагрузка результата;
 * - `commitDerived` — уже готовые события производителя, разрешённые **явной
 *   таблицей** и неподделываемой capability;
 * - `commitControl` — владельческая операция над журналом (`CampaignRewound`),
 *   которая по определению переписывает состояние целиком и потому не может
 *   идти через `commitDerived`, не обессмыслив его инвариант.
 *
 * Модуль намеренно не подключён к боевым путям в этом PR: миграция — шаги 4 и 5,
 * и она объявляет изменение поведения отдельными коммитами.
 */

/**
 * Capability — символ, а не строка: JSON-запрос не может его подделать. Тот же
 * приём уже применён к `DIRECTOR_COMMAND_CAPABILITY`.
 */
export const PARTY_DECISION_CAPABILITY = Symbol('skazanie:party-decision-capability')
export const CAMPAIGN_LIFECYCLE_CAPABILITY = Symbol('skazanie:campaign-lifecycle-capability')
export const PUBLIC_DICE_CAPABILITY = Symbol('skazanie:public-dice-capability')
export const ECONOMY_CLOCK_CAPABILITY = Symbol('skazanie:economy-clock-capability')
export const PRESENCE_CAPABILITY = Symbol('skazanie:presence-capability')
export const CAMPAIGN_CONTROL_CAPABILITY = Symbol('skazanie:campaign-control-capability')

/**
 * Явная таблица вместо общей эвристики: производитель получает ровно свои типы
 * событий и ничего сверх.
 */
const DERIVED_EVENT_ALLOWLIST = new Map([
  [PARTY_DECISION_CAPABILITY, new Set([
    'PartyDecisionOpened',
    'PartyVoteCast',
    'PartyDecisionAbstained',
    'PartyDecisionResolved',
    'PartyDecisionExpired',
    // Групповой бросок решает исход голосования, то есть влияет на ход истории.
    // План (шаг 5) рекомендует перевести его в типизированную команду — до тех
    // пор он разрешён здесь явно, а не молча, и инвариант ниже всё равно не даёт
    // ему тронуть ничего из владений Rules Engine.
    'DieRolled',
  ])],
  [PRESENCE_CAPABILITY, new Set([
    // Уход голосующего закрывает его голос и может разрешить решение отряда.
    'PartyDecisionAbstained',
    'PartyDecisionResolved',
  ])],
  [ECONOMY_CLOCK_CAPABILITY, new Set([
    // Только событие часов. Пополнение лавки остаётся за Rules Engine — это
    // единственный производитель, который расщепляется на два входа.
    'MerchantEconomyClockAdvanced',
  ])],
  [CAMPAIGN_LIFECYCLE_CAPABILITY, new Set([
    'CampaignActivated',
    'CampaignPaused',
    'CampaignResumed',
    'CampaignCompleted',
    'CampaignFailed',
    'CampaignArchived',
    'CampaignArcChainSet',
    'NarrativeSummaryRecorded',
  ])],
  [PUBLIC_DICE_CAPABILITY, new Set([
    'PublicDieRolled',
  ])],
])

/**
 * Инвариант производных событий, сформулированный точно: запрет не на броски —
 * `PublicDieRolled` легитимно приходит от серверного `DiceService`, — а на
 * владения Rules Engine.
 *
 * Проверяется по факту содержимого события, а не по описанию в документе.
 */
const RULES_ENGINE_OWNED_KEYS = Object.freeze([
  'hp', 'hp_after', 'hp_before', 'max_hp', 'damage', 'healing',
  'resources', 'position', 'positions', 'to', 'from',
  'inventory', 'item_id', 'initiative', 'action_economy',
  'conditions', 'currency', 'currency_cp', 'experience',
])

export class AuthoritativeExecutorError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'AuthoritativeExecutorError'
    this.code = code
  }
}

function assertCapability(capability, expected, label) {
  if (capability !== expected) {
    throw new AuthoritativeExecutorError(
      `${label}: производитель не предъявил неподделываемую capability`,
      'PRODUCER_CAPABILITY_REQUIRED',
    )
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string | null} имя поля, которым владеет Rules Engine
 */
function rulesEngineOwnedKeyIn(payload, seen = new WeakSet()) {
  if (!payload || typeof payload !== 'object') return null
  if (seen.has(payload)) return null
  seen.add(payload)
  for (const [key, value] of Object.entries(payload)) {
    if (RULES_ENGINE_OWNED_KEYS.includes(key)) return key
    const nested = rulesEngineOwnedKeyIn(value, seen)
    if (nested) return nested
  }
  return null
}

export class AuthoritativeExecutor {
  /**
   * @param {{ eventStore: any, rulesEngine?: any, maxAttempts?: number }} dependencies
   */
  constructor({ eventStore, rulesEngine = null, maxAttempts = 3 } = {}) {
    if (!eventStore) throw new TypeError('AuthoritativeExecutor requires eventStore')
    this.eventStore = eventStore
    this.rulesEngine = rulesEngine
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 3)
  }

  /**
   * Единственная политика устойчивости на все командные пути: оптимистичный
   * повтор на конфликте версии и перечитывание по ключу на повторе.
   *
   * @param {{
   *   campaignId: string,
   *   idempotencyKey: string,
   *   commands: Array<Record<string, unknown>>,
   *   capability?: symbol | null,
   *   actorIds?: string[],
   *   context?: Record<string, unknown>,
   * }} input
   * @returns {Promise<Record<string, unknown>>} подтверждённый коммит плюс
   *   `resolved` — разобранный план, если он считался в этом вызове
   */
  async executeCommands({
    campaignId,
    idempotencyKey,
    commands = [],
    capability = null,
    actorIds = [],
    context = {},
  } = {}) {
    if (!this.rulesEngine) throw new TypeError('executeCommands requires rulesEngine')
    const key = String(idempotencyKey ?? '')
    if (!key) throw new AuthoritativeExecutorError('Нужен идемпотентный ключ', 'IDEMPOTENCY_KEY_REQUIRED')
    if (!Array.isArray(commands) || !commands.length) {
      throw new AuthoritativeExecutorError('Пустой набор команд не коммитится', 'EMPTY_COMMAND_SET')
    }

    const duplicate = await this.eventStore.getByIdempotencyKey?.(campaignId, key)
    if (duplicate) return { ...duplicate, replayed: true }

    let loaded = await this.eventStore.load(campaignId)
    let state = normalizeCampaignState(loaded.state)
    let lastError = null
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const resolved = this.rulesEngine.resolvePlan({ proposed_commands: commands }, state, {
        ...context,
        ...(capability ? { commandCapability: capability } : {}),
        actor_ids: actorIds,
      })
      if (!resolved.events.length) {
        throw new AuthoritativeExecutorError('План не создал ни одного события', 'EMPTY_EVENT_SET')
      }
      try {
        const committed = await this.eventStore.commit({
          campaign_id: campaignId,
          expected_state_version: state.state_version,
          idempotency_key: key,
          command_id: key,
          events: resolved.events,
        })
        return { ...committed, replayed: false, resolved }
      } catch (error) {
        lastError = error
        if (error?.code === 'STATE_VERSION_CONFLICT' && attempt < this.maxAttempts - 1) {
          loaded = await this.eventStore.load(campaignId)
          state = normalizeCampaignState(loaded.state)
          continue
        }
        if (error instanceof IdempotencyConflictError || error?.code === 'IDEMPOTENCY_CONFLICT') {
          const existing = await this.eventStore.getByIdempotencyKey?.(campaignId, key)
          if (existing) return { ...existing, replayed: true }
        }
        throw error
      }
    }
    throw lastError ?? new AuthoritativeExecutorError('Команда не была подтверждена', 'COMMIT_FAILED')
  }

  /**
   * Вход для производных событий: они не проходят через Rules Engine, поэтому
   * ограничены таблицей типов и не могут трогать ничего, чем движок владеет.
   *
   * @param {{
   *   campaignId: string,
   *   idempotencyKey: string,
   *   events: Array<Record<string, unknown>>,
   *   producerCapability: symbol,
   *   derivedFrom?: string[],
   * }} input
   */
  async commitDerived({
    campaignId,
    idempotencyKey,
    events = null,
    deriveEvents = null,
    producerCapability,
    derivedFrom = [],
  } = {}) {
    const key = String(idempotencyKey ?? '')
    if (!key) throw new AuthoritativeExecutorError('Нужен идемпотентный ключ', 'IDEMPOTENCY_KEY_REQUIRED')
    const allowed = DERIVED_EVENT_ALLOWLIST.get(producerCapability)
    if (!allowed) {
      throw new AuthoritativeExecutorError(
        'Производитель не объявлен в таблице производных событий',
        'PRODUCER_CAPABILITY_REQUIRED',
      )
    }
    /**
     * Проверка содержимого — на каждой попытке, а не один раз: `deriveEvents`
     * пересобирает события против свежего состояния.
     *
     * @param {Array<Record<string, unknown>>} candidate
     */
    const assertAllowed = (candidate) => {
      if (!Array.isArray(candidate) || !candidate.length) {
        throw new AuthoritativeExecutorError('Пустой набор событий не коммитится', 'EMPTY_EVENT_SET')
      }
      for (const event of candidate) {
        const type = String(event?.event_type ?? '')
        if (!allowed.has(type)) {
          throw new AuthoritativeExecutorError(
            `Событие ${type || '(без типа)'} не разрешено этому производителю`,
            'DERIVED_EVENT_NOT_ALLOWED',
          )
        }
        const owned = rulesEngineOwnedKeyIn(event?.payload)
        if (owned) {
          throw new AuthoritativeExecutorError(
            `Производное событие ${type} трогает «${owned}» — этим владеет Rules Engine`,
            'DERIVED_EVENT_TOUCHES_RULES_STATE',
          )
        }
      }
    }
    if (!deriveEvents) assertAllowed(events)

    const duplicate = await this.eventStore.getByIdempotencyKey?.(campaignId, key)
    if (duplicate) return { ...duplicate, replayed: true }

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const loaded = await this.eventStore.load(campaignId)
      // Пересобирать события против свежего состояния обязательно: голос,
      // истечение и сверка присутствия зависят от того, кто ещё в комнате.
      // Повторить старый набор после чужого коммита значит записать решение,
      // посчитанное по устаревшему составу.
      const prepared = deriveEvents ? await deriveEvents(loaded.state, loaded) : events
      if (deriveEvents && (!Array.isArray(prepared) || !prepared.length)) return null
      if (deriveEvents) assertAllowed(prepared)
      try {
        const committed = await this.eventStore.commit({
          campaign_id: campaignId,
          expected_state_version: loaded.state_version,
          idempotency_key: key,
          command_id: key,
          events: prepared.map((event) => ({
            ...event,
            campaign_id: campaignId,
            ...(derivedFrom.length ? { source_event_ids: [...derivedFrom].map(String).slice(0, 32) } : {}),
          })),
        })
        return { ...committed, replayed: false }
      } catch (error) {
        if (error?.code === 'STATE_VERSION_CONFLICT' && attempt < this.maxAttempts - 1) continue
        if (error instanceof IdempotencyConflictError || error?.code === 'IDEMPOTENCY_CONFLICT') {
          const existing = await this.eventStore.getByIdempotencyKey?.(campaignId, key)
          if (existing) return { ...existing, replayed: true }
        }
        throw error
      }
    }
    throw new AuthoritativeExecutorError('Производное событие не было подтверждено', 'COMMIT_FAILED')
  }

  /**
   * Владельческая операция над журналом. Отдельный вход, потому что откат по
   * определению переписывает состояние целиком: пропустить его через
   * `commitDerived` можно было бы только ослабив инвариант последнего до
   * бессмысленного.
   *
   * @param {{
   *   campaignId: string,
   *   idempotencyKey: string,
   *   event: Record<string, unknown>,
   *   capability: symbol,
   * }} input
   */
  async commitControl({ campaignId, idempotencyKey, event, capability, forceSnapshot = false } = {}) {
    assertCapability(capability, CAMPAIGN_CONTROL_CAPABILITY, 'Управление кампанией')
    const key = String(idempotencyKey ?? '')
    if (!key) throw new AuthoritativeExecutorError('Нужен идемпотентный ключ', 'IDEMPOTENCY_KEY_REQUIRED')
    if (String(event?.event_type ?? '') !== 'CampaignRewound') {
      throw new AuthoritativeExecutorError(
        'Через управляющий вход проходит только CampaignRewound',
        'CONTROL_EVENT_NOT_ALLOWED',
      )
    }
    const duplicate = await this.eventStore.getByIdempotencyKey?.(campaignId, key)
    if (duplicate) return { ...duplicate, replayed: true }
    const loaded = await this.eventStore.load(campaignId)
    const committed = await this.eventStore.commit({
      campaign_id: campaignId,
      expected_state_version: loaded.state_version,
      idempotency_key: key,
      command_id: key,
      events: [{ ...event, campaign_id: campaignId }],
      ...(forceSnapshot ? { forceSnapshot: true } : {}),
    })
    return { ...committed, replayed: false }
  }
}

export const DERIVED_PRODUCERS = Object.freeze({
  partyDecision: PARTY_DECISION_CAPABILITY,
  presence: PRESENCE_CAPABILITY,
  economyClock: ECONOMY_CLOCK_CAPABILITY,
  campaignLifecycle: CAMPAIGN_LIFECYCLE_CAPABILITY,
  publicDice: PUBLIC_DICE_CAPABILITY,
})

/**
 * Таблица открыта на чтение тестам и документации: список разрешённых событий
 * обязан быть виден целиком, а не выясняться экспериментом.
 *
 * @returns {Record<string, string[]>}
 */
export function derivedEventAllowlistForReview() {
  const named = new Map(Object.entries(DERIVED_PRODUCERS).map(([name, capability]) => [capability, name]))
  return Object.fromEntries([...DERIVED_EVENT_ALLOWLIST.entries()].map(([capability, types]) => [
    named.get(capability) ?? String(capability.description ?? capability.toString()),
    [...types].sort(),
  ]))
}

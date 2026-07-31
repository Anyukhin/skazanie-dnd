import { createHash } from 'node:crypto'

import { AuthoritativeExecutor } from './authoritative-executor.mjs'

import { initiativeGroupIds, isEnemyActor, normalizeCampaignState } from './rules-engine.mjs'
import { runNpcTurnScheduler } from './npc-turn-scheduler.mjs'

export const DEFAULT_TURN_TIMEOUT_MS = 120_000
export const DEFAULT_RETRY_BASE_DELAY_MS = 250
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000
export const DEFAULT_RETRY_BACKOFF_STEPS = 8

const normalizedCampaignId = (value) => String(value ?? '').trim().toUpperCase()
const keyPart = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 60) || 'none'

function positiveTimeout(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 50 && number <= 3_600_000
    ? number
    : DEFAULT_TURN_TIMEOUT_MS
}

function positiveRetryDelay(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 && number <= 3_600_000
    ? number
    : fallback
}

function positiveRetrySteps(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 && number <= 20
    ? number
    : DEFAULT_RETRY_BACKOFF_STEPS
}

/**
 * Все ещё не завершившие ход участники текущей фазы. В обычной инициативе это
 * один actor, в групповой — оставшиеся существа одной стороны.
 */
export function activeTurnActorIds(rawState) {
  const state = normalizeCampaignState(rawState)
  const combat = state.mechanics?.combat
  if (!combat?.active || !Array.isArray(combat.initiative) || !combat.initiative.length) return []
  if (combat.reaction_window?.actor_id) return [String(combat.reaction_window.actor_id)]
  const completed = new Set((combat.turn_completed ?? []).map(String))
  const grouped = initiativeGroupIds(state)
  const ids = grouped.length
    ? grouped
    : [String(combat.initiative[combat.active_index]?.actor_id ?? '')]
  return ids.map(String).filter((id) => id && !completed.has(id))
}

function timedTurnActorIds(state) {
  const actorIds = activeTurnActorIds(state)
  if (!actorIds.length) return []
  if (state.mechanics?.combat?.reaction_window?.actor_id) return actorIds.slice(0, 1)
  // В групповой фазе действовать по-прежнему могут все участники, но общий
  // дедлайн не должен автозавершать их разом. Часы последовательно принадлежат
  // одному ещё не завершившему ход actor.
  return state.mechanics?.combat?.group_initiative === true
    ? actorIds.slice(0, 1)
    : actorIds
}

export function combatTurnClock(rawState, events, {
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  now = Date.now(),
  previousClock = null,
} = {}) {
  const state = normalizeCampaignState(rawState)
  const combat = state.mechanics?.combat
  if (!combat?.active) return null
  const actorIds = timedTurnActorIds(state)
  if (!actorIds.length || actorIds.every((id) => isEnemyActor(state, id))) return null
  const reactionWindowId = String(combat.reaction_window?.id ?? '')
  const fallbackStarted = [...(Array.isArray(events) ? events : [])].reverse().find((event) => {
    if (reactionWindowId) {
      return event?.event_type === 'ReactionWindowOpened'
        && String(event?.payload?.id ?? '') === reactionWindowId
    }
    return event?.event_type === 'TurnStarted' || event?.event_type === 'ReactionWindowClosed'
  })
  const projectedStartedAt = reactionWindowId
    ? combat.reaction_window?.opened_at
    : combat.turn_started_at
  const projectedEventId = reactionWindowId
    ? combat.reaction_window?.opened_event_id
    : combat.turn_started_event_id
  const previousMatches = previousClock
    && Number(previousClock.round) === (Number(combat.round) || 1)
    && Number(previousClock.active_index) === (Number(combat.active_index) || 0)
    && String(previousClock.reaction_window_id ?? '') === reactionWindowId
    && Array.isArray(previousClock.actor_ids)
    && previousClock.actor_ids.length === actorIds.length
    && actorIds.every((actorId, index) => String(previousClock.actor_ids[index]) === actorId)
  const startedAt = projectedStartedAt
    ?? fallbackStarted?.created_at
    ?? (previousMatches ? previousClock.started_at : null)
  const startedEventId = projectedEventId
    ?? fallbackStarted?.event_id
    ?? (previousMatches && String(previousClock.turn_id ?? '').startsWith('event:')
      ? String(previousClock.turn_id).slice('event:'.length)
      : null)
  const startedMs = Date.parse(String(startedAt ?? ''))
  const safeStartedMs = Number.isFinite(startedMs) ? startedMs : Number(now)
  const durationMs = positiveTimeout(timeoutMs)
  // Координаты round/index повторяются в каждом новом бою. Durable event_id
  // отличает одинаковый состав и порядок инициативы в разных encounters и не
  // даёт idempotency key второго боя вернуть commit первого.
  const turnId = startedEventId
    ? `event:${startedEventId}`
    : `legacy:${Number(combat.round) || 1}:${Number(combat.active_index) || 0}:${new Date(safeStartedMs).toISOString()}`
  return {
    actor_ids: actorIds,
    round: Number(combat.round) || 1,
    active_index: Number(combat.active_index) || 0,
    turn_id: turnId,
    started_at: new Date(safeStartedMs).toISOString(),
    deadline_at: new Date(safeStartedMs + durationMs).toISOString(),
    duration_ms: durationMs,
    ...(reactionWindowId ? { reaction_window_id: reactionWindowId } : {}),
  }
}

/**
 * Не публикует устаревший clock между commit нового active actor и следующим
 * settle coordinator. Иначе быстрый SSE успевает на мгновение показать
 * истёкший таймер героя уже во время хода NPC.
 */
export function combatTurnClockForState(rawState, clock) {
  if (!clock) return null
  const state = normalizeCampaignState(rawState)
  const combat = state.mechanics?.combat
  if (!combat?.active
    || Number(clock.round) !== (Number(combat.round) || 1)
    || Number(clock.active_index) !== (Number(combat.active_index) || 0)) {
    return null
  }
  const expectedActorIds = timedTurnActorIds(state)
  const clockActorIds = Array.isArray(clock.actor_ids) ? clock.actor_ids.map(String) : []
  if (expectedActorIds.length !== clockActorIds.length
    || expectedActorIds.some((actorId, index) => actorId !== clockActorIds[index])) {
    return null
  }
  return clock
}

async function commitTimedOutTurn({ campaignId, eventStore, rulesEngine, loaded, clock }) {
  const combat = loaded.state.mechanics.combat
  const eligibleActorIds = new Set(activeTurnActorIds(loaded.state))
  const actorIds = (Array.isArray(clock?.actor_ids) ? clock.actor_ids : [])
    .map(String)
    .filter((actorId) => eligibleActorIds.has(actorId))
  if (!actorIds.length) return { events: [], state: loaded.state, state_version: loaded.state_version }
  const actorFingerprint = createHash('sha256').update(actorIds.join('\0')).digest('hex').slice(0, 20)
  const reactionWindowId = String(combat.reaction_window?.id ?? '')
  const reactionFingerprint = reactionWindowId
    ? createHash('sha256').update(reactionWindowId).digest('hex').slice(0, 20)
    : ''
  const turnFingerprint = createHash('sha256')
    .update(String(clock?.turn_id ?? `legacy:${combat.round}:${combat.active_index}`))
    .digest('hex')
    .slice(0, 20)
  const key = reactionWindowId
    ? `reaction-timeout:${keyPart(campaignId).slice(0, 40)}:${reactionFingerprint}`
    : `turn-timeout:${keyPart(campaignId).slice(0, 40)}:r${combat.round}:i${combat.active_index}:${actorFingerprint}:${turnFingerprint}`
  const plan = {
    proposed_commands: actorIds.map((actorId, index) => ({
      command_type: reactionWindowId ? 'UseCombatAction' : 'EndTurn',
      command_id: `${key}:${index + 1}`,
      campaign_id: campaignId,
      actor_id: actorId,
      ...(reactionWindowId ? { action_id: 'decline-reaction' } : {}),
      server_authoritative: true,
      auto_skip_reason: 'turn-timeout',
    })),
  }
  // Шаг 4 плана: часы боя получают ту же политику, что и ход игрока. Раньше
  // чужой коммит между чтением и записью ронял авто-пропуск, и ход зависал до
  // следующего тика. Ключ по-прежнему собран из координат хода, поэтому повтор
  // после гонки или рестарта не пропускает ход второй раз.
  // `maxAttempts: 1` намеренно: у координатора **свой** повтор — ограниченная
  // экспоненциальная задержка по таймеру. Внутренний синхронный цикл исполнителя
  // подменил бы её горячими попытками подряд, а тест
  // `test/combat-turn-coordinator.test.mjs` прямо запрещает такой цикл.
  // Унифицируется путь записи и обработка повторного ключа, а не политика ожидания.
  const executor = new AuthoritativeExecutor({ eventStore, rulesEngine, maxAttempts: 1 })
  return executor.executeCommands({
    campaignId,
    idempotencyKey: key,
    commands: plan.proposed_commands,
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
}

/**
 * Один процесс владеет продвижением боёв: NPC исполняются сразу после commit,
 * а срок хода игрока выводится из durable TurnStarted.created_at. Повтор после
 * гонки или рестарта безопасен благодаря координатам хода в idempotency key.
 */
export class CombatTurnCoordinator {
  constructor({
    eventStore,
    rulesEngine,
    npcController = null,
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    retryBackoffSteps = DEFAULT_RETRY_BACKOFF_STEPS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    runNpcTurns = runNpcTurnScheduler,
    onCommitted = () => {},
    onClockChanged = () => {},
    onError = () => {},
  } = {}) {
    if (!eventStore || !rulesEngine) throw new TypeError('CombatTurnCoordinator requires eventStore and rulesEngine')
    this.eventStore = eventStore
    this.rulesEngine = rulesEngine
    this.npcController = npcController
    this.timeoutMs = positiveTimeout(timeoutMs)
    this.retryBaseDelayMs = positiveRetryDelay(retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS)
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      positiveRetryDelay(retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS),
    )
    this.retryBackoffSteps = positiveRetrySteps(retryBackoffSteps)
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.runNpcTurns = runNpcTurns
    this.onCommitted = onCommitted
    this.onClockChanged = onClockChanged
    this.onError = onError
    this.entries = new Map()
  }

  clockFor(campaignId) {
    const clock = this.entries.get(normalizedCampaignId(campaignId))?.clock
    return clock ? { ...clock, actor_ids: [...clock.actor_ids] } : null
  }

  nudge(campaignId) {
    const id = normalizedCampaignId(campaignId)
    if (!id) return
    const entry = this.entries.get(id) ?? {
      running: false,
      pending: false,
      timer: null,
      clock: null,
      retryAttempt: 0,
    }
    entry.pending = true
    this.entries.set(id, entry)
    if (!entry.running) queueMicrotask(() => { void this.#settle(id) })
  }

  async settleNow(campaignId) {
    const id = normalizedCampaignId(campaignId)
    if (!id) return
    const entry = this.entries.get(id) ?? {
      running: false,
      pending: false,
      timer: null,
      clock: null,
      retryAttempt: 0,
    }
    entry.pending = true
    this.entries.set(id, entry)
    await this.#settle(id)
  }

  close() {
    for (const entry of this.entries.values()) if (entry.timer != null) this.clearTimer(entry.timer)
    this.entries.clear()
  }

  #scheduleRetry(campaignId, entry) {
    if (this.entries.get(campaignId) !== entry) return
    entry.pending = false
    entry.retryAttempt = Math.min(entry.retryAttempt + 1, this.retryBackoffSteps)
    const delay = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * (2 ** (entry.retryAttempt - 1)),
    )
    entry.timer = this.setTimer(() => {
      entry.timer = null
      this.nudge(campaignId)
    }, delay)
  }

  async #settle(campaignId) {
    const entry = this.entries.get(campaignId)
    if (!entry || entry.running) return
    entry.running = true
    try {
      while (entry.pending) {
        entry.pending = false
        if (entry.timer != null) {
          this.clearTimer(entry.timer)
          entry.timer = null
        }

        const npc = await this.runNpcTurns({
          campaignId,
          eventStore: this.eventStore,
          rulesEngine: this.rulesEngine,
          npcController: this.npcController,
          advanceNpc: true,
        })
        let loaded = await this.eventStore.load(campaignId)
        if (npc.events?.length) {
          await this.onCommitted({ campaignId, state: loaded.state, events: npc.events })
        }

        const clock = combatTurnClock(loaded.state, [], {
          timeoutMs: this.timeoutMs,
          now: this.now(),
          previousClock: entry.clock,
        })
        entry.clock = clock
        await this.onClockChanged(campaignId, clock)
        if (!clock) {
          entry.retryAttempt = 0
          continue
        }

        const remaining = Date.parse(clock.deadline_at) - this.now()
        if (remaining > 0) {
          entry.retryAttempt = 0
          entry.timer = this.setTimer(() => {
            entry.timer = null
            this.nudge(campaignId)
          }, remaining)
          continue
        }

        const committed = await commitTimedOutTurn({
          campaignId,
          eventStore: this.eventStore,
          rulesEngine: this.rulesEngine,
          loaded,
          clock,
        })
        loaded = await this.eventStore.load(campaignId)
        if (committed.events?.length) {
          await this.onCommitted({ campaignId, state: loaded.state, events: committed.events })
        }
        entry.retryAttempt = 0
        entry.pending = true
      }
    } catch (error) {
      this.#scheduleRetry(campaignId, entry)
      if (!['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error?.code)) {
        try {
          await this.onError(error, campaignId)
        } catch {
          // Retry уже поставлен: сбой диагностического callback не должен
          // возвращать координатор в состояние без таймера.
        }
      }
    } finally {
      entry.running = false
      if (entry.pending) queueMicrotask(() => { void this.#settle(campaignId) })
    }
  }
}

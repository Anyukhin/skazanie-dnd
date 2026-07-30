import { createHash } from 'node:crypto'

import { initiativeGroupIds, isEnemyActor, normalizeCampaignState } from './rules-engine.mjs'
import { runNpcTurnScheduler } from './npc-turn-scheduler.mjs'

export const DEFAULT_TURN_TIMEOUT_MS = 120_000

const normalizedCampaignId = (value) => String(value ?? '').trim().toUpperCase()
const keyPart = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 60) || 'none'

function positiveTimeout(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 50 && number <= 3_600_000
    ? number
    : DEFAULT_TURN_TIMEOUT_MS
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

export function combatTurnClock(rawState, events, {
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  now = Date.now(),
} = {}) {
  const state = normalizeCampaignState(rawState)
  const combat = state.mechanics?.combat
  if (!combat?.active) return null
  const actorIds = activeTurnActorIds(state)
  if (!actorIds.length || actorIds.every((id) => isEnemyActor(state, id))) return null
  const reactionWindowId = String(combat.reaction_window?.id ?? '')
  const started = [...(Array.isArray(events) ? events : [])].reverse().find((event) => {
    if (reactionWindowId) {
      return event?.event_type === 'ReactionWindowOpened'
        && String(event?.payload?.id ?? '') === reactionWindowId
    }
    return event?.event_type === 'TurnStarted' || event?.event_type === 'ReactionWindowClosed'
  })
  const startedMs = Date.parse(String(started?.created_at ?? ''))
  const safeStartedMs = Number.isFinite(startedMs) ? startedMs : Number(now)
  const durationMs = positiveTimeout(timeoutMs)
  // Координаты round/index повторяются в каждом новом бою. Durable event_id
  // отличает одинаковый состав и порядок инициативы в разных encounters и не
  // даёт idempotency key второго боя вернуть commit первого.
  const turnId = started?.event_id
    ? `event:${started.event_id}`
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

async function commitTimedOutTurn({ campaignId, eventStore, rulesEngine, loaded, clock }) {
  const combat = loaded.state.mechanics.combat
  const actorIds = activeTurnActorIds(loaded.state)
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
  const resolved = rulesEngine.resolvePlan(plan, loaded.state, {
    isAdmin: true,
    serverAuthoritativeCombat: true,
  })
  return eventStore.commit({
    campaign_id: campaignId,
    expected_state_version: loaded.state_version,
    idempotency_key: key,
    command_id: key,
    events: resolved.events,
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
    const entry = this.entries.get(id) ?? { running: false, pending: false, timer: null, clock: null }
    entry.pending = true
    this.entries.set(id, entry)
    if (!entry.running) queueMicrotask(() => { void this.#settle(id) })
  }

  async settleNow(campaignId) {
    const id = normalizedCampaignId(campaignId)
    if (!id) return
    const entry = this.entries.get(id) ?? { running: false, pending: false, timer: null, clock: null }
    entry.pending = true
    this.entries.set(id, entry)
    await this.#settle(id)
  }

  close() {
    for (const entry of this.entries.values()) if (entry.timer) this.clearTimer(entry.timer)
    this.entries.clear()
  }

  async #settle(campaignId) {
    const entry = this.entries.get(campaignId)
    if (!entry || entry.running) return
    entry.running = true
    try {
      while (entry.pending) {
        entry.pending = false
        if (entry.timer) {
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

        const events = loaded.state.mechanics?.combat?.active
          ? await this.eventStore.getEvents(campaignId)
          : []
        const clock = combatTurnClock(loaded.state, events, {
          timeoutMs: this.timeoutMs,
          now: this.now(),
        })
        entry.clock = clock
        await this.onClockChanged(campaignId, clock)
        if (!clock) continue

        const remaining = Date.parse(clock.deadline_at) - this.now()
        if (remaining > 0) {
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
        entry.pending = true
      }
    } catch (error) {
      if (['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error?.code)) {
        entry.pending = true
      } else {
        this.onError(error, campaignId)
      }
    } finally {
      entry.running = false
      if (entry.pending) queueMicrotask(() => { void this.#settle(campaignId) })
    }
  }
}

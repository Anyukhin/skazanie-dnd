import { buildNarrationBrief } from './security.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'

/**
 * Потолок ожидания для необязательного текста критического момента.
 *
 * Был 4 000 мс. Живой замер 2026-07-28: первичная модель отвечает за
 * 2,7–4,0 с, то есть падение героя — самый заметный момент партии — срывалось
 * в сухой запасной текст примерно в половине случаев, и роль Творческого
 * режиссёра не работала ровно там, ради чего заведена. Потолок поднят до 8 с:
 * он остаётся ниже общего таймаута модели (9 с), поэтому цепочка фолбэков не
 * успевает начаться, а ход по-прежнему не может зависнуть — по истечении
 * срока рассказчик отдаёт детерминированный текст.
 */
export const CRITICAL_NARRATION_TIMEOUT_MS = 8_000

const CRITICAL_CONDITIONS = new Map([
  ['fled', 'enemy_fled'],
  ['surrendered', 'enemy_surrendered'],
])

function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

function actorName(state, id) {
  const expected = String(id ?? '')
  const actor = [...(state?.players ?? []), ...(state?.enemies ?? []), ...(state?.actors ?? [])]
    .find((candidate) => actorId(candidate) === expected)
  return String(actor?.character ?? actor?.name ?? (expected || 'участник'))
}

export function criticalMomentFor(events = [], state = {}) {
  const enemyIds = new Set((state.enemies ?? []).map(actorId))
  const playerIds = new Set((state.players ?? []).map(actorId))
  for (const event of events) {
    if (event.event_type !== 'HeroDied') continue
    const targetId = String(event.target_ids?.[0] ?? event.payload?.target_id ?? '')
    if (playerIds.has(targetId)) return { kind: 'hero_died', actor_id: String(event.actor_id ?? ''), target_id: targetId, target_name: actorName(state, targetId) }
  }
  for (const event of events) {
    if (event.event_type !== 'HitPointsReducedToZero') continue
    const targetId = String(event.target_ids?.[0] ?? event.payload?.target_id ?? '')
    if (enemyIds.has(targetId)) return { kind: 'enemy_defeated', actor_id: String(event.actor_id ?? ''), target_id: targetId, target_name: actorName(state, targetId) }
    if (playerIds.has(targetId)) return { kind: 'hero_fallen', actor_id: String(event.actor_id ?? ''), target_id: targetId, target_name: actorName(state, targetId) }
  }
  for (const event of events) {
    if (event.event_type !== 'ConditionAdded') continue
    const kind = CRITICAL_CONDITIONS.get(String(event.payload?.condition ?? ''))
    if (!kind) continue
    const targetId = String(event.target_ids?.[0] ?? event.actor_id ?? '')
    return { kind, actor_id: String(event.actor_id ?? ''), target_id: targetId, target_name: actorName(state, targetId) }
  }
  return null
}

function publicEnvironment(state, trigger) {
  const scene = state.scene ?? {}
  return {
    campaign_premise: campaignConceptForAgent(state),
    scene: {
      title: String(scene.title ?? ''),
      location: String(scene.location ?? ''),
      mood: String(scene.mood ?? ''),
      objective: String(scene.objective ?? ''),
    },
    critical_moment: trigger,
    participants: {
      heroes: (state.players ?? []).map((actor) => ({ id: actorId(actor), name: actorName(state, actorId(actor)) })),
      enemies: (state.enemies ?? []).map((actor) => ({ id: actorId(actor), name: actorName(state, actorId(actor)) })),
    },
  }
}

/**
 * The creative director is deliberately absent from ordinary mechanics. It is
 * called only after the rules engine has committed a bounded critical event;
 * narration can decorate that fact but cannot alter HP, rolls or positions.
 */
export class CriticalNarrationCoordinator {
  constructor({ narrator } = {}) {
    if (!narrator) throw new TypeError('CriticalNarrationCoordinator requires narrator')
    this.narrator = narrator
  }

  async renderCriticalMoment({ events = [], state = {}, viewer = {} } = {}) {
    const trigger = criticalMomentFor(events, state)
    if (!trigger) return null
    const brief = buildNarrationBrief({
      visible_events: events,
      visible_state_changes: events.map((event) => ({
        event_type: event.event_type,
        actor_id: event.actor_id ?? null,
        target_ids: event.target_ids ?? [],
        payload: event.payload ?? {},
        source_rule_ids: event.source_rule_ids ?? [],
        visibility: event.visibility ?? 'public',
      })),
      known_environment: publicEnvironment(state, trigger),
      permitted_npc_reactions: trigger.kind === 'enemy_fled' || trigger.kind === 'enemy_surrendered'
        ? [{ actor_id: trigger.target_id, reaction: trigger.kind }]
        : [],
      viewer,
    })
    const knownRuleIds = [...new Set(events.flatMap((event) => event.source_rule_ids ?? []))]
    const narration = await this.narrator.render(brief, {
      knownRuleIds,
      timeoutMs: CRITICAL_NARRATION_TIMEOUT_MS,
      style: trigger.kind === 'hero_fallen'
        ? 'Один выразительный абзац о падении героя без сознания. Герой ещё не объявлен мёртвым: не описывай смерть, предсмертные слова, похороны или окончательный исход. Не добавляй новых бросков, урона, наград или решений правил.'
        : trigger.kind === 'hero_died'
          ? 'Один выразительный абзац об окончательной смерти героя. Можно дать короткое прощание, но не воскрешай героя и не продолжай историю за него. Не добавляй новых бросков, урона, наград или решений правил.'
          : 'Один выразительный абзац о переломном моменте. Не добавляй новых бросков, урона, наград или решений правил.',
    })
    return { ...narration, trigger }
  }
}

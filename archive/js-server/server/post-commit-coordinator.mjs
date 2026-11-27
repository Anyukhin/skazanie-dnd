import { createHash } from 'node:crypto'

import { truceHolds } from './parley.mjs'

/**
 * Шаг 6 плана `docs/agent-architecture-plan.md`: последствия после коммита
 * выводит один координатор, а не пять мест подряд в `index.mjs`.
 *
 * Координатор получает **только подтверждённые** события и запускает
 * детерминированную последовательность:
 *
 * ```
 * commit
 *   → quest consequences
 *   → combat continuation
 *   → encounter completion
 *   → hero hooks
 *   → world/director trigger
 *   → visible projection
 *   → narration
 * ```
 *
 * Порядок — данные, а не поток управления: его видно целиком в `STAGES`, и
 * тест сверяет с ним фактический порядок вызовов.
 *
 * Модуль намеренно не подключён к боевым маршрутам в этом PR: подключение —
 * шаг 7, где `index.mjs` перестаёт содержать игровые сценарии.
 */

/**
 * Два вида ключей, а не один.
 *
 * `once` — одноразовое последствие: разрешение квеста, завершение встречи,
 * награда. Ключ от стабильного источника (идентификатор встречи, `event_id`).
 * Повтор обязан вернуть прежний результат, а не выполнить второй раз.
 *
 * `loop` — продолжение цикла: ход NPC, такт Режиссёра. Ключ от **позиции в
 * состоянии** (`campaign + encounter + round + initiative index + actor`).
 * Так цикл возобновляется после падения на середине очереди инициативы;
 * ключ от события дал бы повторный проход по уже сыгранным ходам.
 */
export const STAGE_KEY_KINDS = Object.freeze(['once', 'loop'])

/**
 * @typedef {{
 *   name: string,
 *   keyKind: 'once' | 'loop',
 *   applies: (context: Record<string, any>) => boolean,
 *   key: (context: Record<string, any>) => string | null,
 *   run: (context: Record<string, any>) => Promise<unknown> | unknown,
 * }} PostCommitStage
 */

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 20)
}

/**
 * Позиция в бою — то, что делает ключ продолжения устойчивым к падению на
 * середине очереди инициативы.
 *
 * @param {Record<string, any>} state
 */
export function combatPositionKey(state) {
  const combat = state?.mechanics?.combat
  if (!combat?.active) return null
  const encounterId = String(state?.mechanics?.encounter?.id ?? 'no-encounter')
  const round = Number(combat.round ?? 0)
  const index = Number(combat.active_index ?? 0)
  const actor = String(combat.initiative?.[index]?.actor_id ?? 'unknown')
  return `combat:${encounterId}:r${round}:i${index}:${actor}`
}

/**
 * Такт Режиссёра ключуется позицией в истории, а не событием: иначе повтор
 * после падения проигрывал бы ту же долю сюжета заново.
 *
 * @param {Record<string, any>} state
 */
export function directorPositionKey(state) {
  const arc = Number(state?.campaignConcept?.current_arc_number ?? 1)
  const chapter = Number(state?.adventure?.chapter ?? 1)
  const beat = String(state?.adventure?.objective ?? '')
  return `director:a${arc}:c${chapter}:${digest(beat)}`
}

/** @type {PostCommitStage[]} */
export const STAGES = Object.freeze([
  Object.freeze({
    name: 'quest-consequences',
    keyKind: 'once',
    applies: (context) => context.eventTypes.has('QuestResolved') || context.eventTypes.has('NpcPromiseResolved'),
    key: (context) => `quest-consequences:${context.commitKey}`,
    run: (context) => context.deps.applyQuestConsequences?.(context),
  }),
  Object.freeze({
    name: 'combat-continuation',
    keyKind: 'loop',
    // Перемирие останавливает продолжение боя целиком: пока обе стороны
    // говорят, ходов нет ни у кого. Предикат живёт здесь, а не только внутри
    // планировщика, чтобы стадия даже не начиналась и не занимала ключ позиции.
    applies: (context) => Boolean(context.state?.mechanics?.combat?.active) && !truceHolds(context.state),
    key: (context) => combatPositionKey(context.state),
    run: (context) => context.deps.continueCombat?.(context),
  }),
  Object.freeze({
    name: 'encounter-completion',
    keyKind: 'once',
    applies: (context) => String(context.state?.mechanics?.encounter?.status ?? '') === 'ended',
    key: (context) => {
      const encounterId = String(context.state?.mechanics?.encounter?.id ?? '')
      return encounterId ? `encounter-completion:${encounterId}:transition` : null
    },
    run: (context) => context.deps.completeEncounter?.(context),
  }),
  Object.freeze({
    name: 'hero-hooks',
    keyKind: 'once',
    // Зацепки из предысторий (`server/hero-hooks.mjs`): плетутся, когда у героя
    // собран лист, а зацепок ещё нет. Кто ждёт плетения, решает зависимость
    // (`heroesNeedingHooks`): без модели список пуст, и стадия не начинается.
    // Ключ — набор ждущих героев; durable-идемпотентность — ключ коммита
    // `hero-hooks:<hero_id>` в Event Store. Вне боя: плетение не спешит.
    applies: (context) => !context.state?.mechanics?.combat?.active
      && (context.deps.heroesNeedingHooks?.(context.state, context.campaignId) ?? []).length > 0,
    key: (context) => {
      const heroIds = [...(context.deps.heroesNeedingHooks?.(context.state, context.campaignId) ?? [])].map(String).sort()
      return heroIds.length ? `hero-hooks:${heroIds.join(',')}` : null
    },
    run: (context) => context.deps.weaveHeroHooks?.(context),
  }),
  Object.freeze({
    name: 'director-trigger',
    keyKind: 'loop',
    // Режиссёр вызывается по детерминированным триггерам, а не после каждого
    // хода: цель сцены разрешена, бой окончен, следующего шага нет.
    applies: (context) => !context.state?.mechanics?.combat?.active
      && (context.eventTypes.has('ObjectiveUpdated')
        || context.eventTypes.has('SceneAdvanced')
        || context.eventTypes.has('EncounterRewardsDistributed')),
    key: (context) => directorPositionKey(context.state),
    run: (context) => context.deps.runDirector?.(context),
  }),
  Object.freeze({
    name: 'visible-projection',
    keyKind: 'once',
    applies: () => true,
    key: (context) => `projection:${context.commitKey}`,
    run: (context) => context.deps.persistProjection?.(context),
  }),
  Object.freeze({
    name: 'narration',
    keyKind: 'once',
    applies: (context) => Boolean(context.deps.narrate) && context.events.length > 0,
    key: (context) => `narration:${context.commitKey}`,
    run: (context) => context.deps.narrate?.(context),
  }),
])

export class PostCommitCoordinator {
  /**
   * @param {{ deps?: Record<string, Function>, stages?: PostCommitStage[], onError?: (error: unknown, stage: string) => void }} options
   */
  constructor({ deps = {}, stages = STAGES, onError = null } = {}) {
    this.deps = deps
    this.stages = stages
    this.onError = onError
    /** @type {Set<string>} */
    this.completed = new Set()
  }

  /**
   * @param {{ campaignId: string, state: Record<string, any>, events: Array<Record<string, any>>, commitKey?: string }} input
   * @returns {Promise<{ ran: string[], skipped: string[], failed: string[] }>}
   */
  async run({ campaignId, state, events = [], commitKey = '', stages = null, context: extraContext = {} } = {}) {
    const context = {
      ...extraContext,
      campaignId,
      state,
      events,
      eventTypes: new Set(events.map((event) => String(event?.event_type ?? ''))),
      commitKey: String(commitKey || events[0]?.event_id || digest(JSON.stringify(events.map((event) => event?.event_id ?? '')))),
      deps: this.deps,
    }
    const ran = []
    const skipped = []
    const failed = []
    /** @type {Record<string, unknown>} */
    const results = {}
    // Подмножество стадий нужно для пошагового подключения (шаг 7): маршрут
    // отдаёт координатору ровно то, что уже готов ему отдать, а не всё сразу.
    const selected = stages ? this.stages.filter((stage) => stages.includes(stage.name)) : this.stages
    for (const stage of selected) {
      if (!stage.applies(context)) {
        skipped.push(stage.name)
        continue
      }
      const key = stage.key(context)
      if (!key) {
        skipped.push(stage.name)
        continue
      }
      const guard = `${campaignId} ${stage.name} ${key}`
      // Память процесса стережёт только одноразовые последствия: у продолжений
      // цикла идемпотентность живёт в Event Store на ключе позиции, а работа
      // внутри одной позиции бывает легитимной дважды (окно реакции решается
      // без смены позиции) — скип по памяти подвесил бы ход.
      if (stage.keyKind === 'once' && this.completed.has(guard)) {
        skipped.push(stage.name)
        continue
      }
      try {
        results[stage.name] = await stage.run({ ...context, stageKey: key })
        // Помечаем только успех: упавшая стадия обязана быть повторена
        // следующим вызовом, а уже выполненные — нет.
        if (stage.keyKind === 'once') this.completed.add(guard)
        ran.push(stage.name)
      } catch (error) {
        failed.push(stage.name)
        this.onError?.(error, stage.name)
        // Последовательность детерминированная: падение одной стадии не
        // отменяет уже выполненные и не отменяет следующие — они выводят
        // последствия из одного и того же подтверждённого состояния.
      }
    }
    return { ran, skipped, failed, results }
  }
}

/**
 * Порядок стадий обязан быть виден целиком и в тесте, и в ревью.
 *
 * @returns {Array<{ name: string, keyKind: string }>}
 */
export function stageOrderForReview() {
  return STAGES.map((stage) => ({ name: stage.name, keyKind: stage.keyKind }))
}

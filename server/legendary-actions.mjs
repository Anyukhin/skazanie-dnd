/**
 * Легендарные действия и Легендарное сопротивление.
 *
 * Модуль общий и намеренно без состояния: им пользуются двое — Rules Engine
 * (валидация, события, сброс в начале хода) и детерминированный планировщик
 * ходов (`server/npc-turn-scheduler.mjs`, выбор действия). Второго
 * авторитетного описания стат-блока быть не должно, а положить правила внутрь
 * планировщика значило бы, что движок проверяет их по своей копии.
 *
 * Учёт потраченного — маркерами состояний, ровно как у `monster-action-used`
 * из recharge-веток: маркер кладётся событием `ConditionAdded`, снимается
 * `ConditionRemoved`, переживает replay без единой новой ветки редьюсера и
 * закрывается от игрока тем же списком `ENEMY_BOOKKEEPING_CONDITIONS`, что и
 * прочая служебная бухгалтерия. Отдельного счётчика в состоянии нет намеренно:
 * счётчик пришлось бы и нормализовать, и мигрировать, и закрывать в проекции
 * третьим способом.
 *
 * Форма блока в стат-блоке:
 *
 * ```js
 * legendary: {
 *   uses: 3,          // легендарных действий между своими ходами
 *   resistance: 3,    // Легендарное сопротивление X в день (необязательно)
 *   actions: [
 *     { id: 'tail', name: 'Удар хвостом', cost: 1, kind: 'attack',
 *       attack_modifier: 8, damage_expression: '2d8+5', damage_type: 'bludgeoning', range_feet: 10 },
 *     { id: 'wing', name: 'Взмах крыльев', cost: 2, kind: 'save',
 *       save_ability: 'dex', damage_expression: '2d6+5', damage_type: 'bludgeoning',
 *       half_on_save: true, radius_feet: 10 },
 *   ],
 * }
 * ```
 */

export const LEGENDARY_POLICY_ID = 'legendary-actions-v1'
export const LEGENDARY_EVENT_SCHEMA_VERSION = 1

/** Потраченное легендарное действие: `legendary-action-used:<порядковый номер>`. */
export const LEGENDARY_ACTION_CONDITION_PREFIX = 'legendary-action-used:'
/** Потраченное Легендарное сопротивление: `legendary-resistance-used:<n>`. */
export const LEGENDARY_RESISTANCE_CONDITION_PREFIX = 'legendary-resistance-used:'

/** Виды легендарных действий, которые движок действительно исполняет. */
export const LEGENDARY_ACTION_KINDS = Object.freeze(['attack', 'save'])

const MAXIMUM_USES = 5
const MAXIMUM_ACTIONS = 6
const SAVE_ABILITIES = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])

const positiveInteger = (value, fallback, maximum) => {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(maximum, parsed)
}

/**
 * Нормализованный легендарный блок либо `null`.
 *
 * Действие без исполнимого вида отбрасывается здесь, а не при исполнении:
 * планировщик обязан предлагать только то, что движок примет, иначе один
 * незнакомый `kind` в записи бестиария ронял бы весь ход существа отказом.
 */
export function legendaryProfileFor(actor) {
  const raw = actor?.legendary
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const actions = (Array.isArray(raw.actions) ? raw.actions : [])
    .map((entry) => {
      const id = String(entry?.id ?? '')
      const kind = String(entry?.kind ?? 'attack')
      if (!id || !LEGENDARY_ACTION_KINDS.includes(kind)) return null
      return Object.freeze({
        id,
        name: String(entry?.name ?? id).slice(0, 120),
        cost: positiveInteger(entry?.cost, 1, MAXIMUM_USES),
        kind,
        attackModifier: Math.trunc(Number(entry?.attack_modifier ?? entry?.attackModifier) || 0),
        damageExpression: entry?.damage_expression == null ? null : String(entry.damage_expression),
        damageType: String(entry?.damage_type ?? 'bludgeoning'),
        saveAbility: SAVE_ABILITIES.includes(String(entry?.save_ability)) ? String(entry.save_ability) : 'dex',
        saveDc: entry?.save_dc == null ? null : Math.max(1, Math.trunc(Number(entry.save_dc) || 10)),
        halfOnSave: entry?.half_on_save === true,
        condition: entry?.condition == null ? null : String(entry.condition),
        rangeFeet: positiveInteger(entry?.range_feet ?? entry?.rangeFeet, 5, 600),
        radiusFeet: positiveInteger(entry?.radius_feet ?? entry?.radiusFeet, 0, 120),
      })
    })
    .filter(Boolean)
    .slice(0, MAXIMUM_ACTIONS)
  if (!actions.length) return null
  return Object.freeze({
    uses: positiveInteger(raw.uses, 3, MAXIMUM_USES),
    resistance: Math.max(0, Math.min(MAXIMUM_USES, Math.trunc(Number(raw.resistance ?? raw.legendary_resistance) || 0))),
    actions: Object.freeze(actions),
  })
}

/**
 * Босс — это существо с легендарными действиями, и никакого второго признака у
 * него нет. Отдельный флаг `boss: true` в стат-блоке разошёлся бы с механикой
 * при первой же правке: рамка была бы, а действий вне хода — нет.
 */
export function isBossActor(actor) {
  return legendaryProfileFor(actor) != null
}

export function legendaryActionFor(actor, actionId) {
  const profile = legendaryProfileFor(actor)
  if (!profile) return null
  const id = String(actionId ?? '')
  return profile.actions.find((action) => action.id === id) ?? null
}

/**
 * Окно легендарного действия — чужой ход, после которого оно совершается.
 *
 * Ключ окна вшит в сам маркер, и это не украшение: без него запас в три
 * действия сгорал бы весь после первого же хода героя. Редакция даёт одно
 * действие на чужой ход, а всего до трёх между своими ходами — оба предела
 * считаются по одним и тем же маркерам, поэтому второго счётчика в состоянии
 * не заводится.
 */
export const legendaryWindowKey = (combat) => `r${Math.max(0, Math.trunc(Number(combat?.round) || 0))}i${Math.trunc(Number(combat?.active_index) ?? -1)}`

export const legendaryActionMarker = (ordinal, windowKey) => `${LEGENDARY_ACTION_CONDITION_PREFIX}${ordinal}:${windowKey}`
export const legendaryResistanceMarker = (ordinal) => `${LEGENDARY_RESISTANCE_CONDITION_PREFIX}${ordinal}`

const countMarkers = (conditionIds, prefix) => [...(conditionIds ?? [])]
  .filter((condition) => String(condition).startsWith(prefix)).length

/** Сколько легендарных действий уже потрачено между своими ходами. */
export function legendaryUsesSpent(conditionIds) {
  return countMarkers(conditionIds, LEGENDARY_ACTION_CONDITION_PREFIX)
}

/** Совершено ли легендарное действие уже в этом окне. */
export function legendaryWindowSpent(conditionIds, windowKey) {
  const suffix = `:${windowKey}`
  return [...(conditionIds ?? [])]
    .some((condition) => String(condition).startsWith(LEGENDARY_ACTION_CONDITION_PREFIX) && String(condition).endsWith(suffix))
}

/** Сколько Легендарных сопротивлений уже сожжено за день. */
export function legendaryResistanceSpent(conditionIds) {
  return countMarkers(conditionIds, LEGENDARY_RESISTANCE_CONDITION_PREFIX)
}

/**
 * Состояния, ради которых Легендарное сопротивление стоит жечь.
 *
 * Список закрыт и лежит здесь, а не в движке: это правило поведения босса, и
 * его должны читать одинаково и валидация, и планировщик. Ошеломление,
 * паралич и обездвиживание отнимают у босса ходы целиком — именно от этого
 * редакция и даёт сопротивление; испуг и очарование ломают ему выбор цели.
 */
export const LEGENDARY_CONTROL_CONDITIONS = Object.freeze([
  'stunned', 'paralyzed', 'unconscious', 'petrified', 'incapacitated',
  'restrained', 'banished', 'charmed', 'frightened',
])

/**
 * Тратить ли Легендарное сопротивление на этот провал. Правило закрытое:
 *
 * 1. осталось хоть одно применение;
 * 2. провал действительно чем-то грозит — либо накладывает состояние из
 *    списка выше, либо урон снимает босса до нуля;
 * 3. на всём прочем сопротивление не жжётся: провал спасброска, который стоит
 *    боссу половины урона от одной стрелы, не стоит суточного ресурса.
 *
 * Модель к решению не допускается: это правило, а не вкус.
 */
export function legendaryResistanceDecision({ actor, spentUses = 0, conditions = [], damage = 0, hpBefore = 0 }) {
  const profile = legendaryProfileFor(actor)
  if (!profile || profile.resistance <= 0) return null
  const remaining = profile.resistance - Math.max(0, Math.trunc(Number(spentUses) || 0))
  if (remaining <= 0) return null
  const controlling = (Array.isArray(conditions) ? conditions : [])
    .map(String)
    .find((condition) => LEGENDARY_CONTROL_CONDITIONS.includes(condition.split(':')[0]))
  const lethal = Math.max(0, Math.trunc(Number(damage) || 0)) >= Math.max(0, Math.trunc(Number(hpBefore) || 0))
    && Math.max(0, Math.trunc(Number(damage) || 0)) > 0
  if (!controlling && !lethal) return null
  return {
    reason: controlling ? 'control' : 'lethal',
    condition: controlling ?? null,
    ordinal: Math.max(0, Math.trunc(Number(spentUses) || 0)) + 1,
    remaining_after: remaining - 1,
    maximum: profile.resistance,
  }
}

/**
 * Какое легендарное действие пустить в ход. Правило закрытое и не зависит от
 * порядка записей в стат-блоке: сперва берётся самое дорогое из доступных —
 * дорогое действие сильнее, и придержать его не за чем, потому что запас всё
 * равно сгорит в начале своего хода, — при равенстве цены побеждает меньший
 * идентификатор, чтобы повтор плана давал тот же выбор.
 *
 * Действие с зоной (`radius_feet`) требует хотя бы двух целей в радиусе, иначе
 * дорогой взмах крыльев разменивался бы на одного героя.
 */
export function chooseLegendaryAction({ actor, remainingUses, targets = [] }) {
  const profile = legendaryProfileFor(actor)
  if (!profile) return null
  const available = Math.max(0, Math.trunc(Number(remainingUses) || 0))
  if (available <= 0 || !targets.length) return null
  const affordable = profile.actions
    .filter((action) => action.cost <= available)
    .filter((action) => {
      if (action.radiusFeet <= 0) return targets.some((target) => target.distanceFeet <= action.rangeFeet)
      return targets.filter((target) => target.distanceFeet <= action.radiusFeet).length >= 2
    })
    .sort((left, right) => right.cost - left.cost || left.id.localeCompare(right.id))
  const action = affordable[0]
  if (!action) return null
  // Цель — ближайшая досягаемая, при равенстве побеждает меньший
  // идентификатор: повтор плана обязан выбрать того же героя.
  const reach = action.radiusFeet > 0 ? action.radiusFeet : action.rangeFeet
  const target = targets
    .filter((candidate) => candidate.distanceFeet <= reach)
    .sort((left, right) => left.distanceFeet - right.distanceFeet || String(left.id).localeCompare(String(right.id)))[0]
  return target ? { action, target_id: String(target.id) } : null
}

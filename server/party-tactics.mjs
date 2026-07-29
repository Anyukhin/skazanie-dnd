import {
  actorPosition,
  attackProfileFor,
  findActor,
  isLivingActor,
  shortestTacticalPath,
} from './rules-engine.mjs'

/**
 * Тактика автономного героя — серверная политика, а не решение модели.
 *
 * До 2026-07-28 автономный герой умел ровно одно: выбрать врага с наименьшими
 * ОЗ, дойти до него и ударить. Это давало странную картину боя — герой
 * разворачивался спиной к противнику, стоящему вплотную, шёл через всю карту
 * под атаки по возможности, а лежащий рядом без сознания союзник так и
 * оставался лежать с зельем лечения в чужой сумке.
 *
 * Политика ниже добавляет три правила, и все три исполняются уже
 * существующими typed-командами: `UseItem`, `MoveActor`, `MakeAttack`. Модель
 * в выборе не участвует, случайности нет — тот же порядок инициативы и то же
 * состояние дают тот же план, поэтому replay остаётся идентичным.
 *
 * Сознательно **не** делается: выбор заклинаний и классовых умений. Он требует
 * знания ресурсов, времени накладывания и статуса карточки (`verified` против
 * `heuristic`), то есть отдельной политики; см. `docs/loop-immersion.md`.
 */

/** Доля максимума ОЗ, ниже которой союзник считается тяжело раненным. */
export const HEAL_THRESHOLD_RATIO = 0.35
/** Профиль лечебного предмета из `server/item-lifecycle.mjs`. */
const HEALING_CATALOG_ID = 'srd_5_2_1:potion-of-healing'
const HEALING_RANGE_FEET = 5

const idOf = (actor) => String(actor?.id ?? actor?.actor_id ?? '')
const hpOf = (actor) => Number(actor?.hp ?? actor?.hitPoints ?? 0) || 0
const maxHpOf = (actor) => Math.max(1, Number(actor?.maxHp ?? actor?.max_hp ?? 0) || 1)

function feetBetween(from, to) {
  return from && to ? Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5 : Number.MAX_SAFE_INTEGER
}

/** Герой мёртв окончательно — лечить его нельзя, это отдельная механика. */
function isDeadHero(state, heroId) {
  return state?.mechanics?.death?.heroes?.[String(heroId)]?.status === 'dead'
}

function healingItem(actor) {
  return (actor?.inventory ?? []).find((item) => String(item?.catalog_id ?? item?.catalogId ?? '') === HEALING_CATALOG_ID
    && Number(item?.quantity ?? 1) > 0) ?? null
}

function equippedWeapon(actor) {
  return (actor?.inventory ?? []).find((item) => item?.type === 'weapon'
    && item?.equipped === true
    && Number(item?.quantity ?? 1) > 0
    && ['melee', 'ranged'].includes(String(item?.combat?.kind ?? ''))) ?? null
}

/**
 * Кого лечить. Порядок жёсткий и объяснимый: сначала те, кто уже упал (у них
 * идут спасброски от смерти), затем тяжело раненные. Внутри группы — меньшие
 * ОЗ вперёд, при равенстве решает идентификатор, чтобы план был устойчив.
 */
export function healingTargetFor(state, actorIdValue) {
  const partyIds = new Set((state?.partyMemberIds?.length ? state.partyMemberIds : (state?.players ?? []).map(idOf)).map(String))
  const candidates = (state?.players ?? [])
    .filter((player) => partyIds.has(idOf(player)) && !isDeadHero(state, idOf(player)))
    .filter((player) => hpOf(player) <= 0 || hpOf(player) <= Math.max(1, Math.floor(maxHpOf(player) * HEAL_THRESHOLD_RATIO)))
  if (!candidates.length) return null
  return candidates.sort((left, right) => {
    const downed = Number(hpOf(left) > 0) - Number(hpOf(right) > 0)
    if (downed !== 0) return downed
    return hpOf(left) - hpOf(right) || idOf(left).localeCompare(idOf(right))
  })[0] ?? null
}

/** Сколько шагов пути герой успевает пройти за ход. */
function stepsWithinSpeed(actor, path, keepDistanceCells = 0, availableMovementFeet = Number(actor?.speed) || 30) {
  const budget = Math.max(0, Math.floor(Math.max(0, availableMovementFeet) / 5))
  const needed = Math.max(0, (path?.length ?? 0) - keepDistanceCells)
  return Math.min(needed, budget)
}

function approachCommands(state, actorIdValue, actor, targetId, keepDistanceFeet, plannedMovementFeet = 0) {
  const to = actorPosition(state, targetId)
  const path = shortestTacticalPath(state, actorIdValue, to, { allowOccupiedDestination: true })
  const keepCells = Math.max(0, Math.floor(Number(keepDistanceFeet) / 5))
  const speed = Math.max(0, Number(actor?.speed) || 30)
  const economy = state?.mechanics?.combat?.action_economy?.[String(actorIdValue)] ?? {}
  const availableMovementFeet = speed
    + Math.max(0, Number(economy.movement_bonus) || 0)
    - Math.max(0, Number(economy.movement_spent) || 0)
    - Math.max(0, Number(plannedMovementFeet) || 0)
  const steps = stepsWithinSpeed(actor, path, keepCells, availableMovementFeet)
  if (steps <= 0 || !path?.[steps - 1]) return { commands: [], position: actorPosition(state, actorIdValue) }
  return {
    commands: [{ command_type: 'MoveActor', actor_id: actorIdValue, to: path[steps - 1] }],
    position: path[steps - 1],
  }
}

function standUpPlan(state, actorIdValue, actor) {
  const prone = (state?.mechanics?.conditions?.[String(actorIdValue)] ?? [])
    .some((condition) => String(condition?.id ?? condition) === 'prone')
  if (!prone) return { commands: [], movementCost: 0 }
  const speed = Math.max(0, Number(actor?.speed) || 30)
  const economy = state?.mechanics?.combat?.action_economy?.[String(actorIdValue)] ?? {}
  const movementCost = Math.ceil(speed / 2)
  const available = speed
    + Math.max(0, Number(economy.movement_bonus) || 0)
    - Math.max(0, Number(economy.movement_spent) || 0)
  if (available < movementCost) return { commands: [], movementCost: 0 }
  return {
    commands: [{ command_type: 'UseCombatAction', actor_id: actorIdValue, action_id: 'stand-up' }],
    movementCost,
  }
}

/**
 * План хода автономного героя: массив typed-команд, всегда завершающийся
 * `EndTurn`. Возвращает также `rule` — какое правило сработало; оно попадает
 * в журнал прогонов и делает поведение объяснимым.
 */
export function planHeroTurn(state, actorIdValue) {
  const actor = findActor(state, actorIdValue)
  const livingEnemies = (state?.enemies ?? []).filter(isLivingActor)
  const end = { command_type: 'EndTurn', actor_id: actorIdValue }
  if (!actor || !livingEnemies.length) return { rule: 'end-turn', commands: [end] }

  const from = actorPosition(state, actorIdValue)
  const standing = standUpPlan(state, actorIdValue, actor)

  // 1. Упавший или тяжело раненный союзник важнее ещё одного удара: зелье в
  //    сумке, потраченное после боя, спасти его уже не может.
  const potion = healingItem(actor)
  const woundedAlly = potion ? healingTargetFor(state, actorIdValue) : null
  if (potion && woundedAlly) {
    const allyId = idOf(woundedAlly)
    const commands = []
    let position = from
    if (feetBetween(position, actorPosition(state, allyId)) > HEALING_RANGE_FEET && allyId !== actorIdValue) {
      const approach = approachCommands(state, actorIdValue, actor, allyId, HEALING_RANGE_FEET, standing.movementCost)
      commands.push(...approach.commands)
      position = approach.position
    }
    if (allyId === actorIdValue || feetBetween(position, actorPosition(state, allyId)) <= HEALING_RANGE_FEET) {
      commands.push({ command_type: 'UseItem', actor_id: actorIdValue, item_id: String(potion.id), target_id: allyId })
      return { rule: allyId === actorIdValue ? 'heal-self' : 'heal-ally', commands: [...standing.commands, ...commands, end] }
    }
    // Дойти не успели — ход не пропадает: ниже отработает обычная атака.
  }

  const profile = attackProfileFor(state, actorIdValue)
  if (!profile) return { rule: 'no-attack-profile', commands: [...standing.commands, end] }
  const weapon = equippedWeapon(actor)
  const attackRangeFeet = weapon
    ? Math.max(5, Number(weapon.combat?.range_feet ?? weapon.combat?.range ?? 5) || 5)
    : profile.range_feet
  const attackCommand = (targetId) => ({
    command_type: 'MakeAttack',
    actor_id: actorIdValue,
    target_id: targetId,
    ...(weapon ? { item_id: String(weapon.id) } : {}),
    server_authoritative: true,
  })

  // 2. Противник вплотную бьётся здесь и сейчас. Уходить от него через всю
  //    карту к более раненой цели значит подставиться под атаку по
  //    возможности ради цели, до которой ещё надо дожить.
  const adjacent = livingEnemies
    .filter((enemy) => feetBetween(from, actorPosition(state, idOf(enemy))) <= HEALING_RANGE_FEET)
    .sort((left, right) => hpOf(left) - hpOf(right) || idOf(left).localeCompare(idOf(right)))[0]
  if (adjacent) {
    return {
      rule: 'attack-adjacent',
      commands: [...standing.commands, attackCommand(idOf(adjacent)), end],
    }
  }

  // 3. Иначе — прежнее сосредоточение огня на самом раненом противнике.
  const target = [...livingEnemies].sort((left, right) => hpOf(left) - hpOf(right) || idOf(left).localeCompare(idOf(right)))[0]
  const targetId = idOf(target)
  const commands = []
  let position = from
  if (feetBetween(position, actorPosition(state, targetId)) > attackRangeFeet) {
    const approach = approachCommands(state, actorIdValue, actor, targetId, attackRangeFeet, standing.movementCost)
    commands.push(...approach.commands)
    position = approach.position
  }
  if (feetBetween(position, actorPosition(state, targetId)) <= attackRangeFeet) {
    commands.push(attackCommand(targetId))
    return { rule: commands.length > 1 ? 'close-and-attack' : 'attack-focus', commands: [...standing.commands, ...commands, end] }
  }
  return { rule: 'advance', commands: [...standing.commands, ...commands, end] }
}

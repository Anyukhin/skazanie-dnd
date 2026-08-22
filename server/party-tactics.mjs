import {
  actorPosition,
  attackProfileFor,
  findActor,
  isLivingActor,
  shortestTacticalPath,
  weaponAttackProfileFor,
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
 *
 * С 2026-08-18 здесь же живёт вторая политика — выбор реакции
 * (`planHeroReaction`). Она отвечает на **уже открытое** сервером окно и
 * ничего к нему не добавляет: список `action_options` собрал движок теми же
 * проверками, какими он показывает кнопки игроку, поэтому автономный герой
 * физически не может поднять «Щит» без ячейки или ударить вдогонку без оружия.
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
  // Дальность берётся из того же профиля, который движок соберёт по `item_id`:
  // считать её здесь по своим полям значит разойтись с проверкой `MakeAttack`.
  // Прежняя формула читала `combat.range_feet`, которого у предметов нет вовсе
  // (`server/starter-kit.mjs` пишет `normalRange`/`longRange`), и любое оружие
  // оказывалось на пяти футах: лучник шёл в упор и стрелял с помехой.
  const weaponProfile = weapon ? weaponAttackProfileFor(state, actorIdValue, String(weapon.id)) : null
  // Порог — обычная дальность, а не предельная: за нею бросок идёт с помехой,
  // и подойти выгоднее, чем выстрелить.
  const attackRangeFeet = weaponProfile?.normal_range_feet ?? profile.range_feet
  const attackCommand = (targetId) => ({
    command_type: 'MakeAttack',
    actor_id: actorIdValue,
    target_id: targetId,
    ...(weaponProfile ? { item_id: String(weapon.id) } : {}),
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

/**
 * Доля максимума ОЗ, начиная с которой удар считается крупным и стоит
 * «Невероятного уклонения». Четверть максимума — не выдуманное число, а тот же
 * порядок величины, каким уже пользуются соседи: зелье противник пьёт на 30%
 * (`NPC_HEALING_POTION_HP_PERCENT`), тяжело раненного союзника автономный герой
 * ищет на 35% (`HEAL_THRESHOLD_RATIO`). Сравнение целыми — чтобы ровно четверть
 * не зависела от двоичного представления `0.25`.
 */
export const UNCANNY_DODGE_DAMAGE_PERCENT = 25

/**
 * Порядок предпочтений автономного героя в открытом окне реакции. Список
 * закрыт: всё, чего в нём нет (парирование, ответный удар, «Поглощение стихий»,
 * «Адская кара», «Несгибаемый», заготовленное действие, контрзаклинание), окно
 * закрывает отказом. Это осознанная граница — у каждой из этих реакций своя
 * цена и свой повод, и выбирать их вслепую значило бы тратить ресурс героя за
 * игрока, а не играть за него.
 */
export const AUTONOMOUS_REACTION_PRIORITY = Object.freeze(['opportunity-attack', 'cast:shield', 'uncanny-dodge'])

/** Сколько ОЗ снял удар, открывший окно: обычный урон плюс съеденный временный. */
function reactionDamageTaken(reactionWindow) {
  const damage = reactionWindow?.damage
  if (!damage || typeof damage !== 'object') return 0
  return Math.max(0, Number(damage.applied_amount) || 0) + Math.max(0, Number(damage.temporary_hp_absorbed) || 0)
}

/**
 * Ответ автономного героя на **уже открытое** сервером окно реакции.
 *
 * До 2026-08-18 автономный цикл закрывал любое окно командой
 * `decline-reaction`: иначе он вставал, дожидаясь ответа, которого в
 * автономной игре некому дать. Плата была прямая — партия под управлением
 * сервера никогда не била вдогонку и не поднимала «Щит», то есть играла слабее
 * тех же героев в руках людей.
 *
 * Политика ниже детерминирована и модели не спрашивает. Своих проверок у неё
 * нет вовсе, и это главное: окно уже содержит `action_options`, собранные
 * движком теми же условиями, какими он рисует кнопки игроку. «Щит» попадает в
 * список, только если попадание перестаёт быть попаданием с +5 к КД и у героя
 * есть ячейка 1-го круга и выше (`reactionOptionsAfterAttack`); «Атака по
 * возможности» — только если реакция свободна и есть чем бить
 * (`opportunityAttackProfile`). Поэтому скрытого преимущества здесь нет по
 * построению: политика выбирает из того же меню и теми же командами, какие
 * отправляет клиент.
 *
 * Единственное собственное решение — порог «Невероятного уклонения»: тратить
 * реакцию на царапину невыгодно, поэтому оно поднимается только на удар от
 * четверти максимума ОЗ. Первым уклонение окажется само собой: реакция на ход
 * одна, и второе окно движок уже не откроет.
 *
 * @param {Record<string, any>} state состояние кампании
 * @param {Record<string, any> | null} [reactionWindow] окно; по умолчанию — текущее
 * @returns {{rule: string, commands: Array<Record<string, any>>}}
 */
export function planHeroReaction(state, reactionWindow = null) {
  const window = reactionWindow ?? state?.mechanics?.combat?.reaction_window ?? null
  const actorIdValue = String(window?.actor_id ?? '')
  const command = (actionId) => ({
    command_type: 'UseCombatAction',
    actor_id: actorIdValue,
    action_id: actionId,
    ...(actionId === 'decline-reaction' ? {} : { target_id: String(window?.source_actor_id ?? '') }),
    server_authoritative: true,
  })
  const decline = { rule: 'decline-reaction', commands: [command('decline-reaction')] }
  if (!window || !actorIdValue) return decline
  const offered = new Set((Array.isArray(window.action_ids) ? window.action_ids : []).map(String))
  const chosen = AUTONOMOUS_REACTION_PRIORITY.find((actionId) => {
    if (!offered.has(actionId)) return false
    if (actionId !== 'uncanny-dodge') return true
    const actor = findActor(state, actorIdValue)
    return reactionDamageTaken(window) * 100 >= maxHpOf(actor) * UNCANNY_DODGE_DAMAGE_PERCENT
  })
  return chosen ? { rule: chosen, commands: [command(chosen)] } : decline
}

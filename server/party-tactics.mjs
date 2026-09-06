import {
  actorPosition,
  attackForecast,
  attackProfileFor,
  findActor,
  isLivingActor,
  movementCostOfPath,
  previewApproachAttack,
  validateCommand,
  shortestTacticalPath,
  weaponAttackProfileFor,
} from './rules-engine.mjs'
import { combatActionsFor } from './combat-actions.mjs'
import { combatSpellsFor } from './combat-spells.mjs'

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

/* -------------------------------------------------------------------------- *
 * Политика одного шага для нового боевого стенда.
 *
 * Важное ограничение: этот helper принимает обычную player-visible проекцию.
 * Поэтому скрытые ОЗ врагов используются только как «жив/не жив», а для
 * validateCommand делается техническая копия с hp=1 у видимых живых врагов.
 * Это не раскрывает информацию и не влияет на настоящий state: validator'у
 * нужны хиты лишь для общего gate цели.
 * -------------------------------------------------------------------------- */

const COMBAT_POLICY_SUPPORT = new Set(['verified', 'partial'])
const DAMAGE_SPELL_KINDS = new Set(['attack', 'damage', 'save', 'debuff', 'area-save', 'area-damage'])
const HEALING_SPELL_KINDS = new Set(['healing'])
const BUFF_SPELL_KINDS = new Set(['buff'])

const combatId = (actor) => String(actor?.id ?? actor?.actor_id ?? '')
const combatHp = (actor) => Number.isFinite(Number(actor?.hp)) ? Number(actor.hp) : null
const combatMaxHp = (actor) => Math.max(1, Number(actor?.maxHp ?? actor?.max_hp) || 1)
const combatPosition = (state, id) => actorPosition(state, id)
const combatDistance = (state, leftId, rightId) => feetBetween(combatPosition(state, leftId), combatPosition(state, rightId))
const economyFor = (state, actorIdValue) => state?.mechanics?.combat?.action_economy?.[String(actorIdValue)] ?? {}
const resourceFor = (state, actorIdValue, resource) => state?.mechanics?.resources?.[String(actorIdValue)]?.[String(resource)] ?? null

function visibleLivingEnemy(actor) {
  return Boolean(actor) && actor.alive !== false && (actor.hp == null || Number(actor.hp) > 0)
}

function visibleLivingAlly(actor) {
  return Boolean(actor) && actor.alive !== false && Number(actor.hp) > 0
}

function downedAlly(actor) {
  return Boolean(actor) && actor.alive !== false && Number(actor.hp) <= 0
}

function conditionIdsForTactics(state, actorIdValue) {
  return new Set((state?.mechanics?.conditions?.[String(actorIdValue)] ?? []).map((condition) => String(condition?.id ?? condition)))
}

function partyActorsForTactics(state) {
  const ids = new Set((state?.partyMemberIds?.length
    ? state.partyMemberIds
    : (state?.players ?? []).map(combatId)).map(String))
  return (state?.players ?? []).filter((actor) => ids.has(combatId(actor)))
}

function enemiesForTactics(state) {
  return (state?.enemies ?? []).filter(visibleLivingEnemy)
}

function cloneForTacticValidation(state) {
  const clone = structuredClone(state)
  // На маленьких аренах стенд знает геометрию карты и координаты участников,
  // но player projection может оставить derived `scene.cells` нераскрытым.
  // Для проверки маршрута раскрываем только техническую копию: содержимое
  // противника и исходный state от этого не становятся видимыми или мутными.
  if (Array.isArray(clone.scene?.cells)) {
    clone.scene.cells = clone.scene.cells.map((cell) => cell?.revealed === false ? cell : { ...cell, revealed: true })
  }
  clone.enemies = (clone.enemies ?? []).map((enemy) => {
    if (enemy?.alive === false || enemy?.hp != null) return enemy
    // Для проверки допустимости цели достаточно одного технического ОЗ.
    // Эта копия не участвует в оценке тактики и исполнении команды.
    return { ...enemy, hp: 1, maxHp: Math.max(1, Number(enemy.maxHp ?? 1) || 1), alive: true }
  })
  return clone
}

function validatesTacticCommand(state, actorIdValue, command) {
  try {
    validateCommand({ ...command, actor_id: String(actorIdValue), server_authoritative: true }, cloneForTacticValidation(state), {
      serverAuthoritativeCombat: true,
      allowedActorIds: [String(actorIdValue)],
    })
    return true
  } catch {
    return false
  }
}

function reactionCommandForTactics(window, actionId, actorIdValue, extra = {}) {
  const command = {
    command_type: 'UseCombatAction',
    actor_id: String(actorIdValue),
    action_id: String(actionId),
    server_authoritative: true,
    ...extra,
  }
  if (actionId !== 'decline-reaction' && !Object.hasOwn(command, 'target_id') && window?.source_actor_id) {
    command.target_id = String(window.source_actor_id)
  }
  return command
}

function planExpandedCombatReaction(state, window) {
  const actorIdValue = String(window?.actor_id ?? '')
  const offered = new Set((Array.isArray(window?.action_ids) ? window.action_ids : []).map(String))
  if (!actorIdValue || !offered.size) return null
  const damage = reactionDamageTaken(window)
  const damageType = String(window?.damage?.damage_type ?? '').toLowerCase()
  const elemental = new Set(['acid', 'cold', 'fire', 'lightning', 'thunder']).has(damageType)
  const trigger = String(window?.trigger ?? '')
  const triggerRoll = window?.trigger_roll ?? {}
  const actor = findActor(state, actorIdValue)
  const choose = (actionId, reason, extra = {}) => {
    if (!offered.has(actionId)) return null
    const command = reactionCommandForTactics(window, actionId, actorIdValue, extra)
    return validatesTacticCommand(state, actorIdValue, command) ? { command, reason } : null
  }

  // Сначала предотвращаем вражеское заклинание, затем сохраняем проваленный
  // спасбросок. Это окна, где промедление меняет уже подтверждённый результат.
  const counterspell = choose('cast:counterspell', 'Прервать вражеское заклинание Контрзаклинанием')
  if (counterspell) return counterspell
  const indomitable = choose('indomitable', 'Перебросить проваленный спасбросок Несгибаемостью')
  if (indomitable) return indomitable

  // Щит отменяет весь удар. Стихийное поглощение и Парирование уменьшают
  // подтверждённый урон; Ответный удар разумен только после промаха.
  const shield = choose('cast:shield', 'Отменить попавший удар реакцией «Щит»')
  if (shield) return shield
  if (elemental && damage > 0) {
    const absorb = choose('cast:absorb-elements', `Снизить ${damageType}-урон «Поглощением стихий»`)
    if (absorb) return absorb
  }
  if (damage > 0 && damage * 100 >= Math.max(1, combatMaxHp(actor)) * 10) {
    const parry = choose('parry', 'Снизить крупный удар Парированием')
    if (parry) return parry
  }
  if (damage > 0) {
    const rebuke = choose('cast:hellish-rebuke', 'Ответить на полученный удар Адским возмездием')
    if (rebuke) return rebuke
  }
  if (trigger === 'attack-missed' || triggerRoll.hit === false) {
    const riposte = choose('riposte', 'Ответить на промах противника Ответным ударом')
    if (riposte) return riposte
  }

  const silvery = offered.has('cast:silvery-barbs')
    ? partyActorsForTactics(state).find((candidate) => visibleLivingAlly(candidate)
      && combatDistance(state, actorIdValue, combatId(candidate)) <= 60)
    : null
  const silveryPlan = silvery
    ? choose('cast:silvery-barbs', 'Перебросить удачный бросок Искусной остротой', { beneficiary_id: combatId(silvery) })
    : null
  if (silveryPlan) return silveryPlan

  for (const [actionId, reason] of [
    ['readied-spell', 'Выпустить заготовленное заклинание'],
    ['readied-attack', 'Выполнить заготовленный удар'],
    ['opportunity-attack', 'Провести атаку по возможности'],
  ]) {
    const plan = choose(actionId, reason)
    if (plan) return plan
  }

  // Сохраняем старый порог для Uncanny Dodge и старый fallback для обычных
  // окон: новый planner лишь расширяет список, а не меняет прежнюю политику.
  const old = planHeroReaction(state, window)
  const command = old.commands[0]
  return command && validatesTacticCommand(state, actorIdValue, command)
    ? { command, reason: `Реакция: ${old.rule}` }
    : null
}

function actionResourceAvailable(state, actorIdValue, action) {
  if (!action?.resource) return true
  const resource = resourceFor(state, actorIdValue, action.resource)
  return Boolean(resource) && Number(resource.current) >= Math.max(1, Number(action.cost) || 1)
}

function spellSlotForTactics(state, actorIdValue, spell) {
  if (!spell || Number(spell.level) <= 0) return null
  if (spell.slotResource === 'pact_slots' || String(spell.slotResource ?? '').startsWith('species_spell_')) {
    const resource = resourceFor(state, actorIdValue, spell.slotResource)
    return resource?.current > 0 ? { resource: spell.slotResource, level: Math.max(Number(spell.level), Number(spell.innateCastLevel) || Number(spell.level)) } : null
  }
  const first = Math.max(1, Number(spell.level) || 1)
  for (let level = first; level <= 6; level += 1) {
    const resource = `spell_slots_${level}`
    if (Number(resourceFor(state, actorIdValue, resource)?.current) > 0) return { resource, level }
  }
  return null
}

function spellAvailableForTactics(state, actorIdValue, spell) {
  if (!spell || !COMBAT_POLICY_SUPPORT.has(spell.mechanicsSupport ?? '')) return null
  if (spell.prepared === false || !['action', 'bonus_action'].includes(spell.actionType)) return null
  return spellSlotForTactics(state, actorIdValue, spell)
}

function hasSpellCondition(state, actorIdValue, spell) {
  const conditions = new Set((spell?.conditions ?? []).map(String))
  if (!conditions.size) return false
  return [...conditions].some((condition) => conditionIdsForTactics(state, actorIdValue).has(condition))
}

function targetHasSpellCondition(state, targetIdValue, spell) {
  const conditions = new Set((spell?.conditions ?? []).map(String))
  if (!conditions.size) return false
  const targetConditions = conditionIdsForTactics(state, targetIdValue)
  return [...conditions].some((condition) => targetConditions.has(condition))
}

function commandWithTarget(actorIdValue, command) {
  return { ...command, actor_id: String(actorIdValue), server_authoritative: true }
}

function safeCell(state, position) {
  if (!position) return false
  const cell = (state?.scene?.cells ?? []).find((candidate) => Number(candidate?.x) === Number(position.x) && Number(candidate?.y) === Number(position.y))
  return Boolean(cell && cell.revealed !== false && cell.type !== 'wall')
}

function approximateAreaTargets(state, actorIdValue, spell, to) {
  const center = spell.target === 'self' ? combatPosition(state, actorIdValue) : to
  const radius = Math.max(0, Number(spell.radius) || 0)
  if (!center || radius <= 0) return { enemies: [], allies: [] }
  const inArea = (actor) => {
    const at = combatPosition(state, combatId(actor))
    return Boolean(at && Math.max(Math.abs(at.x - center.x), Math.abs(at.y - center.y)) * 5 <= radius)
  }
  return {
    enemies: enemiesForTactics(state).filter(inArea),
    // `spellTargetsAt` исключает заклинателя только из области вокруг себя.
    // Заклинание в выбранную точку может задеть его самого: это союзный огонь.
    allies: partyActorsForTactics(state).filter((ally) => (spell.target !== 'self' || combatId(ally) !== String(actorIdValue))
      && visibleLivingAlly(ally) && inArea(ally)),
  }
}

// Оценка для выбора тактики, а не расчёт урона: точный исход остаётся за
// Rules Engine. Не используем скрытую КД врага и не делаем пробных бросков.
function spellTacticalScore(actor, spell, slotLevel = spell.level, targets = 1) {
  const match = /^(\d+)d(\d+)([+-]\d+)?$/u.exec(String(spell.damage ?? ''))
  if (!match) return 220 + 100 * targets
  let average = Number(match[1]) * (Number(match[2]) + 1) / 2 + Number(match[3] || 0)
  if (spell.level === 0) average *= actor.level >= 11 ? 3 : actor.level >= 5 ? 2 : 1
  if (spell.projectileCount) average *= Number(spell.projectileCount) + Math.max(0, slotLevel - spell.level) * Number(spell.upcastProjectilesPerLevel || 0)
  const success = spell.automaticHit ? 1 : spell.halfOnSave ? .75 : .65
  return 500 + average * success * 30 * targets - Math.max(0, slotLevel) * 20
}

function spellCandidatesFor(state, actorIdValue, actor, add) {
  const economy = economyFor(state, actorIdValue)
  const enemies = enemiesForTactics(state)
  const allies = partyActorsForTactics(state)
  for (const spell of combatSpellsFor(actor)) {
    const slot = spellAvailableForTactics(state, actorIdValue, spell)
    if (spell.level > 0 && !slot) continue
    if (spell.concentration && state?.mechanics?.concentration?.[String(actorIdValue)]) continue
    if (hasSpellCondition(state, actorIdValue, spell)) continue
    const base = { command_type: 'CastSpell', actor_id: actorIdValue, spell_id: spell.id, server_authoritative: true, ...(slot ? { slot_level: slot.level } : {}) }
    const addSpell = (command, score, reason) => {
      const actionType = spell.actionType === 'bonus_action' ? 'bonus_action' : 'action'
      if (economy[actionType] === false) return
      if (validatesTacticCommand(state, actorIdValue, command)) add(command, score, reason)
    }
    if (HEALING_SPELL_KINDS.has(spell.kind) && spell.target !== 'point') {
      const targets = allies.filter((ally) => !isDeadHero(state, combatId(ally)) && (downedAlly(ally) || Number(ally.hp) <= Math.max(1, Math.floor(combatMaxHp(ally) * HEAL_THRESHOLD_RATIO))))
        .sort((left, right) => Number(left.hp) - Number(right.hp) || combatId(left).localeCompare(combatId(right)))
      for (const target of targets) {
        const command = { ...base, target_id: combatId(target), target_ids: [combatId(target)] }
        const score = downedAlly(target) ? 10_000 : 4_000
        addSpell(command, score, `${spell.name} спасает ${combatId(target)}`)
        break
      }
    }
    if (BUFF_SPELL_KINDS.has(spell.kind) && spell.target !== 'point') {
      const targets = allies.filter(visibleLivingAlly).filter((target) => combatDistance(state, actorIdValue, combatId(target)) <= Number(spell.range ?? 0))
      if (spell.target === 'self') {
        addSpell({ ...base, target_id: actorIdValue, target_ids: [actorIdValue] }, 180, `${spell.name} усиливает героя`)
      } else if (targets.length) {
        const maximum = Math.max(1, Number(spell.maxTargets) || 1)
        const selected = targets.filter((target) => !targetHasSpellCondition(state, combatId(target), spell)).slice(0, maximum)
        if (!selected.length) continue
        addSpell({ ...base, target_id: combatId(selected[0]), target_ids: selected.map(combatId) }, 180 + selected.length * 30, `${spell.name} поддерживает отряд`)
      }
    }
    if (DAMAGE_SPELL_KINDS.has(spell.kind)) {
      if (spell.target === 'point') {
        const points = enemies.map((enemy) => combatPosition(state, combatId(enemy))).filter(Boolean)
        for (const to of points) {
          const area = approximateAreaTargets(state, actorIdValue, spell, to)
          if (!safeCell(state, to) || !area.enemies.length || area.allies.length) continue
          if (combatDistanceToPosition(state, actorIdValue, to) > Number(spell.range ?? 0)) continue
          addSpell({ ...base, to }, spellTacticalScore(actor, spell, slot?.level, area.enemies.length), `${spell.name} поражает ${area.enemies.length} противников без союзного огня`)
          break
        }
      } else if (spell.target === 'self' && ['area-save', 'area-damage'].includes(spell.kind)) {
        const area = approximateAreaTargets(state, actorIdValue, spell, null)
        if (area.enemies.length && !area.allies.length) addSpell(base, spellTacticalScore(actor, spell, slot?.level, area.enemies.length), `${spell.name} поражает врагов рядом`)
      } else if (spell.target === 'enemy') {
        const targets = enemies.slice().sort((left, right) => combatDistance(state, actorIdValue, combatId(left)) - combatDistance(state, actorIdValue, combatId(right)) || combatId(left).localeCompare(combatId(right)))
        for (const target of targets) {
          if (combatDistance(state, actorIdValue, combatId(target)) > Number(spell.range ?? 0)) continue
          const command = { ...base, target_id: combatId(target), target_ids: [combatId(target)] }
          const inMelee = spell.kind === 'attack' && spell.attackKind !== 'melee' && enemies.some((enemy) => combatDistance(state, actorIdValue, combatId(enemy)) <= 5)
          addSpell(command, spellTacticalScore(actor, spell, slot?.level) - (inMelee ? 120 : 0), `${spell.name} атакует ${combatId(target)}`)
          break
        }
      }
    }
    // Некоторые классовые списки содержат verified summon/utility spells. Они
    // остаются кандидатами только при явно выбранной свободной клетке; без
    // полноценного summon-controller безопаснее пропустить их.
  }
}

function combatDistanceToPosition(state, actorIdValue, position) {
  const from = combatPosition(state, actorIdValue)
  return from && position ? Math.max(Math.abs(from.x - position.x), Math.abs(from.y - position.y)) * 5 : Number.MAX_SAFE_INTEGER
}

function movementCandidateFor(state, actorIdValue, targetIdValue, itemId = null) {
  const validationState = cloneForTacticValidation(state)
  const actor = findActor(validationState, actorIdValue)
  const from = combatPosition(validationState, actorIdValue)
  const to = combatPosition(validationState, targetIdValue)
  if (!actor || !from || !to) return null
  const path = shortestTacticalPath(validationState, actorIdValue, to, { allowOccupiedDestination: true })
  if (!path?.length) return null
  const economy = economyFor(validationState, actorIdValue)
  const budget = Math.max(0, Number(actor.speed) || 30) + Math.max(0, Number(economy.movement_bonus) || 0) - Math.max(0, Number(economy.movement_spent) || 0)
  let chosen = null
  let chosenCost = 0
  let spent = 0
  for (const step of path) {
    const stepCost = movementCostOfPath(validationState, actorIdValue, [step])
    if (spent + stepCost > budget) break
    spent += stepCost
    if (String(step.x) === String(to.x) && String(step.y) === String(to.y)) break
    const attackState = structuredClone(validationState)
    attackState.mechanics.positions[actorIdValue] = { x: step.x, y: step.y }
    const forecast = attackForecast(attackState, actorIdValue, targetIdValue, itemId ? { itemId } : {})
    if (forecast?.reachable ?? forecast?.in_range) {
      chosen = step
      chosenCost = spent
      break
    }
    chosen = step
    chosenCost = spent
  }
  if (!chosen || !validatesTacticCommand(state, actorIdValue, { command_type: 'MoveActor', actor_id: actorIdValue, to: chosen, server_authoritative: true })) return null
  return { command: { command_type: 'MoveActor', actor_id: actorIdValue, to: chosen, server_authoritative: true }, cost: chosenCost }
}

function addAttackCandidates(state, actorIdValue, actor, add) {
  const enemies = enemiesForTactics(state)
  const weapon = equippedWeapon(actor)
  const itemId = weapon ? String(weapon.id) : null
  const economy = economyFor(state, actorIdValue)
  for (const target of enemies) {
    const targetId = combatId(target)
    const forecast = attackForecast(state, actorIdValue, targetId, itemId ? { itemId } : {})
    const attack = commandWithTarget(actorIdValue, { command_type: 'MakeAttack', target_id: targetId, ...(itemId ? { item_id: itemId } : {}) })
    if ((forecast?.reachable ?? forecast?.in_range) && validatesTacticCommand(state, actorIdValue, attack)) {
      add(attack, 500 + Math.max(0, Number(forecast.average_damage) || 0) * 30 * (forecast.disadvantage ? .4 : forecast.advantage ? .85 : .65), `Атаковать ${targetId} доступным оружием`)
      continue
    }
    if (economy.action !== false || Number(economy.attacks_used) < Number(economy.attacks_allowed)) {
      let approach = null
      try {
        const preview = previewApproachAttack(cloneForTacticValidation(state), actorIdValue, targetId)
        const move = preview.commands.find((candidate) => candidate.command_type === 'MoveActor')
        if (move && validatesTacticCommand(state, actorIdValue, move)) approach = move
      } catch { /* проверка маршрута ниже даёт тот же отказ без броска */ }
      approach ??= movementCandidateFor(state, actorIdValue, targetId, itemId)?.command ?? null
      if (approach) add(approach, 260, `Подойти к ${targetId}, чтобы атаковать`)
    }
  }
}

function addActionCandidates(state, actorIdValue, actor, add) {
  const actions = combatActionsFor(actor).filter((action) => COMBAT_POLICY_SUPPORT.has(action.mechanicsSupport ?? '') && action.id !== 'extra-attack')
  const economy = economyFor(state, actorIdValue)
  const conditions = conditionIdsForTactics(state, actorIdValue)
  const enemies = enemiesForTactics(state)
  const allies = partyActorsForTactics(state)
  for (const action of actions) {
    if (!actionResourceAvailable(state, actorIdValue, action)) continue
    if (action.id === 'stand-up') continue
    if (action.id === 'second-wind') {
      const hp = combatHp(actor)
      if (hp != null && hp / combatMaxHp(actor) <= .35) add(commandWithTarget(actorIdValue, { command_type: 'UseCombatAction', action_id: action.id }), 3_500, 'Использовать «Второе дыхание» на тяжело раненного героя')
      continue
    }
    if (action.id === 'action-surge') {
      if (economy.action === false) add(commandWithTarget(actorIdValue, { command_type: 'UseCombatAction', action_id: action.id }), 190, 'Вернуть действие «Всплеском действий»')
      continue
    }
    if (['cunning-dash', 'expeditious-retreat-dash'].includes(action.id)) {
      if (action.id === 'expeditious-retreat-dash' && !conditions.has('expeditious-retreat')) continue
      const target = enemies.find((enemy) => combatDistance(state, actorIdValue, combatId(enemy)) > 5)
      if (target && economy.bonus_action !== false && movementCandidateFor(state, actorIdValue, combatId(target))) add(commandWithTarget(actorIdValue, { command_type: 'UseCombatAction', action_id: action.id }), 120, 'Получить дополнительное перемещение бонусным действием')
      continue
    }
    if (action.effect?.kind === 'heal') {
      const target = allies.filter((ally) => visibleLivingAlly(ally) && combatDistance(state, actorIdValue, combatId(ally)) <= Number(action.range ?? 0))
        .sort((left, right) => Number(left.hp) - Number(right.hp))[0]
      if (target && Number(target.hp) < combatMaxHp(target) * .35) add(commandWithTarget(actorIdValue, { command_type: 'UseCombatAction', action_id: action.id, target_id: combatId(target), target_ids: [combatId(target)] }), 2_500, `${action.name} лечит союзника`)
      continue
    }
    if (['stabilize', 'first-aid'].includes(action.id)) {
      const target = allies.find((ally) => downedAlly(ally) && combatDistance(state, actorIdValue, combatId(ally)) <= Number(action.range ?? 5))
      if (target) add(commandWithTarget(actorIdValue, { command_type: 'UseCombatAction', action_id: action.id, target_id: combatId(target), target_ids: [combatId(target)] }), 8_000, `${action.name} спасает лежащего союзника`)
      continue
    }
    if (['disengage', 'cunning-disengage'].includes(action.id)) {
      if (enemies.some((enemy) => combatDistance(state, actorIdValue, combatId(enemy)) <= 5) && !conditions.has('disengaged')) add(commandWithTarget(actorIdValue, { command_type: 'UseCombatAction', action_id: action.id }), 90, 'Выйти из досягаемости без атаки по возможности')
      continue
    }
    if (['break-free', 'steady-nerves', 'extinguish-self', 'search', 'hide', 'ready', 'ready-action'].includes(action.id)) continue
    if (action.id === 'reckless-attack' && conditions.has('reckless')) continue
    if (action.id === 'reckless-attack' && (Number(economy.attacks_used) > 0 || Number(actor.hp) < combatMaxHp(actor) / 2)) continue
    if (action.id === 'rage' && conditions.has('raging')) continue
    const target = action.target === 'self' ? null : action.target === 'ally'
      ? allies.filter(visibleLivingAlly).sort((left, right) => Number(left.hp) - Number(right.hp))[0]
      : enemies[0]
    if (action.target === 'enemy' && (!target || combatDistance(state, actorIdValue, combatId(target)) > Number(action.range ?? 5))) continue
    if (action.target === 'ally' && !target) continue
    if (action.target === 'self' && !['dash', 'dodge', 'rage', 'reckless-attack'].includes(action.id)) continue
    if (action.id === 'dash' && !enemies.some((enemy) => movementCandidateFor(state, actorIdValue, combatId(enemy)))) continue
    if (action.id === 'dodge' && !enemies.some((enemy) => combatDistance(state, actorIdValue, combatId(enemy)) <= 5)
      && Number(actor.hp) > combatMaxHp(actor) * .4) continue
    const command = commandWithTarget(actorIdValue, {
      command_type: 'UseCombatAction', action_id: action.id,
      ...(target ? { target_id: combatId(target), target_ids: [combatId(target)] } : {}),
      ...(action.requiresWeapon && equippedWeapon(actor) ? { item_id: String(equippedWeapon(actor).id) } : {}),
    })
    const score = action.id === 'rage' ? 900 : action.id === 'reckless-attack' ? 750 : action.effect?.kind === 'weapon_attack' ? 300 : 70
    if (validatesTacticCommand(state, actorIdValue, command)) add(command, score, `${action.name} — подходящая поддержанная тактика`)
  }
}

/**
 * Выбирает одну команду для автономного боевого шага.
 *
 * Команда намеренно не является планом из нескольких действий: после commit
 * вызывающий код должен снова передать свежую player-visible проекцию сюда.
 * Это сохраняет правду о реакции, потраченной экономике и скрытых HP врага.
 *
 * @param {Record<string, any>} state player-visible состояние кампании
 * @param {string} actorIdValue герой, которому принадлежит текущий шаг
 * @returns {{command: Record<string, any>, reason: string}}
 */
export function planHeroCombatCommand(state, actorIdValue) {
  const actorId = String(actorIdValue ?? '')
  const end = commandWithTarget(actorId, { command_type: 'EndTurn' })
  const reaction = state?.mechanics?.combat?.reaction_window
  if (reaction && String(reaction.actor_id) === actorId) {
    const planned = planExpandedCombatReaction(state, reaction)
    if (planned) return planned
    const fallback = planHeroReaction(state, reaction)
    return { command: fallback.commands[0] ?? end, reason: `Реакция: ${fallback.rule}` }
  }
  const actor = findActor(state, actorId)
  if (!actor || combatHp(actor) == null || combatHp(actor) <= 0) return { command: end, reason: 'Герой не может действовать и завершает ход' }
  const combat = state?.mechanics?.combat
  const current = combat?.initiative?.[Number(combat?.active_index)]?.actor_id
  if (!combat?.active || (current && String(current) !== actorId)) return { command: end, reason: 'Сейчас ход другого участника' }

  const economy = economyFor(state, actorId)
  const candidates = []
  const add = (command, score, reason) => {
    if (!command || !validatesTacticCommand(state, actorId, command)) return
    candidates.push({ command, score, reason })
  }
  const prone = conditionIdsForTactics(state, actorId).has('prone')
  if (prone && validatesTacticCommand(state, actorId, commandWithTarget(actorId, { command_type: 'UseCombatAction', action_id: 'stand-up' }))) {
    return { command: commandWithTarget(actorId, { command_type: 'UseCombatAction', action_id: 'stand-up' }), reason: 'Встать после падения перед следующим решением' }
  }
  const healing = healingItem(actor)
  const healTarget = healing ? healingTargetFor(state, actorId) : null
  if (healing && healTarget && (combatId(healTarget) === actorId || combatDistance(state, actorId, combatId(healTarget)) <= HEALING_RANGE_FEET)) {
    add(commandWithTarget(actorId, { command_type: 'UseItem', item_id: String(healing.id), target_id: combatId(healTarget) }), downedAlly(healTarget) ? 9_500 : 3_800, `Зелье лечения помогает ${combatId(healTarget)}`)
  } else if (healing && healTarget) {
    const approach = movementCandidateFor(state, actorId, combatId(healTarget))
    if (approach) add(approach.command, downedAlly(healTarget) ? 9_200 : 3_500, `Подойти к ${combatId(healTarget)} для лечения зельем`)
  }
  spellCandidatesFor(state, actorId, actor, add)
  addActionCandidates(state, actorId, actor, add)
  addAttackCandidates(state, actorId, actor, add)

  const best = candidates.sort((left, right) => right.score - left.score
    || String(left.command.command_type).localeCompare(String(right.command.command_type))
    || JSON.stringify(left.command).localeCompare(JSON.stringify(right.command)))[0]
  if (best) return { command: best.command, reason: best.reason }

  const target = enemiesForTactics(state).sort((left, right) => combatDistance(state, actorId, combatId(left)) - combatDistance(state, actorId, combatId(right)) || combatId(left).localeCompare(combatId(right)))[0]
  if (target && economy.action !== false) {
    const movement = movementCandidateFor(state, actorId, combatId(target))
    if (movement) return { command: movement.command, reason: `Сблизиться с ${combatId(target)} по доступному маршруту` }
  }
  return { command: end, reason: 'Нет безопасной поддержанной команды; завершить ход' }
}

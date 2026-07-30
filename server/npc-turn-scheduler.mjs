import {
  RulesValidationError,
  actorPosition,
  attackProfileFor,
  findActor,
  hasClearTrajectory,
  incapacitatingConditionFor,
  initiativeGroupIds,
  isEnemyActor,
  isLivingActor,
  movementStepCostFor,
  normalizeCampaignState,
  shortestTacticalPath,
} from './rules-engine.mjs'
import { isPartySummon } from './combat-spells.mjs'
import { commandsForMoraleDecision, isMoraleMoment } from './npc-controller.mjs'

const CELL_FEET = 5

/**
 * Словарь повадок: имя черты на стат-блоке → политика, которая её исполняет.
 * Ветки с именем конкретного существа здесь запрещены — новое существо с уже
 * описанной повадкой заводится правкой одного каталога.
 *
 * Исполняются в разных слоях, и это осознанно: `multiattack`, `keep-distance` и
 * `relentless-pursuit` меняют **план хода** и живут здесь; `charge` и
 * `bloodied-frenzy` меняют **разрешение удара** (рывок, преимущество раненого) и
 * живут в `server/rules-engine.mjs`. Словарь один на оба слоя, чтобы список
 * поддержанных повадок нельзя было прочитать в двух местах по-разному.
 */
export const NPC_BEHAVIOR_POLICIES = Object.freeze({
  multiattack: 'multiattack',
  keepDistance: 'keep-distance',
  charge: 'charge',
  bloodiedFrenzy: 'bloodied-frenzy',
  relentlessPursuit: 'relentless-pursuit',
})

function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

function livingParty(state) {
  const members = new Set(state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map(actorId))
  const heroes = state.players.filter((actor) => members.has(actorId(actor)) && isCombatCapable(state, actor))
  const summons = (state.actors ?? []).filter((actor) => isPartySummon(actor) && members.has(String(actor.ownerId ?? actor.owner_id)) && isCombatCapable(state, actor))
  return [...heroes, ...summons]
}

function unstableDyingParty(state) {
  const members = new Set(state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map(actorId))
  return state.players.filter((actor) => {
    const id = actorId(actor)
    const tracker = state.mechanics?.death?.saving_throws?.[id]
    return members.has(id)
      && Number(actor.hp) === 0
      && state.mechanics?.death?.heroes?.[id]?.status !== 'dead'
      && tracker?.stable !== true
  })
}

function stableUnconsciousParty(state) {
  const members = new Set(state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map(actorId))
  return state.players.filter((actor) => {
    const id = actorId(actor)
    const tracker = state.mechanics?.death?.saving_throws?.[id]
    return members.has(id)
      && Number(actor.hp) === 0
      && state.mechanics?.death?.heroes?.[id]?.status !== 'dead'
      && tracker?.stable === true
  })
}

function livingEnemies(state) {
  const encounterIds = new Set(Array.isArray(state.mechanics?.encounter?.enemy_ids)
    ? state.mechanics.encounter.enemy_ids.map(String)
    : [])
  return state.enemies.filter((enemy) => isCombatCapable(state, enemy) && (!encounterIds.size || encounterIds.has(actorId(enemy))))
}

function gridDistance(left, right) {
  const a = actorPosition(left.state, left.id)
  const b = actorPosition(right.state, right.id)
  return a && b ? Math.abs(a.x - b.x) + Math.abs(a.y - b.y) : Number.MAX_SAFE_INTEGER
}

function conditionIds(state, id) {
  return new Set((state.mechanics?.conditions?.[String(id)] ?? []).map((condition) => String(condition?.id ?? condition)))
}

function isCombatCapable(state, actor) {
  if (!isLivingActor(actor)) return false
  const id = actorId(actor)
  return state.mechanics?.resting?.[id]?.reason !== 'knockout' && !conditionIds(state, id).has('unconscious')
}

function traitFor(actor, id) {
  const trait = (Array.isArray(actor?.traits) ? actor.traits : []).find((candidate) => String(candidate?.id ?? candidate) === id)
  return trait && typeof trait === 'object' ? trait : trait ? { id } : null
}

function hasTrait(actor, id) {
  return Boolean(traitFor(actor, id))
}

function actionProfiles(state, enemy) {
  const explicit = Array.isArray(enemy?.action_profiles) ? enemy.action_profiles : []
  const spent = conditionIds(state, actorId(enemy))
  const economy = state.mechanics?.combat?.action_economy?.[actorId(enemy)] ?? {}
  const attacksUsed = Math.max(0, Number(economy.attacks_used) || 0)
  const multiattack = traitFor(enemy, NPC_BEHAVIOR_POLICIES.multiattack)
  const actionCounts = multiattackActionCounts(multiattack)
  const usedActionIds = Array.isArray(economy.multiattack_action_ids)
    ? economy.multiattack_action_ids.map(String)
    : attacksUsed > 0 && economy.multiattack_action_id
      ? [String(economy.multiattack_action_id)]
      : []
  const fixedSequence = Array.isArray(multiattack?.sequence)
    ? multiattack.sequence.map(String).filter(Boolean)
    : []
  const requiredActionId = multiattack?.same_action === true && attacksUsed > 0
    ? String(economy.multiattack_action_id ?? '') || null
    : fixedSequence[attacksUsed] ?? null
  const available = explicit.filter((action) => !(Number(action?.uses) > 0 && spent.has(`monster-action-used:${action.id}`))
    && (!requiredActionId || String(action?.id ?? '') === requiredActionId)
    && (!actionCounts.size || usedActionIds.filter((id) => id === String(action?.id ?? '')).length < (actionCounts.get(String(action?.id ?? '')) ?? 0)))
  if (available.length) return available.map((action) => attackProfileFor(state, actorId(enemy), action.id)).filter(Boolean)
  const fallback = attackProfileFor(state, actorId(enemy))
  return fallback ? [fallback] : []
}

function inAttackRange(state, attackerId, targetId, profile = attackProfileFor(state, attackerId), from = actorPosition(state, attackerId)) {
  const attacker = actorPosition(state, attackerId)
  const target = actorPosition(state, targetId)
  const origin = from ?? attacker
  if (!origin || !target || !profile) return false
  const distance = Math.max(Math.abs(origin.x - target.x), Math.abs(origin.y - target.y)) * CELL_FEET
  return distance >= CELL_FEET && distance <= profile.range_feet && (profile.range_feet <= CELL_FEET || hasClearTrajectory(state, origin, target))
}

function averageDamage(expression, flat = 0) {
  const match = String(expression ?? '').match(/^(\d+)d(\d+)([+-]\d+)?$/u)
  if (!match) return Math.max(0, Number(flat) || 0)
  return Number(match[1]) * (Number(match[2]) + 1) / 2 + Number(match[3] || 0)
}

function adjacentEnemyAlly(state, enemy, target) {
  const targetAt = actorPosition(state, actorId(target))
  return targetAt && livingEnemies(state).some((ally) => actorId(ally) !== actorId(enemy) && (() => {
    const at = actorPosition(state, actorId(ally))
    return at && Math.max(Math.abs(at.x - targetAt.x), Math.abs(at.y - targetAt.y)) === 1
  })())
}

function adjacentPartyMember(state, enemy) {
  const enemyAt = actorPosition(state, actorId(enemy))
  return Boolean(enemyAt && livingParty(state).some((member) => {
    const at = actorPosition(state, actorId(member))
    return at && Math.max(Math.abs(at.x - enemyAt.x), Math.abs(at.y - enemyAt.y)) === 1
  }))
}

/**
 * Может ли кто-то из отряда дойти до стрелка и ударить его **на своём ближайшем
 * ходу**. Это условие «держать дистанцию»: без него стрелок пятился каждый ход
 * даже там, где ему ничто не угрожало — уходил от своих, терял тактику стаи и
 * упирался в край карты, ничего этим не выигрывая.
 *
 * Порог намеренно щедрый — вся скорость плюс клетка досягаемости: лучше отойти
 * на ход раньше, чем позволить себя достать.
 */
function meleeThreatWithinReach(state, enemy) {
  const enemyAt = actorPosition(state, actorId(enemy))
  if (!enemyAt) return false
  return livingParty(state).some((member) => {
    const at = actorPosition(state, actorId(member))
    if (!at) return false
    const feet = Math.max(Math.abs(at.x - enemyAt.x), Math.abs(at.y - enemyAt.y)) * CELL_FEET
    const speed = Math.max(0, Number(member.speed) || 30)
    return feet <= speed + CELL_FEET
  })
}

function targetCandidates(state, enemy) {
  const enemyAt = actorPosition(state, actorId(enemy))
  const profiles = actionProfiles(state, enemy)
  const candidates = []
  for (const target of livingParty(state)) {
    const targetAt = actorPosition(state, actorId(target))
    const path = shortestTacticalPath(state, actorId(enemy), targetAt, { allowOccupiedDestination: true })
    const pathDistance = path ? path.length : gridDistance({ state, id: actorId(enemy) }, { state, id: actorId(target) })
    const support = adjacentEnemyAlly(state, enemy, target)
    for (const profile of profiles) {
      const inRange = inAttackRange(state, actorId(enemy), actorId(target), profile)
      const damage = averageDamage(profile.damage_expression, profile.damage_amount)
      const targetHp = Math.max(1, Number(target.hp) || 1)
      const targetArmor = Math.max(0, Number(target.armor) || 10)
      const alreadyControlled = profile.on_hit?.condition && conditionIds(state, actorId(target)).has(String(profile.on_hit.condition))
      const controlValue = profile.on_hit?.condition && !alreadyControlled ? 80 + Number(profile.tactical_priority || 0) * 10 : 0
      const packValue = support && (hasTrait(enemy, 'pack-tactics') || hasTrait(enemy, 'martial-advantage')) ? 90 : 0
      const rangedAtMeleePenalty = profile.kind === 'ranged' && enemyAt && targetAt && Math.max(Math.abs(enemyAt.x - targetAt.x), Math.abs(enemyAt.y - targetAt.y)) === 1 ? 70 : 0
      const relentlessPursuit = hasTrait(enemy, NPC_BEHAVIOR_POLICIES.relentlessPursuit)
      const score = Number(inRange) * 1_000 + Number(Boolean(path)) * 400 + Math.min(300, damage * 12)
        + (relentlessPursuit
          ? Math.max(0, 800 - pathDistance * 80)
          : damage >= targetHp ? 260 : Math.round((1 - targetHp / Math.max(targetHp, Number(target.maxHp) || targetHp)) * 100))
        + (relentlessPursuit ? 0 : Math.max(0, 22 - targetArmor) * 4 + controlValue + packValue)
        - pathDistance * 3 - rangedAtMeleePenalty
      candidates.push({ actor: target, path, inRange, distance: pathDistance, profile, score })
    }
  }
  return candidates.sort((left, right) => right.score - left.score
    || Number(right.inRange) - Number(left.inRange)
    || left.distance - right.distance
    || actorId(left.actor).localeCompare(actorId(right.actor))
    || String(left.profile.id ?? '').localeCompare(String(right.profile.id ?? '')))
}

/**
 * Самый длинный отрезок маршрута, который существо оплатит из оставшейся
 * скорости. Маршрут приходит от невзвешенного поиска, поэтому его цена — верхняя
 * оценка: авторитетный `MoveActor` ищет дешевейший путь и возьмёт не больше.
 */
function affordablePathPrefix(state, actorIdValue, path, maximumSteps, budgetFeet) {
  const { stepCost } = movementStepCostFor(state, String(actorIdValue))
  const limit = Math.min(Math.max(0, maximumSteps), Array.isArray(path) ? path.length : 0)
  let steps = 0
  let costFeet = 0
  for (let index = 0; index < limit; index += 1) {
    const next = costFeet + stepCost(path[index])
    if (next > budgetFeet) break
    costFeet = next
    steps = index + 1
  }
  return { steps, costFeet }
}

function retreatDestination(state, enemy, target, profile) {
  const from = actorPosition(state, actorId(enemy))
  const targetAt = actorPosition(state, actorId(target))
  if (!from || !targetAt) return null
  const movementSpent = Math.max(0, Number(state.mechanics?.combat?.action_economy?.[actorId(enemy)]?.movement_spent) || 0)
  const budgetFeet = (Number(enemy.speed) || 30) - movementSpent
  const maximumSteps = Math.max(0, Math.floor(budgetFeet / CELL_FEET))
  if (!maximumSteps) return null
  const { stepCost } = movementStepCostFor(state, actorId(enemy))
  let best = null
  for (const cell of state.scene?.cells ?? []) {
    if (!cell.revealed || !['floor', 'door'].includes(cell.type)) continue
    const path = shortestTacticalPath(state, actorId(enemy), { x: Number(cell.x), y: Number(cell.y) })
    if (!path?.length || path.length > maximumSteps) continue
    // Отступление тоже платит за местность. Кандидаты по-прежнему ищутся
    // невзвешенно — их тут перебирается вся сцена, — но цена выбранного
    // маршрута проверяется той же формулой, что применит `MoveActor`.
    if (path.reduce((total, step) => total + stepCost(step), 0) > budgetFeet) continue
    const destination = path.at(-1)
    const distance = Math.max(Math.abs(destination.x - targetAt.x), Math.abs(destination.y - targetAt.y)) * CELL_FEET
    if (distance > profile.range_feet || distance < CELL_FEET || !hasClearTrajectory(state, destination, targetAt)) continue
    const score = Math.min(distance, profile.normal_range_feet) * 10 + path.length
    if (!best
      || score > best.score
      || score === best.score && (destination.x < best.destination.x
        || destination.x === best.destination.x && destination.y < best.destination.y)) {
      best = { score, destination }
    }
  }
  return best?.destination ?? null
}

function multiattackActionCounts(multiattack) {
  if (!multiattack?.action_counts || typeof multiattack.action_counts !== 'object' || Array.isArray(multiattack.action_counts)) return new Map()
  return new Map(Object.entries(multiattack.action_counts)
    .map(([id, count]) => [String(id), Math.max(0, Math.min(8, Number(count) || 0))])
    .filter(([id, count]) => id && count > 0)
    .sort(([left], [right]) => left.localeCompare(right)))
}

function multiattackActionIds(enemy, selectedProfile) {
  const multiattack = traitFor(enemy, NPC_BEHAVIOR_POLICIES.multiattack)
  if (!multiattack) return selectedProfile?.id ? [String(selectedProfile.id)] : []
  const actionCounts = multiattackActionCounts(multiattack)
  if (actionCounts.size) return [...actionCounts].flatMap(([id, count]) => Array.from({ length: count }, () => id))
  const sequence = Array.isArray(multiattack.sequence)
    ? multiattack.sequence.map(String).filter(Boolean)
    : []
  if (sequence.length) return sequence
  const count = Math.max(1, Math.min(8, Number(multiattack.attacks) || 1))
  const actionId = String(multiattack.action_id ?? selectedProfile?.id ?? '')
  return actionId ? Array.from({ length: count }, () => actionId) : []
}

function multiattackCount(enemy) {
  const multiattack = traitFor(enemy, NPC_BEHAVIOR_POLICIES.multiattack)
  if (!multiattack) return 1
  const actionCount = [...multiattackActionCounts(multiattack).values()].reduce((sum, count) => sum + count, 0)
  if (actionCount) return Math.min(8, actionCount)
  const sequence = Array.isArray(multiattack.sequence)
    ? multiattack.sequence.map(String).filter(Boolean)
    : []
  return sequence.length || Math.max(1, Math.min(8, Number(multiattack.attacks) || 1))
}

function attackCommands(state, enemy, targetId, selectedProfile) {
  const sequence = multiattackActionIds(enemy, selectedProfile)
  const actionCounts = multiattackActionCounts(traitFor(enemy, NPC_BEHAVIOR_POLICIES.multiattack))
  const attacksUsed = Math.max(0, Number(state.mechanics?.combat?.action_economy?.[actorId(enemy)]?.attacks_used) || 0)
  const actionId = actionCounts.size ? selectedProfile?.id ?? null : sequence[attacksUsed] ?? selectedProfile?.id ?? null
  const attackCount = multiattackCount(enemy)
  return [{
    command_type: 'MakeAttack',
    actor_id: actorId(enemy),
    target_id: String(targetId),
    ...(actionId ? { action_id: String(actionId) } : {}),
    ...(attackCount > 1 ? {
      monster_ability: 'multiattack',
      multiattack_index: attacksUsed + 1,
      multiattack_count: attackCount,
    } : {}),
  }]
}

/**
 * Публичная причина детерминированного выбора называет только видимые на поле
 * факты: перемещение, раненую цель, контроль от действия или поддержку союзника.
 * Числовая оценка, скрытая КД и внутренние параметры существа наружу не выходят.
 */
function publicTacticFor(state, enemy, candidate, commands = []) {
  if (!candidate) return null
  const targetId = actorId(candidate.actor)
  const profile = candidate.profile
  const supported = adjacentEnemyAlly(state, enemy, candidate.actor)
  const packTactics = supported && (hasTrait(enemy, 'pack-tactics') || hasTrait(enemy, 'martial-advantage'))
  const targetHp = Math.max(0, Number(candidate.actor?.hp) || 0)
  const targetMaximum = Math.max(1, Number(candidate.actor?.maxHp) || targetHp || 1)
  const targetWounded = targetHp > 0 && targetHp <= targetMaximum / 2
  const condition = String(profile?.on_hit?.condition ?? '')
  const alreadyControlled = condition && conditionIds(state, targetId).has(condition)
  const retreat = commands.some((command) => command.command_type === 'MoveActor')
    && commands.some((command) => ['keep-distance', 'nimble-escape'].includes(String(command.monster_ability ?? '')))
  const tactic = retreat
    ? 'держит дистанцию'
    : packTactics
      ? 'тактика стаи'
      : condition && !alreadyControlled
        ? 'пытается сковать цель'
        : targetWounded
          ? 'давит на раненого'
          : candidate.inRange
            ? profile?.kind === 'ranged' ? 'держит линию огня' : 'атакует доступную цель'
            : profile?.kind === 'ranged' ? 'выходит на линию атаки' : 'сокращает дистанцию'
  return {
    tactic,
    target_id: targetId,
  }
}

export function planNpcTurn(rawState, enemyId) {
  const state = normalizeCampaignState(rawState)
  const enemy = findActor(state, enemyId)
  if (!enemy || !isEnemyActor(state, enemyId) || !isCombatCapable(state, enemy)) return [{ command_type: 'EndTurn', actor_id: String(enemyId) }]
  // Surprised, stunned or paralysed enemies still hold their place in the
  // initiative, but the Rules Engine refuses every command except ending the
  // turn — so the scheduler must not propose one.
  if (incapacitatingConditionFor(state, enemyId)) return [{ command_type: 'EndTurn', actor_id: String(enemyId) }]
  const currentEconomy = state.mechanics?.combat?.action_economy?.[String(enemyId)] ?? {}
  const usedBeforePlan = Math.max(0, Number(currentEconomy.attacks_used) || 0)
  const declaredMultiattackCount = multiattackCount(enemy)
  if (currentEconomy.action === false
    && declaredMultiattackCount > 1
    && (usedBeforePlan === 0 || usedBeforePlan >= declaredMultiattackCount)) {
    return [{ command_type: 'EndTurn', actor_id: String(enemyId) }]
  }
  const candidate = targetCandidates(state, enemy)[0]
  if (!candidate) return [{ command_type: 'EndTurn', actor_id: String(enemyId) }]
  const targetId = actorId(candidate.actor)
  const commands = []
  const profile = candidate.profile
  const enemyAt = actorPosition(state, enemyId)
  const targetAt = actorPosition(state, targetId)
  const adjacent = enemyAt && targetAt && Math.max(Math.abs(enemyAt.x - targetAt.x), Math.abs(enemyAt.y - targetAt.y)) === 1
  let movementOnlyPhase = false
  let plannedMovementFeet = 0
  let plannedPosition = null
  if (candidate.inRange
    && profile.kind === 'ranged'
    && hasTrait(enemy, NPC_BEHAVIOR_POLICIES.keepDistance)
    && !adjacentPartyMember(state, enemy)
    && meleeThreatWithinReach(state, enemy)) {
    const retreat = retreatDestination(state, enemy, candidate.actor, profile)
    if (retreat) {
      commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: retreat, monster_ability: 'keep-distance' })
      commands.push(...attackCommands(state, enemy, targetId, profile))
    } else {
      commands.push(...attackCommands(state, enemy, targetId, profile))
    }
  } else if (candidate.inRange && profile.kind === 'ranged' && hasTrait(enemy, NPC_BEHAVIOR_POLICIES.keepDistance) && adjacent && !hasTrait(enemy, 'nimble-escape')) {
    const retreat = retreatDestination(state, enemy, candidate.actor, profile)
    if (retreat) {
      commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: retreat, monster_ability: 'keep-distance' })
      movementOnlyPhase = true
    } else {
      commands.push(...attackCommands(state, enemy, targetId, profile))
    }
  } else if (candidate.inRange && profile.kind === 'ranged' && adjacent && hasTrait(enemy, 'nimble-escape')) {
    const retreat = retreatDestination(state, enemy, candidate.actor, profile)
    if (retreat) {
      commands.push({ command_type: 'AddCondition', actor_id: String(enemyId), target_id: String(enemyId), condition: 'disengaged', duration: 'until-own-turn-end', monster_ability: 'nimble-escape' })
      commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: retreat })
      commands.push(...attackCommands(state, enemy, targetId, profile))
    }
  } else if (!candidate.inRange && candidate.path?.length) {
    const rangeCells = Math.max(1, Math.floor((profile?.range_feet ?? CELL_FEET) / CELL_FEET))
    const speed = Number(enemy.speed)
    const speedFeet = Number.isFinite(speed) ? speed : 30
    const actionEconomy = state.mechanics?.combat?.action_economy?.[String(enemyId)] ?? {}
    const movementSpent = Math.max(0, Number(actionEconomy.movement_spent) || 0)
    const aggressiveAvailable = hasTrait(enemy, 'aggressive') && actionEconomy.bonus_action !== false
    // Бюджет считается в футах по той же формуле, что и у `MoveActor`: трудная
    // местность и ползание дороже шага. Планировать «по клеткам» значило бы
    // выбрать цель, на которую у существа не хватит скорости, — и весь ход NPC
    // упал бы в SPEED_EXCEEDED уже на собственном плане.
    const approachSteps = Math.max(0, candidate.path.length - rangeCells)
    const affordable = affordablePathPrefix(state, enemyId, candidate.path, approachSteps, speedFeet - movementSpent)
    const needsAggressive = aggressiveAvailable && affordable.steps < approachSteps
    const reach = needsAggressive
      ? affordablePathPrefix(state, enemyId, candidate.path, approachSteps, speedFeet * 2 - movementSpent)
      : affordable
    if (reach.steps > 0) {
      plannedMovementFeet = reach.costFeet
      plannedPosition = candidate.path[reach.steps - 1]
      commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: plannedPosition, ...(needsAggressive ? { monster_ability: 'aggressive' } : {}) })
    }
    const steps = reach.steps
    const destination = steps > 0 ? candidate.path[steps - 1] : actorPosition(state, enemyId)
    const distanceAfterMove = destination && targetAt
      ? Math.max(Math.abs(destination.x - targetAt.x), Math.abs(destination.y - targetAt.y)) * CELL_FEET
      : Number.MAX_SAFE_INTEGER
    if (profile && distanceAfterMove >= CELL_FEET && distanceAfterMove <= profile.range_feet && (profile.range_feet <= CELL_FEET || hasClearTrajectory(state, destination, targetAt))) {
      commands.push(...attackCommands(state, enemy, targetId, profile))
    }
  } else if (candidate.inRange) {
    commands.push(...attackCommands(state, enemy, targetId, profile))
  }
  const attackPlanned = commands.some((command) => command.command_type === 'MakeAttack')
  const attacksAllowed = multiattackCount(enemy)
  if (attackPlanned
    && profile.kind === 'melee'
    && attacksAllowed <= 1
    && hasTrait(enemy, 'nimble-escape')
    && currentEconomy.bonus_action !== false) {
    const retreatState = plannedPosition ? normalizeCampaignState(state) : state
    if (plannedPosition) {
      retreatState.mechanics.positions[String(enemyId)] = { ...plannedPosition }
      const retreatEnemy = findActor(retreatState, enemyId)
      if (retreatEnemy) {
        retreatEnemy.x = plannedPosition.x
        retreatEnemy.y = plannedPosition.y
      }
      retreatState.mechanics.combat.action_economy[String(enemyId)] = {
        ...retreatState.mechanics.combat.action_economy[String(enemyId)],
        movement_spent: Math.max(0, Number(currentEconomy.movement_spent) || 0) + plannedMovementFeet,
      }
    }
    const retreatEnemy = findActor(retreatState, enemyId) ?? enemy
    const retreat = retreatDestination(retreatState, retreatEnemy, candidate.actor, {
      ...profile,
      range_feet: 10_000,
      normal_range_feet: 10_000,
    })
    if (retreat) {
      commands.push({
        command_type: 'AddCondition',
        actor_id: String(enemyId),
        target_id: String(enemyId),
        condition: 'disengaged',
        duration: 'until-own-turn-end',
        monster_ability: 'nimble-escape',
      })
      commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: retreat })
    }
  }
  if (!movementOnlyPhase && (!attackPlanned || attacksAllowed <= 1)) {
    commands.push({ command_type: 'EndTurn', actor_id: String(enemyId) })
  }
  return commands
}

function keyPart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'none'
}

function schedulerKey(campaignId, combat, actorIdValue, suffix = 'turn') {
  return `npc:${keyPart(campaignId)}:r${combat.round}:i${combat.active_index}:${keyPart(actorIdValue)}:${suffix}`
}

async function commitPlan({ campaignId, eventStore, rulesEngine, loaded, commands, key }) {
  const plan = {
    proposed_commands: commands.map((command, index) => ({
      ...command,
      server_authoritative: true,
      campaign_id: campaignId,
      command_id: `${key}:${index + 1}`,
    })),
  }
  const resolved = rulesEngine.resolvePlan(plan, loaded.state, { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true })
  if (!resolved.events.length) throw new RulesValidationError('NPC turn produced no events', 'NPC_TURN_EMPTY')
  const committed = await eventStore.commit({
    campaign_id: campaignId,
    expected_state_version: loaded.state_version,
    idempotency_key: key,
    command_id: key,
    events: resolved.events,
  })
  return { committed, resolved }
}

/**
 * Advances only server-owned actors. Ordinary tactics are deterministic. A
 * bounded creative controller may be consulted once when an enemy reaches a
 * morale threshold; the server converts its intent into validated commands.
 */
export async function runNpcTurnScheduler({
  campaignId,
  eventStore,
  rulesEngine,
  npcController = null,
  advanceNpc = true,
  // Один ход существа больше не равен одной итерации: multiattack выпускается
  // отдельными commit-фазами (до восьми атак плюс перемещение), поэтому прежние
  // 64 съедались втрое быстрее и крупная встреча могла упереться в предел на
  // ровном месте. Предел остаётся страховкой от зацикливания, а не бюджетом боя.
  maxTurns = 160,
} = {}) {
  if (!campaignId || !eventStore || !rulesEngine) throw new TypeError('NPC scheduler requires campaignId, eventStore and rulesEngine')
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 256) throw new RangeError('maxTurns must be between 1 and 256')
  let loaded = await eventStore.load(campaignId)
  const turns = []
  const events = []
  for (let iteration = 0; iteration < maxTurns; iteration += 1) {
    const state = normalizeCampaignState(loaded.state)
    const combat = state.mechanics.combat
    if (!combat.active) {
      const stable = stableUnconsciousParty(state)
      const lastCombatEnd = [...(state.battleLog ?? [])].reverse().find((entry) => entry?.type === 'combat-end')
      if (!livingParty(state).length && stable.length && lastCombatEnd?.reason === 'enemies_defeated') {
        const key = `npc:${keyPart(campaignId)}:stable-recovery:v${loaded.state_version}`
        const { committed } = await commitPlan({
          campaignId, eventStore, rulesEngine, loaded, key,
          commands: [{ command_type: 'AdvanceTime', amount: 60, unit: 'minute' }],
        })
        events.push(...committed.events)
        turns.push({
          actor_id: stable.map(actorId).join(','),
          kind: 'stable-recovery',
          elapsed_minutes: 60,
          idempotency_key: key,
          state_version: committed.state_version,
        })
        loaded = await eventStore.load(campaignId)
        continue
      }
      return { state, state_version: loaded.state_version, turns, events }
    }
    if (combat.reaction_window) return { state, state_version: loaded.state_version, turns, events }
    const completed = new Set((combat.turn_completed ?? []).map(String))
    const currentId = String(
      (initiativeGroupIds(state).find((id) => !completed.has(String(id)))
        ?? combat.initiative[combat.active_index]?.actor_id)
      ?? '',
    )
    const party = livingParty(state)
    const enemies = livingEnemies(state)
    const dying = unstableDyingParty(state)
    if ((!party.length || !enemies.length) && !dying.length) {
      const reason = enemies.length
        ? state.mechanics?.death?.campaign_status === 'party_defeated' ? 'party_defeated' : 'party_incapacitated'
        : 'enemies_defeated'
      const key = schedulerKey(campaignId, combat, currentId || party[0]?.id || enemies[0]?.id, `end-${reason}`)
      const actor = findActor(state, currentId) ?? party[0] ?? enemies[0]
      if (!actor) throw new RulesValidationError('Combat has no actor that can close it', 'INVALID_COMBAT_STATE')
      const { committed } = await commitPlan({
        campaignId, eventStore, rulesEngine, loaded, key,
        commands: [{ command_type: 'EndCombat', actor_id: actorId(actor), reason }],
      })
      events.push(...committed.events)
      turns.push({ actor_id: actorId(actor), round: combat.round, active_index: combat.active_index, kind: 'combat-end', reason, idempotency_key: key, state_version: committed.state_version })
      loaded = await eventStore.load(campaignId)
      continue
    }
    const current = findActor(state, currentId)
    if (current && isCombatCapable(state, current) && !isEnemyActor(state, currentId)) {
      return { state: loaded.state, state_version: loaded.state_version, turns, events }
    }
    if (current && isCombatCapable(state, current) && isEnemyActor(state, currentId) && !advanceNpc) {
      return { state: loaded.state, state_version: loaded.state_version, turns, events }
    }
    if (!current) throw new RulesValidationError('Initiative references an unknown actor', 'INVALID_COMBAT_STATE')
    const ordinaryEnemy = current && isCombatCapable(state, current) && isEnemyActor(state, currentId)
    const ordinaryCommands = ordinaryEnemy
      ? planNpcTurn(state, currentId)
      : [{ command_type: 'EndTurn', actor_id: currentId }]
    const ordinaryTactic = ordinaryEnemy
      ? publicTacticFor(state, current, targetCandidates(state, current)[0], ordinaryCommands)
      : null
    const creativeDecision = npcController && isMoraleMoment(state, currentId)
      ? await npcController.decide({ state, enemyId: currentId })
      : null
    const commands = creativeDecision
      ? commandsForMoraleDecision(state, currentId, creativeDecision, ordinaryCommands)
      : ordinaryCommands
    const actionEconomy = state.mechanics?.combat?.action_economy?.[currentId] ?? {}
    const attackPhase = Math.max(0, Number(actionEconomy.attacks_used) || 0)
    const movementPhase = Math.max(0, Number(actionEconomy.movement_spent) || 0)
    const actionSpentPhase = actionEconomy.action === false ? 1 : 0
    const suffix = creativeDecision ? `morale-${creativeDecision.disposition}` : isCombatCapable(state, current) ? `turn-a${attackPhase}-m${movementPhase}-s${actionSpentPhase}` : 'skip'
    const key = schedulerKey(campaignId, combat, currentId, suffix)
    const { committed } = await commitPlan({ campaignId, eventStore, rulesEngine, loaded, commands, key })
    events.push(...committed.events)
    turns.push({
      actor_id: currentId,
      round: combat.round,
      active_index: combat.active_index,
      kind: isCombatCapable(state, current) ? 'enemy-turn' : 'skipped-defeated',
      commands: commands.map((command) => command.command_type),
      creative_decision: creativeDecision ? {
        disposition: creativeDecision.disposition,
        reaction: creativeDecision.reaction,
        provider: creativeDecision.provider,
      } : null,
      ...(creativeDecision ? {
        tactic: creativeDecision.disposition === 'surrender' ? 'слом морали' : 'пытается спастись',
      } : ordinaryTactic ?? {}),
      idempotency_key: key,
      state_version: committed.state_version,
    })
    loaded = await eventStore.load(campaignId)
  }
  throw new RulesValidationError(`NPC scheduler exceeded ${maxTurns} turns`, 'NPC_TURN_LIMIT')
}

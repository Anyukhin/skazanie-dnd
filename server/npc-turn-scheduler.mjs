import { AuthoritativeExecutor } from './authoritative-executor.mjs'
import {
  RulesValidationError,
  actorPosition,
  attackProfileFor,
  coverBetween,
  findActor,
  hasClearTrajectory,
  highGroundBetween,
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
import { truceHolds } from './parley.mjs'

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
  // `uses` и `recharge` тратятся одним маркером, поэтому и отсеиваются одинаково:
  // разряженное дыхание не должно попадать в кандидаты — движок всё равно
  // ответит `MONSTER_ACTION_SPENT`, и ход существа пропал бы впустую.
  const available = explicit.filter((action) => !((Number(action?.uses) > 0 || Number(action?.recharge) > 0) && spent.has(`monster-action-used:${action.id}`))
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

/**
 * Тактическая геометрия целиком взята из движка: `coverBetween` и
 * `highGroundBetween` — те же функции, которыми считается настоящий бросок.
 * Планировщик не повторяет их вычислений, иначе NPC целился бы по одной карте
 * укрытий, а попадал по другой.
 */
const COVER_TARGET_PENALTY = Object.freeze({ none: 0, half: 70, 'three-quarters': 160 })
const OWN_COVER_BONUS = Object.freeze({ none: 0, half: 45, 'three-quarters': 90 })
const CLEAR_SHOT_BONUS = 200
const HIGH_GROUND_BONUS = 120
/** Надбавка заряженной recharge-способности: она сильнее обычной атаки. */
const RECHARGE_READY_BONUS = 120
/**
 * Потолки перебора. Поиск пути дороже всей остальной оценки вместе взятой,
 * поэтому позиции сначала оцениваются геометрией (это дёшево), и только у
 * лучших проверяется маршрут. Без этого разделения ход NPC на сцене 30×30
 * дорожал втрое.
 */
const MAX_EVALUATED_POSITIONS = 24
const MAX_ROUTED_POSITIONS = 5
const MAX_COVER_THREATS = 3
const BLOODIED_RATIO = 0.25

/** Укрытие цели глазами движка. Полным считается перекрытая линия удара. */
function targetCoverLevel(state, attackerIdValue, targetIdValue, from, to) {
  if (!from || !to) return 'none'
  return String(coverBetween(state, attackerIdValue, targetIdValue, from, to).level ?? 'none')
}

function rangedProfileFor(state, actor) {
  const profile = attackProfileFor(state, actorId(actor))
  return profile && profile.kind === 'ranged' ? profile : null
}

/**
 * Герои, от которых стрелку стоит прятаться: те, кто сам бьёт издалека.
 * Берутся ближайшие: дальний стрелок в другом конце сцены на выбор клетки не
 * влияет, а каждый лишний угрожающий — это ещё один расчёт линии огня.
 */
function rangedThreats(state, enemy) {
  const from = actorPosition(state, actorId(enemy))
  if (!from) return []
  return livingParty(state)
    .filter((hero) => rangedProfileFor(state, hero) && actorPosition(state, actorId(hero)))
    .map((hero) => ({ hero, at: actorPosition(state, actorId(hero)) }))
    .sort((left, right) => (Math.max(Math.abs(left.at.x - from.x), Math.abs(left.at.y - from.y)))
      - (Math.max(Math.abs(right.at.x - from.x), Math.abs(right.at.y - from.y)))
      || actorId(left.hero).localeCompare(actorId(right.hero)))
    .slice(0, MAX_COVER_THREATS)
    .map((entry) => entry.hero)
}

/**
 * Насколько позиция укрывает самого NPC от вражеских стрелков.
 *
 * Линия огня проверяется только там, где она способна изменить ответ: при
 * трёх четвертях укрытия перекрытая линия даёт ту же оценку, а лишняя трасса
 * на каждую клетку-кандидата — заметная цена на большой сцене.
 */
function ownCoverScore(state, enemy, position, threats) {
  if (!position || !threats.length) return 0
  let total = 0
  for (const threat of threats) {
    const threatAt = actorPosition(state, actorId(threat))
    const level = targetCoverLevel(state, actorId(threat), actorId(enemy), threatAt, position)
    total += level === 'none' && !hasClearTrajectory(state, threatAt, position)
      ? OWN_COVER_BONUS['three-quarters']
      : OWN_COVER_BONUS[level] ?? 0
  }
  return Math.round(total / threats.length)
}

/**
 * Бонус за высоту начисляется ровно там, где движок действительно даёт
 * преимущество: `highGroundBetween` молчит на дистанции до пяти футов, поэтому
 * ближний бой высоту не считает. Начислять её мечнику значило бы гнать его на
 * уступ ради преимущества, которого он там не получит.
 */
function highGroundBonus(state, from, to) {
  if (!from || !to) return 0
  const distanceFeet = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * CELL_FEET
  return highGroundBetween(state, from, to, distanceFeet) === 'higher' ? HIGH_GROUND_BONUS : 0
}

/**
 * Клетки-кандидаты в пределах бюджета скорости. Сначала дешёвый отбор по
 * форме сцены, затем — потолок на число позиций, и только для выживших
 * считается путь: поиск пути дороже всего остального вместе взятого.
 */
function candidatePositions(state, enemy, budgetFeet, anchor, prefer = 'near') {
  const from = actorPosition(state, actorId(enemy))
  const maximumSteps = Math.max(0, Math.floor(budgetFeet / CELL_FEET))
  if (!from || !maximumSteps) return []
  const occupied = new Set([...livingParty(state), ...livingEnemies(state)]
    .map((actor) => actorPosition(state, actorId(actor)))
    .filter(Boolean)
    .map((position) => `${position.x}:${position.y}`))
  const reachable = (state.scene?.cells ?? [])
    .filter((cell) => cell.revealed && ['floor', 'door'].includes(cell.type))
    .map((cell) => ({ x: Number(cell.x), y: Number(cell.y) }))
    .filter((cell) => Math.max(Math.abs(cell.x - from.x), Math.abs(cell.y - from.y)) <= maximumSteps
      && !occupied.has(`${cell.x}:${cell.y}`))
  const reference = anchor ?? from
  const toReference = (cell) => Math.max(Math.abs(cell.x - reference.x), Math.abs(cell.y - reference.y))
  // Отступающему нужны клетки подальше от якоря, стрелку — поближе к цели.
  // Без этого различия отход выбирал бы из тесного кольца вокруг себя.
  const direction = prefer === 'far' ? -1 : 1
  return reachable
    .sort((left, right) => direction * (toReference(left) - toReference(right)) || left.x - right.x || left.y - right.y)
    .slice(0, MAX_EVALUATED_POSITIONS)
}

/** Оплачиваемый маршрут до клетки или `null`, если он не по карману. */
function affordableRouteTo(state, enemy, cell, budgetFeet) {
  const path = shortestTacticalPath(state, actorId(enemy), cell)
  if (!path?.length) return null
  const { stepCost } = movementStepCostFor(state, actorId(enemy))
  const costFeet = path.reduce((total, step) => total + stepCost(step), 0)
  if (costFeet > budgetFeet) return null
  return { path, costFeet, destination: path.at(-1) }
}

function remainingMovementFeet(state, enemy) {
  const spent = Math.max(0, Number(state.mechanics?.combat?.action_economy?.[actorId(enemy)]?.movement_spent) || 0)
  const speed = Number(enemy.speed)
  return Math.max(0, (Number.isFinite(speed) ? speed : 30) - spent)
}

/**
 * Позиция для выстрела: оттуда, где у цели нет укрытия, а у стрелка оно есть.
 * Возвращается только строго лучший вариант — если текущая клетка не хуже,
 * NPC остаётся на месте и не тратит перемещение впустую.
 */
function firingPositionFor(state, enemy, target, profile) {
  if (profile?.kind !== 'ranged') return null
  const from = actorPosition(state, actorId(enemy))
  const targetAt = actorPosition(state, actorId(target))
  if (!from || !targetAt) return null
  const budgetFeet = remainingMovementFeet(state, enemy)
  const threats = rangedThreats(state, enemy)
  const positionScore = (position) => {
    const distanceFeet = Math.max(Math.abs(position.x - targetAt.x), Math.abs(position.y - targetAt.y)) * CELL_FEET
    if (distanceFeet < CELL_FEET || distanceFeet > profile.range_feet) return null
    if (!hasClearTrajectory(state, position, targetAt)) return null
    const cover = targetCoverLevel(state, actorId(enemy), actorId(target), position, targetAt)
    return (cover === 'none' ? CLEAR_SHOT_BONUS : 0)
      - (COVER_TARGET_PENALTY[cover] ?? 0)
      + ownCoverScore(state, enemy, position, threats)
      + highGroundBonus(state, position, targetAt)
      // Стрельба в упор наказана тем же весом, что и в выборе цели.
      - (distanceFeet <= CELL_FEET ? 70 : 0)
  }
  const current = positionScore(from)
  // Дальше ищем, только если с места стрелять хуже, чем вообще возможно на
  // этой сцене: цель открыта, стрелок сам укрыт и стоит выше. Потолок считается
  // по фактической обстановке — без вражеских стрелков прятаться не от кого.
  const ceiling = CLEAR_SHOT_BONUS
    + (threats.length ? OWN_COVER_BONUS['three-quarters'] : 0)
    + HIGH_GROUND_BONUS
  if (current != null && current >= ceiling) return null
  // Кандидаты отсчитываются от самого стрелка, а не от цели: дешёвый шаг в
  // сторону ценнее рывка навстречу, а уступ и укрытие чаще всего рядом.
  // Отбор по близости к цели прятал бы от стрелка высоту у него под ногами.
  const ranked = rankedPositions(state, enemy, budgetFeet, from, positionScore, current)
  return firstAffordable(state, enemy, ranked, budgetFeet)
}

/**
 * Геометрическая оценка кандидатов без поиска пути, отсортированная так, что
 * равные варианты всегда упорядочены одинаково.
 */
function rankedPositions(state, enemy, budgetFeet, anchor, positionScore, currentScore, prefer = 'near') {
  const scored = []
  for (const cell of candidatePositions(state, enemy, budgetFeet, anchor, prefer)) {
    const score = positionScore(cell)
    if (score == null) continue
    if (currentScore != null && score <= currentScore) continue
    scored.push({ score, cell })
  }
  return scored
    .sort((left, right) => right.score - left.score || left.cell.x - right.cell.x || left.cell.y - right.cell.y)
    .slice(0, MAX_ROUTED_POSITIONS)
}

/** Первый кандидат, до которого действительно хватает скорости. */
function firstAffordable(state, enemy, ranked, budgetFeet) {
  for (const entry of ranked) {
    const route = affordableRouteTo(state, enemy, entry.cell, budgetFeet)
    if (route) return { score: entry.score, destination: route.destination, costFeet: route.costFeet, steps: route.path.length }
  }
  return null
}

const FRENZY_TRAITS = Object.freeze([
  NPC_BEHAVIOR_POLICIES.bloodiedFrenzy,
  NPC_BEHAVIOR_POLICIES.relentlessPursuit,
])

/**
 * Раненый NPC отходит, а не разменивается насмерть.
 *
 * Мораль в состоянии выражена состояниями, а не полем: `npc-controller`
 * вешает `morale-tested` на решившего драться и `fled`/`surrendered` на
 * вышедшего из боя. Поэтому отход уважает уже принятое решение: тот, кто
 * проверку морали прошёл и остался, не убегает следующим же ходом.
 */
function shouldRetreatBloodied(state, enemy) {
  const hp = Math.max(0, Number(enemy.hp) || 0)
  const maxHp = Math.max(1, Number(enemy.maxHp ?? enemy.max_hp) || hp || 1)
  if (hp <= 0 || hp / maxHp >= BLOODIED_RATIO) return false
  if (FRENZY_TRAITS.some((trait) => hasTrait(enemy, trait))) return false
  const conditions = conditionIds(state, actorId(enemy))
  if (conditions.has('morale-tested') || conditions.has('fled') || conditions.has('surrendered')) return false
  // Отходят от угрозы, а не «в принципе»: раненому, до которого никто не
  // достаёт и кто ни у кого не на прицеле, отступать некуда и незачем.
  return adjacentPartyMember(state, enemy) || meleeThreatWithinReach(state, enemy) || underRangedFire(state, enemy)
}

/** Есть ли хоть один вражеский стрелок с открытой линией до этого существа. */
function underRangedFire(state, enemy) {
  const at = actorPosition(state, actorId(enemy))
  if (!at) return false
  return rangedThreats(state, enemy).some((hero) => {
    const heroAt = actorPosition(state, actorId(hero))
    const profile = rangedProfileFor(state, hero)
    const distanceFeet = Math.max(Math.abs(heroAt.x - at.x), Math.abs(heroAt.y - at.y)) * CELL_FEET
    return distanceFeet <= (profile?.range_feet ?? 0) && hasClearTrajectory(state, heroAt, at)
  })
}

/**
 * Куда отходить: под укрытие, ближе к живым союзникам и подальше от чужой
 * досягаемости в ближнем бою.
 */
function bloodiedRetreatFor(state, enemy) {
  const from = actorPosition(state, actorId(enemy))
  if (!from) return null
  const budgetFeet = remainingMovementFeet(state, enemy)
  const heroes = livingParty(state)
    .map((hero) => ({ id: actorId(hero), at: actorPosition(state, actorId(hero)), profile: attackProfileFor(state, actorId(hero)) }))
    .filter((hero) => hero.at)
  const allies = livingEnemies(state)
    .filter((ally) => actorId(ally) !== actorId(enemy))
    .map((ally) => actorPosition(state, actorId(ally)))
    .filter(Boolean)
  const positionScore = (position) => {
    let score = 0
    for (const hero of heroes) {
      const reachFeet = Math.max(CELL_FEET, Number(hero.profile?.kind === 'melee' ? hero.profile?.range_feet : CELL_FEET) || CELL_FEET)
      const distanceFeet = Math.max(Math.abs(position.x - hero.at.x), Math.abs(position.y - hero.at.y)) * CELL_FEET
      if (distanceFeet > reachFeet) score += 60
      score += Math.min(120, distanceFeet * 2)
      const level = targetCoverLevel(state, hero.id, actorId(enemy), hero.at, position)
      score += level === 'none' && !hasClearTrajectory(state, hero.at, position)
        ? OWN_COVER_BONUS['three-quarters']
        : OWN_COVER_BONUS[level] ?? 0
    }
    // Рядом со своими отход осмысленнее, чем в одиночку в угол.
    const nearestAlly = allies.reduce((best, ally) => Math.min(best, Math.max(Math.abs(position.x - ally.x), Math.abs(position.y - ally.y))), Number.MAX_SAFE_INTEGER)
    if (allies.length) score += Math.max(0, 60 - nearestAlly * 12)
    return score
  }
  // Кандидаты отсчитываются от ближайшего героя и берутся самые дальние от
  // него: отступают от угрозы, а не в первое попавшееся соседнее окно.
  const nearestHero = heroes
    .slice()
    .sort((left, right) => Math.max(Math.abs(left.at.x - from.x), Math.abs(left.at.y - from.y))
      - Math.max(Math.abs(right.at.x - from.x), Math.abs(right.at.y - from.y))
      || left.id.localeCompare(right.id))[0]
  const ranked = rankedPositions(state, enemy, budgetFeet, nearestHero?.at ?? from, positionScore, positionScore(from), 'far')
  return firstAffordable(state, enemy, ranked, budgetFeet)?.destination ?? null
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
      // Заряженная recharge-способность — обычно сильнейший ход существа, и
      // держать её «на потом» смысла нет: следующий бросок вернёт её сам, а
      // непотраченная она не стоит ничего. Разряженная сюда не доходит вовсе.
      const rechargeValue = Number(profile.recharge) > 0 ? RECHARGE_READY_BONUS : 0
      const rangedAtMeleePenalty = profile.kind === 'ranged' && enemyAt && targetAt && Math.max(Math.abs(enemyAt.x - targetAt.x), Math.abs(enemyAt.y - targetAt.y)) === 1 ? 70 : 0
      // Укрытие и высота считаются движковыми функциями и только для стрельбы:
      // вплотную укрытия нет, а высота в ближнем бою движком не учитывается.
      const coverLevel = profile.kind === 'ranged' ? targetCoverLevel(state, actorId(enemy), actorId(target), enemyAt, targetAt) : 'none'
      const coverPenalty = COVER_TARGET_PENALTY[coverLevel] ?? 0
      const highGround = profile.kind === 'ranged' ? highGroundBonus(state, enemyAt, targetAt) : 0
      // Перекрытая линия удара — это полное укрытие: стрелять нельзя вовсе,
      // и такая цель выбирается только вместе со сменой позиции. Дистанцию
      // считаем отдельно от `inAttackRange`: тот уже учёл линию огня и вернул
      // «не достать», а нам нужно отличить «далеко» от «закрыто».
      const distanceFeet = enemyAt && targetAt
        ? Math.max(Math.abs(enemyAt.x - targetAt.x), Math.abs(enemyAt.y - targetAt.y)) * CELL_FEET
        : Number.MAX_SAFE_INTEGER
      const blockedShot = profile.kind === 'ranged'
        && distanceFeet >= CELL_FEET && distanceFeet <= profile.range_feet
        && !hasClearTrajectory(state, enemyAt, targetAt)
      const relentlessPursuit = hasTrait(enemy, NPC_BEHAVIOR_POLICIES.relentlessPursuit)
      const score = Number(inRange && !blockedShot) * 1_000 + Number(Boolean(path)) * 400 + Math.min(300, damage * 12)
        + (relentlessPursuit
          ? Math.max(0, 800 - pathDistance * 80)
          : damage >= targetHp ? 260 : Math.round((1 - targetHp / Math.max(targetHp, Number(target.maxHp) || targetHp)) * 100))
        + (relentlessPursuit ? 0 : Math.max(0, 22 - targetArmor) * 4 + controlValue + packValue) + rechargeValue
        - pathDistance * 3 - rangedAtMeleePenalty - coverPenalty + highGround
      candidates.push({ actor: target, path, inRange: inRange && !blockedShot, blockedShot, coverLevel, distance: pathDistance, profile, score })
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
  // Отход раненого идёт раньше любой атакующей ветки: существо на последних
  // ОЗ не разменивается насмерть, если не одержимо чертой ярости.
  const bloodiedRetreat = shouldRetreatBloodied(state, enemy) ? bloodiedRetreatFor(state, enemy) : null
  if (bloodiedRetreat) {
    // Выход из соприкосновения оплачивается Отходом: это общее действие, оно
    // доступно и NPC, и снимает атаки по возможности.
    if (adjacentPartyMember(state, enemy) && currentEconomy.action !== false) {
      commands.push({ command_type: 'UseCombatAction', actor_id: String(enemyId), action_id: 'disengage' })
    }
    commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: bloodiedRetreat, monster_ability: 'bloodied-withdrawal' })
    movementOnlyPhase = true
  } else if (candidate.inRange
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
  } else if (candidate.blockedShot) {
    // Цель закрыта полностью: стрелять неоткуда, но укрытие можно обойти.
    // Ветка стоит раньше сближения — подходить вплотную стрелку незачем.
    const firing = firingPositionFor(state, enemy, candidate.actor, profile)
    if (firing) {
      plannedMovementFeet = firing.costFeet
      plannedPosition = firing.destination
      commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: firing.destination, monster_ability: 'firing-position' })
      commands.push(...attackCommands(state, enemy, targetId, profile))
    } else if (candidate.path?.length) {
      const budgetFeet = remainingMovementFeet(state, enemy)
      const approach = affordablePathPrefix(state, enemyId, candidate.path, Math.max(0, candidate.path.length - 1), budgetFeet)
      if (approach.steps > 0) {
        plannedMovementFeet = approach.costFeet
        plannedPosition = candidate.path[approach.steps - 1]
        commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: plannedPosition })
      }
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
    // Стрелок сперва ищет клетку, откуда цель не за укрытием, а он сам — за ним.
    // Позиция меняется только если она строго лучше текущей.
    const firing = firingPositionFor(state, enemy, candidate.actor, profile)
    if (firing) {
      plannedMovementFeet = firing.costFeet
      plannedPosition = firing.destination
      commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: firing.destination, monster_ability: 'firing-position' })
    }
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
  const proposed = commands.map((command, index) => ({
    ...command,
    server_authoritative: true,
    campaign_id: campaignId,
    command_id: `${key}:${index + 1}`,
  }))
  // Шаг 4 плана `docs/agent-architecture-plan.md`: **объявленное изменение
  // поведения**. Раньше чужой коммит, опередивший планировщик, ронял ход NPC
  // целиком — ошибка 500 и потерянный ход, тогда как тот же конфликт у хода
  // игрока переживался прозрачно. Теперь политика одна для обоих: исполнитель
  // перечитывает состояние и повторяет план.
  //
  // Ключ по-прежнему собран из позиции в очереди инициативы, поэтому повтор
  // после падения на середине очереди не создаёт второй ход NPC.
  const executor = new AuthoritativeExecutor({ eventStore, rulesEngine })
  const committed = await executor.executeCommands({
    campaignId,
    idempotencyKey: key,
    commands: proposed,
    context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true },
  })
  // На повторе ключа плана нет: события берутся из прежнего коммита.
  const resolved = committed.resolved ?? { commands: proposed, events: committed.events ?? [], rolls: [] }
  if (!resolved.events.length) throw new RulesValidationError('NPC turn produced no events', 'NPC_TURN_EMPTY')
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
    // Перемирие замораживает очередь. Это не косметика: без остановки
    // планировщик сходил бы за противника ровно в тот момент, когда обе стороны
    // опустили оружие, и первое же перемирие рвал бы сам сервер.
    if (truceHolds(state)) return { state, state_version: loaded.state_version, turns, events }
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

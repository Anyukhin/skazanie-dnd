import { createHash } from 'node:crypto'

import {
  ENCOUNTER_ASSEMBLER_LIMITS,
  SRD_5_2_1_MONSTER_ALLOWLIST,
} from './encounter-assembler.mjs'
import {
  MAX_CURRENCY_CP,
  copperToCurrency,
  currencyToCopper,
} from './merchant-economy.mjs'
import {
  carryingCapacity,
  inventoryWeight,
} from './item-lifecycle.mjs'
import { materializeCatalogItem } from './item-catalog.mjs'
import {
  ENCOUNTER_LOOT_POLICY_ID,
  serverEncounterLoot,
} from './loot-tables.mjs'

export const ENCOUNTER_OUTCOME_PLAN_VERSION = 'skazanie:encounter-outcome-plan:v1'
export const ENCOUNTER_REWARD_POLICY_ID = 'skazanie:encounter-rewards:v2'
export const ENCOUNTER_COINS_POLICY_ID = 'skazanie:encounter-coins:v1'
export const ENCOUNTER_DISTRIBUTION_POLICY_ID = 'skazanie:encounter-distribution:v1'
export const ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION = 1
export const SERVER_LOOT_GENERATED_EVENT_SCHEMA_VERSION = 2
export const MAX_ENCOUNTER_COINS_CP = 288_000
export const MAX_HERO_REWARD_INVENTORY_ITEMS = 200

const DIFFICULTIES = new Set(['easy', 'medium', 'hard'])
const THEMES = new Set([
  'goblinoids',
  'undead',
  'beasts',
  'raiders',
  'warband',
  'vermin',
  'ambush',
  'crypt',
  'cave',
  'wilderness',
  'generic',
])

const clone = (value) => structuredClone(value)

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function cleanId(value) {
  return String(value ?? '').trim().slice(0, 160)
}

function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

function actorIsDefeated(actor) {
  if (actor?.alive === false) return true
  const rawHp = actor?.hp ?? actor?.hit_points
  if (rawHp == null) return false
  const hp = Number(rawHp)
  return Number.isFinite(hp) && hp <= 0
}

export class EncounterRewardValidationError extends Error {
  constructor(message, code = 'ENCOUNTER_REWARD_INVALID') {
    super(message)
    this.name = 'EncounterRewardValidationError'
    this.code = code
  }
}

function reject(message, code) {
  throw new EncounterRewardValidationError(message, code)
}

export function encounterCompletionStageKey(encounterId, stage) {
  const id = cleanId(encounterId)
  if (!id) reject('У награды нет encounter_id', 'ENCOUNTER_ID_REQUIRED')
  if (!['outcome', 'xp', 'coins', 'loot', 'distribution', 'transition'].includes(stage)) {
    reject('Неизвестная стадия награды', 'ENCOUNTER_REWARD_STAGE_INVALID')
  }
  return `encounter-completion:${id}:${stage}`
}

export function livingEncounterRewardRecipients(state = {}) {
  const players = new Set((state.players ?? []).map(actorId).filter(Boolean))
  const seen = new Set()
  return (state.partyMemberIds ?? [])
    .map(String)
    .filter((id) => {
      if (!id || seen.has(id) || !players.has(id)) return false
      seen.add(id)
      return state.mechanics?.death?.heroes?.[id]?.status !== 'dead'
    })
}

function encounterDescriptorMap(encounter) {
  const descriptors = Array.isArray(encounter.enemies) ? encounter.enemies : []
  const result = new Map()
  for (const descriptor of descriptors) {
    const id = actorId(descriptor)
    if (!id || result.has(id)) reject('Encounter содержит повторяющееся описание врага', 'ENCOUNTER_ENEMY_DUPLICATE')
    result.set(id, descriptor)
  }
  return result
}

function frozenNoRewardPlan(state, encounter, encounterId, outcome) {
  return deepFreeze({
    version: ENCOUNTER_OUTCOME_PLAN_VERSION,
    policy: ENCOUNTER_REWARD_POLICY_ID,
    encounter_id: encounterId,
    outcome,
    rewards_eligible: false,
    difficulty: DIFFICULTIES.has(encounter.difficulty) ? encounter.difficulty : 'medium',
    theme: THEMES.has(encounter.theme) ? encounter.theme : 'generic',
    enemies: [],
    total_xp: 0,
    recipients: livingEncounterRewardRecipients(state),
  })
}

/**
 * Полностью проверяет и замораживает исход встречи до первого броска монет.
 * В XP не попадают ни посторонние мёртвые существа, ни сохранённые числовые
 * проекции врага: единственный источник числа — server-owned stat block.
 */
export function freezeEncounterOutcomePlan(state = {}, requestedOutcome = null) {
  const encounter = state.mechanics?.encounter
  if (!encounter || typeof encounter !== 'object') reject('В состоянии нет встречи', 'ENCOUNTER_NOT_FOUND')
  const encounterId = cleanId(encounter.id ?? encounter.encounter_id)
  if (!encounterId) reject('Встреча не имеет идентификатора', 'ENCOUNTER_ID_REQUIRED')
  if (String(encounter.status ?? '') !== 'ended') reject('Встреча ещё не завершена', 'ENCOUNTER_NOT_ENDED')

  const storedOutcome = String(encounter.outcome ?? '').trim()
  const outcome = String(requestedOutcome ?? storedOutcome).trim()
  if (!outcome || storedOutcome !== outcome) reject('Исход не совпадает с завершённой встречей', 'ENCOUNTER_OUTCOME_MISMATCH')
  if (outcome !== 'enemies_defeated') return frozenNoRewardPlan(state, encounter, encounterId, outcome)

  const enemyIds = encounter.enemy_ids
  if (!Array.isArray(enemyIds)
    || enemyIds.length < 1
    || enemyIds.length > ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures) {
    reject('Список врагов встречи вне разрешённых границ', 'ENCOUNTER_ENEMY_COUNT_INVALID')
  }
  const normalizedIds = enemyIds.map(cleanId)
  if (normalizedIds.some((id) => !id) || new Set(normalizedIds).size !== normalizedIds.length) {
    reject('Список врагов встречи должен содержать уникальные ID', 'ENCOUNTER_ENEMY_DUPLICATE')
  }

  const descriptors = encounterDescriptorMap(encounter)
  if (descriptors.size !== normalizedIds.length || normalizedIds.some((id) => !descriptors.has(id))) {
    reject('Список врагов не совпадает с замороженным составом встречи', 'ENCOUNTER_ENEMY_FOREIGN')
  }
  const actors = new Map((state.enemies ?? []).map((enemy) => [actorId(enemy), enemy]))
  const enemies = normalizedIds.map((enemyId) => {
    const enemy = actors.get(enemyId)
    const descriptor = descriptors.get(enemyId)
    if (!enemy || !descriptor) reject(`Враг ${enemyId} не найден`, 'ENCOUNTER_ENEMY_UNKNOWN')
    if (!actorIsDefeated(enemy)) reject(`Враг ${enemyId} ещё жив`, 'ENCOUNTER_ENEMY_LIVING')

    const statBlockId = cleanId(enemy.stat_block_id)
    if (!statBlockId || statBlockId !== cleanId(descriptor.stat_block_id)) {
      reject(`Враг ${enemyId} не принадлежит замороженному stat block`, 'ENCOUNTER_ENEMY_FOREIGN')
    }
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
    if (!block) reject(`Stat block ${statBlockId} не входит в allowlist`, 'ENCOUNTER_STAT_BLOCK_UNKNOWN')
    const xp = Number(block.xp)
    if (!Number.isSafeInteger(xp) || xp < 0 || xp > 100_000) {
      reject(`Stat block ${statBlockId} содержит некорректный XP`, 'ENCOUNTER_STAT_BLOCK_XP_INVALID')
    }
    if (enemy.provenance && Object.hasOwn(enemy.provenance, 'xp') && Number(enemy.provenance.xp) !== xp) {
      reject(`Сохранённый XP врага ${enemyId} расходится с stat block`, 'ENCOUNTER_ENEMY_XP_MISMATCH')
    }
    return { enemy_id: enemyId, stat_block_id: statBlockId, xp }
  })

  return deepFreeze({
    version: ENCOUNTER_OUTCOME_PLAN_VERSION,
    policy: ENCOUNTER_REWARD_POLICY_ID,
    encounter_id: encounterId,
    outcome,
    rewards_eligible: true,
    difficulty: DIFFICULTIES.has(encounter.difficulty) ? encounter.difficulty : 'medium',
    theme: THEMES.has(encounter.theme) ? encounter.theme : 'generic',
    enemies,
    total_xp: enemies.reduce((sum, enemy) => sum + enemy.xp, 0),
    recipients: livingEncounterRewardRecipients(state),
  })
}

export function frozenEncounterOutcomePlanFromEvent(event) {
  const plan = event?.payload?.plan
  if (!plan || plan.version !== ENCOUNTER_OUTCOME_PLAN_VERSION) {
    reject('Outcome event не содержит поддерживаемый frozen plan', 'ENCOUNTER_OUTCOME_PLAN_UNSUPPORTED')
  }
  return deepFreeze(clone(plan))
}

export function encounterCoinUnitsForXp(value) {
  const numeric = Number(value)
  const bounded = Number.isFinite(numeric)
    ? Math.min(100_000, Math.max(0, Math.trunc(numeric)))
    : numeric > 0 ? 100_000 : 0
  return Math.ceil(bounded / 25)
}

export function rollEncounterCoins(plan, diceService) {
  if (!plan?.rewards_eligible) return deepFreeze({
    policy: ENCOUNTER_COINS_POLICY_ID,
    encounter_id: cleanId(plan?.encounter_id),
    rolls: [],
    total_cp: 0,
  })
  if (!diceService || typeof diceService.roll !== 'function') throw new TypeError('Encounter coin policy requires DiceService')
  const enemies = [...plan.enemies].sort((left, right) => left.enemy_id.localeCompare(right.enemy_id))
  if (enemies.length < 1 || enemies.length > ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures) {
    reject('Frozen plan содержит недопустимое число врагов', 'ENCOUNTER_ENEMY_COUNT_INVALID')
  }
  const rolls = enemies.map((enemy) => {
    const roll = diceService.roll('1d6', `encounter-coins:${enemy.enemy_id}`, null, 'party')
    const xpUnits = encounterCoinUnitsForXp(enemy.xp)
    return {
      roll_id: roll.roll_id,
      expression: roll.expression,
      dice: clone(roll.dice),
      total: roll.total,
      enemy_id: enemy.enemy_id,
      stat_block_id: enemy.stat_block_id,
      xp: enemy.xp,
      xp_units: xpUnits,
      amount_cp: roll.total * xpUnits,
    }
  })
  const totalCp = rolls.reduce((sum, roll) => sum + roll.amount_cp, 0)
  if (!Number.isSafeInteger(totalCp) || totalCp < 0 || totalCp > MAX_ENCOUNTER_COINS_CP) {
    reject('Монеты встречи вышли за разрешённую границу', 'ENCOUNTER_COINS_OUT_OF_RANGE')
  }
  return deepFreeze({
    policy: ENCOUNTER_COINS_POLICY_ID,
    encounter_id: plan.encounter_id,
    rolls,
    total_cp: totalCp,
  })
}

export function lootForEncounterOutcome(plan) {
  if (!plan?.rewards_eligible) return deepFreeze([])
  return deepFreeze(serverEncounterLoot({
    theme: plan.theme,
    difficulty: plan.difficulty,
    encounterId: plan.encounter_id,
  }))
}

export function serverRewardForEncounter(state = {}, outcome = null) {
  const plan = freezeEncounterOutcomePlan(state, outcome)
  return {
    encounter_id: plan.encounter_id,
    outcome: plan.outcome,
    xp: plan.total_xp,
    recipients: [...plan.recipients],
    progression: plan.rewards_eligible ? 'xp' : null,
    milestone: null,
    loot: clone(lootForEncounterOutcome(plan)),
  }
}

function experienceAwards(totalXp, recipients) {
  if (!recipients.length || totalXp <= 0) return new Map()
  const share = Math.floor(totalXp / recipients.length)
  const remainder = totalXp % recipients.length
  return new Map(recipients.map((id, index) => [id, share + (index < remainder ? 1 : 0)]))
}

function distributionOrder(encounterId, recipients) {
  if (!recipients.length) return []
  const offset = Number.parseInt(digest(`distribution:${encounterId}`).slice(0, 8), 16) % recipients.length
  return [...recipients.slice(offset), ...recipients.slice(0, offset)]
}

function materializedLootInstances(encounterId, loot) {
  const encounterDigest = digest(encounterId).slice(0, 16)
  return loot.flatMap((stack, stackIndex) => (
    Array.from({ length: Math.max(1, Number(stack.quantity) || 1) }, (_, unitIndex) => (
      materializeCatalogItem(stack.catalog_id, {
        id: `loot-${encounterDigest}-${stackIndex + 1}-${unitIndex + 1}`,
        quantity: 1,
        equipped: false,
      })
    ))
  ))
}

function assertLootBounds(items) {
  const physicalUnits = items.reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0)
  const weight = items.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0) * Math.max(1, Number(item.quantity) || 1), 0)
  if (items.length > 3 || physicalUnits > 9 || weight > 54) {
    reject('Добыча встречи вышла за физические границы', 'ENCOUNTER_LOOT_OUT_OF_RANGE')
  }
}

function canReceiveRewardItems(player, items) {
  const inventory = Array.isArray(player?.inventory) ? player.inventory : []
  if (inventory.length + items.length > MAX_HERO_REWARD_INVENTORY_ITEMS) return false
  const addedWeight = items.reduce((sum, item) => (
    sum + Math.max(0, Number(item?.weight) || 0) * Math.max(1, Number(item?.quantity) || 1)
  ), 0)
  return inventoryWeight(player) + addedWeight <= carryingCapacity(player)
}

export function assertEncounterRewardRecipients(state, recipients = []) {
  const ids = recipients.map(cleanId)
  const players = new Set((state.players ?? []).map(actorId).filter(Boolean))
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length || ids.some((id) => !players.has(id))) {
    reject('Состав получателей награды изменился после frozen plan', 'ENCOUNTER_REWARD_RECIPIENT_CHANGED')
  }
  return true
}

export function distributeEncounterRewards(state, { plan, coins, loot } = {}) {
  const recipients = [...(plan?.recipients ?? [])]
  const order = distributionOrder(plan?.encounter_id, recipients)
  assertLootBounds(loot ?? [])
  const items = materializedLootInstances(plan?.encounter_id, loot ?? [])
  const xpAwards = experienceAwards(Number(plan?.total_xp) || 0, recipients)
  const totalCp = Number(coins?.total_cp ?? 0)
  if (!Number.isSafeInteger(totalCp) || totalCp < 0 || totalCp > MAX_ENCOUNTER_COINS_CP) {
    reject('Монеты встречи вышли за разрешённую границу', 'ENCOUNTER_COINS_OUT_OF_RANGE')
  }

  if (!order.length) {
    return deepFreeze({
      schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
      policy: ENCOUNTER_DISTRIBUTION_POLICY_ID,
      encounter_id: plan?.encounter_id,
      allocations: [],
      unassigned: {
        xp: Math.max(0, Number(plan?.total_xp) || 0),
        coins_cp: totalCp,
        items,
      },
    })
  }

  const byId = new Map((state.players ?? []).map((player) => [actorId(player), player]))
  const allocations = order.map((recipientId) => {
    const player = byId.get(recipientId)
    if (!player) reject(`Получатель ${recipientId} не найден`, 'ENCOUNTER_REWARD_RECIPIENT_UNKNOWN')
    return {
      recipient_id: recipientId,
      xp: xpAwards.get(recipientId) ?? 0,
      coins_cp: 0,
      items: [],
    }
  })

  const equalShare = Math.floor(totalCp / allocations.length)
  const remainder = totalCp % allocations.length
  allocations.forEach((allocation, index) => {
    allocation.coins_cp = equalShare + (index < remainder ? 1 : 0)
  })
  const unassignedItems = []
  let nextRecipientIndex = 0
  for (const item of items) {
    let assigned = false
    for (let attempt = 0; attempt < allocations.length; attempt += 1) {
      const index = (nextRecipientIndex + attempt) % allocations.length
      const allocation = allocations[index]
      const player = byId.get(allocation.recipient_id)
      const proposedItems = [...allocation.items, item]
      if (!canReceiveRewardItems(player, proposedItems)) continue
      allocation.items.push(item)
      nextRecipientIndex = (index + 1) % allocations.length
      assigned = true
      break
    }
    if (!assigned) unassignedItems.push(item)
  }

  const existingItemIds = new Set((state.players ?? []).flatMap((player) => (
    (player.inventory ?? []).map((item) => String(item?.id ?? '')).filter(Boolean)
  )))
  for (const allocation of allocations) {
    const player = byId.get(allocation.recipient_id)
    const afterCp = currencyToCopper(player.currency) + allocation.coins_cp
    if (!Number.isSafeInteger(afterCp) || afterCp > MAX_CURRENCY_CP) {
      reject('Кошелёк героя не может вместить награду встречи', 'CURRENCY_LIMIT_EXCEEDED')
    }
    if (!canReceiveRewardItems(player, allocation.items)) {
      reject('Герой не может нести назначенную добычу', 'ENCOUNTER_REWARD_CAPACITY_EXCEEDED')
    }
    for (const item of allocation.items) {
      if (!item.id || existingItemIds.has(String(item.id))) {
        reject('ID предмета награды уже существует', 'ENCOUNTER_LOOT_ID_COLLISION')
      }
      existingItemIds.add(String(item.id))
    }
  }

  return deepFreeze({
    schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
    policy: ENCOUNTER_DISTRIBUTION_POLICY_ID,
    encounter_id: plan?.encounter_id,
    allocations,
    unassigned: { xp: 0, coins_cp: 0, items: unassignedItems },
  })
}

export function assertEncounterDistributionPreconditions(state, distribution) {
  const byId = new Map((state.players ?? []).map((player) => [actorId(player), player]))
  const existingItemIds = new Set((state.players ?? []).flatMap((player) => (
    (player.inventory ?? []).map((item) => String(item?.id ?? '')).filter(Boolean)
  )))
  for (const allocation of distribution?.allocations ?? []) {
    const player = byId.get(cleanId(allocation.recipient_id))
    const deltaCp = Number(allocation.coins_cp)
    const afterCp = player ? currencyToCopper(player.currency) + deltaCp : Number.NaN
    if (!player || !Number.isSafeInteger(deltaCp) || deltaCp < 0
      || !Number.isSafeInteger(afterCp) || afterCp < 0 || afterCp > MAX_CURRENCY_CP) {
      reject('Кошелёк героя не может вместить награду встречи', 'CURRENCY_LIMIT_EXCEEDED')
    }
    const items = Array.isArray(allocation.items) ? allocation.items : []
    if (!canReceiveRewardItems(player, items)) {
      reject('Состояние инвентаря изменилось после frozen plan', 'ENCOUNTER_REWARD_STATE_CHANGED')
    }
    for (const item of items) {
      if (!item?.id || existingItemIds.has(String(item.id))) {
        reject('Состояние инвентаря изменилось после frozen plan', 'ENCOUNTER_REWARD_STATE_CHANGED')
      }
      existingItemIds.add(String(item.id))
    }
  }
  return true
}

/**
 * Применяет только точный versioned payload. Каталог здесь намеренно не
 * читается: старый replay получает ровно сохранённые экземпляры и балансы.
 *
 * @returns {string[]} ID героев, чьи derived inventory-поля надо обновить.
 */
export function applyEncounterRewardsDistribution(state, event) {
  if (event?.event_type !== 'EncounterRewardsDistributed'
    || Number(event.event_schema_version) !== ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION
    || Number(event.payload?.schema_version) !== ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION
    || !Array.isArray(event.payload?.allocations)) return []

  const allocations = event.payload.allocations
  const allocationIds = allocations.map((allocation) => cleanId(allocation?.recipient_id))
  if (allocationIds.some((id) => !id) || new Set(allocationIds).size !== allocationIds.length) return []
  const byId = new Map((state.players ?? []).map((player) => [actorId(player), player]))
  if (allocationIds.some((id) => !byId.has(id))) return []

  const seenItemIds = new Set((state.players ?? []).flatMap((player) => (
    (player.inventory ?? []).map((item) => String(item?.id ?? '')).filter(Boolean)
  )))
  const nextById = new Map()
  for (const allocation of allocations) {
    const id = cleanId(allocation.recipient_id)
    const items = Array.isArray(allocation.items) ? allocation.items.map(clone) : []
    if (items.some((item) => !item?.id || seenItemIds.has(String(item.id)))) return []
    const player = byId.get(id)
    const deltaCp = Number(allocation.coins_cp)
    const afterCp = currencyToCopper(player.currency) + deltaCp
    if (!Number.isSafeInteger(deltaCp) || deltaCp < 0
      || !Number.isSafeInteger(afterCp) || afterCp < 0 || afterCp > MAX_CURRENCY_CP
      || !canReceiveRewardItems(player, items)) return []
    items.forEach((item) => seenItemIds.add(String(item.id)))
    nextById.set(id, {
      ...player,
      currency: copperToCurrency(afterCp),
      inventory: [...(Array.isArray(player.inventory) ? player.inventory : []), ...items],
    })
  }
  state.players = state.players.map((player) => nextById.get(actorId(player)) ?? player)
  return allocationIds
}

export function encounterRewardResponse({ plan, coins, loot, distribution } = {}) {
  return {
    encounter_id: plan?.encounter_id ?? '',
    outcome: plan?.outcome ?? '',
    xp: Math.max(0, Number(plan?.total_xp) || 0),
    xp_recipients: [...(plan?.recipients ?? [])],
    coins: Math.max(0, Number(coins?.total_cp) || 0),
    coin_rolls: clone(coins?.rolls ?? []),
    loot: clone(loot ?? []),
    allocations: clone(distribution?.allocations ?? []),
    unassigned: clone(distribution?.unassigned ?? { xp: 0, coins_cp: 0, items: [] }),
  }
}

export { ENCOUNTER_LOOT_POLICY_ID }

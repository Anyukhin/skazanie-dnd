import { createHash } from 'node:crypto'

import { catalogItem, itemLifecycleProfile } from './item-catalog.mjs'
import { inventoryStackKey, MAX_STOCK_QUANTITY, normalizeInventoryItem } from './merchant-economy.mjs'
import {
  MAX_NPC_INVENTORY_ITEMS,
  MAX_NPC_INVENTORY_OWNERS,
  npcInteractionTargetForViewer,
  npcVitalFor,
  normalizeNpcWorldState,
} from './npc-positioning.mjs'

export const ITEM_LIFECYCLE_COMMAND_TYPES = new Set(['EquipItem', 'UseItem', 'TransferItem', 'AttuneItem', 'ActivateItem'])
export const MAX_ATTUNED_ITEMS = 3
export const MAX_ACTIVE_ITEM_EFFECT_BONUS = 100
export const ITEM_DESTROYED_EVENT_SCHEMA_VERSION = 1
export const MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION = 1

export class ItemLifecycleValidationError extends Error {
  constructor(message, code = 'ITEM_LIFECYCLE_INVALID') {
    super(message)
    this.name = 'ItemLifecycleValidationError'
    this.code = code
  }
}

const clean = (value, maximum = 120) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const clone = (value) => structuredClone(value)

function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

function player(state, id) {
  return (state.players ?? []).find((candidate) => actorId(candidate) === String(id ?? '')) ?? null
}

function itemFor(actor, id) {
  return (actor?.inventory ?? []).find((item) => String(item?.id) === String(id ?? '') && Number(item?.quantity ?? 1) > 0) ?? null
}

function profileFor(item, rulesetId = '') {
  const catalog = itemLifecycleProfile(String(item?.catalog_id ?? item?.catalogId ?? ''), { rulesetId })
  if (catalog) return clone(catalog)
  const profile = {
    requires_attunement: item?.requires_attunement === true,
  }
  if (item?.type === 'weapon' && item?.combat) return { ...profile, equip_slot: 'main_hand' }
  if (item?.type === 'armor') return { ...profile, equip_slot: 'body' }
  return profile
}

function chargeStateFor(item, profile) {
  if (!profile?.charges) return null
  const maximum = Math.max(0, integer(profile.charges.max, 0))
  const requested = item?.charges?.current ?? profile.charges.current
  return {
    current: Math.max(0, Math.min(maximum, integer(requested, maximum))),
    max: maximum,
  }
}

function chargeStateFromEvent(payload) {
  const maximum = Math.max(0, integer(payload?.max, 0))
  return {
    current: Math.max(0, Math.min(maximum, integer(payload?.after, 0))),
    max: maximum,
  }
}

function sameParty(state, id) {
  const ids = new Set((state.partyMemberIds?.length ? state.partyMemberIds : (state.players ?? []).map(actorId)).map(String))
  return ids.has(String(id))
}

function allowedActor(context, id) {
  return context.isAdmin === true || new Set((context.allowedActorIds ?? []).map(String)).has(String(id))
}

function assertPlainCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new ItemLifecycleValidationError('Команда предмета должна быть объектом')
  }
  const common = [
    'command_type', 'command_id', 'campaign_id', 'actor_id', 'target_id', 'target_ids',
    'item_id', 'quantity', 'equipped', 'attuned', 'recipient_id', 'charges_to_spend',
    'activated',
    'merchant_id', 'stock_id', 'action_id',
    // Клетка рассыпания, выбор режима фляги и оружие под яд. Поля недоверенные:
    // допустимость клетки, дальность и принадлежность оружия проверяет
    // Rules Engine, а не отправитель команды.
    'to', 'use_mode', 'weapon_id',
    'expected_state_version', 'ruleset_id', 'source_rule_ids', 'house_rule_id', 'ruling_id', 'visibility', 'request_fingerprint',
    'server_authoritative',
  ]
  const unexpected = Object.keys(command).filter((key) => !common.includes(key))
  if (unexpected.length) {
    throw new ItemLifecycleValidationError(`Команда предмета содержит запрещённые поля: ${unexpected.join(', ')}`, 'ITEM_COMMAND_UNKNOWN_FIELD')
  }
}

export function itemProfileFor(item, { rulesetId = '' } = {}) {
  return profileFor(item, rulesetId)
}

export function inventoryWeight(actor) {
  return Math.round((actor?.inventory ?? []).reduce((total, item) => total
    + Math.max(0, Number(item?.weight) || 0) * Math.max(0, integer(item?.quantity, 1)), 0) * 100) / 100
}

export function carryingCapacity(actor) {
  return Math.max(0, integer(actor?.abilities?.str, 10)) * 15
}

export function inventoryLoadFor(actor) {
  const weight = inventoryWeight(actor)
  const capacity = carryingCapacity(actor)
  return {
    weight,
    capacity,
    encumbered: capacity > 0 && weight > capacity,
    remaining: Math.max(0, Math.round((capacity - weight) * 100) / 100),
    attuned: (actor?.inventory ?? []).filter((item) => item?.attuned_to === actorId(actor)).length,
    attunement_limit: MAX_ATTUNED_ITEMS,
  }
}

export function activeItemEffectTotals(actor) {
  const ownerId = actorId(actor)
  const groups = new Map()
  for (const item of actor?.inventory ?? []) {
    if (!item || integer(item.quantity, 1) <= 0 || !Array.isArray(item.passive_effects)) continue
    for (const effect of item.passive_effects.slice(0, 32)) {
      if (!effect || integer(effect.schema_version, 0) !== 1) continue
      const group = clean(effect.group)
      if (!group || !clean(effect.effect_id)) continue
      if (effect.requires_equipped === true && item.equipped !== true) continue
      if (effect.requires_attunement === true && (!ownerId || String(item.attuned_to ?? '') !== ownerId)) continue
      const armorClassBonus = Math.min(MAX_ACTIVE_ITEM_EFFECT_BONUS, Math.max(0, integer(effect.armor_class_bonus, 0)))
      const savingThrowBonus = Math.min(MAX_ACTIVE_ITEM_EFFECT_BONUS, Math.max(0, integer(effect.saving_throw_bonus, 0)))
      if (armorClassBonus === 0 && savingThrowBonus === 0) continue
      const current = groups.get(group) ?? { armor_class_bonus: 0, saving_throw_bonus: 0 }
      groups.set(group, {
        armor_class_bonus: Math.max(current.armor_class_bonus, armorClassBonus),
        saving_throw_bonus: Math.max(current.saving_throw_bonus, savingThrowBonus),
      })
    }
  }
  let armorClassBonus = 0
  let savingThrowBonus = 0
  for (const effect of groups.values()) {
    armorClassBonus = Math.min(MAX_ACTIVE_ITEM_EFFECT_BONUS, armorClassBonus + effect.armor_class_bonus)
    savingThrowBonus = Math.min(MAX_ACTIVE_ITEM_EFFECT_BONUS, savingThrowBonus + effect.saving_throw_bonus)
  }
  return {
    armor_class_bonus: armorClassBonus,
    saving_throw_bonus: savingThrowBonus,
    active_groups: [...groups.keys()].sort(),
  }
}

function normalizedWeaponDamageRider(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const expression = clean(input.expression, 40).toLowerCase().replace(/\s+/gu, '')
  if (!/^([1-9]|1\d|20)d(4|6|8|10|12)$/u.test(expression)) return null
  const damageType = clean(input.damage_type, 40).toLowerCase()
  if (!damageType) return null
  return {
    expression,
    damage_type: damageType,
    critical_doubles: input.critical_doubles === true,
  }
}

function normalizedPassiveEffectContract(effect) {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect) || integer(effect.schema_version, 0) !== 1) return null
  const effectId = clean(effect.effect_id)
  const group = clean(effect.group)
  if (!effectId || !group) return null
  const rider = normalizedWeaponDamageRider(effect.weapon_damage_rider)
  return {
    schema_version: 1,
    effect_id: effectId,
    group,
    requires_equipped: effect.requires_equipped === true,
    requires_attunement: effect.requires_attunement === true,
    requires_activated: effect.requires_activated === true,
    armor_class_bonus: Math.min(MAX_ACTIVE_ITEM_EFFECT_BONUS, Math.max(0, integer(effect.armor_class_bonus, 0))),
    saving_throw_bonus: Math.min(MAX_ACTIVE_ITEM_EFFECT_BONUS, Math.max(0, integer(effect.saving_throw_bonus, 0))),
    damage_resistances: uniqueCleanStrings(effect.damage_resistances),
    spell_immunities: uniqueCleanStrings(effect.spell_immunities),
    prevents_critical_hits: effect.prevents_critical_hits === true,
    initiative_advantage: effect.initiative_advantage === true,
    weapon_damage_rider: rider,
  }
}

function trustedItemPassiveEffects(item) {
  const catalogId = clean(item?.catalog_id ?? item?.catalogId)
  const entry = catalogId ? catalogItem(catalogId) : null
  if (!entry || !Array.isArray(item?.passive_effects) || !Array.isArray(entry.passive_effects)) return []
  const canonicalById = new Map(entry.passive_effects.slice(0, 32)
    .map((effect) => normalizedPassiveEffectContract(effect))
    .filter(Boolean)
    .map((effect) => [effect.effect_id, effect]))
  return item.passive_effects.slice(0, 32)
    .map((effect) => normalizedPassiveEffectContract(effect))
    .filter((effect) => effect && JSON.stringify(effect) === JSON.stringify(canonicalById.get(effect.effect_id)))
}

/**
 * Расширенные эффекты известных предметов. В отличие от исторического
 * числового stamp-контракта выше, этот путь не исполняет эффекты произвольного
 * объекта без известного catalog_id. Сама семантика всё равно читается из
 * сохранённого экземпляра, а не из текущей записи каталога: будущая правка
 * manifest не переписывает replay уже выданного предмета.
 */
export function activeItemMechanicEffects(actor, { selectedItemId = null, selectedCountsAsEquipped = false } = {}) {
  const ownerId = actorId(actor)
  const result = []
  for (const item of actor?.inventory ?? []) {
    if (!item || integer(item.quantity, 1) <= 0) continue
    const catalogId = clean(item.catalog_id ?? item.catalogId)
    if (!catalogId) continue
    const selected = selectedItemId != null && String(item.id) === String(selectedItemId)
    const consideredEquipped = item.equipped === true || (selected && selectedCountsAsEquipped)
    for (const effect of trustedItemPassiveEffects(item)) {
      const effectId = clean(effect.effect_id)
      const group = clean(effect.group)
      if (!effectId || !group) continue
      if (effect.requires_equipped === true && !consideredEquipped) continue
      if (effect.requires_attunement === true && (!ownerId || String(item.attuned_to ?? '') !== ownerId)) continue
      if (effect.requires_activated === true && item.activated !== true) continue
      const rider = normalizedWeaponDamageRider(effect.weapon_damage_rider)
      result.push({
        schema_version: 1,
        effect_id: effectId,
        group,
        item_id: clean(item.id),
        item_name: clean(item.name),
        catalog_id: catalogId,
        damage_resistances: uniqueCleanStrings(effect.damage_resistances),
        spell_immunities: uniqueCleanStrings(effect.spell_immunities),
        prevents_critical_hits: effect.prevents_critical_hits === true,
        initiative_advantage: effect.initiative_advantage === true,
        ...(rider ? { weapon_damage_rider: rider } : {}),
      })
    }
  }
  return result
}

function uniqueCleanStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).slice(0, 32)
    .map((value) => clean(value, 80).toLowerCase())
    .filter(Boolean))].sort()
}

export function weaponDamageRidersForItem(actor, itemId, { selectedCountsAsEquipped = false } = {}) {
  const item = itemFor(actor, itemId)
  if (!item || item?.type !== 'weapon' || profileFor(item).equip_slot !== 'main_hand') return []
  const seenGroups = new Set()
  return activeItemMechanicEffects(actor, { selectedItemId: itemId, selectedCountsAsEquipped })
    .filter((effect) => effect.item_id === String(itemId) && effect.weapon_damage_rider)
    .filter((effect) => {
      if (seenGroups.has(effect.group)) return false
      seenGroups.add(effect.group)
      return true
    })
    .map((effect) => ({
      effect_id: effect.effect_id,
      group: effect.group,
      item_id: effect.item_id,
      item_name: effect.item_name,
      catalog_id: effect.catalog_id,
      ...effect.weapon_damage_rider,
    }))
}

export function derivedEquipmentArmorClass(actor, { includeItemEffects = true } = {}) {
  const dexterity = Math.floor(((Number(actor?.abilities?.dex) || 10) - 10) / 2)
  let body = null
  let bonus = 0
  for (const item of actor?.inventory ?? []) {
    if (!item?.equipped) continue
    const profile = profileFor(item)
    if (profile.armor) {
      const dexterityBonus = profile.armor.dexterity
        ? profile.armor.dexterity_cap == null ? dexterity : Math.min(dexterity, Number(profile.armor.dexterity_cap) || 0)
        : 0
      body = Math.max(body ?? 0, profile.armor.base + dexterityBonus)
    }
    bonus += Number(profile.armor_bonus) || 0
  }
  const itemBonus = includeItemEffects ? activeItemEffectTotals(actor).armor_class_bonus : 0
  return body == null && bonus === 0 && itemBonus === 0
    ? null
    : Math.max(0, body ?? 10 + dexterity) + bonus + itemBonus
}

export function validateItemLifecycleCommand(command, state, context = {}) {
  if (!ITEM_LIFECYCLE_COMMAND_TYPES.has(command.command_type)) return command
  assertPlainCommand(command)
  const ownerId = clean(command.actor_id)
  const owner = player(state, ownerId)
  if (!owner) throw new ItemLifecycleValidationError('Герой не найден', 'ACTOR_NOT_FOUND')
  if (!allowedActor(context, ownerId)) throw new ItemLifecycleValidationError('Предмет доступен только владельцу героя', 'ACTOR_FORBIDDEN')
  const itemId = clean(command.item_id)
  const item = itemFor(owner, itemId)
  if (!item) throw new ItemLifecycleValidationError('Предмет не найден', 'ITEM_NOT_FOUND')
  const profile = profileFor(item, state?.ruleset_id)
  const result = {
    ...command,
    actor_id: ownerId,
    item_id: itemId,
    target_ids: [ownerId],
    visibility: 'party',
    item_profile: profile,
  }

  if (command.command_type === 'EquipItem') {
    const equipped = command.equipped !== false
    if (!profile.equip_slot) throw new ItemLifecycleValidationError('Этот предмет нельзя экипировать', 'ITEM_NOT_EQUIPPABLE')
    if (state.mechanics?.combat?.active) throw new ItemLifecycleValidationError('Общую экипировку нельзя менять во время боя', 'ITEM_EQUIP_DURING_COMBAT')
    result.equipped = equipped
    result.equip_slot = profile.equip_slot
  }

  if (command.command_type === 'UseItem') {
    if (!profile.use) throw new ItemLifecycleValidationError('У предмета нет серверного профиля использования', 'ITEM_NOT_USABLE')
    const targetId = clean(command.target_id || ownerId)
    const creatureTarget = ['creature', 'enemy'].includes(profile.use.target)
    const target = creatureTarget
      ? [...(state.players ?? []), ...(state.actors ?? []), ...(state.enemies ?? [])]
        .find((candidate) => actorId(candidate) === targetId) ?? null
      : player(state, targetId)
    const enemyTarget = (state.enemies ?? []).some((candidate) => actorId(candidate) === targetId)
    if (!target || (profile.use.target === 'enemy' && !enemyTarget) || (!creatureTarget && !sameParty(state, targetId))) {
      throw new ItemLifecycleValidationError(
        creatureTarget ? 'Цель использования не является допустимым противником' : 'Цель использования не входит в отряд',
        'INVALID_ITEM_TARGET',
      )
    }
    if (profile.use.target === 'self' && targetId !== ownerId) {
      throw new ItemLifecycleValidationError('Этот предмет можно использовать только на себя', 'INVALID_ITEM_TARGET')
    }
    if (profile.use.combat_only === true && state.mechanics?.combat?.active !== true) {
      throw new ItemLifecycleValidationError('Этот предмет можно использовать только в бою', 'COMBAT_NOT_ACTIVE')
    }
    if (profile.use.requires_equipped === true && item.equipped !== true) {
      throw new ItemLifecycleValidationError('Чтобы использовать этот предмет, его нужно держать экипированным', 'ITEM_NOT_EQUIPPED')
    }
    if (profile.use.kind === 'ration' && state.mechanics?.combat?.active) {
      throw new ItemLifecycleValidationError('Паёк нельзя использовать во время боя', 'ITEM_USE_DURING_COMBAT')
    }
    const minimumChargeCost = Math.max(0, integer(profile.use.min_charges_to_spend, 0))
    const maximumChargeCost = Math.max(minimumChargeCost, integer(profile.use.max_charges_to_spend, minimumChargeCost))
    const variableChargeCost = maximumChargeCost > 0
    const requestedChargeCost = integer(command.charges_to_spend, Number.NaN)
    if (variableChargeCost && (!Number.isSafeInteger(requestedChargeCost)
      || requestedChargeCost < minimumChargeCost
      || requestedChargeCost > maximumChargeCost)) {
      throw new ItemLifecycleValidationError(
        `Нужно потратить от ${minimumChargeCost} до ${maximumChargeCost} зарядов`,
        'INVALID_ITEM_CHARGE_SPEND',
      )
    }
    const chargeCost = variableChargeCost ? requestedChargeCost : Math.max(0, integer(profile.use.charges_per_use, 0))
    if (chargeCost > 0) {
      const charges = chargeStateFor(item, profile)
      if (!charges || charges.current < chargeCost) {
        throw new ItemLifecycleValidationError('У предмета не осталось применений', 'ITEM_CHARGES_EXHAUSTED')
      }
      result.charge_spend = {
        before: charges.current,
        spent: chargeCost,
        after: charges.current - chargeCost,
        max: charges.max,
      }
    }
    if (variableChargeCost) result.charges_to_spend = chargeCost
    result.target_id = targetId
    result.target_ids = [targetId]
    result.use_profile = profile.use
  }

  if (command.command_type === 'TransferItem') {
    if (state.mechanics?.combat?.active) throw new ItemLifecycleValidationError('Передача предметов во время боя недоступна', 'ITEM_TRANSFER_DURING_COMBAT')
    if (item.equipped) throw new ItemLifecycleValidationError('Сначала снимите предмет', 'ITEM_EQUIPPED')
    if (item.attuned_to) throw new ItemLifecycleValidationError('Сначала разорвите настройку с предметом', 'ITEM_ATTUNED')
    const recipientId = clean(command.recipient_id || command.target_id)
    if (!recipientId || recipientId === ownerId) {
      throw new ItemLifecycleValidationError('Получатель должен отличаться от владельца предмета', 'INVALID_ITEM_RECIPIENT')
    }
    const heroRecipient = player(state, recipientId)
    let recipientKind = 'hero'
    let recipientInventory = heroRecipient?.inventory ?? []
    if (heroRecipient) {
      if (!sameParty(state, recipientId)) {
        throw new ItemLifecycleValidationError('Получатель должен быть другим героем отряда', 'INVALID_ITEM_RECIPIENT')
      }
    } else {
      const npcTarget = npcInteractionTargetForViewer(state, recipientId)
      if (!npcTarget) {
        throw new ItemLifecycleValidationError('NPC должен быть видим и реально присутствовать в текущей сцене', 'NPC_ITEM_RECIPIENT_NOT_VISIBLE')
      }
      const npcProfile = npcTarget.npc
      if (npcProfile.available === false) {
        throw new ItemLifecycleValidationError('NPC сейчас недоступен для взаимодействия', 'NPC_ITEM_RECIPIENT_UNAVAILABLE')
      }
      if (npcVitalFor(state, recipientId).alive !== true) {
        throw new ItemLifecycleValidationError('Нельзя передать предмет погибшему NPC', 'NPC_ITEM_RECIPIENT_DEAD')
      }
      recipientKind = 'npc'
      const npcWorld = normalizeNpcWorldState(state.npc_world)
      const hasNpcInventory = Object.hasOwn(npcWorld.inventories, recipientId)
      recipientInventory = hasNpcInventory ? npcWorld.inventories[recipientId] : []
      if (!hasNpcInventory
        && Object.keys(npcWorld.inventories).length >= MAX_NPC_INVENTORY_OWNERS) {
        throw new ItemLifecycleValidationError('Хранилище инвентарей NPC заполнено', 'NPC_INVENTORY_CAPACITY_EXCEEDED')
      }
    }
    const quantity = integer(command.quantity, 1)
    if (quantity < 1 || quantity > integer(item.quantity, 1)) {
      throw new ItemLifecycleValidationError('Некорректное количество предметов', 'INVALID_ITEM_QUANTITY')
    }
    const transferred = normalizeInventoryItem({ ...item, id: transferItemId(command, item, recipientId), quantity, equipped: false, attuned_to: null }, { preserveUnknown: true })
    const stackable = profile.stackable !== false
    if (!stackable && quantity !== 1) {
      throw new ItemLifecycleValidationError('Этот предмет переносится только отдельным экземпляром', 'ITEM_NOT_STACKABLE')
    }
    const mergeable = stackable && recipientInventory.some((candidate) => !candidate.equipped && !candidate.attuned_to
      && inventoryStackKey(candidate) === inventoryStackKey(transferred))
    const matchingQuantity = stackable ? recipientInventory
      .filter((candidate) => !candidate.equipped && !candidate.attuned_to
        && inventoryStackKey(candidate) === inventoryStackKey(transferred))
      .reduce((total, candidate) => total + integer(candidate.quantity, 1), 0) : 0
    const inventoryLimit = recipientKind === 'npc' ? MAX_NPC_INVENTORY_ITEMS : 200
    if (!mergeable && recipientInventory.length >= inventoryLimit) {
      throw new ItemLifecycleValidationError(
        recipientKind === 'npc' ? 'Инвентарь NPC заполнен' : 'Инвентарь получателя заполнен',
        recipientKind === 'npc' ? 'NPC_INVENTORY_CAPACITY_EXCEEDED' : 'INVENTORY_CAPACITY_EXCEEDED',
      )
    }
    if (matchingQuantity + quantity > MAX_STOCK_QUANTITY) {
      throw new ItemLifecycleValidationError('Стопка предметов получателя превысит допустимый размер', 'ITEM_STACK_LIMIT_EXCEEDED')
    }
    const projectedWeight = heroRecipient ? inventoryWeight(heroRecipient) + transferred.weight * quantity : 0
    if (heroRecipient && projectedWeight > carryingCapacity(heroRecipient)) {
      throw new ItemLifecycleValidationError('Получатель превысит грузоподъёмность', 'CARRYING_CAPACITY_EXCEEDED')
    }
    result.recipient_id = recipientId
    result.recipient_kind = recipientKind
    result.quantity = quantity
    result.transferred_item = transferred
    result.item_stackable = stackable
    result.target_ids = [ownerId, recipientId]
  }

  if (command.command_type === 'AttuneItem') {
    if (state.mechanics?.combat?.active) throw new ItemLifecycleValidationError('Настройка на предмет выполняется вне боя', 'ITEM_ATTUNE_DURING_COMBAT')
    const attuned = command.attuned !== false
    if (attuned && profile.requires_attunement !== true) {
      throw new ItemLifecycleValidationError('Этот предмет не требует настройки', 'ITEM_NOT_ATTUNABLE')
    }
    if (attuned && item.attuned_to && item.attuned_to !== ownerId) {
      throw new ItemLifecycleValidationError('Предмет уже настроен на другого героя', 'ITEM_ALREADY_ATTUNED')
    }
    const catalogId = clean(item.catalog_id ?? item.catalogId)
    const duplicate = attuned && catalogId
      ? (owner.inventory ?? []).find((candidate) => String(candidate.id) !== itemId
        && clean(candidate.catalog_id ?? candidate.catalogId) === catalogId
        && String(candidate.attuned_to ?? '') === ownerId)
      : null
    if (duplicate) {
      throw new ItemLifecycleValidationError('Нельзя настроиться на несколько копий одного и того же предмета', 'DUPLICATE_ITEM_ATTUNEMENT')
    }
    const current = (owner.inventory ?? []).filter((candidate) => candidate.attuned_to === ownerId && candidate.id !== itemId).length
    if (attuned && current >= MAX_ATTUNED_ITEMS) {
      throw new ItemLifecycleValidationError('Достигнут лимит из трёх настроенных предметов', 'ATTUNEMENT_LIMIT_REACHED')
    }
    result.attuned = attuned
  }
  if (command.command_type === 'ActivateItem') {
    const activation = profile.activation
    if (!activation || integer(activation.schema_version, 0) !== MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION) {
      throw new ItemLifecycleValidationError('Этот предмет нельзя активировать', 'ITEM_NOT_ACTIVATABLE')
    }
    if (typeof command.activated !== 'boolean') {
      throw new ItemLifecycleValidationError('Нужно явно выбрать включение или выключение предмета', 'INVALID_ITEM_ACTIVATION')
    }
    if (activation.requires_equipped === true && item.equipped !== true) {
      throw new ItemLifecycleValidationError('Чтобы активировать предмет, его нужно держать экипированным', 'ITEM_NOT_EQUIPPED')
    }
    if (activation.requires_attunement === true && String(item.attuned_to ?? '') !== ownerId) {
      throw new ItemLifecycleValidationError('Для активации нужна настройка на предмет', 'ITEM_NOT_ATTUNED')
    }
    if (item.activated === command.activated) {
      throw new ItemLifecycleValidationError('Предмет уже находится в выбранном состоянии', 'ITEM_ACTIVATION_UNCHANGED')
    }
    result.activated = command.activated
    result.activation_profile = clone(activation)
    result.activation_before = item.activated === true
  }
  return result
}

function transferItemId(command, item, recipientId) {
  const digest = createHash('sha256')
    .update(`${command.command_id ?? ''}\0${item.id}\0${recipientId}`)
    .digest('hex')
    .slice(0, 20)
  return `${String(item.id).slice(0, 80)}:transfer:${digest}`
}

export function itemLifecycleEvents(command) {
  if (command.command_type === 'EquipItem') {
    return [{
      event_type: command.equipped ? 'ItemEquipped' : 'ItemUnequipped',
      payload: { item_id: command.item_id, equip_slot: command.equip_slot, request_fingerprint: command.request_fingerprint ?? null },
      target_ids: [command.actor_id],
    }]
  }
  if (command.command_type === 'TransferItem') {
    return [{
      event_type: 'ItemTransferred',
      payload: {
        item_id: command.item_id,
        from_actor_id: command.actor_id,
        to_actor_id: command.recipient_id,
        recipient_kind: command.recipient_kind,
        quantity: command.quantity,
        item: clone(command.transferred_item),
        stackable: command.item_stackable !== false,
        request_fingerprint: command.request_fingerprint ?? null,
      },
      target_ids: [command.actor_id, command.recipient_id],
    }]
  }
  if (command.command_type === 'AttuneItem') {
    return [{
      event_type: 'ItemAttunementChanged',
      payload: { item_id: command.item_id, actor_id: command.actor_id, attuned: command.attuned, request_fingerprint: command.request_fingerprint ?? null },
      target_ids: [command.actor_id],
    }]
  }
  if (command.command_type === 'ActivateItem') {
    return [{
      event_type: 'MagicItemActivationChanged',
      event_schema_version: MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION,
      payload: {
        schema_version: MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION,
        owner_id: command.actor_id,
        item_id: command.item_id,
        activation_id: command.activation_profile.activation_id,
        activated_before: command.activation_before === true,
        activated: command.activated === true,
        combat_action: command.activation_profile.combat_action ?? null,
        request_fingerprint: command.request_fingerprint ?? null,
      },
      target_ids: [command.actor_id],
    }]
  }
  return []
}

export function applyItemLifecycleEventToPlayers(players, event) {
  const payload = event.payload ?? {}
  let next = clone(Array.isArray(players) ? players : [])
  if (event.event_type === 'ItemEquipped' || event.event_type === 'ItemUnequipped') {
    const ownerId = String(event.target_ids?.[0] ?? event.actor_id ?? '')
    const equipped = event.event_type === 'ItemEquipped'
    next = next.map((actor) => actorId(actor) !== ownerId ? actor : {
      ...actor,
      inventory: (actor.inventory ?? []).map((item) => {
        if (String(item.id) === String(payload.item_id)) return { ...item, equipped, ...(!equipped ? { activated: false } : {}) }
        if (equipped && profileFor(item).equip_slot === payload.equip_slot) return { ...item, equipped: false, activated: false }
        return item
      }),
    })
  }
  if (event.event_type === 'ItemAttunementChanged') {
    const ownerId = String(payload.actor_id ?? event.actor_id ?? '')
    next = next.map((actor) => actorId(actor) !== ownerId ? actor : {
      ...actor,
      inventory: (actor.inventory ?? []).map((item) => String(item.id) === String(payload.item_id)
        ? { ...item, attuned_to: payload.attuned ? ownerId : null, ...(!payload.attuned ? { activated: false } : {}) }
        : item),
    })
  }
  if (event.event_type === 'ItemTransferred') {
    const quantity = Math.max(1, integer(payload.quantity, 1))
    next = next.map((actor) => {
      const id = actorId(actor)
      if (id === String(payload.from_actor_id)) {
        return {
          ...actor,
          inventory: (actor.inventory ?? [])
            .map((item) => String(item.id) === String(payload.item_id)
              ? { ...item, quantity: Math.max(0, integer(item.quantity, 1) - quantity) }
              : item)
            .filter((item) => integer(item.quantity, 0) > 0),
        }
      }
      if (id === String(payload.to_actor_id)) {
        const incoming = normalizeInventoryItem(payload.item, { preserveUnknown: true })
        const stackIndex = payload.stackable === false ? -1 : (actor.inventory ?? []).findIndex((item) => !item.equipped && !item.attuned_to
          && inventoryStackKey(item) === inventoryStackKey(incoming))
        if (stackIndex < 0) return { ...actor, inventory: [...(actor.inventory ?? []), incoming] }
        return {
          ...actor,
          inventory: (actor.inventory ?? []).map((item, index) => index === stackIndex
            ? { ...item, quantity: integer(item.quantity, 1) + quantity }
            : item),
        }
      }
      return actor
    })
  }
  if (event.event_type === 'ItemChargesSpent') {
    const ownerId = String(event.target_ids?.[0] ?? event.actor_id ?? '')
    next = next.map((actor) => actorId(actor) !== ownerId ? actor : {
      ...actor,
      inventory: (actor.inventory ?? []).map((item) => String(item.id) === String(payload.item_id)
        ? {
            ...item,
            charges: chargeStateFromEvent(payload),
          }
        : item),
    })
  }
  if (
    event.event_type === 'ItemDestroyed'
    && Number(event.event_schema_version) === ITEM_DESTROYED_EVENT_SCHEMA_VERSION
    && Number(payload.schema_version) === ITEM_DESTROYED_EVENT_SCHEMA_VERSION
  ) {
    const ownerId = String(payload.owner_id ?? event.target_ids?.[0] ?? event.actor_id ?? '')
    next = next.map((actor) => actorId(actor) !== ownerId ? actor : {
      ...actor,
      inventory: (actor.inventory ?? []).filter((item) => String(item.id) !== String(payload.item_id)),
    })
  }
  if (
    event.event_type === 'MagicItemActivationChanged'
    && Number(event.event_schema_version) === MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION
    && Number(payload.schema_version) === MAGIC_ITEM_ACTIVATION_EVENT_SCHEMA_VERSION
  ) {
    const ownerId = String(payload.owner_id ?? event.target_ids?.[0] ?? event.actor_id ?? '')
    next = next.map((actor) => actorId(actor) !== ownerId ? actor : {
      ...actor,
      inventory: (actor.inventory ?? []).map((item) => String(item.id) === String(payload.item_id)
        ? { ...item, activated: payload.activated === true }
        : item),
    })
  }
  return next
}

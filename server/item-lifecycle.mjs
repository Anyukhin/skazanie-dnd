import { createHash } from 'node:crypto'

import { itemLifecycleProfile } from './item-catalog.mjs'
import { inventoryStackKey, MAX_STOCK_QUANTITY, normalizeInventoryItem } from './merchant-economy.mjs'
import {
  MAX_NPC_INVENTORY_ITEMS,
  MAX_NPC_INVENTORY_OWNERS,
  npcInteractionTargetForViewer,
  npcVitalFor,
  normalizeNpcWorldState,
} from './npc-positioning.mjs'

export const ITEM_LIFECYCLE_COMMAND_TYPES = new Set(['EquipItem', 'UseItem', 'TransferItem', 'AttuneItem'])
export const MAX_ATTUNED_ITEMS = 3

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

function profileFor(item) {
  const catalog = itemLifecycleProfile(String(item?.catalog_id ?? item?.catalogId ?? ''))
  if (catalog) return clone(catalog)
  if (item?.type === 'weapon' && item?.combat) return { equip_slot: 'main_hand' }
  if (item?.type === 'armor') return { equip_slot: 'body' }
  return {}
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
    'item_id', 'quantity', 'equipped', 'attuned', 'recipient_id',
    'merchant_id', 'stock_id', 'action_id',
    'expected_state_version', 'source_rule_ids', 'house_rule_id', 'ruling_id', 'visibility', 'request_fingerprint',
    'server_authoritative',
  ]
  const unexpected = Object.keys(command).filter((key) => !common.includes(key))
  if (unexpected.length) {
    throw new ItemLifecycleValidationError(`Команда предмета содержит запрещённые поля: ${unexpected.join(', ')}`, 'ITEM_COMMAND_UNKNOWN_FIELD')
  }
}

export function itemProfileFor(item) {
  return profileFor(item)
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

export function derivedEquipmentArmorClass(actor) {
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
  return body == null && bonus === 0 ? null : Math.max(0, body ?? 10 + dexterity) + bonus
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
  const profile = profileFor(item)
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
    const target = player(state, targetId)
    if (!target || !sameParty(state, targetId)) throw new ItemLifecycleValidationError('Цель использования не входит в отряд', 'INVALID_ITEM_TARGET')
    if (profile.use.kind === 'ration' && state.mechanics?.combat?.active) {
      throw new ItemLifecycleValidationError('Паёк нельзя использовать во время боя', 'ITEM_USE_DURING_COMBAT')
    }
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
    const mergeable = recipientInventory.some((candidate) => !candidate.equipped && !candidate.attuned_to
      && inventoryStackKey(candidate) === inventoryStackKey(transferred))
    const matchingQuantity = recipientInventory
      .filter((candidate) => !candidate.equipped && !candidate.attuned_to
        && inventoryStackKey(candidate) === inventoryStackKey(transferred))
      .reduce((total, candidate) => total + integer(candidate.quantity, 1), 0)
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
    result.target_ids = [ownerId, recipientId]
  }

  if (command.command_type === 'AttuneItem') {
    if (state.mechanics?.combat?.active) throw new ItemLifecycleValidationError('Настройка на предмет выполняется вне боя', 'ITEM_ATTUNE_DURING_COMBAT')
    const attuned = command.attuned !== false
    if (attuned && item.requires_attunement !== true) {
      throw new ItemLifecycleValidationError('Этот предмет не требует настройки', 'ITEM_NOT_ATTUNABLE')
    }
    if (attuned && item.attuned_to && item.attuned_to !== ownerId) {
      throw new ItemLifecycleValidationError('Предмет уже настроен на другого героя', 'ITEM_ALREADY_ATTUNED')
    }
    const current = (owner.inventory ?? []).filter((candidate) => candidate.attuned_to === ownerId && candidate.id !== itemId).length
    if (attuned && current >= MAX_ATTUNED_ITEMS) {
      throw new ItemLifecycleValidationError('Достигнут лимит из трёх настроенных предметов', 'ATTUNEMENT_LIMIT_REACHED')
    }
    result.attuned = attuned
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
      payload: { item_id: command.item_id, equip_slot: command.equip_slot },
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
      },
      target_ids: [command.actor_id, command.recipient_id],
    }]
  }
  if (command.command_type === 'AttuneItem') {
    return [{
      event_type: 'ItemAttunementChanged',
      payload: { item_id: command.item_id, actor_id: command.actor_id, attuned: command.attuned },
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
        if (String(item.id) === String(payload.item_id)) return { ...item, equipped }
        if (equipped && profileFor(item).equip_slot === payload.equip_slot) return { ...item, equipped: false }
        return item
      }),
    })
  }
  if (event.event_type === 'ItemAttunementChanged') {
    const ownerId = String(payload.actor_id ?? event.actor_id ?? '')
    next = next.map((actor) => actorId(actor) !== ownerId ? actor : {
      ...actor,
      inventory: (actor.inventory ?? []).map((item) => String(item.id) === String(payload.item_id)
        ? { ...item, attuned_to: payload.attuned ? ownerId : null }
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
        const stackIndex = (actor.inventory ?? []).findIndex((item) => !item.equipped && !item.attuned_to
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
  return next
}

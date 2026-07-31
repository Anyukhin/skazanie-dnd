import {
  catalogItem,
  itemRechargeProfile,
  normalizeItemRechargeProfile,
} from './item-catalog.mjs'

export const DAWN_PERIOD_MINUTES = 1_440
export const MAX_DAWN_RECHARGE_ITEMS_PER_EVENT = 64
export const MAX_DAWN_RECHARGE_ROLLS_PER_ITEM = 4
export const ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION = 1

const clone = (value) => structuredClone(value)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const clean = (value, maximum = 120) => String(value ?? '').trim().slice(0, maximum)

function ownerId(owner) {
  return clean(owner?.id ?? owner?.actor_id)
}

function boundedWorldMinute(value) {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, integer(value, 0)))
}

function addWorldMinutes(beforeMinute, elapsedMinutes) {
  const before = boundedWorldMinute(beforeMinute)
  const elapsed = boundedWorldMinute(elapsedMinutes)
  const remaining = Number.MAX_SAFE_INTEGER - before
  return before + Math.min(elapsed, remaining)
}

/**
 * Нулевая отметка campaign clock считается рассветом первого дня. Поэтому
 * пересечение 1440, 2880, ... минут — новый рассвет, а старт на нуле сам по
 * себе ничего не перезаряжает.
 */
export function dawnCrossings(elapsedMinutesBefore, elapsedMinutes) {
  const before = boundedWorldMinute(elapsedMinutesBefore)
  const after = addWorldMinutes(before, elapsedMinutes)
  return Math.max(0, Math.floor(after / DAWN_PERIOD_MINUTES) - Math.floor(before / DAWN_PERIOD_MINUTES))
}

function effectiveRecharge(item) {
  const catalogId = clean(item?.catalog_id ?? item?.catalogId)
  if (catalogId && catalogItem(catalogId)) {
    const profile = itemRechargeProfile(catalogId)
    const maximum = Math.max(0, Number(catalogItem(catalogId)?.charges?.max) || 0)
    return profile && maximum > 0 ? { profile, maximum } : null
  }
  const profile = normalizeItemRechargeProfile(item?.recharge)
  const maximum = Math.max(0, Math.min(1_000_000, integer(item?.charges?.max, 0)))
  return profile && maximum > 0 ? { profile, maximum } : null
}

function rechargeCandidates(state) {
  const candidates = []
  const owners = [...(Array.isArray(state?.players) ? state.players : [])]
    .sort((left, right) => ownerId(left).localeCompare(ownerId(right), 'en'))
  for (const owner of owners) {
    const id = ownerId(owner)
    if (!id) continue
    const items = [...(Array.isArray(owner?.inventory) ? owner.inventory : [])]
      .sort((left, right) => clean(left?.id ?? left?.item_id).localeCompare(clean(right?.id ?? right?.item_id), 'en'))
    for (const item of items) {
      if (integer(item?.quantity, 1) <= 0) continue
      const itemId = clean(item?.id ?? item?.item_id)
      const authority = effectiveRecharge(item)
      if (!itemId || !authority) continue
      const current = Math.max(0, Math.min(authority.maximum, integer(item?.charges?.current, authority.maximum)))
      if (current >= authority.maximum) continue
      candidates.push({
        owner_id: id,
        item_id: itemId,
        ...(item?.catalog_id ? { catalog_id: clean(item.catalog_id) } : {}),
        profile: clone(authority.profile),
        current,
        maximum: authority.maximum,
      })
    }
  }
  return candidates
}

/**
 * Все случайные числа появляются здесь, до commit. Возвращаемый payload
 * самодостаточен: reducer не знает ни о DiceService, ни о текущем каталоге.
 */
export function resolveItemDawnRecharge(state, elapsedMinutes, diceService) {
  if (!diceService || typeof diceService.roll !== 'function') {
    throw new TypeError('Перезарядка предметов требует DiceService')
  }
  const beforeMinute = boundedWorldMinute(state?.mechanics?.world_time?.elapsed_minutes)
  const elapsed = boundedWorldMinute(elapsedMinutes)
  const afterMinute = addWorldMinutes(beforeMinute, elapsed)
  const crossings = dawnCrossings(beforeMinute, elapsed)
  if (crossings <= 0) return { payload: null, rolls: [] }

  const candidates = rechargeCandidates(state)
  if (candidates.length > MAX_DAWN_RECHARGE_ITEMS_PER_EVENT) {
    const error = new RangeError(`Одна команда может перезарядить не более ${MAX_DAWN_RECHARGE_ITEMS_PER_EVENT} предметов`)
    error.code = 'ITEM_DAWN_RECHARGE_LIMIT_EXCEEDED'
    throw error
  }

  const rolls = []
  const items = []
  for (const candidate of candidates) {
    const maximumUsefulRolls = Math.ceil((candidate.maximum - candidate.current) / 2)
    const rollCount = Math.min(crossings, maximumUsefulRolls, MAX_DAWN_RECHARGE_ROLLS_PER_ITEM)
    let current = candidate.current
    const itemRolls = []
    for (let index = 0; index < rollCount && current < candidate.maximum; index += 1) {
      const roll = diceService.roll(
        candidate.profile.formula,
        `item-dawn-recharge:${candidate.item_id}`,
        candidate.owner_id,
        'gm_only',
      )
      const restored = Math.max(0, integer(roll.total, 0))
      const before = current
      current = Math.min(candidate.maximum, current + restored)
      const recorded = {
        ...clone(roll),
        dawn_index: index + 1,
        charges_before: before,
        charges_after: current,
        restored_charges: current - before,
      }
      rolls.push(clone(roll))
      itemRolls.push(recorded)
    }
    if (current <= candidate.current) continue
    items.push({
      owner_id: candidate.owner_id,
      item_id: candidate.item_id,
      ...(candidate.catalog_id ? { catalog_id: candidate.catalog_id } : {}),
      recharge: candidate.profile,
      before: candidate.current,
      after: current,
      max: candidate.maximum,
      rolls: itemRolls,
    })
  }

  return {
    payload: items.length ? {
      schema_version: ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION,
      trigger: 'dawn',
      elapsed_minutes_before: beforeMinute,
      elapsed_minutes_after: afterMinute,
      dawns_crossed: crossings,
      items,
    } : null,
    rolls,
  }
}

/**
 * Payload-only reducer. Даже если каталог позднее изменится или исчезнет,
 * старое событие воспроизводит ровно зафиксированный результат.
 */
export function applyItemDawnRechargeToPlayers(players, event) {
  if (
    Number(event?.event_schema_version) !== ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION
    || Number(event?.payload?.schema_version) !== ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION
  ) return Array.isArray(players) ? players : []
  const entries = Array.isArray(event?.payload?.items)
    ? event.payload.items.slice(0, MAX_DAWN_RECHARGE_ITEMS_PER_EVENT)
    : []
  if (!entries.length) return Array.isArray(players) ? players : []
  const byOwner = new Map()
  for (const entry of entries) {
    const owner = clean(entry?.owner_id)
    const item = clean(entry?.item_id)
    const maximum = Math.max(0, Math.min(1_000_000, integer(entry?.max, 0)))
    const after = Math.max(0, Math.min(maximum, integer(entry?.after, 0)))
    if (!owner || !item || maximum <= 0) continue
    const ownerEntries = byOwner.get(owner) ?? new Map()
    ownerEntries.set(item, { current: after, max: maximum })
    byOwner.set(owner, ownerEntries)
  }
  return (Array.isArray(players) ? players : []).map((owner) => {
    const ownerEntries = byOwner.get(ownerId(owner))
    if (!ownerEntries) return owner
    return {
      ...owner,
      inventory: (Array.isArray(owner?.inventory) ? owner.inventory : []).map((item) => {
        const charges = ownerEntries.get(clean(item?.id ?? item?.item_id))
        return charges ? { ...item, charges } : item
      }),
    }
  })
}

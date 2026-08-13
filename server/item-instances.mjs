/**
 * Экземпляр предмета — вещь, у которой есть история.
 *
 * До этого модуля в игре существовали только две формы вещи: запись каталога
 * (общий тип) и запись инвентаря героя (`normalizeInventoryItem`, форма для
 * склада и торговли). Ни одна из них не отвечает на вопрос «чей это меч и
 * откуда он взялся», а без ответа не собрать жизненный цикл добычи: гоблин
 * носит скимитар, отряд снимает его с тела, продаёт торговцу — и это должен
 * быть один и тот же предмет, а не три одинаковых записи.
 *
 * **Снимок каталога — не оптимизация, а требование replay.** Событие несёт
 * вещь целиком, поэтому пересборка баланса каталога не переписывает прошлое:
 * бой, сыгранный до правки урона скимитара, при повторном проигрывании даёт
 * тот же скимитар с теми же числами. Поэтому `normalizeItemInstance` **никогда**
 * не заглядывает в каталог — он читает только то, что пришло в payload.
 * В каталог ходит один `createItemInstance`, и только в момент создания.
 */
import { createHash } from 'node:crypto'

import { catalogItem, materializeCatalogItem } from './item-catalog.mjs'

export const ITEM_INSTANCE_SCHEMA_VERSION = 1

/** Откуда вещь взялась. Список открыт по мере появления новых источников. */
export const ITEM_INSTANCE_ORIGIN_KINDS = Object.freeze(['enemy_loadout'])

/** Кому вещь принадлежит. Тела и контейнеры появятся отдельным шагом. */
export const ITEM_INSTANCE_OWNER_KINDS = Object.freeze(['enemy'])

export const MAX_ITEM_INSTANCE_QUANTITY = 999

/**
 * Поля снимка. Ровно то, что отдаёт `materializeCatalogItem`: второго
 * авторитетного материализатора у каталога быть не должно, поэтому список
 * описывает форму, а не собирает её заново.
 */
const SNAPSHOT_FIELDS = Object.freeze([
  'catalog_id',
  'catalog_schema_version',
  'name',
  'type',
  'weight',
  'description',
  'properties',
  'base_price_cp',
  'mechanics_status',
  'rarity',
  'combat',
  'passive_effects',
  'charges',
  'recharge',
  'requires_attunement',
  // Каталог сегодня не несёт собственной картинки: изображения предметов
  // генерируются по запросу и живут в `/generated/items`. Поле объявлено в
  // снимке, а не выводится из каталога при чтении — тогда сгенерированная
  // позже картинка не подменит вид уже существующей вещи.
  'image',
])

export class ItemInstanceError extends Error {
  constructor(message, code = 'ITEM_INSTANCE_INVALID') {
    super(message)
    this.name = 'ItemInstanceError'
    this.code = code
  }
}

const clone = (value) => structuredClone(value)
const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

/**
 * Замороженный снимок каталожной записи на момент создания экземпляра.
 * @param {string} catalogId
 * @returns {Record<string, unknown>}
 */
export function itemInstanceSnapshot(catalogId) {
  const entry = catalogItem(catalogId)
  if (!entry) throw new ItemInstanceError(`Предмета ${catalogId} нет в каталоге`, 'ITEM_INSTANCE_CATALOG_UNKNOWN')
  const materialized = materializeCatalogItem(entry.catalog_id, {})
  return Object.fromEntries(SNAPSHOT_FIELDS
    .filter((field) => materialized[field] !== undefined)
    .map((field) => [field, clone(materialized[field])]))
}

function normalizeSnapshot(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const snapshot = Object.fromEntries(SNAPSHOT_FIELDS
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, clone(source[field])]))
  if (snapshot.name != null) snapshot.name = text(snapshot.name, 120)
  if (snapshot.description != null) snapshot.description = text(snapshot.description, 1_000)
  if (snapshot.properties != null) snapshot.properties = text(snapshot.properties, 1_000)
  return snapshot
}

function normalizeCharges(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const maximum = Math.max(0, integer(input.max, 0))
  if (maximum <= 0) return null
  return { current: Math.max(0, Math.min(maximum, integer(input.current, maximum))), max: maximum }
}

function normalizeOwner(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const kind = text(source.kind, 40)
  const owner = {
    kind: ITEM_INSTANCE_OWNER_KINDS.includes(kind) ? kind : '',
    actor_id: text(source.actor_id ?? source.actorId, 120),
  }
  return owner.kind && owner.actor_id ? owner : null
}

function normalizeOrigin(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const kind = text(source.kind, 40)
  if (!ITEM_INSTANCE_ORIGIN_KINDS.includes(kind)) return null
  return {
    kind,
    template_id: text(source.template_id ?? source.templateId, 120),
    source_id: text(source.source_id ?? source.sourceId, 160),
  }
}

/**
 * Создание экземпляра. Единственное место, где читается живой каталог.
 *
 * @param {{
 *   catalogId: string,
 *   instanceId: string,
 *   quantity?: number,
 *   equipped?: boolean,
 *   charges?: {current: number, max: number} | null,
 *   owner: {kind: string, actor_id: string},
 *   origin: {kind: string, template_id?: string, source_id?: string},
 *   lootable?: boolean | null,
 * }} input
 */
export function createItemInstance({
  catalogId,
  instanceId,
  quantity = 1,
  equipped = false,
  charges = null,
  owner,
  origin,
  lootable = null,
} = {}) {
  const entry = catalogItem(catalogId)
  if (!entry) throw new ItemInstanceError(`Предмета ${catalogId} нет в каталоге`, 'ITEM_INSTANCE_CATALOG_UNKNOWN')
  const id = text(instanceId, 160)
  if (!id) throw new ItemInstanceError('У экземпляра предмета должен быть item_instance_id', 'ITEM_INSTANCE_ID_REQUIRED')
  const normalizedOwner = normalizeOwner(owner)
  if (!normalizedOwner) throw new ItemInstanceError('У экземпляра предмета должен быть владелец', 'ITEM_INSTANCE_OWNER_REQUIRED')
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) throw new ItemInstanceError('У экземпляра предмета должно быть происхождение', 'ITEM_INSTANCE_ORIGIN_REQUIRED')
  const count = integer(quantity, 1)
  if (count < 1 || count > MAX_ITEM_INSTANCE_QUANTITY) {
    throw new ItemInstanceError('Количество экземпляра вне допустимых границ', 'ITEM_INSTANCE_QUANTITY_OUT_OF_RANGE')
  }
  const snapshot = itemInstanceSnapshot(entry.catalog_id)
  const instanceCharges = normalizeCharges(charges ?? snapshot.charges)
  return {
    schema_version: ITEM_INSTANCE_SCHEMA_VERSION,
    item_instance_id: id,
    catalog_id: entry.catalog_id,
    snapshot,
    quantity: count,
    // Заряды объявлены дважды намеренно и означают разное: в снимке — сколько
    // их было у каталожной записи, здесь — сколько осталось у этой вещи.
    // Стёртый набор лекаря не должен восстанавливаться при чтении снимка.
    ...(instanceCharges ? { charges: instanceCharges } : {}),
    equipped: equipped === true,
    owner: normalizedOwner,
    origin: normalizedOrigin,
    lootable: lootable == null ? entry.corpse_loot_eligible === true : lootable === true,
  }
}

/**
 * Приведение экземпляра из сохранённого состояния или payload события.
 * Каталог здесь не читается: старый бой обязан проигрываться теми числами,
 * которые в нём были.
 *
 * @returns {Record<string, unknown> | null} null — запись не является экземпляром
 */
export function normalizeItemInstance(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!source) return null
  const id = text(source.item_instance_id ?? source.itemInstanceId, 160)
  const catalogId = text(source.catalog_id ?? source.catalogId, 120)
  const owner = normalizeOwner(source.owner)
  const origin = normalizeOrigin(source.origin)
  if (!id || !catalogId || !owner || !origin) return null
  const charges = normalizeCharges(source.charges)
  return {
    schema_version: ITEM_INSTANCE_SCHEMA_VERSION,
    item_instance_id: id,
    catalog_id: catalogId,
    snapshot: normalizeSnapshot(source.snapshot),
    quantity: Math.max(1, Math.min(MAX_ITEM_INSTANCE_QUANTITY, integer(source.quantity, 1))),
    ...(charges ? { charges } : {}),
    equipped: source.equipped === true,
    owner,
    origin,
    lootable: source.lootable === true,
  }
}

/**
 * Детерминированное целое из сида. Общий помощник для всех генераторов
 * экземпляров: один сид — один и тот же инвентарь после replay и рестарта.
 */
export function seededInteger(seed, label, minimum, maximum) {
  const low = Math.min(minimum, maximum)
  const high = Math.max(minimum, maximum)
  if (high === low) return low
  const digest = createHash('sha256').update(`${seed} ${label}`).digest('hex')
  return low + (Number.parseInt(digest.slice(0, 8), 16) % (high - low + 1))
}

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
 * не ищет запись каталога — он читает только то, что пришло в payload. За
 * записью ходит один `createItemInstance`, и только в момент создания.
 * (Общие константы вроде списка статусов механики — не запись предмета: они
 * описывают словарь, а не числа конкретной вещи, и от баланса не зависят.)
 *
 * **Снимок недоверенный.** Он приезжает из сохранения и из payload события, то
 * есть и из админского импорта состояния, поэтому приведение здесь — граница
 * безопасности, а не косметика: см. `normalizeSnapshot`.
 */
import { createHash } from 'node:crypto'

import {
  ITEM_MECHANICS_STATUSES,
  catalogItem,
  materializeCatalogItem,
  normalizeItemRechargeProfile,
} from './item-catalog.mjs'
import {
  normalizeInventoryItemRarity,
  normalizeInventoryItemType,
  normalizeInventoryPassiveEffects,
} from './merchant-economy.mjs'

export const ITEM_INSTANCE_SCHEMA_VERSION = 1

/** Откуда вещь взялась. Список открыт по мере появления новых источников. */
export const ITEM_INSTANCE_ORIGIN_KINDS = Object.freeze(['enemy_loadout'])

/**
 * Кому вещь принадлежит. `container` — тело, разоружённый пленный, брошенная
 * добыча или схрон: всё, что описывает `server/loot-containers.mjs`. Владелец
 * меняется переездом экземпляра, а не пересозданием: у вещи одна история, и
 * `origin` при смене владельца не переписывается.
 */
export const ITEM_INSTANCE_OWNER_KINDS = Object.freeze(['enemy', 'container'])

export const MAX_ITEM_INSTANCE_QUANTITY = 999

/**
 * Поля снимка. Ровно то, что отдаёт `materializeCatalogItem`: второго
 * авторитетного материализатора у каталога быть не должно, поэтому список
 * описывает форму, а не собирает её заново.
 *
 * `properties` в список намеренно **не** входит, хотя материализатор его
 * отдаёт: там лежит `entry.description`, то есть байт-в-байт то же, что в поле
 * `description` рядом. Измерено на записях каталога: дубль занимал от 17 % веса
 * снимка у скимитара до 30 % у стрел и набора лекаря. События неизменяемы,
 * поэтому в журнале он остался бы навсегда и оплачивался бы на каждом replay.
 * Чтение снимка от снятия не страдает: описание вещи по-прежнему одно и на
 * своём месте, а `properties` записи инвентаря героя (`normalizeInventoryItem`)
 * это поле не теряет — там своя форма и свой владелец.
 */
const SNAPSHOT_FIELDS = Object.freeze([
  'catalog_id',
  'catalog_schema_version',
  'name',
  'type',
  'weight',
  'description',
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

/**
 * Границы снимка.
 *
 * Снимок приходит из сохранения или payload события и в каталог **не**
 * сверяется — иначе пересобранный баланс переписал бы прошлый бой. Значит,
 * границы обязаны стоять здесь и не зависеть от каталога. Числа выбраны с
 * запасом к сегодняшнему SRD 5.2.1 (самая дорогая запись — 400 000 мм, самая
 * тяжёлая — 65 фунтов), поэтому обычная вещь их не замечает, а `1e15` в цене
 * или `-1e9` в весе не доживают до торговца и до расчёта переносимого груза.
 */
export const MAX_ITEM_SNAPSHOT_NUMBER = 10_000_000
export const MAX_ITEM_SNAPSHOT_WEIGHT = 1_000
export const MAX_ITEM_INSTANCE_CHARGES = 1_000
const MAX_SNAPSHOT_DEPTH = 6
const MAX_SNAPSHOT_KEYS = 64
const MAX_SNAPSHOT_ENTRIES = 64

/**
 * Картинка вещи — локальный путь, который отдаёт сам сервер, и ничего больше.
 * Граница та же по смыслу, что у портретов врагов (`publicEnemyImage` в
 * `server/viewer-projection.mjs`): без неё снимок из чужого состояния увёл бы
 * браузер игрока на произвольный внешний адрес прямо из карточки предмета.
 */
const LOCAL_ITEM_IMAGE = /^\/(?:assets|generated)\/items\/[a-z0-9][a-z0-9-]*\.(?:png|webp|jpe?g)$/u

export class ItemInstanceError extends Error {
  constructor(message, code = 'ITEM_INSTANCE_INVALID') {
    super(message)
    this.name = 'ItemInstanceError'
    this.code = code
  }
}

const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

/**
 * Замороженный снимок каталожной записи на момент создания экземпляра.
 *
 * Снимок собирается тем же нормализатором, что и чтение сохранённого: иначе
 * `normalizeItemInstance(createItemInstance(x))` дал бы не `createItemInstance(x)`,
 * и состояние после replay разошлось бы с состоянием в момент боя.
 *
 * @param {string} catalogId
 * @returns {Record<string, unknown>}
 */
export function itemInstanceSnapshot(catalogId) {
  const entry = catalogItem(catalogId)
  if (!entry) throw new ItemInstanceError(`Предмета ${catalogId} нет в каталоге`, 'ITEM_INSTANCE_CATALOG_UNKNOWN')
  return normalizeSnapshot(materializeCatalogItem(entry.catalog_id, {}))
}

function boundedNumber(value, minimum = -MAX_ITEM_SNAPSHOT_NUMBER, maximum = MAX_ITEM_SNAPSHOT_NUMBER) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.min(maximum, Math.max(minimum, numeric))
}

/**
 * Общая рамка снимка: он — данные, а не произвольный объект. Строки обрезаются,
 * числа ограничиваются, `NaN`/`Infinity` и функции выбрасываются, глубина,
 * длина массива и число ключей ограничены. Это не заменяет адресные правила
 * ниже, а закрывает то, что в них не названо: снимок читается по имени поля,
 * и незнакомая ветка не должна уметь принести в состояние бесконечность.
 */
function boundedValue(value, depth = 0) {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return boundedNumber(value)
  if (typeof value === 'string') return text(value, 1_000)
  if (depth >= MAX_SNAPSHOT_DEPTH || !value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SNAPSHOT_ENTRIES)
      .map((entry) => boundedValue(entry, depth + 1))
      .filter((entry) => entry !== undefined)
  }
  return Object.fromEntries(Object.entries(value)
    .slice(0, MAX_SNAPSHOT_KEYS)
    .map(([key, nested]) => [text(key, 80), boundedValue(nested, depth + 1)])
    .filter(([key, nested]) => key && nested !== undefined))
}

/**
 * Приведение снимка — граница replay и загрузки сохранения, а значит граница
 * недоверенных данных: сюда приезжает и админский импорт состояния. Каталог
 * тут не спрашивают, поэтому «сверить с записью» нельзя — можно только
 * ограничить форму. Ограничивается то, что оживает в момент, когда экземпляр
 * переложат в инвентарь героя: `passive_effects` читает `activeItemEffectTotals`
 * и превращает в КД и спасброски, `base_price_cp` — это то, что заплатит
 * торговец, `image` попадает в разметку карточки.
 */
function normalizeSnapshot(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const snapshot = {}
  for (const field of SNAPSHOT_FIELDS) {
    if (source[field] === undefined) continue
    const value = boundedValue(source[field])
    if (value !== undefined) snapshot[field] = value
  }
  if (snapshot.catalog_id != null) snapshot.catalog_id = text(snapshot.catalog_id, 120)
  if (snapshot.catalog_schema_version != null) snapshot.catalog_schema_version = text(snapshot.catalog_schema_version, 120)
  if (snapshot.name != null) snapshot.name = text(snapshot.name, 120)
  if (snapshot.description != null) snapshot.description = text(snapshot.description, 1_000)
  if (snapshot.type != null) snapshot.type = normalizeInventoryItemType(snapshot.type)
  if (snapshot.rarity != null) snapshot.rarity = normalizeInventoryItemRarity(snapshot.rarity)
  if (snapshot.mechanics_status != null) {
    const status = text(snapshot.mechanics_status, 40)
    if (ITEM_MECHANICS_STATUSES.includes(status)) snapshot.mechanics_status = status
    else delete snapshot.mechanics_status
  }
  if (snapshot.weight != null) snapshot.weight = boundedNumber(snapshot.weight, 0, MAX_ITEM_SNAPSHOT_WEIGHT) ?? 0
  if (snapshot.base_price_cp != null) {
    snapshot.base_price_cp = Math.max(0, Math.min(MAX_ITEM_SNAPSHOT_NUMBER, integer(snapshot.base_price_cp, 0)))
  }
  if (snapshot.passive_effects != null) {
    const effects = normalizeInventoryPassiveEffects(snapshot.passive_effects)
    if (effects.length) snapshot.passive_effects = effects
    else delete snapshot.passive_effects
  }
  if (snapshot.charges != null) {
    const charges = normalizeCharges(snapshot.charges)
    if (charges) snapshot.charges = charges
    else delete snapshot.charges
  }
  if (snapshot.recharge != null) {
    const recharge = normalizeItemRechargeProfile(snapshot.recharge)
    if (recharge) snapshot.recharge = recharge
    else delete snapshot.recharge
  }
  if (snapshot.requires_attunement != null) snapshot.requires_attunement = snapshot.requires_attunement === true
  if (snapshot.image != null && !LOCAL_ITEM_IMAGE.test(String(snapshot.image))) delete snapshot.image
  return snapshot
}

function normalizeCharges(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const maximum = Math.max(0, Math.min(MAX_ITEM_INSTANCE_CHARGES, integer(input.max, 0)))
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

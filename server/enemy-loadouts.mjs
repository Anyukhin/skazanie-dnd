/**
 * Инвентари противников: чем существо вооружено на самом деле.
 *
 * До этого модуля добыча появлялась только после боя и из воздуха: таблица
 * `server/loot-tables.mjs` выдавала предметы по теме встречи, никак не связанные
 * с тем, кого отряд убил. Гоблин мог бить скимитаром, а с тела снимался
 * кольчужный доспех, которого на нём не было. Здесь вещь появляется **до** боя
 * и принадлежит конкретному существу.
 *
 * ## Три правила, которые здесь нельзя нарушить
 *
 * 1. **Боевые формулы стат-блока не меняются.** Инвентарь лежит в отдельном
 *    поле `enemy.loadout`, а не в `actor.inventory`: последнее читают
 *    `derivedEquipmentArmorClass` и `activeItemEffectTotals`, и надетый доспех
 *    поднял бы КД противника молча. Оружие в инвентаре — это отражение
 *    `action_profiles`, а не их источник; атака по-прежнему считается по
 *    стат-блоку.
 * 2. **Гарантированная экипировка выводится из стат-блока, а не назначается.**
 *    Список оружия строится из `action_profiles` через явную таблицу
 *    `WEAPON_CATALOG_BY_ACTION`, поэтому «инвентарь совпал с тем, чем существо
 *    бьёт» — свойство построения, а не совпадение, за которым надо следить.
 *    Доспеха в инвентарях нет намеренно: в SRD 5.2.1 стат-блок объявляет КД
 *    числом и не называет доспех, так что любая кольчуга здесь была бы
 *    выдумкой — и вдобавок риском для расчёта КД.
 * 3. **`ruling-only` не материализуется.** Движок такую вещь всё равно
 *    заблокирует до расхода ресурса; выдать её добычей значило бы подсунуть
 *    отряду неисполнимую механику. Граница проверяется на входе, а не
 *    надеждой на аккуратность таблицы.
 *
 * ## Кому инвентарь не положен
 *
 * Звери, слизни, растения, конструкты и безмозглая нежить получают пустой
 * список. Волк не носит кинжала. Скелет и зомби в SRD бьют коротким мечом и
 * кулаком, но их «снаряжение» — часть анимации трупа, а не карман: решение
 * владельца — у безмозглой нежити инвентаря нет. Великаны (огр, эттин,
 * холмовой великан) вооружены настоящими палицами и топорами, но это
 * `creature_type: 'giant'`, и шаг A1 их намеренно не трогает: гуманоиды сначала.
 *
 * ## Опциональные расходники — только `verified`
 *
 * Гарантированное оружие берётся у стат-блока и живёт со статусом `partial`
 * (базовая атака исполняется сервером, mastery — нет). Расходник же сервер
 * выбирает **сам**, поэтому планка выше: в автошаблон попадает только то, что
 * движок исполняет целиком.
 */
import { createHash } from 'node:crypto'

import { catalogItem } from './item-catalog.mjs'
import { createItemInstance, normalizeItemInstance, seededInteger } from './item-instances.mjs'

export const ENEMY_LOADOUT_SCHEMA_VERSION = 1
export const ENEMY_LOADOUT_POLICY_ID = 'enemy-loadout-v1'
export const MAX_ENEMY_LOADOUT_ITEMS = 12
export const MAX_ENEMY_PURSE_CP = 100_000

export class EnemyLoadoutError extends Error {
  constructor(message, code = 'ENEMY_LOADOUT_INVALID') {
    super(message)
    this.name = 'EnemyLoadoutError'
    this.code = code
  }
}

const id = (slug) => `srd_5_2_1:${slug}`

/**
 * `action_profiles[].id` стат-блока → запись каталога. Пары «оружие в двух
 * режимах» (`javelin-melee`/`javelin-ranged`, `spear-melee`/`spear-ranged`)
 * ведут к одной записи: это одно копьё, а не два.
 *
 * Действий, которых здесь нет, в инвентарь не попадает ничего — укус, коготь,
 * ложноножка и костяной лук гнолла оружием каталога не являются.
 */
const WEAPON_CATALOG_BY_ACTION = Object.freeze({
  dagger: id('dagger'),
  greataxe: id('greataxe'),
  greatsword: id('greatsword'),
  'hand-crossbow': id('hand-crossbow'),
  javelin: id('javelin'),
  'javelin-melee': id('javelin'),
  'javelin-ranged': id('javelin'),
  'heavy-crossbow': id('heavy-crossbow'),
  'light-crossbow': id('light-crossbow'),
  longbow: id('longbow'),
  longsword: id('longsword'),
  morningstar: id('morningstar'),
  pistol: id('pistol'),
  scimitar: id('scimitar'),
  shortbow: id('shortbow'),
  shortsword: id('shortsword'),
  sling: id('sling'),
  'spear-melee': id('spear'),
  'spear-ranged': id('spear'),
  warhammer: id('warhammer'),
})

/** Чем стреляет оружие со свойством `ammunition`. */
const AMMUNITION_BY_WEAPON = Object.freeze({
  [id('blowgun')]: id('needles-50'),
  [id('hand-crossbow')]: id('bolts-20'),
  [id('heavy-crossbow')]: id('bolts-20'),
  [id('light-crossbow')]: id('bolts-20'),
  [id('longbow')]: id('arrows-20'),
  [id('musket')]: id('firearm-bullets-10'),
  [id('pistol')]: id('firearm-bullets-10'),
  [id('shortbow')]: id('arrows-20'),
  [id('sling')]: id('sling-bullets-20'),
})

/**
 * Метательное оружие носят пучком, а не поштучно — но только когда оно не
 * основное: копьё гладиатора одно, дротики огра и стражника считаются
 * запасом. Диапазон, а не число: пять одинаковых бандитов с ровно тремя
 * дротиками выглядят как копии.
 */
const THROWN_BUNDLE = Object.freeze({ minimum: 2, maximum: 4 })

/**
 * Шаблон существа. `ammunition` — диапазон **комплектов** боеприпасов
 * (в каталоге стрелы лежат пачками по двадцать), `purse_cp` — карман в медяках,
 * `consumables` — необязательные находки с шансом в процентах.
 */
const TEMPLATES = Object.freeze({
  [id('goblin-minion')]: { ammunition: [1, 1], purse_cp: [0, 8], consumables: [] },
  [id('goblin-warrior')]: { ammunition: [1, 2], purse_cp: [0, 15], consumables: [{ catalog_id: id('oil-flask'), chance: 20 }] },
  [id('kobold')]: { ammunition: [1, 1], purse_cp: [0, 6], consumables: [] },
  [id('bandit')]: { ammunition: [1, 2], purse_cp: [2, 25], consumables: [] },
  [id('orc')]: { ammunition: [1, 1], purse_cp: [2, 20], consumables: [] },
  [id('hobgoblin')]: { ammunition: [1, 2], purse_cp: [5, 30], consumables: [{ catalog_id: id('potion-of-healing'), chance: 15 }] },
  [id('bugbear')]: { ammunition: [1, 1], purse_cp: [5, 40], consumables: [{ catalog_id: id('oil-flask'), chance: 15 }] },
  [id('scout')]: { ammunition: [1, 2], purse_cp: [5, 30], consumables: [{ catalog_id: id('healers-kit'), chance: 25 }] },
  [id('spy')]: { ammunition: [1, 2], purse_cp: [20, 80], consumables: [{ catalog_id: id('poison-basic'), chance: 35 }] },
  [id('berserker')]: { ammunition: [1, 1], purse_cp: [5, 40], consumables: [{ catalog_id: id('potion-of-healing'), chance: 20 }] },
  [id('bandit-captain')]: { ammunition: [1, 2], purse_cp: [50, 250], consumables: [{ catalog_id: id('potion-of-healing'), chance: 40 }] },
  [id('warrior-veteran')]: { ammunition: [1, 2], purse_cp: [30, 150], consumables: [{ catalog_id: id('potion-of-healing'), chance: 30 }] },
  [id('guard-captain')]: {
    ammunition: [1, 1],
    purse_cp: [40, 200],
    consumables: [{ catalog_id: id('potion-of-healing'), chance: 35 }, { catalog_id: id('healers-kit'), chance: 30 }],
  },
  [id('knight')]: { ammunition: [1, 2], purse_cp: [60, 300], consumables: [{ catalog_id: id('potion-of-healing'), chance: 35 }] },
  [id('gladiator')]: { ammunition: [1, 1], purse_cp: [40, 200], consumables: [{ catalog_id: id('potion-of-healing'), chance: 30 }] },
  [id('tough-boss')]: {
    ammunition: [1, 2],
    purse_cp: [40, 200],
    consumables: [{ catalog_id: id('potion-of-healing'), chance: 30 }, { catalog_id: id('oil-flask'), chance: 25 }],
  },
})

export const ENEMY_LOADOUT_TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES))

const EMPTY_LOADOUT = Object.freeze({
  schema_version: ENEMY_LOADOUT_SCHEMA_VERSION,
  policy_id: ENEMY_LOADOUT_POLICY_ID,
  template_id: null,
  items: Object.freeze([]),
  purse_cp: 0,
})

const clone = (value) => structuredClone(value)
const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

/**
 * Граница шаблона. Проверяется на каждом предмете при сборке, а не при
 * вычитке таблицы: тогда неисполнимая вещь не доедет до события, даже если
 * попадёт в шаблон правкой из другого файла.
 */
export function assertEnemyLoadoutItem(catalogId, { verifiedOnly = false } = {}) {
  const entry = catalogItem(catalogId)
  if (!entry) throw new EnemyLoadoutError(`Предмета ${catalogId} нет в каталоге`, 'ENEMY_LOADOUT_CATALOG_UNKNOWN')
  if (!entry.enemy_loadout_eligible) {
    throw new EnemyLoadoutError(`Предмет ${catalogId} не разрешён в инвентарях противников`, 'ENEMY_LOADOUT_ITEM_NOT_ELIGIBLE')
  }
  if (verifiedOnly && entry.mechanics_status !== 'verified') {
    throw new EnemyLoadoutError(`Расходник ${catalogId} не имеет статуса verified`, 'ENEMY_LOADOUT_CONSUMABLE_NOT_VERIFIED')
  }
  return entry
}

function weaponCatalogIdsFor(block) {
  const profiles = Array.isArray(block?.action_profiles) ? block.action_profiles : []
  const primary = WEAPON_CATALOG_BY_ACTION[String(profiles[0]?.id ?? '')] ?? null
  const ordered = []
  for (const profile of profiles) {
    const catalogId = WEAPON_CATALOG_BY_ACTION[String(profile?.id ?? '')]
    if (catalogId && !ordered.includes(catalogId)) ordered.push(catalogId)
  }
  return { primary, ordered }
}

function thrownBundle(catalogId, primaryCatalogId) {
  if (catalogId === primaryCatalogId) return null
  const properties = catalogItem(catalogId)?.weapon?.properties ?? []
  return properties.includes('thrown') ? THROWN_BUNDLE : null
}

/**
 * Инвентарь одного противника.
 *
 * @param {{
 *   statBlockId: string,
 *   block: Record<string, any>,
 *   ownerId: string,
 *   seed: string,
 *   sourceId?: string,
 * }} input
 * @returns {{schema_version: number, policy_id: string, template_id: string|null, items: Array<Record<string, unknown>>, purse_cp: number}}
 */
export function enemyLoadoutFor({ statBlockId, block, ownerId, seed, sourceId = '' } = {}) {
  const templateId = text(statBlockId, 120)
  const template = TEMPLATES[templateId]
  const owner = text(ownerId, 120)
  if (!template || !owner) return clone(EMPTY_LOADOUT)
  const loadoutSeed = createHash('sha256').update(`${ENEMY_LOADOUT_POLICY_ID} ${seed ?? ''} ${owner}`).digest('hex')
  const { primary, ordered } = weaponCatalogIdsFor(block)
  const items = []
  const push = (catalogId, { quantity = 1, equipped = false } = {}) => {
    if (items.length >= MAX_ENEMY_LOADOUT_ITEMS) return
    items.push(createItemInstance({
      catalogId,
      instanceId: `${owner}-item-${items.length + 1}`.slice(0, 160),
      quantity,
      equipped,
      owner: { kind: 'enemy', actor_id: owner },
      origin: { kind: 'enemy_loadout', template_id: templateId, source_id: text(sourceId, 160) },
    }))
  }

  for (const catalogId of ordered) {
    assertEnemyLoadoutItem(catalogId)
    const bundle = thrownBundle(catalogId, primary)
    const quantity = bundle ? seededInteger(loadoutSeed, `thrown:${catalogId}`, bundle.minimum, bundle.maximum) : 1
    push(catalogId, { quantity, equipped: catalogId === primary })
  }

  const [ammunitionMinimum, ammunitionMaximum] = template.ammunition
  const ammunitionSeen = new Set()
  for (const catalogId of ordered) {
    const ammunitionId = AMMUNITION_BY_WEAPON[catalogId]
    if (!ammunitionId || ammunitionSeen.has(ammunitionId)) continue
    ammunitionSeen.add(ammunitionId)
    assertEnemyLoadoutItem(ammunitionId)
    push(ammunitionId, {
      quantity: seededInteger(loadoutSeed, `ammunition:${ammunitionId}`, ammunitionMinimum, ammunitionMaximum),
    })
  }

  for (const candidate of template.consumables) {
    assertEnemyLoadoutItem(candidate.catalog_id, { verifiedOnly: true })
    const roll = seededInteger(loadoutSeed, `consumable:${candidate.catalog_id}`, 0, 99)
    if (roll < candidate.chance) push(candidate.catalog_id)
  }

  const [purseMinimum, purseMaximum] = template.purse_cp
  return {
    schema_version: ENEMY_LOADOUT_SCHEMA_VERSION,
    policy_id: ENEMY_LOADOUT_POLICY_ID,
    template_id: templateId,
    items,
    purse_cp: Math.min(MAX_ENEMY_PURSE_CP, seededInteger(loadoutSeed, 'purse', purseMinimum, purseMaximum)),
  }
}

/**
 * Приведение инвентаря из сохранённого состояния. Кампании, сыгранные до этого
 * шага, поля не знают — у их противников инвентарь пустой, а не отсутствующий.
 */
export function normalizeEnemyLoadout(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const templateId = text(source.template_id ?? source.templateId, 120)
  return {
    schema_version: ENEMY_LOADOUT_SCHEMA_VERSION,
    policy_id: ENEMY_LOADOUT_POLICY_ID,
    template_id: templateId || null,
    items: (Array.isArray(source.items) ? source.items : [])
      .slice(0, MAX_ENEMY_LOADOUT_ITEMS)
      .map((item) => normalizeItemInstance(item))
      .filter(Boolean),
    purse_cp: Math.max(0, Math.min(MAX_ENEMY_PURSE_CP, integer(source.purse_cp ?? source.purseCp, 0))),
  }
}

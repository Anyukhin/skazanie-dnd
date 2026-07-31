export const ITEM_CATALOG_SCHEMA_VERSION = 'skazanie:item-catalog:v1'

export const ITEM_CATALOG_SOURCE = Object.freeze({
  source_url: 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf',
  source_version: 'SRD 5.2.1',
  source_sha256: '8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87',
  license: 'CC-BY-4.0',
  attribution: 'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
})

export const ITEM_MECHANICS_STATUSES = Object.freeze(['verified', 'partial', 'ruling-only'])
export const ITEM_AVAILABILITY_CHANNELS = Object.freeze(['shop', 'loot', 'crafting'])
export const ITEM_RECHARGE_SCHEMA_VERSION = 1

const SHOP_IDS = new Set([
  'srd_5_2_1:dagger',
  'srd_5_2_1:longsword',
  'srd_5_2_1:longbow',
  'srd_5_2_1:shortbow',
  'srd_5_2_1:leather-armor',
  'srd_5_2_1:shield',
  'srd_5_2_1:explorers-pack',
  'srd_5_2_1:potion-of-healing',
  'srd_5_2_1:rations-one-day',
  'srd_5_2_1:rope-hempen-50-feet',
  'srd_5_2_1:torch',
  'srd_5_2_1:arrows-20',
])

const LOOT_IDS = new Set([
  'srd_5_2_1:torch',
  'srd_5_2_1:rations-one-day',
  'srd_5_2_1:rope-hempen-50-feet',
  'srd_5_2_1:arrows-20',
  'srd_5_2_1:dagger',
  'srd_5_2_1:shield',
  'srd_5_2_1:leather-armor',
  'srd_5_2_1:longsword',
  'srd_5_2_1:potion-of-healing',
])

const IMPLEMENTED_WEAPON_COMBAT = new Set([
  'srd_5_2_1:dagger',
  'srd_5_2_1:longsword',
  'srd_5_2_1:longbow',
  'srd_5_2_1:shortbow',
])

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function clone(value) {
  return structuredClone(value)
}

export function normalizeItemRechargeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  if (Number(input.schema_version) !== ITEM_RECHARGE_SCHEMA_VERSION) return null
  if (String(input.trigger ?? '').trim().toLowerCase() !== 'dawn') return null
  if (String(input.formula ?? '').trim().toLowerCase().replace(/\s+/g, '') !== '1d6+1') return null
  return {
    schema_version: ITEM_RECHARGE_SCHEMA_VERSION,
    trigger: 'dawn',
    formula: '1d6+1',
  }
}

function availability(catalogId) {
  return {
    shop: SHOP_IDS.has(catalogId),
    loot: LOOT_IDS.has(catalogId),
    crafting: false,
  }
}

function provenance(sourcePage, { sourcePages = null, mechanicsSourcePage = null } = {}) {
  return {
    ...ITEM_CATALOG_SOURCE,
    source_page: sourcePage,
    ...(sourcePages ? { source_pages: sourcePages } : {}),
    ...(mechanicsSourcePage ? { mechanics_source_page: mechanicsSourcePage } : {}),
  }
}

function titleCaseDamageType(value) {
  return {
    bludgeoning: 'дробящий',
    piercing: 'колющий',
    slashing: 'рубящий',
  }[value] ?? value
}

function weaponEntry({
  id,
  name,
  group,
  damage,
  damageType,
  properties = [],
  mastery,
  weight,
  price,
  normalRange = 5,
  longRange = null,
}) {
  const catalogId = `srd_5_2_1:${id}`
  const ranged = group.endsWith('ranged')
  const finesse = properties.includes('finesse')
  const combatRange = ranged ? normalRange : properties.includes('reach') ? 10 : 5
  const combat = IMPLEMENTED_WEAPON_COMBAT.has(catalogId)
    ? {
        kind: ranged ? 'ranged' : 'melee',
        ability: ranged || finesse ? 'dex' : 'str',
        damage,
        damageType,
        normalRange: combatRange,
        ...(ranged && longRange != null ? { longRange } : {}),
        ...(properties.includes('two-handed') ? { twoHanded: true } : {}),
        ...(properties.includes('ammunition') ? { ammunition: true } : {}),
      }
    : null
  return {
    catalog_id: catalogId,
    ...ITEM_CATALOG_SOURCE,
    display_name: name,
    name,
    manifest_section: 'weapon',
    description: `${name} — обычное оружие: ${damage} ${titleCaseDamageType(damageType)} урона. Полный эффект свойств и мастерства не автоматизирован.`,
    category: 'weapon',
    type: 'weapon',
    price_cp: price,
    base_price_cp: price,
    weight,
    lifecycle: { equippable: true, equip_slot: 'main_hand', transferable: true, stackable: false },
    equip: { slot: 'main_hand' },
    combat,
    use: null,
    attunement: { required: false },
    charges: null,
    recharge: null,
    crafting: { implemented: false, hooks: [] },
    weapon: { group, damage, damage_type: damageType, properties, mastery, normal_range_feet: normalRange, long_range_feet: longRange },
    mechanics_status: 'partial',
    limitation: combat
      ? 'Базовая атака исполнима, но mastery, versatile, reach, thrown и расход ammunition полностью не поддержаны.'
      : 'Сохранены точные параметры SRD; боевой профиль ещё не подключён к Rules Engine.',
    availability: availability(catalogId),
    source_page: 91,
    provenance: provenance(91),
  }
}

function armorEntry({
  id,
  name,
  category,
  armorClassBase = null,
  dexterityCap = null,
  armorClassBonus = null,
  strength = null,
  stealthDisadvantage = false,
  weight,
  price,
}) {
  const catalogId = `srd_5_2_1:${id}`
  const shield = category === 'shield'
  const armorProfile = shield
    ? { kind: 'shield', armorClassBonus, speedPenalty: 0 }
    : { kind: 'armor', armorClassBase, dexterityCap, speedPenalty: 0 }
  return {
    catalog_id: catalogId,
    ...ITEM_CATALOG_SOURCE,
    display_name: name,
    name,
    manifest_section: 'armor',
    description: shield
      ? `${name} даёт +${armorClassBonus} к КД. Требования тренировки и действие надевания пока не автоматизированы.`
      : `${name} задаёт базовый КД ${armorClassBase}${dexterityCap === 0 ? '' : dexterityCap == null ? ' + Ловкость' : ` + Ловкость (не более ${dexterityCap})`}.`,
    category: 'armor',
    type: 'armor',
    price_cp: price,
    base_price_cp: price,
    weight,
    lifecycle: { equippable: true, equip_slot: shield ? 'off_hand' : 'body', transferable: true, stackable: false },
    equip: { slot: shield ? 'off_hand' : 'body', armor: armorProfile },
    combat: null,
    use: null,
    attunement: { required: false },
    charges: null,
    recharge: null,
    crafting: { implemented: false, hooks: [] },
    armor: {
      category,
      armor_class_base: armorClassBase,
      dexterity_cap: dexterityCap,
      armor_class_bonus: armorClassBonus,
      strength,
      stealth_disadvantage: stealthDisadvantage,
    },
    mechanics_status: 'partial',
    limitation: 'КД считается сервером; training, Stealth, условный штраф скорости и время don/doff пока не исполняются полностью.',
    availability: availability(catalogId),
    source_page: 92,
    provenance: provenance(92),
  }
}

function ammunitionEntry({ id, name, amount, storage, weight, price }) {
  const catalogId = `srd_5_2_1:${id}`
  return {
    catalog_id: catalogId,
    ...ITEM_CATALOG_SOURCE,
    display_name: name,
    name,
    manifest_section: 'ammunition',
    description: `${name}: комплект из ${amount} шт.; обычное хранилище — ${storage}. Расход боеприпасов в бою пока не учитывается.`,
    category: 'ammunition',
    type: 'other',
    price_cp: price,
    base_price_cp: price,
    weight,
    lifecycle: { equippable: false, equip_slot: null, transferable: true, stackable: true },
    equip: null,
    combat: null,
    use: null,
    attunement: { required: false },
    charges: null,
    recharge: null,
    crafting: { implemented: false, hooks: [] },
    ammunition: { amount, storage },
    mechanics_status: 'partial',
    limitation: 'Покупка, хранение и передача исполнимы; автоматический расход боеприпасов оружием не реализован.',
    availability: availability(catalogId),
    source_page: 96,
    provenance: provenance(96),
  }
}

function toolEntry({
  id,
  name,
  ability,
  weight,
  price,
  hooks = [],
  craftingFamilies = [],
  manifestSection = 'artisan-tool',
  sourcePage = 93,
  sourcePages = null,
}) {
  const catalogId = `srd_5_2_1:${id}`
  return {
    catalog_id: catalogId,
    ...ITEM_CATALOG_SOURCE,
    display_name: name,
    name,
    manifest_section: manifestSection,
    description: `${name} связаны с проверками характеристики «${ability}»; конкретные действия и изготовление требуют отдельного серверного правила.`,
    category: 'tool',
    type: 'tool',
    price_cp: price,
    base_price_cp: price,
    weight,
    lifecycle: { equippable: false, equip_slot: null, transferable: true, stackable: false },
    equip: null,
    combat: null,
    use: null,
    attunement: { required: false },
    charges: null,
    recharge: null,
    crafting: { implemented: false, hooks },
    crafting_families: craftingFamilies,
    tool: { ability },
    mechanics_status: 'ruling-only',
    limitation: 'Каталог хранит точные цену, вес и crafting hooks, но Utilize/Craft не исполняются движком.',
    availability: availability(catalogId),
    source_page: sourcePage,
    ...(sourcePages ? { source_pages: sourcePages } : {}),
    provenance: provenance(sourcePage, { sourcePages }),
  }
}

function gearEntry({
  id,
  name,
  type = 'tool',
  weight,
  price,
  description,
  use = null,
  charges = null,
  stackable = true,
  mechanicsStatus = null,
  limitation,
  mechanicsSourcePage = null,
}) {
  const catalogId = `srd_5_2_1:${id}`
  const partial = SHOP_IDS.has(catalogId) || use != null
  const sourcePages = mechanicsSourcePage ? [95, mechanicsSourcePage] : null
  return {
    catalog_id: catalogId,
    ...ITEM_CATALOG_SOURCE,
    display_name: name,
    name,
    manifest_section: 'practical-gear',
    description,
    category: type === 'consumable' ? 'consumable' : type === 'other' ? 'gear' : 'tool',
    type,
    price_cp: price,
    base_price_cp: price,
    weight,
    lifecycle: { equippable: false, equip_slot: null, transferable: true, stackable },
    equip: null,
    combat: null,
    use,
    attunement: { required: false },
    charges,
    recharge: null,
    crafting: { implemented: false, hooks: [] },
    mechanics_status: mechanicsStatus ?? (partial ? 'partial' : 'ruling-only'),
    limitation,
    availability: availability(catalogId),
    source_page: 95,
    ...(sourcePages ? { source_pages: sourcePages } : {}),
    ...(mechanicsSourcePage ? { mechanics_source_page: mechanicsSourcePage } : {}),
    provenance: provenance(95, { sourcePages, mechanicsSourcePage }),
  }
}

const WEAPONS = [
  { id: 'club', name: 'Дубинка', group: 'simple-melee', damage: '1d4', damageType: 'bludgeoning', properties: ['light'], mastery: 'slow', weight: 2, price: 10 },
  { id: 'dagger', name: 'Кинжал', group: 'simple-melee', damage: '1d4', damageType: 'piercing', properties: ['finesse', 'light', 'thrown'], mastery: 'nick', weight: 1, price: 200, normalRange: 20, longRange: 60 },
  { id: 'greatclub', name: 'Большая дубинка', group: 'simple-melee', damage: '1d8', damageType: 'bludgeoning', properties: ['two-handed'], mastery: 'push', weight: 10, price: 20 },
  { id: 'handaxe', name: 'Ручной топор', group: 'simple-melee', damage: '1d6', damageType: 'slashing', properties: ['light', 'thrown'], mastery: 'vex', weight: 2, price: 500, normalRange: 20, longRange: 60 },
  { id: 'javelin', name: 'Дротик', group: 'simple-melee', damage: '1d6', damageType: 'piercing', properties: ['thrown'], mastery: 'slow', weight: 2, price: 50, normalRange: 30, longRange: 120 },
  { id: 'light-hammer', name: 'Лёгкий молот', group: 'simple-melee', damage: '1d4', damageType: 'bludgeoning', properties: ['light', 'thrown'], mastery: 'nick', weight: 2, price: 200, normalRange: 20, longRange: 60 },
  { id: 'mace', name: 'Булава', group: 'simple-melee', damage: '1d6', damageType: 'bludgeoning', properties: [], mastery: 'sap', weight: 4, price: 500 },
  { id: 'quarterstaff', name: 'Боевой посох', group: 'simple-melee', damage: '1d6', damageType: 'bludgeoning', properties: ['versatile-1d8'], mastery: 'topple', weight: 4, price: 20 },
  { id: 'sickle', name: 'Серп', group: 'simple-melee', damage: '1d4', damageType: 'slashing', properties: ['light'], mastery: 'nick', weight: 2, price: 100 },
  { id: 'spear', name: 'Копьё', group: 'simple-melee', damage: '1d6', damageType: 'piercing', properties: ['thrown', 'versatile-1d8'], mastery: 'sap', weight: 3, price: 100, normalRange: 20, longRange: 60 },
  { id: 'dart', name: 'Метательный дротик', group: 'simple-ranged', damage: '1d4', damageType: 'piercing', properties: ['finesse', 'thrown'], mastery: 'vex', weight: 0.25, price: 5, normalRange: 20, longRange: 60 },
  { id: 'light-crossbow', name: 'Лёгкий арбалет', group: 'simple-ranged', damage: '1d8', damageType: 'piercing', properties: ['ammunition', 'loading', 'two-handed'], mastery: 'slow', weight: 5, price: 2_500, normalRange: 80, longRange: 320 },
  { id: 'shortbow', name: 'Короткий лук', group: 'simple-ranged', damage: '1d6', damageType: 'piercing', properties: ['ammunition', 'two-handed'], mastery: 'vex', weight: 2, price: 2_500, normalRange: 80, longRange: 320 },
  { id: 'sling', name: 'Праща', group: 'simple-ranged', damage: '1d4', damageType: 'bludgeoning', properties: ['ammunition'], mastery: 'slow', weight: 0, price: 10, normalRange: 30, longRange: 120 },
  { id: 'battleaxe', name: 'Боевой топор', group: 'martial-melee', damage: '1d8', damageType: 'slashing', properties: ['versatile-1d10'], mastery: 'topple', weight: 4, price: 1_000 },
  { id: 'flail', name: 'Кистень', group: 'martial-melee', damage: '1d8', damageType: 'bludgeoning', properties: [], mastery: 'sap', weight: 2, price: 1_000 },
  { id: 'glaive', name: 'Глефа', group: 'martial-melee', damage: '1d10', damageType: 'slashing', properties: ['heavy', 'reach', 'two-handed'], mastery: 'graze', weight: 6, price: 2_000, normalRange: 10 },
  { id: 'greataxe', name: 'Секира', group: 'martial-melee', damage: '1d12', damageType: 'slashing', properties: ['heavy', 'two-handed'], mastery: 'cleave', weight: 7, price: 3_000 },
  { id: 'greatsword', name: 'Двуручный меч', group: 'martial-melee', damage: '2d6', damageType: 'slashing', properties: ['heavy', 'two-handed'], mastery: 'graze', weight: 6, price: 5_000 },
  { id: 'halberd', name: 'Алебарда', group: 'martial-melee', damage: '1d10', damageType: 'slashing', properties: ['heavy', 'reach', 'two-handed'], mastery: 'cleave', weight: 6, price: 2_000, normalRange: 10 },
  { id: 'lance', name: 'Пика всадника', group: 'martial-melee', damage: '1d10', damageType: 'piercing', properties: ['heavy', 'reach', 'two-handed-unless-mounted'], mastery: 'topple', weight: 6, price: 1_000, normalRange: 10 },
  { id: 'longsword', name: 'Длинный меч', group: 'martial-melee', damage: '1d8', damageType: 'slashing', properties: ['versatile-1d10'], mastery: 'sap', weight: 3, price: 1_500 },
  { id: 'maul', name: 'Молот', group: 'martial-melee', damage: '2d6', damageType: 'bludgeoning', properties: ['heavy', 'two-handed'], mastery: 'topple', weight: 10, price: 1_000 },
  { id: 'morningstar', name: 'Моргенштерн', group: 'martial-melee', damage: '1d8', damageType: 'piercing', properties: [], mastery: 'sap', weight: 4, price: 1_500 },
  { id: 'pike', name: 'Длинная пика', group: 'martial-melee', damage: '1d10', damageType: 'piercing', properties: ['heavy', 'reach', 'two-handed'], mastery: 'push', weight: 18, price: 500, normalRange: 10 },
  { id: 'rapier', name: 'Рапира', group: 'martial-melee', damage: '1d8', damageType: 'piercing', properties: ['finesse'], mastery: 'vex', weight: 2, price: 2_500 },
  { id: 'scimitar', name: 'Скимитар', group: 'martial-melee', damage: '1d6', damageType: 'slashing', properties: ['finesse', 'light'], mastery: 'nick', weight: 3, price: 2_500 },
  { id: 'shortsword', name: 'Короткий меч', group: 'martial-melee', damage: '1d6', damageType: 'piercing', properties: ['finesse', 'light'], mastery: 'vex', weight: 2, price: 1_000 },
  { id: 'trident', name: 'Трезубец', group: 'martial-melee', damage: '1d8', damageType: 'piercing', properties: ['thrown', 'versatile-1d10'], mastery: 'topple', weight: 4, price: 500, normalRange: 20, longRange: 60 },
  { id: 'warhammer', name: 'Боевой молот', group: 'martial-melee', damage: '1d8', damageType: 'bludgeoning', properties: ['versatile-1d10'], mastery: 'push', weight: 5, price: 1_500 },
  { id: 'war-pick', name: 'Боевой клевец', group: 'martial-melee', damage: '1d8', damageType: 'piercing', properties: ['versatile-1d10'], mastery: 'sap', weight: 2, price: 500 },
  { id: 'whip', name: 'Кнут', group: 'martial-melee', damage: '1d4', damageType: 'slashing', properties: ['finesse', 'reach'], mastery: 'slow', weight: 3, price: 200, normalRange: 10 },
  { id: 'blowgun', name: 'Духовая трубка', group: 'martial-ranged', damage: '1', damageType: 'piercing', properties: ['ammunition', 'loading'], mastery: 'vex', weight: 1, price: 1_000, normalRange: 25, longRange: 100 },
  { id: 'hand-crossbow', name: 'Ручной арбалет', group: 'martial-ranged', damage: '1d6', damageType: 'piercing', properties: ['ammunition', 'light', 'loading'], mastery: 'vex', weight: 3, price: 7_500, normalRange: 30, longRange: 120 },
  { id: 'heavy-crossbow', name: 'Тяжёлый арбалет', group: 'martial-ranged', damage: '1d10', damageType: 'piercing', properties: ['ammunition', 'heavy', 'loading', 'two-handed'], mastery: 'push', weight: 18, price: 5_000, normalRange: 100, longRange: 400 },
  { id: 'longbow', name: 'Длинный лук', group: 'martial-ranged', damage: '1d8', damageType: 'piercing', properties: ['ammunition', 'heavy', 'two-handed'], mastery: 'slow', weight: 2, price: 5_000, normalRange: 150, longRange: 600 },
  { id: 'musket', name: 'Мушкет', group: 'martial-ranged', damage: '1d12', damageType: 'piercing', properties: ['ammunition', 'loading', 'two-handed'], mastery: 'slow', weight: 10, price: 50_000, normalRange: 40, longRange: 120 },
  { id: 'pistol', name: 'Пистолет', group: 'martial-ranged', damage: '1d10', damageType: 'piercing', properties: ['ammunition', 'loading'], mastery: 'vex', weight: 3, price: 25_000, normalRange: 30, longRange: 90 },
]

const ARMOR = [
  { id: 'padded-armor', name: 'Стёганый доспех', category: 'light', armorClassBase: 11, dexterityCap: null, stealthDisadvantage: true, weight: 8, price: 500 },
  { id: 'leather-armor', name: 'Кожаный доспех', category: 'light', armorClassBase: 11, dexterityCap: null, weight: 10, price: 1_000 },
  { id: 'studded-leather-armor', name: 'Клёпаный кожаный доспех', category: 'light', armorClassBase: 12, dexterityCap: null, weight: 13, price: 4_500 },
  { id: 'hide-armor', name: 'Шкурный доспех', category: 'medium', armorClassBase: 12, dexterityCap: 2, weight: 12, price: 1_000 },
  { id: 'chain-shirt', name: 'Кольчужная рубаха', category: 'medium', armorClassBase: 13, dexterityCap: 2, weight: 20, price: 5_000 },
  { id: 'scale-mail', name: 'Чешуйчатый доспех', category: 'medium', armorClassBase: 14, dexterityCap: 2, stealthDisadvantage: true, weight: 45, price: 5_000 },
  { id: 'breastplate', name: 'Кираса', category: 'medium', armorClassBase: 14, dexterityCap: 2, weight: 20, price: 40_000 },
  { id: 'half-plate-armor', name: 'Полулаты', category: 'medium', armorClassBase: 15, dexterityCap: 2, stealthDisadvantage: true, weight: 40, price: 75_000 },
  { id: 'ring-mail', name: 'Кольчатый доспех', category: 'heavy', armorClassBase: 14, dexterityCap: 0, stealthDisadvantage: true, weight: 40, price: 3_000 },
  { id: 'chain-mail', name: 'Кольчуга', category: 'heavy', armorClassBase: 16, dexterityCap: 0, strength: 13, stealthDisadvantage: true, weight: 55, price: 7_500 },
  { id: 'splint-armor', name: 'Ламеллярный доспех', category: 'heavy', armorClassBase: 17, dexterityCap: 0, strength: 15, stealthDisadvantage: true, weight: 60, price: 20_000 },
  { id: 'plate-armor', name: 'Латы', category: 'heavy', armorClassBase: 18, dexterityCap: 0, strength: 15, stealthDisadvantage: true, weight: 65, price: 150_000 },
  { id: 'shield', name: 'Щит', category: 'shield', armorClassBonus: 2, weight: 6, price: 1_000 },
]

const AMMUNITION = [
  { id: 'arrows-20', name: 'Стрелы, 20 штук', amount: 20, storage: 'quiver', weight: 1, price: 100 },
  { id: 'bolts-20', name: 'Арбалетные болты, 20 штук', amount: 20, storage: 'case', weight: 1.5, price: 100 },
  { id: 'firearm-bullets-10', name: 'Огнестрельные пули, 10 штук', amount: 10, storage: 'pouch', weight: 2, price: 300 },
  { id: 'sling-bullets-20', name: 'Пули для пращи, 20 штук', amount: 20, storage: 'pouch', weight: 1.5, price: 4 },
  { id: 'needles-50', name: 'Иглы, 50 штук', amount: 50, storage: 'pouch', weight: 1, price: 100 },
]

const TOOLS = [
  { id: 'alchemists-supplies', name: 'Алхимические принадлежности', ability: 'Интеллект', weight: 8, price: 5_000, hooks: ['srd_5_2_1:acid', 'srd_5_2_1:alchemists-fire', 'srd_5_2_1:oil-flask'], craftingFamilies: ['alchemical-gear'] },
  { id: 'brewers-supplies', name: 'Принадлежности пивовара', ability: 'Интеллект', weight: 9, price: 2_000, hooks: ['srd_5_2_1:antitoxin'], craftingFamilies: ['brewed-remedies'] },
  { id: 'calligraphers-supplies', name: 'Принадлежности каллиграфа', ability: 'Ловкость', weight: 5, price: 1_000, craftingFamilies: ['written-gear', 'spell-scroll'] },
  { id: 'carpenters-tools', name: 'Инструменты плотника', ability: 'Сила', weight: 6, price: 800, craftingFamilies: ['wooden-gear'] },
  { id: 'cartographers-tools', name: 'Инструменты картографа', ability: 'Мудрость', weight: 6, price: 1_500, craftingFamilies: ['map'] },
  { id: 'cobblers-tools', name: 'Инструменты сапожника', ability: 'Ловкость', weight: 5, price: 500, hooks: ['srd_5_2_1:climbers-kit'], craftingFamilies: ['footwear'] },
  { id: 'cooks-utensils', name: 'Кухонная утварь', ability: 'Мудрость', weight: 8, price: 100, hooks: ['srd_5_2_1:rations-one-day'], craftingFamilies: ['food'] },
  { id: 'glassblowers-tools', name: 'Инструменты стеклодува', ability: 'Интеллект', weight: 5, price: 3_000, craftingFamilies: ['glassware'] },
  { id: 'jewelers-tools', name: 'Инструменты ювелира', ability: 'Интеллект', weight: 2, price: 2_500, craftingFamilies: ['jewelry', 'ornamental-focus'] },
  { id: 'leatherworkers-tools', name: 'Инструменты кожевника', ability: 'Ловкость', weight: 5, price: 500, craftingFamilies: ['leather-goods'] },
  { id: 'masons-tools', name: 'Инструменты каменщика', ability: 'Сила', weight: 8, price: 1_000, craftingFamilies: ['stone-gear'] },
  { id: 'painters-supplies', name: 'Принадлежности художника', ability: 'Мудрость', weight: 5, price: 1_000, craftingFamilies: ['painted-gear'] },
  { id: 'potters-tools', name: 'Инструменты гончара', ability: 'Интеллект', weight: 3, price: 1_000, craftingFamilies: ['ceramic-gear'] },
  { id: 'smiths-tools', name: 'Инструменты кузнеца', ability: 'Сила', weight: 8, price: 2_000, craftingFamilies: ['metal-weapons', 'medium-armor', 'heavy-armor', 'metal-gear'], sourcePages: [93, 94] },
  { id: 'tinkers-tools', name: 'Инструменты ремонтника', ability: 'Ловкость', weight: 10, price: 5_000, craftingFamilies: ['firearms', 'mechanical-gear'], sourcePage: 94 },
  { id: 'weavers-tools', name: 'Инструменты ткача', ability: 'Ловкость', weight: 5, price: 100, craftingFamilies: ['cloth-goods'], sourcePage: 94 },
  { id: 'woodcarvers-tools', name: 'Инструменты резчика по дереву', ability: 'Ловкость', weight: 5, price: 100, craftingFamilies: ['wooden-weapons', 'ammunition', 'wooden-focus'], sourcePage: 94 },
]

const OTHER_TOOLS = [
  {
    id: 'herbalism-kit',
    name: 'Набор травника',
    ability: 'Интеллект',
    weight: 3,
    price: 500,
    hooks: [
      'srd_5_2_1:antitoxin',
      'srd_5_2_1:healers-kit',
      'srd_5_2_1:potion-of-healing',
    ],
    craftingFamilies: ['herbal-remedies'],
    manifestSection: 'other-tool',
    sourcePage: 94,
  },
]

const GEAR = [
  { id: 'acid', name: 'Кислота', type: 'consumable', weight: 1, price: 2_500, description: 'Склянка кислоты; её боевое применение требует отдельного серверного действия.', limitation: 'Attack replacement и спасбросок кислоты не реализованы.' },
  { id: 'alchemists-fire', name: 'Алхимический огонь', type: 'consumable', weight: 1, price: 5_000, description: 'Склянка горючей смеси; каталог не исполняет её продолжительное горение.', limitation: 'Attack replacement, горение и тушение не реализованы.' },
  { id: 'antitoxin', name: 'Противоядие', type: 'consumable', weight: 0, price: 5_000, description: 'Флакон противоядия; заявленное преимущество против яда пока не исполняется.', limitation: 'Bonus Action и часовой эффект против Poisoned не реализованы.' },
  { id: 'backpack', name: 'Рюкзак', weight: 5, price: 200, description: 'Дорожный рюкзак для переноски снаряжения.', limitation: 'Объём контейнера не моделируется.' },
  { id: 'ball-bearings', name: 'Шарики, мешочек', weight: 2, price: 100, description: 'Мешочек металлических шариков для создания препятствия.', limitation: 'Рассыпание, площадь и падение не исполняются Rules Engine.' },
  { id: 'bedroll', name: 'Спальный мешок', weight: 7, price: 100, description: 'Свёрнутая походная постель.', limitation: 'Бонусы отдыха от снаряжения не моделируются.' },
  { id: 'caltrops', name: 'Калтропы', weight: 2, price: 100, description: 'Набор острых шипов для перекрытия участка пути.', limitation: 'Размещение, урон и замедление не реализованы.' },
  { id: 'climbers-kit', name: 'Набор скалолаза', weight: 12, price: 2_500, description: 'Ремни и крепления для безопасного подъёма.', limitation: 'Якорение и ограничения перемещения не реализованы.' },
  { id: 'crowbar', name: 'Лом', weight: 5, price: 200, description: 'Прочный рычаг для силовой работы.', limitation: 'Ситуативное преимущество требует ruling.' },
  { id: 'explorers-pack', name: 'Набор путешественника', weight: 55, price: 1_000, description: 'Собранный комплект обычного дорожного снаряжения.', limitation: 'Содержимое набора не разворачивается в отдельные предметы автоматически.' },
  { id: 'grappling-hook', name: 'Крюк-кошка', weight: 4, price: 200, description: 'Металлический крюк для закрепления верёвки.', limitation: 'Бросок и закрепление требуют ruling.' },
  {
    id: 'healers-kit',
    name: 'Набор лекаря',
    weight: 3,
    price: 500,
    description: 'Набор перевязочных материалов для первой помощи. Одно из десяти применений стабилизирует живого героя с 0 хитов без проверки Мудрости (Медицина).',
    use: { kind: 'stabilize', consumes: 0, charges_per_use: 1, combat_action: 'action', range_feet: 5, target: 'party' },
    charges: { current: 10, max: 10 },
    stackable: false,
    mechanicsStatus: 'verified',
    limitation: 'Стабилизация, десять применений и расход действия исполняются Rules Engine; лечение хитов набор не выполняет.',
  },
  { id: 'holy-water', name: 'Святая вода', type: 'consumable', weight: 1, price: 2_500, description: 'Склянка освящённой воды.', limitation: 'Бросок и особый урон по типам существ не реализованы.' },
  { id: 'hunting-trap', name: 'Охотничий капкан', weight: 25, price: 500, description: 'Механический капкан для удержания цели.', limitation: 'Установка, спасбросок, урон и удержание не реализованы.' },
  { id: 'lantern-hooded', name: 'Закрытый фонарь', weight: 2, price: 500, description: 'Фонарь с заслонкой для управления светом.', limitation: 'Топливо и световой радиус не связаны с картой.' },
  { id: 'manacles', name: 'Кандалы', weight: 6, price: 200, description: 'Металлические оковы для существа подходящего размера.', limitation: 'Надевание, побег и прочность не реализованы.' },
  { id: 'oil-flask', name: 'Масло, фляга', type: 'consumable', weight: 1, price: 10, description: 'Фляга обычного горючего масла.', limitation: 'Разлив, поджигание и продолжительный урон не реализованы.' },
  { id: 'poison-basic', name: 'Простой яд', type: 'consumable', weight: 0, price: 10_000, description: 'Доза простого яда для нанесения на оружие или боеприпас.', limitation: 'Нанесение, длительность и спасбросок не реализованы.' },
  {
    id: 'potion-of-healing',
    name: 'Зелье лечения',
    type: 'consumable',
    weight: 0.5,
    price: 5_000,
    description: 'Выпитое зелье восстанавливает 2к4 + 2 хита.',
    use: { kind: 'healing', expression: '2d4+2', consumes: 1, combat_action: 'bonus_action', range_feet: 5, target: 'party' },
    mechanicsStatus: 'verified',
    limitation: 'Лечение 2к4 + 2, расход бонусного действия и одной порции исполняются Rules Engine.',
    mechanicsSourcePage: 99,
  },
  { id: 'rations-one-day', name: 'Сухой паёк, 1 день', type: 'consumable', weight: 2, price: 50, description: 'Запас непортящейся еды на один день пути.', use: { kind: 'ration', consumes: 1, combat_action: null, range_feet: 0, target: 'self' }, limitation: 'Расход исполним, но голод и malnutrition не моделируются.' },
  { id: 'rope-hempen-50-feet', name: 'Пеньковая верёвка, 50 футов', weight: 5, price: 100, description: 'Пятьдесят футов прочной пеньковой верёвки.', limitation: 'Связывание, прочность и лазание требуют ruling.' },
  { id: 'torch', name: 'Факел', weight: 1, price: 1, description: 'Переносной источник обычного огня и света.', limitation: 'Время горения, свет и импровизированная атака не автоматизированы.' },
  { id: 'waterskin', name: 'Бурдюк', weight: 5, price: 20, description: 'Полный дорожный бурдюк с водой.', limitation: 'Вода, вместимость и обезвоживание не моделируются.' },
]

const MAGIC_ITEMS = [
  {
    catalog_id: 'srd_5_2_1:longsword-plus-1',
    ...ITEM_CATALOG_SOURCE,
    display_name: 'Длинный меч +1',
    name: 'Длинный меч +1',
    manifest_section: 'magic-item',
    description: 'Магически усиленный длинный меч. Атаки этим оружием получают +1 к броску атаки и +1 к броску урона.',
    category: 'weapon',
    type: 'weapon',
    price_cp: 41_500,
    base_price_cp: 41_500,
    weight: 3,
    lifecycle: { equippable: true, equip_slot: 'main_hand', transferable: true, stackable: false },
    equip: { slot: 'main_hand' },
    combat: {
      kind: 'melee',
      ability: 'str',
      damage: '1d8',
      damageType: 'slashing',
      normalRange: 5,
      attackBonus: 1,
      damageBonus: 1,
    },
    use: null,
    attunement: { required: false },
    charges: null,
    recharge: null,
    crafting: { implemented: false, hooks: [] },
    weapon: {
      group: 'martial-melee',
      damage: '1d8',
      damage_type: 'slashing',
      properties: ['versatile-1d10'],
      mastery: 'sap',
      normal_range_feet: 5,
      long_range_feet: null,
    },
    magic_item: {
      category: 'weapon',
      rarity: 'uncommon',
      bonus: 1,
      base_item_catalog_id: 'srd_5_2_1:longsword',
      value_formula: '400 gp (Uncommon magic item) + 15 gp (Longsword)',
    },
    mechanics_status: 'partial',
    limitation: 'Бонус +1 к атаке и урону исполняется сервером; versatile, mastery Sap и полная смена хвата ещё не автоматизированы.',
    availability: availability('srd_5_2_1:longsword-plus-1'),
    source_page: 253,
    source_pages: [91, 206, 253],
    mechanics_source_page: 253,
    provenance: provenance(253, { sourcePages: [91, 206, 253], mechanicsSourcePage: 253 }),
  },
  {
    catalog_id: 'srd_5_2_1:ring-of-protection',
    ...ITEM_CATALOG_SOURCE,
    display_name: 'Кольцо защиты',
    name: 'Кольцо защиты',
    manifest_section: 'magic-item',
    description: 'Пока вы носите это кольцо и настроены на него, вы получаете +1 к КД и всем спасброскам.',
    category: 'ring',
    type: 'other',
    rarity: 'редкий',
    price_cp: 400_000,
    base_price_cp: 400_000,
    weight: 0,
    lifecycle: { equippable: true, equip_slot: 'ring-protection', transferable: true, stackable: false },
    equip: { slot: 'ring-protection' },
    use: null,
    attunement: { required: true },
    charges: null,
    recharge: null,
    crafting: { implemented: false, hooks: [] },
    passive_effects: [{
      schema_version: 1,
      effect_id: 'srd_5_2_1:ring-of-protection:protection',
      group: 'srd_5_2_1:ring-of-protection',
      requires_equipped: true,
      requires_attunement: true,
      armor_class_bonus: 1,
      saving_throw_bonus: 1,
    }],
    magic_item: {
      category: 'ring',
      rarity: 'rare',
      bonus: 1,
      value_formula: '4,000 gp (Rare magic item)',
    },
    mechanics_status: 'partial',
    limitation: 'Числовые бонусы +1 к КД и спасброскам исполняются сервером. Общая настройка упрощена: отдельный Short Rest для неё пока не моделируется.',
    availability: availability('srd_5_2_1:ring-of-protection'),
    source_page: 237,
    source_pages: [101, 205, 237],
    mechanics_source_page: 237,
    provenance: provenance(237, { sourcePages: [101, 205, 237], mechanicsSourcePage: 237 }),
  },
  {
    catalog_id: 'srd_5_2_1:wand-of-magic-missiles',
    ...ITEM_CATALOG_SOURCE,
    display_name: 'Жезл волшебных стрел',
    name: 'Жезл волшебных стрел',
    manifest_section: 'magic-item',
    description: 'Пока вы держите этот жезл, вы можете потратить от 1 до 3 зарядов, чтобы наложить Волшебную стрелу: один заряд создаёт версию 1-го круга, каждый дополнительный повышает круг на 1.',
    category: 'wand',
    type: 'other',
    rarity: 'необычный',
    price_cp: 40_000,
    base_price_cp: 40_000,
    weight: 0,
    lifecycle: { equippable: true, equip_slot: 'main_hand', transferable: true, stackable: false },
    equip: { slot: 'main_hand' },
    use: {
      kind: 'cast_spell',
      spell_id: 'magic-missile',
      min_charges_to_spend: 1,
      max_charges_to_spend: 3,
      default_charges_to_spend: 1,
      combat_action: 'action',
      combat_only: true,
      requires_equipped: true,
      requires_line_of_sight: true,
      range_feet: 120,
      target: 'enemy',
    },
    attunement: { required: false },
    charges: { current: 7, max: 7 },
    recharge: { schema_version: ITEM_RECHARGE_SCHEMA_VERSION, trigger: 'dawn', formula: '1d6+1' },
    crafting: { implemented: false, hooks: [] },
    magic_item: {
      category: 'wand',
      rarity: 'uncommon',
      value_formula: '400 gp (Uncommon magic item)',
    },
    mechanics_status: 'partial',
    limitation: 'Сервер исполняет Волшебную стрелу по одной вражеской цели, используя один бросок 1к4 + 1 для всех дротиков, заряды, разрушение и рассветную перезарядку. Counterspell для заклинания без компонентов из предмета не открывается; автоматический Shield NPC и доставание жезла в бою пока не моделируются.',
    availability: availability('srd_5_2_1:wand-of-magic-missiles'),
    source_page: 250,
    source_pages: [145, 205, 250],
    mechanics_source_page: 250,
    provenance: provenance(250, { sourcePages: [145, 205, 250], mechanicsSourcePage: 250 }),
  },
]

const ENTRIES = [
  ...WEAPONS.map(weaponEntry),
  ...ARMOR.map(armorEntry),
  ...AMMUNITION.map(ammunitionEntry),
  ...TOOLS.map(toolEntry),
  ...OTHER_TOOLS.map(toolEntry),
  ...GEAR.map(gearEntry),
  ...MAGIC_ITEMS,
]

if (ENTRIES.length !== 100) {
  throw new Error(`Item catalog manifest must contain 100 entries, got ${ENTRIES.length}`)
}

const entriesById = Object.fromEntries(ENTRIES.map((entry) => [entry.catalog_id, entry]))
if (Object.keys(entriesById).length !== ENTRIES.length) {
  throw new Error('Item catalog catalog_id values must be unique')
}

export const ITEM_CATALOG = deepFreeze(entriesById)

export const ITEM_SHOP_CATALOG_IDS = deepFreeze(
  Object.keys(ITEM_CATALOG).filter((catalogId) => (
    ITEM_CATALOG[catalogId].availability.shop
    && ITEM_CATALOG[catalogId].mechanics_status !== 'ruling-only'
  )),
)

export const ITEM_LOOT_CATALOG_IDS = deepFreeze(
  Object.keys(ITEM_CATALOG).filter((catalogId) => (
    ITEM_CATALOG[catalogId].availability.loot
    && ITEM_CATALOG[catalogId].mechanics_status !== 'ruling-only'
  )),
)

export const ITEM_CRAFTING_CATALOG_IDS = deepFreeze(
  Object.keys(ITEM_CATALOG).filter((catalogId) => (
    ITEM_CATALOG[catalogId].availability.crafting
    && ITEM_CATALOG[catalogId].mechanics_status === 'verified'
  )),
)

export const SRD_EQUIPMENT_CATALOG = deepFreeze(Object.fromEntries(
  ITEM_SHOP_CATALOG_IDS.map((catalogId) => [catalogId, ITEM_CATALOG[catalogId]]),
))

export function catalogItem(catalogId) {
  return ITEM_CATALOG[String(catalogId ?? '')] ?? null
}

export function catalogIdsFor(channel) {
  if (channel === 'shop') return [...ITEM_SHOP_CATALOG_IDS]
  if (channel === 'loot') return [...ITEM_LOOT_CATALOG_IDS]
  if (channel === 'crafting') return [...ITEM_CRAFTING_CATALOG_IDS]
  return []
}

export function itemLifecycleProfile(catalogId) {
  const entry = catalogItem(catalogId)
  if (!entry) return null
  return clone({
    equippable: entry.lifecycle?.equippable === true,
    stackable: entry.lifecycle?.stackable !== false,
    ...(entry.equip?.slot ? { equip_slot: entry.equip.slot } : {}),
    ...(entry.equip?.armor?.kind === 'armor' ? {
      armor: {
        base: entry.equip.armor.armorClassBase,
        dexterity: entry.equip.armor.dexterityCap !== 0,
        dexterity_cap: entry.equip.armor.dexterityCap,
      },
    } : {}),
    ...(entry.equip?.armor?.kind === 'shield' ? { armor_bonus: entry.equip.armor.armorClassBonus } : {}),
    ...(entry.use ? { use: entry.use } : {}),
    ...(entry.charges ? { charges: entry.charges } : {}),
    ...(normalizeItemRechargeProfile(entry.recharge) ? { recharge: normalizeItemRechargeProfile(entry.recharge) } : {}),
    requires_attunement: entry.attunement?.required === true,
  })
}

export function itemRechargeProfile(catalogId) {
  const entry = catalogItem(catalogId)
  const recharge = normalizeItemRechargeProfile(entry?.recharge)
  const maximum = Math.max(0, Number(entry?.charges?.max) || 0)
  return recharge && maximum > 0 ? clone(recharge) : null
}

export const ITEM_ARMOR_PROFILES = deepFreeze(Object.fromEntries(
  Object.values(ITEM_CATALOG).flatMap((entry) => (
    entry.equip?.armor ? [[entry.catalog_id, entry.equip.armor]] : []
  )),
))

const INSTANCE_FIELDS = new Set([
  'id',
  'item_id',
  'stock_id',
  'quantity',
  'equipped',
  'attuned_to',
  'image',
  'imagePosition',
  'imagePrompt',
  'imageStatus',
  'rarity',
  'sellable',
  'quest_item',
  'appraisal',
  'appraisal_policy_id',
  'price_provenance',
  'price_source_version',
  'charges',
])

function catalogChargeState(entry, source) {
  if (!entry?.charges) return null
  const maximum = Math.max(0, Number(entry.charges.max) || 0)
  const requested = source?.charges?.current ?? entry.charges.current
  return {
    current: Math.max(0, Math.min(maximum, Number.isSafeInteger(Number(requested)) ? Number(requested) : maximum)),
    max: maximum,
  }
}

export function materializeCatalogItem(catalogId, instance = {}) {
  const entry = catalogItem(catalogId)
  const source = instance && typeof instance === 'object' && !Array.isArray(instance) ? instance : {}
  if (!entry) return clone(source)
  const preserved = Object.fromEntries(
    Object.entries(source).filter(([key]) => INSTANCE_FIELDS.has(key)),
  )
  return {
    ...preserved,
    catalog_id: entry.catalog_id,
    catalog_schema_version: ITEM_CATALOG_SCHEMA_VERSION,
    name: String(source.name ?? '').trim() || entry.name,
    type: entry.type,
    weight: entry.weight,
    description: String(source.description ?? '').trim() || entry.description,
    properties: String(source.properties ?? '').trim() || entry.description,
    base_price_cp: entry.base_price_cp,
    mechanics_status: entry.mechanics_status,
    ...(entry.rarity ? { rarity: entry.rarity } : {}),
    ...(entry.combat ? { combat: clone(entry.combat) } : {}),
    ...(entry.passive_effects ? { passive_effects: clone(entry.passive_effects) } : {}),
    ...(entry.charges ? { charges: catalogChargeState(entry, source) } : {}),
    ...(normalizeItemRechargeProfile(entry.recharge) ? { recharge: normalizeItemRechargeProfile(entry.recharge) } : {}),
    ...(entry.attunement.required ? { requires_attunement: true } : {}),
  }
}

export function hydrateCatalogItem(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const catalogId = String(source.catalog_id ?? source.catalogId ?? '').trim()
  return catalogItem(catalogId) ? materializeCatalogItem(catalogId, source) : clone(source)
}

export function itemViewerCapabilities(item = {}) {
  const entry = catalogItem(item?.catalog_id ?? item?.catalogId)
  if (!entry) {
    const equipSlot = item?.type === 'weapon' && item?.combat
      ? 'main_hand'
      : item?.type === 'armor'
        ? 'body'
        : null
    const requiresAttunement = item?.requires_attunement === true
    const recharge = normalizeItemRechargeProfile(item?.recharge)
    const maximum = Math.max(0, Number(item?.charges?.max) || 0)
    const current = Math.max(0, Math.min(maximum, Number.isSafeInteger(Number(item?.charges?.current)) ? Number(item.charges.current) : maximum))
    if (!equipSlot && !requiresAttunement && (!recharge || maximum <= 0)) return null
    return {
      equippable: Boolean(equipSlot),
      equip_slot: equipSlot,
      usable: false,
      use: null,
      charges: recharge && maximum > 0 ? { current, max: maximum } : null,
      recharge: recharge && maximum > 0 ? recharge : null,
      requires_attunement: requiresAttunement,
    }
  }
  const use = entry.use
    ? {
        kind: entry.use.kind,
        action_type: entry.use.combat_action,
        target: entry.use.target ?? 'self',
        range_feet: entry.use.range_feet ?? 0,
        ...(entry.use.charges_per_use ? { charges_per_use: entry.use.charges_per_use } : {}),
        ...(entry.use.spell_id ? { spell_id: entry.use.spell_id } : {}),
        ...(entry.use.min_charges_to_spend ? { min_charges_to_spend: entry.use.min_charges_to_spend } : {}),
        ...(entry.use.max_charges_to_spend ? { max_charges_to_spend: entry.use.max_charges_to_spend } : {}),
        ...(entry.use.default_charges_to_spend ? { default_charges_to_spend: entry.use.default_charges_to_spend } : {}),
        ...(entry.use.requires_equipped === true ? { requires_equipped: true } : {}),
        ...(entry.use.combat_only === true ? { combat_only: true } : {}),
      }
    : null
  return clone({
    equippable: entry.lifecycle?.equippable === true,
    equip_slot: entry.lifecycle?.equip_slot ?? null,
    usable: Boolean(use),
    use,
    charges: catalogChargeState(entry, item),
    recharge: normalizeItemRechargeProfile(entry.recharge),
    requires_attunement: entry.attunement?.required === true,
    mechanics_status: entry.mechanics_status,
    limitation: entry.limitation,
  })
}

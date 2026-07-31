import { createHash } from 'node:crypto'

const COMMON = 'обычный'
const UNCOMMON = 'необычный'
const RARE = 'редкий'
const VERY_RARE = 'очень редкий'

const mundane = (catalogId, name, type, weight = 0, extra = {}) => Object.freeze({
  catalog_id: `srd_5_2_1:${catalogId}`,
  name,
  type,
  weight,
  rarity: COMMON,
  ...extra,
})

/**
 * Магический профиль доверяется только по catalog_id из этой таблицы. Поля
 * предмета в snapshot остаются данными представления и не могут подменить
 * бонус, кость или условие активации.
 */
export const MAGIC_ITEM_DEFINITIONS = Object.freeze({
  'srd_5_2_1:weapon-plus-1-longsword': Object.freeze({
    catalog_id: 'srd_5_2_1:weapon-plus-1-longsword',
    name: 'Длинный меч +1',
    type: 'weapon',
    rarity: UNCOMMON,
    weight: 3,
    activation: 'equipped',
    effects: Object.freeze({ attack_bonus: 1, weapon_damage_bonus: 1 }),
    combat: Object.freeze({ kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5, longRange: 5 }),
    description: 'Магический длинный меч даёт +1 к броскам атаки и урона.',
  }),
  'srd_5_2_1:flame-tongue-longsword': Object.freeze({
    catalog_id: 'srd_5_2_1:flame-tongue-longsword',
    name: 'Длинный меч «Язык пламени»',
    type: 'weapon',
    rarity: RARE,
    weight: 3,
    activation: 'equipped_attuned',
    requires_attunement: true,
    effects: Object.freeze({ weapon_damage_dice: '2d6', weapon_damage_type: 'fire' }),
    combat: Object.freeze({ kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5, longRange: 5 }),
    description: 'Пылающий клинок добавляет 2к6 урона огнём при попадании.',
  }),
  'srd_5_2_1:weapon-of-warning-longsword': Object.freeze({
    catalog_id: 'srd_5_2_1:weapon-of-warning-longsword',
    name: 'Предупреждающий длинный меч',
    type: 'weapon',
    rarity: UNCOMMON,
    weight: 3,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ initiative_advantage: true }),
    combat: Object.freeze({ kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5, longRange: 5 }),
    description: 'Настроенный владелец совершает бросок инициативы с преимуществом.',
  }),
  'srd_5_2_1:cloak-of-protection': Object.freeze({
    catalog_id: 'srd_5_2_1:cloak-of-protection',
    name: 'Плащ защиты',
    type: 'other',
    rarity: UNCOMMON,
    weight: 1,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ armor_class_bonus: 1, saving_throw_bonus: 1 }),
    description: 'Даёт +1 к КД и спасброскам настроенного владельца.',
  }),
  'srd_5_2_1:ring-of-protection': Object.freeze({
    catalog_id: 'srd_5_2_1:ring-of-protection',
    name: 'Кольцо защиты',
    type: 'other',
    rarity: RARE,
    weight: 0,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ armor_class_bonus: 1, saving_throw_bonus: 1 }),
    description: 'Даёт +1 к КД и спасброскам настроенного владельца.',
  }),
  'srd_5_2_1:stone-of-good-luck': Object.freeze({
    catalog_id: 'srd_5_2_1:stone-of-good-luck',
    name: 'Камень удачи',
    type: 'other',
    rarity: UNCOMMON,
    weight: 0,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ ability_check_bonus: 1, saving_throw_bonus: 1 }),
    description: 'Даёт +1 к проверкам характеристик и спасброскам.',
  }),
  'srd_5_2_1:boots-of-elvenkind': Object.freeze({
    catalog_id: 'srd_5_2_1:boots-of-elvenkind',
    name: 'Эльфийские сапоги',
    type: 'other',
    rarity: UNCOMMON,
    weight: 1,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ stealth_advantage: true }),
    description: 'Шаги владельца беззвучны: проверки Скрытности совершаются с преимуществом.',
  }),
  'srd_5_2_1:gauntlets-of-ogre-power': Object.freeze({
    catalog_id: 'srd_5_2_1:gauntlets-of-ogre-power',
    name: 'Рукавицы силы огра',
    type: 'other',
    rarity: UNCOMMON,
    weight: 2,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ strength_score: 19 }),
    description: 'Сила настроенного владельца считается равной 19, если не была выше.',
  }),
  'srd_5_2_1:amulet-of-health': Object.freeze({
    catalog_id: 'srd_5_2_1:amulet-of-health',
    name: 'Амулет здоровья',
    type: 'other',
    rarity: RARE,
    weight: 0,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ constitution_score: 19 }),
    description: 'Телосложение настроенного владельца считается равным 19, если не было выше.',
  }),
  'srd_5_2_1:periapt-of-wound-closure': Object.freeze({
    catalog_id: 'srd_5_2_1:periapt-of-wound-closure',
    name: 'Периапт заживления ран',
    type: 'other',
    rarity: UNCOMMON,
    weight: 0,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ hit_die_healing_multiplier: 2, stabilize_at_turn_start: true }),
    description: 'Удваивает лечение от потраченных костей хитов и стабилизирует владельца.',
  }),
  'srd_5_2_1:vicious-longsword': Object.freeze({
    catalog_id: 'srd_5_2_1:vicious-longsword',
    name: 'Жестокий длинный меч',
    type: 'weapon',
    rarity: RARE,
    weight: 3,
    activation: 'equipped',
    effects: Object.freeze({ critical_damage_dice: '2d6' }),
    combat: Object.freeze({ kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5, longRange: 5 }),
    description: 'При критическом попадании добавляет 2к6 урона того же типа.',
  }),
  'srd_5_2_1:adamantine-half-plate': Object.freeze({
    catalog_id: 'srd_5_2_1:adamantine-half-plate',
    name: 'Адамантиновый полулаты',
    type: 'armor',
    rarity: UNCOMMON,
    weight: 40,
    activation: 'equipped',
    effects: Object.freeze({ critical_hit_immunity: true }),
    description: 'Критическое попадание по владельцу становится обычным.',
  }),
  'srd_5_2_1:brooch-of-shielding': Object.freeze({
    catalog_id: 'srd_5_2_1:brooch-of-shielding',
    name: 'Брошь защиты',
    type: 'other',
    rarity: UNCOMMON,
    weight: 0,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ damage_resistance: 'force' }),
    description: 'Даёт сопротивление урону силовым полем.',
  }),
  'srd_5_2_1:bracers-of-archery': Object.freeze({
    catalog_id: 'srd_5_2_1:bracers-of-archery',
    name: 'Наручи стрельбы из лука',
    type: 'other',
    rarity: UNCOMMON,
    weight: 1,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ ranged_weapon_damage_bonus: 2 }),
    description: 'Добавляют 2 урона атакам из лука.',
  }),
  'srd_5_2_1:headband-of-intellect': Object.freeze({
    catalog_id: 'srd_5_2_1:headband-of-intellect',
    name: 'Обруч интеллекта',
    type: 'other',
    rarity: UNCOMMON,
    weight: 0,
    activation: 'attuned',
    requires_attunement: true,
    effects: Object.freeze({ intelligence_score: 19 }),
    description: 'Интеллект настроенного владельца считается равным 19, если не был выше.',
  }),
})

export const MAGIC_LOOT_CATALOG_IDS = Object.freeze(Object.keys(MAGIC_ITEM_DEFINITIONS))

export function magicItemDefinitionFor(itemOrCatalogId) {
  const catalogId = typeof itemOrCatalogId === 'string'
    ? itemOrCatalogId
    : String(itemOrCatalogId?.catalog_id ?? itemOrCatalogId?.catalogId ?? '')
  return MAGIC_ITEM_DEFINITIONS[catalogId] ?? null
}

const LOOT_ITEMS = Object.freeze({
  torch: mundane('torch', 'Факел', 'tool', 1),
  rations: mundane('rations-one-day', 'Сухой паёк, 1 день', 'consumable', 2),
  rope: mundane('rope-hempen-50-feet', 'Пеньковая верёвка, 50 футов', 'tool', 10),
  arrows: mundane('arrows-20', 'Стрелы, 20 штук', 'other', 1),
  bolts: mundane('crossbow-bolts-20', 'Арбалетные болты, 20 штук', 'other', 1.5),
  dagger: mundane('dagger', 'Кинжал', 'weapon', 1, { combat: { kind: 'melee', ability: 'str', damage: '1d4', damageType: 'piercing', normalRange: 5, longRange: 5 } }),
  shield: mundane('shield', 'Щит', 'armor', 6),
  leather: mundane('leather-armor', 'Кожаный доспех', 'armor', 10),
  studded: mundane('studded-leather-armor', 'Проклёпанный кожаный доспех', 'armor', 13),
  chain: mundane('chain-mail', 'Кольчуга', 'armor', 55),
  longsword: mundane('longsword', 'Длинный меч', 'weapon', 3, { combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5, longRange: 5 } }),
  shortsword: mundane('shortsword', 'Короткий меч', 'weapon', 2, { combat: { kind: 'melee', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 5, longRange: 5 } }),
  handaxe: mundane('handaxe', 'Ручной топор', 'weapon', 2, { combat: { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'slashing', normalRange: 5, longRange: 5 } }),
  mace: mundane('mace', 'Булава', 'weapon', 4, { combat: { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'bludgeoning', normalRange: 5, longRange: 5 } }),
  spear: mundane('spear', 'Копьё', 'weapon', 3, { combat: { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'piercing', normalRange: 5, longRange: 5 } }),
  shortbow: mundane('shortbow', 'Короткий лук', 'weapon', 2, { combat: { kind: 'ranged', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 80, longRange: 320 } }),
  longbow: mundane('longbow', 'Длинный лук', 'weapon', 2, { combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150, longRange: 600 } }),
  light_crossbow: mundane('light-crossbow', 'Лёгкий арбалет', 'weapon', 5, { combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 80, longRange: 320 } }),
  crowbar: mundane('crowbar', 'Ломик', 'tool', 5),
  caltrops: mundane('caltrops-bag', 'Калтропы, мешок', 'tool', 2),
  healer_kit: mundane('healers-kit', 'Набор лекаря', 'tool', 3),
  thieves_tools: mundane('thieves-tools', 'Воровские инструменты', 'tool', 1),
  lantern: mundane('lantern-hooded', 'Закрытый фонарь', 'tool', 2),
  oil: mundane('oil-flask', 'Фляга масла', 'consumable', 1),
  antitoxin: mundane('antitoxin-vial', 'Флакон противоядия', 'consumable', 0),
  potion: mundane('potion-of-healing', 'Зелье лечения', 'consumable', 0.5),
  gem: mundane('gemstone-50-gp', 'Самоцвет стоимостью 50 зм', 'treasure', 0),
  art: mundane('art-object-250-gp', 'Малый предмет искусства', 'treasure', 2),
})

export const LOOT_ITEM_CATALOG_IDS = Object.freeze([
  ...new Set([
    ...Object.values(LOOT_ITEMS).map((item) => item.catalog_id),
    ...MAGIC_LOOT_CATALOG_IDS,
  ]),
])

const LOOT_BY_THEME = Object.freeze({
  goblinoids: ['arrows', 'bolts', 'dagger', 'shortsword', 'shield', 'torch', 'caltrops'],
  undead: ['mace', 'spear', 'lantern', 'oil', 'gem', 'shield', 'chain'],
  beasts: ['rations', 'rope', 'healer_kit', 'antitoxin', 'shortbow', 'spear'],
  raiders: ['dagger', 'leather', 'studded', 'arrows', 'shield', 'longsword', 'shortbow', 'crowbar'],
  warband: ['chain', 'shield', 'longsword', 'longbow', 'light_crossbow', 'bolts', 'gem', 'art'],
  vermin: ['rations', 'rope', 'torch', 'oil', 'antitoxin', 'healer_kit'],
  ambush: ['dagger', 'arrows', 'shortbow', 'rope', 'caltrops', 'thieves_tools', 'studded'],
  crypt: ['mace', 'lantern', 'oil', 'gem', 'art', 'chain', 'shield'],
  cave: ['rope', 'torch', 'rations', 'crowbar', 'lantern', 'gem', 'antitoxin'],
  wilderness: ['rations', 'rope', 'arrows', 'longbow', 'spear', 'healer_kit', 'antitoxin'],
  generic: Object.keys(LOOT_ITEMS),
})

const LOOT_POTIONS_BY_DIFFICULTY = Object.freeze({ easy: 0, medium: 1, hard: 2 })
const MUNDANE_COUNT_BY_DIFFICULTY = Object.freeze({ easy: 1, medium: 2, hard: 3 })
const MAGIC_THRESHOLD_BY_DIFFICULTY = Object.freeze({ easy: 8, medium: 24, hard: 50 })
const COIN_DICE_BY_DIFFICULTY = Object.freeze({
  easy: Object.freeze([{ denomination: 'silver', count: 2, sides: 6 }]),
  medium: Object.freeze([{ denomination: 'gold', count: 3, sides: 6 }]),
  hard: Object.freeze([
    { denomination: 'gold', count: 4, sides: 6 },
    { denomination: 'platinum', count: 1, sides: 6 },
  ]),
})

function hashBytes(seed) {
  return createHash('sha256').update(String(seed)).digest()
}

function hashNumber(seed, offset = 0) {
  const bytes = hashBytes(seed)
  return bytes.readUInt32BE((offset * 4) % 28)
}

function deterministicDice(seed, count, sides) {
  return Array.from({ length: count }, (_, index) => 1 + hashNumber(`${seed}:${index}`, index) % sides)
}

export function serverEncounterCoins({
  theme = 'generic',
  difficulty = 'medium',
  encounterId = '',
  enemyCount = 1,
} = {}) {
  const dice = COIN_DICE_BY_DIFFICULTY[difficulty] ?? COIN_DICE_BY_DIFFICULTY.medium
  const multiplier = Math.max(1, Math.min(20, Number.isSafeInteger(Number(enemyCount)) ? Number(enemyCount) : 1))
  const currency = { copper: 0, silver: 0, gold: 0, platinum: 0 }
  const rolls = []
  for (const entry of dice) {
    const values = deterministicDice(`coins:${theme}:${difficulty}:${encounterId}:${entry.denomination}`, entry.count, entry.sides)
    const total = values.reduce((sum, value) => sum + value, 0) * multiplier
    currency[entry.denomination] = total
    rolls.push({ expression: `${entry.count}d${entry.sides}`, denomination: entry.denomination, values, multiplier, total })
  }
  return Object.freeze({ currency: Object.freeze(currency), rolls: Object.freeze(rolls.map(Object.freeze)) })
}

export function serverEncounterLoot({ theme = 'generic', difficulty = 'medium', encounterId = '' } = {}) {
  const table = LOOT_BY_THEME[theme] ?? LOOT_BY_THEME.generic
  const count = MUNDANE_COUNT_BY_DIFFICULTY[difficulty] ?? 2
  const offset = hashNumber(`loot:${theme}:${encounterId}`)
  const mundaneLoot = Array.from({ length: Math.min(count, table.length) }, (_, index) => ({
    ...LOOT_ITEMS[table[(offset + index * 5) % table.length]],
    quantity: 1,
  }))
  const potions = LOOT_POTIONS_BY_DIFFICULTY[difficulty] ?? 0
  const magicRoll = hashNumber(`magic-chance:${theme}:${encounterId}`) % 100
  const threshold = MAGIC_THRESHOLD_BY_DIFFICULTY[difficulty] ?? 24
  const magic = magicRoll < threshold
    ? MAGIC_ITEM_DEFINITIONS[MAGIC_LOOT_CATALOG_IDS[hashNumber(`magic-item:${theme}:${encounterId}`) % MAGIC_LOOT_CATALOG_IDS.length]]
    : null
  return [
    ...(potions > 0 ? [{ ...LOOT_ITEMS.potion, quantity: potions }] : []),
    ...mundaneLoot,
    ...(magic ? [{ ...magic, effects: { ...magic.effects }, combat: magic.combat ? { ...magic.combat } : undefined, quantity: 1 }] : []),
  ]
}

function currencyToCopper(currency = {}) {
  return Math.max(0, Number(currency.copper) || 0)
    + Math.max(0, Number(currency.silver) || 0) * 10
    + Math.max(0, Number(currency.gold) || 0) * 100
    + Math.max(0, Number(currency.platinum) || 0) * 1_000
}

function copperToCurrency(value) {
  let remaining = Math.max(0, Math.floor(Number(value) || 0))
  const platinum = Math.floor(remaining / 1_000)
  remaining -= platinum * 1_000
  const gold = Math.floor(remaining / 100)
  remaining -= gold * 100
  const silver = Math.floor(remaining / 10)
  return { copper: remaining - silver * 10, silver, gold, platinum }
}

/**
 * Распределение не зависит от порядка выполнения команд. Стартовый герой
 * выбирается по encounter_id, предметы идут по кругу, а медь делится поровну;
 * остаток по одной мм получают первые герои от детерминированной точки старта.
 */
export function planEncounterLootDistribution({
  encounterId = '',
  loot = [],
  coins = {},
  partyMemberIds = [],
  ineligibleActorIds = [],
} = {}) {
  const ineligible = new Set((Array.isArray(ineligibleActorIds) ? ineligibleActorIds : []).map(String))
  const eligible = [...new Set((Array.isArray(partyMemberIds) ? partyMemberIds : []).map(String).filter(Boolean))]
    .filter((id) => !ineligible.has(id))
  if (!eligible.length) return []
  const start = hashNumber(`distribution:${encounterId}`) % eligible.length
  const order = [...eligible.slice(start), ...eligible.slice(0, start)]
  const allocations = order.map((actorId) => ({ actor_id: actorId, items: [], currency: copperToCurrency(0) }))
  for (const [index, item] of (Array.isArray(loot) ? loot : []).entries()) {
    allocations[index % allocations.length].items.push({
      ...structuredClone(item),
      id: `loot-${String(encounterId).slice(0, 80)}-${index + 1}`,
    })
  }
  const totalCopper = currencyToCopper(coins)
  const base = Math.floor(totalCopper / allocations.length)
  let remainder = totalCopper % allocations.length
  for (const allocation of allocations) {
    const amount = base + (remainder > 0 ? 1 : 0)
    allocation.currency = copperToCurrency(amount)
    if (remainder > 0) remainder -= 1
  }
  return allocations
}

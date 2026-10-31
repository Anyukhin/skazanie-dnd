// Эталон `server/equipment-visuals.mjs` и `server/actor-appearance.mjs` для sk-scene-base.
// Запуск из корня репозитория: node rust/crates/sk-scene-base/fixtures/gen-equipment-appearance.mjs
import { writeFileSync } from 'node:fs'

import {
  EQUIPMENT_ITEM_VISUALS,
  EQUIPMENT_VISUAL_MODEL_KEYS,
  EQUIPMENT_VISUAL_SCHEMA_VERSION,
  EQUIPMENT_VISUAL_SLOTS,
  EQUIPMENT_VISUAL_VARIANTS,
  itemVisualForCatalogId,
  modelKeysForEquipmentSlot,
  normalizeEquipmentModelKey,
  normalizeEquipmentVisualSlot,
  normalizeEquipmentVisualVariant,
  normalizePublicLoadout,
  publicLoadoutForItems,
} from '../../../../server/equipment-visuals.mjs'
import {
  ACTOR_APPEARANCE_EQUIPMENT,
  ACTOR_APPEARANCE_PROFILES,
  ACTOR_APPEARANCE_STATURES,
  actorAppearanceFor,
  actorProfileFor,
  actorStatureFor,
  attackVisualFor,
  equipmentForPublicItems,
  namesDragon,
  normalizeAttackVisual,
  publicAppearanceRecord,
} from '../../../../server/actor-appearance.mjs'
import { ITEM_CATALOG } from '../../../../server/item-catalog.mjs'
import { jsonOf, readJson, rng, shuffled } from './corpus.mjs'

const catalog = Object.values(ITEM_CATALOG)
const PROTO = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'toLocaleString']

// --- Каталог и нормализаторы --------------------------------------------------
const catalogIds = [...catalog.map((entry) => entry.catalog_id), ...Object.keys(EQUIPMENT_ITEM_VISUALS), 'srd_5_2_1:net', '', ' srd_5_2_1:longsword ', 'SRD_5_2_1:LONGSWORD', 'srd_5_2_1:ｌｏｎｇｓｗｏｒｄ', ...PROTO, null, 42]
const itemVisuals = [...new Set(catalogIds)].map((id) => ({ id, output: jsonOf(itemVisualForCatalogId(id) ?? null) }))
const VALUES = ['', ' main_hand ', 'body', 'BODY', 'ring-protection', 'flaming', 'enchanted', 'default', 'DEFAULT', 'adamantine', 'longsword', 'armor-plate', 'net', 'wand', 'holy-amulet', '../secret.glb', null, 42, true, ['body'], { a: 1 }, 'ｂｏｄｙ', ...PROTO, 'x'.repeat(100)]
const normalizers = VALUES.map((value) => ({
  value,
  slot: normalizeEquipmentVisualSlot(value),
  variant: normalizeEquipmentVisualVariant(value),
  variantNull: normalizeEquipmentVisualVariant(value, null),
  modelKey: normalizeEquipmentModelKey(value),
  slotKeys: modelKeysForEquipmentSlot(value),
}))

// --- Инвентари -----------------------------------------------------------------
const LEGACY_NAMES = ['Длинный меч', 'длинный  меч', 'LONGSWORD', 'Короткий лук', 'Длинный лук', 'Посох', 'Боевой посох', 'Кинжал', 'Сеть', 'Щит', 'Кольчуга', 'Латы', 'Кираса',
  'Стёганый доспех', 'Клепаный кожаный доспех', 'Half Plate', 'Light hammer', 'Молот', 'Копьё', 'Меч', 'Лук', 'Арбалет', 'Древний клинок', 'Меч с красной руной',
  'Огненный длинный меч', 'Тайный посох', 'constructor', '__proto__', 'Constructor', 'toString', '', null, 42]
const VISIBILITY = [undefined, 'public', 'party', 'PUBLIC', ' party ', 'gm_only', 'npc_private', 'specific_player', '', null]
const next = rng(97)
const pick = (list) => list[Math.floor(next() * list.length)]
function randomItem(index) {
  const item = { id: next() < 0.9 ? `item-${index % 7}` : undefined }
  if (next() < 0.1) { delete item.id; item.item_id = `alt-${index % 3}` }
  const fromCatalog = next() < 0.6
  if (fromCatalog) {
    const entry = pick(catalog)
    if (next() < 0.9) item.catalog_id = entry.catalog_id
    else item.catalogId = entry.catalog_id
    item.name = entry.name
    item.type = entry.type
  } else {
    item.name = pick(LEGACY_NAMES)
    item.type = pick(['weapon', 'armor', 'gear', undefined])
    if (next() < 0.5) item.combat = pick([{ kind: 'melee' }, null, [], 'x'])
  }
  const equipped = next()
  item.equipped = equipped < 0.6 ? true : equipped < 0.8 ? false : pick(['true', 1, null])
  const visibility = pick(VISIBILITY)
  if (visibility !== undefined) item[pick(['visibility', 'visibility_level', 'visibilityLevel'])] = visibility
  if (next() < 0.08) item[pick(['hidden', 'private', 'gm_only', 'secret', 'unrevealed', 'gm_notes'])] = pick([true, 'x', 0, ''])
  if (next() < 0.2) item.identified = pick([false, true, undefined])
  if (next() < 0.2) item.activated = pick([true, false, 'yes'])
  return JSON.parse(JSON.stringify(item))
}
const inventories = []
for (let index = 0; index < 400; index += 1) {
  const size = Math.floor(next() * 6)
  inventories.push(Array.from({ length: size }, (_, offset) => randomItem(index * 7 + offset)))
}
// Каждая каталожная вещь и каждое прежнее имя — по одному.
for (const entry of catalog) inventories.push([{ id: entry.catalog_id, catalog_id: entry.catalog_id, name: entry.name, type: entry.type, equipped: true }])
for (const name of LEGACY_NAMES) inventories.push([{ id: 'x', name, type: 'weapon', equipped: true }], [{ id: 'y', name, type: 'armor', equipped: true, combat: {} }])
inventories.push(
  [{ id: 'net', type: 'weapon', name: 'Сеть', equipped: true }],
  [{ id: 'one', catalog_id: 'srd_5_2_1:longsword', equipped: true }, { id: 'two', catalog_id: 'srd_5_2_1:dagger', equipped: true }],
  [{ id: 'hidden', catalog_id: 'srd_5_2_1:plate-armor', equipped: true, visibility: 'gm_only' }, { id: 'custom', type: 'weapon', name: 'Древний клинок', combat: { kind: 'melee' }, equipped: true }],
  [{ id: 'proto', catalog_id: 'constructor', name: 'Длинный меч', type: 'weapon', equipped: true }],
  [{ id: 'proto2', catalogId: '__proto__', name: 'Щит', equipped: true }, { id: 'p3', catalog_id: 'toString', type: 'armor', equipped: true }],
  'не массив', null, [null, 'строка', 7, [], { equipped: true }],
)
const ADDITIONAL = [undefined, [], [{ id: 'extra', catalog_id: 'srd_5_2_1:shield' }], [{ catalog_id: 'srd_5_2_1:shield' }], [{ id: 'item-1', catalog_id: 'srd_5_2_1:plate-armor', equipped: false }], 'x', [null, { id: '  ' }]]
const loadouts = inventories.map((items, index) => {
  const additional = ADDITIONAL[index % ADDITIONAL.length]
  return {
    items,
    additional: additional === undefined ? null : additional,
    loadout: jsonOf(publicLoadoutForItems(items, additional === undefined ? undefined : { additionalEquipped: additional })),
    plain: jsonOf(publicLoadoutForItems(items)),
    equipment: equipmentForPublicItems(items),
  }
})

const LOADOUTS = [
  { main_hand: { model_key: 'longsword', variant: 'flaming', item_id: 'secret' }, body: { model_key: 'armor-plate', variant: 'adamantine' }, off_hand: { model_key: '../secret.glb' }, cloak: { model_key: 'ring' }, url: 'https://private.invalid/model.glb' },
  { main_hand: { model_key: 'net' } }, { main_hand: null, body: 'x', focus: { modelKey: 'holy-amulet' }, brooch: { model_key: 'brooch', variant: 'bad' }, 'ring-protection': { model_key: ' ring ', variant: '' } },
  null, [], 'x', {}, { main_hand: { model_key: 'longsword', variant: null } }, { constructor: { model_key: 'x' }, main_hand: [] },
]
const publicLoadouts = LOADOUTS.map((value) => ({ value, output: jsonOf(normalizePublicLoadout(value)) }))

// --- Облик -------------------------------------------------------------------
const monsters = readJson('data/compendia/dnd_5e_2014/monsters.json').monsters
const PROFILE_NAMES = [
  'Саргат', 'Red Wyrmling', 'Волк', 'Неизвестная тень', 'Гигантская крыса 1', 'Рой крыс', 'Гигантский паук', 'Гигантская оса 2', 'Гигантская жаба', 'Ядовитая змея',
  'Giant Spider', 'Крысолов', 'Осада', 'Паукообразный жрец', 'Сотник Жуков', 'Тень в кустах', 'Неизвестный', 'Арес', 'Тварь', '???', 'unknown bandit', 'Враг',
  'Существо', 'Тайный', 'Тайная', 'Скрытый', 'маскированный', 'Гоблин-лучник', 'Скелет', 'Зомби', 'Драконица', 'драконы', 'Виверна', 'Драконорождённый', 'Drake',
  'Wyrmlings', 'Охотник на драконов', 'dragon slayer', 'dragon-hunter', 'Убийца драконов', 'Кабан', 'Медведь', 'Кобольд', '', null,
]
const ROLES = ['', 'молодой красный дракон и наследник Вулканиса', 'дракон', 'король Валедора и прославленный драконоборец', 'охотник на драконов', 'dragon slayer',
  'драконорождённый паладин', 'виверна', 'маг', 'волшебник', 'жрец', 'плут', 'следопыт', 'разведчик', 'староста', 'гоблин', 'нежить', 'зверь', 'warlock', 'scout', 'Магистр', null]
const CLASSES = ['fighter', 'wizard', 'rogue', 'ranger', 'cleric', 'druid', 'sorcerer', 'warlock', 'bard', 'monk', 'paladin', 'barbarian', 'Воин', 'Плут', 'Маг', '', null]
const KINDS = ['hero', 'enemy', 'summon', 'neutral', 'npc', 'HERO', ' hero ', '', null]
const actors = []
for (const monster of monsters) {
  for (const kind of ['enemy', 'summon']) {
    actors.push({ kind, actor: { name: monster.name_ru, creature_type: monster.creature_type, size: monster.size } })
    actors.push({ kind, actor: { name: monster.name_en, role: monster.name_ru, creature_type: monster.creature_type, size: monster.size, masked: next() < 0.2 } })
  }
}
for (const name of PROFILE_NAMES) {
  for (const role of shuffled(ROLES, String(name).length).slice(0, 4)) {
    for (const kind of KINDS) actors.push({ kind, actor: { name, role, creature_type: pick(['dragon', 'beast', 'undead', 'goblin', '', undefined, 'DRAGON']) } })
  }
}
for (const characterClass of CLASSES) {
  for (const species of ['Человек', 'Легконогий полурослик', 'Лесной гном', 'Холмовой дварф', 'Halfling', '', null]) {
    actors.push({ kind: 'hero', actor: { name: 'Гоблинус', characterClass, species, inventory: pick(inventories) } })
    actors.push({ kind: 'hero', actor: { character_class: characterClass, class_id: 'mage', role: 'гоблин', species, size: pick(['Huge', 'tiny', 'medium', '', 'giant']) } })
  }
}
for (const flags of [{ masked: true }, { is_masked: true }, { identity_masked: true }, { identityMasked: true }, { masked_identity: true }, { identified: false }, { identity_known: false }, { masked: 'true' }, { identified: 0 }]) {
  actors.push({ kind: 'enemy', actor: { name: 'Гоблин', creature_type: 'dragon', ...flags } })
}
actors.push({ kind: 'enemy', actor: null }, { kind: 'hero', actor: 'строка' }, { kind: undefined, actor: {} }, { kind: 'hero', actor: { inventory: [{ name: 'Длинный меч', type: 'weapon', equipped: true }, { name: 'Щит', type: 'armor', equipped: true }] } })
const appearances = actors.map(({ kind, actor }) => ({
  kind: kind === undefined ? null : kind,
  actor,
  appearance: jsonOf(actorAppearanceFor(kind, actor ?? undefined)),
  profile: actorProfileFor(actor && typeof actor === 'object' ? { ...actor, kind } : undefined),
  stature: actorStatureFor(kind, actor ?? undefined),
  record: publicAppearanceRecord(actor),
}))

const DRAGON_TEXTS = [...PROFILE_NAMES, ...ROLES, 'Красный ДРАКОН', 'истребитель-дракон', 'победитель на драконов', 'dragonslayers', 'wyrm', 'Дракона', 'драконом', 'драконий']
const dragons = DRAGON_TEXTS.map((value) => ({ value, output: namesDragon(value) }))

const VISUALS = [
  { version: 1, equipment: 'bow', private: 'drop' }, { version: 1, equipment: 'laser' }, { version: '1', equipment: 'bow' },
  { version: 2, equipment: 'sword-shield', loadout: { main_hand: { model_key: 'longsword' }, off_hand: { model_key: 'shield' } } },
  { version: 2, equipment: 'staff' }, { version: 2, equipment: 'staff', loadout: 'x' }, { version: 3, equipment: 'bow' }, { version: 2.0, equipment: 'unknown', loadout: { body: null } },
  null, [], 'x', {}, { version: 1 }, { version: 2, equipment: null }, { version: 1, equipment: ['bow'] },
]
const attackVisuals = VISUALS.map((value) => ({ value, output: jsonOf(normalizeAttackVisual(value) ?? null) }))

const SWORD = { id: 'sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true }
const SHIELD = { id: 'shield', catalog_id: 'srd_5_2_1:shield', name: 'Щит', type: 'armor', quantity: 1, equipped: true }
const ACTIONS = ['Дальний удар', 'Короткий лук', 'crossbow', 'Арбалет', 'Безоружный удар', 'Кулак', 'Посох', 'Боевой посох', 'staff strike', 'Кинжал', 'Метнуть кинжал', 'Длинный меч', 'Меч и щит',
  'Скимитар', 'Сабля', 'Укус', 'Когти', 'Длинный лук', 'лук', 'Bow', 'longbow', 'Сеть', 'Молот', '', null]
const ATTACK_KINDS = [undefined, 'melee', 'ranged', 'thrown', 'spell', null]
const attackInputs = []
for (const actionName of ACTIONS) {
  for (const attackKind of ATTACK_KINDS) {
    const input = { actionName }
    if (attackKind !== undefined) input.attackKind = attackKind
    attackInputs.push(input)
  }
  attackInputs.push({ itemName: actionName, attackKind: 'melee' }, { actionName, unarmed: true }, { actionName, items: [] })
}
for (const items of shuffled(inventories.filter(Array.isArray), 5).slice(0, 150)) {
  const item = items.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)) ?? null
  attackInputs.push({ item, items, attackKind: pick(['melee', 'ranged', undefined]) })
  attackInputs.push({ item: item ? { ...item, equipped: false, id: undefined } : SWORD, items })
}
attackInputs.push(
  { item: { id: 'dagger', catalog_id: 'srd_5_2_1:dagger', type: 'weapon', quantity: 1, equipped: false }, items: [SWORD, SHIELD, { id: 'dagger', catalog_id: 'srd_5_2_1:dagger', type: 'weapon', quantity: 1, equipped: false }, { id: 'plate', catalog_id: 'srd_5_2_1:plate-armor', type: 'armor', quantity: 1, equipped: true }], attackKind: 'melee' },
  { item: SWORD, items: [SWORD, { ...SHIELD, visibility: 'gm_only' }] },
  { item: SWORD, items: [SWORD, { ...SHIELD, visibility: 'party' }] },
  { item: SWORD, items: [SWORD, { ...SHIELD, visibilityLevel: 'specific_player' }] },
  { item: { id: 'flame', catalog_id: 'srd_5_2_1:flame-tongue-longsword', type: 'weapon', name: 'Огненный длинный меч', equipped: true, identified: false, activated: true } },
  { actionName: 'Дальний удар', attackKind: 'ranged', npcBinding: { catalog_id: 'srd_5_2_1:longbow', item_instance_id: 'secret-bow' } },
  { item: [], items: 'x' }, { item: 'меч' }, {}, { unarmed: 'true' }, { item: SWORD, items: [null, 'x', { id: 'sword', equipped: false, name: 'Старый меч' }] },
  { item: { item_id: 'alt', name: 'Кинжал', type: 'weapon' }, items: [{ item_id: 'alt', equipped: true, name: 'Посох' }] },
)
const attacks = attackInputs.map((input) => ({ input: jsonOf(input), output: jsonOf(attackVisualFor(input)) }))
attacks.push({ input: null, output: jsonOf(attackVisualFor()) })

const fixture = {
  constants: {
    EQUIPMENT_VISUAL_SCHEMA_VERSION, EQUIPMENT_VISUAL_SLOTS, EQUIPMENT_VISUAL_VARIANTS, EQUIPMENT_VISUAL_MODEL_KEYS,
    ACTOR_APPEARANCE_PROFILES, ACTOR_APPEARANCE_EQUIPMENT, ACTOR_APPEARANCE_STATURES,
    itemVisuals: Object.entries(EQUIPMENT_ITEM_VISUALS).map(([id, visual]) => [id, visual.slot, visual.model_key, visual.variant]),
  },
  itemVisuals,
  normalizers,
  loadouts,
  publicLoadouts,
  appearances,
  dragons,
  attackVisuals,
  attacks,
}
writeFileSync(new URL('./equipment-appearance.json', import.meta.url), `${JSON.stringify(fixture)}\n`)
console.log(`equipment-appearance: ${itemVisuals.length + normalizers.length + loadouts.length * 3 + publicLoadouts.length + appearances.length * 4 + dragons.length + attackVisuals.length + attacks.length} случаев`)

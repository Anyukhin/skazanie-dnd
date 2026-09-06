/**
 * Среда как оружие — задача 3.2 плана `docs/experience-upgrade-plan.md`.
 *
 * «Опрокинуть стеллаж, поджечь сено» — это интеракции с уже существующими
 * пропсами карты, а не новый слой сущностей. Поэтому здесь только справочник:
 * какой пропс тяжёлый, какой горючий, какой сам является источником огня, и с
 * какими числами это разрешается. Механику исполняет `rules-engine.mjs`, зону
 * огня ведёт та же машинерия площадных эффектов, что и у заклинаний.
 *
 * Теги выводятся из `assetId` детерминированно и целиком на сервере: контракт
 * карты для этого не менялся, а присланный клиентом `prop.interaction` здесь,
 * как и в `scene-interactions.mjs`, не читается.
 *
 * Подвешенные объекты не становятся универсальной физикой карты: для swing
 * есть отдельный закрытый профиль с фиксированной высотой, опорой и СЛ.
 * Поэтому игрок может использовать только реально существующий проп из карты,
 * а не назвать люстру в тексте.
 */

export const SCENE_HAZARD_POLICY_ID = 'skazanie:scene-hazards-v1'

export const SCENE_SWING_POLICY_ID = 'skazanie:scene-swing-v1'

const SWING_PROPS = Object.freeze({
  chandelier: Object.freeze({
    anchor: 'ceiling',
    height_feet: 10,
    reach_feet: 5,
    check: Object.freeze({ ability: 'str', skill: 'athletics', difficulty: 12 }),
    failure_condition: 'prone',
  }),
})

export function swingPropProfileFor(assetId) {
  const key = hazardAssetKey(assetId)
  const profile = SWING_PROPS[key]
  return profile ? { ...profile, check: { ...profile.check } } : null
}

export function swingPropAssetIds() {
  return Object.keys(SWING_PROPS).sort()
}

/** Опрокидываемая мебель: СЛ Атлетики по массивности и урон падения. */
const HEAVY_PROPS = Object.freeze({
  bookshelf: Object.freeze({ dc: 13, damage: '2d6', mass: 'высокий стеллаж' }),
  bar_shelf: Object.freeze({ dc: 13, damage: '2d6', mass: 'полка за стойкой' }),
  shelf_wall: Object.freeze({ dc: 13, damage: '2d6', mass: 'стеллаж' }),
  wardrobe: Object.freeze({ dc: 15, damage: '2d8', mass: 'платяной шкаф' }),
  cupboard: Object.freeze({ dc: 14, damage: '2d6', mass: 'буфет' }),
  crate_stack: Object.freeze({ dc: 13, damage: '2d6', mass: 'штабель ящиков' }),
  barrel_stack: Object.freeze({ dc: 14, damage: '2d6', mass: 'штабель бочек' }),
  table_long: Object.freeze({ dc: 12, damage: '1d6', mass: 'длинный стол' }),
  table_round: Object.freeze({ dc: 11, damage: '1d6', mass: 'круглый стол' }),
  table_small: Object.freeze({ dc: 10, damage: '1d6', mass: 'столик' }),
  bar_counter: Object.freeze({ dc: 15, damage: '2d6', mass: 'барная стойка' }),
  barrel: Object.freeze({ dc: 11, damage: '1d6', mass: 'бочка' }),
  keg: Object.freeze({ dc: 11, damage: '1d6', mass: 'бочонок' }),
  crate: Object.freeze({ dc: 10, damage: '1d6', mass: 'ящик' }),
  cart: Object.freeze({ dc: 14, damage: '2d6', mass: 'телега' }),
  market_stall: Object.freeze({ dc: 13, damage: '2d6', mass: 'торговый лоток' }),
  statue: Object.freeze({ dc: 16, damage: '2d8', mass: 'каменная статуя' }),
  pillar: Object.freeze({ dc: 17, damage: '2d8', mass: 'колонна' }),
})

/** Горючее: урон зоны и сколько раундов она держится. */
const FLAMMABLE_PROPS = Object.freeze({
  haystack: Object.freeze({ damage: '1d6', rounds: 3, what: 'стог сена' }),
  woodpile: Object.freeze({ damage: '1d6', rounds: 3, what: 'поленница' }),
  firewood_stack: Object.freeze({ damage: '1d6', rounds: 3, what: 'дрова' }),
  bookshelf: Object.freeze({ damage: '1d6', rounds: 3, what: 'стеллаж с книгами' }),
  bar_shelf: Object.freeze({ damage: '1d4', rounds: 2, what: 'полка за стойкой' }),
  shelf_wall: Object.freeze({ damage: '1d4', rounds: 2, what: 'стеллаж' }),
  wardrobe: Object.freeze({ damage: '1d4', rounds: 2, what: 'платяной шкаф' }),
  cupboard: Object.freeze({ damage: '1d4', rounds: 2, what: 'буфет' }),
  table_long: Object.freeze({ damage: '1d4', rounds: 2, what: 'длинный стол' }),
  table_round: Object.freeze({ damage: '1d4', rounds: 2, what: 'круглый стол' }),
  table_small: Object.freeze({ damage: '1d4', rounds: 2, what: 'столик' }),
  crate: Object.freeze({ damage: '1d4', rounds: 2, what: 'ящик' }),
  crate_stack: Object.freeze({ damage: '1d6', rounds: 3, what: 'штабель ящиков' }),
  barrel: Object.freeze({ damage: '1d4', rounds: 2, what: 'бочка' }),
  barrel_stack: Object.freeze({ damage: '1d6', rounds: 3, what: 'штабель бочек' }),
  keg: Object.freeze({ damage: '1d4', rounds: 2, what: 'бочонок' }),
  basket: Object.freeze({ damage: '1d4', rounds: 2, what: 'корзина' }),
  broom: Object.freeze({ damage: '1d4', rounds: 2, what: 'метла' }),
  cobweb: Object.freeze({ damage: '1d4', rounds: 2, what: 'паутина' }),
  banner: Object.freeze({ damage: '1d4', rounds: 2, what: 'полотнище' }),
  temple_banner: Object.freeze({ damage: '1d4', rounds: 2, what: 'храмовое полотнище' }),
  rug: Object.freeze({ damage: '1d4', rounds: 2, what: 'ковёр' }),
  market_stall: Object.freeze({ damage: '1d6', rounds: 3, what: 'торговый лоток' }),
  cart: Object.freeze({ damage: '1d6', rounds: 3, what: 'телега' }),
  bed: Object.freeze({ damage: '1d4', rounds: 2, what: 'постель' }),
  bunk_bed: Object.freeze({ damage: '1d6', rounds: 3, what: 'двухъярусная койка' }),
  prayer_bench: Object.freeze({ damage: '1d4', rounds: 2, what: 'скамья' }),
  bench: Object.freeze({ damage: '1d4', rounds: 2, what: 'скамья' }),
})

/** Открытый огонь на карте: от него поджигают, если он рядом. */
const FIRE_SOURCE_PROPS = Object.freeze([
  'campfire', 'brazier', 'hearth_fire', 'fireplace', 'torch_wall', 'lantern_wall', 'candelabra', 'candle', 'lamp_post', 'cauldron',
])

/** Предметы героя, которыми можно поджечь: тот же вопрос, что и «есть ли огонь». */
const FIRE_SOURCE_ITEMS = Object.freeze(['torch', 'tinderbox', 'lantern', 'candle', 'flint'])

const clean = (value, maximum = 160) => String(value ?? '').trim().slice(0, maximum)

/**
 * Ключ справочника из `assetId`. Идентификаторы в атласе плоские
 * (`table_long`, `crate_stack`), но карта может нести префикс пути, поэтому
 * берётся последний сегмент.
 */
export function hazardAssetKey(assetId) {
  const value = clean(assetId, 120).toLowerCase()
  if (!value) return ''
  const tail = value.split(/[\\/]/u).at(-1) ?? value
  return tail.replace(/\.[a-z0-9]+$/u, '')
}

/** Теги пропса. Ничего не хранится в состоянии — вывод детерминирован. */
export function sceneHazardTagsFor(assetId) {
  const key = hazardAssetKey(assetId)
  return {
    heavy: Object.hasOwn(HEAVY_PROPS, key),
    flammable: Object.hasOwn(FLAMMABLE_PROPS, key),
    fireSource: FIRE_SOURCE_PROPS.includes(key),
  }
}

/**
 * Все пропсы, которым справочник даёт хотя бы один глагол обстановки.
 *
 * Нужен сторожу. Операбельность решает каталог взаимодействий: без вида в нём
 * «поджечь сено» упрётся в `SCENE_OBJECT_UNSUPPORTED` уже в движке. Флаг
 * `interactive` реестра сторож требует не ради движка — `addProp` поднимает его
 * сам всякому предмету из каталога, — а чтобы реестр не расходился со
 * справочником; свой настоящий смысл флаг имеет только в `normalizeTransition`.
 */
export function sceneHazardAssetIds() {
  return [...new Set([...Object.keys(HEAVY_PROPS), ...Object.keys(FLAMMABLE_PROPS)])].sort()
}

/** Открытый огонь карты: без такого пропса или предмета поджечь нечем. */
export function fireSourceAssetIds() {
  return [...FIRE_SOURCE_PROPS]
}

/** Глаголы, которые справочник добавляет к обычным операциям пропса. */
export function sceneHazardVerbsFor(assetId) {
  const tags = sceneHazardTagsFor(assetId)
  return [...(tags.heavy ? ['topple'] : []), ...(tags.flammable ? ['ignite'] : [])]
}

export function toppleDefinitionFor(assetId) {
  const entry = HEAVY_PROPS[hazardAssetKey(assetId)]
  if (!entry) return null
  return {
    ability: 'str',
    skill: 'athletics',
    dc: entry.dc,
    purpose: 'scene-object:topple',
    damage: entry.damage,
    damage_type: 'bludgeoning',
    save_ability: 'dex',
    save_dc: entry.dc,
    mass: entry.mass,
  }
}

export function igniteDefinitionFor(assetId) {
  const entry = FLAMMABLE_PROPS[hazardAssetKey(assetId)]
  if (!entry) return null
  return {
    damage: entry.damage,
    damage_type: 'fire',
    rounds: entry.rounds,
    what: entry.what,
    save_ability: 'dex',
  }
}

/** Клетки пропса. Та же форма, что читает `sceneObjectDistance`. */
export function hazardPropCells(prop) {
  if (Array.isArray(prop?.footprint) && prop.footprint.length) {
    return prop.footprint
      .map((cell) => ({ x: Math.floor(Number(cell?.x)), y: Math.floor(Number(cell?.y)) }))
      .filter((cell) => Number.isFinite(cell.x) && Number.isFinite(cell.y))
  }
  const x = Math.floor(Number(prop?.x))
  const y = Math.floor(Number(prop?.y))
  return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
}

/**
 * Есть ли чем поджечь: открытый огонь на соседней клетке или подходящий
 * предмет в руках. Проверка серверная — заявка игрока её не заменяет.
 */
export function fireSourceNear(props, actorPosition, actor) {
  const at = { x: Math.floor(Number(actorPosition?.x)), y: Math.floor(Number(actorPosition?.y)) }
  if (Number.isFinite(at.x) && Number.isFinite(at.y)) {
    for (const prop of Array.isArray(props) ? props : []) {
      if (!sceneHazardTagsFor(prop?.assetId).fireSource) continue
      const near = hazardPropCells(prop).some((cell) => Math.max(Math.abs(cell.x - at.x), Math.abs(cell.y - at.y)) <= 1)
      if (near) return { kind: 'prop', id: clean(prop?.id, 120) }
    }
  }
  for (const item of Array.isArray(actor?.inventory) ? actor.inventory : []) {
    const haystack = `${clean(item?.id, 120)} ${clean(item?.catalog_id, 120)} ${clean(item?.name, 120)}`.toLowerCase()
    const match = FIRE_SOURCE_ITEMS.find((needle) => haystack.includes(needle))
    if (match) return { kind: 'item', id: clean(item?.id, 120) || match }
  }
  return null
}

/**
 * Запись горящей зоны для `SpellAreaCreated`.
 *
 * Форма ровно та же, что строит `CastSpell` для площадных заклинаний: тик по
 * входу и по концу хода читает только саму запись и никогда не разрешает
 * заклинание заново. Поэтому параллельной машинерии огня не заводится — только
 * своё происхождение в `spell_id`.
 *
 * `id` и `effect_id` заполняются оба: снятие зоны ищет по `effect_id ?? id`,
 * и запись без него не удалилась бы никогда.
 */
export function burningPropEffect({ propId, commandId, cells, definition, sourceActorId, round }) {
  const identifier = `hazard:burning-prop:${clean(propId, 120)}:${clean(commandId, 160)}`
  return {
    id: identifier,
    effect_id: identifier,
    spell_id: 'hazard:burning-prop',
    source_actor: clean(sourceActorId, 120),
    center: cells[0] ?? { x: 0, y: 0 },
    cells: cells.map((cell) => ({ x: cell.x, y: cell.y })),
    area_shape: 'line',
    radius_feet: 5,
    difficult_terrain: false,
    trigger_on_enter: true,
    trigger_on_turn_end: true,
    save_ability: definition.save_ability,
    save_dc: 12,
    condition: null,
    damage: definition.damage,
    damage_type: definition.damage_type,
    half_on_save: true,
    follows_source: false,
    open_flame: true,
    concentration: false,
    expires_round: Math.max(1, Number(round) || 1) + Math.max(1, Number(definition.rounds) || 2),
  }
}

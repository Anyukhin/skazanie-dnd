// Эталон `server/scene-map-design.mjs` для sk-scene-base.
// Запуск из корня репозитория: node rust/crates/sk-scene-base/fixtures/gen-scene-map-design.mjs
import { writeFileSync } from 'node:fs'

import { normalizeSceneMapDesign, sceneMapDesignFor, worldLocationDesignContext } from '../../../../server/scene-map-design.mjs'
import { jsonOf, rng, sentences, shuffled, worldLocations } from './corpus.mjs'

const LOCATION_NAMES = [
  'Мормар', 'Два Берега', 'Высохшее русло', 'Город порталов', 'Смотровая дамба', 'Старая плотина', 'Амбары у мельницы',
  'Трактир у дороги', 'Старый маяк', 'Маячная улица', 'Башня мага', 'Кузница Торна', 'Казармы стражи', 'Деревня Кленовка',
  'Село Липки', 'Хутор у болота', 'Столица', 'Рыночная площадь', 'Северные ворота', 'Застава', 'Горный склон', 'Вельдбург',
  'Ледяной дворец', 'Мраморный квартал', 'Глинобитная слобода', 'Крепость Штормберг', 'Галерея королей', 'Ротонда',
  'Г-образный дом', 'Крестообразный храм', 'Порт Ветлуга', 'Гавань', 'Портал', 'Магазин алхимика', 'Лаборатория некроманта',
  'Дом мага', 'Магистрат', 'Snow Peak', 'Desert Harbour', 'Swamp village', 'Port Royal', 'river crossing', 'the wizard tower',
  'Речная переправа', 'Междуречье', 'Дельта', 'Канал', 'Без реки', 'Вдоль тракта', 'Одна улица', 'Внутренний двор',
  'Постоялый двор', 'Корчма', 'Гостиница', 'Лавка', 'Мастерская', 'Склад', 'Особняк', 'Усадьба', 'Цитадель', 'Тронный зал',
  'Тундра', 'Мерзлота', 'Песчаный берег', 'Барханы', 'Трясина', 'Мангровая топь', 'Набережная', 'Верфь', 'Причал',
  'Пристань', 'Волнолом', 'Шлюз', 'Терраса', 'Кряж', 'На скале', 'Базар', 'Торговая площадь', 'Маленькая деревня',
  'Редкие дома', 'Разбросанные хижины', 'Тесный квартал', 'Густая застройка', 'Многолюдный город', 'Мегаполис', 'Великий город',
  'Сторожевая башня', 'Дозорная башня', 'Караульня', 'Гарнизон', 'Мельница', 'Белокаменный город', 'Кирпичный завод',
  'Деревянный сруб', 'Бревенчатый дом', 'Стальной город', 'Железный город', 'Изо льда', 'Саманная деревня', 'Сырцовые стены',
  'Чародейская башня', 'Колдун', 'Волшебник', 'Алхимия', 'Чернокнижник', 'Пересохшая река', 'Высохший канал', 'Без воды',
  '', '   ', 'МАЯКА', 'маяки', 'маячок', 'Магия', 'Магии нет', 'Магическая лавка',
]
const THEMES = ['', 'тихая деревня', 'портовый город', 'лес', 'пещера', 'храм', 'harbor', 'desert', 'tavern', 'маяк']
const DESCRIPTIONS = ['', 'Город на слиянии двух рек.', 'Здесь весело, реконструкция рынка уже закончилась.', 'Река пересохла, район без реки.',
  'Кирпичная дамба над соляными полями, у шлюзов толпа.', 'Морской берег и пристань.', 'Деревня в пустыне.', 'Снежная тундра и ледяные дома.']
const BIOMES = ['', 'plains', 'desert', 'marsh', 'tundra', 'forest', 'mountains', 'coast']
const WORLD = ['', 'На юге пустыня, на севере снежная тундра.', 'Болотистый край.', 'Засушливые степи.', 'Арктические острова, снег и лёд.']
const KINDS = [undefined, '', 'village', 'city', 'capital', 'port', 'town', 'fortress', 'VILLAGE', ' city ', 0, null]
const REQUESTS = [
  undefined, {}, { design: { topology: 'crossroads', climate: 'cold' } }, { design: { climate: 'arid', architecture: 'metal', density: 'sparse', building_use: 'mill', shape: 'L', scale: 'city' } },
  { design: { topology: 'lava', climate: 'lava' } }, { pattern: 'keep' }, { design: null }, { design: { landmarks: [{ kind: 'well', role: 'focus' }] } }, 'строка',
]

const cases = []
const next = rng(17)
const pick = (list) => list[Math.floor(next() * list.length)]
for (const location of LOCATION_NAMES) {
  for (let variant = 0; variant < 6; variant += 1) {
    const input = {}
    if (variant > 0) input.theme = pick(THEMES)
    if (variant > 1) input.description = pick(DESCRIPTIONS)
    if (variant > 2) input.biome = pick(BIOMES)
    if (variant > 1) input.worldDescription = pick(WORLD)
    const kind = pick(KINDS)
    if (kind !== undefined && variant % 2 === 0) input.worldKind = kind
    if (variant === 3) input.settlementType = pick(KINDS.filter((value) => value !== undefined))
    const request = pick(REQUESTS)
    if (request !== undefined) input.request = request
    input.location = location
    input.seed = `seed-${variant}-${location.length}`
    cases.push({ input, output: jsonOf(sceneMapDesignFor(input)) })
  }
}
// Живые места из карт миров: имя, описание, биом, описание мира.
for (const { world, location } of worldLocations()) {
  const input = {
    location: location.name,
    description: [location.summary, location.history].filter((value) => typeof value === 'string').join(' '),
    biome: location.biome ?? '',
    worldDescription: [world.world_summary, world.world?.premise, world.world?.boundaries].filter((value) => typeof value === 'string').join(' '),
    worldKind: location.kind ?? location.type ?? '',
    seed: `world:${location.id}`,
  }
  cases.push({ input, output: jsonOf(sceneMapDesignFor(input)) })
}
for (const sentence of shuffled(sentences(), 23).slice(0, 300)) {
  const input = { location: sentence.slice(0, 40), description: sentence, seed: sentence.length }
  cases.push({ input, output: jsonOf(sceneMapDesignFor(input)) })
}
for (const input of [{}, { seed: null }, { location: null, theme: null }, { location: 7, theme: true, seed: 3.5 }, { worldKind: 'port' }, { request: { design: { topology: 'harbor' } } }]) {
  cases.push({ input, output: jsonOf(sceneMapDesignFor(input)) })
}
cases.push({ input: null, output: jsonOf(sceneMapDesignFor()) })

const normalize = [
  { topology: 'harbor', density: 'dense', architecture: 'stone', climate: 'lava', building_use: 'teleport', seed: 'forged', houses: [{ x: 1, y: 1 }], hp: 900 },
  null, [], 'x', 42, {},
  { topology: 'river', climate: 'wetland', architecture: 'ice', density: 'mixed', building_use: 'smithy', shape: 'round', scale: 'town', landmarks: [{ kind: 'well', role: 'focus' }, { kind: 'ufo' }, { id: 'altar', role: 'clue', count: 3 }] },
  { shape: 'l', scale: 'City', topology: ['harbor'], landmarks: 'x' },
  { landmarks: [{ kind: 'statue', role: 'npc_post', npc: '  Страж  ' }] },
].map((input) => ({ input, output: jsonOf(normalizeSceneMapDesign(input)) }))

const worlds = [...new Set(worldLocations().map((entry) => entry.map))]
const contextCases = []
for (const [worldIndex, map] of worlds.entries()) {
  for (const location of map.locations ?? []) {
    contextCases.push({ worldIndex, locationId: location.id, location: null, output: jsonOf(worldLocationDesignContext(map, location.id)) })
    contextCases.push({ worldIndex, locationId: 'нет такого', location: location.name, output: jsonOf(worldLocationDesignContext(map, 'нет такого', location.name)) })
  }
  contextCases.push({ worldIndex, locationId: null, location: null, output: jsonOf(worldLocationDesignContext(map, null)) })
}
const SYNTHETIC = {
  regions: [{ id: 'south', biome: 'desert' }, { id: 7, biome: 42 }],
  locations: [
    { id: 'port', name: 'Мормар', known: true, summary: 'Гавань', history: 'Старые верфи', regionId: 'south' },
    { id: 'hidden', name: 'Тайник', known: false, summary: 'SECRET' },
    { id: 'gm', name: 'Логово', visibility: 'gm_only', summary: 'x' },
    { id: 'off', name: 'Скрыто', hidden: true },
    { id: 8, name: '  ＭОРМАР  ', summary: 7, history: 'История', region_id: 7 },
    { name: 'Без id', summary: 'Нет идентификатора', biome: 'tundra' },
    { id: 'long', name: 'Длинное', summary: 'а'.repeat(1700), biome: 'б'.repeat(100) },
  ],
}
const syntheticCases = []
for (const [locationId, location] of [['port', ''], ['hidden', ''], ['gm', ''], ['off', ''], [8, ''], ['8', ''], [null, ''], [undefined, ''], ['x', 'мормар'], ['x', 'Без id'], ['long', ''], ['x', null]]) {
  syntheticCases.push({ locationId: locationId === undefined ? '__undefined__' : locationId, location, output: jsonOf(worldLocationDesignContext(SYNTHETIC, locationId, location ?? undefined)) })
}

writeFileSync(new URL('./scene-map-design.json', import.meta.url), `${JSON.stringify({ cases, normalize, worlds, contexts: contextCases, synthetic: SYNTHETIC, syntheticCases })}\n`)
console.log(`scene-map-design: ${cases.length + normalize.length + contextCases.length + syntheticCases.length} случаев`)

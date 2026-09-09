#!/usr/bin/env node
// @ts-check
/**
 * Offline builder for the complete native-grid authored tactical catalog.
 * Большие imagegen overview assets сюда не подключаются; Ares берётся из
 * отдельного native-grid layout через общий authored-location builder.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetById } from '../server/asset-registry.mjs'
import { sceneInteractionCatalogEntry } from '../server/scene-interactions.mjs'
import { buildAuthoredLocationMap, revealInitialArea } from './build-authored-location-maps.mjs'
import {
  addProp, addSpawnPoint, addZone, cellAt, createTacticalMap,
  reachableCells, serializeTacticalMap, setCell, setDoor, setEdge,
  validateTacticalMap,
} from '../server/tactical-map.mjs'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
export const WORLD_FILE = resolve(ROOT, 'data/campaign-worlds-v1.json')
export const OVERVIEW_MANIFEST_FILE = resolve(ROOT, 'data/authored-location-overview-manifest-v1.json')
export const ARES_LAYOUT_FILE = resolve(ROOT, 'data/authored-tactical-ares-v1.json')
export const DEFAULT_OUTPUT = resolve(ROOT, 'data/authored-location-maps-v1.json')
export const SMALL_TACTICAL_GENERATOR_ID = 'authored-tactical-scene'
export const SMALL_TACTICAL_MARKER = /^authored-tactical:[a-z0-9][a-z0-9_-]{0,119}:v1$/u
export const EXCLUDED_LOCATION_ID = 'astohan-stormberg'
const MAX_WIDTH = 30
const MAX_HEIGHT = 24

const key = (x, y) => String(x) + ',' + String(y)
const text = (v) => String(v == null ? '' : v).trim()
const hashNumber = (v) => createHash('sha256').update(String(v)).digest().readUInt32LE(0)
const pick = (v, n) => hashNumber(v) % Math.max(1, n)

const FORM_GEOMETRIES = Object.freeze({
  rooms: 'court', fortress: 'court', shore: 'shore', harbor: 'shore', causeway: 'shore', 'submerged-street': 'shore', shipwreck: 'shore', 'lake-shore': 'shore', 'mill-town': 'shore', 'garden-canals': 'shore', spring: 'shore', 'fountain-court': 'court',
  lighthouse: 'tower', 'observatory-ruins': 'tower', tower: 'tower', 'wizard-tower': 'tower',
  cave: 'cave', shaft: 'cave', grotto: 'cave', cistern: 'cave',
  'rift-bridge': 'bridge', 'dry-bridge': 'bridge', 'obsidian-pass': 'bridge',
  'nomad-camp': 'camp', camp: 'camp', 'street-village': 'camp', 'dead-grove': 'camp', 'great-tree': 'camp', wild: 'camp',
  cloister: 'court', 'canal-gate': 'court', 'well-court': 'court', mausoleum: 'court', 'buried-quarter': 'court', 'temple-court': 'court', 'burnt-watch': 'court', 'caravan-yard': 'court',
  volcano: 'volcano', 'lava-islets': 'volcano', 'volcanic-lair': 'volcano', terraces: 'steps', quarry: 'steps',
})

const preset = (form, style, theme, material, props, firstZone) => ({ form, geometry: FORM_GEOMETRIES[form] || form, style, theme, material, props, firstZone })

/**
 * Адресные сцены намеренно собраны небольшим набором форм. Решение по
 * `locationId` держит геометрию и предметы рядом: слово «лес» в истории
 * больше не может превратить мост, башню или вулкан в лесную поляну.
 */
const LOCATION_PRESETS = Object.freeze({
  // Лига Девяти Приливов
  'tides-veld-burg': preset('harbor', 'shore', 'high-harbor', 'stone', ['market_stall', 'barrel_stack', 'crate_stack', 'well']),
  'tides-grunvik': preset('submerged-street', 'shore', 'submerged-city', 'stone', ['rubble_heap', 'barrel', 'crate_stack', 'boulder']),
  'tides-salt-gates': preset('harbor', 'shore', 'salt-port', 'sand', ['market_stall', 'barrel_stack', 'crate_stack', 'well']),
  'tides-three-koegs': preset('causeway', 'shore', 'brick-causeway', 'stone', ['village_fence', 'cart', 'barrel_stack', 'well']),
  'tides-sisters-hallig': preset('cloister', 'rooms', 'island-cloister', 'stone', ['pillar', 'prayer_bench', 'altar', 'brazier']),
  'tides-broken-stars-lighthouse': preset('lighthouse', 'shore', 'lighthouse', 'stone', ['stairs_up', 'brazier', 'barrel', 'rock_small']),
  'tides-cog-graveyard': preset('shipwreck', 'shore', 'shipwreck-shoal', 'sand', ['woodpile', 'barrel_stack', 'crate_stack', 'boulder']),
  'tides-north-watch': preset('fortress', 'fortress', 'watchtower', 'stone', ['crate_stack', 'barrel_stack', 'cart', 'brazier']),
  'tides-black-dike': preset('canal-gate', 'fortress', 'canal-fortress', 'stone', ['crate_stack', 'barrel_stack', 'cart', 'brazier']),
  'tides-reed-market': preset('harbor', 'shore', 'floating-market', 'wood', ['market_stall', 'cart', 'barrel_stack', 'crate_stack']),
  'tides-drowned-bell': preset('shaft', 'cave', 'drowned-bell-shaft', 'stone', ['stairs_down', 'brazier', 'rubble_heap', 'boulder']),
  'tides-archive-rift': preset('rift-bridge', 'rooms', 'rift-bridge', 'stone', ['boulder', 'rubble_heap', 'crate_stack', 'chest']),
  'tides-southern-firth': preset('harbor', 'shore', 'deep-harbor', 'wood', ['barrel_stack', 'crate_stack', 'cart', 'woodpile']),
  'tides-whisper-forest': preset('wild', 'wild', 'salt-edge-forest', 'earth', ['tree_spruce', 'boulder', 'fallen_log', 'milestone']),

  // Пояс Негаснущей Звезды
  'star-nur-kesh': preset('fountain-court', 'rooms', 'oasis-capital', 'marble', ['well', 'pillar', 'brazier', 'cart']),
  'star-ark-tash': preset('fortress', 'fortress', 'desert-fortress', 'sand', ['crate_stack', 'barrel_stack', 'cart', 'brazier']),
  'star-mirhad': preset('garden-canals', 'shore', 'canal-gardens', 'stone', ['tree_oak', 'bush', 'well', 'boulder']),
  'star-meridian-rift': preset('observatory-ruins', 'rooms', 'observatory-ruins', 'stone', ['pillar', 'boulder', 'rubble_heap', 'stairs_up']),
  'star-forty-wells': preset('well-court', 'rooms', 'forty-wells-caravanserai', 'sand', ['well', 'well', 'well', 'well']),
  'star-mirror-lake': preset('lake-shore', 'shore', 'salt-mirror-lake', 'sand', ['campfire', 'cart', 'boulder', 'water_trough']),
  'star-nameless-mausoleum': preset('mausoleum', 'cave', 'nameless-mausoleum', 'stone', ['sarcophagus', 'grave', 'urn', 'crypt_niche']),
  'star-dry-wind-gate': preset('fortress', 'fortress', 'mountain-pass-fortress', 'stone', ['crate_stack', 'barrel_stack', 'cart', 'brazier']),
  'star-red-caravanserai': preset('caravan-yard', 'rooms', 'red-caravanserai', 'sand', ['cart', 'well', 'barrel_stack', 'crate_stack']),
  'star-sky-steppe': preset('nomad-camp', 'wild', 'nomad-camp', 'sand', ['campfire', 'cart', 'water_trough', 'barrel']),
  'star-old-river-ford': preset('dry-bridge', 'wild', 'dry-stone-bridge', 'stone', ['boulder', 'rock_small', 'milestone', 'fallen_log']),
  'star-salt-road': preset('cave', 'cave', 'salt-mine', 'earth', ['boulder', 'crate_stack', 'stairs_down', 'barrel']),
  'star-broken-star-observatory': preset('tower', 'fortress', 'observatory-tower', 'stone', ['stairs_up', 'pillar', 'brazier', 'boulder']),
  'star-black-well': preset('well-court', 'rooms', 'black-well-court', 'stone', ['well', 'brazier', 'barrel', 'boulder']),

  // Чаша Пепельного Сада
  'ash-limnara': preset('harbor', 'shore', 'caldera-port', 'stone', ['well', 'barrel_stack', 'crate_stack', 'cart']),
  'ash-talass-akr': preset('buried-quarter', 'rooms', 'buried-city', 'sand', ['boulder', 'rubble_heap', 'table_long', 'chest']),
  'ash-elefra': preset('temple-court', 'rooms', 'pilgrim-temple', 'marble', ['altar', 'statue', 'pillar', 'reliquary']),
  'ash-port-somma': preset('harbor', 'shore', 'obsidian-harbor', 'stone', ['cart', 'crate_stack', 'barrel_stack', 'well']),
  'ash-black-cone': preset('volcano', 'wild', 'active-volcano', 'stone', ['boulder', 'rock_small', 'brazier', 'rubble_heap']),
  'ash-three-torches-grotto': preset('grotto', 'cave', 'black-water-grotto', 'stone', ['brazier', 'stairs_down', 'rubble_heap', 'boulder']),
  'ash-first-grain-terraces': preset('terraces', 'wild', 'grain-terraces', 'earth', ['haystack', 'cart', 'water_trough', 'boulder']),
  'ash-ash-gate': preset('fortress', 'fortress', 'pumice-mine-gate', 'stone', ['barrel_stack', 'cart', 'brazier', 'crate_stack']),
  'ash-returning-spring': preset('spring', 'shore', 'returning-spring', 'stone', ['well', 'boulder', 'brazier', 'stairs_down']),
  'ash-white-harbor': preset('harbor', 'shore', 'limestone-harbor', 'wood', ['crate_stack', 'cart', 'barrel_stack', 'well']),
  'ash-cinder-monastery': preset('cloister', 'rooms', 'cinder-monastery', 'stone', ['altar', 'pillar', 'prayer_bench', 'brazier']),
  'ash-pumice-quarries': preset('quarry', 'wild', 'pumice-quarry', 'stone', ['boulder', 'rock_small', 'cart', 'stairs_down']),
  'ash-underworld-cistern': preset('cistern', 'cave', 'underworld-cistern', 'stone', ['stairs_down', 'rubble_heap', 'boulder', 'barrel']),
  'ash-three-sisters-isle': preset('lava-islets', 'shore', 'lava-islets', 'stone', ['boulder', 'rock_small', 'brazier', 'cave_pool']),

  // Астоханские равнины (дворец Ares собирается отдельным layout-файлом)
  'astohan-ash-watch': preset('burnt-watch', 'rooms', 'burnt-watchtower', 'stone', ['rubble_heap', 'boulder', 'chest', 'barrel']),
  'astohan-mirror-lake': preset('lake-shore', 'shore', 'two-reflections-lake', 'earth', ['boulder', 'rock_small', 'fallen_log', 'campfire']),
  'astohan-forgotten-cliffs': preset('fortress', 'fortress', 'haunted-cliff-fortress', 'stone', ['boulder', 'rubble_heap', 'barrel_stack', 'brazier']),
  'astohan-mittlayd': preset('mill-town', 'shore', 'river-mill-town', 'stone', ['table_long', 'barrel_stack', 'cart', 'crate_stack']),
  'astohan-quiet-watch-camp': preset('camp', 'wild', 'quiet-watch-camp', 'earth', ['campfire', 'crate_stack', 'barrel_stack', 'cart']),
  'astohan-cursed-woods': preset('dead-grove', 'wild', 'cursed-deadwood', 'earth', ['tree_dead', 'tree_stump', 'boulder', 'roadside_shrine']),
  'astohan-redstone': preset('street-village', 'wild', 'redstone-village', 'stone', ['cart', 'well', 'crate_stack', 'barrel_stack']),
  'astohan-smugglers-cave': preset('cave', 'cave', 'smugglers-mine', 'stone', ['stairs_down', 'barrel', 'rubble_heap', 'boulder']),
  'astohan-lomar-tower': preset('wizard-tower', 'fortress', 'burnt-wizard-tower', 'stone', ['stairs_up', 'brazier', 'chest', 'rubble_heap']),
  'astohan-wild-forest': preset('wild', 'wild', 'ancient-wild-forest', 'grass', ['tree_oak', 'tree_spruce', 'boulder', 'fallen_log']),
  'astohan-eldrin-heart': preset('great-tree', 'wild', 'great-tree-grove', 'grass', ['tree_oak', 'tree_oak', 'boulder', 'roadside_shrine']),
  'astohan-obsidian-pass': preset('obsidian-pass', 'wild', 'obsidian-pass', 'stone', ['boulder', 'boulder', 'rock_small', 'stairs_down']),
  'astohan-vulkanis-brazier': preset('volcanic-lair', 'cave', 'volcanic-lair', 'stone', ['brazier', 'boulder', 'stairs_down', 'rubble_heap']),
})

const FORM_ZONE_DEFS = Object.freeze({
  'submerged-street': [
    { id: 'street-crossing', kind: 'exterior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Перекрёсток затонувших улиц' },
    { id: 'sunken-square', kind: 'exterior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Затонувшая площадь' },
  ],
  harbor: [
    { id: 'dock', kind: 'exterior', material: 'wood', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Деревянный причал' },
    { id: 'boathouse', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'vertical', label: 'Лодочный склад' },
  ],
  causeway: [
    { id: 'island-west', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Западный остров дамбы' },
    { id: 'island-east', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Восточный остров дамбы' },
  ],
  cloister: [
    { id: 'cloister-walk', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Крытая галерея клуатра' },
    { id: 'chapel', kind: 'interior', material: 'marble', lightLevel: 'dim', floorDirection: 'vertical', label: 'Часовня острова' },
  ],
  lighthouse: [
    { id: 'tower-room', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Основание маячной башни' },
    { id: 'rock-platform', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Скальная площадка' },
  ],
  shipwreck: [
    { id: 'shoal', kind: 'exterior', material: 'sand', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Отмель с обломками' },
    { id: 'wreck-hull', kind: 'exterior', material: 'wood', lightLevel: 'bright', floorDirection: 'vertical', label: 'Разбитый корпус' },
  ],
  shaft: [
    { id: 'bell-chamber', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'vertical', label: 'Нижняя камера колокольни' },
  ],
  grotto: [
    { id: 'black-pool', kind: 'exterior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: 'Чёрная вода грота' },
  ],
  'rift-bridge': [
    { id: 'bridge-head', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Каменный устой моста' },
    { id: 'rift', kind: 'exterior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: 'Дно разлома' },
  ],
  'canal-gate': [
    { id: 'gatehouse', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Башня шлюзовых ворот' },
    { id: 'gate-yard', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Двор дамбы' },
  ],
  'observatory-ruins': [
    { id: 'observatory-floor', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Зал разрушенной обсерватории' },
    { id: 'arc-court', kind: 'exterior', material: 'marble', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Площадка каменной дуги' },
  ],
  'well-court': [
    { id: 'well-ring', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Круг колодцев' },
  ],
  mausoleum: [
    { id: 'burial-hall', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Погребальный зал' },
    { id: 'tomb-niches', kind: 'interior', material: 'marble', lightLevel: 'dark', floorDirection: 'horizontal', label: 'Ниши мавзолея' },
  ],
  'dry-bridge': [
    { id: 'riverbank-west', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Западный сухой берег' },
    { id: 'riverbank-east', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Восточный сухой берег' },
  ],
  tower: [
    { id: 'tower-floor', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Круглый зал башни' },
  ],
  'nomad-camp': [
    { id: 'fire-circle', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Костровой круг' },
    { id: 'wagon-ring', kind: 'exterior', material: 'sand', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Кольцо повозок' },
  ],
  camp: [
    { id: 'fire-circle', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Костровой круг' },
    { id: 'wagon-ring', kind: 'exterior', material: 'sand', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Кольцо повозок' },
  ],
  'buried-quarter': [
    { id: 'buried-house-west', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Западный погребённый дом' },
    { id: 'buried-house-east', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Восточный погребённый дом' },
  ],
  'temple-court': [
    { id: 'sanctuary', kind: 'interior', material: 'marble', lightLevel: 'dim', floorDirection: 'vertical', label: 'Зал святилища' },
    { id: 'processional', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Процессуальная дорожка' },
  ],
  volcano: [
    { id: 'caldera-rim', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Кромка кальдеры' },
    { id: 'crater', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Лавовый кратер' },
  ],
  terraces: [
    { id: 'terrace-mid', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Средняя зерновая терраса' },
    { id: 'terrace-high', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Верхняя зерновая терраса' },
  ],
  quarry: [
    { id: 'quarry-bench', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Рабочая ступень карьера' },
    { id: 'quarry-wall', kind: 'exterior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Каменная стенка выработки' },
  ],
  cistern: [
    { id: 'cistern-hall', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Зал подземной цистерны' },
    { id: 'reservoir', kind: 'exterior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: 'Резервуар с водой' },
  ],
  'lava-islets': [
    { id: 'islet-east', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Восточный лавовый островок' },
    { id: 'islet-west', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Западный лавовый островок' },
    { id: 'hot-spring', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Горячий источник' },
  ],
  'burnt-watch': [
    { id: 'burnt-yard', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Сожжённый двор заставы' },
    { id: 'watch-house', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Обугленная башня' },
  ],
  'lake-shore': [
    { id: 'lake-bank', kind: 'exterior', material: 'sand', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Берег озера' },
    { id: 'water', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Вода озера' },
  ],
  'mill-town': [
    { id: 'mill-house', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'vertical', label: 'Мельничный двор' },
    { id: 'riverbank', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Речной берег' },
  ],
  'street-village': [
    { id: 'yard-west', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Западный деревенский двор' },
    { id: 'yard-east', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Восточный деревенский двор' },
  ],
  'obsidian-pass': [
    { id: 'cliff-pass', kind: 'exterior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Тёмный проход между скалами' },
  ],
  'great-tree': [
    { id: 'tree-circle', kind: 'exterior', material: 'grass', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Корневой круг Великого Древа' },
  ],
  'wizard-tower': [
    { id: 'burnt-yard', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Выжженный двор башни' },
    { id: 'tower-room', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Лаборатория чародея' },
  ],
  'volcanic-lair': [
    { id: 'lair', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: 'Логово над трещиной' },
    { id: 'fissure', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'vertical', label: 'Раскалённая трещина' },
  ],
  'fountain-court': [
    { id: 'arcade', kind: 'interior', material: 'marble', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Аркада школы астрономов' },
    { id: 'fountain', kind: 'exterior', material: 'marble', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Фонтанный бассейн' },
  ],
  'garden-canals': [
    { id: 'garden-bed', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Садовые террасы' },
    { id: 'canal', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Канал водяных часов' },
  ],
  'caravan-yard': [
    { id: 'wagon-yard', kind: 'exterior', material: 'sand', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Караванный двор' },
    { id: 'caravan-house', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'vertical', label: 'Постоялый зал' },
  ],
  spring: [
    { id: 'spring-bank', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Каменный берег источника' },
    { id: 'spring-pool', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Чаша горячего источника' },
  ],
  'dead-grove': [
    { id: 'dead-grove', kind: 'exterior', material: 'earth', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Круг мёртвых деревьев' },
  ],
})

function loadLocations(path = WORLD_FILE, { includeExcluded = false } = {}) {
  const root = JSON.parse(readFileSync(path, 'utf8'))
  return (Array.isArray(root.templates) ? root.templates : []).flatMap((template) => {
    const worldId = text(template.id)
    return (Array.isArray(template.world_map?.locations) ? template.world_map.locations : []).map((location) => ({ ...location, worldId }))
  }).filter((location) => text(location.id) && (includeExcluded || text(location.id) !== EXCLUDED_LOCATION_ID))
    .sort((a, b) => text(a.id).localeCompare(text(b.id)))
}

function loadOverviewZones(path = OVERVIEW_MANIFEST_FILE) {
  if (!existsSync(path)) return new Map()
  try {
    const root = JSON.parse(readFileSync(path, 'utf8'))
    return new Map((Array.isArray(root.entries) ? root.entries : []).map((entry) => [text(entry.locationId), text(entry.firstPlayableZone)]).filter((entry) => entry[0] && entry[1]))
  } catch { return new Map() }
}

function presetFor(location) {
  return LOCATION_PRESETS[text(location?.id)] || null
}

export function locationPresetFor(locationId) {
  const value = LOCATION_PRESETS[text(locationId)]
  return value ? { ...value, props: [...value.props] } : null
}

function styleFor(location) {
  const authored = presetFor(location)
  if (authored?.style) return authored.style
  const kind = text(location.kind)
  if (kind === 'dungeon') return 'cave'
  if (kind === 'port') return 'shore'
  if (kind === 'fortress') return 'fortress'
  if (kind === 'wilds') return 'wild'
  return 'rooms'
}

function themeFor(location, style) {
  const authored = presetFor(location)
  const form = authored?.form || ''
  if (['cloister', 'temple-court'].includes(form)) return 'temple'
  if (['mausoleum', 'volcano', 'lava-islets', 'volcanic-lair'].includes(form)) return 'cave'
  if (['rift-bridge', 'dry-bridge', 'obsidian-pass', 'causeway', 'quarry'].includes(form)) return 'road'
  if (['fountain-court', 'well-court', 'caravan-yard', 'street-village'].includes(form)) return 'settlement'
  if (form === 'spring') return 'forest'
  if (style === 'cave') return 'cave'
  if (style === 'wild') return 'forest'
  if (style === 'shore') return 'settlement'
  if (style === 'fortress') return 'building'
  return 'building'
}

function materialFor(location, style) {
  const authored = presetFor(location)
  if (authored?.material) return authored.material
  const choices = style === 'cave' ? ['stone', 'earth', 'sand']
    : style === 'wild' ? ['grass', 'earth', 'stone']
      : text(location.worldId) === 'unfading-star-belt' ? ['sand', 'stone', 'marble']
        : text(location.worldId) === 'league-nine-tides' ? ['stone', 'wood', 'sand'] : ['stone', 'wood', 'earth']
  return choices[pick(location.id, choices.length)]
}

function sizeFor(location, style) {
  const authored = presetFor(location)
  const form = authored?.form
  if (['submerged-street', 'rift-bridge', 'dry-bridge', 'obsidian-pass'].includes(form)) return [28, 20]
  if (['lighthouse', 'tower', 'wizard-tower', 'volcano', 'cistern', 'lava-islets'].includes(form)) return [26, 20]
  if (['cloister', 'observatory-ruins', 'mausoleum', 'fountain-court', 'garden-canals'].includes(form)) return [28, 20]
  const roll = hashNumber(location.id)
  if (style === 'wild') return roll % 2 ? [24, 18] : [26, 20]
  if (style === 'cave') return roll % 2 ? [26, 20] : [24, 18]
  if (style === 'fortress') return roll % 2 ? [26, 20] : [28, 20]
  return roll % 2 ? [24, 18] : [26, 20]
}

function fallbackFirstZone(location, style) {
  const authored = presetFor(location)
  if (authored?.firstZone) return authored.firstZone
  if (style === 'cave') return 'Входная камера'
  if (style === 'fortress') return 'Ворота крепости'
  if (style === 'wild') return 'Открытая поляна'
  if (style === 'shore') return 'Прибрежный двор'
  return 'Входной двор'
}

function addRect(floors, zone, x0, y0, width, height) {
  for (let y = y0; y < y0 + height; y += 1) for (let x = x0; x < x0 + width; x += 1) floors.set(key(x, y), zone)
}

function addEllipse(floors, zone, cx, cy, rx, ry) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
    if (rx > 0 && ry > 0 && ((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2) <= 1) floors.set(key(x, y), zone)
  }
}

function addLine(floors, zone, from, to) {
  let x = from[0]
  let y = from[1]
  while (x !== to[0]) { floors.set(key(x, y), zone); x += Math.sign(to[0] - x) }
  while (y !== to[1]) { floors.set(key(x, y), zone); y += Math.sign(to[1] - y) }
  floors.set(key(x, y), zone)
}

function insideMap(x, y, width, height) { return x >= 0 && y >= 0 && x < width && y < height }

function removeEllipse(floors, cx, cy, rx, ry) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
    if (rx > 0 && ry > 0 && ((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2) <= 1) floors.delete(key(x, y))
  }
}

function removeRect(floors, x0, y0, width, height) {
  for (let y = y0; y < y0 + height; y += 1) for (let x = x0; x < x0 + width; x += 1) floors.delete(key(x, y))
}

function shapeCells(type, args) {
  const scratch = new Map()
  if (type === 'ellipse') addEllipse(scratch, 'special', ...args)
  else addRect(scratch, 'special', ...args)
  return scratch.keys()
}

function connectFloors(floors, width, height) {
  for (const raw of [...floors.keys()]) {
    const xy = raw.split(',').map(Number)
    if (!insideMap(xy[0], xy[1], width, height)) floors.delete(raw)
  }
  while (true) {
    const pending = new Set(floors.keys())
    const components = []
    while (pending.size) {
      const start = pending.values().next().value
      pending.delete(start)
      const component = new Set([start])
      const queue = [start]
      for (let i = 0; i < queue.length; i += 1) {
        const xy = queue[i].split(',').map(Number)
        for (const delta of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = key(xy[0] + delta[0], xy[1] + delta[1])
          if (!pending.has(next)) continue
          pending.delete(next); component.add(next); queue.push(next)
        }
      }
      components.push(component)
    }
    if (components.length <= 1) return
    let best = null
    for (const left of components[0]) {
      const a = left.split(',').map(Number)
      for (let i = 1; i < components.length; i += 1) for (const right of components[i]) {
        const b = right.split(',').map(Number)
        const distance = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
        if (!best || distance < best.distance) best = { a, b, distance }
      }
    }
    if (!best) throw new Error('Не удалось соединить клетки малой карты')
    addLine(floors, 'ground', best.a, best.b)
  }
}

function floorPlan(location, style, width, height, roll) {
  const floors = new Map()
  const water = []
  const specials = []
  const cx = Math.floor(width / 2)
  const cy = Math.floor(height / 2)
  const form = presetFor(location)?.form || style
  if (form === 'rooms' || form === 'fortress') {
    addRect(floors, 'ground', 3, 7, width - 6, height - 9)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
    addRect(floors, 'room-west', 2, 2, 7, 5)
    addRect(floors, 'room-east', width - 9, 2, 7, 5)
    addRect(floors, 'ground', 4, 6, 3, 2)
    addRect(floors, 'ground', width - 7, 6, 3, 2)
    if (form === 'fortress') addRect(floors, 'wall-walk', 2, 10, 3, height - 12)
    if (roll % 3 === 0) addRect(floors, 'side-court', width - 5, 12, 3, 4)
  } else if (form === 'cave') {
    addEllipse(floors, 'cave-chamber', Math.floor(width * .4), Math.floor(height * .55), Math.floor(width * .26), Math.floor(height * .3))
    addEllipse(floors, 'deep-chamber', Math.floor(width * .72), Math.floor(height * .35), Math.floor(width * .18), Math.floor(height * .2))
    addLine(floors, 'ground', [cx, height - 2], [Math.floor(width * .4), Math.floor(height * .7)])
    addLine(floors, 'ground', [Math.floor(width * .4), Math.floor(height * .55)], [Math.floor(width * .72), Math.floor(height * .38)])
  } else if (form === 'grotto') {
    addEllipse(floors, 'ground', Math.floor(width * .42), Math.floor(height * .55), Math.floor(width * .3), Math.floor(height * .3))
    addEllipse(floors, 'ground', Math.floor(width * .72), Math.floor(height * .35), Math.floor(width * .18), Math.floor(height * .2))
    addLine(floors, 'ground', [cx, height - 2], [Math.floor(width * .42), Math.floor(height * .7)])
    addLine(floors, 'ground', [Math.floor(width * .42), Math.floor(height * .55)], [Math.floor(width * .72), Math.floor(height * .38)])
    removeEllipse(floors, Math.floor(width * .42), Math.floor(height * .55), 2, 2)
    specials.push({ type: 'ellipse', args: [Math.floor(width * .42), Math.floor(height * .55), 2, 2], zone: 'black-pool', surface: 'water', material: 'stone' })
  } else if (form === 'wild') {
    addEllipse(floors, 'clearing', cx, Math.floor(height * .52), Math.floor(width * .32), Math.floor(height * .31))
    addEllipse(floors, 'grove', Math.floor(width * .72), Math.floor(height * .3), Math.floor(width * .18), Math.floor(height * .18))
    addLine(floors, 'ground', [cx, height - 2], [cx, Math.floor(height * .52)])
    addLine(floors, 'ground', [cx, Math.floor(height * .52)], [Math.floor(width * .72), Math.floor(height * .3)])
    addLine(floors, 'ground', [cx, Math.floor(height * .52)], [3, Math.floor(height * .62)])
  } else if (form === 'shore') {
    addEllipse(floors, 'ground', Math.floor(width * .42), Math.floor(height * .54), Math.floor(width * .35), Math.floor(height * .34))
    addRect(floors, 'ground', cx - 1, height - 3, 3, 3)
    addRect(floors, 'room-a', 3, 3, 6, 5)
    addRect(floors, 'room-b', width - 9, 3, 6, 5)
    addRect(floors, 'dock', Math.floor(width * .6), Math.floor(height * .62), Math.max(3, Math.floor(width * .3)), 2)
    water.push({ type: 'rect', args: [width - 3, 2, 3, height - 4] })
  } else if (form === 'harbor') {
    addRect(floors, 'ground', 3, 8, width - 6, height - 10)
    addRect(floors, 'boathouse', 3, 3, 7, 5)
    addRect(floors, 'dock', cx - 2, 4, 5, height - 6)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
    water.push({ type: 'rect', args: [width - 4, 2, 4, height - 4] })
  } else if (form === 'causeway') {
    addRect(floors, 'ground', 3, cy - 1, width - 6, 3)
    addRect(floors, 'island-west', 3, 4, 7, 6)
    addRect(floors, 'island-east', width - 10, 4, 7, 6)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy])
    water.push({ type: 'rect', args: [3, 2, width - 6, Math.max(1, cy - 4)] })
    water.push({ type: 'rect', args: [3, cy + 2, width - 6, Math.max(1, height - cy - 4)] })
  } else if (form === 'submerged-street') {
    addRect(floors, 'ground', 3, cy - 1, width - 6, 3)
    addRect(floors, 'street-crossing', cx - 1, 3, 3, height - 6)
    addRect(floors, 'sunken-square', 4, 4, 6, 5)
    addRect(floors, 'sunken-square', width - 10, 4, 6, 5)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy])
    water.push({ type: 'rect', args: [3, 2, width - 6, 2] })
    water.push({ type: 'rect', args: [3, height - 3, width - 6, 2] })
  } else if (form === 'cloister') {
    addRect(floors, 'ground', 7, 6, width - 14, height - 10)
    addRect(floors, 'cloister-walk', 5, 4, width - 10, 2)
    addRect(floors, 'cloister-walk', 5, height - 6, width - 10, 2)
    addRect(floors, 'cloister-walk', 5, 6, 2, height - 10)
    addRect(floors, 'cloister-walk', width - 7, 6, 2, height - 10)
    addRect(floors, 'chapel', cx - 3, 2, 7, 4)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
    if (location?.id === 'tides-sisters-hallig') {
      water.push({ type: 'rect', args: [3, 2, width - 6, 2] })
      water.push({ type: 'rect', args: [width - 3, 2, 3, height - 4] })
    }
  } else if (form === 'lighthouse') {
    addEllipse(floors, 'rock-platform', cx, cy + 1, Math.floor(width * .4), Math.floor(height * .34))
    addRect(floors, 'tower-room', cx - 2, 3, 5, height - 8)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
    water.push({ type: 'rect', args: [3, 2, width - 6, 3] })
    water.push({ type: 'rect', args: [width - 3, 2, 3, height - 4] })
  } else if (form === 'shipwreck') {
    addEllipse(floors, 'shoal', cx, cy + 1, Math.floor(width * .4), Math.floor(height * .3))
    addRect(floors, 'wreck-hull', cx - 7, cy - 2, 14, 4)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy + 3])
    water.push({ type: 'rect', args: [3, 2, width - 6, 3] })
    water.push({ type: 'rect', args: [width - 3, 2, 3, height - 4] })
  } else if (form === 'shaft') {
    addRect(floors, 'ground', cx - 5, 4, 10, height - 7)
    addRect(floors, 'bell-chamber', cx - 7, 3, 14, 5)
    addLine(floors, 'ground', [cx, height - 2], [cx, 8])
    removeEllipse(floors, cx, height - 5, 3, 2)
    specials.push({ type: 'ellipse', args: [cx, height - 5, 3, 2], zone: 'water', surface: 'water', material: 'stone' })
  } else if (form === 'rift-bridge') {
    addRect(floors, 'ground', cx - 2, 2, 5, height - 4)
    addRect(floors, 'bridge-head', 4, 4, 6, 6)
    addRect(floors, 'bridge-head', width - 10, height - 10, 6, 6)
    addLine(floors, 'ground', [cx, height - 2], [cx, height - 5])
    addLine(floors, 'ground', [cx, 2], [cx, 5])
    specials.push({ type: 'rect', args: [4, 10, Math.max(1, cx - 6), height - 14], zone: 'rift', surface: 'rubble', material: 'stone' })
    specials.push({ type: 'rect', args: [cx + 3, 4, Math.max(1, width - cx - 7), height - 8], zone: 'rift', surface: 'rubble', material: 'stone' })
  } else if (form === 'canal-gate') {
    addRect(floors, 'gate-yard', 3, 4, width - 6, height - 7)
    addRect(floors, 'gatehouse', cx - 4, 4, 9, 6)
    removeRect(floors, 3, 10, width - 6, 5)
    addRect(floors, 'ground', cx - 2, 9, 5, height - 12)
    water.push({ type: 'rect', args: [3, 10, width - 6, 5] })
  } else if (form === 'observatory-ruins') {
    addEllipse(floors, 'arc-court', cx, cy + 1, Math.floor(width * .4), Math.floor(height * .35))
    addEllipse(floors, 'observatory-floor', cx, cy - 1, 5, 4)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
  } else if (form === 'well-court') {
    addRect(floors, 'ground', 3, 4, width - 6, height - 7)
    addRect(floors, 'well-ring', 5, 6, width - 10, height - 11)
    addRect(floors, 'ground', cx - 1, height - 3, 3, 3)
    water.push({ type: 'ellipse', args: [width - 5, 5, 2, 2] })
  } else if (form === 'mausoleum') {
    addRect(floors, 'ground', 4, 8, width - 8, height - 10)
    addRect(floors, 'burial-hall', cx - 5, 3, 10, 6)
    addRect(floors, 'tomb-niches', 4, 4, 4, 4)
    addRect(floors, 'tomb-niches', width - 8, 4, 4, 4)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
  } else if (form === 'dry-bridge') {
    addRect(floors, 'ground', 3, cy - 1, width - 6, 3)
    addRect(floors, 'riverbank-west', 3, 4, 7, cy - 6)
    addRect(floors, 'riverbank-east', width - 10, 4, 7, cy - 6)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy])
    addLine(floors, 'riverbank-west', [6, cy - 4], [cx - 2, cy - 1])
    addLine(floors, 'riverbank-east', [width - 7, cy - 4], [cx + 2, cy - 1])
    specials.push({ type: 'rect', args: [3, cy - 4, width - 6, 2], zone: 'riverbed', surface: 'rubble', material: 'earth' })
  } else if (form === 'tower' || form === 'wizard-tower') {
    addEllipse(floors, 'ground', cx, cy + 1, Math.floor(width * .36), Math.floor(height * .35))
    addRect(floors, form === 'tower' ? 'tower-floor' : 'tower-room', cx - 3, 3, 7, height - 8)
    if (form === 'wizard-tower') addRect(floors, 'burnt-yard', 4, 5, 6, 5)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
  } else if (form === 'nomad-camp' || form === 'camp') {
    addEllipse(floors, 'ground', cx, cy + 1, Math.floor(width * .39), Math.floor(height * .34))
    addEllipse(floors, 'wagon-ring', cx, cy, Math.floor(width * .25), Math.floor(height * .22))
    addEllipse(floors, 'fire-circle', cx, cy, 4, 3)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
  } else if (form === 'buried-quarter') {
    addRect(floors, 'ground', 3, cy - 1, width - 6, 3)
    addRect(floors, 'buried-house-west', 3, 3, 8, 6)
    addRect(floors, 'buried-house-east', width - 11, 3, 8, 6)
    addRect(floors, 'ground', 4, 11, 6, 5)
    addRect(floors, 'ground', width - 10, 11, 6, 5)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy])
  } else if (form === 'temple-court') {
    addRect(floors, 'ground', 4, 8, width - 8, height - 10)
    addRect(floors, 'sanctuary', cx - 4, 3, 9, 6)
    addRect(floors, 'processional', cx - 1, height - 4, 3, 4)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
  } else if (form === 'volcano') {
    addEllipse(floors, 'caldera-rim', cx, cy + 1, Math.floor(width * .42), Math.floor(height * .4))
    removeEllipse(floors, cx, cy, 4, 3)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy + 4])
    // Жерло остаётся непроходимой пустотой: малая карта не вводит механику лавы.
    specials.push({ type: 'ellipse', args: [cx, cy, 4, 3], zone: 'crater', surface: 'none', material: 'stone' })
  } else if (form === 'terraces') {
    addRect(floors, 'ground', 3, 13, width - 6, 4)
    addRect(floors, 'terrace-mid', 5, 9, width - 10, 4)
    addRect(floors, 'terrace-high', 7, 5, width - 14, 4)
    addLine(floors, 'ground', [cx, height - 2], [cx, 14])
    addLine(floors, 'terrace-mid', [cx, 12], [cx, 10])
    addLine(floors, 'terrace-high', [cx, 8], [cx, 5])
  } else if (form === 'quarry') {
    addRect(floors, 'ground', 5, 12, width - 10, 5)
    addRect(floors, 'quarry-bench', 3, 7, 7, 5)
    addRect(floors, 'quarry-bench', width - 10, 7, 7, 5)
    addRect(floors, 'quarry-wall', 7, 3, width - 14, 4)
    addLine(floors, 'ground', [cx, height - 2], [cx, 14])
    addLine(floors, 'quarry-bench', [cx - 2, 11], [cx - 2, 8])
    addLine(floors, 'quarry-wall', [cx, 7], [cx, 4])
  } else if (form === 'cistern') {
    addEllipse(floors, 'cistern-hall', cx, cy + 1, Math.floor(width * .4), Math.floor(height * .36))
    removeEllipse(floors, cx, cy, 5, 3)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy + 4])
    specials.push({ type: 'ellipse', args: [cx, cy, 5, 3], zone: 'reservoir', surface: 'water', material: 'stone' })
  } else if (form === 'lava-islets') {
    addEllipse(floors, 'islet-west', cx - 6, cy - 2, 4, 3)
    addEllipse(floors, 'islet-east', cx + 6, cy - 2, 4, 3)
    addEllipse(floors, 'hot-spring', cx, cy + 5, 4, 3)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy + 5])
    addLine(floors, 'ground', [cx - 2, cy + 2], [cx - 6, cy - 2])
    addLine(floors, 'ground', [cx + 2, cy + 2], [cx + 6, cy - 2])
    water.push({ type: 'rect', args: [3, 2, width - 6, 3] })
    water.push({ type: 'rect', args: [3, height - 3, width - 6, 2] })
  } else if (form === 'burnt-watch') {
    addRect(floors, 'burnt-yard', 4, 8, width - 8, height - 10)
    addRect(floors, 'watch-house', cx - 4, 3, 9, 6)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
  } else if (form === 'lake-shore') {
    addRect(floors, 'ground', 3, 11, width - 6, height - 8)
    addRect(floors, 'lake-bank', 3, 8, width - 6, 3)
    addLine(floors, 'ground', [cx, height - 2], [cx, 10])
    water.push({ type: 'rect', args: [3, 2, width - 6, 6] })
  } else if (form === 'mill-town') {
    addRect(floors, 'ground', 3, 8, width - 7, height - 10)
    addRect(floors, 'mill-house', cx - 4, 3, 9, 6)
    addRect(floors, 'riverbank', width - 7, 8, 4, height - 10)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
    water.push({ type: 'rect', args: [width - 3, 2, 3, height - 4] })
  } else if (form === 'street-village') {
    addRect(floors, 'ground', cx - 2, 2, 5, height - 4)
    addRect(floors, 'yard-west', 3, 5, 7, 7)
    addRect(floors, 'yard-east', width - 10, 5, 7, 7)
    addRect(floors, 'ground', 3, 14, width - 6, 3)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
  } else if (form === 'obsidian-pass') {
    addRect(floors, 'ground', 4, 8, 6, 7)
    addRect(floors, 'cliff-pass', cx - 3, 5, 7, 10)
    addRect(floors, 'ground', width - 10, 3, 6, 7)
    addLine(floors, 'ground', [6, 14], [cx - 1, 12])
    addLine(floors, 'cliff-pass', [cx, 12], [width - 7, 6])
    addLine(floors, 'ground', [cx, height - 2], [6, 14])
  } else if (form === 'great-tree' || form === 'dead-grove') {
    addEllipse(floors, form === 'great-tree' ? 'ground' : 'dead-grove', cx, cy + 1, Math.floor(width * .38), Math.floor(height * .34))
    if (form === 'great-tree') addEllipse(floors, 'tree-circle', cx, cy, 5, 4)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy + 3])
  } else if (form === 'volcanic-lair') {
    addEllipse(floors, 'ground', cx, cy + 1, Math.floor(width * .4), Math.floor(height * .34))
    addRect(floors, 'lair', cx - 4, 3, 9, 6)
    addLine(floors, 'ground', [cx, height - 2], [cx, 8])
    removeRect(floors, cx + 4, 8, 2, 4)
    // Горячая трещина — только непроходимый участок, без oil-поверхности.
    specials.push({ type: 'rect', args: [cx + 4, 8, 2, height - 11], zone: 'fissure', surface: 'none', material: 'stone' })
  } else if (form === 'fountain-court') {
    addRect(floors, 'ground', 4, 7, width - 8, height - 9)
    addRect(floors, 'arcade', cx - 5, 3, 10, 5)
    removeEllipse(floors, cx, cy + 1, 2, 2)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
    specials.push({ type: 'ellipse', args: [cx, cy + 1, 2, 2], zone: 'fountain', surface: 'water', material: 'marble' })
  } else if (form === 'garden-canals') {
    addRect(floors, 'ground', 3, 5, width - 6, height - 8)
    addRect(floors, 'garden-bed', 5, 7, width - 10, height - 12)
    addLine(floors, 'ground', [cx, height - 2], [cx, 6])
    removeRect(floors, width - 6, 5, 3, height - 8)
    specials.push({ type: 'rect', args: [width - 6, 5, 3, height - 8], zone: 'canal', surface: 'water', material: 'stone' })
  } else if (form === 'caravan-yard') {
    addEllipse(floors, 'wagon-yard', cx, cy + 1, Math.floor(width * .4), Math.floor(height * .34))
    addRect(floors, 'caravan-house', cx - 4, 3, 9, 6)
    addRect(floors, 'ground', cx - 1, height - 2, 3, 2)
  } else if (form === 'spring') {
    addEllipse(floors, 'spring-bank', cx, cy + 1, Math.floor(width * .4), Math.floor(height * .34))
    removeEllipse(floors, cx, cy, 4, 3)
    addLine(floors, 'ground', [cx, height - 2], [cx, cy + 4])
    specials.push({ type: 'ellipse', args: [cx, cy, 4, 3], zone: 'spring-pool', surface: 'water', material: 'stone' })
  } else {
    addEllipse(floors, 'ground', Math.floor(width * .42), Math.floor(height * .54), Math.floor(width * .35), Math.floor(height * .34))
    addRect(floors, 'ground', cx - 1, height - 3, 3, 3)
  }
  connectFloors(floors, width, height)
  const waterCells = new Set()
  for (const entry of water) {
    for (const raw of shapeCells(entry.type, entry.args)) {
      const [x, y] = raw.split(',').map(Number)
      if (insideMap(x, y, width, height) && !floors.has(raw)) waterCells.add(raw)
    }
  }
  const specialCells = new Map()
  for (const entry of specials) for (const raw of shapeCells(entry.type, entry.args)) {
    const [x, y] = raw.split(',').map(Number)
    if (insideMap(x, y, width, height) && !floors.has(raw) && !waterCells.has(raw)) specialCells.set(raw, { zone: entry.zone, surface: entry.surface, material: entry.material })
  }
  return { floors, waterCells, specialCells }
}

function zoneDefinitions(location, style, firstZone, material, form, hasWater, specialZones = new Set()) {
  const authored = presetFor(location)
  const actualForm = form || authored?.form || style
  const custom = FORM_ZONE_DEFS[actualForm]
  const result = [{ id: 'ground', kind: 'exterior', material, lightLevel: style === 'cave' ? 'dim' : 'bright', floorDirection: 'horizontal', label: firstZone || text(location.name) }]
  if (custom) result.push(...custom.map((zone) => ({ ...zone })))
  else if (actualForm === 'rooms' || actualForm === 'fortress') {
    result.push({ id: 'room-west', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'vertical', label: style === 'fortress' ? 'Западная казарма' : 'Западная комната' })
    result.push({ id: 'room-east', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: style === 'fortress' ? 'Восточная башня' : 'Восточная комната' })
    if (style === 'fortress') result.push({ id: 'wall-walk', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Стена и проход дозора' })
    if (actualForm === 'rooms' && location?.id === 'astohan-mittlayd') result[1].label = 'Мельничный зал'
  } else if (actualForm === 'cave') {
    result.push({ id: 'cave-chamber', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Входная пещера' }, { id: 'deep-chamber', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: 'Дальняя полость' })
  } else if (actualForm === 'wild') {
    result.push({ id: 'clearing', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Лесная поляна' }, { id: 'grove', kind: 'exterior', material: 'grass', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Тихая роща' })
  } else {
    result.push({ id: 'room-a', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Прибрежная комната' }, { id: 'room-b', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Служебное помещение' }, { id: 'dock', kind: 'exterior', material: 'wood', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Деревянный причал' })
  }
  for (const zoneId of specialZones) if (!result.some((zone) => zone.id === zoneId)) result.push({ id: zoneId, kind: 'exterior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: zoneId })
  if (hasWater) {
    const waterDefinition = result.find((zone) => zone.id === 'water' || zone.id === 'reservoir' || zone.id === 'lake-water' || zone.id === 'spring-pool' || zone.id === 'fountain')
    if (!waterDefinition) result.push({ id: 'water', kind: 'exterior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Вода' })
  }
  const labels = new Set()
  for (const zone of result) {
    if (labels.has(zone.label)) zone.label = zone.label + ' · ' + zone.id
    labels.add(zone.label)
  }
  return result
}

function propAssets(location, style) {
  const authored = presetFor(location)
  if (authored?.props?.length) return authored.props
  return {
    rooms: ['table_long', 'bookshelf', 'crate_stack', 'barrel_stack', 'chest'],
    fortress: ['crate_stack', 'barrel_stack', 'cart', 'brazier', 'table_small'],
    cave: ['rubble_heap', 'boulder', 'crate_stack', 'stairs_down', 'barrel'],
    wild: ['tree_oak', 'boulder', 'fallen_log', 'tree_stump', 'campfire'],
    shore: ['barrel_stack', 'crate_stack', 'cart', 'market_stall', 'well'],
  }[style]
}

function footprintFor(asset, x, y) {
  const width = Math.max(1, Number(asset?.baseFootprint?.w) || 1)
  const height = Math.max(1, Number(asset?.baseFootprint?.h) || 1)
  return Array.from({ length: width * height }, (_, index) => ({ x: x + index % width, y: y + Math.floor(index / width) }))
}

function rotationFor(asset, locationId, index) {
  const width = Math.max(1, Number(asset?.baseFootprint?.w) || 1)
  const height = Math.max(1, Number(asset?.baseFootprint?.h) || 1)
  const flip = hashNumber(locationId + ':prop-rotation:' + index) % 2
  if (width > height) return flip * 180
  if (height > width) return 90 + flip * 180
  return (hashNumber(locationId + ':prop-square-rotation:' + index) % 4) * 90
}

function placementFits(floors, occupied, reserved, footprint, width, height) {
  return footprint.every((cell) => insideMap(cell.x, cell.y, width, height) && floors.has(key(cell.x, cell.y)) && !occupied.has(key(cell.x, cell.y)) && !reserved.has(key(cell.x, cell.y)))
}

function placeProp(map, locationId, assetId, desired, floors, occupied, reserved, index) {
  const asset = assetById(assetId)
  if (!asset) throw new Error(locationId + ': неизвестный native assetId ' + assetId)
  const width = Math.max(1, Number(asset.baseFootprint?.w) || 1)
  const height = Math.max(1, Number(asset.baseFootprint?.h) || 1)
  const maxX = map.width - width
  const maxY = map.height - height
  for (let radius = 0; radius < Math.max(map.width, map.height); radius += 1) for (const delta of [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
    const x = Math.max(0, Math.min(maxX, desired.x + delta[0] * radius))
    const y = Math.max(0, Math.min(maxY, desired.y + delta[1] * radius))
    const footprint = footprintFor(asset, x, y)
    if (!placementFits(floors, occupied, reserved, footprint, map.width, map.height)) continue
    addProp(map, {
      id: 'painted:' + locationId + ':prop-' + (index + 1), assetId, x: x + .5, y: y + .5,
      rotation: rotationFor(asset, locationId, index), scale: 1, footprint,
      blocksMove: asset.blocksMove === true, blocksSight: asset.blocksSight === true,
      cover: asset.cover, destructible: asset.destructible === true, hp: asset.hp,
      interactive: asset.interactive === true && Boolean(sceneInteractionCatalogEntry(assetId)?.verbs?.length),
    })
    for (const cell of footprint) occupied.add(key(cell.x, cell.y))
    return true
  }
  return false
}

function addBoundaryEdges(map, floors) {
  for (const raw of floors.keys()) {
    const xy = raw.split(',').map(Number)
    for (const delta of [[1,0],[0,1],[-1,0],[0,-1]]) {
      const nx = xy[0] + delta[0]
      const ny = xy[1] + delta[1]
      if (!insideMap(nx, ny, map.width, map.height)) continue
      const next = key(nx, ny)
      if (floors.has(next)) continue
      setEdge(map, xy[0], xy[1], nx, ny, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
    }
  }
}

function addOpenDoors(map, floors, zones, locationId, style) {
  const candidates = []
  for (const raw of floors.keys()) {
    const xy = raw.split(',').map(Number)
    for (const delta of [[1,0,'e'],[0,1,'s']]) {
      const next = key(xy[0] + delta[0], xy[1] + delta[1])
      if (floors.has(next) && zones.get(raw) !== zones.get(next)) candidates.push({ x: xy[0], y: xy[1], dir: delta[2], zone: zones.get(raw) })
    }
  }
  if (!candidates.length) {
    for (const raw of floors.keys()) {
      const xy = raw.split(',').map(Number)
      if (floors.has(key(xy[0] + 1, xy[1]))) { candidates.push({ x: xy[0], y: xy[1], dir: 'e', zone: 'ground' }); break }
    }
  }
  const used = new Set()
  const limit = new Set(candidates.map((candidate) => candidate.zone)).size
  for (const candidate of candidates) {
    if (used.has(candidate.zone) || map.doors.length >= limit) continue
    used.add(candidate.zone)
    setDoor(map, { id: 'door:' + locationId + ':' + (map.doors.length + 1), x: candidate.x, y: candidate.y, dir: candidate.dir, state: 'open', lockDc: 0, keyItemId: null })
  }
}

export function validateSmallTacticalMap(map) {
  if (map.width > MAX_WIDTH || map.height > MAX_HEIGHT) throw new Error(map.locationId + ': map size exceeds ' + MAX_WIDTH + 'x' + MAX_HEIGHT)
  if (map.generator.id !== SMALL_TACTICAL_GENERATOR_ID || map.tilesetId !== 'authored-tactical:' + map.locationId + ':v1' || !SMALL_TACTICAL_MARKER.test(map.tilesetId)) throw new Error(map.locationId + ': authored marker/generator mismatch')
  if (map.doors.length < 1 || map.props.length < 1) throw new Error(map.locationId + ': native map needs door and prop')
  if (map.zones.filter((zone) => zone.kind === 'interior').length > 3) throw new Error(map.locationId + ': more than 3 interior zones')
  const party = map.spawnPoints.find((point) => point.role === 'party')
  const enemy = map.spawnPoints.find((point) => point.role === 'enemy')
  if (!party || !enemy) throw new Error(map.locationId + ': party/enemy spawn required')
  const reached = reachableCells(map, party.x, party.y, { throughDoors: true })
  let passable = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.passable) continue
    passable += 1
    if (!reached.has(key(x, y))) throw new Error(map.locationId + ': unreachable cell ' + key(x, y))
  }
  if (passable < 12) throw new Error(map.locationId + ': too few passable cells')
  const propCells = new Set()
  for (const prop of map.props) for (const cell of prop.footprint) {
    if (!cellAt(map, cell.x, cell.y)?.passable) throw new Error(map.locationId + ': prop off floor')
    if (propCells.has(key(cell.x, cell.y))) throw new Error(map.locationId + ': overlapping props')
    propCells.add(key(cell.x, cell.y))
  }
  for (const spawn of map.spawnPoints) if (propCells.has(key(spawn.x, spawn.y))) throw new Error(map.locationId + ': spawn on prop')
  const report = validateTacticalMap(map)
  if (!report.ok) throw new Error(map.locationId + ': ' + report.errors.map((error) => error.code).join(', '))
  return map
}

export function buildSmallTacticalMap(location, { firstPlayableZone = '' } = {}) {
  const id = text(location?.id)
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,119}$/u.test(id)) throw new Error('invalid location id ' + id)
  const style = styleFor(location)
  const size = sizeFor(location, style)
  const material = materialFor(location, style)
  const seed = 'authored-tactical:' + id + ':v1'
  const map = createTacticalMap({ width: size[0], height: size[1], locationId: id, seed, generator: { id: SMALL_TACTICAL_GENERATOR_ID, version: '1' }, theme: themeFor(location, style), tilesetId: 'authored-tactical:' + id + ':v1', sizeClass: 'arena' })
  const plan = floorPlan(location, style, map.width, map.height, hashNumber(id))
  const specialZones = new Set([...plan.specialCells.values()].map((entry) => entry.zone))
  const usedZoneIds = new Set(plan.floors.values())
  for (const raw of plan.waterCells) usedZoneIds.add('water')
  for (const special of plan.specialCells.values()) usedZoneIds.add(special.zone)
  const defs = zoneDefinitions(location, style, firstPlayableZone || fallbackFirstZone(location, style), material, presetFor(location)?.form || style, plan.waterCells.size > 0 || specialZones.has('water'), specialZones).filter((zone) => usedZoneIds.has(zone.id))
  for (const zone of defs) addZone(map, zone)
  const zones = new Map(plan.floors)
  for (const [raw, special] of plan.specialCells) if (!plan.floors.has(raw)) zones.set(raw, special.zone)
  for (const raw of plan.waterCells) if (!plan.floors.has(raw)) zones.set(raw, 'water')
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const raw = key(x, y)
    if (plan.floors.has(raw)) {
      const zone = defs.some((entry) => entry.id === zones.get(raw)) ? zones.get(raw) : 'ground'
      const zoneMaterial = defs.find((entry) => entry.id === zone)?.material || material
      setCell(map, x, y, { passable: true, revealed: false, zone, material: zoneMaterial, moveCost: 1, surface: 'none', elevation: 0 })
    } else if (plan.specialCells.has(raw)) {
      const special = plan.specialCells.get(raw)
      setCell(map, x, y, { passable: false, revealed: false, zone: special.zone, material: special.material, surface: special.surface, elevation: 0 })
    } else if (plan.waterCells.has(raw)) setCell(map, x, y, { passable: false, revealed: false, zone: 'water', material: 'stone', surface: 'water', elevation: 0 })
  }
  addBoundaryEdges(map, plan.floors)
  addOpenDoors(map, plan.floors, zones, id, style)
  const party = { x: Math.floor(map.width / 2), y: map.height - 2 }
  const partyAt = plan.floors.has(key(party.x, party.y)) ? party : [...plan.floors.keys()].map((raw) => { const xy = raw.split(',').map(Number); return { x: xy[0], y: xy[1], distance: Math.abs(xy[0] - party.x) + Math.abs(xy[1] - party.y) } }).sort((a,b) => a.distance-b.distance || a.y-b.y || a.x-b.x)[0]
  const reserved = new Set([key(partyAt.x, partyAt.y)])
  const neutral = [...plan.floors.keys()].map((raw) => { const xy = raw.split(',').map(Number); return { x: xy[0], y: xy[1], distance: Math.abs(xy[0] - Math.floor(map.width/2)) + Math.abs(xy[1] - 3) } }).filter((p) => !reserved.has(key(p.x,p.y))).sort((a,b) => a.distance-b.distance || a.y-b.y || a.x-b.x)[0]
  reserved.add(key(neutral.x, neutral.y))
  const enemy = [...plan.floors.keys()].map((raw) => { const xy = raw.split(',').map(Number); return { x: xy[0], y: xy[1], distance: Math.abs(xy[0] - partyAt.x) + Math.abs(xy[1] - partyAt.y) } }).filter((p) => !reserved.has(key(p.x,p.y))).sort((a,b) => b.distance-a.distance || a.y-b.y || a.x-b.x)[0]
  if (!enemy) throw new Error(id + ': enemy spawn not found')
  reserved.add(key(enemy.x, enemy.y))
  addSpawnPoint(map, { id: 'party:' + id, x: partyAt.x, y: partyAt.y, role: 'party' })
  addSpawnPoint(map, { id: 'neutral:' + id, x: neutral.x, y: neutral.y, role: 'neutral' })
  addSpawnPoint(map, { id: 'enemy:' + id, x: enemy.x, y: enemy.y, role: 'enemy' })
  revealInitialArea(map, partyAt, 8)
  const occupied = new Set(reserved)
  const anchors = [{ x: 4, y: 4 }, { x: Math.floor(map.width / 2) - 1, y: Math.floor(map.height / 2) }, { x: map.width - 6, y: 5 }, { x: 5, y: map.height - 5 }, { x: map.width - 6, y: map.height - 5 }]
  const assets = propAssets(location, style)
  let placed = 0
  for (let i = 0; i < assets.length; i += 1) {
    if (placeProp(map, id, assets[(i + hashNumber(id + ':props')) % assets.length], anchors[i % anchors.length], plan.floors, occupied, reserved, i)) placed += 1
    if (placed >= 4) break
  }
  if (!placed) throw new Error(id + ': no native prop placement')
  map.overlays = { compass: false, scaleBar: false, roomLabels: [] }
  return validateSmallTacticalMap(map)
}

function loadAresLayout(path = ARES_LAYOUT_FILE) {
  const root = JSON.parse(readFileSync(path, 'utf8'))
  const layout = (Array.isArray(root?.layouts) ? root.layouts : []).find((entry) => text(entry?.location_id) === EXCLUDED_LOCATION_ID)
  if (!layout || layout.native_grid !== true) throw new Error('Ares native-grid layout не найден: ' + path)
  return layout
}

export function buildAresTacticalMap(path = ARES_LAYOUT_FILE) {
  const map = buildAuthoredLocationMap(loadAresLayout(path))
  if (map.locationId !== EXCLUDED_LOCATION_ID || map.tilesetId !== 'authored-tactical:' + EXCLUDED_LOCATION_ID + ':v1' || map.generator.id !== SMALL_TACTICAL_GENERATOR_ID) {
    throw new Error('Ares layout собрался с неверным native marker/generator')
  }
  const report = validateTacticalMap(map)
  if (!report.ok) throw new Error('Ares map invalid: ' + report.errors.map((error) => error.code).join(', '))
  const table = map.props.find((prop) => prop.assetId === 'table_royal')
  const throne = map.props.find((prop) => prop.assetId === 'royal_throne')
  const tableShape = new Set(table?.footprint.map((cell) => cell.x)).size + 'x' + new Set(table?.footprint.map((cell) => cell.y)).size
  if (!table || table.rotation !== 90 || tableShape !== '2x5' || !throne || throne.footprint.length !== 4) {
    throw new Error('Ares map должен содержать вертикальный table_royal 2x5 и royal_throne 2x2')
  }
  return map
}

export function semanticQaRows(maps) {
  return maps.map((map) => {
    const authored = locationPresetFor(map.locationId)
    const surfaces = map.layers?.surface ? [...map.layers.surface] : []
    const blockedZones = new Set()
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell && !cell.passable) blockedZones.add(cell.zone)
    }
    return {
      locationId: map.locationId,
      style: authored?.geometry || 'native-layout',
      variant: authored?.form || 'native-layout',
      theme: map.theme,
      descriptor: authored?.theme || map.theme,
      mainFeature: map.zones.find((zone) => zone.id === 'ground')?.label || map.locationId,
      materials: [...new Set(map.zones.map((zone) => zone.material))],
      props: [...new Set(map.props.map((prop) => prop.assetId))],
      blockedZones: [...blockedZones].sort(),
      waterCells: surfaces.filter((surface) => surface === 1).length,
      width: map.width,
      height: map.height,
    }
  }).sort((a, b) => a.locationId.localeCompare(b.locationId))
}

export function buildSmallTacticalMaps({ worldPath = WORLD_FILE, manifestPath = OVERVIEW_MANIFEST_FILE, aresPath = ARES_LAYOUT_FILE, outputPath = DEFAULT_OUTPUT, qaOutputPath = '' } = {}) {
  const allLocations = loadLocations(worldPath, { includeExcluded: true })
  const locations = allLocations.filter((location) => text(location.id) !== EXCLUDED_LOCATION_ID)
  const firstZones = loadOverviewZones(manifestPath)
  const maps = [...locations.map((location) => buildSmallTacticalMap(location, { firstPlayableZone: firstZones.get(text(location.id)) || '' })), buildAresTacticalMap(aresPath)]
    .sort((a,b) => a.locationId.localeCompare(b.locationId))
  if (maps.length !== allLocations.length || maps.length !== 56) throw new Error('Ожидалось 56 authored tactical maps, получено ' + maps.length)
  mkdirSync(dirname(resolve(outputPath)), { recursive: true })
  writeFileSync(resolve(outputPath), JSON.stringify({ schema_version: 1, maps: maps.map(serializeTacticalMap) }, null, 2) + '\n')
  if (qaOutputPath) {
    mkdirSync(dirname(resolve(qaOutputPath)), { recursive: true })
    writeFileSync(resolve(qaOutputPath), JSON.stringify({ schema_version: 1, entries: semanticQaRows(maps) }, null, 2) + '\n')
  }
  return { locations: allLocations, maps, outputPath: resolve(outputPath) }
}

if (process.argv[1] && process.argv[1].endsWith('build-small-tactical-maps.mjs')) {
  try {
    const argv = process.argv.slice(2)
    const value = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback }
    const result = buildSmallTacticalMaps({ worldPath: value('--world', WORLD_FILE), manifestPath: value('--manifest', OVERVIEW_MANIFEST_FILE), aresPath: value('--ares', ARES_LAYOUT_FILE), outputPath: value('--out', DEFAULT_OUTPUT), qaOutputPath: value('--qa-out', '') })
    process.stdout.write(JSON.stringify({ ok: true, maps: result.maps.length, output: result.outputPath }, null, 2) + '\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n')
    process.exitCode = 1
  }
}

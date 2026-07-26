// @ts-check
import { createHash } from 'node:crypto'

import { buildBuildingScene } from './building-generator.mjs'
import { buildSceneFromGraph } from './graph-layout.mjs'
import { addSceneLink, addSceneZone, createSceneGraph } from './scene-graph.mjs'
import { placeProps } from './prop-placement.mjs'
import { SIZE_CLASSES, addZone, cellAt, createTacticalMap, setCell, setEdge } from './tactical-map.mjs'

/**
 * Каталог тем сцены — этап M6 (`docs/tactical-map-plan.md`, раздел 12).
 *
 * Тема = набор материалов, набор предметов и правила расстановки. Геометрия
 * берётся одним из трёх способов, и выбор способа — часть темы:
 *
 * - `building` — здание с участком, отдельный генератор планировки;
 * - `graph` — помещения и проходы: сначала граф зон с проверкой ключей, затем
 *   геометрия. Так строятся храм, склеп и пещера;
 * - `open` — открытая местность без помещений: лес, дорога, поселение.
 *
 * Опознание темы идёт по названию локации и по виду сцены. Это единственное
 * место, где такое опознание живёт: раньше оно было размазано регулярками по
 * `dynamic-map.mjs`.
 */

export const SCENE_THEMES = Object.freeze([
  {
    id: 'building',
    label: 'Здание с участком',
    kind: 'building',
    material: 'wood',
    // `\b` в JavaScript опирается на латиницу и с кириллицей не работает.
    match: /таверн|трактир|постоял|корчм|харчевн|гостиниц|(?<![а-яё])дом(?![а-яё])|(?<![а-яё])изб[аеуы](?![а-яё])|хижин|усадьб|поместь|лавк/iu,
  },
  {
    id: 'temple',
    label: 'Храм',
    kind: 'graph',
    material: 'marble',
    match: /храм|святилищ|капищ|алтар|собор|монастыр/iu,
    zones: ['Притвор', 'Неф', 'Алтарная', 'Ризница'],
    density: 14,
    require: ['altar', 'pillar', 'statue', 'brazier'],
    prefer: ['pillar', 'statue', 'brazier', 'prayer_bench', 'reliquary', 'mosaic', 'temple_banner'],
  },
  {
    id: 'crypt',
    label: 'Склеп',
    kind: 'graph',
    material: 'stone',
    match: /склеп|крипт|гробниц|усыпальниц|катакомб|мавзоле/iu,
    zones: ['Вход', 'Галерея', 'Погребальная', 'Тайник'],
    density: 16,
    require: ['sarcophagus', 'grave', 'urn', 'brazier'],
    prefer: ['grave', 'urn', 'crypt_niche', 'bone_pile', 'cobweb', 'statue'],
    locked: true,
  },
  {
    id: 'cave',
    label: 'Пещера',
    kind: 'graph',
    material: 'earth',
    match: /пещер|грот|каверн|штольн|шахт|подземель|нора/iu,
    zones: ['Устье', 'Штрек', 'Зал', 'Тупик'],
    density: 18,
    require: ['stalagmite', 'cave_pool', 'rubble_heap'],
    prefer: ['stalagmite', 'rubble_heap', 'mushroom_cluster', 'bone_pile', 'ore_vein', 'cobweb'],
  },
  {
    id: 'forest',
    label: 'Лес',
    kind: 'open',
    material: 'grass',
    match: /лес|чащ|рощ|бор|дубрав|пущ|тайг/iu,
    density: 11,
    require: ['tree_oak', 'tree_spruce', 'tree_birch', 'fallen_log'],
    prefer: ['tree_oak', 'tree_spruce', 'tree_birch', 'tree_pine', 'tree_dead', 'bush', 'shrub', 'boulder', 'fern'],
  },
  {
    id: 'road',
    label: 'Дорога',
    kind: 'open',
    material: 'earth',
    match: /дорог|тракт|путь|перекрёст|перекрест|мост|брод|перевал/iu,
    density: 6,
    require: ['milestone', 'tree_birch', 'cart', 'roadside_shrine'],
    prefer: ['tree_birch', 'tree_dead', 'bush', 'boulder', 'fern', 'path_stone', 'milestone'],
    road: true,
  },
  {
    id: 'settlement',
    label: 'Поселение',
    kind: 'open',
    material: 'earth',
    match: /деревн|поселен|село|посад|хутор|город|слобод|рынок|площад/iu,
    density: 9,
    require: ['market_stall', 'well', 'cart', 'village_fence'],
    prefer: ['market_stall', 'village_fence', 'cart', 'haystack', 'woodpile', 'tree_birch', 'hitching_post'],
    road: true,
  },
])

/** Тема по умолчанию, когда ничто не опознано. */
export const FALLBACK_THEME = SCENE_THEMES[0]

/**
 * @param {string|number} seed
 * @returns {() => number}
 */
function randomFor(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * Опознаёт тему сцены. Дикая местность никогда не становится зданием, даже если
 * в названии есть «дом»: «Дом у дороги» в лесу — это всё-таки лес.
 *
 * @param {object} input
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @returns {typeof SCENE_THEMES[number]}
 */
export function themeFor(input = {}) {
  return matchTheme(input) ?? FALLBACK_THEME
}

/**
 * То же опознание, но без подстановки темы по умолчанию: `null` означает «не
 * узнал». Вызывающий вправе отдать такую сцену прежнему процедурному
 * генератору, а не выдавать таверну за всё подряд.
 *
 * @param {object} input
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @returns {typeof SCENE_THEMES[number]|null}
 */
export function matchTheme({ location = '', theme = '', sceneKind = '' } = {}) {
  const haystack = `${location} ${theme}`
  const wilderness = String(sceneKind) === 'wilderness'
  for (const candidate of SCENE_THEMES) {
    if (wilderness && candidate.kind === 'building') continue
    if (candidate.match.test(haystack)) return candidate
  }
  // Дикая местность без опознанной темы — это лес, а не таверна.
  if (wilderness) return SCENE_THEMES.find((candidate) => candidate.id === 'forest') ?? null
  return null
}

/**
 * Граф зон под тему: цепочка помещений, последнее — цель. У склепа последняя
 * дверь заперта, а ключ лежит в предыдущей зоне — проверку порядка ключей
 * делает стадия 1.
 *
 * @param {typeof SCENE_THEMES[number]} theme
 * @param {string} seed
 * @returns {import('./scene-graph.mjs').SceneGraph}
 */
export function sceneGraphForTheme(theme, seed) {
  const random = randomFor(`${theme.id}:${seed}`)
  const labels = theme.zones ?? ['Вход', 'Зал', 'Дальняя']
  const count = Math.max(3, Math.min(labels.length, 3 + Math.floor(random() * (labels.length - 2))))
  const graph = createSceneGraph({ entranceZoneId: 'zone-0', goalZoneId: `zone-${count - 1}` })
  for (let index = 0; index < count; index += 1) {
    addSceneZone(graph, {
      id: `zone-${index}`,
      kind: 'interior',
      required: index < count - 1,
      label: labels[index] ?? `Помещение ${index + 1}`,
      keys: theme.locked && index === count - 2 ? ['goal-key'] : [],
    })
  }
  for (let index = 1; index < count; index += 1) {
    const lockLast = theme.locked && index === count - 1
    addSceneLink(graph, {
      id: `link-${index}`,
      from: `zone-${index - 1}`,
      to: `zone-${index}`,
      kind: lockLast ? 'locked' : (random() < 0.5 ? 'door' : 'open'),
      keyId: lockLast ? 'goal-key' : null,
    })
  }
  return graph
}

/**
 * Открытая местность: помещений нет, есть проходимая площадка с опушкой по
 * краю. У дороги и поселения через карту идёт полоса утоптанной земли.
 *
 * @param {typeof SCENE_THEMES[number]} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutOpenTerrain(theme, { seed = 'open', width = 26, height = 26, locationId = '' } = {}) {
  const safeWidth = Math.max(12, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(12, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`open:${theme.id}:${seed}`)
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { id: `theme-${theme.id}`, version: '1' },
    theme: theme.id,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  addZone(map, { id: 'field', kind: 'exterior', material: theme.material, lightLevel: 'bright', label: theme.label })

  const roadY = Math.floor(safeHeight / 2)
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      // Дорога вьётся, а не идёт по линейке: прямая полоса читается как шов.
      const drift = Math.round(Math.sin((x / Math.max(1, safeWidth - 1)) * Math.PI * 2) * Math.max(1, safeHeight * 0.08))
      const onRoad = theme.road && Math.abs(y - (roadY + drift)) <= 1
      setCell(map, x, y, {
        passable: true,
        material: onRoad ? 'earth' : theme.material,
        zone: 'field',
        variant: Math.floor(random() * 6),
        revealed: true,
      })
    }
  }
  // Край карты — непроходимая опушка: иначе отряд уходит в пустоту.
  for (let x = 0; x < safeWidth; x += 1) {
    for (const y of [0, safeHeight - 1]) {
      if (theme.road && Math.abs(y - roadY) <= 1) continue
      setCell(map, x, y, { passable: false, material: theme.material })
    }
  }
  for (let y = 0; y < safeHeight; y += 1) {
    for (const x of [0, safeWidth - 1]) {
      // У дороги края открыты: она обязана вести за пределы карты.
      if (theme.road) continue
      setCell(map, x, y, { passable: false, material: theme.material })
    }
  }
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cellAt(map, x + dx, y + dy)?.passable) {
          setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
        }
      }
    }
  }
  map.spawnPoints.push({ id: 'party-entrance', x: 1, y: roadY, role: 'party' })
  map.overlays = { compass: true, scaleBar: true, roomLabels: [{ zoneId: 'field', label: theme.label }] }
  return map
}

/**
 * Собирает сцену по теме. Единая точка входа: вызывающему не нужно знать, каким
 * способом строится геометрия.
 *
 * @param {object} options
 * @param {string} [options.location]
 * @param {string} [options.theme]
 * @param {string} [options.sceneKind]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, theme: string, warnings: string[]}}
 */
export function buildThemedScene({
  location = '', theme = '', sceneKind = '', seed = 'scene', width = 26, height = 26, locationId = '',
} = {}) {
  const definition = themeFor({ location, theme, sceneKind })

  if (definition.kind === 'building') {
    const built = buildBuildingScene({ seed, width, height, locationId, theme: definition.id })
    return { map: built.map, theme: definition.id, warnings: built.warnings }
  }

  if (definition.kind === 'graph') {
    const graph = sceneGraphForTheme(definition, seed)
    const built = buildSceneFromGraph(graph, {
      seed, width, height, locationId, theme: definition.id, material: definition.material,
    })
    const map = placeProps(built.map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (built.map.sizeClass)].maxProps,
      zones: built.map.zones
        .filter((zone) => zone.label)
        .map((zone) => ({
          zoneId: zone.id,
          theme: definition.id,
          density: definition.density ?? 12,
          require: definition.require,
          prefer: definition.prefer,
        })),
    })
    return {
      map,
      theme: definition.id,
      warnings: [...built.warnings, ...built.errors.map((issue) => issue.code)],
    }
  }

  const map = layoutOpenTerrain(definition, { seed, width, height, locationId })
  placeProps(map, {
    seed: `${seed}:props`,
    maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
    zones: [{
      zoneId: 'field',
      theme: definition.id,
      density: definition.density ?? 10,
      require: definition.require,
      prefer: definition.prefer,
    }],
  })
  return { map, theme: definition.id, warnings: [] }
}

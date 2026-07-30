import type { GameState, MapCell } from './types'

export const SCENE_THEMES = [
  'building',
  'temple',
  'crypt',
  'cave',
  'forest',
  'road',
  'settlement',
] as const

export type SceneTheme = typeof SCENE_THEMES[number]
export type SceneVisualTheme = SceneTheme | 'common'

export type SceneArt = Readonly<{
  id: string
  url: string
}>

/** Пять существующих подложек Dyson Logos; каталог переехал сюда без изменений. */
export const BOARD_MAP_LIBRARY = Object.freeze({
  cave: Object.freeze({ id: 'dyson-logos-cavern', url: '/assets/maps/library/dyson-logos/cave/dyson-logos-cavern.webp' }),
  dungeon: Object.freeze({ id: 'dyson-logos-dungeon', url: '/assets/maps/library/dyson-logos/dungeon/dyson-logos-dungeon.webp' }),
  tavern: Object.freeze({ id: 'dyson-logos-estate', url: '/assets/maps/library/dyson-logos/tavern/dyson-logos-estate.webp' }),
  temple: Object.freeze({ id: 'dyson-logos-temple', url: '/assets/maps/library/dyson-logos/temple/dyson-logos-temple.webp' }),
  village: Object.freeze({ id: 'dyson-logos-village', url: '/assets/maps/library/dyson-logos/village/dyson-logos-village.webp' }),
})

function themedArt(theme: SceneTheme, variant: 1 | 2): SceneArt {
  const suffix = String(variant).padStart(2, '0')
  return Object.freeze({
    id: `scene-${theme}-${suffix}`,
    url: `/assets/scenes/${theme}-${suffix}.webp`,
  })
}

export const SCENE_ART_LIBRARY = Object.freeze({
  building: Object.freeze([themedArt('building', 1), themedArt('building', 2)]),
  temple: Object.freeze([themedArt('temple', 1), themedArt('temple', 2)]),
  crypt: Object.freeze([themedArt('crypt', 1), themedArt('crypt', 2)]),
  cave: Object.freeze([themedArt('cave', 1), themedArt('cave', 2)]),
  forest: Object.freeze([themedArt('forest', 1), themedArt('forest', 2)]),
  road: Object.freeze([themedArt('road', 1), themedArt('road', 2)]),
  settlement: Object.freeze([themedArt('settlement', 1), themedArt('settlement', 2)]),
  common: Object.freeze([
    Object.freeze({ id: 'scene-common-night-road', url: '/assets/scenes/common-night-road.webp' }),
    Object.freeze({ id: 'scene-common-camp', url: '/assets/scenes/common-camp.webp' }),
    Object.freeze({ id: 'scene-common-ruins', url: '/assets/scenes/common-ruins.webp' }),
  ]),
})

/**
 * Стабильный FNV-1a без platform API: одинаковая строка даёт тот же uint32 в
 * браузере, тестах и после перезагрузки.
 */
export function stableSceneHash(value: string): number {
  let hash = 0x811c9dc5
  const normalized = String(value ?? '').normalize('NFKC')
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function themeFromText(value: unknown): SceneTheme | null {
  const text = String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru')
  if (!text) return null
  if (/(?:^|[^a-z])temple(?:[^a-z]|$)|храм|святилищ|часовн|собор|монастыр|алтар/u.test(text)) return 'temple'
  if (/(?:^|[^a-z])crypt(?:[^a-z]|$)|склеп|крипт|гробниц|усыпальниц|катакомб|мавзоле/u.test(text)) return 'crypt'
  if (/(?:^|[^a-z])cave(?:[^a-z]|$)|cavern|cave-cluster|пещер|грот|каверн|штольн|шахт|подземель/u.test(text)) return 'cave'
  if (/(?:^|[^a-z])forest(?:[^a-z]|$)|wild|лес|чащ|рощ|дубрав|пущ|тайг|джунг/u.test(text)) return 'forest'
  if (/(?:^|[^a-z])road(?:[^a-z]|$)|bridge|дорог|тракт|перекр[её]ст|мост|брод|перевал|путь/u.test(text)) return 'road'
  if (/(?:^|[^a-z])settlement(?:[^a-z]|$)|village|town|city|посел|деревн|город|улиц|порт|рынок/u.test(text)) return 'settlement'
  if (/(?:^|[^a-z])building(?:[^a-z]|$)|small-room|таверн|трактир|корчм|постоял|гостиниц|особняк|усадьб|поместь|хижин|дом/u.test(text)) return 'building'
  return null
}

function themeFromCells(cells: MapCell[]): SceneTheme | null {
  const patterns = new Set(cells.map((cell) => cell.pattern).filter(Boolean))
  const materials = new Set(cells.map((cell) => cell.material).filter(Boolean))
  const features = cells.map((cell) => cell.feature).filter(Boolean).join(' ')
  const semantic = themeFromText(`${[...patterns].join(' ')} ${features}`)
  if (semantic) return semantic
  if (materials.has('marble')) return 'temple'
  if (materials.has('grass')) return 'forest'
  if (patterns.has('small-room') || materials.has('wood')) return 'building'
  if (materials.has('earth')) return 'cave'
  return null
}

/**
 * Единственный resolver визуальной темы. Он читает только уже публичные поля
 * GameState: каноническая тема карты сильнее описания сцены, затем используются
 * theme/location и в последнюю очередь клеточные материалы и паттерны.
 */
export function resolveSceneTheme(state: Pick<GameState, 'scene'>): SceneVisualTheme {
  const scene = state.scene
  const mapTheme = themeFromText(scene.map?.theme)
  if (mapTheme) return mapTheme
  const sceneTheme = themeFromText(scene.theme)
  if (sceneTheme) return sceneTheme
  const locationTheme = themeFromText(`${scene.location} ${scene.title}`)
  if (locationTheme) return locationTheme
  const cellTheme = themeFromCells(scene.cells)
  if (cellTheme) return cellTheme
  if (scene.scene_kind === 'road') return 'road'
  if (scene.scene_kind === 'settlement' || scene.settlement_type) return 'settlement'
  if (scene.scene_kind === 'wilderness') return 'forest'
  if (scene.scene_kind === 'dungeon') return 'crypt'
  return 'common'
}

export function boardMapArtForTheme(theme: SceneVisualTheme): SceneArt {
  if (theme === 'building') return BOARD_MAP_LIBRARY.tavern
  if (theme === 'temple') return BOARD_MAP_LIBRARY.temple
  if (theme === 'cave') return BOARD_MAP_LIBRARY.cave
  if (theme === 'forest' || theme === 'road' || theme === 'settlement') return BOARD_MAP_LIBRARY.village
  return BOARD_MAP_LIBRARY.dungeon
}

export function sceneIllustrationForTheme(theme: SceneTheme | string, locationId: string): SceneArt {
  if ((SCENE_THEMES as readonly string[]).includes(theme)) {
    const variants = SCENE_ART_LIBRARY[theme as SceneTheme]
    return variants[stableSceneHash(`${theme}:${locationId}`) % variants.length]
  }
  return SCENE_ART_LIBRARY.common[stableSceneHash(`common:${locationId}`) % SCENE_ART_LIBRARY.common.length]
}

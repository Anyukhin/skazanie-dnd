import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/WorldMapView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/world-map.css', import.meta.url), 'utf8')
const citySource = readFileSync(new URL('../src/CityOverviewView.tsx', import.meta.url), 'utf8')
const cityStyles = readFileSync(new URL('../src/city-overview.css', import.meta.url), 'utf8')

test('глобальная карта кладёт безопасный SVG background image под процедурные слои', () => {
  const imageIndex = source.indexOf('className="world-map-background"')
  const terrainIndex = source.indexOf('<Terrain state={state}')
  const routesIndex = source.indexOf('<g className="world-routes">')
  const locationsIndex = source.indexOf('<g className="world-locations">')
  assert.ok(imageIndex >= 0, 'фон карты должен быть SVG image')
  assert.ok(imageIndex < terrainIndex, 'фон должен быть ниже процедурного terrain')
  assert.ok(imageIndex < routesIndex, 'фон должен быть ниже маршрутов')
  assert.ok(imageIndex < locationsIndex, 'фон должен быть ниже маркеров')
  assert.match(source, /WORLD_MAP_BACKGROUND_URL_RE/u)
  assert.match(source, /safeWorldMapBackgroundUrl\(map\.backgroundImage\)/u)
  assert.match(source, /preserveAspectRatio="xMidYMid slice"/u)
  assert.match(source, /aria-label=\{backgroundAlt \|\| undefined\}/u)
  assert.match(source, /showOrnaments=\{!backgroundImage\}/u)
  assert.match(source, /style=\{\{ opacity: \.94/u)
  assert.match(source, /className="world-map-background-veil".*opacity: \.1/u)
  assert.match(source, /style=\{\{ position: 'absolute', inset: 0, width: '100%', height: '100%' \}\}/u)
  assert.match(source, /\{!backgroundImage && <g className="compass-rose"/u)
  assert.match(source, /style=\{\{ aspectRatio: `\$\{map\.width\} \/ \$\{map\.height\}`, minHeight: 0, alignSelf: 'start' \}\}/u)
  assert.match(styles, /\.world-map-background\{/u)
  assert.match(styles, /\.world-map-background-veil\{/u)
})

test('инспектор показывает историю и сюжетные зацепки выбранной точки', () => {
  assert.match(source, /className="location-history"/u)
  assert.match(source, /История места/u)
  assert.match(source, /className="location-hooks"/u)
  assert.match(source, /Сюжетные зацепки/u)
  assert.match(source, /selected\.storyHooks\.map/u)
})

test('городской обзор открывается локально, показывает районы и не создаёт второй travel path', () => {
  assert.match(source, /selected\.cityOverview/u)
  assert.match(source, /Открыть план города/u)
  assert.match(source, /<CityOverviewView/u)
  assert.match(citySource, /overview\.districts\.map/u)
  assert.match(citySource, /overview\.places\.map/u)
  assert.match(citySource, /К глобальной карте/u)
  assert.match(citySource, /Выбор района или места не перемещает отряд/u)
  assert.doesNotMatch(citySource, /onTravel|fetch\(|submitAction|onTravel/u)
  assert.match(cityStyles, /\.city-district-shape/u)
  assert.match(cityStyles, /\.city-place-ring/u)
})

test('глобальная карта не выдаёт логические единицы маршрута за дни', () => {
  assert.ok(source.includes('<dt><Clock3 size={13}/>Путь</dt>'))
  assert.match(source, /переходов/u)
  assert.match(source, /Сервер учтёт время пути/u)
  assert.doesNotMatch(source, /totalDistance|totalDays|\{totalDistance\} ед\./u)
})

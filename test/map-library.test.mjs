import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { levelKey } from '../server/adventure-director.mjs'
import { generateBuildingScene } from '../server/building-generator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  MapLibrary,
  chooseLibraryMap,
  climateFor,
  libraryIdsInUse,
  libraryRequestFor,
  placeKindsFor,
  setActiveMapLibrary,
} from '../server/map-library.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { importTaleSpireSlab } from '../server/talespire-import.mjs'
import { deserializeTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'
import { HOUSE_SLAB } from './talespire-fixtures.mjs'

/**
 * Библиотека готовых карт: подбор под заявку сцены и путь выбранной карты
 * через `AdvanceScene` в память локации. Библиотека живёт во временном
 * каталоге; реестр сбрасывается после каждого теста, чтобы остальной корпус
 * видел генератор без библиотеки.
 */

function entryFor(id, overrides = {}) {
  return {
    id,
    title: `Карта ${id}`,
    source: { site: 'TalesTavern', url: `https://talestavern.com/slab/${id}/`, author: 'Автор', license: 'Attribution-NonCommercial', license_url: 'https://creativecommons.org/licenses/by-nc/4.0/', downloads: 10 },
    place_kinds: ['tavern'],
    climate: '',
    terrains: [],
    types: ['inn'],
    passport: { features: ['common_room', 'bedrooms', 'interior', 'upstairs'], interior_share: 0.8, floor_cells: 500, material: 'wood', summary: 'Двухэтажное строение.' },
    levels: [{ index: 0, label: 'Первый этаж' }],
    slab_sha256: 'x',
    added_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

test('заявка сцены переводится в виды места тем же словарём, что и у генератора', () => {
  assert.deepEqual(libraryRequestFor({ themeId: 'building', buildingUse: 'tavern' }).placeKinds, ['tavern'])
  assert.deepEqual(libraryRequestFor({ themeId: 'building', buildingUse: 'manor' }).placeKinds, ['manor', 'fortress'])
  assert.deepEqual(libraryRequestFor({ themeId: 'cave', worldKind: 'dungeon' }).placeKinds, ['dungeon', 'cave'])
  assert.equal(libraryRequestFor({ themeId: 'forest' }).exterior, true)
  assert.equal(libraryRequestFor({ themeId: 'building', levels: [{ offset: -1 }] }).wantsCellar, true)
  assert.deepEqual(placeKindsFor(['inn', 'merchant'], ['desert'], { features: [], interior_share: 0.4 }), ['shop', 'tavern'])
  // Паспорт не дописывает виды к авторским, но выручает, когда автор их не дал.
  assert.deepEqual(placeKindsFor([], ['dungeon'], { features: ['crypt'], interior_share: 0.9 }), ['dungeon'])
  assert.deepEqual(placeKindsFor([], [], { features: ['crypt'], interior_share: 0.9 }), ['crypt'])
  assert.deepEqual(placeKindsFor(['merchant'], [], { features: [], interior_share: 0.5 }, 'Cog Small Ship Merchant'), ['ship'])
  assert.deepEqual(libraryRequestFor({ themeId: 'settlement', place: 'Палуба торгового корабля' }).placeKinds, ['ship'])
  assert.equal(libraryRequestFor({ themeId: 'building', world: 'Киберпанк-мегаполис будущего' }).genre, 'scifi')
  assert.equal(libraryRequestFor({ themeId: 'building', world: 'Королевство драконов' }).genre, 'fantasy')
  assert.equal(climateFor(['desert'], { material: 'wood' }), 'arid')
  assert.equal(climateFor([], { material: 'ice' }), 'cold')
})

test('подбор: вид места обязателен, климат не спорит, использованная карта не повторяется', () => {
  const entries = [
    entryFor('tavern-a'),
    entryFor('tavern-desert', { climate: 'arid' }),
    entryFor('cave-a', { place_kinds: ['cave'] }),
    entryFor('tavern-scifi', { passport: { features: ['common_room'], interior_share: 0.8, floor_cells: 500, material: 'metal', summary: '', genre: 'scifi' } }),
    entryFor('glade', { place_kinds: ['wilds'], passport: { features: ['exterior'], interior_share: 0.05, floor_cells: 600, material: 'grass', summary: '' } }),
  ]
  const tavern = libraryRequestFor({ themeId: 'building', buildingUse: 'tavern' })
  assert.equal(chooseLibraryMap(entries, tavern, { seed: 'a' })?.id, 'tavern-a', 'пустынная таверна в умеренном мире не встаёт')
  assert.equal(chooseLibraryMap(entries, { ...tavern, climate: 'arid' }, { seed: 'a' })?.id, 'tavern-desert')
  assert.equal(chooseLibraryMap(entries, tavern, { seed: 'a', usedIds: ['tavern-a'] }), null, 'единственная подходящая уже стоит в другой локации')
  assert.equal(chooseLibraryMap(entries, libraryRequestFor({ themeId: 'temple' }), { seed: 'a' }), null, 'нет храма — генератор сам')
  assert.equal(chooseLibraryMap(entries, libraryRequestFor({ themeId: 'forest', climate: 'arid' }), { seed: 'a' }), null, 'лесная поляна в пустыню не попадает')
  assert.equal(chooseLibraryMap(entries, libraryRequestFor({ themeId: 'forest' }), { seed: 'a' })?.id, 'glade')
  assert.equal(chooseLibraryMap(entries, libraryRequestFor({ themeId: 'building', buildingUse: 'tavern', world: 'орбитальная станция будущего' }), { seed: 'a' })?.id, 'tavern-scifi', 'бар станции — из научно-фантастического набора')
  // Выбор среди равных детерминирован по сиду места.
  const twins = [entryFor('twin-a'), entryFor('twin-b'), entryFor('twin-c')]
  const picks = new Set(['s1', 's2', 's3', 's4', 's5', 's6'].map((seed) => chooseLibraryMap(twins, tavern, { seed })?.id))
  assert.ok(picks.size > 1, 'разные места получают разные карты из равных')
  assert.equal(chooseLibraryMap(twins, tavern, { seed: 's1' })?.id, chooseLibraryMap(twins, tavern, { seed: 's1' })?.id)
})

test('хранилище библиотеки: запись, этажи и использованные карты кампании', (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-map-library-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  const library = new MapLibrary(storage)
  assert.deepEqual(library.entries(), [])
  const imported = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'tt-house' })
  library.put(entryFor('tt-house', { passport: imported.passport }), imported.levels)
  assert.deepEqual(library.entries().map((entry) => entry.id), ['tt-house'])
  assert.deepEqual(library.levels('tt-house')?.map((level) => level.index), [0, 1])
  assert.equal(library.levels('../etc/passwd'), null, 'идентификатор не выводит за пределы каталога')
  const picked = library.pick(libraryRequestFor({ themeId: 'building', buildingUse: 'tavern' }), { seed: 'x' })
  assert.equal(picked?.entry.id, 'tt-house')
  assert.deepEqual([...libraryIdsInUse({ a: { map: { seed: 'library:tt-house:0' } }, b: { map: { seed: 'other' } } })], ['tt-house'])
})

function tavernState() {
  const map = generateBuildingScene({ seed: 'прежняя улица', locationId: 'loc-street' })
  return normalizeCampaignState({
    sessionCode: 'LIBRARY',
    state_version: 0,
    engine_mode: 'enforce',
    activePlayerId: 'hero-a',
    partyMemberIds: ['hero-a'],
    players: [{ id: 'hero-a', character: 'Герой', hp: 10, maxHp: 10, level: 1, inventory: [], x: 1, y: 1 }],
    worldMap: { seed: 'library-seed', currentLocationId: 'loc-street', locations: [{ id: 'loc-street', name: 'Улица', kind: 'town' }] },
    scene: { title: 'Улица', location: 'Улица', location_id: 'loc-street', turn: 1, map: serializeTacticalMap(map), cells: legacyCellsFromTacticalMap(map) },
  })
}

test('переход в таверну берёт карту из библиотеки: этажи в памяти локации, автор виден игроку', (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-map-library-scene-'))
  t.after(() => {
    setActiveMapLibrary(null)
    rmSync(storage, { recursive: true, force: true })
  })
  const library = new MapLibrary(storage)
  const imported = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'tt-house' })
  library.put(entryFor('tt-house', { title: 'Дом у дороги', passport: imported.passport }), imported.levels)
  setActiveMapLibrary(library)

  const initial = tavernState()
  const dice = new DiceService({ rng: new SequenceDiceRng([]), idFactory: () => 'roll', now: () => '2026-10-02T00:00:00.000Z' })
  const result = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'to-tavern',
    scene_args: { title: 'Таверна «Рог»', location: 'Таверна «Рог»', theme: 'таверна', objective: 'Найти хозяина' },
  }, initial, { diceService: dice, context: { isAdmin: true } })
  const event = result.events.find((candidate) => candidate.event_type === 'SceneAdvanced')
  assert.ok(event)
  assert.equal(event.payload.scene.map_source.title, 'Дом у дороги')
  assert.equal(event.payload.scene.layout, imported.passport.summary)
  assert.deepEqual(event.payload.scene.levels.map((level) => level.offset), [1])
  assert.deepEqual(event.payload.library_levels.map((level) => level.index), [1])
  assert.ok(String(deserializeTacticalMap(event.payload.scene.map).seed).startsWith('library:tt-house:'))

  const after = result.events.reduce((state, current) => applyGameEvent(state, current), initial)
  const locationId = after.scene.location_id
  assert.ok(after.locationMaps[levelKey(locationId, 1)], 'второй этаж постройки лежит в памяти локации')
  assert.deepEqual(replayEvents(initial, result.events).locationMaps, after.locationMaps)

  const player = { id: 'player', role: 'player' }
  const visible = mechanicsForViewer(result.events, player, 'hero-a', after).find((candidate) => candidate.event_type === 'SceneAdvanced')
  assert.equal(visible.payload.library_levels, undefined, 'этажи постройки игрок не получает в событии')
  const view = campaignStateForViewer(after, player, 'hero-a')
  assert.equal(view.scene.map_source.author, 'Автор', 'атрибуция видна игроку')
  assert.equal(view.scene.map_source.license, 'Attribution-NonCommercial')
  assert.equal(view.scene.layout, undefined, 'паспорт перечисляет нераскрытые комнаты и игроку не отдаётся')

  // Вторая таверна не получает ту же постройку: карта уже стоит в кампании.
  const second = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'to-second-tavern',
    scene_args: { title: 'Трактир «Гусь»', location: 'Трактир «Гусь»', theme: 'трактир', objective: 'Отдохнуть' },
  }, normalizeCampaignState(after), { diceService: dice, context: { isAdmin: true } })
  const secondScene = second.events.find((candidate) => candidate.event_type === 'SceneAdvanced')
  assert.equal(secondScene.payload.scene.map_source, undefined)
  assert.ok(!String(deserializeTacticalMap(secondScene.payload.scene.map).seed).startsWith('library:'))
})

test('без подключённой библиотеки генератор работает как раньше', () => {
  setActiveMapLibrary(null)
  const initial = tavernState()
  const dice = new DiceService({ rng: new SequenceDiceRng([]), idFactory: () => 'roll', now: () => '2026-10-02T00:00:00.000Z' })
  const result = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'to-tavern',
    scene_args: { title: 'Таверна «Рог»', location: 'Таверна «Рог»', theme: 'таверна', objective: 'Найти хозяина' },
  }, initial, { diceService: dice, context: { isAdmin: true } })
  const event = result.events.find((candidate) => candidate.event_type === 'SceneAdvanced')
  assert.equal(event.payload.scene.map_source, undefined)
  assert.equal(event.payload.library_levels, undefined)
})

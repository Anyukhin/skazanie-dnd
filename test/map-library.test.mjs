import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { levelKey } from '../server/adventure-director.mjs'
import { generateBuildingScene } from '../server/building-generator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  MIN_LIBRARY_SCORE,
  MapLibrary,
  chooseLibraryMap,
  climateFor,
  libraryIdsInUse,
  libraryPlaceKinds,
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
    entryFor('cave-a', { place_kinds: ['cave'], types: ['caves'] }),
    entryFor('tavern-scifi', { passport: { features: ['common_room'], interior_share: 0.8, floor_cells: 500, material: 'metal', summary: '', genre: 'scifi' } }),
    entryFor('glade', { place_kinds: ['wilds'], types: ['nature'], passport: { features: ['exterior', 'grove'], interior_share: 0.05, floor_cells: 600, material: 'grass', summary: '' } }),
  ]
  const tavern = libraryRequestFor({ themeId: 'building', buildingUse: 'tavern' })
  assert.equal(chooseLibraryMap(entries, tavern, { seed: 'a' })?.id, 'tavern-a', 'пустынная таверна в умеренном мире не встаёт')
  assert.equal(chooseLibraryMap(entries, { ...tavern, climate: 'arid' }, { seed: 'a' })?.id, 'tavern-desert')
  assert.equal(chooseLibraryMap(entries, tavern, { seed: 'a', usedIds: ['tavern-a'] }), null, 'единственная подходящая уже стоит в другой локации')
  assert.equal(chooseLibraryMap(entries, libraryRequestFor({ themeId: 'temple' }), { seed: 'a' }), null, 'нет храма — генератор сам')
  assert.equal(chooseLibraryMap(entries, libraryRequestFor({ themeId: 'forest', climate: 'arid' }), { seed: 'a' }), null, 'лесная поляна в пустыню не попадает')
  assert.equal(chooseLibraryMap(entries, libraryRequestFor({ themeId: 'forest' }), { seed: 'a' })?.id, 'glade')
  // Уличная сцена требует признака вида места: «природа» по метке автора без
  // рощи и стоянки на карте — не лес (этап 0 плана карт).
  const bare = [entryFor('bare-field', { place_kinds: ['wilds'], types: ['nature'], passport: { features: ['exterior'], interior_share: 0.05, floor_cells: 600, material: 'grass', summary: '' } })]
  assert.equal(chooseLibraryMap(bare, libraryRequestFor({ themeId: 'forest' }), { seed: 'a' }), null)
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

test('неиграбельная карта библиотеки пропускается: подбор берёт следующую', (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-map-library-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  const library = new MapLibrary(storage)
  const imported = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'tt-house' })
  // Тот же дом без точки появления отряда: сцену на нём не начать.
  const broken = imported.levels.map((level) => (level.index === 0 ? { ...level, map: { ...level.map, spawnPoints: [] } } : level))
  library.put(entryFor('tt-broken', { passport: imported.passport }), broken)
  const request = libraryRequestFor({ themeId: 'building', buildingUse: 'tavern' })
  assert.equal(library.pick(request, { seed: 'x' }), null, 'единственная карта битая — работает генератор')
  library.put(entryFor('tt-house', { passport: imported.passport }), imported.levels)
  for (const seed of ['s1', 's2', 's3', 's4']) assert.equal(library.pick(request, { seed })?.entry.id, 'tt-house', `${seed}: выбрана битая карта`)
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

/** Уличная постройка: площадь этажа входа задаётся паспортом. */
function yardEntry(id, { cells = 600, props = {}, types = ['village'], placeKinds = ['village'], features = ['exterior', 'street'] } = {}) {
  const side = Math.round(Math.sqrt(cells))
  return entryFor(id, {
    place_kinds: placeKinds,
    types,
    passport: { features, interior_share: 0.2, floor_cells: cells, width: side, height: side, levels: [{ index: 0, label: 'Земля', cells, rooms: [] }], material: 'earth', summary: 'Открытая местность.', props },
  })
}

test('ферма деревней не считается, даже если библиотеку собрали прежним словарём', () => {
  // Живая кампания 2026-10-02: «Japanese Farmhouse» 16×16 попала в деревни
  // только по тегу автора farm. Сохранённый place_kinds — ещё старый.
  const farmhouse = yardEntry('japanese-farmhouse', { cells: 256, types: ['farm', 'home'], features: ['bedrooms', 'camp', 'exterior'] })
  assert.deepEqual(farmhouse.place_kinds, ['village'], 'в индексе запись лежит деревней')
  assert.deepEqual(libraryPlaceKinds(farmhouse), ['house'], 'нынешний словарь видит дом')
  assert.equal(chooseLibraryMap([farmhouse], libraryRequestFor({ themeId: 'settlement' }), { seed: 'a' }), null)
  assert.deepEqual(placeKindsFor(['farm', 'multiple-structures'], [], { features: [], interior_share: 0.1 }), ['village'],
    'хутор из нескольких построек деревней остаётся — по своему второму тегу')
})

test('библиотечная карта, чей паспорт обещает навес, а карта его не держит, проверку не проходит', (t) => {
  // Этап 4 плана карт: готовая карта проходит ту же проверку по программе,
  // что и сгенерированная. Паспорт говорит «навес есть», подбор её выбирает,
  // но на самой карте навеса нет — сцену строит генератор.
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-map-library-check-'))
  t.after(() => {
    setActiveMapLibrary(null)
    rmSync(storage, { recursive: true, force: true })
  })
  const library = new MapLibrary(storage)
  const imported = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'tt-awning' })
  const entry = yardEntry('tt-awning', { cells: 600, props: { market_awning: 1 } })
  library.put(entry, imported.levels)
  setActiveMapLibrary(library)
  const request = libraryRequestFor({ themeId: 'settlement', requirements: [{ id: 'shelter', count: 1 }] })
  assert.equal(chooseLibraryMap([entry], request, { seed: 'a' })?.id, 'tt-awning', 'по паспорту карта подходит')
  const dice = new DiceService({ rng: new SequenceDiceRng([]), idFactory: () => 'roll', now: () => '2026-10-02T00:00:00.000Z' })
  const advanced = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'awning',
    scene_args: { title: 'Кленовка', location: 'Деревня Кленовка', theme: 'деревня', settlement_type: 'village', objective: 'Найти старосту', arrival: 'Посреди деревни — общий навес.' },
  }, tavernState(), { diceService: dice, context: { isAdmin: true } }).events.find((event) => event.event_type === 'SceneAdvanced')
  assert.equal(advanced.payload.scene.map_source, undefined, 'карта без навеса не выбрана')
  assert.equal(advanced.payload.scene.map_requirements.focus, 'shelter')
  assert.equal(advanced.payload.scene.map_requirements.missing, undefined, 'генератор навес поставил')
  assert.ok(deserializeTacticalMap(advanced.payload.scene.map).props.some((prop) => prop.assetId === 'market_awning'))
})

test('уличной сцене нужна площадь её вида места: двор 16×16 — не деревня', () => {
  const village = libraryRequestFor({ themeId: 'settlement' })
  assert.equal(chooseLibraryMap([yardEntry('yard', { cells: 256 })], village, { seed: 'a' }), null, '80×80 футов — двор одного дома')
  assert.equal(chooseLibraryMap([yardEntry('hamlet', { cells: 600 })], village, { seed: 'a' })?.id, 'hamlet')
  // Заказанная площадь тоже держит планку: деревня 40×30 не встаёт на 20×20.
  assert.equal(chooseLibraryMap([yardEntry('hamlet', { cells: 420 })], libraryRequestFor({ themeId: 'settlement', width: 40, height: 30 }), { seed: 'a' }), null)
  // Помещение по-прежнему мерится мягко: маленькая таверна остаётся таверной.
  assert.equal(chooseLibraryMap([entryFor('tiny-inn', { passport: { ...entryFor('x').passport, floor_cells: 120 } })], libraryRequestFor({ themeId: 'building', buildingUse: 'tavern' }), { seed: 'a' })?.id, 'tiny-inn')
})

test('обещанные сценой объекты сверяются с предметами карты, порог отсекает слабое совпадение', () => {
  const plain = yardEntry('plain-village', { props: { haystack: 2 } })
  const withWell = yardEntry('well-village', { props: { well: 1, campfire: 1 } })
  const request = (requirements) => libraryRequestFor({ themeId: 'settlement', requirements })
  assert.ok(MIN_LIBRARY_SCORE > 0)
  // Ничего не обещано — выбор прежний.
  assert.ok(['plain-village', 'well-village'].includes(chooseLibraryMap([plain, withWell], request([]), { seed: 'a' })?.id))
  // Обещан колодец: карта с колодцем выигрывает у карты без него при любом сиде.
  for (const seed of ['a', 'b', 'c', 'd']) {
    assert.equal(chooseLibraryMap([plain, withWell], request([{ id: 'well', count: 1 }]), { seed })?.id, 'well-village')
  }
  // Живая сцена: навес, ящик, три настила, камни на порогах. Ни одна карта
  // этого не держит — строит генератор.
  const village = [{ id: 'shelter', count: 1 }, { id: 'crate', count: 1 }, { id: 'platform', count: 3 }, { id: 'threshold_stone', count: 1 }]
  assert.equal(chooseLibraryMap([plain, withWell], request(village), { seed: 'a' }), null)
  // Количество сверяется: два колодца на карте с одним — недостача.
  assert.equal(chooseLibraryMap([withWell], request([{ id: 'well', count: 2 }, { id: 'campfire', count: 2 }]), { seed: 'a' }), null)
  // Незнакомые виды и мусор в заявке не участвуют.
  assert.deepEqual(request([{ id: 'dragon', count: 1 }, { id: 'well', count: 99 }, null]).requirements, [{ id: 'well', count: 6 }])
})

test('деревня с обещанным навесом строится генератором, список объектов едет в сцене и переживает replay', (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-map-library-village-'))
  t.after(() => {
    setActiveMapLibrary(null)
    rmSync(storage, { recursive: true, force: true })
  })
  const library = new MapLibrary(storage)
  const imported = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'tt-hamlet' })
  library.put(yardEntry('tt-hamlet', { cells: 600, props: { haystack: 2 } }), imported.levels)
  setActiveMapLibrary(library)
  const dice = new DiceService({ rng: new SequenceDiceRng([]), idFactory: () => 'roll', now: () => '2026-10-02T00:00:00.000Z' })
  const advance = (commandId, arrival) => resolveCommand({
    command_type: 'AdvanceScene',
    command_id: commandId,
    scene_args: { title: 'Кленовка', location: 'Деревня Кленовка', theme: 'деревня', settlement_type: 'village', objective: 'Найти старосту', arrival },
  }, tavernState(), { diceService: dice, context: { isAdmin: true } }).events.find((event) => event.event_type === 'SceneAdvanced')

  // Контроль: та же деревня без обещаний берёт карту из библиотеки.
  const plain = advance('plain', 'Отряд входит в тихую деревню.')
  assert.equal(plain.payload.scene.map_source?.id, 'tt-hamlet')
  assert.equal(plain.payload.scene.map_requirements, undefined, 'сцена без обещаний поля не получает')

  const promised = advance('promised', 'Посреди деревни — общий навес, под ним ящик с документами; к реке ведут три настила.')
  assert.equal(promised.payload.scene.map_source, undefined, 'обещанного навеса на библиотечной карте нет')
  assert.deepEqual(promised.payload.scene.map_requirements, {
    version: 'scene-requirements/v3',
    items: [{ id: 'shelter', count: 1 }, { id: 'crate', count: 1 }, { id: 'platform', count: 3 }],
    focus: 'shelter',
  })
  const initial = tavernState()
  const after = applyGameEvent(initial, promised)
  assert.deepEqual(after.scene.map_requirements, promised.payload.scene.map_requirements)
  assert.deepEqual(replayEvents(initial, [promised]).scene.map_requirements, promised.payload.scene.map_requirements)
  assert.deepEqual(normalizeCampaignState(after).scene.map_requirements, promised.payload.scene.map_requirements, 'нормализация состояния поле не теряет')
  const view = campaignStateForViewer(after, { id: 'player', role: 'player' }, 'hero-a')
  assert.equal(view.scene.map_requirements, undefined, 'служебный список карты игроку не отдаётся')
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { SETTLEMENT_MIN_SIZE, countPlatforms, platformCells, programReport } from '../server/map-quality.mjs'
import { normalizeSceneMapDesign } from '../server/scene-map-design.mjs'
import { PLATFORM_ELEVATION_FEET, applyScenePlan } from '../server/scene-program-layout.mjs'
import {
  SCENE_REQUIREMENTS_VERSION,
  SCENE_REQUIREMENT_KINDS,
  normalizeLandmarks,
  requiredProgramKinds,
  sceneMapRequirementsFor,
} from '../server/scene-requirements.mjs'
import { addProp, addSpawnPoint, addZone, cellAt, createTacticalMap, edgeNeighbor, reachableCells, serializeTacticalMap, setCell, setEdge } from '../server/tactical-map.mjs'

/**
 * Этапы 2–4 `docs/map-generation-plan.md`: якоря модели в программе сцены,
 * генератор ставит программу на карту, общая проверка карты по программе.
 * Случай — «Скит Трёх Настилов» живой кампании 2026-10-02: деревня с навесом
 * в центре, ящиком записей, тремя настилами и камнями на порогах.
 */

const SKIT = 'Скит Трёх Настилов. У ближайших домов на порогах лежат камни с чужих полей. '
  + 'В центре — общий навес, под ним староста Илва держит копию соглашения. '
  + 'Хранитель записей Терен стоит у запертого ящика для документов. Мастер настилов Вейра.'
const RESIDENTS = [
  { name: 'Илва', role: 'староста' },
  { name: 'Терен', role: 'хранитель записей' },
  { name: 'Вейра', role: 'мастер настилов' },
]

const skitProgram = () => sceneMapRequirementsFor([SKIT], { npcs: RESIDENTS })
const skitMap = (seed, program = skitProgram()) => generateSceneGeometry({
  location: 'Скит Трёх Настилов', theme: 'деревня', settlementType: 'village', seed, useLibrary: false,
  requirements: program?.items ?? [], program,
})

test('этап 1: «на порогах лежат камни» — камни на пороге, хотя слова идут в обратном порядке', () => {
  const program = skitProgram()
  assert.equal(program.version, SCENE_REQUIREMENTS_VERSION)
  assert.deepEqual(program.items.map((item) => item.id).sort(), ['chest', 'crate', 'platform', 'shelter', 'threshold_stone'])
  assert.equal(program.focus, 'shelter')
  assert.deepEqual(program.posts, [{ npc: 'Илва', id: 'shelter' }, { npc: 'Терен', id: 'chest' }, { npc: 'Вейра', id: 'platform' }])
  assert.deepEqual(requiredProgramKinds(program).sort(), ['chest', 'platform', 'shelter'])
})

test('этап 2: якоря модели сливаются с текстом, неизвестное и чужие жители отбрасываются', () => {
  const landmarks = [
    { kind: 'well', role: 'focus', count: 1 },
    { kind: 'forge', role: 'npc_post', count: 1, npc: 'Терен' },
    { kind: 'forge', role: 'dressing', count: 2 },
    { kind: 'chest', role: 'npc_post', npc: 'Тайный Связной' },
    { kind: 'spaceship', role: 'focus' },
    { kind: 'barrels', role: 'clue', count: 9, note: 'бочка с двойным дном' },
    { kind: 'platform', role: 'whatever', count: 3 },
  ]
  assert.deepEqual(normalizeLandmarks(landmarks), [
    { id: 'well', role: 'focus', count: 1 },
    { id: 'forge', role: 'npc_post', count: 1, npc: 'Терен' },
    { id: 'chest', role: 'npc_post', count: 1, npc: 'Тайный Связной' },
    { id: 'barrels', role: 'clue', count: 6 },
    { id: 'platform', role: 'dressing', count: 3 },
  ], 'вид вне словаря отброшен, повтор вида — тоже, примечание модели не хранится')
  const program = sceneMapRequirementsFor([SKIT], { npcs: RESIDENTS, landmarks })
  assert.equal(program.focus, 'well', 'центр называет модель')
  assert.ok(program.items.some((item) => item.id === 'well'))
  assert.ok(program.items.some((item) => item.id === 'barrels' && item.count === 6))
  assert.deepEqual(program.clues, ['barrels'])
  assert.deepEqual(program.posts.find((post) => post.npc === 'Терен'), { npc: 'Терен', id: 'forge' }, 'пост модели сильнее роли')
  assert.equal(program.posts.some((post) => post.npc === 'Тайный Связной'), false,
    'житель, которого в сцене не видно, поста не получает: программа его бы назвала')
  // Староста стоит в центре — у колодца модели; улика и посты тоже обязательны.
  assert.deepEqual(requiredProgramKinds(program).sort(), ['barrels', 'forge', 'platform', 'well'])
})

test('этап 2: якоря живут в map.design и переживают нормализацию замысла', () => {
  const design = normalizeSceneMapDesign({ topology: 'organic', landmarks: [{ kind: 'shelter', role: 'focus' }, { kind: 'dragon' }], secret: 'x' })
  assert.deepEqual(design, { topology: 'organic', landmarks: [{ id: 'shelter', role: 'focus', count: 1 }] })
  assert.deepEqual(normalizeSceneMapDesign({ topology: 'organic' }), { topology: 'organic' }, 'без якорей поле не появляется')
})

test('этап 2: оба промпта v8 перечисляют ровно словарь якорей сервера', () => {
  const kinds = SCENE_REQUIREMENT_KINDS.map((kind) => kind.id).sort()
  for (const file of ['prompts/map_architect/v8.txt', 'prompts/campaign_creator/v8.txt']) {
    const prompt = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(prompt, /landmarks/u, file)
    const listed = [...prompt.matchAll(/(?<![\p{L}_])([a-z_]+)\s+\(/gu)].map((match) => match[1])
    const vocabulary = [...new Set(listed.filter((id) => kinds.includes(id)))].sort()
    assert.deepEqual(vocabulary, kinds, `${file}: в промпте весь словарь`)
    for (const role of ['focus', 'npc_post', 'clue', 'dressing']) assert.match(prompt, new RegExp(role, 'u'), `${file}: роль ${role}`)
  }
})

test('этап 3: скит строится по программе — навес на открытом месте, три настила, камни у дверей', () => {
  for (const seed of ['skit-a', 'skit-b', 'skit-c']) {
    const { map, missing } = skitMap(seed)
    assert.equal(missing, undefined, `${seed}: обязательное воплощено`)
    const party = map.spawnPoints.find((point) => point.role === 'party')
    const focus = map.props.find((prop) => prop.assetId === 'market_awning')
    assert.ok(focus, `${seed}: навес на карте`)
    const kind = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
    for (const cell of focus.footprint) assert.notEqual(kind.get(cellAt(map, cell.x, cell.y).zone), 'interior', `${seed}: навес под открытым небом`)
    assert.equal(countPlatforms(map), 3, `${seed}: три настила`)
    for (const cell of platformCells(map)) {
      assert.equal(cellAt(map, cell.x, cell.y).elevation, PLATFORM_ELEVATION_FEET, 'настил — шаг, а не стена')
      assert.ok(Math.abs(cell.x - party.x) + Math.abs(cell.y - party.y) >= 5, 'настил не у самого входа')
    }
    const reached = reachableCells(map, party.x, party.y)
    assert.ok(platformCells(map).every((cell) => reached.has(`${cell.x},${cell.y}`)), `${seed}: на настил всходят без лазания`)
    const stones = map.props.filter((prop) => prop.id.startsWith('program-threshold'))
    assert.equal(stones.length, 2, `${seed}: камни у двух ближайших домов`)
    for (const stone of stones) {
      assert.equal(stone.blocksMove, false, 'камень на пороге не запирает проём')
      const at = { x: Math.floor(stone.x), y: Math.floor(stone.y) }
      assert.ok(map.doors.some((door) => [door, edgeNeighbor(door)].some((side) => side.x === at.x && side.y === at.y)), `${seed}: камень у двери`)
    }
    const report = programReport(map, skitProgram(), { minSize: SETTLEMENT_MIN_SIZE, openScene: true })
    assert.deepEqual(report.problems, [], `${seed}: проверка карты чиста`)
  }
})

test('этап 3: центр сцены — колодец площади, а не второй колодец рядом с ним', () => {
  const program = sceneMapRequirementsFor(['Деревня: деревянные дома, колодец на площади, огороды и плетни.'], { npcs: [] })
  assert.equal(program?.focus, 'well')
  for (const seed of ['well-a', 'well-b', 'well-c']) {
    const { map } = generateSceneGeometry({ location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed, useLibrary: false, requirements: program.items, program })
    const wells = map.props.filter((prop) => prop.assetId === 'well')
    assert.equal(wells.length, 1, `${seed}: колодцев ${wells.map((prop) => prop.id).join(', ')}`)
  }
})

test('этап 3: карта по программе детерминирована, а сцена без программы строится как прежде', () => {
  const first = serializeTacticalMap(skitMap('skit-det').map)
  const second = serializeTacticalMap(skitMap('skit-det').map)
  assert.deepEqual(first, second)
  const plain = generateSceneGeometry({ location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed: 'plain-village', useLibrary: false })
  const again = generateSceneGeometry({ location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed: 'plain-village', useLibrary: false, program: null })
  assert.deepEqual(serializeTacticalMap(plain.map), serializeTacticalMap(again.map))
  assert.equal(plain.map.seed, 'plain-village', 'удачная карта строится с первой попытки, прежним сидом')
  assert.equal(plain.map.props.some((prop) => prop.id.startsWith('program-')), false)
})

/** Открытое поле 12×10 со входом отряда слева — основа ручных карт проверки. */
function field({ width = 12, height = 10 } = {}) {
  const map = createTacticalMap({ width, height, locationId: 'field', seed: 'field' })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', lightLevel: 'bright', label: 'Двор' })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) setCell(map, x, y, { passable: true, revealed: true, material: 'grass', zone: 'yard' })
  addSpawnPoint(map, { id: 'party', x: 1, y: 5, role: 'party' })
  return map
}

test('этап 4: нет обязательного якоря — провал; нет обычного обещанного — предупреждение', () => {
  const map = field()
  const program = { items: [{ id: 'well', count: 1 }, { id: 'barrels', count: 2 }], focus: 'well' }
  const report = programReport(map, program)
  assert.deepEqual(report.problems, [{ code: 'PROGRAM_ANCHOR_MISSING', detail: 'well' }])
  assert.deepEqual(report.warnings, [{ code: 'PROGRAM_ITEM_MISSING', detail: 'barrels' }])
  assert.deepEqual(report.missing, ['well'])
})

test('этап 4: якорь за глухой стеной — провал, у открытого входа — порядок', () => {
  const map = field()
  addProp(map, { id: 'well-1', assetId: 'well', x: 9.5, y: 5.5, footprint: [{ x: 9, y: 5 }], blocksMove: true })
  const program = { items: [{ id: 'well', count: 1 }], focus: 'well' }
  assert.deepEqual(programReport(map, program).problems, [])
  // Стена поперёк поля отрезает колодец: дойти до него нельзя.
  for (let y = 0; y < 10; y += 1) setEdge(map, 6, y, 7, y, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
  const codes = programReport(map, program).problems.map((problem) => problem.code)
  assert.ok(codes.includes('PROGRAM_ANCHOR_UNREACHABLE'))
  assert.ok(codes.includes('UNREACHABLE_POCKET'), 'отрезанная половина поля — потерянный закуток')
})

test('этап 4: малая деревня, глухая площадь и предмет на краю', () => {
  const small = field()
  assert.deepEqual(programReport(small, null, { minSize: SETTLEMENT_MIN_SIZE }).problems.map((problem) => problem.code), ['SCENE_TOO_SMALL'])
  const cluttered = field()
  // Глухие полосы через ряд с проходом по столбцу 3: всё досягаемо, но
  // глухого больше трети.
  for (let y = 0; y < 10; y += 1) for (let x = 4; x < 12; x += 1) if (y % 3 !== 0) setCell(cluttered, x, y, { passable: false })
  assert.ok(programReport(cluttered, null, { openScene: true }).problems.some((problem) => problem.code === 'OPEN_SCENE_CLUTTERED'))
  assert.equal(programReport(cluttered, null).problems.some((problem) => problem.code === 'OPEN_SCENE_CLUTTERED'), false,
    'густота мешает только месту сбора: лес под эту мерку не идёт')
  const edge = field()
  addProp(edge, { id: 'statue-1', assetId: 'statue', x: 11.5, y: 9.5, footprint: [{ x: 11, y: 9 }], blocksMove: true })
  assert.deepEqual(programReport(edge, null).warnings.map((warning) => warning.code), ['PROP_ON_EDGE'])
})

test('этап 3–4: настил считается по клеткам карты и воплощает программу', () => {
  const map = field()
  const program = { items: [{ id: 'platform', count: 2 }], focus: 'platform' }
  assert.deepEqual(programReport(map, program).missing, ['platform'])
  applyScenePlan(map, program, { seed: 'field-plan' })
  assert.equal(countPlatforms(map), 2)
  assert.deepEqual(programReport(map, program).problems, [])
})

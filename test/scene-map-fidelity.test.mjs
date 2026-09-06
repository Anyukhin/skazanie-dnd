import assert from 'node:assert/strict'
import test from 'node:test'
import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { createSceneTransition, rememberCurrentSceneMap } from '../server/adventure-director.mjs'
import { FakeLLM } from '../server/llm-client.mjs'
import { sceneContextForAgent } from '../server/agent-context.mjs'
import { createTacticalMap, addZone, setCell, addProp, cellAt, deserializeTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

const hero = { id: 'hero', character: 'Герой', role: 'Воин · ур. 1', species: 'Человек', maxHp: 12 }
const scene = { title: 'Вечер в трактире', location: 'Трактир у ворот', theme: 'таверна', objective: 'Поговорить с хозяином', map: { layout: 'rooms', pattern: 'great-hall', width: 26, height: 26 } }

function assertRichMap(serialized) {
  const map = deserializeTacticalMap(serialized)
  assert.ok(map.zones.some((zone) => zone.id === 'kitchen'), 'Назначение кухни потерялось по дороге в игровую сцену')
  assert.ok(map.zones.some((zone) => zone.id === 'yard' && zone.kind === 'exterior'))
  assert.ok(map.props.some((prop) => prop.footprint.length > 1), 'Крупная мебель исчезла при преобразовании карты')
  assert.ok(map.doors.some((door) => door.id === 'front-door'), 'У дверей потеряны устойчивые идентификаторы')
  assert.ok(map.spawnPoints.some((point) => point.role === 'party'))
}

test('создание кампании сохраняет зоны, крупную мебель, двери и точки появления генератора', async () => {
  const llmClient = new FakeLLM([{ content: JSON.stringify({ scene, openingNarration: 'Герои прибыли в трактир.', npcs: [{ id: 'host', name: 'Хозяин', location: scene.location }] }) }])
  const state = await new CampaignBootstrapper({ llmClient }).create({ code: 'MAP-FIDELITY', world: { startingLocation: scene.location }, players: [hero] })
  assertRichMap(state.scene.map)
})

test('переход и повторное посещение сохраняют полную структуру новой карты', () => {
  const state = { sessionCode: 'MAP-RETURN', players: [hero], scene: { title: 'Дорога', location: 'Дорога', cells: [] } }
  const first = createSceneTransition(scene, state)
  assertRichMap(first.scene.map)
  const current = { ...state, ...first }
  const remembered = rememberCurrentSceneMap(current)
  const back = createSceneTransition({ ...scene, location_id: first.scene.location_id }, remembered)
  assert.deepEqual(back.scene.map, first.scene.map)
})

test('рассказчик получает текущее помещение и видимый реквизит без скрытых зон', () => {
  const map = createTacticalMap({ width: 6, height: 3 })
  addZone(map, { id: 'gallery', label: 'Военная галерея', kind: 'interior' })
  addZone(map, { id: 'secret', label: 'Тайный архив', kind: 'interior' })
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 6; x += 1) setCell(map, x, y, { passable: true, revealed: x < 3, zone: x < 3 ? 'gallery' : 'secret' })
  addProp(map, { id: 'public-table', assetId: 'table_long', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  addProp(map, { id: 'secret-treasure', assetId: 'chest', x: 4.5, y: 1.5, footprint: [{ x: 4, y: 1 }] })
  addProp(map, { id: 'partly-hidden', assetId: 'bed', x: 2.5, y: 2.5, footprint: [{ x: 2, y: 2 }, { x: 3, y: 2 }] })
  const state = { scene: { ...scene, map: serializeTacticalMap(map) }, players: [{ ...hero, x: 0, y: 1 }] }
  const brief = sceneContextForAgent(state, hero.id)
  assert.equal(brief.spatial_context.current_area.name, 'Военная галерея')
  assert.deepEqual(brief.spatial_context.objects.map((prop) => prop.kind), ['table_long'])
  assert.doesNotMatch(JSON.stringify(brief), /Тайный архив|secret-treasure|chest|bed|layers/)
})

test('максимальный отряд появляется на разных свободных клетках галереи', async () => {
  const players = Array.from({ length: 12 }, (_, index) => ({ ...hero, id: `hero-${index}` }))
  const state = await new CampaignBootstrapper().create({ code: 'FULL-GALLERY', worldTemplateId: 'astohan-plains', players })
  assert.equal(new Set(state.players.map(({ x, y }) => `${x},${y}`)).size, 12)
  const map = deserializeTacticalMap(state.scene.map)
  const occupied = new Set(map.props.flatMap((prop) => prop.footprint).map(({ x, y }) => `${x},${y}`))
  for (const player of state.players) {
    const cell = cellAt(map, player.x, player.y)
    assert.ok(cell.revealed && cell.passable)
    assert.equal(cell.zone, 'gallery')
    assert.ok(!occupied.has(`${player.x},${player.y}`))
  }
})

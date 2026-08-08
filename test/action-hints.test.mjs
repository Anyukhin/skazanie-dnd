// Подсказки «что можно сделать»: детерминированная сборка из уже видимого.
//
// Главная проверка здесь не «строки красивые», а «строки не могут раскрыть
// скрытое». Подсказки строятся из спроецированной комнаты, поэтому сторож
// прогоняет настоящую проекцию со скрытыми клетками, gm_only NPC и секретами
// пропсов и убеждается, что ничего из этого в подсказки не просочилось.
//
// Второй сторож — про меру. После открытия интеракций всей обстановке (задача
// 3.2b) на карте таверны три десятка предметов, и панель заполнялась описью
// мебели под латинскими идентификаторами: «bench / broom / chest / cobweb».
// Ниже закреплено обратное: реквизит попадает в подсказки только содержательный,
// только под русской подписью и только в остаток строк.
import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_ACTION_HINTS, MAX_PROP_HINTS, suggestedActionsFor } from '../server/action-hints.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { addProp, createTacticalMap, serializeTacticalMap, setCell, setDoor } from '../server/tactical-map.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const room = (patch = {}) => ({
  scene: { objective: '', map: { props: [], doors: [] }, ...(patch.scene ?? {}) },
  scene_npcs: patch.scene_npcs ?? [],
  mechanics: patch.mechanics ?? { combat: { active: false } },
})

const prop = (id, assetId, verbs, extra = {}) => ({
  id, assetId, interactive: true, interaction: { kind: 'container', verbs, ...extra },
})

test('подсказки собираются из пропсов, NPC, цели и выхода', () => {
  const hints = suggestedActionsFor(room({
    scene: {
      objective: 'Найти пропавшего писаря',
      map: {
        props: [prop('chest-1', 'chest', ['inspect', 'open'])],
        doors: [{ x: 1, y: 0, dir: 'e' }],
      },
    },
    scene_npcs: [{ id: 'npc-1', name: 'Бром', role: 'трактирщик', alive: true, stance: 'neutral' }],
  }))
  assert.deepEqual(hints.map((hint) => hint.text), [
    'Можно осмотреть: Сундук',
    'Можно заговорить с кем-то из местных: Бром (трактирщик)',
    'Цель отряда: Найти пропавшего писаря',
    'Можно уйти из этого места через дверь',
  ])
  // Идентификаторы нужны клиенту, чтобы не перерисовывать закрытую панель.
  assert.deepEqual(hints.map((hint) => hint.id), ['prop:chest-1:inspect', 'npc:npc-1', 'objective', 'exit'])
})

test('в бою подсказок нет: там действия перечисляет хотбар', () => {
  const combat = room({
    scene: { objective: 'Выжить', map: { props: [prop('chest-1', 'chest', ['inspect'])], doors: [{ x: 1, y: 0, dir: 'e' }] } },
    scene_npcs: [{ id: 'npc-1', name: 'Бром', alive: true }],
    mechanics: { combat: { active: true } },
  })
  assert.deepEqual(suggestedActionsFor(combat), [])
})

test('пустая, чужая и бессодержательная комната не рождают подсказок', () => {
  assert.deepEqual(suggestedActionsFor(null), [])
  assert.deepEqual(suggestedActionsFor(undefined), [])
  assert.deepEqual(suggestedActionsFor('комната'), [])
  assert.deepEqual(suggestedActionsFor(room()), [])
  // Неинтерактивный пропс, незнакомый глагол и предмет вне каталога — молча мимо.
  assert.deepEqual(suggestedActionsFor(room({
    scene: {
      map: {
        props: [
          { id: 'rug', assetId: 'rug' },
          prop('x', 'chest', ['левитировать']),
          prop('y', 'нет-такого-ассета', ['inspect']),
        ],
        doors: [],
      },
    },
  })), [])
  // Враждебный и мёртвый NPC — не собеседники.
  assert.deepEqual(suggestedActionsFor(room({
    scene_npcs: [
      { id: 'a', name: 'Головорез', alive: true, stance: 'hostile' },
      { id: 'b', name: 'Труп', alive: false },
    ],
  })), [])
})

test('обстановка в подсказки не попадает вовсе: её и так видно на доске', () => {
  // Скамья, метла и паутина интерактивны и осматриваются кнопкой, но сервер за
  // ними ничего не приготовил. Подсказка про них — не помощь, а шум.
  const furnished = room({
    scene: {
      objective: 'Дождаться связного',
      map: {
        props: [
          prop('bench-1', 'bench', ['inspect']),
          prop('broom-1', 'broom', ['inspect', 'ignite']),
          prop('cobweb-1', 'cobweb', ['inspect', 'ignite']),
          prop('rug-1', 'rug', ['inspect', 'ignite']),
        ],
        doors: [{ x: 0, y: 1, dir: 's' }],
      },
    },
    scene_npcs: [{ id: 'npc-1', name: 'Бром', role: 'трактирщик', alive: true }],
  })
  assert.deepEqual(suggestedActionsFor(furnished).map((hint) => hint.text), [
    'Можно заговорить с кем-то из местных: Бром (трактирщик)',
    'Цель отряда: Дождаться связного',
    'Можно уйти из этого места через дверь',
  ])
})

test('реквизиту достаётся не больше двух строк, и не за счёт NPC, цели и выхода', () => {
  const crowded = room({
    scene: {
      objective: 'Найти писаря',
      map: {
        props: [
          prop('a-altar', 'altar', ['inspect', 'use'], { pointOfInterest: true }),
          prop('b-chest', 'chest', ['inspect', 'open'], { pointOfInterest: true }),
          prop('c-grave', 'grave', ['inspect', 'take'], { pointOfInterest: true }),
          prop('d-urn', 'urn', ['inspect'], { pointOfInterest: true }),
        ],
        doors: [{ x: 0, y: 0, dir: 's' }],
      },
    },
    scene_npcs: [{ id: 'z', name: 'Зевака', alive: true }],
  })
  // Четыре точки интереса, и все содержательные — в панель войдёт одна: три
  // строки уже заняты собеседником, целью и выходом.
  const texts = suggestedActionsFor(crowded).map((hint) => hint.text)
  assert.deepEqual(texts, [
    'Можно осмотреть: Алтарь',
    'Можно заговорить: Зевака',
    'Цель отряда: Найти писаря',
    'Можно уйти из этого места через дверь',
  ])

  // Без собеседников остаток больше — но потолок реквизита всё равно свой.
  const quiet = room({
    scene: {
      objective: 'Найти писаря',
      map: { props: crowded.scene.map.props, doors: [{ x: 0, y: 0, dir: 's' }] },
    },
  })
  assert.equal(
    suggestedActionsFor(quiet).filter((hint) => hint.id.startsWith('prop:')).length,
    MAX_PROP_HINTS,
  )

  // Мест не осталось вовсе — реквизит уступает целиком, а не наполовину.
  const talkative = room({
    scene: {
      objective: 'Найти писаря',
      map: { props: crowded.scene.map.props, doors: [{ x: 0, y: 0, dir: 's' }] },
    },
    scene_npcs: [
      { id: 'a', name: 'Бром', alive: true },
      { id: 'b', name: 'Марта', alive: true },
    ],
  })
  assert.deepEqual(suggestedActionsFor(talkative).map((hint) => hint.text), [
    'Можно заговорить: Бром',
    'Можно заговорить: Марта',
    'Цель отряда: Найти писаря',
    'Можно уйти из этого места через дверь',
  ])
})

test('порядок детерминирован, приметное впереди, число ограничено', () => {
  const many = room({
    scene: {
      objective: 'Цель',
      map: {
        props: [
          prop('b-crate', 'crate', ['open']),
          prop('a-altar', 'altar', ['inspect'], { pointOfInterest: true }),
          prop('c-barrel', 'barrel', ['topple']),
          prop('d-bones', 'bone_pile', ['inspect']),
        ],
        doors: [{ x: 0, y: 0, dir: 's' }],
      },
    },
  })
  const first = suggestedActionsFor(many)
  assert.equal(first.length, MAX_ACTION_HINTS)
  assert.equal(first[0].text, 'Можно осмотреть: Алтарь', 'точка интереса идёт первой')

  // Тот же вход — тот же список: перестановка не должна выглядеть как событие.
  const shuffled = room({
    scene: {
      objective: 'Цель',
      map: {
        props: [...many.scene.map.props].reverse(),
        doors: [{ x: 0, y: 0, dir: 's' }],
      },
    },
  })
  assert.deepEqual(suggestedActionsFor(shuffled), first)
  assert.deepEqual(suggestedActionsFor(many), first)
})

/**
 * Настоящая таверна: мебель, сундук, NPC за стойкой, цель и дверь.
 *
 * @param {{hiddenChest?: boolean}} [options]
 */
function tavernState({ hiddenChest = false } = {}) {
  const map = createTacticalMap({
    width: 8, height: 6, locationId: 'tavern-hall', seed: 'hints-tavern',
    fill: { passable: true, revealed: true, material: 'wood' },
  })
  if (hiddenChest) setCell(map, 6, 4, { revealed: false })
  // Обстановка зала — ровно то, что затопило панель в зонде ревью.
  addProp(map, { id: 'bench-1', assetId: 'bench', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  addProp(map, { id: 'broom-1', assetId: 'broom', x: 2.5, y: 1.5, footprint: [{ x: 2, y: 1 }] })
  addProp(map, { id: 'cobweb-1', assetId: 'cobweb', x: 3.5, y: 1.5, footprint: [{ x: 3, y: 1 }] })
  addProp(map, { id: 'bar-1', assetId: 'bar_counter', x: 4.5, y: 1.5, footprint: [{ x: 4, y: 1 }] })
  addProp(map, { id: 'chest-1', assetId: 'chest', x: 6.5, y: 4.5, footprint: [{ x: 6, y: 4 }] })
  setDoor(map, { id: 'door-out', x: 0, y: 2, dir: 'e' })
  return normalizeCampaignState({
    sessionCode: 'HINTS-TAVERN',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Мира', hp: 20, maxHp: 20, armor: 14, x: 0, y: 2,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    }],
    enemies: [],
    scene: {
      turn: 1,
      title: 'Общий зал',
      location: 'tavern-hall',
      objective: 'Найти пропавшего писаря',
      cells: [],
      map: serializeTacticalMap(map),
    },
    social: {
      npcs: [
        { id: 'brom', name: 'Бром', role: 'трактирщик', location: 'tavern-hall', visibility: 'public' },
        { id: 'shade', name: 'Соглядатай', role: 'осведомитель', location: 'tavern-hall', visibility: 'gm_only' },
      ],
      relationships: {}, conversations: [], promises: [],
    },
    npc_world: {
      schema_version: 2,
      placements: [
        { npc_id: 'brom', location_id: 'tavern-hall', x: 4, y: 2, placement_reason: 'test' },
        { npc_id: 'shade', location_id: 'tavern-hall', x: 5, y: 2, placement_reason: 'test' },
      ],
      vitals: {}, stances: {}, inventories: {},
    },
    mechanics: { positions: { hero: { x: 0, y: 2 } }, combat: { active: false } },
  })
}

const projectedHints = (state) => campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero').suggested_actions

test('настоящая проекция таверны: сундук по-русски, а мебель — мимо', () => {
  const hints = projectedHints(tavernState())
  const texts = hints.map((hint) => hint.text)

  assert.deepEqual(texts, [
    'Можно осмотреть: Сундук',
    'Можно заговорить с кем-то из местных: Бром (трактирщик)',
    'Цель отряда: Найти пропавшего писаря',
    'Можно уйти из этого места через дверь',
  ])
  // Зонд ревью дословно: сырых идентификаторов в панели быть не может.
  for (const line of texts) {
    assert.doesNotMatch(line, /[A-Za-z]/u, `подсказка показала латиницу: ${line}`)
  }
  for (const assetId of ['bench', 'broom', 'cobweb', 'bar_counter', 'chest']) {
    assert.doesNotMatch(JSON.stringify(texts), new RegExp(assetId, 'iu'), `идентификатор ${assetId} уехал игроку`)
  }
  assert.ok(texts.every((line) => !line.includes('Соглядатай')), 'gm_only NPC в подсказках быть не должно')
})

test('зал из одной обстановки даёт подсказки без реквизита', () => {
  // Сундук спрятан за нераскрытой клеткой — проекция его вырезает, и подсказок
  // по реквизиту не остаётся вовсе. Прочие строки при этом не страдают.
  const hints = projectedHints(tavernState({ hiddenChest: true }))
  assert.deepEqual(hints.map((hint) => hint.text), [
    'Можно заговорить с кем-то из местных: Бром (трактирщик)',
    'Цель отряда: Найти пропавшего писаря',
    'Можно уйти из этого места через дверь',
  ])
  assert.equal(hints.some((hint) => hint.id.startsWith('prop:')), false)
})

test('подсказки не выносят из проекции ничего скрытого', () => {
  const state = normalizeCampaignState({
    sessionCode: 'HINTS',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Мира', hp: 20, maxHp: 20, armor: 14, x: 0, y: 0, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } }],
    enemies: [],
    scene: {
      turn: 1,
      objective: 'Найти писаря',
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
        // Дальняя часть зала ещё не раскрыта — и всё, что там стоит, тоже.
        { x: 5, y: 0, type: 'floor', revealed: false },
      ],
    },
    npc_world: {
      placements: [],
    },
    mechanics: { combat: { active: false } },
  })
  const projected = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  assert.ok(Array.isArray(projected.suggested_actions), 'проекция обязана нести поле подсказок')

  const serialized = JSON.stringify(projected.suggested_actions)
  for (const secret of ['gm_only', 'hidden_information', 'секрет', 'ловушк', 'Скрытый']) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'iu'), `подсказки выдали ${secret}`)
  }
  // Цель сцены игрок и так видит в проекции — её подсказка повторить вправе.
  assert.ok(projected.suggested_actions.some((hint) => hint.text.includes('Найти писаря')))
  assert.ok(projected.suggested_actions.length <= MAX_ACTION_HINTS)

  // Каждая подсказка выводится только из того, что уже уехало игроку.
  assert.deepEqual(projected.suggested_actions, suggestedActionsFor(projected))
})

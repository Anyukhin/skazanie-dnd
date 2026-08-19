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
import { INCORRUPTIBLE_TAG } from '../server/underworld.mjs'
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
 * `leisure: false` переносит тот же зал в место, где ни костей, ни выпивки не
 * подают. Понадобилось это после того, как в таверне появился досуг
 * (`server/tavern-life.mjs`): его строка соперничает за слот панели, и без
 * такой копии проверить подпись реквизита на настоящем пути проекции было бы
 * негде.
 *
 * `pointOfInterest` делает сундук приметным — тем самым, ради чего панель и
 * заводилась.
 *
 * @param {{hiddenChest?: boolean, leisure?: boolean, pointOfInterest?: boolean}} [options]
 */
function tavernState({ hiddenChest = false, leisure = true, pointOfInterest = false } = {}) {
  const hallId = leisure ? 'tavern-hall' : 'guild-hall'
  const map = createTacticalMap({
    width: 8, height: 6, locationId: hallId, seed: 'hints-tavern',
    fill: { passable: true, revealed: true, material: 'wood' },
  })
  if (hiddenChest) setCell(map, 6, 4, { revealed: false })
  // Обстановка зала — ровно то, что затопило панель в зонде ревью.
  addProp(map, { id: 'bench-1', assetId: 'bench', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  addProp(map, { id: 'broom-1', assetId: 'broom', x: 2.5, y: 1.5, footprint: [{ x: 2, y: 1 }] })
  addProp(map, { id: 'cobweb-1', assetId: 'cobweb', x: 3.5, y: 1.5, footprint: [{ x: 3, y: 1 }] })
  addProp(map, { id: 'bar-1', assetId: 'bar_counter', x: 4.5, y: 1.5, footprint: [{ x: 4, y: 1 }] })
  addProp(map, {
    id: 'chest-1',
    assetId: 'chest',
    x: 6.5,
    y: 4.5,
    footprint: [{ x: 6, y: 4 }],
    ...(pointOfInterest ? { interaction: { pointOfInterest: true } } : {}),
  })
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
      location: hallId,
      objective: 'Найти пропавшего писаря',
      cells: [],
      map: serializeTacticalMap(map),
    },
    social: {
      npcs: [
        { id: 'brom', name: 'Бром', role: 'трактирщик', location: hallId, visibility: 'public' },
        { id: 'shade', name: 'Соглядатай', role: 'осведомитель', location: hallId, visibility: 'gm_only' },
      ],
      relationships: {}, conversations: [], promises: [],
    },
    npc_world: {
      schema_version: 2,
      placements: [
        { npc_id: 'brom', location_id: hallId, x: 4, y: 2, placement_reason: 'test' },
        { npc_id: 'shade', location_id: hallId, x: 5, y: 2, placement_reason: 'test' },
      ],
      vitals: {}, stances: {}, inventories: {},
    },
    mechanics: { positions: { hero: { x: 0, y: 2 } }, combat: { active: false } },
  })
}

const projectedHints = (state) => campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero').suggested_actions

test('настоящая проекция зала: сундук по-русски, а мебель — мимо', () => {
  // Зал без досуга: тот же реквизит, те же NPC, но ни костей, ни выпивки здесь
  // не подают — и панель занимают только находка, собеседник, цель и выход.
  const hints = projectedHints(tavernState({ leisure: false }))
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

/**
 * Тот же зал, но в таверне. Досуг заведения занимает одну строку и стоит в ней
 * впереди рядовой обстановки: про кости и кружку новичку иначе никто не
 * скажет, а сундук в углу зала он не вытесняет (следующий тест).
 */
test('в таверне досуг занимает строку панели, а не две', () => {
  const hints = projectedHints(tavernState())
  const texts = hints.map((hint) => hint.text)

  assert.equal(texts.filter((line) => /кост|выпивк/iu.test(line)).length, 1, 'досуг — ровно одна строка')
  assert.equal(texts[0], 'Можно сыграть в кости с местными или заказать выпивку (4 мм)')
  assert.deepEqual(texts.slice(1), [
    'Можно заговорить с кем-то из местных: Бром (трактирщик)',
    'Цель отряда: Найти пропавшего писаря',
    'Можно уйти из этого места через дверь',
  ])
  for (const line of texts) assert.doesNotMatch(line, /[A-Za-z]/u, `подсказка показала латиницу: ${line}`)
})

/**
 * Зонд ревью: безусловный слот у досуга означал, что в трактире про находку не
 * скажут никогда — собеседник, цель и выход занимали остальные три строки.
 * Теперь строки соперничают: приметная находка досуг вытесняет, рядовая
 * обстановка — нет.
 */
test('приметная находка в таверне сильнее приглашения за стол', () => {
  const texts = projectedHints(tavernState({ pointOfInterest: true })).map((hint) => hint.text)

  assert.deepEqual(texts, [
    'Можно осмотреть: Сундук',
    'Можно заговорить с кем-то из местных: Бром (трактирщик)',
    'Цель отряда: Найти пропавшего писаря',
    'Можно уйти из этого места через дверь',
  ])
  assert.equal(texts.some((line) => /кост|выпивк/iu.test(line)), false, 'досуг уступил слот находке')
})

test('зал из одной обстановки даёт подсказки без реквизита', () => {
  // Сундук спрятан за нераскрытой клеткой — проекция его вырезает, и подсказок
  // по реквизиту не остаётся вовсе. Прочие строки при этом не страдают.
  const hints = projectedHints(tavernState({ hiddenChest: true, leisure: false }))
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

// ---------------------------------------------------------------------------
// Изнанка: карман, монета и краденое (волна 4)
//
// Проверок здесь две породы. Первая — «строка появляется там, где движок скажет
// да»: обчистить можно того, до кого дотянулась рука, монету доставать — тому, у
// кого она есть. Вторая, и она важнее, — «строка не отвечает на вопрос, ради
// которого механика заведена»: скупщик и неподкупный выводятся из сида, в
// проекции их нет, и подсказка обязана звучать одинаково по обе стороны сида.

const STOLEN_SPOON = Object.freeze({
  id: 'spoon-1', name: 'Серебряная ложка', type: 'treasure', quantity: 1, weight: 0.1, origin: 'stolen',
})

/**
 * Рыночная площадь: живой мирный человек, торговец за прилавком и герой,
 * который может стоять вплотную или в другом конце площади.
 *
 * `tags` профиля принимает `INCORRUPTIBLE_TAG` — это единственный способ
 * назначить неподкупность руками, и он нужен, чтобы сверить обе стороны сида на
 * одном и том же состоянии.
 */
function underworldState({
  heroCell = { x: 4, y: 2 },
  conversation = false,
  purse = { copper: 50 },
  inventory = [],
  mateInventory = [],
  merchant = true,
  combat = false,
  tags = [],
} = {}) {
  const hallId = 'market'
  const abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
  const grid = []
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 8; x += 1) grid.push({ x, y, type: 'floor', revealed: true })
  return normalizeCampaignState({
    sessionCode: 'HINTS-UNDERWORLD',
    partyMemberIds: ['hero', 'mate'],
    players: [
      { id: 'hero', character: 'Мира', hp: 20, maxHp: 20, armor: 14, abilities, currency: purse, inventory, ...heroCell },
      { id: 'mate', character: 'Тарн', hp: 20, maxHp: 20, armor: 14, abilities, inventory: mateInventory, x: 0, y: 0 },
    ],
    enemies: [],
    scene: { turn: 1, title: 'Рыночная площадь', location: hallId, objective: '', cells: grid },
    social: {
      npcs: [{ id: 'brom', name: 'Бром', role: 'лавочник', location: hallId, visibility: 'public', tags }],
      relationships: {},
      conversations: conversation
        ? [{ id: 'talk-1', npc_id: 'brom', hero_id: 'hero', player_message: 'Нам нужен проводник', npc_reply: 'Поглядим.' }]
        : [],
      promises: [],
    },
    npc_world: {
      schema_version: 2,
      placements: [{ npc_id: 'brom', location_id: hallId, x: 5, y: 2, placement_reason: 'test' }],
      vitals: {}, stances: {}, inventories: {},
    },
    merchants: merchant
      ? [{
          id: 'brom', name: 'Бром', location: hallId, available: true, purse_cp: 50_000,
          stock: [{ stock_id: 'stock-1', catalog_id: 'srd_5_2_1:dagger', quantity: 2, name: 'Кинжал', type: 'weapon', weight: 1, rarity: 'обычный' }],
        }]
      : [],
    mechanics: {
      positions: { hero: { ...heroCell }, mate: { x: 0, y: 0 } },
      combat: { active: combat },
    },
  })
}

const hintsFor = (state, actorId = 'hero') => campaignStateForViewer(state, { role: 'player', heroIds: [actorId] }, actorId).suggested_actions ?? []
const hintTexts = (state, actorId = 'hero') => hintsFor(state, actorId).map((hint) => hint.text)

test('карман называют тому, кто до него дотянулся, и никому больше', () => {
  const close = hintTexts(underworldState())
  assert.ok(close.includes('Можно незаметно обчистить карманы: Бром (Ловкость рук)'), JSON.stringify(close))

  // Через площадь рука не дотягивается — и строки нет: панель на четыре строки,
  // и звать обчистить каждого встречного она не должна.
  const across = hintTexts(underworldState({ heroCell: { x: 0, y: 2 } }))
  assert.equal(across.some((line) => /обчистить карманы/u.test(line)), false, JSON.stringify(across))

  // Ни СЛ, ни содержимого кармана в строке нет: в проекции их нет вовсе.
  assert.equal(close.some((line) => /СЛ|мм|монет/u.test(line)), false, JSON.stringify(close))
})

test('в бою изнанки нет: ни кармана, ни монеты, ни краденого', () => {
  const state = underworldState({ combat: true, conversation: true, inventory: [STOLEN_SPOON] })
  assert.deepEqual(hintsFor(state), [], 'в бою действия перечисляет хотбар')
})

test('монету предлагают после разговора и по кошельку, но о неподкупности молчат', () => {
  const silent = hintTexts(underworldState({ heroCell: { x: 0, y: 2 } }))
  assert.equal(silent.some((line) => /монет/u.test(line)), false, 'разговора не было — и подкреплять нечего')

  const talked = hintTexts(underworldState({ heroCell: { x: 0, y: 2 }, conversation: true }))
  assert.ok(talked.includes('Можно подкрепить убеждение монетой: Бром'), JSON.stringify(talked))

  // Пустой кошелёк движок встретит отказом (`INSUFFICIENT_FUNDS`), и звать
  // доставать монету того, у кого её нет, — подсказка наоборот.
  const broke = hintTexts(underworldState({ heroCell: { x: 0, y: 2 }, conversation: true, purse: { copper: 3 } }))
  assert.equal(broke.some((line) => /монет/u.test(line)), false, JSON.stringify(broke))

  // Неподкупный назначен руками — строка обязана остаться той же буква в букву.
  const incorruptible = hintTexts(underworldState({
    heroCell: { x: 0, y: 2 }, conversation: true, tags: [INCORRUPTIBLE_TAG],
  }))
  assert.deepEqual(incorruptible, talked, 'подкупность читалась бы из панели раньше, чем из разговора')
  assert.doesNotMatch(JSON.stringify(incorruptible), /неподкуп|оскорб/iu)
})

test('сбыть краденое предлагают нейтрально: торговца строка не выдаёт', () => {
  const far = { x: 0, y: 2 }
  const withLoot = hintTexts(underworldState({ heroCell: far, inventory: [STOLEN_SPOON] }))
  assert.ok(withLoot.includes('Можно попробовать сбыть краденое торговцу'), JSON.stringify(withLoot))
  // Кто берёт чужое, выводится из сида и в проекцию не едет: назови строка
  // торговца по имени — она ответила бы на вопрос, ради которого скупщик заведён.
  assert.equal(withLoot.some((line) => /сбыть краденое.*Бром|скупщик/iu.test(line)), false, JSON.stringify(withLoot))

  // Нет краденого — нет и предложения.
  assert.equal(
    hintTexts(underworldState({ heroCell: far })).some((line) => /краденое/u.test(line)),
    false,
  )
  // Нет торговца — сбывать некому.
  assert.equal(
    hintTexts(underworldState({ heroCell: far, inventory: [STOLEN_SPOON], merchant: false })).some((line) => /краденое/u.test(line)),
    false,
  )
})

test('краденое соседа по столу подсказку не рождает: чужая история вещи закрыта', () => {
  const state = underworldState({ heroCell: { x: 0, y: 2 }, mateInventory: [STOLEN_SPOON] })
  const room = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  const mate = room.players.find((player) => player.id === 'mate')
  assert.equal(mate.inventory[0].origin, undefined, 'происхождение чужой вещи проекция снимает')
  assert.equal(
    (room.suggested_actions ?? []).some((hint) => /краденое/u.test(hint.text)),
    false,
    'подсказка не вправе знать больше проекции',
  )

  // Своему герою та же вещь видна вместе с историей — и строка появляется.
  assert.ok(hintTexts(state, 'mate').includes('Можно попробовать сбыть краденое торговцу'))
})

test('строки изнанки не выносят из проекции ни латиницы, ни закрытых тегов', () => {
  const state = underworldState({ conversation: true, inventory: [STOLEN_SPOON], tags: [INCORRUPTIBLE_TAG] })
  const hints = hintsFor(state)
  const serialized = JSON.stringify(hints.map((hint) => hint.text))
  for (const line of hints) assert.doesNotMatch(line.text, /[A-Za-z]/u, `подсказка показала латиницу: ${line.text}`)
  for (const secret of ['gm_only', 'скупщик', 'неподкупный', 'pocket-picked']) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'iu'), `подсказки выдали ${secret}`)
  }
  assert.ok(hints.length <= MAX_ACTION_HINTS)
  // Тот же вход — тот же список: перестановка читалась бы как изменение мира.
  const room = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  assert.deepEqual(suggestedActionsFor(room, 'hero'), hints)
})

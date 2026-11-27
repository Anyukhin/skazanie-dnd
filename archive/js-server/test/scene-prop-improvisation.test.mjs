// Мост между свободной фразой и обстановкой как оружием (задача 3.2c).
//
// Проверяется не «модель поняла задумку» — это недетерминированно, — а границы
// моста: предмет берётся только из переданного списка, глагол обязан быть у
// этого предмета, а исполняет всё та же OperateSceneObject с её проверкой,
// источником огня и ценой действия. Выдуманный предмет не должен доходить до
// движка вовсе.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ActionAdjudicator, adjudicationBrief } from '../server/action-adjudicator.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { scenePropIntentFor } from '../server/improvised-effects.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { addProp, createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

const CAMPAIGN_ID = 'PROP-IMPROV-1'

/**
 * @param {{withFire?: boolean, distantBed?: boolean, hiddenCorner?: boolean, twinChests?: boolean}} options
 *   `distantBed` — настоящий пропс вне досягаемости: зонд ревью про «осмотреть
 *   кровать в дальнем углу». `hiddenCorner` прячет его клетку от игрока.
 *   `twinChests` ставит два одинаковых сундука: один у клетки из листа героя,
 *   другой у клетки, где герой стоит на самом деле.
 */
function sceneState({ withFire = true, distantBed = false, hiddenCorner = false, twinChests = false } = {}) {
  const map = createTacticalMap({
    width: 6, height: 4, locationId: 'stable', seed: 'prop-improv',
    fill: { passable: true, revealed: true, material: 'wood' },
  })
  if (hiddenCorner) setCell(map, 4, 3, { revealed: false })
  addProp(map, { id: 'prop-haystack', assetId: 'haystack', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] })
  addProp(map, { id: 'prop-shelf', assetId: 'bookshelf', x: 0.5, y: 1.5, footprint: [{ x: 0, y: 1 }] })
  if (distantBed) addProp(map, { id: 'prop-bed', assetId: 'bed', x: 4.5, y: 3.5, footprint: [{ x: 4, y: 3 }] })
  if (twinChests) {
    addProp(map, { id: 'prop-chest-sheet', assetId: 'chest', x: 0.5, y: 2.5, footprint: [{ x: 0, y: 2 }] })
    addProp(map, { id: 'prop-chest-real', assetId: 'chest', x: 5.5, y: 2.5, footprint: [{ x: 5, y: 2 }] })
  }
  if (withFire) addProp(map, { id: 'prop-fire', assetId: 'campfire', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  return normalizeCampaignState({
    sessionCode: CAMPAIGN_ID,
    campaign: 'Мост к обстановке',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Ада', level: 3, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 2,
      abilities: { str: 18, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
      classSkillProficiencies: ['athletics'], x: 0, y: 0, inventory: [],
    }],
    enemies: [{
      id: 'goblin', name: 'Гоблин', hp: 14, maxHp: 14, armor: 13, alive: true,
      abilities: { str: 10, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, x: 0, y: 1,
    }],
    scene: {
      title: 'Конюшня', location: 'Конюшня', objective: 'Выбить налётчика', turn: 1,
      map: serializeTacticalMap(map),
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, goblin: { x: 0, y: 1 } },
      world_time: { elapsed_minutes: 0 },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const reading = (overrides = {}) => ({
  goal_summary: 'Поджечь сено под ногами налётчика',
  approach_summary: 'Подношу к сену открытый огонь',
  obstacle: 'налётчик рядом',
  ability: 'dex',
  skill: 'sleight_of_hand',
  plausibility: 'plausible',
  risk: 'serious',
  required_means: [],
  action_cost: 'action',
  effect: 'ignite_prop',
  effect_target: '',
  hazard: '',
  prop_id: 'prop-haystack',
  target_id: '',
  item_id: '',
  proficiency: 'none',
  consequence_type: 'noise',
  ...overrides,
})

// Первые два значения — d20: проверка Атлетики проходит, спасбросок жертвы
// проваливается. Дальше идут мелкие кости урона, годные и для d20, и для d6.
const DICE = Object.freeze([19, 2, 4, 3, ...Array.from({ length: 200 }, () => 3)])

async function fixture(t, { payload = reading(), state = sceneState() } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-prop-improv-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const eventStore = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 7 })
  await eventStore.initializeCampaign({ campaign_id: CAMPAIGN_ID, initial_state: state })
  const diceService = new DiceService({ rng: new SequenceDiceRng([...DICE]) })
  const rulesEngine = new RulesEngine({ diceService })
  const actionAdjudicator = new ActionAdjudicator({ llmClient: { completeJson: async () => payload } })
  return {
    eventStore,
    autonomy: new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, actionAdjudicator, now: () => 1_784_466_000_000 }),
  }
}

const improvise = (autonomy, key, action) => autonomy.handleUnknownAction({
  campaignId: CAMPAIGN_ID, playerId: 'hero', action, idempotencyKey: key,
})

const types = (result) => (result.events ?? []).map((event) => event.event_type)

test('бриф называет арбитру только те предметы сцены, с которыми умеет работать движок', () => {
  const brief = adjudicationBrief(sceneState(), 'hero', 'Поджигаю сено')
  const ids = brief.scene_props.map((entry) => entry.id)
  assert.deepEqual(ids, ['prop-haystack', 'prop-shelf'], 'костёр не валится и не горит — в списке его быть не должно')

  const haystack = brief.scene_props.find((entry) => entry.id === 'prop-haystack')
  assert.deepEqual(haystack.verbs, ['ignite'], 'у стога нет опрокидывания')
  assert.equal(haystack.name, 'стог сена')
  assert.equal(haystack.state, 'idle')
  assert.deepEqual(haystack.at, { x: 1, y: 0 })
  assert.equal(haystack.distance_feet, 5)
  const shelf = brief.scene_props.find((entry) => entry.id === 'prop-shelf')
  assert.deepEqual(shelf.verbs, ['topple', 'ignite'])
  // Скрытого в списке нет: ни СЛ, ни урона, ни ключей находки.
  for (const field of ['dc', 'damage', 'detailKey', 'rewardKey']) {
    assert.equal(Object.hasOwn(haystack, field), false, `поле ${field} не должно уезжать модели`)
  }
})

test('предмет в нераскрытой клетке арбитру не называется', () => {
  // Карта в состоянии авторитетная, поэтому спрашивать про раскрытие обязан
  // сам бриф: иначе арбитр предложил бы игроку поджечь кровать в той части
  // подземелья, которую проекция карты от него ещё прячет.
  const visible = adjudicationBrief(sceneState({ distantBed: true }), 'hero', 'Поджигаю сено')
  assert.ok(visible.scene_props.some((entry) => entry.id === 'prop-bed'), 'раскрытая клетка предмет показывает')

  const hidden = adjudicationBrief(sceneState({ distantBed: true, hiddenCorner: true }), 'hero', 'Поджигаю сено')
  assert.deepEqual(hidden.scene_props.map((entry) => entry.id), ['prop-haystack', 'prop-shelf'])
})

test('расстояние до предмета считается от авторитетной позиции, а не от листа героя', () => {
  const state = sceneState()
  // Ходит движок по mechanics.positions; поле листа осталось той клеткой, с
  // которой герой начал бой, и бриф не имеет права мерить от неё.
  state.mechanics.positions.hero = { x: 3, y: 3 }
  const brief = adjudicationBrief(state, 'hero', 'Поджигаю сено')

  assert.equal(state.players[0].x, 0, 'лист персонажа намеренно оставлен устаревшим')
  assert.equal(brief.scene_props.find((entry) => entry.id === 'prop-haystack').distance_feet, 15)
})

test('«поджигаю сено» доходит до настоящей зоны огня, а не до одноразового урона', async (t) => {
  const { autonomy } = await fixture(t)
  const result = await improvise(autonomy, 'prop-improv-1', 'Поджигаю сено у стойл, чтобы огонь отрезал налётчика.')

  assert.equal(result.kind, 'scene_interaction')
  assert.ok(types(result).includes('SceneObjectOperated'))
  assert.ok(types(result).includes('SpellAreaCreated'), 'зона огня заводится общей машинерией площадных эффектов')
  assert.equal(types(result).includes('ApplyDamage'), false, 'одноразового импровизированного урона здесь быть не должно')
  assert.equal(result.state.mechanics.scene_interactions['prop-haystack'].state, 'burning')
  assert.equal(result.turn_consumed, true, 'в бою интеракция стоит действия')
  assert.equal(result.state.mechanics.combat.action_economy.hero.action, false)
  assert.match(result.narration, /огн[её]м/u)
  assert.equal(/\d/u.test(result.narration), false, 'чисел механики в тексте быть не должно')

  const effect = result.state.mechanics.active_effects.at(-1)
  assert.equal(effect.damage_type, 'fire')
  assert.deepEqual(effect.cells, [{ x: 1, y: 0 }])
})

test('опрокинутый стеллаж накрывает того, кто стоит под ним', async (t) => {
  const { autonomy } = await fixture(t, {
    payload: reading({ effect: 'topple_prop', prop_id: 'prop-shelf', ability: 'str', skill: 'athletics' }),
  })
  const result = await improvise(autonomy, 'prop-improv-topple', 'Наваливаюсь на стеллаж, чтобы он рухнул на гоблина.')

  assert.equal(result.kind, 'scene_interaction')
  assert.ok(types(result).includes('SceneObjectCheckResolved'), 'проверку бросает движок, а не арбитр')
  assert.ok(types(result).includes('DamageApplied'))
  assert.equal(result.state.mechanics.scene_interactions['prop-shelf'].state, 'toppled')
  assert.ok(result.state.enemies[0].hp < 14)
})

test('выдуманный предмет и чужой глагол до движка не доходят', async (t) => {
  const invented = await fixture(t, { payload: reading({ prop_id: 'prop-powder-barrel' }) })
  const first = await improvise(invented.autonomy, 'prop-improv-invented', 'Поджигаю бочку с маслом у стены, чтобы она рванула.')
  assert.notEqual(first.kind, 'scene_interaction')
  assert.equal(types(first).includes('SceneObjectOperated'), false, 'интеракции с несуществующим предметом быть не может')
  assert.equal(types(first).includes('SpellAreaCreated'), false)

  // У стога нет опрокидывания: глагол обязан быть у названного предмета.
  const wrongVerb = await fixture(t, { payload: reading({ effect: 'topple_prop', prop_id: 'prop-haystack' }) })
  const second = await improvise(wrongVerb.autonomy, 'prop-improv-wrong-verb', 'Опрокидываю стог сена на гоблина.')
  assert.notEqual(second.kind, 'scene_interaction')
  assert.equal(types(second).includes('SceneObjectStateChanged'), false)
})

test('отказ правил остаётся отказом правил: нечем поджечь — ход не потрачен', async (t) => {
  const { autonomy, eventStore } = await fixture(t, { state: sceneState({ withFire: false }) })
  const before = await eventStore.load(CAMPAIGN_ID)
  const result = await improvise(autonomy, 'prop-improv-no-fire', 'Поджигаю сено у стойл голыми руками.')

  assert.equal(result.kind, 'clarification')
  assert.match(result.narration, /Нечем поджечь/u)
  assert.deepEqual(result.events, [])
  assert.equal(result.turn_consumed, false)

  // Ответ несёт состояние, прочитанное ДО попытки, поэтому проверять по нему
  // атомарность бессмысленно — такое утверждение не может упасть. Спрашивается
  // хранилище: версия не сдвинулась, действие осталось при герое, стог цел.
  const after = await eventStore.load(CAMPAIGN_ID)
  assert.equal(after.state_version, before.state_version, 'отклонённый коммит не должен оставлять версию')
  assert.equal(after.state.mechanics.combat.action_economy.hero.action, true, 'действие обязано остаться при герое')
  assert.equal(after.state.mechanics.scene_interactions?.['prop-haystack']?.state ?? 'idle', 'idle')
})

test('явный глагол по дальнему предмету возвращает уточнение, а не ошибку запроса', async (t) => {
  // Зонд ревью: «осмотреть кровать в дальнем углу» называет настоящий пропс,
  // до которого не дотянуться. Ветка ближайшего названного предмета шла без
  // try/catch, и SCENE_OBJECT_OUT_OF_REACH улетал наружу как HTTP 400.
  const { autonomy, eventStore } = await fixture(t, { state: sceneState({ distantBed: true }) })
  const before = await eventStore.load(CAMPAIGN_ID)
  const result = await improvise(autonomy, 'prop-improv-far-bed', 'Осмотреть кровать в дальнем углу конюшни.')

  assert.equal(result.kind, 'clarification')
  assert.match(result.narration, /встаньте вплотную/u)
  assert.deepEqual(result.events, [])
  assert.equal(result.turn_consumed, false)

  const after = await eventStore.load(CAMPAIGN_ID)
  assert.equal(after.state_version, before.state_version, 'отклонённый коммит не должен оставлять версию')
  assert.equal(after.state.mechanics.combat.action_economy.hero.action, true)
})

test('предмет в нераскрытой клетке фразой не находится', async (t) => {
  // Разбор фразы про реквизит шёл по всем предметам карты — включая те, что
  // проекция от игрока прячет. Отказ «встаньте вплотную» на такую фразу и был
  // оракулом: игрок узнавал, что кровать в неразведанном углу существует.
  const { autonomy, eventStore } = await fixture(t, { state: sceneState({ distantBed: true, hiddenCorner: true }) })
  const before = await eventStore.load(CAMPAIGN_ID)
  const result = await improvise(autonomy, 'prop-improv-hidden-bed', 'Осмотреть кровать в дальнем углу конюшни.')

  assert.equal(result.kind, 'clarification')
  assert.match(result.narration, /не видно/u)
  assert.doesNotMatch(result.narration, /вплотную/u, 'о существовании предмета отвечать нельзя')
  assert.deepEqual(result.events, [])
  assert.equal(result.turn_consumed, false)

  const after = await eventStore.load(CAMPAIGN_ID)
  assert.equal(after.state_version, before.state_version, 'отклонённый разбор не должен оставлять версию')
  assert.equal(after.state.mechanics.combat.action_economy.hero.action, true)
})

test('ближайший предмет выбирается от боевой позиции, а не от листа героя', async (t) => {
  // Ходит герой по `mechanics.positions`; поле листа осталось той клеткой, с
  // которой он начал бой. Мерить от неё значило выбрать сундук на другом конце
  // конюшни и получить отказ по досягаемости на ровном месте.
  const state = sceneState({ twinChests: true })
  state.mechanics.positions.hero = { x: 5, y: 3 }
  assert.equal(state.players[0].x, 0, 'лист персонажа намеренно оставлен устаревшим')

  const { autonomy } = await fixture(t, { state })
  const result = await improvise(autonomy, 'prop-improv-twin-chests', 'Осмотреть сундук у стены конюшни.')

  assert.equal(result.kind, 'scene_interaction')
  const operated = (result.events ?? []).find((event) => event.event_type === 'SceneObjectOperated')
  assert.equal(operated?.payload?.prop_id, 'prop-chest-real')
})

test('каталог знает ровно два глагола обстановки и ничего сверх', () => {
  assert.equal(scenePropIntentFor('topple_prop'), 'topple')
  assert.equal(scenePropIntentFor('ignite_prop'), 'ignite')
  for (const effectId of ['none', 'prone', 'hazard_damage', 'burn_everything', '']) {
    assert.equal(scenePropIntentFor(effectId), null, `${effectId}: маршрута в OperateSceneObject быть не должно`)
  }
})

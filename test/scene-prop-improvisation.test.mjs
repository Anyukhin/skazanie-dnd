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
import { addProp, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

const CAMPAIGN_ID = 'PROP-IMPROV-1'

function sceneState({ withFire = true } = {}) {
  const map = createTacticalMap({
    width: 6, height: 4, locationId: 'stable', seed: 'prop-improv',
    fill: { passable: true, revealed: true, material: 'wood' },
  })
  addProp(map, { id: 'prop-haystack', assetId: 'haystack', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] })
  addProp(map, { id: 'prop-shelf', assetId: 'bookshelf', x: 0.5, y: 1.5, footprint: [{ x: 0, y: 1 }] })
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
  const { autonomy } = await fixture(t, { state: sceneState({ withFire: false }) })
  const result = await improvise(autonomy, 'prop-improv-no-fire', 'Поджигаю сено у стойл голыми руками.')

  assert.equal(result.kind, 'clarification')
  assert.match(result.narration, /Нечем поджечь/u)
  assert.deepEqual(result.events, [])
  assert.equal(result.turn_consumed, false)
  assert.equal(result.state.mechanics.combat.action_economy.hero.action, true, 'действие обязано остаться при герое')
})

test('каталог знает ровно два глагола обстановки и ничего сверх', () => {
  assert.equal(scenePropIntentFor('topple_prop'), 'topple')
  assert.equal(scenePropIntentFor('ignite_prop'), 'ignite')
  for (const effectId of ['none', 'prone', 'hazard_damage', 'burn_everything', '']) {
    assert.equal(scenePropIntentFor(effectId), null, `${effectId}: маршрута в OperateSceneObject быть не должно`)
  }
})

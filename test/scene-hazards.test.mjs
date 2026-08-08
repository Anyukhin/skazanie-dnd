import assert from 'node:assert/strict'
import test from 'node:test'

import { assetById } from '../server/asset-registry.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { interactionMetadataForProp, sceneInteractionCatalogEntry, sceneInteractionDefinition } from '../server/scene-interactions.mjs'
import {
  fireSourceAssetIds,
  hazardAssetKey,
  sceneHazardAssetIds,
  sceneHazardTagsFor,
  sceneHazardVerbsFor,
} from '../server/scene-hazards.mjs'
import { hasSceneHazardEvent, sceneHazardNarration } from '../server/scene-hazard-narration.mjs'
import { addProp, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

/**
 * Задача 3.2 плана: обстановка как оружие. Опрокинуть тяжёлое и поджечь
 * горючее — обычные операции пропса, объявленные сервером, с настоящей
 * механикой: проверка, урон, спасбросок, зона огня.
 */

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `roll-${++id}`,
    now: () => '2026-08-02T00:00:00.000Z',
  })
}

function hazardState({ assetId = 'bookshelf', seed = 'hazard-seed', withFire = false, victimAt = null, heroInventory = [] } = {}) {
  const map = createTacticalMap({
    width: 6, height: 4, locationId: 'hazard-scene', seed,
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  addProp(map, { id: 'prop-target', assetId, x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }], interactive: true })
  if (withFire) addProp(map, { id: 'prop-fire', assetId: 'campfire', x: 0.5, y: 1.5, footprint: [{ x: 0, y: 1 }], interactive: true })
  return normalizeCampaignState({
    sessionCode: 'HAZARD',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', hp: 20, maxHp: 20, proficiency: 2,
      abilities: { str: 18, dex: 14, int: 12, wis: 12, cha: 10, con: 14 },
      classSkillProficiencies: ['athletics'], inventory: heroInventory, x: 0, y: 0,
    }],
    enemies: victimAt
      ? [{ id: 'goblin', name: 'Гоблин', hp: 14, maxHp: 14, armor: 13, alive: true, abilities: { str: 10, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, x: victimAt.x, y: victimAt.y }]
      : [],
    scene: { map: serializeTacticalMap(map), turn: 1 },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, ...(victimAt ? { goblin: { x: victimAt.x, y: victimAt.y } } : {}) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero' }, ...(victimAt ? [{ actor_id: 'goblin' }] : [])],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true } },
      },
    },
  })
}

const operate = (state, intent, diceService) => resolveCommands(
  [{ command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-target', intent, approach: 'hand' }],
  state,
  { diceService, context: { serverAuthoritativeCombat: true } },
)

const types = (result) => result.events.map((event) => event.event_type)
const propState = (state) => state.mechanics.scene_interactions['prop-target']?.state

test('теги обстановки выводятся из assetId и объявляются сервером как глаголы', () => {
  assert.deepEqual(sceneHazardTagsFor('bookshelf'), { heavy: true, flammable: true, fireSource: false })
  assert.deepEqual(sceneHazardTagsFor('campfire'), { heavy: false, flammable: false, fireSource: true })
  assert.deepEqual(sceneHazardTagsFor('statue'), { heavy: true, flammable: false, fireSource: false })
  assert.deepEqual(sceneHazardTagsFor('rune'), { heavy: false, flammable: false, fireSource: false })
  // Путь и расширение в assetId не мешают: ключ берётся из последнего сегмента.
  assert.equal(hazardAssetKey('props/table_long.png'), 'table_long')
  assert.deepEqual(sceneHazardVerbsFor('table_long'), ['topple', 'ignite'])
  assert.deepEqual(sceneHazardVerbsFor('statue'), ['topple'])
  assert.deepEqual(sceneHazardVerbsFor('rune'), [])

  // Контракт пропса отдаёт их вместе с обычными операциями, не вместо них.
  const definition = sceneInteractionDefinition({
    mapSeed: 'hazard-seed',
    props: [{ id: 'prop-target', assetId: 'bookshelf', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] }],
    propId: 'prop-target',
  })
  assert.ok(definition.verbs.includes('inspect'), 'осмотр никуда не делся')
  assert.ok(definition.verbs.includes('topple') && definition.verbs.includes('ignite'))
  assert.equal(definition.topple.skill, 'athletics')
  assert.equal(definition.ignite.damage_type, 'fire')
})

test('весь справочник опасностей операбелен: реестр, каталог и глаголы сходятся', () => {
  const hazardIds = sceneHazardAssetIds()
  assert.ok(hazardIds.length >= 30, `справочник обмельчал: ${hazardIds.length} пропсов`)
  for (const assetId of hazardIds) {
    const asset = assetById(assetId)
    assert.ok(asset, `${assetId}: тега опасности нет соответствия в реестре ассетов`)
    assert.equal(asset.interactive, true, `${assetId}: тяжёлый или горючий предмет обязан быть интерактивным`)
    const catalog = sceneInteractionCatalogEntry(assetId)
    assert.ok(catalog, `${assetId}: каталог взаимодействий не узнаёт предмет, движок ответит SCENE_OBJECT_UNSUPPORTED`)
    const expected = sceneHazardVerbsFor(assetId)
    assert.ok(expected.length, `${assetId}: у предмета из справочника обязан быть хотя бы один глагол обстановки`)
    const definition = sceneInteractionDefinition({
      mapSeed: 'hazard-coverage',
      props: [{ id: 'p', assetId, x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] }],
      propId: 'p',
    })
    for (const verb of expected) {
      assert.ok(definition.verbs.includes(verb), `${assetId}: контракт не объявил ${verb}`)
    }
    // Affordance едет игроку картой: клиент рисует кнопку по этому списку.
    const projected = interactionMetadataForProp({ mapSeed: 'hazard-coverage', prop: { id: 'p', assetId } })
    for (const verb of expected) {
      assert.ok(projected.verbs.includes(verb), `${assetId}: проекция карты не объявила ${verb}`)
    }
  }
  for (const assetId of fireSourceAssetIds()) {
    assert.ok(assetById(assetId), `${assetId}: источник огня обязан существовать в реестре`)
  }
})

test('декор без тегов опасности интерактивным не становится', () => {
  for (const assetId of ['chair', 'stool', 'sack', 'bucket', 'night_table', 'mug', 'sign_board', 'floor_stain', 'washbasin']) {
    const asset = assetById(assetId)
    assert.ok(asset, `${assetId}: запись реестра пропала`)
    assert.deepEqual(sceneHazardVerbsFor(assetId), [], `${assetId}: у декора не должно быть глаголов обстановки`)
    if (assetId === 'night_table') continue // словарный вариант `table`: осмотр был и остаётся
    assert.equal(asset.interactive, false, `${assetId}: декор не должен становиться интерактивным`)
    assert.equal(sceneInteractionCatalogEntry(assetId), null, `${assetId}: каталог не должен знать декор`)
  }
})

test('новые пропсы обстановки действительно валятся и горят через движок', () => {
  // Сено поджигается от костра рядом, платяной шкаф валится проверкой Атлетики.
  const burning = operate(hazardState({ assetId: 'haystack', withFire: true }), 'ignite', dice([10, 10]))
  assert.ok(types(burning).includes('SpellAreaCreated'))
  assert.equal(propState(burning.state), 'burning')

  const toppled = operate(hazardState({ assetId: 'wardrobe', victimAt: { x: 1, y: 0 } }), 'topple', dice([19, 2, 4, 3]))
  assert.ok(types(toppled).includes('SceneObjectCheckResolved'))
  assert.equal(propState(toppled.state), 'toppled')
  assert.ok(toppled.state.enemies[0].hp < 14, 'шкаф придавил стоящего под ним')

  // Обстановка осматривается как раньше, но добычи и тайника в ней нет.
  const furnishing = sceneInteractionDefinition({
    mapSeed: 'hazard-coverage',
    props: [{ id: 'p', assetId: 'bunk_bed', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] }],
    propId: 'p',
  })
  assert.equal(furnishing.kind, 'furnishing')
  assert.deepEqual(furnishing.verbs, ['inspect', 'ignite'])
  assert.equal(furnishing.rewardKey, '')
  assert.equal(furnishing.pointOfInterest, false, 'обстановка не объявляется точкой интереса')
  assert.ok(furnishing.detail?.text, 'осмотр обстановки обязан что-то сообщать')
})

test('успешное опрокидывание валит стеллаж, ранит стоящего под ним и сбивает с ног', () => {
  // Высокий бросок Атлетики валит стеллаж; низкий спасбросок гоблина проваливает.
  const result = operate(hazardState({ victimAt: { x: 1, y: 0 } }), 'topple', dice([19, 2, 4, 3]))
  assert.ok(types(result).includes('SceneObjectOperated'))
  assert.ok(types(result).includes('SceneObjectCheckResolved'))
  assert.ok(types(result).includes('SavingThrowResolved'))
  assert.ok(types(result).includes('DamageApplied'))
  assert.ok(types(result).includes('ConditionAdded'), 'проваленный спасбросок сбивает с ног')
  assert.equal(propState(result.state), 'toppled')
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.reason, 'scene-object-topple')
  assert.ok(result.state.enemies[0].hp < 14, 'урон применён')
  assert.ok((result.state.mechanics.conditions.goblin ?? []).some((entry) => entry.id === 'prone'))
})

test('проваленная попытка ничего не ломает и оставляет пропс целым', () => {
  const result = operate(hazardState({ victimAt: { x: 1, y: 0 } }), 'topple', dice([1, 1, 1, 1]))
  assert.ok(types(result).includes('SceneObjectCheckResolved'))
  assert.equal(types(result).includes('DamageApplied'), false, 'без успеха урона нет')
  assert.notEqual(propState(result.state), 'toppled')
  assert.equal(result.state.enemies[0].hp, 14)
})

test('поджог создаёт горящую зону на клетках пропса и тушится сроком', () => {
  const state = hazardState({ withFire: true })
  const result = operate(state, 'ignite', dice([10, 10]))
  assert.ok(types(result).includes('SpellAreaCreated'), 'зона огня заведена общей машинерией')
  assert.equal(propState(result.state), 'burning')

  const effect = result.state.mechanics.active_effects.at(-1)
  assert.equal(effect.damage_type, 'fire')
  assert.equal(effect.trigger_on_enter, true)
  assert.equal(effect.trigger_on_turn_end, true)
  assert.equal(effect.open_flame, true)
  // Снятие зоны ищет по effect_id: без него запись не удалилась бы никогда.
  assert.equal(effect.effect_id, effect.id)
  assert.deepEqual(effect.cells, [{ x: 1, y: 0 }])
  assert.ok(effect.expires_round > state.mechanics.combat.round, 'зона живёт несколько раундов')
  assert.ok(effect.expires_round <= state.mechanics.combat.round + 3)
})

test('поджечь нечем — честный отказ, а не молчаливый успех', () => {
  assert.throws(
    () => operate(hazardState({ withFire: false }), 'ignite', dice([10, 10])),
    (error) => error.code === 'SCENE_OBJECT_NO_FIRE_SOURCE',
  )
  // Факел в руках — законный источник огня.
  const withTorch = operate(hazardState({ heroInventory: [{ id: 'torch-1', name: 'Факел' }] }), 'ignite', dice([10, 10]))
  assert.ok(types(withTorch).includes('SpellAreaCreated'))
})

test('повторная интеракция с изменённым пропсом отклоняется', () => {
  // Действие хода первая операция уже потратила, и без сброса экономии сработал
  // бы ACTION_SPENT — а проверить нужно именно запрет по состоянию пропса.
  const refreshed = (state) => normalizeCampaignState({
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: {
        ...state.mechanics.combat,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true } },
      },
    },
  })

  const toppled = refreshed(operate(hazardState({ withFire: true }), 'topple', dice([19, 2, 4, 3])).state)
  assert.equal(propState(toppled), 'toppled')
  for (const intent of ['topple', 'ignite']) {
    assert.throws(
      () => operate(toppled, intent, dice([19, 2, 4, 3])),
      (error) => error.code === 'SCENE_OBJECT_ALREADY_ALTERED',
      `${intent} по поваленному объекту недопустим`,
    )
  }

  const burning = refreshed(operate(hazardState({ withFire: true }), 'ignite', dice([10, 10])).state)
  assert.equal(propState(burning), 'burning')
  assert.throws(
    () => operate(burning, 'ignite', dice([10, 10])),
    (error) => error.code === 'SCENE_OBJECT_ALREADY_ALTERED',
  )
})

test('негорючее и нетяжёлое не поддаётся: руна не валится и не горит', () => {
  for (const intent of ['topple', 'ignite']) {
    assert.throws(
      () => operate(hazardState({ assetId: 'rune', withFire: true }), intent, dice([19, 2])),
      (error) => error.code === 'SCENE_OBJECT_INTENT_NOT_ALLOWED',
    )
  }
})

test('интеракции получают детерминированное описание без чисел механики', () => {
  const toppled = operate(hazardState({ victimAt: { x: 1, y: 0 } }), 'topple', dice([19, 2, 4, 3]))
  assert.equal(hasSceneHazardEvent(toppled.events), true)
  const fallText = sceneHazardNarration(toppled.events, toppled.state)
  assert.match(fallText, /[Сс]теллаж/u)
  assert.match(fallText, /сбива|накрыва/u)
  assert.equal(/\d/u.test(fallText), false, 'чисел механики в тексте быть не должно')

  const failed = operate(hazardState(), 'topple', dice([1, 1, 1, 1]))
  assert.match(sceneHazardNarration(failed.events, failed.state), /устоял/u)

  const burning = operate(hazardState({ withFire: true }), 'ignite', dice([10, 10]))
  const fireText = sceneHazardNarration(burning.events, burning.state)
  assert.match(fireText, /огн[её]м/u)
  assert.equal(/\d/u.test(fireText), false)

  // Чужой батч этот рассказчик не перехватывает.
  assert.equal(hasSceneHazardEvent([{ event_type: 'SceneObjectStateChanged', payload: { intent: 'open' } }]), false)
  assert.equal(hasSceneHazardEvent([]), false)
})

test('состояние пропса переживает replay и попадает в обе авторитетные записи', () => {
  const state = hazardState({ withFire: true })
  for (const [intent, expected] of [['topple', 'toppled'], ['ignite', 'burning']]) {
    const result = operate(state, intent, dice([19, 2, 4, 3]))
    assert.deepEqual(replayEvents(state, result.events), result.state, `${intent}: replay даёт то же состояние`)
    // Повтор того же потока не удваивает запись и не меняет итог.
    const twice = result.events.reduce((current, event) => applyGameEvent(current, event), result.state)
    assert.equal(twice.mechanics.scene_interactions['prop-target'].state, expected)
    // Зеркало в карте сцены — второй авторитетный источник состояния пропса.
    const mirrored = twice.scene.map.props.find((prop) => prop.id === 'prop-target')
    assert.equal(mirrored.state, expected)
  }
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import {
  GAME_STATE_PROJECTOR_VERSION,
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'
import {
  interactionMetadataForProp,
  nearestSceneObjectCommand,
  sceneInteractionCatalogEntry,
  sceneInteractionDefinition,
  sceneInteractionMetadata,
  sceneInteractionNarration,
  sceneObjectOperationFromText,
} from '../server/scene-interactions.mjs'
import {
  addProp,
  createTacticalMap,
  serializeTacticalMap,
} from '../server/tactical-map.mjs'

// Объекты сцены в JS-библиотеке: metadata, разбор свободного текста, команда
// OperateSceneObject в движке и журнале. HTTP-путь — scene-interactions.test.mjs.

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `scene-roll-${++id}`,
    now: () => '2026-07-30T18:00:00.000Z',
  })
}

/**
 * `thief` — предыстория с владением воровскими инструментами. Замок вскрывает
 * только владеющий (`server/lockpicking.mjs`), и без этого признака запертый
 * сундук отвечает отказом до всякого броска.
 */
function sceneState({ assetId = 'chest', seed = 'scene-seed', propX = 1, propY = 0, combat = false, thief = false } = {}) {
  const map = createTacticalMap({
    width: 5,
    height: 3,
    locationId: 'test-scene',
    seed,
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  addProp(map, {
    id: `prop-${assetId}`,
    assetId,
    x: propX + 0.5,
    y: propY + 0.5,
    footprint: [{ x: propX, y: propY }],
    interactive: true,
  })
  return normalizeCampaignState({
    sessionCode: 'SCENE-T',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      hp: 12,
      maxHp: 12,
      proficiency: 2,
      abilities: { str: 16, dex: 14, int: 14, wis: 14, cha: 10, con: 12 },
      classSkillProficiencies: ['athletics', 'arcana', 'religion', 'investigation', 'perception', 'sleight_of_hand'],
      ...(thief ? { backgroundId: 'criminal' } : {}),
      inventory: [],
      x: 0,
      y: 0,
    }],
    scene: { map: serializeTacticalMap(map), turn: 1 },
    mechanics: {
      positions: { hero: { x: 0, y: 0 } },
      combat: combat ? {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'hero' }],
        active_index: 0,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true } },
      } : undefined,
    },
  })
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

function containerSeed({ locked = true, trapped = true } = {}) {
  const prop = { id: 'prop-chest', assetId: 'chest' }
  for (let index = 0; index < 10_000; index += 1) {
    const seed = `container-${index}`
    const definition = sceneInteractionDefinition({ mapSeed: seed, props: [prop], propId: prop.id })
    if (Boolean(definition.lock) === locked && Boolean(definition.trap) === trapped) return seed
  }
  throw new Error('Не найден тестовый seed контейнера')
}

test('metadata объектов детерминирована, выбирает 2–4 POI и не доверяет входному interaction', () => {
  const props = ['chest', 'barrel', 'crate', 'altar', 'rune', 'statue', 'campfire', 'bookshelf', 'table', 'bones']
    .map((assetId, index) => ({
      id: `prop-${index}`,
      assetId,
      interaction: { kind: 'forged', verbs: ['steal'], pointOfInterest: true, detailKey: 'secret', rewardKey: 'wish' },
    }))
  const first = sceneInteractionMetadata({ mapSeed: 'metadata-seed', props })
  const second = sceneInteractionMetadata({ mapSeed: 'metadata-seed', props })
  assert.deepEqual([...first], [...second])
  const points = [...first.values()].filter((metadata) => metadata.pointOfInterest)
  assert.ok(points.length >= 2 && points.length <= 4)
  assert.ok(points.every((metadata) => metadata.detailKey && metadata.rewardKey))
  assert.ok([...first.values()].every((metadata) => metadata.kind !== 'forged' && !metadata.verbs.includes('steal')))

  const one = interactionMetadataForProp({ mapSeed: 'metadata-seed', prop: props[0], pointOfInterest: true })
  assert.equal(one.kind, 'container')
})

test('свободный текст распознаёт силовое открытие и выбирает ближайшую подходящую бочку', () => {
  assert.deepEqual(sceneObjectOperationFromText('Разбить бочку топором'), {
    intent: 'open',
    approach: 'force',
    aliases: ['barrel'],
  })
  const command = nearestSceneObjectCommand({
    actorPosition: { x: 0, y: 0 },
    text: 'Разбить бочку топором',
    props: [
      { id: 'far', assetId: 'barrel', x: 4.5, y: 0.5, footprint: [{ x: 4, y: 0 }] },
      { id: 'near', assetId: 'barrel', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] },
    ],
  })
  assert.deepEqual(command, {
    command_type: 'OperateSceneObject', prop_id: 'near', intent: 'open', approach: 'force',
  })
})

test('свободный поиск выбирает авторскую улику по подписи, даже если assetId не входит в общий каталог', () => {
  const text = 'Ищу под обломками караулки обгоревший журнал сборщика налогов'
  const command = nearestSceneObjectCommand({
    actorPosition: { x: 0, y: 0 },
    text,
    props: [
      { id: 'rubble', assetId: 'rubble_heap', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] },
      { id: 'journal', assetId: 'paper_scatter', x: 8.5, y: 0.5, footprint: [{ x: 8, y: 0 }] },
    ],
    scenarioClueForProp: (prop) => prop.id === 'journal' ? { label: 'обгоревший журнал' } : null,
  })
  assert.deepEqual(command, { command_type: 'OperateSceneObject', prop_id: 'journal', intent: 'inspect', approach: 'hand' })
})

test('цитата, отказ и осмотр комнаты не читают фреску рядом с героем', () => {
  const options = {
    props: [{ id: 'fresco', assetId: 'temple_banner', footprint: [{ x: 5, y: 5 }] }],
    actorPosition: { x: 5, y: 4 }, scenarioClueForProp: () => ({ label: 'фреска' }),
  }
  for (const text of ['Не читаю фреску', 'Как изучать фреску?', 'Осматриваю комнату', 'Ищу кота и говорю «фреска»']) {
    assert.equal(nearestSceneObjectCommand({ ...options, text }), null, text)
  }
  assert.equal(nearestSceneObjectCommand({ ...options, text: 'Изучаю фреску' })?.prop_id, 'fresco')
})

test('свободный текст находит составные варианты канонического предмета', () => {
  for (const [assetId, text, intent] of [
    ['table_small', 'Осмотреть стол', 'inspect'],
    ['table_round', 'Осмотреть стол', 'inspect'],
    ['barrel_stack', 'Разбить бочку топором', 'open'],
    ['crate_stack', 'Открыть ящик', 'open'],
  ]) {
    assert.ok(sceneInteractionCatalogEntry(assetId), `${assetId}: вариант должен поддерживаться каталогом`)
    assert.deepEqual(nearestSceneObjectCommand({
      actorPosition: { x: 0, y: 0 },
      text,
      props: [{ id: `prop-${assetId}`, assetId, x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] }],
    }), {
      command_type: 'OperateSceneObject',
      prop_id: `prop-${assetId}`,
      intent,
      approach: /разбить|топор/iu.test(text) ? 'force' : 'hand',
    })
  }
})

test('глагол без названного предмета не уходит дальнему или неподходящему предмету', () => {
  // Живой прогон 2026-10-02: «проталкиваюсь к шлюзам и смотрю, кто пытается
  // их открыть» уезжало ближайшему пропсу с глаголом «открыть», и движок
  // отвечал «Для этого объекта такое действие недоступно».
  const text = 'Проталкиваюсь сквозь толпу к шлюзам и смотрю, кто пытается их открыть'
  assert.equal(nearestSceneObjectCommand({
    actorPosition: { x: 0, y: 0 }, text,
    props: [{ id: 'bench', assetId: 'bench', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] }],
  }), null, 'у скамьи нет глагола «открыть»')
  assert.equal(nearestSceneObjectCommand({
    actorPosition: { x: 0, y: 0 }, text,
    props: [{ id: 'far-chest', assetId: 'chest', x: 6.5, y: 0.5, footprint: [{ x: 6, y: 0 }] }],
  }), null, 'безымянный сундук через площадь не «под рукой»')
  assert.equal(nearestSceneObjectCommand({
    actorPosition: { x: 0, y: 0 }, text: 'Открыть',
    props: [
      { id: 'bench', assetId: 'bench', x: 0.5, y: 1.5, footprint: [{ x: 0, y: 1 }] },
      { id: 'chest', assetId: 'chest', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] },
    ],
  })?.prop_id, 'chest', 'рядом стоящий сундук открывается и без названия')
})

test('названная дверь или рычаг не подменяются соседним контейнером', () => {
  // Плейтест 2026-10-04, MAP2-01: фраза про рычаг и дверь башни открыла
  // соседний буфет и показала булаву внутри. Незнакомые обстановке слова
  // оставляли пустой список aliases, и это читалось как «предмет не назван».
  const props = [{ id: 'prop-159-cupboard', assetId: 'cupboard', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] }]
  const near = (text) => nearestSceneObjectCommand({ actorPosition: { x: 0, y: 0 }, text, props })
  for (const text of [
    'Пробую осторожно привести в действие ржавый рычаг у ворот и открыть запертую дверь башни, не ломая механизм.',
    'Открыть дверь',
    'Осмотреть ворота',
    'Использовать рычаг',
    'Взломать замок двери',
    'Открыть люк в полу',
  ]) assert.equal(near(text), null, text)
  assert.equal(near('Открыть')?.prop_id, 'prop-159-cupboard', 'голое «Открыть» по-прежнему берёт то, что под рукой')
  assert.equal(near('Открыть буфет у двери')?.prop_id, 'prop-159-cupboard', 'названный буфет открывается и рядом с дверью')
  assert.equal(near('Открыть дверцу')?.prop_id, 'prop-159-cupboard', 'дверцу открывают у буфета')
})

test('дистанция и server-only силовой подход проверяются до броска', () => {
  const far = sceneState({ propX: 4 })
  assert.throws(
    () => resolveCommand({ command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'inspect' }, far, { diceService: dice([20]) }),
    (error) => error instanceof RulesValidationError && error.code === 'SCENE_OBJECT_OUT_OF_REACH',
  )
  const near = sceneState()
  assert.throws(
    () => resolveCommand({ command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'open', approach: 'force' }, near, { diceService: dice([20]) }),
    (error) => error instanceof RulesValidationError && error.code === 'SCENE_OBJECT_FORCE_FORBIDDEN',
  )
})

test('запертый контейнер с ловушкой вскрывается отмычкой, наносит bounded урон и отдаёт loot ровно один раз', () => {
  const seed = containerSeed()
  const initial = sceneState({ seed, thief: true })
  const opened = resolveCommand({
    command_type: 'OperateSceneObject',
    actor_id: 'hero',
    prop_id: 'prop-chest',
    intent: 'lockpick',
  }, initial, { diceService: dice([20, 3]) })
  assert.ok(opened.events.some((event) => event.event_type === 'SceneObjectCheckResolved' && event.payload.success))
  assert.ok(opened.events.some((event) => event.event_type === 'SceneObjectStateChanged' && event.payload.state === 'open'))
  const trapDamage = opened.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(trapDamage.payload.reason, 'scene-object-trap')
  assert.ok(trapDamage.payload.applied_amount >= 1 && trapDamage.payload.applied_amount <= 4)
  const afterOpen = applyAll(initial, opened.events)
  assert.equal(afterOpen.mechanics.scene_interactions['prop-chest'].opened, true)

  const taken = resolveCommand({
    command_type: 'OperateSceneObject',
    actor_id: 'hero',
    prop_id: 'prop-chest',
    intent: 'take',
  }, afterOpen, { diceService: dice([]) })
  const finalState = applyAll(afterOpen, taken.events)
  assert.equal(finalState.players[0].inventory.filter((item) => item.id === 'scene-loot-prop-chest-1').length, 1)
  assert.equal(finalState.mechanics.scene_interactions['prop-chest'].loot_claimed, true)
  assert.throws(
    () => resolveCommand({
      command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'take',
    }, finalState, { diceService: dice([]) }),
    (error) => error instanceof RulesValidationError && error.code === 'SCENE_OBJECT_LOOT_ALREADY_CLAIMED',
  )
  assert.deepEqual(replayEvents(initial, [...opened.events, ...taken.events]), finalState)
})

test('ловушка при падении до нуля запускает те же последствия, что обычный урон', () => {
  const seed = containerSeed()
  const initial = sceneState({ seed, thief: true })
  initial.players[0].hp = 1
  const opened = resolveCommand({
    command_type: 'OperateSceneObject',
    actor_id: 'hero',
    prop_id: 'prop-chest',
    intent: 'lockpick',
  }, initial, { diceService: dice([20, 3]) })
  assert.ok(opened.events.some((event) => event.event_type === 'DamageApplied' && event.payload.hp_after === 0))
  assert.ok(opened.events.some((event) => event.event_type === 'HitPointsReducedToZero'))
  const after = applyAll(initial, opened.events)
  assert.equal(after.players[0].hp, 0)
  assert.ok(after.mechanics.conditions.hero.some((condition) => condition.id === 'unconscious'))
})

test('неудачный осмотр фиксирует попытку, а успешный открывает только server detail', () => {
  const initial = sceneState({ assetId: 'rune' })
  const failed = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-rune', intent: 'inspect',
  }, initial, { diceService: dice([1]) })
  const afterFailure = applyAll(initial, failed.events)
  assert.equal(afterFailure.mechanics.scene_interactions['prop-rune'].inspected, false)
  assert.equal(afterFailure.mechanics.scene_interactions['prop-rune'].inspection_attempted, true)
  assert.deepEqual(afterFailure.mechanics.scene_interactions['prop-rune'].inspection_attempted_by, ['hero'])
  assert.equal(failed.events.some((event) => event.event_type === 'SceneObjectKnowledgeRevealed'), false)
  assert.throws(
    () => resolveCommand({
      command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-rune', intent: 'inspect',
    }, afterFailure, { diceService: dice([20]) }),
    (error) => error instanceof RulesValidationError && error.code === 'SCENE_OBJECT_ALREADY_INSPECTED',
  )

  const succeeded = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-rune', intent: 'inspect',
  }, initial, { diceService: dice([20]) })
  const afterSuccess = applyAll(initial, succeeded.events)
  assert.equal(afterSuccess.mechanics.scene_interactions['prop-rune'].inspected, true)
  assert.ok(succeeded.events.some((event) => event.event_type === 'SceneObjectKnowledgeRevealed'))
  assert.equal(sceneInteractionNarration([]), '')
  assert.match(sceneInteractionNarration(succeeded.events), /надпись|символ|знак/ui)

  const used = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-rune', intent: 'use',
  }, afterSuccess, { diceService: dice([]) })
  const afterUse = applyAll(afterSuccess, used.events)
  assert.equal(afterUse.mechanics.temporary_hp.hero, 1)
  assert.equal(afterUse.mechanics.scene_interactions['prop-rune'].used, true)
  assert.throws(
    () => resolveCommand({
      command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-rune', intent: 'use',
    }, afterUse, { diceService: dice([]) }),
    (error) => error instanceof RulesValidationError && error.code === 'SCENE_OBJECT_ALREADY_USED',
  )
})

test('в бою объект тратит действие, вне боя костёр проходит через RestStarted/RestCompleted', () => {
  const combat = sceneState({ assetId: 'bookshelf', combat: true })
  const inspected = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-bookshelf', intent: 'inspect',
  }, combat, { diceService: dice([20]) })
  const afterCombat = applyAll(combat, inspected.events)
  assert.equal(afterCombat.mechanics.combat.action_economy.hero.action, false)
  assert.throws(
    () => resolveCommand({
      command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-bookshelf', intent: 'inspect',
    }, afterCombat, { diceService: dice([20]) }),
    (error) => error instanceof RulesValidationError && error.code === 'ACTION_SPENT',
  )

  const campfire = sceneState({ assetId: 'campfire' })
  const rested = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-campfire', intent: 'use',
  }, campfire, { diceService: dice([]) })
  assert.deepEqual(
    rested.events.filter((event) => ['RestStarted', 'TimeAdvanced', 'RestCompleted'].includes(event.event_type)).map((event) => event.event_type),
    ['RestStarted', 'TimeAdvanced', 'RestCompleted'],
  )
  const afterRest = applyAll(campfire, rested.events)
  assert.equal(afterRest.mechanics.world_time.elapsed_minutes, 60)
  assert.equal(afterRest.players[0].hp, campfire.players[0].hp, 'костёр не лечит без расхода кости хитов')
  assert.equal(afterRest.mechanics.resting.hero, undefined)
  assert.equal(afterRest.mechanics.scene_interactions['prop-campfire'].used, false)
  assert.deepEqual(afterRest.mechanics.scene_interactions['prop-campfire'].used_by, ['hero'])
  assert.equal(sceneInteractionNarration(rested.events), 'У костра завершён короткий привал.')
  assert.equal(sceneInteractionNarration([
    { event_type: 'RestCompleted', actor_id: 'hero', target_ids: ['hero'], payload: { kind: 'long' } },
  ]), '', 'обычный отдых не должен получать generic-текст объекта сцены')
  assert.throws(
    () => resolveCommand({
      command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-campfire', intent: 'use',
    }, afterRest, { diceService: dice([]) }),
    (error) => error instanceof RulesValidationError && error.code === 'SCENE_OBJECT_ALREADY_USED',
  )
})

test('другой герой может осмотреть тот же объект и отдохнуть у того же костра', () => {
  const rune = sceneState({ assetId: 'rune' })
  rune.partyMemberIds.push('hero-2')
  rune.players.push({
    ...rune.players[0],
    id: 'hero-2',
    x: 0,
    y: 1,
  })
  rune.mechanics.positions['hero-2'] = { x: 0, y: 1 }
  const firstInspection = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-rune', intent: 'inspect',
  }, rune, { diceService: dice([1]) })
  const afterFirstInspection = applyAll(rune, firstInspection.events)
  const secondInspection = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero-2', prop_id: 'prop-rune', intent: 'inspect',
  }, afterFirstInspection, { diceService: dice([20]) })
  const afterSecondInspection = applyAll(afterFirstInspection, secondInspection.events)
  assert.equal(afterSecondInspection.mechanics.scene_interactions['prop-rune'].inspected, true)
  assert.deepEqual(
    afterSecondInspection.mechanics.scene_interactions['prop-rune'].inspection_attempted_by,
    ['hero', 'hero-2'],
  )

  const campfire = sceneState({ assetId: 'campfire' })
  campfire.partyMemberIds.push('hero-2')
  campfire.players.push({
    ...campfire.players[0],
    id: 'hero-2',
    x: 0,
    y: 1,
  })
  campfire.mechanics.positions['hero-2'] = { x: 0, y: 1 }
  const firstRest = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-campfire', intent: 'use',
  }, campfire, { diceService: dice([]) })
  const afterFirstRest = applyAll(campfire, firstRest.events)
  const secondRest = resolveCommand({
    command_type: 'OperateSceneObject', actor_id: 'hero-2', prop_id: 'prop-campfire', intent: 'use',
  }, afterFirstRest, { diceService: dice([]) })
  const afterSecondRest = applyAll(afterFirstRest, secondRest.events)
  assert.deepEqual(afterSecondRest.mechanics.scene_interactions['prop-campfire'].used_by, ['hero', 'hero-2'])
  assert.deepEqual(replayEvents(campfire, [...firstRest.events, ...secondRest.events]), afterSecondRest)
})

test('FileEventStore не дублирует loot по тому же key и после reopen даёт тот же replay', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-scene-object-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const seed = containerSeed({ locked: false, trapped: false })
  const initial = sceneState({ seed })
  const store = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
  })
  await store.initializeCampaign({ campaign_id: initial.sessionCode, initial_state: initial })

  const open = resolveCommand({
    command_type: 'OperateSceneObject',
    command_id: 'open-cache',
    campaign_id: initial.sessionCode,
    actor_id: 'hero',
    prop_id: 'prop-chest',
    intent: 'open',
  }, initial, { diceService: dice([]) })
  const opened = await store.commit({
    campaign_id: initial.sessionCode,
    expected_state_version: 0,
    idempotency_key: 'open-cache',
    command_id: 'open-cache',
    events: open.events,
  })
  assert.equal(opened.events.filter((event) => event.event_type === 'SceneObjectLootRevealed').length, 1)

  const take = resolveCommand({
    command_type: 'OperateSceneObject',
    command_id: 'take-cache',
    campaign_id: initial.sessionCode,
    actor_id: 'hero',
    prop_id: 'prop-chest',
    intent: 'take',
  }, opened.state, { diceService: dice([]) })
  const request = {
    campaign_id: initial.sessionCode,
    expected_state_version: opened.state_version,
    idempotency_key: 'take-cache',
    command_id: 'take-cache',
    events: take.events,
  }
  const taken = await store.commit(request)
  const duplicate = await store.commit(request)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.state_version, taken.state_version)
  assert.equal(taken.events.filter((event) => event.event_type === 'SceneObjectLootGranted').length, 1)
  assert.equal(taken.state.players[0].inventory.filter((item) => item.id === 'scene-loot-prop-chest-1').length, 1)

  const reopened = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
  })
  const replayed = await reopened.replay(initial.sessionCode, { use_snapshots: false })
  assert.deepEqual(replayed.state, taken.state)
  assert.equal((await reopened.getEvents(initial.sessionCode))
    .filter((event) => event.event_type === 'SceneObjectLootGranted').length, 1)
})

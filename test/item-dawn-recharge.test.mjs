import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore, VersionConflictError } from '../server/event-store.mjs'
import {
  MAX_DAWN_RECHARGE_ITEMS_PER_EVENT,
  MAX_DAWN_RECHARGE_ROLLS_PER_ITEM,
  dawnCrossings,
} from '../server/item-dawn-recharge.mjs'
import {
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'
import {
  campaignStateForViewer,
  turnExplanationForViewer,
  turnResultForViewer,
} from '../server/viewer-projection.mjs'

const RECHARGE = Object.freeze({ schema_version: 1, trigger: 'dawn', formula: '1d6+1' })

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `dawn-roll-${++id}`,
    now: () => '2026-07-31T06:00:00.000Z',
  })
}

function hero(id, inventory = []) {
  return {
    id,
    character: id,
    characterClass: 'fighter',
    level: 1,
    hp: 12,
    maxHp: 12,
    armor: 14,
    speed: 30,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory,
  }
}

function rechargeable(id, current = 0, maximum = 7, extra = {}) {
  return {
    id,
    name: id,
    type: 'other',
    quantity: 1,
    charges: { current, max: maximum },
    recharge: RECHARGE,
    ...extra,
  }
}

function campaign({ elapsed = 0, players = [hero('hero')] } = {}) {
  return normalizeCampaignState({
    campaign_id: 'DAWN-RECHARGE',
    sessionCode: 'DAWN-RECHARGE',
    partyMemberIds: players.map((player) => player.id),
    players,
    scene: { turn: 1, location: 'Лагерь', cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    mechanics: { world_time: { elapsed_minutes: elapsed } },
  })
}

function advance(state, amount, unit, values = []) {
  return resolveCommand(
    { command_type: 'AdvanceTime', amount, unit },
    state,
    { diceService: dice(values) },
  )
}

test('арифметика рассвета не считает стартовую границу повторно и работает без минутных циклов', () => {
  assert.equal(dawnCrossings(0, 0), 0)
  assert.equal(dawnCrossings(0, 1_439), 0)
  assert.equal(dawnCrossings(1_439, 1), 1)
  assert.equal(dawnCrossings(1_440, 1), 0)
  assert.equal(dawnCrossings(1_439, 2_881), 3)
  assert.equal(dawnCrossings(0, 1_440 * 1_000_000), 1_000_000)
  const nearMaximum = Number.MAX_SAFE_INTEGER - 1_000
  assert.equal(
    dawnCrossings(nearMaximum, 2_000),
    Math.floor(Number.MAX_SAFE_INTEGER / 1_440) - Math.floor(nearMaximum / 1_440),
  )
  const capped = advance(campaign({
    elapsed: nearMaximum,
    players: [hero('hero', [rechargeable('near-maximum', 0)])],
  }), 2_000, 'minute', [1])
  const aggregate = capped.events.find((event) => event.event_type === 'ItemDawnRechargeResolved')
  assert.equal(aggregate.payload.elapsed_minutes_before, nearMaximum)
  assert.equal(aggregate.payload.elapsed_minutes_after, Number.MAX_SAFE_INTEGER)
})

test('без пересечения рассвета и для полного предмета нет броска и дополнительного события', () => {
  const beforeDawn = campaign({
    elapsed: 1_000,
    players: [hero('hero', [rechargeable('waiting', 2)])],
  })
  // Рассвет предмета и рассвет мировых часов — разные границы: первая считается
  // от пересечения 1440 минут, вторая — от пяти утра (`server/weather.mjs`).
  // Здесь проверяется перезарядка, поэтому события неба отфильтрованы.
  const withoutSky = (result) => result.events.map((event) => event.event_type)
    .filter((type) => !['TimeOfDayChanged', 'WeatherChanged'].includes(type))
  const noCrossing = advance(beforeDawn, 439, 'minute', [])
  assert.deepEqual(withoutSky(noCrossing), ['TimeAdvanced'])
  assert.deepEqual(noCrossing.rolls, [])

  const full = campaign({
    elapsed: 1_439,
    players: [hero('hero', [rechargeable('full', 7)])],
  })
  const crossedAtFull = advance(full, 1, 'minute', [])
  assert.deepEqual(withoutSky(crossedAtFull), ['TimeAdvanced'])
  assert.deepEqual(crossedAtFull.rolls, [])
})

test('один aggregate event сортирует героев и предметы, хранит приватные броски и проецирует только capability', () => {
  const initial = campaign({
    elapsed: 1_439,
    players: [
      hero('zeta', [rechargeable('z-item', 0), rechargeable('a-item', 1)]),
      hero('alpha', [rechargeable('middle-item', 2)]),
    ],
  })
  const result = advance(initial, 1, 'minute', [1, 2, 3])
  assert.deepEqual(result.events.map((event) => event.event_type), ['TimeAdvanced', 'ItemDawnRechargeResolved'])
  const rechargeEvent = result.events[1]
  assert.equal(rechargeEvent.visibility, 'gm_only')
  assert.equal(rechargeEvent.event_schema_version, 1)
  assert.equal(rechargeEvent.payload.dawns_crossed, 1)
  assert.deepEqual(
    rechargeEvent.payload.items.map((item) => `${item.owner_id}/${item.item_id}`),
    ['alpha/middle-item', 'zeta/a-item', 'zeta/z-item'],
  )
  assert.deepEqual(rechargeEvent.payload.items.map((item) => [item.before, item.after]), [[2, 4], [1, 4], [0, 4]])
  assert.ok(rechargeEvent.payload.items.every((item) => {
    assert.deepEqual(item.recharge, RECHARGE)
    return Object.hasOwn(item.recharge, 'max_charges') === false
  }))
  assert.ok(rechargeEvent.payload.items.every((item) => item.rolls.length === 1))
  assert.ok(rechargeEvent.payload.items.every((item) => item.rolls[0].visibility === 'gm_only'))

  const after = replayEvents(initial, result.events)
  const projected = campaignStateForViewer(after, { role: 'player' }, 'alpha')
  const projectedItem = projected.players.find((player) => player.id === 'alpha').inventory[0]
  assert.deepEqual(projectedItem.capabilities.charges, { current: 4, max: 7 })
  assert.deepEqual(projectedItem.capabilities.recharge, RECHARGE)
  assert.equal(Object.hasOwn(projectedItem.capabilities.recharge, 'rolls'), false)

  const playerResult = turnResultForViewer({
    authoritative_state: after,
    mechanics: result.events,
    rolls: result.rolls,
  }, { role: 'player' }, 'alpha')
  assert.deepEqual(playerResult.rolls, [])
  assert.equal(playerResult.mechanics.some((event) => event.event_type === 'ItemDawnRechargeResolved'), false)
  const playerExplanation = turnExplanationForViewer({
    commands: [],
    events: result.events,
    rolls: result.rolls,
  }, { role: 'player' }, 'alpha', after)
  assert.deepEqual(playerExplanation.rolls, [])
  assert.equal(playerExplanation.events.some((event) => event.event_type === 'ItemDawnRechargeResolved'), false)
  const adminResult = turnResultForViewer({
    authoritative_state: after,
    mechanics: result.events,
    rolls: result.rolls,
  }, { role: 'admin' }, 'alpha')
  assert.equal(adminResult.rolls.length, 3)
})

test('несколько рассветов бросают лишь до заполнения и не более bounded-лимита', () => {
  const initial = campaign({
    elapsed: 1_439,
    players: [hero('hero', [rechargeable('wand-like', 0)])],
  })
  const result = advance(initial, 1_440 * 100, 'minute', [1, 1, 1, 1])
  const item = result.events.find((event) => event.event_type === 'ItemDawnRechargeResolved').payload.items[0]
  assert.equal(item.rolls.length, MAX_DAWN_RECHARGE_ROLLS_PER_ITEM)
  assert.deepEqual(item.rolls.map((roll) => roll.charges_after), [2, 4, 6, 7])
  assert.equal(item.after, 7)
  assert.equal(result.rolls.length, MAX_DAWN_RECHARGE_ROLLS_PER_ITEM)
})

test('reducer воспроизводит payload после изменения профиля и не обращается к DiceService или каталогу', () => {
  const initial = campaign({
    elapsed: 1_439,
    players: [hero('hero', [rechargeable('legacy-homebrew', 1)])],
  })
  const result = advance(initial, 1, 'minute', [4])
  const event = result.events.find((candidate) => candidate.event_type === 'ItemDawnRechargeResolved')
  const live = replayEvents(initial, result.events)

  const drifted = campaign({
    elapsed: 1_439,
    players: [hero('hero', [{
      ...rechargeable('legacy-homebrew', 1, 99),
      recharge: { schema_version: 999, trigger: 'midnight', formula: '100d100' },
    }])],
  })
  const replayed = applyGameEvent(applyGameEvent(drifted, result.events[0]), event)
  assert.deepEqual(
    replayed.players[0].inventory[0].charges,
    live.players[0].inventory[0].charges,
  )
  assert.deepEqual(replayed.players[0].inventory[0].charges, { current: 6, max: 7 })
})

test('reducer fail-closed игнорирует unversioned и неизвестные версии aggregate event', () => {
  const initial = campaign({
    elapsed: 1_440,
    players: [hero('hero', [rechargeable('versioned', 1)])],
  })
  const payload = {
    schema_version: 1,
    trigger: 'dawn',
    elapsed_minutes_before: 1_439,
    elapsed_minutes_after: 1_440,
    dawns_crossed: 1,
    items: [{
      owner_id: 'hero',
      item_id: 'versioned',
      recharge: RECHARGE,
      before: 1,
      after: 7,
      max: 7,
      rolls: [],
    }],
  }
  const baseEvent = {
    event_type: 'ItemDawnRechargeResolved',
    actor_id: 'system',
    target_ids: ['hero'],
    payload,
    visibility: 'gm_only',
  }
  const unversioned = applyGameEvent(initial, baseEvent)
  assert.deepEqual(unversioned.players[0].inventory[0].charges, { current: 1, max: 7 })
  const unknownEventVersion = applyGameEvent(initial, { ...baseEvent, event_schema_version: 2 })
  assert.deepEqual(unknownEventVersion.players[0].inventory[0].charges, { current: 1, max: 7 })
  const unknownPayloadVersion = applyGameEvent(initial, {
    ...baseEvent,
    event_schema_version: 1,
    payload: { ...payload, schema_version: 2 },
  })
  assert.deepEqual(unknownPayloadVersion.players[0].inventory[0].charges, { current: 1, max: 7 })
})

test('известный catalog id игнорирует forged recharge, а невалидный homebrew-профиль инертен', () => {
  const initial = campaign({
    elapsed: 1_439,
    players: [hero('hero', [
      rechargeable('forged-ring', 0, 7, { catalog_id: 'srd_5_2_1:ring-of-protection' }),
      { ...rechargeable('bad-homebrew', 0), recharge: { schema_version: 1, trigger: 'dawn', formula: '1d20+20' } },
    ])],
  })
  const result = advance(initial, 1, 'minute', [])
  assert.deepEqual(result.events.map((event) => event.event_type), ['TimeAdvanced'])
  assert.deepEqual(result.rolls, [])
  assert.equal(initial.players[0].inventory[0].recharge, undefined)
  assert.equal(initial.players[0].inventory[1].recharge, undefined)
})

test('слишком большой aggregate отклоняется до первого броска', () => {
  const inventory = Array.from(
    { length: MAX_DAWN_RECHARGE_ITEMS_PER_EVENT + 1 },
    (_, index) => rechargeable(`item-${String(index).padStart(3, '0')}`, 0),
  )
  const initial = campaign({ elapsed: 1_439, players: [hero('hero', inventory)] })
  assert.throws(
    () => advance(initial, 1, 'minute', []),
    (error) => error?.code === 'ITEM_DAWN_RECHARGE_LIMIT_EXCEEDED',
  )
})

test('все producer-path TimeAdvanced используют один resolver перезарядки', () => {
  const source = readFileSync(new URL('../server/rules-engine.mjs', import.meta.url), 'utf8')
  assert.match(source, /actionType === 'long_cast'[\s\S]{0,350}appendTimeAdvance\(/u)
  assert.match(source, /case 'AdvanceTime'[\s\S]{0,350}appendWorldTimeConsequences\(/u)
  assert.match(source, /if \(definition\.kind === 'campfire'\)[\s\S]{0,1600}appendWorldTimeConsequences\(/u)
  assert.equal([...source.matchAll(/'TimeAdvanced'/gu)].length, 3, 'producer не должен обходить общий appendTimeAdvance')
})

test('проекция комнаты больше не зависит от списка типов событий', () => {
  // Раньше здесь проверялось, что `ItemDawnRechargeResolved` не забыт в
  // allowlist `refreshInventory`. Сам allowlist удалён (шаг 1
  // `docs/agent-architecture-plan.md`): проекция берёт авторитетное состояние
  // целиком, поэтому забыть тип больше нельзя в принципе.
  //
  // Инвариант «комната равна полной проекции» проверяется на живом сервере в
  // `test/room-projection-equivalence.test.mjs`, в том числе на типах событий,
  // которых в прежних списках не было.
  const source = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const projection = source.split('function persistAuthoritativeProjection')[1]?.split('function reconcileProjectionOutbox')[0] ?? ''
  assert.doesNotMatch(projection, /const\s+(?:refreshInventory|characterBuildChanged)\s*=/u,
    'вернулся список типов событий — вместе с ним вернулся и класс багов «забыли тип»')
  assert.doesNotMatch(projection, /eventTypes\.has\(/u,
    'проекция снова смотрит на тип события вместо авторитетного состояния')
  assert.match(projection, /\.\.\.engineState/u,
    'проекция обязана брать авторитетное состояние целиком')
})

test('повтор idempotency key и reopen не дублируют aggregate; stale version отклоняется', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-dawn-recharge-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const initial = campaign({
    elapsed: 1_439,
    players: [hero('hero', [rechargeable('durable', 1)])],
  })
  const resolved = advance(initial, 1, 'minute', [2])
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent })
  await store.initializeCampaign({ campaign_id: 'dawn-durable', initial_state: initial })
  const request = {
    campaign_id: 'dawn-durable',
    expected_state_version: initial.state_version,
    idempotency_key: 'advance-one-dawn',
    command_id: resolved.command.command_id,
    events: resolved.events,
  }
  const committed = await store.commit(request)
  const duplicate = await store.commit(request)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.state_version, committed.state_version)
  assert.equal((await store.getEvents('dawn-durable')).filter((event) => event.event_type === 'ItemDawnRechargeResolved').length, 1)
  await assert.rejects(
    store.commit({ ...request, idempotency_key: 'stale-advance' }),
    VersionConflictError,
  )

  const reopened = new FileEventStore({ rootDir, reducer: applyGameEvent })
  const restored = await reopened.replay('dawn-durable', { use_snapshots: false })
  assert.deepEqual(restored.state.players[0].inventory[0].charges, { current: 4, max: 7 })
  assert.deepEqual(restored.state, committed.state)
})

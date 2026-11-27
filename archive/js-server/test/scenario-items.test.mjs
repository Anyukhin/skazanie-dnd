// Предметы сценария «Асстоханские равнины» (`SCENARIO_ITEM_CATALOG`,
// `server/item-catalog.mjs`): Слеза Проклятого Рыцаря и оберег Ломара.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignScenario, scenarioClueFactId, scenarioLocationId } from '../server/campaign-scenario.mjs'
import { ITEM_CATALOG, SCENARIO_ITEM_CATALOG, catalogItem, materializeCatalogItem } from '../server/item-catalog.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { fixedDice } from './kit/dice.mjs'

const heroes = [
  { id: 'item-hero', character: 'Аста', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Странница', level: 7, hp: 70, maxHp: 70, armor: 18, speed: 30 },
  { id: 'item-ally', character: 'Борн', name: 'Игрок 2', role: 'Жрец · ур. 7', species: 'Дварф', background: 'Отшельник', level: 7, hp: 60, maxHp: 60, armor: 18, speed: 25 },
]
const TEAR = 'scenario_astohan:kaelan-tear'
const WARD = 'scenario_astohan:lomar-ward'

async function campaign() {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({ code: 'ITEMS', worldTemplateId: 'astohan-plains', players: heroes }))
  const run = { initial, state: initial, events: [], step: 0 }
  run.apply = (commands, context = { isAdmin: true }) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `items-${run.step}-${index}`, ...command }))
    const result = resolveCommands(list, run.state, { diceService: fixedDice(10), context })
    run.state = normalizeCampaignState(result.state)
    run.events.push(...result.events)
    return result
  }
  run.travel = async (locationId) => {
    for (let hop = 0; hop < 8 && scenarioLocationId(run.state) !== locationId; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: `В ${locationId}`, destinationLocationId: locationId })
      run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
    }
    assert.equal(scenarioLocationId(run.state), locationId)
  }
  run.give = (catalogId, heroId = heroes[0].id) => {
    const result = run.apply({ command_type: 'GrantItem', actor_id: heroId, item: { catalog_id: catalogId, origin: 'reward' } })
    return result.events.find((event) => event.event_type === 'ItemGranted').payload.item.id
  }
  /** Команда от имени игрока, владеющего героем. */
  run.player = (id = heroes[0].id) => ({ allowedActorIds: [id] })
  run.hero = (id = heroes[0].id) => run.state.players.find((player) => player.id === id)
  run.hit = (target, type, amount = 20) => run.apply({ command_type: 'ApplyDamage', actor_id: heroes[1].id, target_id: target, amount, damage_type: type, ruling_id: 'test-items-damage' })
    .events.find((event) => event.event_type === 'DamageApplied').payload
  return run
}

test('предметы сценария — свой каталог: SRD-каталог не меняется, поиск видит обе записи', () => {
  assert.equal(Object.keys(ITEM_CATALOG).length, 145)
  assert.equal(ITEM_CATALOG[TEAR], undefined)
  assert.equal(catalogItem(TEAR).name, 'Слеза Проклятого Рыцаря')
  assert.equal(catalogItem(WARD).name, 'Оберег Ломара')
  for (const entry of Object.values(SCENARIO_ITEM_CATALOG)) {
    assert.deepEqual(Object.values(entry.availability), [false, false, false, false], 'не продаются и не выпадают')
    assert.equal(entry.mechanics_status, 'verified')
  }
})

test('Слеза: надетая — сопротивление холоду; щит — 50 временных хитов раз в сутки, на рассвете снова', async () => {
  const run = await campaign()
  const tearId = run.give(TEAR)
  assert.equal(run.hit(heroes[0].id, 'cold').applied_amount, 20, 'без ношения сопротивления нет')
  run.apply({ command_type: 'EquipItem', actor_id: heroes[0].id, item_id: tearId, equipped: true }, run.player())
  assert.equal(run.hit(heroes[0].id, 'cold').applied_amount, 10)

  assert.throws(() => run.apply({ command_type: 'UseItem', actor_id: heroes[0].id, item_id: tearId, target_id: heroes[1].id }, run.player()), { code: 'INVALID_ITEM_TARGET' })
  const shield = run.apply({ command_type: 'UseItem', actor_id: heroes[0].id, item_id: tearId, target_id: heroes[0].id }, run.player())
  const granted = shield.events.find((event) => event.event_type === 'TemporaryHitPointsGranted')
  assert.equal(granted.payload.temporary_hp_after, 50)
  assert.equal(run.state.mechanics.temporary_hp[heroes[0].id], 50)
  assert.throws(() => run.apply({ command_type: 'UseItem', actor_id: heroes[0].id, item_id: tearId, target_id: heroes[0].id }, run.player()), { code: 'ITEM_CHARGES_EXHAUSTED' })

  run.apply({ command_type: 'AdvanceTime', amount: 24 * 60, unit: 'minute' })
  const tear = run.hero().inventory.find((item) => item.id === tearId)
  assert.equal(tear.charges.current, 1, 'рассвет вернул заряд')
  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.players.find((player) => player.id === heroes[0].id).inventory.find((item) => item.id === tearId), tear)
})

test('«Хрупкая Чешуя» снимает с дракона иммунитет к огню на минуту — только с него и только в бою', async () => {
  const run = await campaign()
  await run.travel('astohan-obsidian-pass')
  await run.travel('astohan-vulkanis-brazier')
  const tearId = run.give(TEAR)
  run.apply({ command_type: 'EquipItem', actor_id: heroes[0].id, item_id: tearId, equipped: true }, run.player())
  assert.throws(() => run.apply({ command_type: 'UseItem', actor_id: heroes[0].id, item_id: tearId, target_id: 'astohan-sargat' }, run.player()))
  run.apply({ command_type: 'CreateEncounter', npc_id: 'astohan-sargat', difficulty: 'deadly', seed: 'items-dragon' }, { isDirector: true })
  run.apply({ command_type: 'StartCombat', server_authoritative: true }, { isDirector: true })
  assert.equal(run.hit('astohan-sargat', 'fire').applied_amount, 0, 'до Чешуи огонь не берёт дракона')

  // Подготовка сцены, а не проверяемое правило: ход героя и дракон рядом.
  const ready = structuredClone(run.state)
  const order = ready.mechanics.combat.initiative.findIndex((entry) => String(entry.actor_id) === heroes[0].id)
  ready.mechanics.combat.active_index = order
  const dragonAt = ready.mechanics.positions['astohan-sargat'] ?? ready.enemies.find((enemy) => enemy.id === 'astohan-sargat')
  ready.mechanics.positions[heroes[0].id] = { x: Number(dragonAt.x) - 3, y: Number(dragonAt.y) }
  run.state = normalizeCampaignState(ready)

  const scale = run.apply({ command_type: 'UseItem', actor_id: heroes[0].id, item_id: tearId, target_id: 'astohan-sargat' }, run.player())
  const condition = scale.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'fragile-scale')
  assert.ok(condition)
  assert.equal(condition.payload.duration, 'rounds:10')
  assert.ok(run.hit('astohan-sargat', 'fire').applied_amount > 0, 'огонь проходит сквозь треснувшую чешую')
})

test('оберег Ломара: лежит на его столе — находка тайны даёт его; сожжённый, даёт отряду сопротивление огню', async () => {
  const run = await campaign()
  await run.travel('astohan-redstone')
  await run.travel('astohan-lomar-tower')
  const scenario = campaignScenario(run.state)
  const secretId = scenarioClueFactId(scenario, 'tower-fire-ward')
  const secret = run.state.worldMemory.facts.find((fact) => fact.id === secretId)
  assert.ok(secret)
  const find = () => run.apply({ command_type: 'RecordWorldFact', actor_id: heroes[1].id, fact: {
    id: `fact-found-ward-${run.step}`, subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
    summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secretId,
  } })
  const found = find()
  const granted = found.events.find((event) => event.event_type === 'ItemGranted')
  assert.equal(granted?.payload.item.catalog_id, WARD)
  assert.throws(() => find(), { code: 'WORLD_FACT_NOT_FOUND' }, 'найденную тайну второй раз не найти — оберег не удваивается')

  const holder = run.state.players.find((player) => player.inventory.some((item) => item.catalog_id === WARD))
  const wardId = holder.inventory.find((item) => item.catalog_id === WARD).id
  run.apply({ command_type: 'UseItem', actor_id: holder.id, item_id: wardId, target_id: holder.id }, run.player(holder.id))
  for (const hero of heroes) {
    assert.ok((run.state.mechanics.conditions[hero.id] ?? []).some((entry) => entry.id === 'lomar-ward'), hero.id)
    assert.equal(run.hit(hero.id, 'fire').applied_amount, 10, `${hero.id}: огонь вполовину`)
  }
  assert.equal(run.state.players.find((player) => player.id === holder.id).inventory.some((item) => item.id === wardId), false, 'оберег сгорел')
})

test('мирно упокоенный рыцарь отдаёт Слезу каталога — с её свойствами', () => {
  const tear = materializeCatalogItem(TEAR, {})
  assert.deepEqual(tear.passive_effects?.[0]?.damage_resistances, ['cold'])
  assert.deepEqual(tear.charges, { current: 1, max: 1 })
})

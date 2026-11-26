import assert from 'node:assert/strict'
import test from 'node:test'

import { astohanPilotBuildCatalog, stagedCommandsForPilotBuild } from '../server/astohan-pilot-builds.mjs'
import { experienceForLevel } from '../server/character-lifecycle.mjs'
import { pilotImportDocument } from './kit/astohan-pilot.mjs'
import { addPlayer, createCampaign, expectStatus, registerUser, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const RULESET = 'dnd_5e_2014'
const PILOT = 'PILOT-HTTP'
const ADVANCE = 'PILOT-LEVELS'

test('пилотные листы 7–10-го уровня, Ярость и Безрассудная атака работают через HTTP', { timeout: runnerTimeout(120_000) }, async (t) => {
  const server = await startTestServer(t, { dice: { format: 'skazanie.test-dice/1', rules: [{ sides: 20, value: 14 }, { value: 'min' }] } })
  const { client: admin } = await setupAdmin(server)
  const { client: owner } = await registerUser(server)
  const { builds, target_level: startLevel } = astohanPilotBuildCatalog()
  const catalog = expectStatus(await owner.get(`/api/rulesets/${RULESET}/character-creation`))
  await createCampaign(owner, { code: PILOT, bootstrap: {
    worldTemplateId: 'astohan-plains', campaignMode: 'adventure', rulesetId: RULESET, startLevel, slotCount: builds.length,
  } })
  const view = async (client, code, actorId) => expectStatus(await client.get(`/api/rooms/${code}`)).state.players.find((entry) => entry.id === actorId)
  for (const [index, recipe] of builds.entries()) {
    const actorId = `hero-slot-${index + 1}`
    const player = index === 0 ? owner : (await addPlayer(server, owner, PILOT, { heroIds: [actorId] })).client
    const document = pilotImportDocument(catalog, recipe, `Герой ${index + 1}`)
    expectStatus(await sendCommand(player, PILOT, `pilot-import-${actorId}`, { command_type: 'ImportCharacter', actor_id: actorId, document }))
    for (const [step, command] of stagedCommandsForPilotBuild(recipe, actorId).entries()) {
      expectStatus(await sendCommand(player, PILOT, `pilot-${actorId}-${step}`, command))
    }
    const hero = await view(player, PILOT, actorId)
    assert.equal(hero.characterClass, recipe.class)
    assert.equal(hero.level, startLevel)
    assert.equal(hero.characterSetupRequired, false)
    const actions = new Map(hero.combatActions.map((action) => [action.id, action]))
    for (const id of recipe.exposed_actions) assert.equal(actions.get(id)?.mechanicsSupport, 'verified', `${recipe.id}/${id}`)
    const early = await sendCommand(player, PILOT, `early-${actorId}`, { command_type: 'LevelUp', actor_id: actorId, expected_level: startLevel })
    assert.equal(early.body?.code, 'LEVEL_UP_PROGRESSION_REQUIRED')
  }

  const { state: prepared } = await readJournal(server, PILOT)
  // Подготовка высокой награды тестовой кампании. Сами повышения и выбор
  // характеристики проходят через тот же маршрут, что в обычной игре.
  await createCampaign(admin, { code: ADVANCE, state: {
    ruleset_id: RULESET, character_start_level: startLevel, activePlayerId: 'hero-slot-1', partyMemberIds: prepared.partyMemberIds,
    players: prepared.players.map((hero) => ({ ...hero, experience: experienceForLevel(10) })),
  } })
  for (const [index, recipe] of builds.entries()) {
    const actorId = `hero-slot-${index + 1}`
    const { client: player } = await addPlayer(server, admin, ADVANCE, { heroIds: [actorId] })
    const before = await view(player, ADVANCE, actorId)
    const ability = { fighter: 'con', monk: 'dex' }[recipe.class] ?? 'str'
    for (let level = startLevel; level < 10; level += 1) {
      const command = { command_type: 'LevelUp', actor_id: actorId, expected_level: level }
      const key = `level-${actorId}-${level}`
      const raised = expectStatus(await sendCommand(player, ADVANCE, key, command))
      assert.equal((await view(player, ADVANCE, actorId)).level, level + 1)
      if (level === startLevel) {
        const retry = expectStatus(await sendCommand(player, ADVANCE, key, command))
        assert.equal(retry.idempotent_replay, true)
        assert.equal(retry.state_version, raised.state_version)
        expectStatus(await sendCommand(player, ADVANCE, `asi-${actorId}`, {
          command_type: 'SetCharacterChoices', actor_id: actorId, subclass: recipe.subclass,
          class_skill_proficiencies: recipe.class_skills, selected_feature_ids: recipe.features,
          ability_score_level: 8, ability_score_increases: [ability],
        }))
      }
    }
    const hero = await view(player, ADVANCE, actorId)
    assert.equal(hero.abilities[ability], Math.min(20, before.abilities[ability] + 2), recipe.id)
    assert.ok(hero.maxHp > before.maxHp, recipe.id)
  }
  await server.restart()
  const loaded = expectStatus(await admin.get(`/api/rooms/${ADVANCE}`)).state
  assert.deepEqual(loaded.players.map((hero) => hero.level), [10, 10, 10, 10])

  const barbarian = prepared.players.find((hero) => hero.characterClass === 'barbarian')
  const actorId = barbarian.id
  const axe = barbarian.inventory.find((item) => /greataxe$/u.test(item.catalog_id ?? item.catalogId ?? ''))
  assert.ok(axe)
  const dexWeapon = { id: 'dex-weapon', name: 'Клинок', type: 'weapon', quantity: 1, equipped: true,
    combat: { kind: 'melee', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 5 },
  }
  const duel = 'PILOT-BARBARIAN'
  await createCampaign(admin, { code: duel, state: {
    ruleset_id: RULESET, character_start_level: startLevel, activePlayerId: actorId, partyMemberIds: [actorId],
    players: [{ ...barbarian, x: 0, y: 0, inventory: [{ ...axe, equipped: true }, dexWeapon] }],
    enemies: [{ id: 'target', name: 'Противник', x: 1, y: 0, hp: 40, maxHp: 40, armor: 10, alive: true }],
    scene: { turn: 1, cells: [0, 1].map((x) => ({ x, y: 0, type: 'floor', revealed: true })) },
    mechanics: { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: actorId }, { actor_id: 'target' }],
      action_economy: { [actorId]: { action: true, bonus_action: true } },
    } },
  } })
  const { client: player } = await addPlayer(server, admin, duel, { heroIds: [actorId] })
  const readBattle = async () => expectStatus(await player.get(`/api/rooms/${duel}`)).state
  const before = await readBattle()
  const action = (id) => before.players[0].combatActions.find((entry) => entry.id === id)
  const use = (id) => sendCommand(player, duel, id, { command_type: 'UseCombatAction', actor_id: actorId, action_id: id })
  for (const [id, condition] of [['rage', 'raging'], ['reckless-attack', 'reckless']]) {
    assert.ok(action(id), id)
    const result = expectStatus(await use(id))
    assert.ok(result.mechanics.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === condition))
  }
  const ready = await readBattle()
  assert.equal(ready.mechanics.resources[actorId].rage.current, before.mechanics.resources[actorId].rage.current - 1)
  const forecast = (itemId) => ready.combatForecast.targets.target.find((entry) => entry.item_id === itemId)
  assert.ok(forecast(axe.id).advantage_sources.includes('безрассудная атака'))
  assert.ok(!forecast(dexWeapon.id).advantage_sources.includes('безрассудная атака'))
  for (const [item, mode, rageBonus] of [[axe, 'advantage', 2], [dexWeapon, 'normal', 0]]) {
    const result = expectStatus(await sendCommand(player, duel, `attack-${item.id}`, {
      command_type: 'MakeAttack', actor_id: actorId, target_id: 'target', item_id: item.id,
    }))
    const events = result.mechanics
    assert.equal(events.find((event) => event.event_type === 'AttackResolved')?.payload.mode, mode)
    const rolled = events.find((event) => event.event_type === 'DieRolled' && event.payload.purpose === 'damage')?.payload.total
    assert.equal(events.find((event) => event.event_type === 'DamageApplied')?.payload.applied_amount, rolled + rageBonus)
  }
})

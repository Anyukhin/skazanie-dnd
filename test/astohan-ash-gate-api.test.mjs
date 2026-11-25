import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignScenario, scenarioClueFactId } from '../server/campaign-scenario.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { fixedDice } from './kit/dice.mjs'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CODE = 'ASTOHAN-ASH-GATE'
const LOCATION = 'astohan-ash-watch'
const ACTION = 'Лада осматривает распахнутые ворота и выжженную землю у входа. Ищу следы, по которым можно понять, кто открыл ворота перед пожаром.'

test('осмотр ворот 15 против СЛ 15 засчитывает авторскую улику обоим игрокам ровно один раз', { timeout: runnerTimeout(90_000) }, async (t) => {
  const players = [
    { id: 'lada', character: 'Лада', characterClass: 'barbarian', level: 7, hp: 68, maxHp: 68, abilities: { str: 16, dex: 14, con: 15, int: 9, wis: 12, cha: 11 }, classSkillProficiencies: ['athletics', 'perception'], inventory: [] },
    { id: 'gleb', character: 'Глеб', characterClass: 'fighter', level: 7, hp: 60, maxHp: 60, inventory: [] },
  ]
  const opening = await new CampaignBootstrapper().create({
    code: CODE, worldTemplateId: 'astohan-plains', campaignMode: 'adventure', rulesetId: 'dnd_5e_2014', players,
  })
  const { sceneArgs } = await new SceneArchitectAgent().plan({ state: opening, decision: 'Идём к заставе', destinationLocationId: LOCATION })
  const state = normalizeCampaignState(resolveCommands([{
    command_type: 'AdvanceScene', command_id: 'arrive-ash-watch', scene_args: sceneArgs,
  }], opening, { diceService: fixedDice(10), context: { isAdmin: true } }).state)
  assert.equal(state.scene.location_id, LOCATION)
  const gateFact = scenarioClueFactId(campaignScenario(state), 'ash-gate')
  const report = state.worldMemory.facts.find((fact) => /В донесении о Пепельной заставе сказано/u.test(fact.summary))
  assert.equal(report?.status, 'active', 'донесение Ивары ещё спрятано в Штормберге')
  assert.equal(report.visibility, 'gm_only')
  const chapterId = `quest:chapter:${state.adventure.chapter}`
  const investigationId = state.worldMemory.quests.find((quest) => quest.clock.label === 'Прогресс расследования')?.id
  assert.ok(investigationId)

  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-ash-gate-api-',
    dice: { format: 'skazanie.test-dice/1', rules: [{ sides: 20, value: 11 }, { value: 'min' }] },
  })
  const { client: owner } = await setupAdmin(server)
  await createCampaign(owner, { code: CODE, state: {
    sessionCode: CODE, partyMemberIds: state.partyMemberIds, players: state.players,
    activePlayerId: 'lada', ruleset_id: state.ruleset_id, ruleset_version: state.ruleset_version,
    enabled_rule_packs: state.enabled_rule_packs, campaignConcept: state.campaignConcept,
    adventure: state.adventure, worldMemory: state.worldMemory,
    scene: { location_id: LOCATION, location: state.scene.location, objective: state.scene.objective, title: state.scene.title, cells: [] },
  } })
  const { client: lada } = await addPlayer(server, owner, CODE, { heroIds: ['lada'], email: 'ash-gate-lada@example.test', name: 'Лада' })
  const { client: gleb } = await addPlayer(server, owner, CODE, { heroIds: ['gleb'], email: 'ash-gate-gleb@example.test', name: 'Глеб' })
  async function assertProgress(client, current) {
    const { state: view } = expectStatus(await client.get(`/api/rooms/${CODE}`))
    const clock = (id) => view.worldMemory.quests.find((quest) => quest.id === id)?.clock
    assert.deepEqual([clock(chapterId)?.current, clock(chapterId)?.max], [current, 2])
    assert.deepEqual([clock(investigationId)?.current, clock(investigationId)?.max], [current, 6])
    if (current) {
      assert.match(view.scene.objective, /Митглайд/u)
      assert.match(view.worldMemory.quests.find((quest) => quest.id === chapterId).objectives.join(' '), /Митглайд/u)
    }
  }
  await assertProgress(lada, 0)
  await assertProgress(gleb, 0)
  const narrate = (key, options) => lada.post('/api/narrate', {
    campaignId: CODE, actor_id: 'lada', action: ACTION, idempotency_key: key, ...options,
  })
  const offer = expectStatus(await narrate('gate-offer', { manual_roll: true }))
  assert.ok(offer.check?.check_id)
  assert.equal(offer.check.difficulty, 15)
  assert.equal(offer.check.modifier, 4)
  const roll = expectStatus(await lada.post('/api/roll', { campaignId: CODE, playerId: 'lada', checkId: offer.check.check_id }))
  const sameRoll = { roll: { roll_id: roll.roll_id } }
  const result = expectStatus(await narrate('gate-resolve', sameRoll))
  const check = result.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(check?.payload.total, 15)
  assert.equal(check?.payload.success, true)
  assert.equal(result.mechanics.find((event) => event.event_type === 'WorldFactRecorded')?.payload.fact.supersedes_fact_id, gateFact)
  await assertProgress(lada, 1)
  await assertProgress(gleb, 1)

  const retried = expectStatus(await narrate('gate-resolve', sameRoll))
  assert.equal(retried.idempotent_replay, true)
  const { events } = await readJournal(server, CODE)
  assert.equal(events.filter((event) => event.event_type === 'QuestClockAdvanced').length, 2)
  assert.equal(events.filter((event) => event.event_type === 'WorldFactRecorded' && event.payload.fact.supersedes_fact_id === gateFact).length, 1)
  await server.restart()
  await assertProgress(lada, 1)
  await assertProgress(gleb, 1)
})

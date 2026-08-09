import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { NpcSocialController } from '../server/npc-social-controller.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import {
  DEED_LOCAL_DELAY_MINUTES,
  RUMOR_HOP_MINUTES,
  planWorldRumorReputation,
  planWorldRumorTick,
  rumorClaimId,
  rumorSpreadTargets,
  worldDeedsFeed,
} from '../server/world-deeds.mjs'

const VILLAGE = 'Тихий Брод'
const MILL = 'Мельница'
const CAPITAL = 'Столица'
const EDGE = 'Край света'

function dice() {
  return new DiceService({ rng: new SequenceDiceRng([]) })
}

/**
 * Граф мира собирается явно: узлы расставлены на одной прямой с равным шагом,
 * поэтому достроенные `world-map.mjs` резервные маршруты совпадают с заданной
 * цепочкой и не добавляют лишних рёбер.
 */
function worldMap() {
  return {
    seed: 'deeds-seed',
    locations: [
      { id: 'village', name: VILLAGE, kind: 'village', x: 100, y: 300 },
      { id: 'mill', name: MILL, kind: 'landmark', x: 300, y: 300 },
      { id: 'capital', name: CAPITAL, kind: 'city', x: 500, y: 300 },
      { id: 'edge', name: EDGE, kind: 'wilds', x: 700, y: 300 },
    ],
    routes: [
      { id: 'r1', from: 'village', to: 'mill', kind: 'road' },
      { id: 'r2', from: 'mill', to: 'capital', kind: 'road' },
      { id: 'r3', from: 'capital', to: 'edge', kind: 'road' },
    ],
  }
}

function npc(id, name, location, faction) {
  return {
    id, name, role: 'житель', location, visibility: 'party',
    public_summary: `${name} живёт в месте «${location}».`,
    tags: [`faction:${faction}`],
  }
}

function campaign({ npcs = [], minutes = 0 } = {}) {
  return normalizeCampaignState({
    sessionCode: 'DEEDS',
    campaign: 'Свидетели и слухи',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: { title: 'Площадь', location: VILLAGE, location_id: 'village', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    worldMap: worldMap(),
    social: { npcs },
    mechanics: { world_time: { elapsed_minutes: minutes } },
  })
}

function deathEvent({ id = 'evt-death', commandId = 'cmd-death' } = {}) {
  return {
    event_id: id,
    command_id: commandId,
    event_type: 'NpcDied',
    actor_id: 'hero',
    target_ids: ['guard'],
    payload: { npc_id: 'guard', npc_name: 'Страж Бран', location_id: 'village', source_actor_id: 'hero', trigger: 'server-collateral' },
    visibility: 'party',
  }
}

function witnessedCampaign(minutes = 0) {
  return campaign({
    minutes,
    npcs: [
      npc('guard', 'Страж Бран', VILLAGE, 'brod-watch'),
      npc('baker', 'Пекарь Мила', VILLAGE, 'brod-guild'),
      npc('miller', 'Мельник Ждан', MILL, 'mill-folk'),
      npc('clerk', 'Писец Ольд', CAPITAL, 'crown'),
      npc('hermit', 'Отшельник', EDGE, 'wilds-folk'),
    ],
  })
}

test('поступок без свидетелей остаётся тайной и слуха не рождает', () => {
  const state = applyGameEvent(campaign({ npcs: [npc('guard', 'Страж Бран', VILLAGE, 'brod-watch')] }), deathEvent())
  const [deed] = state.world_deeds.deeds
  assert.equal(state.world_deeds.deeds.length, 1)
  assert.equal(deed.kind, 'murder')
  assert.equal(deed.severity, 'grave')
  assert.equal(deed.location_name, VILLAGE)
  // Единственный живой NPC сцены — сама жертва, и свидетелем она быть не может.
  assert.deepEqual(deed.witness_ids, [])
  assert.equal(deed.secret, true)
  assert.deepEqual(rumorSpreadTargets(state, { worldMinute: 100_000 }), [])
})

test('свидетель рождает слух только через положенные игровые часы', () => {
  const state = applyGameEvent(witnessedCampaign(), deathEvent())
  const [deed] = state.world_deeds.deeds
  assert.deepEqual(deed.witness_ids, ['baker'])
  assert.equal(deed.secret, false)
  assert.equal(deed.spread_at_minutes, DEED_LOCAL_DELAY_MINUTES.grave)

  assert.deepEqual(rumorSpreadTargets(state, { worldMinute: DEED_LOCAL_DELAY_MINUTES.grave - 1 }), [])
  const local = rumorSpreadTargets(state, { worldMinute: DEED_LOCAL_DELAY_MINUTES.grave })
  assert.deepEqual(local.map((target) => target.npc_id), ['baker'])
  assert.equal(local[0].hop, 0)
})

test('слух расползается по графу мира: сутки на локацию, дальше двух шагов не уходит', () => {
  const state = applyGameEvent(witnessedCampaign(), deathEvent())
  const born = DEED_LOCAL_DELAY_MINUTES.grave
  const at = (minute) => rumorSpreadTargets(state, { worldMinute: minute })
    .map((target) => `${target.npc_id}@${target.hop}`)
    .sort()

  assert.deepEqual(at(born), ['baker@0'])
  assert.deepEqual(at(born + RUMOR_HOP_MINUTES), ['baker@0', 'miller@1'])
  assert.deepEqual(at(born + RUMOR_HOP_MINUTES * 2), ['baker@0', 'clerk@2', 'miller@1'])
  // Отшельник живёт в трёх шагах от места: до него молва не доходит никогда.
  assert.deepEqual(at(born + RUMOR_HOP_MINUTES * 20), ['baker@0', 'clerk@2', 'miller@1'])
})

test('пересказ искажает: три ступени точности по дальности', () => {
  const state = applyGameEvent(witnessedCampaign(), deathEvent())
  const targets = rumorSpreadTargets(state, { worldMinute: DEED_LOCAL_DELAY_MINUTES.grave + RUMOR_HOP_MINUTES * 2 })
  const byHop = new Map(targets.map((target) => [target.hop, target.claim]))
  assert.equal(byHop.size, 3)
  assert.match(byHop.get(0), /Страж Бран/u)
  assert.match(byHop.get(0), /Ада/u)
  // Первый пересказ теряет имена, второй — раздувает произошедшее.
  assert.doesNotMatch(byHop.get(1), /Страж Бран|Ада/u)
  assert.doesNotMatch(byHop.get(2), /Страж Бран|Ада/u)
  assert.notEqual(byHop.get(1), byHop.get(2))
  assert.match(byHop.get(2), /резн/iu)
})

/** Прогоняет такт молвы через настоящие команды движка и возвращает состояние. */
function runRumorTick(state, worldMinute) {
  const { commands } = planWorldRumorTick(state, { worldMinute })
  if (!commands.length) return { state, events: [] }
  const resolved = resolveCommands(
    commands.map((command, index) => ({ ...command, command_id: `rumor-tick:${worldMinute}:${index + 1}` })),
    state,
    { diceService: dice(), context: { isDirector: true } },
  )
  let next = state
  const events = []
  for (const [index, event] of resolved.events.entries()) {
    const stamped = { ...event, event_id: `rumor-event:${worldMinute}:${index + 1}` }
    events.push(stamped)
    next = applyGameEvent(next, stamped)
  }
  return { state: next, events }
}

test('такт молвы пишет факт поступка и слухи как обычные команды памяти мира', () => {
  const start = applyGameEvent(witnessedCampaign(), deathEvent())
  const { state, events } = runRumorTick(start, DEED_LOCAL_DELAY_MINUTES.grave + RUMOR_HOP_MINUTES)
  assert.ok(events.some((event) => event.event_type === 'WorldFactRecorded'))
  const rumors = state.worldMemory.epistemic_claims.filter((claim) => claim.kind === 'rumor')
  assert.deepEqual(rumors.map((claim) => claim.holder_entity_id).sort(), ['baker', 'miller'])
  for (const rumor of rumors) assert.equal(rumor.visibility, 'gm_only')
  // Прямой свидетель видел сам: его слух подтверждён провенансом поступка.
  assert.equal(rumors.find((claim) => claim.holder_entity_id === 'baker').truth_status, 'confirmed')
  assert.equal(rumors.find((claim) => claim.holder_entity_id === 'miller').truth_status, 'unknown')

  const deedFact = state.worldMemory.facts.find((fact) => fact.predicate === 'party_deed')
  assert.ok(deedFact)
  assert.equal(deedFact.visibility, 'gm_only')
  assert.equal(JSON.parse(deedFact.object).kind, 'murder')

  // Повтор такта на том же времени ничего не добавляет: идемпотентность живёт
  // в детерминированных идентификаторах слуха и факта.
  const repeat = planWorldRumorTick(state, { worldMinute: DEED_LOCAL_DELAY_MINUTES.grave + RUMOR_HOP_MINUTES })
  assert.deepEqual(repeat.commands, [])
})

test('дошедший слух двигает репутацию фракций один раз и по дальности', () => {
  const start = applyGameEvent(witnessedCampaign(), deathEvent())
  const spread = runRumorTick(start, DEED_LOCAL_DELAY_MINUTES.grave + RUMOR_HOP_MINUTES)
  const reputation = planWorldRumorReputation(spread.state)
  const byFaction = new Map(reputation.map((event) => [event.payload.faction_id, event.payload.delta]))
  assert.deepEqual([...byFaction.keys()].sort(), ['brod-guild', 'mill-folk'])
  // Тяжкий поступок у прямого свидетеля стоит полной поправки, пересказ — половины.
  assert.equal(byFaction.get('brod-guild'), -8)
  assert.equal(byFaction.get('mill-folk'), -4)
  for (const event of reputation) assert.equal(event.visibility, 'gm_only')

  let state = spread.state
  for (const [index, event] of reputation.entries()) {
    state = applyGameEvent(state, { ...event, event_id: `rep-event:${index + 1}`, command_id: 'rep-tick' })
  }
  assert.equal(state.autonomy.reputations['brod-guild'], -8)
  assert.deepEqual(planWorldRumorReputation(state), [])
  assert.deepEqual(state.world_deeds.deeds[0].reputation_faction_ids, ['brod-guild', 'mill-folk'])
})

test('доброе дело поднимает репутацию тем же механизмом', () => {
  const helpful = {
    event_id: 'evt-rescue',
    command_id: 'cmd-rescue',
    event_type: 'WitnessConsequencePropagated',
    target_ids: ['baker'],
    payload: { outcome: 'helpful', severity: 'major', witness_ids: ['baker'], faction_ids: ['brod-guild'] },
    visibility: 'party',
  }
  const start = applyGameEvent(witnessedCampaign(), helpful)
  const [deed] = start.world_deeds.deeds
  assert.equal(deed.kind, 'rescue')
  assert.equal(deed.alignment, 'bright')
  const spread = runRumorTick(start, DEED_LOCAL_DELAY_MINUTES.major)
  const reputation = planWorldRumorReputation(spread.state)
  // Молва рождается на месте: её слышат все живые жители локации, а не только
  // прямые свидетели, — поэтому фракций две.
  assert.deepEqual(reputation.map((event) => event.payload.faction_id).sort(), ['brod-guild', 'brod-watch'])
  for (const event of reputation) assert.equal(event.payload.delta, 5)
})

test('поджог и погром обстановки распознаются как разные поступки', () => {
  const operate = (intent, id) => ({
    event_id: `evt-${id}`,
    command_id: `cmd-${id}`,
    event_type: 'SceneObjectOperated',
    actor_id: 'hero',
    target_ids: [],
    payload: { prop_id: `prop-${id}`, kind: 'furnishing', intent },
    visibility: 'public',
  })
  let state = witnessedCampaign()
  state = applyGameEvent(state, operate('ignite', 'fire'))
  state = applyGameEvent(state, operate('topple', 'crash'))
  assert.deepEqual(state.world_deeds.deeds.map((deed) => deed.kind), ['arson', 'vandalism'])
  assert.deepEqual(state.world_deeds.deeds.map((deed) => deed.severity), ['major', 'minor'])
  for (const deed of state.world_deeds.deeds) assert.deepEqual(deed.witness_ids, ['baker', 'guard'])
})

test('взятое из чужого сундука без единого живого NPC поступком не считается', () => {
  const take = {
    event_id: 'evt-take',
    command_id: 'cmd-take',
    event_type: 'SceneObjectOperated',
    actor_id: 'hero',
    target_ids: [],
    payload: { prop_id: 'prop-chest', kind: 'container', intent: 'take' },
    visibility: 'public',
  }
  assert.deepEqual(applyGameEvent(campaign(), take).world_deeds.deeds, [])
  const seen = applyGameEvent(witnessedCampaign(), take).world_deeds.deeds
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'theft')
})

test('летопись поступков переживает replay и не удваивается', () => {
  const events = [deathEvent(), deathEvent({ id: 'evt-death-replay', commandId: 'cmd-death' })]
  const once = applyGameEvent(witnessedCampaign(), events[0])
  const replayed = replayEvents(witnessedCampaign(), events)
  assert.deepEqual(replayed.world_deeds.deeds.map((deed) => deed.id), once.world_deeds.deeds.map((deed) => deed.id))
  assert.equal(replayed.world_deeds.deeds.length, 1)
  assert.deepEqual(replayed.world_deeds, once.world_deeds)
})

test('летопись и слухи принадлежат ведущему и не текут игроку', () => {
  const start = applyGameEvent(witnessedCampaign(), deathEvent())
  const { state } = runRumorTick(start, DEED_LOCAL_DELAY_MINUTES.grave)
  const player = campaignStateForViewer(state, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')
  assert.equal(player.world_deeds, undefined)
  assert.deepEqual(player.worldMemory.epistemic_claims ?? [], [])
  assert.equal((player.worldMemory.facts ?? []).some((fact) => fact.predicate === 'party_deed'), false)

  const admin = campaignStateForViewer(state, { id: 'user-2', role: 'admin', heroIds: [] }, '')
  assert.equal(admin.world_deeds.deeds.length, 1)
  assert.equal(admin.worldMemory.epistemic_claims.length, 1)
  const feed = worldDeedsFeed(admin)
  assert.equal(feed[0].label, 'Убийство')
  assert.equal(feed[0].witness_count, 1)
})

test('дошедший слух попадает в разговор своего NPC', async () => {
  const start = applyGameEvent(witnessedCampaign(), deathEvent())
  const { state } = runRumorTick(start, DEED_LOCAL_DELAY_MINUTES.grave + RUMOR_HOP_MINUTES)
  const controller = new NpcSocialController()
  const reply = await controller.respond({ state, playerId: 'hero', npcId: 'miller', message: 'Что слышно нового?', turnId: 'turn-1' })
  assert.ok(reply)
  const claimId = rumorClaimId(state.world_deeds.deeds[0], 'miller')
  // Контроллер отдаёт NPC ровно его собственные утверждения — и слух в их числе.
  const conversationClaims = state.worldMemory.epistemic_claims.filter((claim) => claim.holder_entity_id === 'miller')
  assert.deepEqual(conversationClaims.map((claim) => claim.id), [claimId])
  assert.equal(reply.provider, 'deterministic-social-fallback')
})

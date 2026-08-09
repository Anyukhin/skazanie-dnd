import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { NpcSocialController } from '../server/npc-social-controller.mjs'
import {
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import {
  DEED_KINDS,
  DEED_LOCAL_DELAY_MINUTES,
  RUMOR_HOP_MINUTES,
  planWorldRumorReputation,
  planWorldRumorTick,
  rumorClaimId,
  rumorSpreadTargets,
  rumorWording,
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

/**
 * Жители той же локации, которых в сцене нет: у них пустая `location`, поэтому
 * `npcNodeIdFor` ставит их в узел текущей сцены (нулевой шаг от места), а
 * `presentSceneNpcs` свидетелями не считает. Ровно эта разница и делает пробу
 * сторожа «без свидетелей молве взяться неоткуда» непустой: прежняя фикстура
 * держала одного NPC, который и был жертвой, и целей не было ни при каком
 * сторо́же.
 */
function bystanders() {
  return [
    { ...npc('gossip', 'Кумушка Веся', VILLAGE, 'brod-guild'), location: '' },
    { ...npc('smith', 'Кузнец Гор', VILLAGE, 'brod-craft'), location: '' },
  ]
}

test('поступок без свидетелей остаётся тайной и слуха не рождает', () => {
  const state = applyGameEvent(campaign({
    npcs: [npc('guard', 'Страж Бран', VILLAGE, 'brod-watch'), ...bystanders()],
  }), deathEvent())
  const [deed] = state.world_deeds.deeds
  assert.equal(state.world_deeds.deeds.length, 1)
  assert.equal(deed.kind, 'murder')
  assert.equal(deed.severity, 'grave')
  assert.equal(deed.location_name, VILLAGE)
  // Единственный живой NPC сцены — сама жертва, и свидетелем она быть не может.
  // Кумушка и кузнец живы и стоят в той же локации, но не в сцене.
  assert.deepEqual(deed.witness_ids, [])
  assert.equal(deed.secret, true)
  assert.deepEqual(rumorSpreadTargets(state, { worldMinute: 100_000 }), [])

  // Положительный контроль к тому же составу: стоит появиться живому свидетелю
  // сцены — и те же самые жители получают слух нулевым шагом. Значит, пустой
  // список выше даёт именно сторож тайны, а не безлюдная фикстура.
  const seen = applyGameEvent(campaign({
    npcs: [npc('guard', 'Страж Бран', VILLAGE, 'brod-watch'), npc('baker', 'Пекарь Мила', VILLAGE, 'brod-guild'), ...bystanders()],
  }), deathEvent())
  assert.equal(seen.world_deeds.deeds[0].secret, false)
  assert.deepEqual(
    rumorSpreadTargets(seen, { worldMinute: 100_000 }).map((target) => `${target.npc_id}@${target.hop}`).sort(),
    ['baker@0', 'gossip@0', 'smith@0'],
  )
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

test('успешная рискованная проверка тёмным поступком не становится', () => {
  // Единственный писатель `scene_change` — `materialConsequenceCommands`
  // (`server/autonomous-orchestrator.mjs`), и он срабатывает на ЛЮБОЙ успешной
  // рискованной проверке. Пока летопись выводила отсюда «разрушение»,
  // обезвреженная ловушка и потушенный пожар роняли славу отряда.
  const sceneChange = {
    event_id: 'evt-scene-change',
    command_id: 'cmd-free-action',
    event_type: 'WorldFactRecorded',
    actor_id: 'hero',
    target_ids: [],
    payload: { fact: {
      id: 'fact-scene-change-trap',
      subject_id: 'location-shrine',
      predicate: 'scene_change',
      object: 'обезвредить ловушку',
      summary: 'обезвредить ловушку: вставить клин в механизм (Площадь)',
      visibility: 'party',
      source_event_ids: ['evt-check'],
    } },
    visibility: 'party',
  }
  assert.deepEqual(applyGameEvent(witnessedCampaign(), sceneChange).world_deeds.deeds, [])
})

test('разрушение — это выломанная на людях дверь, и только она', () => {
  const forced = (success) => ({
    event_id: `evt-door-${success}`,
    command_id: `cmd-door-${success}`,
    event_type: 'DoorForced',
    actor_id: 'hero',
    target_ids: [],
    payload: { door_id: 'door-1', success, previous_state: 'locked', difficulty: 15, check_total: 18 },
    visibility: 'public',
  })
  // Неудачная попытка ничего не сломала; пустое подземелье никого не обидело.
  assert.deepEqual(applyGameEvent(witnessedCampaign(), forced(false)).world_deeds.deeds, [])
  assert.deepEqual(applyGameEvent(campaign(), forced(true)).world_deeds.deeds, [])

  const [deed] = applyGameEvent(witnessedCampaign(), forced(true)).world_deeds.deeds
  assert.equal(deed.kind, 'destruction')
  assert.equal(deed.alignment, 'dark')
  assert.equal(deed.severity, 'major')
  assert.equal(deed.subject, 'дверь')
  assert.deepEqual(deed.witness_ids, ['baker', 'guard'])
  assert.equal(deed.summary, 'Ада: разрушение — дверь (Тихий Брод)')
})

test('подстановка в слух держит именительный падеж и не оставляет заглушек', () => {
  // Имя героя и подпись пропса склонять нечем: в состоянии лежит одна форма.
  // Поэтому фраза обязана ставить подстановку туда, где нужен именительный,
  // иначе NPC произносит игрокам «после Ада» и «огонь по обстановку».
  const preposition = /(?:после|от|для|без|у|про|через|над|перед|с|по|данное|данного|руки)\s+(?:ИМЯГЕРОЯ|НАЗВАНИЕ)/u
  for (const kind of Object.keys(DEED_KINDS)) {
    for (const hop of [0, 1, 2]) {
      const claim = rumorWording({ kind, location_name: VILLAGE, actor_names: ['ИМЯГЕРОЯ'], subject: 'НАЗВАНИЕ' }, hop)
      assert.doesNotMatch(claim, /\{[a-z]+\}/u, `${kind}@${hop}: в слухе осталась заглушка — ${claim}`)
      assert.doesNotMatch(claim, preposition, `${kind}@${hop}: подстановка стоит под предлогом — ${claim}`)
    }
  }
  // Подписи видов обстановки тоже именительные: они уходят в ту же подстановку.
  const arson = { kind: 'arson', location_name: VILLAGE, actor_names: ['Ада'], subject: 'обстановка' }
  assert.equal(rumorWording(arson, 0), 'В «Тихий Брод» был пожар. Горело вот что: обстановка. Свидетели указывают: Ада.')
})

test('новое производное состояние отбрасывает снимки прежней версии проектора', () => {
  // `FileEventStore._readSnapshot` принимает снимок с совпавшей
  // `projector_version` и доигрывает только события после него. Снимки версии 9
  // писались без `world_deeds`, и без бампа поступки до границы снимка не
  // восстановились бы никогда — летопись перестала бы быть функцией журнала.
  assert.ok(GAME_STATE_PROJECTOR_VERSION >= 10,
    'летопись поступков обязана отбросить снимки, записанные без world_deeds')
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

test('одна команда, двое убитых — два поступка, а не один', () => {
  const victim = (npcId, name) => ({
    event_id: `evt-death-${npcId}`,
    command_id: 'cmd-area-spell',
    event_type: 'NpcDied',
    actor_id: 'hero',
    target_ids: [npcId],
    payload: { npc_id: npcId, npc_name: name, location_id: 'village', source_actor_id: 'hero' },
    visibility: 'party',
  })
  const state = replayEvents(witnessedCampaign(), [victim('guard', 'Страж Бран'), victim('baker', 'Пекарь Мила')])
  assert.equal(state.world_deeds.deeds.length, 2)
  assert.deepEqual(state.world_deeds.deeds.map((deed) => deed.subject), ['Страж Бран', 'Пекарь Мила'])
  assert.equal(new Set(state.world_deeds.deeds.map((deed) => deed.id)).size, 2)
  // Свидетели считаются по состоянию после каждого события: первую смерть видела
  // пекарь, вторую — уже некому, и она остаётся тайной.
  assert.deepEqual(state.world_deeds.deeds.map((deed) => deed.witness_ids), [['baker'], []])
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
  const claimId = rumorClaimId(state.world_deeds.deeds[0], 'miller')
  const controller = new NpcSocialController()
  const reply = await controller.respond({ state, playerId: 'hero', npcId: 'miller', message: 'Что слышно нового?', turnId: 'turn-1' })
  assert.ok(reply)
  assert.equal(reply.provider, 'deterministic-social-fallback')

  // Слух пишется `gm_only` и в проекцию игроку не попадает: единственная дорога
  // молвы к столу — реплика держателя. Поэтому проверяется сама реплика, а не
  // только то, что тик записал утверждение.
  assert.deepEqual(reply.disclosed_claim_ids, [claimId])
  const claim = state.worldMemory.epistemic_claims.find((entry) => entry.id === claimId)
  assert.ok(reply.reply.includes(claim.summary || claim.claim), `слух не прозвучал: ${reply.reply}`)
  assert.match(reply.reply, /Мельник Ждан/u)
  // Мельник знает о случившемся с чужих слов: первый пересказ теряет имена.
  assert.doesNotMatch(reply.reply, /Страж Бран|Ада/u)
  assert.equal(reply.conversation.npc_reply, reply.reply)
  assert.deepEqual(reply.conversation.disclosed_claim_ids, [claimId])

  // Отрицательный контроль: до отшельника молва не дошла, и говорить ему нечего.
  const silent = await controller.respond({ state, playerId: 'hero', npcId: 'hermit', message: 'Что слышно нового?', turnId: 'turn-2' })
  assert.deepEqual(silent.disclosed_claim_ids, [])
  assert.match(silent.reply, /не сообщает ничего нового/u)
})

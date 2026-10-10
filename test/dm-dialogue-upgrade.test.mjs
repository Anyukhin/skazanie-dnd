import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { RulesEngine, normalizeCampaignState, applyGameEvent } from '../server/rules-engine.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { ActionAdjudicator } from '../server/action-adjudicator.mjs'
import { IntentParser, inferRequestKind } from '../server/intent-parser.mjs'
import { createTacticalMap, setCell, setDoor, serializeTacticalMap, legacyCellsFromTacticalMap } from '../server/tactical-map.mjs'

async function fixture({ reader = new ActionAdjudicator(), narrator, state: extra = {}, rolls = [18, 18, 18] } = {}) {
  const state = normalizeCampaignState({
    sessionCode: 'DM-UPGRADE', activePlayerId: 'hero', partyMemberIds: ['hero'],
    scene: { title: 'Караульная', location: 'Караульная', objective: 'Найти пропавшего курьера', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 12, maxHp: 12, armor: 14, speed: 30,
      abilities: { str: 14, dex: 14, con: 12, int: 12, wis: 12, cha: 12 },
      currency: { gold: 10 }, inventory: [{ id: 'rope', name: 'Верёвка', quantity: 1 }] }],
    ...extra,
  })
  const eventStore = new FileEventStore({ rootDir: join(mkdtempSync(join(tmpdir(), 'skazanie-dm-upgrade-')), 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: state.sessionCode, initial_state: state })
  const rulesEngine = new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng(rolls) }) })
  const unknownActionHandler = new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, actionAdjudicator: reader })
  const game = new GameOrchestrator({ eventStore, rulesEngine, unknownActionHandler, ...(narrator ? { narrator } : {}) })
  let next = 0
  return { state, game, eventStore, send: async (message, options = {}) => game.handle({ state: (await eventStore.load(state.sessionCode)).state, playerId: 'hero', message, idempotencyKey: `upgrade-${++next}`, ...options }) }
}

test('обычная работа с верёвкой не становится явным запросом проверки Мудрости', async () => {
  const { state } = await fixture()
  const intent = await new IntentParser().parse({ playerId: 'hero', visibleState: state, message: 'Развязываю и заново завязываю верёвку, проверяя прочность узлов перед использованием.' })
  assert.equal(intent.intent, 'improvised_action')
  assert.equal(inferRequestKind('А если вместо камня бросить монету?'), 'question')
})

test('упоминание удара в адресной речи остаётся разговором, а не атакой', async () => {
  const { state } = await fixture({ state: roomWithDoor() })
  const intent = await new IntentParser().parse({ playerId: 'hero', visibleState: state,
    message: 'Говорю Мире: предлагаю условный сигнал — три удара по пустой кружке.' })
  assert.equal(intent.intent, 'social')
  assert.deepEqual(intent.targets, ['mira'])
})

test('прямое обращение по имени выбирает видимого собеседника, а одинаковые имена требуют уточнения', async () => {
  const { state } = await fixture({ state: roomWithDoor() })
  const parser = new IntentParser()
  const message = 'Мира, напомни, какой условный сигнал мы выбрали?'
  const parsed = await parser.parse({ playerId: 'hero', visibleState: state, message })
  assert.equal(parsed.intent, 'social')
  assert.deepEqual(parsed.targets, ['mira'])
  state.social.npcs.push({ ...state.social.npcs[0], id: 'other-mira', name: 'Мира Лесная' })
  const ambiguous = await parser.parse({ playerId: 'hero', visibleState: state, message })
  assert.equal(ambiguous.requires_clarification, true)
  assert.deepEqual(ambiguous.missing_information, ['ambiguous_npc'])
  const hidden = await parser.parse({ playerId: 'hero', visibleState: { ...state, social: { npcs: [] } }, message })
  assert.deepEqual(hidden.targets, [])
  const physical = await parser.parse({ playerId: 'hero', visibleState: state, message: 'Подхожу к Мире, затем открываю дверь' })
  assert.notEqual(physical.intent, 'social')
})

test('безопасная импровизация сохраняет цель и не вызывает модель, даже когда она доступна', async () => {
  let calls = 0
  const reader = new ActionAdjudicator({ llmClient: { completeJson: async () => { calls += 1; throw Error('не нужен') } } })
  const { send, state, eventStore } = await fixture({ reader })
  const response = await send('Подбрасываю монету и ловлю её другой рукой')
  assert.equal(response.free_action_outcome, 'auto_success')
  assert.equal(calls, 0)
  assert.equal(response.effects.roll, null)
  assert.equal(response.authoritative_state.scene.objective, state.scene.objective)
  assert.ok(!response.mechanics.some(event => event.event_type === 'ObjectiveUpdated'))
  const replay = await eventStore.load(state.sessionCode)
  assert.equal(replay.state.scene.objective, state.scene.objective)
})

test('упоминание ворот не создаёт сообщения о воре или другой новой цели', async () => {
  const reader = { read: async (_state, _actor, action) => ({ goal_summary: action, approach_summary: action, ability: 'cha', skill: 'persuasion', plausibility: 'trivial', risk: 'none', required_means: [], effect: 'none', source: 'agent-adjudicator' }) }
  const { send, state } = await fixture({ reader })
  const response = await send('Сравниваю рассказы о Северных воротах')
  assert.equal(response.authoritative_state.scene.objective, state.scene.objective)
  assert.doesNotMatch(response.narration, /сообщени[ея] о воре/u)
})

test('вопрос о способе получает предметное объяснение без событий и броска', async () => {
  const { send, eventStore, state } = await fixture()
  const response = await send('Можно ли отвлечь собеседника стуком по столу?', { requestKind: 'question' })
  assert.match(response.narration, /внимани|отвлеч/u)
  assert.doesNotMatch(response.narration, /точного ответа пока нет/u)
  assert.deepEqual(response.mechanics, [])
  assert.equal(response.effects.roll, null)
  assert.equal((await eventStore.load(state.sessionCode)).state_version, 0)
})

test('тёплая память рассказчика включает только что выполненную свободную импровизацию', async () => {
  const { send, game, state } = await fixture({ narrator: { render: async () => ({ narration: 'Монета снова у вас в ладони.', provider: 'test' }) } })
  const response = await send('Подбрасываю монету и ловлю её другой рукой')
  assert.ok(game.recentNarrationsFor(state.sessionCode).includes(response.narration))
})

test('последовательный план исполняется шаг за шагом без вопроса «выполнить первый шаг?» и повторяется идемпотентно', async () => {
  // Плейтест 2026-10-10: каждый сложный ход получал служебное «В заявке 2
  // последовательных шага… Выполнить первый шаг?». Живой ведущий исполняет
  // сказанное по порядку и останавливается только на броске или неудаче.
  const { send, eventStore, state } = await fixture()
  const versionBefore = (await eventStore.load(state.sessionCode)).state_version
  const planned = await send('Сначала подбрасываю монету и ловлю её другой рукой; затем сматываю верёвку', { idempotencyKey: 'sequence' })
  assert.doesNotMatch(String(planned.narration), /последовательн|Выполнить первый шаг/u)
  assert.equal(planned.free_action_outcome, 'auto_success')
  assert.equal(planned.clarification ?? null, null)
  assert.equal(planned.mechanics.filter(event => event.event_type === 'ActionDeclared').length, 2)
  assert.equal(planned.authoritative_state.scene.objective, state.scene.objective)
  const after = (await eventStore.load(state.sessionCode)).state_version
  assert.ok(after > versionBefore)
  const repeated = await send('Сначала подбрасываю монету и ловлю её другой рукой; затем сматываю верёвку', { idempotencyKey: 'sequence' })
  assert.equal(repeated.mechanics.filter(event => event.event_type === 'ActionDeclared').length, 2)
  assert.equal((await eventStore.load(state.sessionCode)).state_version, after, 'повтор того же запроса не исполняет шаги заново')
})

test('союз перед «потом» не остаётся хвостом первого шага', async () => {
  const { actionSequence } = await import('../server/intent-parser.mjs')
  assert.deepEqual(actionSequence('Подхожу к двери маяка, прислушиваюсь, а потом поднимаюсь по лестнице'), [
    'Подхожу к двери маяка, прислушиваюсь',
    'поднимаюсь по лестнице',
  ])
  assert.deepEqual(actionSequence('Осматриваю следы и потом иду к бочкам'), ['Осматриваю следы', 'иду к бочкам'])
})

function roomWithDoor() {
  const map = createTacticalMap({ width: 6, height: 3, locationId: 'room', seed: 'dialogue-effects' })
  for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
  setDoor(map, { id: 'door', x: 1, y: 1, dir: 'e', state: 'closed' })
  return {
    scene: { title: 'Караульная', location: 'Караульная', location_id: 'room', objective: 'Найти курьера', map: serializeTacticalMap(map), cells: legacyCellsFromTacticalMap(map) },
    players: [{ id: 'hero', character: 'Ада', x: 1, y: 1, hp: 12, maxHp: 12, armor: 14, speed: 30, abilities: { str: 14, dex: 14 }, inventory: [{ id: 'rope', name: 'Верёвка', quantity: 1 }] }],
    social: { npcs: [{ id: 'mira', name: 'Мира Ветрокрыл', role: 'проводница', location: 'Караульная', visibility: 'party', available: true }] },
    npc_world: { schema_version: 3, placements: [{ npc_id: 'mira', location_id: 'room', x: 5, y: 1 }], inventories: {}, vitals: {} },
  }
}

test('открывание и закрывание двери свободным текстом меняют реальную дверь и переживают replay', async () => {
  let reads = 0
  const { send, game, state, eventStore } = await fixture({ state: roomWithDoor(), reader: { read: async () => { reads++; throw Error('стандартная дверь без модели') } } })
  const opened = await send('Открываю дверь ломом', { idempotencyKey: 'open-door' })
  assert.ok(opened.mechanics.some(event => event.event_type === 'DoorStateChanged' && event.payload.state === 'open'))
  const repeated = await send('Открываю дверь ломом', { idempotencyKey: 'open-door' })
  assert.equal(repeated.idempotent_replay, true)
  const closed = await send('Закрываю дверь')
  assert.ok(closed.mechanics.some(event => event.event_type === 'DoorStateChanged' && event.payload.state === 'closed'))
  assert.equal(reads, 0)
  assert.equal((await eventStore.load(state.sessionCode)).state.scene.map.doors[0].state, 'closed')
})

test('подход к NPC и передача своей вещи исполняются реальными командами без модели', async () => {
  const initial = roomWithDoor()
  initial.scene.map.doors[0].state = 'open'
  const { send } = await fixture({ state: initial, reader: { read: async () => { throw Error('стандартная команда без модели') } } })
  const moved = await send('Подхожу к Мире')
  assert.ok(moved.mechanics.some(event => event.event_type === 'ActorMoved'))
  const transferred = await send('Передаю верёвку Мире')
  assert.equal(transferred.free_action_outcome, 'item_transfer')
  assert.equal(transferred.authoritative_state.players[0].inventory.some(item => item.id === 'rope'), false)
  assert.ok(transferred.authoritative_state.npc_world.inventories.mira.length > 0)
})

test('баррикада из своей верёвки подтверждается, блокирует дверь и не расходуется повторно', async () => {
  const { send, state, eventStore } = await fixture({ state: roomWithDoor() })
  const offered = await send('Подпираю дверь верёвкой')
  assert.equal(offered.clarification.confirmation_required, true)
  assert.equal(offered.mechanics.length, 0)
  const options = { requestKind: 'action', clarificationId: offered.clarification.id, idempotencyKey: 'barrier-confirm' }
  const placed = await send('Да', options)
  assert.ok(placed.mechanics.some(event => event.event_type === 'DoorBarricaded'))
  assert.equal(placed.authoritative_state.players[0].inventory.length, 0)
  const replay = await send('Да', options)
  assert.equal(replay.idempotent_replay, true)
  assert.equal((await eventStore.load(state.sessionCode)).state.players[0].inventory.length, 0)
  const blocked = await send('Открываю дверь')
  assert.equal(blocked.free_action_outcome, 'clarification')
  assert.match(blocked.narration, /баррикад/u)
  const cleared = await send('Убираю баррикаду')
  assert.ok(cleared.mechanics.some(event => event.event_type === 'DoorBarricadeCleared'))
  assert.equal(cleared.authoritative_state.scene.map.doors[0].barricade, null)
  assert.equal(cleared.authoritative_state.scene.map.doors[0].state, 'closed')
})

test('ожидание с наблюдением — два шага: время проходит, а что высмотрели, решает судья действий', async () => {
  // Плейтест 2026-10-10: «Ждём темноты и смотрим на вершину маяка — загорится
  // ли огонь?» давало один AdvanceTime и рассказ о сроках заданий вместо ответа.
  const { actionSequence } = await import('../server/intent-parser.mjs')
  assert.deepEqual(actionSequence('Ждём темноты в укрытии и смотрим на вершину маяка — загорится ли огонь?'),
    ['Ждём темноты в укрытии', 'смотрим на вершину маяка — загорится ли огонь?'])
  assert.deepEqual(actionSequence('Смотрим на маяк и ждём'), [], 'без цели ожидания фраза не делится')
  const { send } = await fixture()
  const response = await send('Ждём темноты в укрытии и смотрим на дверь — выйдет ли кто-нибудь?', { idempotencyKey: 'wait-watch' })
  assert.ok(response.mechanics.some(event => event.event_type === 'TimeAdvanced'), 'время прошло')
  assert.ok(response.mechanics.some(event => event.event_type === 'ActionDeclared'), 'наблюдение разобрано как поступок')
  assert.doesNotMatch(response.narration, /Вышло: смотрим|выйдет ли/u, 'вопрос миру не пересказывается как итог')
  assert.match(response.narration, /не сводит глаз|всматривается/u)
})

test('фоновая запись памяти во время разбора не отбрасывает ход, а смена сцены — отбрасывает', async () => {
  // Плейтест 2026-10-10: зацепки из предысторий плелись рядом со вторым шагом
  // плана, и ход получал «Обстановка изменилась… Отправьте его ещё раз».
  const reading = { goal_summary: 'Простучать бочки', approach_summary: 'Простукиваю бочки', ability: 'wis', skill: 'perception', plausibility: 'trivial', risk: 'none', required_means: [], effect: 'none', source: 'agent-adjudicator' }
  const sideEffect = { event: null, store: null, campaignId: '' }
  const reader = {
    llmClient: { completeJson: async () => ({}) },
    read: async () => {
      const current = await sideEffect.store.load(sideEffect.campaignId)
      await sideEffect.store.commit({ campaignId: sideEffect.campaignId, expectedStateVersion: current.state_version, idempotencyKey: `background-${current.state_version}`, events: [sideEffect.event] })
      return reading
    },
  }
  const { send, eventStore, state } = await fixture({ reader })
  Object.assign(sideEffect, { store: eventStore, campaignId: state.sessionCode })
  sideEffect.event = { event_type: 'WorldFactRecorded', visibility: 'gm_only', payload: { fact: {
    id: 'fact:background-hook', subject_id: 'entity:hero', predicate: 'gm_secret', object: '{"topic":"сестра"}',
    summary: 'Фоновая зацепка', visibility: 'gm_only', status: 'active', recorded_at_minutes: 0,
  } } }
  const accepted = await send('Простукиваю бочки у стены')
  assert.doesNotMatch(String(accepted.narration), /Обстановка изменилась/u)
  assert.ok(accepted.mechanics.some(event => event.event_type === 'ActionDeclared'))

  sideEffect.event = { event_type: 'ObjectiveUpdated', visibility: 'party', payload: { objective: 'Новая цель от другого игрока' } }
  const stale = await send('Простукиваю бочки у двери')
  assert.match(String(stale.narration), /Обстановка изменилась/u, 'перемена сцены по-прежнему требует свежего разбора')
})

test('реплика своему спутнику — сцена для рассказчика, а не «стоит расспросить здешних»', async () => {
  // Плейтест 2026-10-10: «…говорит Борину: «Ила любила это море. Я не уйду,
  // пока не узнаю правду»» получало «Мирель старается, но нового это не
  // приносит. Может, кто-то из здешних знает больше».
  const { NpcSocialController } = await import('../server/npc-social-controller.mjs')
  const room = roomWithDoor()
  room.players.push({ id: 'ally', character: 'Борин', x: 2, y: 1, hp: 12, maxHp: 12, armor: 16, speed: 30, abilities: { str: 16 }, inventory: [] })
  const briefs = []
  const narrator = { render: async (brief) => { briefs.push(brief); return { narration: 'Вода у причала тёмная и тихая; ветер уносит слова к маяку.', provider: 'test-llm' } } }
  const base = await fixture({ state: { ...room, partyMemberIds: ['hero', 'ally'] }, narrator })
  base.game.npcSocialController = new NpcSocialController()
  const speech = 'Ада отходит к краю причала и негромко говорит Борину: «Ила любила это море. Я не уйду отсюда, пока не узнаю правду».'
  const spoken = await base.send(speech)
  assert.doesNotMatch(String(spoken.narration), /стоит расспросить|нового это не приносит|Назовите собеседника/u)
  assert.equal(briefs.length, 1, 'на реплику отвечает рассказчик')
  assert.match(spoken.narration, /ветер уносит слова/u)

  const offline = await fixture({ state: { ...roomWithDoor(), players: room.players, partyMemberIds: ['hero', 'ally'] } })
  offline.game.npcSocialController = new NpcSocialController()
  const quiet = await offline.send(speech)
  assert.match(String(quiet.narration), /«Ила любила это море/u, 'без модели ведущий повторяет сказанное')
})

test('прямая проверка навыка получает деталь места от судьи действий при любом исходе', async () => {
  // Замер 2026-10-10: «осматриваю баркас» шло прямой проверкой мимо судьи
  // действий, и за партию не записалось ни одной детали — провал оставался
  // пустым «ничего не заметила».
  const surface = 'Сеть на корме сложена аккуратно, будто её укладывали на берегу.'
  const answer = 'На корме выжжена чайка с перебитым крылом — знак артели Ворониных.'
  let reads = 0
  const reader = {
    llmClient: { completeJson: async () => ({}) },
    read: async () => { reads += 1; return { goal_summary: 'Осмотреть корму', approach_summary: 'Осматриваю', ability: 'wis', skill: 'perception', plausibility: 'plausible', risk: 'none', required_means: [], effect: 'none', source: 'agent-adjudicator', success_detail: answer, surface_detail: surface } },
  }
  const memory = { worldMemory: { entities: [{ id: 'loc:guard', kind: 'location', name: 'Караульная', summary: '', aliases: [], visibility: 'party', tags: [] }], facts: [] } }
  const lucky = await fixture({ reader, state: memory })
  const found = await lucky.send('Осматриваю корму и ищу метку владельца', { idempotencyKey: 'look-lucky' })
  const facts = found.mechanics.filter((event) => event.event_type === 'WorldFactRecorded').map((event) => event.payload.fact.summary)
  assert.ok(facts.includes(answer), `удача — ответ на вопрос: ${JSON.stringify(facts)}`)
  assert.equal(reads, 1)
  await lucky.send('Осматриваю корму и ищу метку владельца', { idempotencyKey: 'look-lucky' })
  assert.equal(reads, 1, 'повтор хода не зовёт судью второй раз')
})

test('проваленная прямая проверка навыка показывает видимую деталь, а не пустое «ничего не заметила»', async () => {
  const surface = 'Сеть на корме сложена аккуратно, будто её укладывали на берегу.'
  const reader = {
    llmClient: { completeJson: async () => ({}) },
    read: async () => ({ goal_summary: 'Осмотреть корму', approach_summary: 'Осматриваю', ability: 'wis', skill: 'perception', plausibility: 'plausible', risk: 'none', required_means: [], effect: 'none', source: 'agent-adjudicator', success_detail: 'Знак артели Ворониных на корме.', surface_detail: surface }),
  }
  const memory = { worldMemory: { entities: [{ id: 'loc:guard', kind: 'location', name: 'Караульная', summary: '', aliases: [], visibility: 'party', tags: [] }], facts: [] } }
  const unlucky = await fixture({ reader, state: memory, rolls: [2, 2, 2] })
  const missed = await unlucky.send('Осматриваю корму и ищу метку владельца', { idempotencyKey: 'look-unlucky' })
  assert.equal(missed.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')?.payload?.success, false)
  const facts = missed.mechanics.filter((event) => event.event_type === 'WorldFactRecorded').map((event) => event.payload.fact)
  assert.deepEqual(facts.map((fact) => [fact.object, fact.summary]), [['surface', surface]], 'на провале — только видимая деталь, без ответа на вопрос')
})

test('хранитель зацепки, вставший на поле во время разбора, ход не отбрасывает', async () => {
  // Замер 2026-10-10: плетение зацепок ставило хранителя на поле (`NpcPlaced`)
  // рядом со вторым шагом плана — и ход получал «Обстановка изменилась…».
  const reading = { goal_summary: 'Простучать бочки', approach_summary: 'Простукиваю бочки', ability: 'wis', skill: 'perception', plausibility: 'trivial', risk: 'none', required_means: [], effect: 'none', source: 'agent-adjudicator' }
  const side = { store: null, campaignId: '' }
  const reader = {
    llmClient: { completeJson: async () => ({}) },
    read: async () => {
      const current = await side.store.load(side.campaignId)
      await side.store.commit({ campaignId: side.campaignId, expectedStateVersion: current.state_version, idempotencyKey: `placed-${current.state_version}`, events: [
        { event_type: 'NpcPlaced', visibility: 'party', payload: { npc_id: 'mira', location_id: 'room', x: 4, y: 1 }, target_ids: ['mira'] },
      ] })
      return reading
    },
  }
  const { send, eventStore, state } = await fixture({ reader, state: roomWithDoor() })
  Object.assign(side, { store: eventStore, campaignId: state.sessionCode })
  const accepted = await send('Простукиваю бочки у стены')
  assert.doesNotMatch(String(accepted.narration), /Обстановка изменилась/u)
})

test('провал проверки рассказывается через цену и причину от судьи, а не «не вышло»', async () => {
  // Замер 9 (2026-10-10): «Дверь не поддаётся, и Борин остаётся снаружи» —
  // без причины и цены. Судья называет до броска, что герой увидит при
  // провале (`failure_detail`), и рассказчик получает это как деталь исхода.
  const { narratorResponsePlan } = await import('../server/narrator.mjs')
  const failure = 'Ветер воет в щелях так, что все звуки с кормы тонут в нём.'
  const reader = {
    llmClient: { completeJson: async () => ({}) },
    read: async () => ({ goal_summary: 'Осмотреть корму', approach_summary: 'Осматриваю', ability: 'wis', skill: 'perception', plausibility: 'plausible', risk: 'none', required_means: [], effect: 'none', source: 'agent-adjudicator', success_detail: 'Знак артели на корме.', failure_detail: failure }),
  }
  const briefs = []
  const narrator = { render: async (brief) => { briefs.push(brief); return { narration: 'Ветер воет так, что корма молчит; метку в темноте не разобрать.', provider: 'test-llm' } } }
  const { send } = await fixture({ reader, narrator, rolls: [2, 2, 2] })
  const missed = await send('Прислушиваюсь у кормы, есть ли кто в трюме', { idempotencyKey: 'look-failure-detail' })
  assert.equal(missed.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')?.payload?.success, false)
  const brief = briefs.at(-1)
  assert.equal(brief?.known_environment?.player_intent?.outcome_detail, failure)
  assert.match(narratorResponsePlan(brief).must_answer, /outcome_detail/u)
})

test('реакция NPC из подтверждённой детали исхода разрешена рассказчику', async () => {
  // Замер 9: после удачной Проницательности ведущий писал «по её реакции
  // неясно» — любая реакция вне словаря отбрасывалась проверкой.
  const { withDetailReactions } = await import('../server/game-orchestrator.mjs')
  const permits = [
    { npc_id: 'mara', name: 'Мара Вейл', reaction: 'reacts_to_act', description: 'отзывается на поступок героя по своему нраву' },
    { npc_id: 'orren', name: 'Оррен Кель', reaction: 'reacts_to_act', description: 'отзывается на поступок героя по своему нраву' },
  ]
  const detail = 'Мара бледнеет и стискивает край стойки — лицо на мостках ей знакомо.'
  const [mara, orren] = withDetailReactions(permits, [detail, ''])
  assert.match(mara.description, /стискивает край стойки/u)
  assert.equal(orren.description, permits[1].description, 'другого NPC деталь не касается')
  assert.deepEqual(withDetailReactions(permits, ['', '']), permits)
})

test('методичный осмотр с проваленным броском находит спрятанное за полчаса', async () => {
  // DMG 2014, гл. 8, «Многократные проверки»: когда спешить некуда,
  // вдесятеро больше времени — успех. Провал броска решает только время.
  const briefs = []
  const narrator = { render: async (brief) => { briefs.push(brief); return { narration: 'Полчаса под дождём — и под скамьёй находится обрывок журнала.', provider: 'test-llm' } } }
  const clue = 'Под кормовой скамьёй спрятан обрывок судового журнала с записью о ночной разгрузке.'
  const memory = { worldMemory: {
    entities: [{ id: 'loc:guard', kind: 'location', name: 'Караульная', summary: '', aliases: [], visibility: 'party', tags: [] }],
    facts: [{ id: 'fact:secret:log', subject_id: 'loc:guard', predicate: 'gm_secret', object: JSON.stringify({ topic: 'журнал корма скамья', skills: ['perception', 'investigation'], holder: '' }),
      summary: clue, visibility: 'gm_only', source_event_ids: [], status: 'active', recorded_at_minutes: 0 }],
  } }
  const { send } = await fixture({ narrator, state: memory, rolls: [2, 2, 2] })
  const result = await send('Методично осматриваю корму и скамьи, доску за доской', { idempotencyKey: 'thorough-1' })
  assert.equal(result.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')?.payload?.success, false)
  const facts = result.mechanics.filter((event) => event.event_type === 'WorldFactRecorded').map((event) => event.payload.fact.summary)
  assert.ok(facts.includes(clue), `спрятанное найдено: ${JSON.stringify(facts)}`)
  const minutes = result.mechanics.filter((event) => event.event_type === 'TimeAdvanced').reduce((sum, event) => sum + Number(event.payload?.minutes ?? event.payload?.amount ?? 0), 0)
  assert.ok(minutes >= 30, `ушло полчаса: ${minutes}`)
  assert.equal(briefs.at(-1)?.known_environment?.player_intent?.thorough_search, 'found')
})

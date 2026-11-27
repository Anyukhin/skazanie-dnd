import assert from 'node:assert/strict'
import test from 'node:test'

// Правка готовой карты сцены (скрыть клетки, открыть след предмета, убрать
// предмет): в `fixtures.mjs` нет шагов поверх уже построенной карты — импорт
// остаётся до них.
import { createCampaignState, editMap, normalizeCampaignState, planScene, readMap, resolveCommands, serverBatch } from './kit/fixtures.mjs'
import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SCENARIO_ID = 'astohan-dragon-hunt'
const HERO_ID = 'clue-hero'
const HERO = {
  id: HERO_ID, character: 'Следопыт улик', name: 'Игрок улик', role: 'Воин · ур. 7',
  species: 'Человек', background: 'Солдат', level: 7, hp: 70, maxHp: 70,
  armor: 18, speed: 30, proficiency: 3,
  abilities: { str: 16, dex: 12, con: 14, int: 12, wis: 14, cha: 10 }, inventory: [],
}

// Id фактов улик считает сервер (`scenarioClueFactId`) одним пакетом.
const CLUE_IDS = ['ash-journal', 'cliffs-frescoes', 'cliffs-diary', 'cliffs-maid']
const CLUE_FACT_IDS = new Map((await serverBatch(CLUE_IDS.map((clueId) => ['scenarioClueFactId', { id: SCENARIO_ID }, clueId])))
  .map((factId, index) => [CLUE_IDS[index], factId]))

function clueFactId(clueId) {
  const factId = CLUE_FACT_IDS.get(clueId)
  assert.ok(factId, `${clueId}: id факта улики не посчитан`)
  return factId
}

const CASES = [
  {
    code: 'ASTOHAN-JOURNAL-CLUE', locationId: 'astohan-ash-watch',
    propIds: ['astohan-ash-watch:burnt-journal'], clueId: 'ash-journal', label: /журнал|бумаг/u,
    text: 'Под обломками караулки — обгоревший журнал сборщика налогов. Последняя ночёвка вычеркнута чужой рукой: «двор у старой мельницы, Редстоуновка».',
  },
  {
    code: 'ASTOHAN-FRESCO-CLUE', locationId: 'astohan-forgotten-cliffs',
    propIds: ['astohan-forgotten-cliffs:fresco-1', 'astohan-forgotten-cliffs:fresco-2', 'astohan-forgotten-cliffs:fresco-3'],
    clueId: 'cliffs-frescoes', label: /фреск|мозаи|часовн/u,
    text: 'Три фрески библиотеки: Каэлан подносит корону дракону, его казнь проклятым мечом и голова, спрятанная в «сердце камня». Подпись: «Голова спит там, где пали небеса».',
  },
  {
    code: 'ASTOHAN-DIARY-CLUE', locationId: 'astohan-forgotten-cliffs',
    propIds: ['astohan-forgotten-cliffs:executioner-diary'], clueId: 'cliffs-diary', label: /Дневник палача/iu,
    text: 'Дневник палача из темницы: казнь Каэлана мечом «Лунный Судья» и страх перед глазами, «что светились даже после удара».',
  },
]

async function arriveAndExpose(server, admin, scene, { atProp = true, expose = true, withoutDiary = false, worldTimeMinutes = null } = {}) {
  let state = await normalizeCampaignState(await createCampaignState({
    code: scene.code, worldTemplateId: 'astohan-plains', players: [HERO], campaignMode: 'adventure',
  }))
  for (let hop = 0; hop < 8 && state.scene.location_id !== scene.locationId; hop += 1) {
    const { sceneArgs } = await planScene({
      state, decision: `Идём в ${scene.locationId}`, destinationLocationId: scene.locationId,
    })
    state = await normalizeCampaignState((await resolveCommands([{ command_type: 'AdvanceScene', command_id: `${scene.code}:arrive:${hop}`, scene_args: sceneArgs }], state, {
      fixed: 10, context: { isAdmin: true },
    })).state)
  }
  assert.equal(state.scene.location_id, scene.locationId, `${scene.locationId}: сценарный переход должен дойти до места`)
  // Карту правит сервер (`editMap`): шаги `setCell` по порядку, как раньше на JS.
  const source = withoutDiary
    ? { ...state.scene.map, props: state.scene.map.props.filter((prop) => prop.id !== 'astohan-forgotten-cliffs:executioner-diary') }
    : state.scene.map
  const map = await readMap(source)
  const steps = map.cells.map(({ x, y }) => ({ cell: [x, y, { revealed: false }] }))
  for (const propId of scene.propIds) {
    const prop = map.props.find((candidate) => candidate.id === propId)
    assert.ok(prop?.footprint[0], `${propId}: authored предмет должен быть на карте`)
    if (expose) for (const cell of prop.footprint) steps.push({ cell: [cell.x, cell.y, { revealed: true }] })
  }
  const target = map.props.find(candidate => candidate.id === scene.propIds[0])
  const propCell = target.footprint[0]
  const occupied = new Set(map.props.filter(prop => prop.blocksMove || prop === target)
    .flatMap(prop => prop.footprint.map(cell => `${cell.x},${cell.y}`)))
  const besideProp = target.footprint.flatMap(({ x, y }) => [{ x, y: y + 1 }, { x: x + 1, y }, { x, y: y - 1 }, { x: x - 1, y }])
    .find(({ x, y }) => map.cellAt(x, y)?.passable && !occupied.has(`${x},${y}`))
  const position = atProp ? besideProp : state.mechanics.positions[HERO_ID]
  assert.ok(position, 'для осмотра нужна свободная клетка рядом с предметом')
  if (!atProp) assert.ok(Math.max(Math.abs(position.x - propCell.x), Math.abs(position.y - propCell.y)) > 3)
  steps.push({ cell: [position.x, position.y, { revealed: true }] })
  const edited = await editMap(source, steps)
  const compact = await normalizeCampaignState({
    sessionCode: scene.code, campaign: 'Авторские улики Асстохана', partyName: 'Отряд улик',
    partyMemberIds: [HERO_ID], campaignConcept: state.campaignConcept, worldMap: state.worldMap,
    worldMemory: state.worldMemory, adventure: state.adventure, social: state.social, npc_world: state.npc_world,
    players: state.players.map((player) => ({ ...player, x: position.x, y: position.y })),
    enemies: [], entities: [], merchants: [], mechanics: {
      ...state.mechanics,
      ...(worldTimeMinutes == null ? {} : { world_time: { ...state.mechanics.world_time, elapsed_minutes: worldTimeMinutes } }),
      positions: { [HERO_ID]: position },
    }, activePlayerId: HERO_ID,
    ruleset_id: state.ruleset_id, ruleset_version: state.ruleset_version, enabled_rule_packs: state.enabled_rule_packs,
    scene: { ...state.scene, map: edited.map, cells: edited.cells }, messages: [], battleLog: [], rulings: [], state_version: 0,
  })
  await createCampaign(admin, { code: scene.code, name: 'Авторские улики Асстохана', state: compact })
  return (await addPlayer(server, admin, scene.code, { heroIds: [HERO_ID], name: `Игрок ${scene.code}` })).client
}

function projectedProp(room, propId) {
  return room.state.scene.map.props.find((prop) => prop.id === propId)
}

function discovery(room, clueId) {
  const factId = clueFactId(clueId)
  return (room.state.worldMemory?.facts ?? []).filter((fact) => fact.predicate === 'discovery' && fact.supersedes_fact_id === factId)
}

function knowledge(room, clueId) {
  const factId = clueFactId(clueId)
  return (room.state.worldMemory?.knowledge_revealed ?? []).filter((entry) => entry.fact_id === factId)
}

function clueText(result) {
  const event = (result.mechanics ?? []).find((entry) => ['SceneObjectKnowledgeRevealed', 'KnowledgeRevealed'].includes(entry.event_type))
  return event?.payload?.text ?? event?.payload?.summary ?? ''
}

test('авторские предметы Асстохана открывают публичные улики через обычный HTTP-путь', { timeout: runnerTimeout(180_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-astohan-scene-clues-' })
  const { client: admin } = await setupAdmin(server, {
    name: 'Ведущий улик', email: 'astohan-clues-admin@test.local', password: 'secure-clues-admin-password',
  })

  for (const scene of CASES) {
    const player = await arriveAndExpose(server, admin, scene)
    const before = expectStatus(await player.get(`/api/rooms/${scene.code}`))
    for (const propId of scene.propIds) {
      const prop = projectedProp(before, propId)
      assert.equal(prop?.interactive, true, `${propId}: предмет должен быть интерактивен в проекции (${before.state.scene.map.locationId}, ${JSON.stringify(prop)})`)
      assert.ok(prop.interaction?.verbs?.includes('inspect'), `${propId}: UI должна предложить осмотр`)
    }
    assert.equal(discovery(before, scene.clueId).length, 0, `${scene.code}: улика скрыта до осмотра`)
    assert.doesNotMatch(JSON.stringify(before.state.messages ?? []), scene.label, `${scene.code}: текст не раскрыт заранее`)

    for (const [index, propId] of scene.propIds.entries()) {
      if (index > 0) {
        const target = projectedProp(before, propId)?.footprint?.[0]
        assert.ok(target, `${propId}: клетка предмета должна быть в проекции`)
        expectStatus(await sendCommand(player, scene.code, `${scene.code}:approach:${index}`, {
          command_type: 'MoveActor', actor_id: HERO_ID, to: target,
        }))
      }
      const result = expectStatus(await sendCommand(player, scene.code, `${scene.code}:inspect:${index}`, {
        command_type: 'OperateSceneObject', actor_id: HERO_ID, prop_id: propId, intent: 'inspect', approach: 'hand',
      }))
      assert.equal(clueText(result), scene.text, `${propId}: точный текст улики`)
    }

    const after = expectStatus(await player.get(`/api/rooms/${scene.code}`))
    assert.equal(discovery(after, scene.clueId).length + knowledge(after, scene.clueId).length, 1, `${scene.code}: одна общая публичная улика`)
    assert.equal(discovery(after, scene.clueId)[0]?.visibility ?? 'party', 'party')
    assert.match(JSON.stringify(after.state.messages ?? []), scene.label, `${scene.code}: последствие осмотра в истории`)

    const firstTarget = projectedProp(before, scene.propIds[0])?.footprint?.[0]
    if (scene.propIds.length > 1) expectStatus(await sendCommand(player, scene.code, `${scene.code}:approach:again`, {
      command_type: 'MoveActor', actor_id: HERO_ID, to: firstTarget,
    }))
    const replay = expectStatus(await sendCommand(player, scene.code, `${scene.code}:inspect:0`, {
      command_type: 'OperateSceneObject', actor_id: HERO_ID, prop_id: scene.propIds[0], intent: 'inspect', approach: 'hand',
    }))
    assert.equal(replay.idempotent_replay, true, `${scene.code}: повтор ключа идемпотентен`)
    const second = await sendCommand(player, scene.code, `${scene.code}:inspect:again`, {
      command_type: 'OperateSceneObject', actor_id: HERO_ID, prop_id: scene.propIds[0], intent: 'inspect', approach: 'hand',
    })
    assert.equal(second.status, 400)
    assert.equal(second.body?.code, 'SCENE_OBJECT_ALREADY_INSPECTED')
    const foreign = await sendCommand(player, scene.code, `${scene.code}:foreign`, {
      command_type: 'OperateSceneObject', actor_id: 'foreign-hero', prop_id: scene.propIds[0], intent: 'inspect', approach: 'hand',
    })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body?.code, 'ACTOR_FORBIDDEN')

    const journal = await readJournal(server, scene.code)
    const replayed = await readJournal(server, scene.code, { useSnapshots: false })
    assert.deepEqual(replayed.state.worldMemory, journal.state.worldMemory, `${scene.code}: replay сохраняет улику`)
    assert.deepEqual(replayed.state.messages, journal.state.messages, `${scene.code}: replay сохраняет историю`)
  }
})

test('заявка словами открывает ту же улику, что и кнопка осмотра', { timeout: runnerTimeout(180_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-astohan-text-clues-' })
  const { client: admin } = await setupAdmin(server)
  for (const [source, action] of [
    [CASES[0], 'Ищу под обломками караулки обгоревший журнал сборщика налогов.'],
    [CASES[1], 'Изучаю фрески в библиотеке.'],
    [CASES[2], 'Читаю дневник палача в темнице.'],
  ]) {
    const scene = { ...source, code: source.clueId.toUpperCase() + '-TEXT' }
    const player = await arriveAndExpose(server, admin, scene)
    if (source === CASES[0]) {
      const declined = expectStatus(await player.post('/api/narrate', {
        campaign_id: scene.code, actor_id: HERO_ID, action: 'Не читаю обгоревший журнал.', idempotency_key: 'decline-reading',
      }))
      assert.ok(!declined.mechanics?.some(event => event.event_type === 'SceneObjectInspected'))
      const stillHidden = expectStatus(await player.get(`/api/rooms/${scene.code}`))
      assert.equal(discovery(stillHidden, scene.clueId).length + knowledge(stillHidden, scene.clueId).length, 0)
    }
    const body = { campaign_id: scene.code, actor_id: HERO_ID, action, idempotency_key: 'read-by-name' }
    const submit = () => player.post('/api/narrate', body)
    const result = expectStatus(await submit())
    assert.equal(clueText(result), scene.text, `${scene.code}: ${result.provider} — ${result.narration}`)
    assert.ok(result.narration.includes(scene.text), 'игрок должен получить текст открытой улики')
    const retry = expectStatus(await submit())
    assert.equal(retry.idempotent_replay, true)
    const after = expectStatus(await player.get(`/api/rooms/${scene.code}`))
    assert.equal(discovery(after, scene.clueId).length + knowledge(after, scene.clueId).length, 1)
    const replayed = await readJournal(server, scene.code, { useSnapshots: false })
    assert.deepEqual(replayed.state.worldMemory, (await readJournal(server, scene.code)).state.worldMemory)
  }
})

test('название журнала в заявке не позволяет осмотреть его издалека или через туман', { timeout: runnerTimeout(180_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-astohan-distant-clue-' })
  const { client: admin } = await setupAdmin(server)
  for (const expose of [true, false]) {
    const scene = { ...CASES[0], code: expose ? 'ASH-JOURNAL-DISTANT' : 'ASH-JOURNAL-HIDDEN' }
    const player = await arriveAndExpose(server, admin, scene, { atProp: false, expose })
    const before = expectStatus(await player.get(`/api/rooms/${scene.code}`))
    const visibleProp = projectedProp(before, scene.propIds[0])
    assert.equal(Boolean(visibleProp), expose)
    if (visibleProp) {
      const where = before.state.mechanics.positions[HERO_ID]
      assert.ok(visibleProp.footprint.every(cell => Math.max(Math.abs(cell.x - where.x), Math.abs(cell.y - where.y)) > 1))
    }
    const result = await player.post('/api/narrate', {
      campaign_id: scene.code, actor_id: HERO_ID, action: 'Осматриваю журнал.', idempotency_key: 'read-from-afar',
    })
    assert.ok([200, 400].includes(result.status))
    const reply = result.body.narration ?? result.body.error
    assert.ok(reply?.trim(), 'герою нужно объяснить, как продолжить поиск')
    assert.doesNotMatch(reply, /Вышло:|Последняя ночёвка|двор у старой мельницы/u,
      `${scene.code}: ${result.body.provider}, ${(result.body.mechanics ?? []).map(event => event.event_type).join(', ')} — ${reply}`)
    if (!expose) {
      assert.doesNotMatch(reply, /улика|журнал лежит|караулк/iu, 'ответ не должен подтверждать наличие скрытого предмета')
      assert.ok(!JSON.stringify(result.body).includes(scene.propIds[0]), 'служебный ID скрытого предмета не уходит игроку')
    }
    assert.ok(!(result.body.mechanics ?? []).some(event => ['TimeAdvanced', 'SceneObjectKnowledgeRevealed', 'RulingRecorded'].includes(event.event_type)))
    const room = expectStatus(await player.get(`/api/rooms/${scene.code}`))
    assert.equal(discovery(room, scene.clueId).length + knowledge(room, scene.clueId).length, 0)
  }
})

test('игрок узнаёт свидетельство призрачной служанки при выборе её реплики на кухне', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-astohan-maid-' })
  const { client: admin } = await setupAdmin(server)
  const npcId = 'astohan-cliffs-maid'
  const scene = { code: 'ASTOHAN-KITCHEN', locationId: 'astohan-forgotten-cliffs', propIds: ['astohan-forgotten-cliffs:kitchen_stove-49'] }
  const player = await arriveAndExpose(server, admin, scene, { worldTimeMinutes: 1_200 })
  const room = () => player.get(`/api/rooms/${scene.code}`).then(result => expectStatus(result))
  const before = await room()
  assert.ok(before.state.scene_dialogues[npcId]?.options.some(option => option.id === 'last-tear'))
  const discoveries = snapshot => discovery(snapshot, 'cliffs-maid').length + knowledge(snapshot, 'cliffs-maid').length
  assert.equal(discoveries(before), 0)
  assert.doesNotMatch(JSON.stringify(before.state.scene_dialogues[npcId]), /слеза стала камнем под алтарём/u)
  const choose = () => sendCommand(player, scene.code, 'ask-the-maid', {
    command_type: 'ChooseDialogueOption', actor_id: HERO_ID, npc_id: npcId, option_id: 'last-tear',
  })
  expectStatus(await choose())
  assert.equal(expectStatus(await choose()).idempotent_replay, true)
  const after = await room()
  assert.equal(discoveries(after), 1)
  assert.match(JSON.stringify(after.state.worldMemory), /слеза стала камнем под алтарём/u)
  assert.deepEqual((await readJournal(server, scene.code, { useSnapshots: false })).state.worldMemory, (await readJournal(server, scene.code)).state.worldMemory)
})

test('в сохранённом замке без отдельной книги по словам «дневник палача» осматривается старый стол', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-astohan-old-diary-' })
  const { client: admin } = await setupAdmin(server)
  const scene = { ...CASES[2], code: 'ASTOHAN-OLD-DIARY', propIds: ['astohan-forgotten-cliffs:executioner-desk'] }
  const player = await arriveAndExpose(server, admin, scene, { withoutDiary: true })
  const result = expectStatus(await player.post('/api/narrate', {
    campaign_id: scene.code, actor_id: HERO_ID, action: 'Читаю дневник.', idempotency_key: 'read-old-desk',
  }))
  assert.equal(clueText(result), scene.text)
})

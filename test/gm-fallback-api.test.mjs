import assert from 'node:assert/strict'
import test from 'node:test'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const cargoFact = 'Сафра видела лодку с грузом у нижнего настила после второго колокола.'
const guardedFact = 'Груз увезли к запечатанному подвалу.'
const askCargo = 'Сафра, что случилось с грузом «Чайки» и с чего лучше начать поиски?'
const hangKettle = 'Подвешиваю свой пустой котелок на верёвке над дверью сторожки, чтобы он звякнул, если дверь откроют.'

async function mill(t) {
  const code = 'GM-FALLBACK-MILL'
  const server = await startTestServer(t)
  const { client: admin } = await setupAdmin(server)
  await createCampaign(admin, { code, state: {
    sessionCode: code,
    activePlayerId: 'ada',
    players: [
      { id: 'ada', character: 'Ада', role: 'Плут', hp: 22, maxHp: 22, inventory: ['Медный котелок', 'Верёвка'], characterSetupRequired: false },
      { id: 'ivo', character: 'Иво', role: 'Воин', hp: 27, maxHp: 27, inventory: [], characterSetupRequired: false },
    ],
    scene: {
      title: 'Старая мельница', location: 'Старая мельница', location_id: 'old-mill',
      objective: 'Выяснить, куда пропал груз с баркаса «Чайка».',
      description: 'У старой мельницы стоят сторожка и пустая телега.', cells: [],
    },
    worldMemory: {
      entities: [{ id: 'old-mill', kind: 'location', name: 'Старая мельница', visibility: 'party' }],
      facts: [
        { id: 'fact:cargo', subject_id: 'old-mill', predicate: 'rumor', object: cargoFact, summary: cargoFact, visibility: 'party', status: 'active' },
        { id: 'fact:guarded', subject_id: 'old-mill', predicate: 'gm_secret', object: '{"topic":"груз"}', summary: guardedFact, visibility: 'gm_only', status: 'active' },
      ],
    },
    social: { npcs: [{
      id: 'safra', name: 'Сафра', role: 'мельничиха', location: 'Старая мельница',
      location_id: 'old-mill', known_fact_ids: ['fact:cargo', 'fact:guarded'], visibility: 'party', available: true,
    }] },
  } })
  const { client: ada } = await addPlayer(server, admin, code, { heroIds: ['ada'] })
  const { client: ivo } = await addPlayer(server, admin, code, { heroIds: ['ivo'] })
  const room = async (client) => expectStatus(await client.get(`/api/rooms/${code}`)).state
  const send = (client, key, action, extra) => client.post('/api/narrate', {
    campaign_id: code, actor_id: 'ada', idempotency_key: key, action, ...extra,
  })
  return { code, server, ada, ivo, room, send }
}

test('NPC без модели сообщает известную открытую зацепку и записывает источник её раскрытия', { timeout: runnerTimeout(90_000) }, async (t) => {
  const { code, server, ada, ivo, room, send } = await mill(t)
  const reply = expectStatus(await send(ada, 'ask-cargo', askCargo, { npc_id: 'safra' })).narration
  assert.match(reply, /видела лодку с грузом у нижнего настила/u)
  assert.ok(!reply.includes(guardedFact))
  for (const viewer of [ada, ivo]) {
    const state = await room(viewer)
    assert.ok(state.social.conversations.some((turn) => turn.npc_reply === reply))
    assert.ok(!JSON.stringify(state).includes(guardedFact))
  }

  const history = await readJournal(server, code, { useSnapshots: false })
  const events = history.commits.flatMap((commit) => commit.events)
  const turn = events.find((event) => event.event_type === 'NpcConversationRecorded' && event.payload.conversation.npc_reply === reply)
  const reveal = events.find((event) => event.event_type === 'KnowledgeRevealed')
  assert.equal(turn?.visibility, 'party')
  assert.deepEqual(turn.payload.conversation.disclosed_fact_ids, ['fact:cargo'])
  assert.equal(reveal?.payload.fact_id, 'fact:cargo')
  assert.deepEqual(reveal.payload.source_event_ids, [turn.event_id])
  assert.equal(history.state.social.conversations.at(-1).npc_reply, reply)

  await server.restart()
  assert.ok((await room(ivo)).social.conversations.some((turn) => turn.npc_reply === reply))
  const again = expectStatus(await send(ada, 'ask-again', askCargo, { npc_id: 'safra' }))
  assert.doesNotMatch(again.narration, /видела лодку с грузом/u)
  assert.ok(!again.narration.includes(guardedFact))
})

test('ясная цель замысла с предметом ведёт к уточнению способа без траты предмета или хода', { timeout: runnerTimeout(90_000) }, async (t) => {
  const { code, server, ada, ivo, room, send } = await mill(t)
  const before = await room(ada)
  const result = expectStatus(await send(ada, 'hang-kettle', hangKettle, { manual_roll: true }))
  assert.match(result.narration, /как движение передастся/u)
  assert.match(result.narration, /если дверь откроют/u)
  assert.doesNotMatch(result.narration, /чего .* хочет добиться|отправиться дальше/u)
  assert.ok(result.clarification)
  assert.ok(!result.check)
  assert.ok(!(result.mechanics ?? []).length)
  assert.deepEqual((await room(ada)).players.find(({ id }) => id === 'ada').inventory, before.players.find(({ id }) => id === 'ada').inventory)
  assert.ok((await room(ivo)).messages.some((message) => message.text === result.narration))
  const history = await readJournal(server, code, { useSnapshots: false })
  assert.equal(history.state_version, before.state_version)
})

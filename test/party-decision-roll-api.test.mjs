// Общий бросок отряда через HTTP: `POST /api/campaigns/:id/party-decisions/:id/roll`
// (server/index.mjs, маршрут partyRollMatch). Кость бросает сервер (назначение
// `party_decision`), значение клиента не учитывается; права, повтор по ключу,
// закрытое решение и replay после перезапуска.
//
// Решение типа `roll` открывает только ход Режиссёра или рассказчика, поэтому
// тест кладёт `PartyDecisionOpened` в журнал при остановленном сервере
// (`appendJournal`) — так же, как его записал бы сервер.
import assert from 'node:assert/strict'
import test from 'node:test'

import { addPlayer, createCampaign, createClient, expectStatus, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'
import { appendJournal, readJournal } from './kit/journal.mjs'
import { partyDecisionOpenedEvent } from '../server/party-decision.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CODE = 'PARTY-ROLL'
const DECISION = 'roll-gate-1'
// Кость общего броска — 7: ниже СЛ 12, побеждает второй вариант.
const DICE = { format: 'skazanie.test-dice/1', rules: [{ purpose: '^party_decision$', sides: 20, value: 7 }] }

function hero(id, character) {
  return { id, name: character, character, hp: 12, maxHp: 12, armor: 12, speed: 30, proficiency: 2,
    abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [] }
}

function campaignState() {
  return {
    sessionCode: CODE,
    campaign: 'Общий бросок',
    partyName: 'Двое у ворот',
    activePlayerId: 'hero-a',
    partyMemberIds: ['hero-a', 'hero-b'],
    messages: [],
    players: [hero('hero-a', 'Лира'), hero('hero-b', 'Бранн')],
    scene: { title: 'Ворота', location: 'Старые ворота', mood: '', objective: 'Пройти ворота', turn: 1, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Старые ворота'], history: [] },
    mechanics: { combat: { active: false } },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
}

function rollPath(id = DECISION, code = CODE) {
  return `/api/campaigns/${code}/party-decisions/${encodeURIComponent(id)}/roll`
}

test('общий бросок отряда: серверная кость, права, повтор по ключу и replay', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { dice: DICE, storagePrefix: 'skazanie-party-roll-' })
  const admin = await setupAdmin(server)
  await createCampaign(admin.client, { code: CODE, name: 'Общий бросок', state: campaignState() })
  const guest = await addPlayer(server, admin.client, CODE, { heroIds: ['hero-b'] })
  const outsider = await registerUser(server)

  // Решение «общий бросок» — как его открывает ход ведущего.
  await server.stop()
  const before = await readJournal(server, CODE)
  const opened = partyDecisionOpenedEvent({
    id: DECISION,
    type: 'roll',
    title: 'Прорваться через ворота?',
    description: 'Один общий бросок решает, успеет ли отряд.',
    difficulty: 12,
    options: [{ id: 'through', label: 'Прорваться' }, { id: 'retreat', label: 'Отступить' }],
    createdAt: Date.now(),
  }, 'hero-a', { eligibleHeroIds: ['hero-a', 'hero-b'], policy: before.state.partyDecisionPolicy })
  await appendJournal(server, CODE, { expected_state_version: before.state_version, idempotency_key: 'test-open-roll', events: [opened] })
  await server.start()

  const opening = expectStatus(await admin.client.get(`/api/rooms/${CODE}`))
  assert.equal(opening.state.agentInteraction?.id, DECISION)
  assert.equal(opening.state.agentInteraction?.status, 'open')
  assert.equal(opening.state.agentInteraction?.type, 'roll')

  // Права: без входа, чужая кампания, чужой герой.
  const anonymous = await createClient(server).post(rollPath(), { actor_id: 'hero-b' })
  assert.equal(anonymous.status, 401, anonymous.text)
  const foreign = await outsider.client.post(rollPath(), { actor_id: 'hero-b', idempotency_key: 'outsider-roll' })
  assert.equal(foreign.status, 403, foreign.text)
  assert.equal(foreign.body?.error, 'Нет доступа к этой кампании')
  const notOwner = await guest.client.post(rollPath(), { actor_id: 'hero-a', idempotency_key: 'guest-roll-a' })
  assert.equal(notOwner.status, 403, notOwner.text)
  assert.equal(notOwner.body?.code, 'ACTOR_FORBIDDEN')
  const missing = await admin.client.post(rollPath('roll-gate-1', 'NO-SUCH-CAMPAIGN'), { actor_id: 'hero-a' })
  assert.equal(missing.status, 404, missing.text)

  // Голос не годится для общего броска; устаревшее решение — конфликт.
  const vote = await guest.client.post(`/api/campaigns/${CODE}/party-decisions/${DECISION}/votes`, { actor_id: 'hero-b', option_id: 'through', idempotency_key: 'vote-on-roll' })
  assert.equal(vote.status, 409, vote.text)
  assert.equal(vote.body?.code, 'PARTY_DECISION_CLOSED')
  const stale = await guest.client.post(rollPath('roll-gate-0'), { actor_id: 'hero-b', idempotency_key: 'stale-roll' })
  assert.equal(stale.status, 409, stale.text)
  assert.equal(stale.body?.code, 'PARTY_DECISION_CONFLICT')

  // Бросок: значение клиента не учитывается, кость — серверная.
  const rolled = await guest.client.post(rollPath(), { actor_id: 'hero-b', idempotency_key: 'guest-roll-1', roll: 20, total: 20 })
  assert.equal(rolled.status, 200, rolled.text)
  assert.equal(rolled.body.roll?.total, 7)
  assert.equal(rolled.body.roll?.value, 7)
  assert.equal(rolled.body.roll?.purpose, 'party_decision')
  assert.equal(rolled.body.roll?.playerId, 'hero-b')
  assert.deepEqual(rolled.body.mechanics.map((event) => event.event_type), ['DieRolled', 'PartyDecisionResolved'])
  const [die, resolved] = rolled.body.mechanics
  assert.equal(die.payload.purpose, 'party_decision')
  assert.deepEqual(die.payload.dice, [7])
  assert.equal(resolved.payload.success, false)
  assert.equal(resolved.payload.resolved_option_id, 'retreat')
  assert.equal(rolled.body.state.agentInteraction?.status, 'resolved')
  assert.equal(rolled.body.state.agentInteraction?.resolvedOptionId, 'retreat')
  assert.ok(rolled.body.state_version > before.state_version + 1, rolled.text)

  // Повтор с тем же ключом — тот же коммит, кость второй раз не бросается.
  const repeated = await guest.client.post(rollPath(), { actor_id: 'hero-b', idempotency_key: 'guest-roll-1' })
  assert.equal(repeated.status, 200, repeated.text)
  assert.deepEqual(repeated.body.mechanics.map((event) => event.event_id), rolled.body.mechanics.map((event) => event.event_id))
  assert.equal(repeated.body.roll?.roll_id, rolled.body.roll?.roll_id)
  assert.equal(repeated.body.state_version, rolled.body.state_version)

  // Решение уже принято: новый ключ — конфликт, а не второй бросок.
  const again = await admin.client.post(rollPath(), { actor_id: 'hero-a', idempotency_key: 'admin-roll-2' })
  assert.equal(again.status, 409, again.text)
  assert.equal(again.body?.code, 'PARTY_DECISION_CLOSED')

  // Журнал: ровно один коммит броска; replay после перезапуска сходится.
  await server.stop()
  const journal = await readJournal(server, CODE)
  const rollCommits = journal.commits.filter((commit) => commit.events.some((event) => event.event_type === 'DieRolled' && event.payload?.purpose === 'party_decision'))
  assert.deepEqual(rollCommits.map((commit) => commit.idempotency_key), ['guest-roll-1'])
  assert.equal(journal.state.agentInteraction?.resolvedOptionId, 'retreat')
  assert.equal(journal.state_version, rolled.body.state_version)
  const replayed = await readJournal(server, CODE, { useSnapshots: false })
  assert.deepEqual(replayed.state.agentInteraction, journal.state.agentInteraction)
  await server.start()
  const restarted = expectStatus(await guest.client.get(`/api/rooms/${CODE}`))
  assert.equal(restarted.state.agentInteraction?.status, 'resolved')
  assert.equal(restarted.state.agentInteraction?.resolvedOptionId, 'retreat')
  assert.equal(restarted.state.agentInteraction?.roll?.total, 7)
})

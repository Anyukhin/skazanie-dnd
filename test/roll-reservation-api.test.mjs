// Резерв броска вокруг commit (аудит PR #131, SEC-04).
//
// `/api/narrate` потребляет `roll_id` в реестре раньше, чем ход фиксируется в
// журнале. До исправления несостоявшийся commit оставлял кость помеченной: новый
// ключ получал `ROLL_ALREADY_USED`, хотя ни одного события с этой костью не
// было, и объявленная проверка оставалась без исхода. Здесь по настоящему HTTP
// проверены три точки сбоя: отказ commit, остановка процесса до commit и
// остановка после commit. Во всех трёх кость исполняет ровно одну проверку.
import assert from 'node:assert/strict'
import test from 'node:test'

import { readJournal } from './kit/journal.mjs'
import { createClient, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'ROLL-RESERVATION'
const SETUP_TOKEN = 'roll-reservation-setup'
const ACTION = 'Проверяю силу'

function fixtureState() {
  return {
    state_version: 0,
    sessionCode: SESSION,
    campaign: 'Резерв броска',
    activePlayerId: 'hero-a',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero-a', character: 'Герой', name: 'Герой', hp: 10, maxHp: 10,
      armor: 14, proficiency: 2,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [], online: true,
    }],
    enemies: [],
    scene: { title: 'Проба', location: 'Площадь', mood: '', objective: '', turn: 0, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
}

/**
 * Сбои commit по ключу идемпотентности — данные `skazanie.test-faults/1`
 * (test/kit/hooks-format.mjs); каждый срабатывает один раз за жизнь процесса.
 *
 * @param {Record<string, 'throw' | 'exit-before' | 'exit-after'>} entries
 */
const commitFaults = (entries) => ({
  commit: Object.entries(entries).map(([key, mode]) => ({ idempotency_key: key, mode })),
})

/** Все `AbilityCheckResolved` из журнала событий кампании. */
async function committedAbilityChecks(server) {
  const { commits } = await readJournal(server, SESSION)
  return commits
    .flatMap((commit) => commit.events.map((event) => ({ ...event, idempotency_key: commit.idempotency_key })))
    .filter((event) => event.event_type === 'AbilityCheckResolved')
}

test('несостоявшийся commit возвращает бросок, состоявшийся закрепляет его за ключом', { timeout: runnerTimeout(120_000) }, async (t) => {
  const server = await startTestServer(t, {
    setupToken: SETUP_TOKEN,
    storagePrefix: 'skazanie-roll-reservation-',
    faults: commitFaults({ 'reservation-fail': 'throw', 'reservation-crash': 'exit-before' }),
  })
  const logs = server.output

  const admin = createClient(server)
  const setup = await admin.post('/api/auth/setup-admin', {
    name: 'Мастер стенда', email: 'roll-reservation-admin@example.test', password: 'RollReservationAdmin-2026!', setupToken: SETUP_TOKEN,
  })
  assert.equal(setup.status, 201, setup.text)
  const created = await admin.post('/api/campaigns', { code: SESSION, name: 'Резерв броска', state: fixtureState() })
  assert.equal(created.status, 201, `${created.text}\n${logs()}`)
  const player = createClient(server)
  const registered = await player.post('/api/auth/register', {
    name: 'Игрок стенда', email: 'roll-reservation-player@example.test', password: 'RollReservationPlayer-2026!',
  })
  assert.equal(registered.status, 201, registered.text)
  const users = await admin.get('/api/admin/users')
  const playerUser = users.body.users.find((candidate) => candidate.email === 'roll-reservation-player@example.test')
  assert.ok(playerUser)
  const assigned = await admin.patch(`/api/admin/users/${playerUser.id}`, { heroIds: ['hero-a'] })
  assert.equal(assigned.status, 200, assigned.text)
  const narrate = (key, extra = {}) => player.post('/api/narrate', {
    campaignId: SESSION, actor_id: 'hero-a', action: ACTION, idempotency_key: key, ...extra,
  })
  const declareAndRoll = async (offerKey) => {
    const offer = await narrate(offerKey, { manual_roll: true })
    assert.equal(offer.status, 200, `${offer.text}\n${logs()}`)
    assert.ok(offer.body.check?.check_id, `нет карточки проверки: ${offer.text}`)
    const rolled = await player.post('/api/roll', { campaignId: SESSION, playerId: 'hero-a', checkId: offer.body.check.check_id })
    assert.equal(rolled.status, 200, `${rolled.text}\n${logs()}`)
    return rolled.body
  }
  const assertResolvedWith = (response, roll) => {
    assert.equal(response.status, 200, `${response.text}\n${logs()}`)
    const ability = (response.body.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
    assert.ok(ability, `проверка не исполнилась: ${response.text}`)
    assert.equal(ability.payload.roll_id, roll.roll_id)
    assert.equal(ability.payload.kept, roll.value, 'та же кость, без переброса')
  }

  // 1. Commit отклонён: кость возвращается и исполняет проверку под новым
  // ключом — ровно один раз.
  const first = await declareAndRoll('reservation-offer-1')
  const failed = await narrate('reservation-fail', { roll: { roll_id: first.roll_id } })
  assert.notEqual(failed.status, 200, failed.text)
  assert.equal((await committedAbilityChecks(server)).length, 0, 'отказ commit не оставил событий')
  assertResolvedWith(await narrate('reservation-retry', { roll: { roll_id: first.roll_id } }), first)
  const third = await narrate('reservation-third', { roll: { roll_id: first.roll_id } })
  assert.equal(third.status, 400, third.text)
  assert.equal(third.body.code, 'ROLL_ALREADY_USED')

  // 2. Процесс остановлен между consume и commit: после перезапуска резерв
  // осиротевший, и кость исполняет проверку под новым ключом.
  const second = await declareAndRoll('reservation-offer-2')
  await assert.rejects(narrate('reservation-crash', { roll: { roll_id: second.roll_id } }))
  assert.equal(await server.waitForExit(), 70)
  await server.start({ faults: commitFaults({ 'reservation-after': 'exit-after' }) })
  assertResolvedWith(await narrate('reservation-crash-retry', { roll: { roll_id: second.roll_id } }), second)

  // 3. Процесс остановлен после commit: перезапуск резерв не снимает. Другой
  // ключ получает отказ, тот же ключ — прежний commit.
  const last = await declareAndRoll('reservation-offer-3')
  await assert.rejects(narrate('reservation-after', { roll: { roll_id: last.roll_id } }))
  assert.equal(await server.waitForExit(), 71)
  await server.start({ faults: null })
  const other = await narrate('reservation-after-other', { roll: { roll_id: last.roll_id } })
  assert.equal(other.status, 400, other.text)
  assert.equal(other.body.code, 'ROLL_ALREADY_USED')
  const replay = await narrate('reservation-after', { roll: { roll_id: last.roll_id } })
  assertResolvedWith(replay, last)
  assert.equal(replay.body.idempotent_replay, true)

  // В журнале ровно по одной проверке на кость.
  const checks = await committedAbilityChecks(server)
  assert.deepEqual(
    checks.map((event) => [event.idempotency_key, event.payload.roll_id]),
    [['reservation-retry', first.roll_id], ['reservation-crash-retry', second.roll_id], ['reservation-after', last.roll_id]],
  )
})

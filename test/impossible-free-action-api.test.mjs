import assert from 'node:assert/strict'
import test from 'node:test'
import { tacticalMap } from './kit/fixtures.mjs'
import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

test('недоступное действие завершается, а новая заявка читается по обстановке', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { dice: { rules: [{ sides: 6, value: 'max' }] } })
  const { client: gm } = await setupAdmin(server)
  const code = 'FREE-ACTION-LIMIT'
  const hero = { id: 'hero', character: 'Шорох', hp: 20, maxHp: 20, speed: 30, x: 0, y: 0 }
  const { map, cells } = await tacticalMap({ width: 5, height: 3, locationId: 'gallery', seed: code, fill: { passable: true, revealed: true } })
    .prop({ id: 'campfire-1', assetId: 'campfire', x: 3.5, y: 0.5, footprint: [{ x: 3, y: 0 }] })
    .build()
  await createCampaign(gm, { code, state: {
    sessionCode: code, campaign: 'Каменная галерея', activePlayerId: hero.id, partyMemberIds: [hero.id], players: [hero],
    ruleset_id: 'dnd_5e_2014', enabled_rule_packs: ['dnd_5e_2014'],
    scene: { location: 'Каменная галерея', map, cells },
    mechanics: { positions: { [hero.id]: { x: 0, y: 0 } } },
  } })
  const { client: player } = await addPlayer(server, gm, code, { heroIds: [hero.id] })
  const say = async (action, key, fields = {}) => expectStatus(await player.post('/api/narrate', {
    campaign_id: code, actor_id: hero.id, action, idempotency_key: key, ...fields,
  }))
  const dialogue = async () => expectStatus(await player.get(`/api/campaigns/${code}/dialogue?actor_id=${hero.id}`))
  const state = async () => expectStatus(await player.get(`/api/rooms/${code}`)).state
  const before = await state()
  const sitInFire = 'Сажусь жопой в огонь'

  for (const [index, [action, explanation]] of [
    ['Я сажусь в горящий костёр', /нет доступного источника этой опасности/u],
    [sitInFire, /нет доступного источника этой опасности/u],
    ['Прыгаю в пропасть', /нет доступного источника этой опасности/u],
    ['Я поднимаю весь замок одной рукой', /замок.*одной рукой/u],
    ['Пытаюсь сдвинуть целую крепость голыми руками', /сдвинуть целую крепость голыми руками/u],
  ].entries()) {
    const result = await say(action, `unavailable-${index}`)
    assert.match(result.narration, explanation, JSON.stringify(result.verification?.repaired_from ?? []))
    assert.equal(result.verification.valid, true)
    assert.ok(!result.clarification, action)
    assert.ok(!result.check, action)
    assert.equal(result.rejected, true)
    assert.equal(result.turn_consumed, false)
    assert.ok((result.mechanics ?? []).every(event => event.event_type === 'ActionDeclared'), action)
  }
  const unchanged = await state()
  assert.deepEqual(unchanged.mechanics.positions, before.mechanics.positions)
  assert.deepEqual(unchanged.mechanics.world_time, before.mechanics.world_time)
  assert.equal(unchanged.players[0].hp, 20)

  const unclear = await say('Делаю нечто невнятное с воздухом вокруг', 'unclear')
  assert.ok(unclear.clarification?.id)
  assert.equal((await dialogue()).clarification?.id, unclear.clarification.id)
  const continuation = { clarification_id: unclear.clarification.id }
  const refused = await say('Нет, сажусь в огонь', 'clarification-refusal', continuation)
  assert.equal(refused.rejected, true)
  assert.ok(!refused.clarification)
  assert.equal((await dialogue()).clarification, null)

  const plan = await say(`${sitInFire}, затем подхожу к костру`, 'plan')
  assert.equal(plan.rejected, true)
  assert.deepEqual((await state()).mechanics.positions, before.mechanics.positions)

  expectStatus(await sendCommand(player, code, 'move-near-fire', {
    command_type: 'MoveActor', actor_id: hero.id, to: { x: 2, y: 0 },
  }))
  const replay = await say('Нет, сажусь в огонь', 'clarification-refusal', continuation)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.narration, refused.narration)
  assert.ok(!replay.clarification)
  assert.equal((await state()).players[0].hp, 20)

  for (const [index, action] of [
    'Я не поднимаю весь замок одной рукой',
    'Осматриваю весь замок',
    'Поднимаю замок с пола',
    'Поднимаю весь замок с помощью заклинания',
    'Я не сажусь в огонь',
    'Я сажусь на стул у огня',
    'Сажусь на стул и смотрю на огонь',
    'Не намерен прыгать в огонь',
    'На стене написано «Сажусь в огонь»',
    'Я касаюсь огня на рисунке',
  ].entries()) {
    const result = await say(action, `other-${index}`)
    assert.ok(!result.rejected, action)
    assert.ok(!result.mechanics?.some(event => event.event_type === 'DamageApplied'), action)
  }
  const contact = await say('Я прыгаю прямо в пламя', 'reachable-fire')
  assert.ok(!contact.clarification)
  assert.equal(contact.free_action_outcome, 'hazard_contact')
  assert.ok(contact.mechanics.some(event => event.event_type === 'DamageApplied' && event.payload.damage_type === 'fire'))
  assert.ok((await state()).players[0].hp < 20)
})

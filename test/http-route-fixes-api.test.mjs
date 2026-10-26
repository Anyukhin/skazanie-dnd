import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaign, registerUser, sendCommand, setupAdmin, startTestServer } from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Исправления маршрутов, найденные при переносе на Rust
 * (`docs/rust-port-js-findings.md`, «HTTP-маршруты (С6–С16)»): повтор ключа
 * `/lifecycle` с другим действием, вторая рука через `/commands`, гонка
 * создания кампании, домашние правила всё-или-ничего, `null` вместо версии
 * у торговца и код комнаты общего кубика в нижнем регистре. Тест входит в
 * контракт: проходит и против JS, и против Rust.
 */

const weapon = (id, catalogId, equipped = false) => ({ id, catalog_id: catalogId, name: id, type: 'weapon', quantity: 1, equipped })

function cells(width = 8, height = 6) {
  return Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), type: 'floor', passable: true, revealed: true }))
}

/** @param {string} code */
function importedState(code) {
  return {
    sessionCode: code,
    campaign: 'Две руки',
    partyName: 'Проверка',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero', name: 'Шорох', character: 'Шорох', role: 'Воин', characterClass: 'fighter', species: 'Человек',
      level: 3, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 2,
      abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [weapon('sword', 'srd_5_2_1:shortsword', true), weapon('dagger', 'srd_5_2_1:dagger')], online: true, x: 2, y: 2,
    }],
    scene: { title: 'Зал', location: 'Зал', mood: '', objective: '', turn: 0, cells: cells() },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    engine_mode: 'enforce',
    state_version: 0,
  }
}

const bootstrap = { partyName: 'Двое', slotCount: 2, rulesetId: 'srd_5_2_1', world: {} }

test('lifecycle: другой переход или ключ чужого маршрута под тем же ключом — 409, ключ прототипа — запрещённый переход', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-route-fixes-lifecycle-' })
  await setupAdmin(server)
  const { client: owner } = await registerUser(server, { name: 'Владелец' })
  await createCampaign(owner, { code: 'LIFE-1', bootstrap })
  const path = '/api/campaigns/LIFE-1/lifecycle'

  const paused = await owner.post(path, { action: 'pause', idempotency_key: 'life-key' })
  assert.equal(paused.status, 200, paused.text)
  const again = await owner.post(path, { action: 'PAUSE', idempotency_key: 'life-key' })
  assert.deepEqual([again.status, again.body.lifecycle.status], [200, 'paused'], again.text)
  const resumed = await owner.post(path, { action: 'resume', idempotency_key: 'life-key' })
  assert.deepEqual([resumed.status, resumed.body], [409, { error: 'Этот idempotency_key уже использован для другого действия кампании', code: 'IDEMPOTENCY_CONFLICT' }], resumed.text)
  // Ключ, под которым записан коммит другого маршрута (смена домашнего правила).
  const hands = (await owner.get('/api/campaigns/LIFE-1/settings')).body.ruleset.houseRules.find((/** @type {any} */ rule) => rule.id === 'house:bg3-spell-hands')
  const settings = await owner.patch('/api/campaigns/LIFE-1/settings', { idempotency_key: 'shared', houseRules: { 'house:bg3-spell-hands': !hands.enabled } })
  assert.equal(settings.status, 200, settings.text)
  const foreign = await owner.post(path, { action: 'resume', idempotency_key: 'shared:house-rule:house:bg3-spell-hands' })
  assert.deepEqual([foreign.status, foreign.body.code], [409, 'IDEMPOTENCY_CONFLICT'], foreign.text)
  const state = await owner.get(path)
  assert.equal(state.body.lifecycle.status, 'paused', 'отказ ничего не записал')

  for (const action of ['constructor', '__proto__']) {
    const proto = await owner.post(path, { action, idempotency_key: `proto-${action}` })
    assert.deepEqual([proto.status, proto.body], [409, { error: `Переход lifecycle "paused" → "${action}" запрещён`, code: 'INVALID_CAMPAIGN_TRANSITION' }], proto.text)
  }
})

test('вторая рука через /commands; торговец без версии котировок; общий кубик по коду в нижнем регистре', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-route-fixes-hands-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: 'HANDS-1', state: importedState('HANDS-1') })

  const equipped = await sendCommand(gm, 'HANDS-1', 'off-hand-1', { command_type: 'EquipItem', actor_id: 'hero', item_id: 'dagger', equipped: true, equip_slot: 'off_hand' })
  assert.equal(equipped.status, 200, equipped.text)
  const hero = equipped.body.authoritative_state.players.find((/** @type {any} */ player) => player.id === 'hero')
  const held = hero.inventory.filter((/** @type {any} */ item) => item.equipped).map((/** @type {any} */ item) => `${item.id}:${item.equipped_slot ?? 'main'}`).sort()
  assert.deepEqual(held, ['dagger:off_hand', 'sword:main'])
  const unknown = await sendCommand(gm, 'HANDS-1', 'off-hand-2', { command_type: 'EquipItem', actor_id: 'hero', item_id: 'dagger', equipped: true, slot: 'off_hand' })
  assert.deepEqual([unknown.status, unknown.body.code], [400, 'ITEM_COMMAND_UNKNOWN_FIELD'], unknown.text)

  for (const fields of [{ expected_state_version: null, expectedStateVersion: null }, { expectedStateVersion: null }]) {
    const trade = await sendCommand(gm, 'HANDS-1', `buy-${Object.keys(fields).length}`, { command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'smith', stock_id: 'rope', quantity: 1, ...fields })
    assert.deepEqual([trade.status, trade.body.code], [400, 'EXPECTED_STATE_VERSION_REQUIRED'], trade.text)
  }

  const rolled = await gm.post('/api/rooms/hands-1/dice', { playerId: 'hero', sides: 6 })
  assert.equal(rolled.status, 200, rolled.text)
  assert.equal(rolled.body.roll.sides, 6)
  assert.equal(rolled.body.state.sessionCode, 'HANDS-1')
})

test('создание кампании: из двух одновременных запросов с одним кодом владельцем становится один', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-route-fixes-create-' })
  await setupAdmin(server)
  const { client: first } = await registerUser(server, { name: 'Первый' })
  const { client: second } = await registerUser(server, { name: 'Второй' })
  const body = { code: 'RACE-1', name: 'Гонка', bootstrap }
  const results = await Promise.all([first.post('/api/campaigns', body), second.post('/api/campaigns', body)])
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409], results.map((result) => result.text).join('\n'))
  const loser = results.find((result) => result.status === 409)
  assert.deepEqual(loser?.body, { error: 'Кампания с таким кодом уже существует' })
  const owners = []
  for (const client of [first, second]) {
    const me = await client.get('/api/auth/me')
    const membership = (me.body.user?.campaignMemberships ?? []).find((/** @type {any} */ entry) => entry.campaignId === 'RACE-1')
    if (membership?.role === 'owner') owners.push(membership)
  }
  assert.equal(owners.length, 1)
})

test('домашние правила: набор пишется целиком или никак, повтор ключа с другим значением — 409, две строки летописи', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-route-fixes-rules-' })
  await setupAdmin(server)
  const { client: owner } = await registerUser(server, { name: 'Владелец' })
  await createCampaign(owner, { code: 'RULES-1', bootstrap })
  const path = '/api/campaigns/RULES-1/settings'
  const STRIKE = 'house:bg3-opening-strike'
  const HANDS = 'house:bg3-spell-hands'
  const enabled = async () => Object.fromEntries((await owner.get(path)).body.ruleset.houseRules.map((/** @type {any} */ rule) => [rule.id, rule.enabled]))
  const journal = async () => ((await owner.get('/api/rooms/RULES-1')).body.state.messages ?? []).filter((/** @type {any} */ message) => String(message.id).startsWith('house-rule-'))
  const before = await enabled()
  const linesBefore = (await journal()).length

  const partial = await owner.patch(path, { idempotency_key: 'mixed', houseRules: { [STRIKE]: !before[STRIKE], [HANDS]: 'да' } })
  assert.deepEqual([partial.status, partial.body.code], [400, 'HOUSE_RULE_VALUE_INVALID'], partial.text)
  assert.deepEqual(await enabled(), before, 'первое правило не записано')

  const both = await owner.patch(path, { idempotency_key: 'both', houseRules: { [STRIKE]: !before[STRIKE], [HANDS]: !before[HANDS] } })
  assert.equal(both.status, 200, both.text)
  assert.deepEqual(await enabled(), { ...before, [STRIKE]: !before[STRIKE], [HANDS]: !before[HANDS] })
  const lines = await journal()
  assert.equal(lines.length, linesBefore + 2, 'у каждого правила своя строка летописи')
  assert.equal(new Set(lines.map((/** @type {any} */ line) => line.id)).size, lines.length)

  const same = await owner.patch(path, { idempotency_key: 'both', houseRules: { [STRIKE]: !before[STRIKE] } })
  assert.equal(same.status, 200, same.text)
  const changed = await owner.patch(path, { idempotency_key: 'both', houseRules: { [STRIKE]: before[STRIKE] } })
  assert.deepEqual([changed.status, changed.body.code], [409, 'IDEMPOTENCY_CONFLICT'], changed.text)
  assert.equal((await enabled())[STRIKE], !before[STRIKE])
})

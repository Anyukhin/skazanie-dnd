import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

const CAMPAIGN = 'MASS-CURE-HTTP'
const SETUP_TOKEN = 'mass-cure-http-admin'

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function harness(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-mass-cure-api-'))
  let child = null
  let baseUrl = ''
  let logs = ''
  const stop = async () => {
    if (!child || child.exitCode != null || child.signalCode != null) return
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Тестовый сервер не завершился')), 5_000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.kill()
    })
  }
  t.after(async () => {
    await stop()
    rmSync(storage, { recursive: true, force: true })
  })
  const start = async () => {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
        ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: SETUP_TOKEN, COOKIE_SECURE: 'false', NODE_ENV: 'test', GAME_ENGINE_MODE: 'enforce' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-4_000) })
    child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-4_000) })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode != null || child.signalCode != null) throw new Error(`Сервер завершился: ${logs}`)
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* listener ещё запускается */ }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Сервер не запустился: ${logs}`)
  }
  const request = async (path, { cookie = '', method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const command = (cookie, idempotencyKey, commandBody) => request(`/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie, body: { idempotency_key: idempotencyKey, command: commandBody },
  })
  await start()
  return { request, command, restart: async () => { await stop(); child = null; await start() } }
}

function expectStatus(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify({ code: result.body.code, error: result.body.error }))
  return result.body
}

function clericDocument(name) {
  const baseScores = { str: 10, dex: 12, con: 13, int: 8, wis: 15, cha: 14 }
  return { schema: 'skazanie.character', schema_version: 1, character: {
    character: name, characterClass: 'cleric', species: 'Человек', background: 'Прислужник', backgroundId: 'acolyte',
    level: 1, experience: 0,
    abilities: Object.fromEntries(Object.entries(baseScores).map(([id, value]) => [id, value + 1])),
    abilityGeneration: { policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2,
      method: 'standard_array', baseScores, originBonusProfileId: 'human',
      originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speciesOptionId: 'human' },
    speciesChoices: { 'extra-language': ['dwarvish'] }, backgroundChoices: { tools: [], languages: ['elvish', 'draconic'] },
    starterEquipmentChoices: { armor: ['scale-mail'], weapon: ['mace'], 'ranged-or-simple': ['javelin'], pack: ['priests-pack'] },
    baseSpeed: 30, hitPointIncreases: [], classSkillProficiencies: ['insight', 'religion'],
    selectedFeatureIds: [], knownSpellIds: [], preparedSpellIds: ['healing-word'],
  } }
}

function cellDistance(from, to) {
  return Math.max(Math.abs(Number(from.x) - Number(to.x)), Math.abs(Number(from.y) - Number(to.y))) * 5
}

function choosePoint(state, caster, predicate = () => true) {
  return state.scene.cells.find((cell) => cell.revealed !== false && cell.type !== 'wall'
    && cellDistance(caster, cell) <= 60 && predicate(cell))
}

async function acquireCleric(api, t) {
  const adminResponse = await api.request('/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Тестовый ведущий', email: 'admin@mass-cure.test', password: 'mass-cure-admin-password', setupToken: SETUP_TOKEN,
  } })
  expectStatus(adminResponse, 201)
  const adminCookie = adminResponse.cookie
  const registrationResponse = await api.request('/api/auth/register', { method: 'POST', body: {
    name: 'Игрок лечения', email: 'player@mass-cure.test', password: 'mass-cure-player-password',
  } })
  expectStatus(registrationResponse, 201)
  const playerCookie = registrationResponse.cookie
  const guestRegistration = await api.request('/api/auth/register', { method: 'POST', body: {
    name: 'Второй игрок', email: 'guest@mass-cure.test', password: 'mass-cure-guest-password',
  } })
  expectStatus(guestRegistration, 201)
  const guestCookie = guestRegistration.cookie
  expectStatus(await api.request('/api/campaigns', { method: 'POST', cookie: playerCookie, body: {
    code: CAMPAIGN, name: 'Множественное лечение', bootstrap: { slotCount: 2, startLevel: 11, rulesetId: 'dnd_5e_2014', world: { preset: 'Классическое фэнтези' } },
  } }), 201)
  const invite = expectStatus(await api.request(`/api/campaigns/${CAMPAIGN}/invites`, { method: 'POST', cookie: playerCookie, body: { hero_ids: ['hero-slot-2'] } }), 201)
  expectStatus(await api.request(`/api/campaigns/${CAMPAIGN}/join`, { method: 'POST', cookie: guestCookie, body: { invite_token: invite.token } }))
  const catalog = expectStatus(await api.request('/api/rulesets/dnd_5e_2014/character-creation'))
  const cleric = catalog.classes.find((entry) => entry.id === 'cleric')
  assert.ok(cleric)
  const cantripPool = cleric.spell_selection.spells.filter((spell) => spell.level === 0).map((spell) => spell.id)
  const cantripsForLevel = (level) => cantripPool.slice(0, level >= 10 ? 5 : level >= 4 ? 4 : 3)
  const actorId = 'hero-slot-1'
  expectStatus(await api.command(playerCookie, 'mass-cure-import', { command_type: 'ImportCharacter', actor_id: actorId, document: clericDocument('Иара') }))
  let state = expectStatus(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie: playerCookie })).state
  state = expectStatus(await api.command(playerCookie, 'mass-cure-choices-1', { command_type: 'SetCharacterChoices', actor_id: actorId,
    subclass: cleric.subclasses[0]?.name ?? '', class_skill_proficiencies: ['insight', 'religion'], selected_feature_ids: [] })).authoritative_state
  state = expectStatus(await api.command(playerCookie, 'mass-cure-spells-0', { command_type: 'SetSpellSelections', actor_id: actorId,
    known_spell_ids: cantripsForLevel(1), prepared_spell_ids: ['healing-word'] })).authoritative_state
  for (let expectedLevel = 1; expectedLevel <= 10; expectedLevel += 1) {
    state = expectStatus(await api.command(playerCookie, `mass-cure-level-${expectedLevel}`, { command_type: 'LevelUp', actor_id: actorId, expected_level: expectedLevel })).authoritative_state
    if (expectedLevel === 3 || expectedLevel === 7) {
      const choices = { command_type: 'SetCharacterChoices', actor_id: actorId,
        subclass: state.players.find((entry) => entry.id === actorId)?.subclass ?? cleric.subclasses[0]?.name ?? '',
        class_skill_proficiencies: ['insight', 'religion'], selected_feature_ids: state.players.find((entry) => entry.id === actorId)?.selectedFeatureIds ?? [],
      }
      choices.ability_score_level = expectedLevel + 1, choices.ability_score_increases = ['wis', 'con']
      state = expectStatus(await api.command(playerCookie, `mass-cure-choices-${expectedLevel + 1}`, choices)).authoritative_state
    }
    const prepared = expectedLevel >= 9 ? ['healing-word', 'mass-cure-wounds'] : ['healing-word']
    state = expectStatus(await api.command(playerCookie, `mass-cure-spells-${expectedLevel}`, { command_type: 'SetSpellSelections', actor_id: actorId,
      known_spell_ids: cantripsForLevel(expectedLevel + 1), prepared_spell_ids: prepared })).authoritative_state
  }
  const hero = state.players.find((entry) => entry.id === actorId)
  assert.equal(hero.level, 11)
  assert.equal(hero.characterSetupRequired, false)
  assert.ok(hero.preparedSpellIds.includes('mass-cure-wounds'))
  return { adminCookie, playerCookie, guestCookie, actorId, state }
}

test('HTTP Mass Cure Wounds проходит acquisition, права, ошибки до оплаты, idempotency и restart', { timeout: runnerTimeout(90_000) }, async (t) => {
  const api = await harness(t)
  const { adminCookie, playerCookie, guestCookie, actorId, state: prepared } = await acquireCleric(api, t)
  const room = () => api.request(`/api/rooms/${CAMPAIGN}`, { cookie: playerCookie })
  let state = prepared
  const initialCaster = state.players.find((entry) => entry.id === actorId)
  for (const item of initialCaster.inventory.filter((entry) => entry.equipped === true)) {
    state = expectStatus(await api.command(playerCookie, `mass-cure-unequip-${item.id}`, { command_type: 'EquipItem', actor_id: actorId, item_id: item.id, equipped: false })).authoritative_state
  }
  const caster = state.players.find((entry) => entry.id === actorId)
  const ally = state.players.find((entry) => entry.id !== actorId)
  assert.ok(caster && ally)
  const point = { x: caster.x, y: caster.y }
  assert.ok(cellDistance(ally, point) <= 30)
  const selected = { command_type: 'CastSpell', actor_id: actorId, spell_id: 'mass-cure-wounds',
    to: { x: point.x, y: point.y }, target_ids: [actorId, ally.id], slot_level: 5, casting_resource: 'spell_slots_5' }
  const beforeSlots = prepared.mechanics.resources[actorId].spell_slots_5.current
  const beforeSixthSlots = prepared.mechanics.resources[actorId].spell_slots_6.current

  expectStatus(await api.command(guestCookie, 'mass-cure-foreign', selected), 403)
  const unknownTarget = await api.command(playerCookie, 'mass-cure-unknown-target', { ...selected, target_ids: [ally.id, 'missing-target'] })
  expectStatus(unknownTarget, 400)
  assert.equal(unknownTarget.body.code, 'TARGET_NOT_FOUND')
  const outside = choosePoint(state, caster, (cell) => cellDistance(ally, cell) > 30)
  assert.ok(outside)
  const refused = await api.command(playerCookie, 'mass-cure-outside-area', { ...selected, to: { x: outside.x, y: outside.y } })
  expectStatus(refused, 400)
  const afterRefusal = expectStatus(await room()).state
  assert.equal(afterRefusal.mechanics.resources[actorId].spell_slots_5.current, beforeSlots)

  const first = expectStatus(await api.command(playerCookie, 'mass-cure-cast-once', selected))
  assert.equal(first.mechanics.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(first.authoritative_state.mechanics.resources[actorId].spell_slots_5.current, beforeSlots - 1)
  assert.equal(first.authoritative_state.players.find((entry) => entry.id === actorId).preparedSpellIds.includes('mass-cure-wounds'), true)
  const replay = expectStatus(await api.command(playerCookie, 'mass-cure-cast-once', selected))
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.authoritative_state.mechanics.resources[actorId].spell_slots_5.current, beforeSlots - 1)

  const second = expectStatus(await api.command(playerCookie, 'mass-cure-cast-twice', { ...selected, slot_level: 6, casting_resource: 'spell_slots_6' }))
  assert.equal(second.authoritative_state.mechanics.resources[actorId].spell_slots_5.current, beforeSlots - 1)
  assert.equal(second.authoritative_state.mechanics.resources[actorId].spell_slots_6.current, beforeSixthSlots - 1)
  const exhausted = await api.command(playerCookie, 'mass-cure-cast-exhausted', selected)
  expectStatus(exhausted, 400)
  assert.equal(exhausted.body.code, 'INSUFFICIENT_RESOURCE')

  await api.restart()
  const restored = expectStatus(await room()).state
  assert.equal(restored.players.find((entry) => entry.id === actorId).level, 11)
  assert.equal(restored.mechanics.resources[actorId].spell_slots_5.current, beforeSlots - 1)
  assert.equal(restored.mechanics.resources[actorId].spell_slots_6.current, beforeSixthSlots - 1)
  assert.equal(restored.mechanics.resources[actorId].spell_slots_5.max, prepared.mechanics.resources[actorId].spell_slots_5.max)
  assert.ok(adminCookie)
})

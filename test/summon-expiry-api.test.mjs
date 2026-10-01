import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freePort } from './free-port.mjs'

const SESSION = 'SUMMON-HTTP'
const SETUP_TOKEN = 'summon-http-setup-token'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

function startServer(port, storage, logs) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: SETUP_TOKEN, COOKIE_SECURE: 'false',
      NODE_ENV: 'test', GAME_ENGINE_MODE: 'enforce',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logs.value = `${logs.value}${chunk}`.slice(-4_000) })
  child.stderr.on('data', (chunk) => { logs.value = `${logs.value}${chunk}`.slice(-4_000) })
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Тестовый сервер не завершился')), 5_000)
    child.once('exit', () => { clearTimeout(timeout); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Сервер завершился: ${child.exitCode}\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* слушатель ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Сервер не запустился\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion reports raw body */ }
  return { status: response.status, body: parsed, text, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

function sessionCookie(result) {
  assert.ok(result.cookie, `Нет cookie: ${result.text}`)
  return result.cookie
}

function assertStatus(result, expected, logs) {
  assert.equal(result.status, expected, `${result.text.slice(0, 1_000)}\n${logs()}`)
  assert.ok(result.body && typeof result.body === 'object', result.text)
}

function commandBody(key, command) {
  return { idempotency_key: key, command }
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

test('HTTP: обычный игрок получает Божественное оружие, срок проходит по секундам и переживает restart', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-summon-expiry-api-'))
  const logs = { value: '' }
  let child = null
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  const start = async () => {
    child = startServer(port, storage, logs)
    const health = await waitForHealth(baseUrl, child, () => logs.value)
    assert.equal(health.engineMode, 'enforce')
  }
  await start()

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Summon Admin', email: 'summon-admin@test.local', password: 'summon-admin-password', setupToken: SETUP_TOKEN },
  })
  assertStatus(setup, 201, () => logs.value)
  const adminCookie = sessionCookie(setup)
  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Summon Player', email: 'summon-player@test.local', password: 'summon-player-password' },
  })
  assertStatus(registered, 201, () => logs.value)
  const playerCookie = sessionCookie(registered)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: playerCookie,
    body: { code: SESSION, name: 'HTTP summon expiry', bootstrap: { slotCount: 1, startLevel: 3, rulesetId: 'dnd_5e_2014', world: { preset: 'Классическое фэнтези' } } },
  })
  assertStatus(created, 201, () => logs.value)

  const catalog = await request(baseUrl, '/api/rulesets/dnd_5e_2014/character-creation')
  assertStatus(catalog, 200, () => logs.value)
  const cleric = catalog.body.classes.find((entry) => entry.id === 'cleric')
  assert.ok(cleric)
  const actorId = 'hero-slot-1'
  const cantrips = cleric.spell_selection.spells.filter((spell) => spell.level === 0).slice(0, 3).map((spell) => spell.id)
  const imported = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('acquire-import', { command_type: 'ImportCharacter', actor_id: actorId, document: clericDocument('Жрец HTTP') }),
  })
  assertStatus(imported, 200, () => logs.value)
  const choices = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('acquire-choices', { command_type: 'SetCharacterChoices', actor_id: actorId,
      subclass: cleric.subclasses[0]?.name ?? '', class_skill_proficiencies: ['insight', 'religion'], selected_feature_ids: [] }),
  })
  assertStatus(choices, 200, () => logs.value)
  const firstSpells = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('acquire-spells-1', { command_type: 'SetSpellSelections', actor_id: actorId,
      known_spell_ids: cantrips, prepared_spell_ids: ['healing-word'] }),
  })
  assertStatus(firstSpells, 200, () => logs.value)
  let acquiredState = firstSpells.body.authoritative_state
  for (const expectedLevel of [1, 2]) {
    const levelUp = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
      method: 'POST', cookie: playerCookie,
      body: commandBody(`acquire-level-${expectedLevel}`, { command_type: 'LevelUp', actor_id: actorId, expected_level: expectedLevel }),
    })
    assertStatus(levelUp, 200, () => logs.value)
    acquiredState = levelUp.body.authoritative_state
  }
  const prepared = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('acquire-spells-3', { command_type: 'SetSpellSelections', actor_id: actorId,
      known_spell_ids: [...cantrips, 'spiritual-weapon'], prepared_spell_ids: ['healing-word', 'spiritual-weapon'] }),
  })
  assertStatus(prepared, 200, () => logs.value)
  acquiredState = prepared.body.authoritative_state
  const caster = acquiredState.players.find((entry) => entry.id === actorId)
  assert.equal(caster.level, 3)
  assert.ok(caster.preparedSpellIds.includes('spiritual-weapon'))
  for (const item of caster.inventory.filter((entry) => entry.equipped === true)) {
    const unequip = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
      method: 'POST', cookie: playerCookie,
      body: commandBody(`acquire-unequip-${item.id}`, { command_type: 'EquipItem', actor_id: actorId, item_id: item.id, equipped: false }),
    })
    assertStatus(unequip, 200, () => logs.value)
  }

  const cast = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: playerCookie,
    body: commandBody('cast-spiritual-weapon', {
      command_type: 'CastSpell', actor_id: actorId, spell_id: 'spiritual-weapon',
      to: { x: caster.x, y: caster.y }, slot_level: 2,
    }),
  })
  assertStatus(cast, 200, () => logs.value)
  const summon = cast.body.authoritative_state.actors.find((actor) => actor.kind === 'summon')
  assert.ok(summon, 'обычный игрок должен получить фишку призыва')
  assert.equal(summon.expires_at_seconds, 60)

  const beforeExpiry = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: adminCookie,
    body: commandBody('advance-59', { command_type: 'AdvanceTime', actor_id: actorId, amount: 59, unit: 'second' }),
  })
  assertStatus(beforeExpiry, 200, () => logs.value)
  assert.ok(beforeExpiry.body.authoritative_state.actors.some((actor) => actor.id === summon.id))
  assert.equal(beforeExpiry.body.mechanics.some((event) => event.event_type === 'SummonedCreatureDismissed'), false)

  const expired = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: adminCookie,
    body: commandBody('advance-60', { command_type: 'AdvanceTime', actor_id: actorId, amount: 1, unit: 'second' }),
  })
  assertStatus(expired, 200, () => logs.value)
  assert.equal(expired.body.authoritative_state.actors.some((actor) => actor.id === summon.id), false)
  assert.ok(expired.body.mechanics.some((event) => event.event_type === 'SummonedCreatureDismissed'))
  const playerRoom = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: playerCookie })
  assertStatus(playerRoom, 200, () => logs.value)
  assert.equal(playerRoom.body.state.actors.some((actor) => actor.id === summon.id), false)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  await start()
  const afterRestart = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: playerCookie })
  assertStatus(afterRestart, 200, () => logs.value)
  assert.equal(afterRestart.body.state.actors.some((actor) => actor.id === summon.id), false)
})

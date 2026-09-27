import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SETUP_TOKEN = 'chain-lightning-api-setup-token'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer({ port, storage, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: SETUP_TOKEN,
      GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* listener is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion reports raw body */ }
  return { status: response.status, body: json, text, response }
}

function sessionCookie(result) {
  return result.body ? result.headers?.get?.('set-cookie')?.split(';')[0] : undefined
}

function cookieFrom(result) {
  return result.response?.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-2000)}`)
  assert.ok(result.body && typeof result.body === 'object', `Expected JSON, received: ${result.text}`)
}

async function command(baseUrl, code, cookie, idempotencyKey, commandBody) {
  return request(baseUrl, `/api/campaigns/${code}/commands`, {
    method: 'POST',
    cookie,
    body: { idempotency_key: idempotencyKey, command: commandBody },
  })
}

function wizardDocument(name, knownSpellIds) {
  const baseScores = { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }
  return { schema: 'skazanie.character', schema_version: 1, character: {
    character: name, characterClass: 'wizard', species: 'Человек', background: 'Мудрец', backgroundId: 'sage',
    level: 1, experience: 0, abilities: Object.fromEntries(Object.entries(baseScores).map(([id, value]) => [id, value + 1])), abilityGeneration: {
      policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'standard_array', baseScores,
      originBonusProfileId: 'human', originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speciesOptionId: 'human',
    }, speciesChoices: { 'extra-language': ['dwarvish'] }, backgroundChoices: { tools: [], languages: ['elvish', 'draconic'] },
    starterEquipmentChoices: { weapon: ['dagger'], focus: ['component-pouch'], pack: ['explorers-pack'] }, baseSpeed: 30,
    hitPointIncreases: [], classSkillProficiencies: ['investigation', 'religion'], selectedFeatureIds: [],
    knownSpellIds, preparedSpellIds: ['longstrider'],
  } }
}

function initialState() {
  const cells = Array.from({ length: 40 * 6 }, (_, index) => ({
    x: index % 40, y: Math.floor(index / 40), type: 'floor', revealed: true,
  }))
  const actor = (id, x, dex = 8, y = 0) => ({
    id, name: id, hp: 120, maxHp: 120, armor: 10, speed: 30, alive: true,
    abilities: { str: 10, dex, con: 10, int: 8, wis: 8, cha: 8 }, attackBonus: 0, damageDice: 4, damageBonus: 0, attackRange: 5, x, y,
  })
  return {
    sessionCode: 'CHAIN-LIGHTNING-HTTP', campaign: 'Chain Lightning HTTP', partyMemberIds: ['hero-slot-1'], activePlayerId: 'hero-slot-1',
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', character_start_level: 11,
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [{ id: 'hero-slot-1', name: 'Wave10 owner', character: 'Wave10 wizard', characterClass: 'wizard', level: 1, characterSetupRequired: true, characterSetupStage: 'leveling',
      hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 9, dex: 20, con: 14, int: 16, wis: 12, cha: 10 }, inventory: [], x: 0, y: 0 }],
    enemies: [actor('primary', 20), actor('near', 19), actor('far', 39, 8, 5)],
    scene: { turn: 1, title: 'Chain Lightning HTTP', location: 'chain-lightning-http', cells },
    mechanics: { combat: { active: false, round: 0, active_index: 0, initiative: [], action_economy: {} } }, engine_mode: 'enforce',
  }
}

async function acquireWizard11(baseUrl, code, cookie, catalog, log) {
  const wizard = catalog.classes.find((entry) => entry.id === 'wizard')
  assert.ok(wizard, 'wizard catalog missing')
  const spells = wizard.spell_selection.spells
  const allCantrips = spells.filter((spell) => spell.level === 0).map((spell) => spell.id)
  const firstLevel = spells.filter((spell) => spell.level === 1).map((spell) => spell.id)
  const orderedFirst = ['longstrider', ...firstLevel.filter((id) => id !== 'longstrider')]
  const initialKnown = [...allCantrips.slice(0, 3), ...orderedFirst.slice(0, 6)]
  const send = (key, value) => command(baseUrl, code, cookie, key, value)
  let result = await send('chain-http-import', { command_type: 'ImportCharacter', actor_id: 'hero-slot-1', document: wizardDocument('Wave10 HTTP Wizard', initialKnown) })
  assertStatus(result, 200, log)
  for (let expectedLevel = 1; expectedLevel < 11; expectedLevel += 1) {
    result = await send(`chain-http-level-${expectedLevel}`, { command_type: 'LevelUp', actor_id: 'hero-slot-1', expected_level: expectedLevel })
    assertStatus(result, 200, log)
    const level = expectedLevel + 1
    if ([2, 4, 8].includes(level)) {
      result = await send(`chain-http-choices-${level}`, {
        command_type: 'SetCharacterChoices', actor_id: 'hero-slot-1', subclass: wizard.subclasses[0].name,
        class_skill_proficiencies: ['investigation', 'religion'], selected_feature_ids: [],
        ...(level === 4 || level === 8 ? { ability_score_level: level, ability_score_increases: ['int', 'int'] } : {}),
      })
      assertStatus(result, 200, log)
    }
    const maximumSpellLevel = Math.min(6, Math.floor((level + 1) / 2))
    const bookMinimum = 6 + (level - 1) * 2
    const available = spells.filter((spell) => spell.level > 0 && spell.level <= maximumSpellLevel && spell.id !== 'chain-lightning')
    const knownLimit = bookMinimum - (level === 11 ? 1 : 0)
    const knownLeveled = ['longstrider', ...available.filter((spell) => spell.id !== 'longstrider').slice(0, Math.max(0, knownLimit - 1)).map((spell) => spell.id)]
    if (level === 11) knownLeveled.push('chain-lightning')
    result = await send(`chain-http-spells-${level}`, {
      command_type: 'SetSpellSelections', actor_id: 'hero-slot-1',
      known_spell_ids: [...allCantrips.slice(0, level >= 10 ? 5 : level >= 4 ? 4 : 3), ...knownLeveled],
      prepared_spell_ids: level === 11 ? ['longstrider', 'chain-lightning'] : ['longstrider'],
    })
    assertStatus(result, 200, log)
  }
  const actor = result.body.authoritative_state.players.find((entry) => entry.id === 'hero-slot-1')
  assert.equal(actor.level, 11)
  assert.equal(actor.characterSetupRequired, false)
  assert.ok(actor.knownSpellIds.includes('chain-lightning'))
  assert.ok(actor.preparedSpellIds.includes('chain-lightning'))
  return result.body.authoritative_state
}

test('Chain Lightning HTTP path acquires a wizard legally, casts, denies bad secondary and replays after restart', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-chain-lightning-api-'))
  const setupToken = SETUP_TOKEN
  let logs = ''
  let child = null
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  const log = () => logs
  const launch = async () => {
    child = startServer({ port, storage, appendLog: (chunk) => { logs += chunk } })
    await waitForHealth(baseUrl, child, log)
  }
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  await launch()
  const setup = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Chain HTTP admin', email: 'chain-http-admin@example.test', password: 'chain-http-admin-password', setupToken,
  } })
  assertStatus(setup, 201, log)
  const adminCookie = cookieFrom(setup)
  const registration = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Chain HTTP owner', email: 'chain-http-owner@example.test', password: 'chain-http-owner-password',
  } })
  assertStatus(registration, 201, log)
  const ownerCookie = cookieFrom(registration)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assertStatus(users, 200, log)
  const owner = users.body.users.find((entry) => entry.email === 'chain-http-owner@example.test')
  assert.ok(owner)
  const code = 'CHAIN-HTTP-API'
  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code, name: 'Chain Lightning HTTP', state: initialState() } })
  assertStatus(created, 201, log)
  const assigned = await request(baseUrl, `/api/admin/users/${owner.id}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero-slot-1'] } })
  assertStatus(assigned, 200, log)
  const catalogResult = await request(baseUrl, '/api/rulesets/dnd_5e_2014/character-creation', { cookie: ownerCookie })
  assertStatus(catalogResult, 200, log)
  await acquireWizard11(baseUrl, code, ownerCookie, catalogResult.body, log)
  const started = await command(baseUrl, code, ownerCookie, 'chain-http-start-combat', { command_type: 'StartCombat', actor_id: 'hero-slot-1' })
  assertStatus(started, 200, log)
  const deniedBefore = await request(baseUrl, `/api/rooms/${code}`, { cookie: ownerCookie })
  assertStatus(deniedBefore, 200, log)
  const denied = await command(baseUrl, code, ownerCookie, 'chain-http-denied', {
    command_type: 'CastSpell', actor_id: 'hero-slot-1', spell_id: 'chain-lightning', target_id: 'primary', target_ids: ['primary', 'far'], slot_level: 6,
  })
  assertStatus(denied, 400, log)
  assert.equal(denied.body.code, 'SPELL_TARGETS_TOO_FAR_APART')
  const deniedAfter = await request(baseUrl, `/api/rooms/${code}`, { cookie: ownerCookie })
  assertStatus(deniedAfter, 200, log)
  assert.equal(deniedAfter.body.state.state_version, deniedBefore.body.state.state_version)
  const cast = await command(baseUrl, code, ownerCookie, 'chain-http-cast', {
    command_type: 'CastSpell', actor_id: 'hero-slot-1', spell_id: 'chain-lightning', target_id: 'primary', target_ids: ['primary', 'near'], slot_level: 6,
  })
  assertStatus(cast, 200, log)
  const spellCast = (cast.body.mechanics ?? []).find((entry) => entry.event_type === 'SpellCast')
  assert.ok(spellCast)
  assert.deepEqual(spellCast.target_ids, ['primary', 'near'])
  const replay = await command(baseUrl, code, ownerCookie, 'chain-http-cast', {
    command_type: 'CastSpell', actor_id: 'hero-slot-1', spell_id: 'chain-lightning', target_id: 'primary', target_ids: ['primary', 'near'], slot_level: 6,
  })
  assertStatus(replay, 200, log)
  assert.equal(replay.body.idempotent_replay, true)
  const firstVersion = cast.body.authoritative_state.state_version
  assert.equal(replay.body.authoritative_state.state_version, firstVersion)
  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  await launch()
  const afterRestart = await request(baseUrl, `/api/rooms/${code}`, { cookie: ownerCookie })
  assertStatus(afterRestart, 200, log)
  assert.equal(afterRestart.body.state.state_version, firstVersion)
  const replayAfterRestart = await command(baseUrl, code, ownerCookie, 'chain-http-cast', {
    command_type: 'CastSpell', actor_id: 'hero-slot-1', spell_id: 'chain-lightning', target_id: 'primary', target_ids: ['primary', 'near'], slot_level: 6,
  })
  assertStatus(replayAfterRestart, 200, log)
  assert.equal(replayAfterRestart.body.idempotent_replay, true)
})

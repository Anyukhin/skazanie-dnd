import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const CAMPAIGN = 'TEMPEST-WAVE-HTTP'
const SETUP_TOKEN = 'tempest-wave-http-admin'

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function harness(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-tempest-wave-api-'))
  let child = null
  let baseUrl = ''
  let logs = ''
  const stop = async () => {
    if (!child || child.exitCode != null || child.signalCode != null) return
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server did not stop: ' + logs)), 5_000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.kill()
    })
  }
  const start = async () => {
    const port = await freePort()
    baseUrl = 'http://127.0.0.1:' + port
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
        ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: SETUP_TOKEN, COOKIE_SECURE: 'false', NODE_ENV: 'test', GAME_ENGINE_MODE: 'enforce' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-4_000) })
    child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-4_000) })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode != null || child.signalCode != null) throw new Error('server exited: ' + logs)
      try { if ((await fetch(baseUrl + '/api/health')).ok) return } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('server did not start: ' + logs)
  }
  const request = async (path, { cookie = '', method = 'GET', body } = {}) => {
    const response = await fetch(baseUrl + path, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const setCookie = [...response.headers.entries()].find(([key]) => key.toLowerCase() === 'set-cookie')?.[1]
    return { status: response.status, body: await response.json(), cookie: setCookie?.split(';')[0] }
  }
  const command = (cookie, key, commandBody) => request('/api/campaigns/' + CAMPAIGN + '/commands', {
    method: 'POST', cookie, body: { idempotency_key: key, command: commandBody },
  })
  await start()
  t.after(async () => { await stop(); rmSync(storage, { recursive: true, force: true }) })
  return { request, command }
}

function expectStatus(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify({ code: result.body.code, error: result.body.error }))
  return result.body
}

function clericDocument() {
  const baseScores = { str: 10, dex: 12, con: 13, int: 8, wis: 15, cha: 14 }
  return { schema: 'skazanie.character', schema_version: 1, character: {
    character: 'Буревестник', characterClass: 'cleric', subclass: 'Домен бури', species: 'Человек', background: 'Прислужник', backgroundId: 'acolyte',
    level: 1, experience: 0,
    abilities: Object.fromEntries(Object.entries(baseScores).map(([id, value]) => [id, value + 1])),
    abilityGeneration: { policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2,
      method: 'standard_array', baseScores, originBonusProfileId: 'human',
      originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speciesOptionId: 'human' },
    speciesChoices: { 'extra-language': ['dwarvish'] }, backgroundChoices: { tools: [], languages: ['elvish', 'draconic'] },
    starterEquipmentChoices: { armor: ['scale-mail'], weapon: ['mace'], 'ranged-or-simple': ['javelin'], pack: ['priests-pack'] },
    baseSpeed: 30, hitPointIncreases: [], classSkillProficiencies: ['insight', 'religion'],
    selectedFeatureIds: [], knownSpellIds: ['guidance', 'light', 'mending'], preparedSpellIds: ['healing-word'],
    phbCreation: { schema_version: 1, classChoices: { subclass: 'Домен бури' } },
  } }
}

test('HTTP Tempest cleric 9 reaches Destructive Wave without a grant', { timeout: 120_000 }, async (t) => {
  const api = await harness(t)
  const adminResponse = await api.request('/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Tempest admin', email: 'admin@tempest-wave.test', password: 'tempest-admin-password', setupToken: SETUP_TOKEN,
  } })
  const admin = expectStatus(adminResponse, 201)
  const adminCookie = adminResponse.cookie
  const playerResponse = await api.request('/api/auth/register', { method: 'POST', body: {
    name: 'Tempest player', email: 'player@tempest-wave.test', password: 'tempest-player-password',
  } })
  const player = expectStatus(playerResponse, 201)
  const playerCookie = playerResponse.cookie
  assert.ok(playerCookie, JSON.stringify(player))
  expectStatus(await api.request('/api/campaigns', { method: 'POST', cookie: playerCookie, body: {
    code: CAMPAIGN, name: 'Буря', bootstrap: { slotCount: 1, startLevel: 9, rulesetId: 'dnd_5e_2014', world: { preset: 'Классическое фэнтези' } },
  } }), 201)
  const catalog = expectStatus(await api.request('/api/rulesets/dnd_5e_2014/character-creation'))
  const cleric = catalog.classes.find((entry) => entry.id === 'cleric')
  const tempest = cleric.subclasses.find((entry) => entry.id === 'tempest' || /бур/iu.test(String(entry.name)))
  assert.ok(tempest)
  expectStatus(await api.command(playerCookie, 'tempest-import', { command_type: 'ImportCharacter', actor_id: 'hero-slot-1', document: clericDocument() }))
  let state = expectStatus(await api.command(playerCookie, 'tempest-choices-1', {
    command_type: 'SetCharacterChoices', actor_id: 'hero-slot-1', subclass: tempest.name,
    class_skill_proficiencies: ['insight', 'religion'], selected_feature_ids: [],
  })).authoritative_state
  const cantripPool = cleric.spell_selection.spells.filter((spell) => spell.level === 0).map((spell) => spell.id)
  const cantripsForLevel = (level) => cantripPool.slice(0, level >= 10 ? 5 : level >= 4 ? 4 : 3)
  state = expectStatus(await api.command(playerCookie, 'tempest-spells-1', {
    command_type: 'SetSpellSelections', actor_id: 'hero-slot-1',
    known_spell_ids: cantripsForLevel(1), prepared_spell_ids: ['healing-word'],
  })).authoritative_state
  for (let expectedLevel = 1; expectedLevel <= 8; expectedLevel += 1) {
    state = expectStatus(await api.command(playerCookie, 'tempest-level-' + expectedLevel, {
      command_type: 'LevelUp', actor_id: 'hero-slot-1', expected_level: expectedLevel,
    })).authoritative_state
    if (expectedLevel === 3 || expectedLevel === 7) {
      state = expectStatus(await api.command(playerCookie, 'tempest-asi-' + (expectedLevel + 1), {
        command_type: 'SetCharacterChoices', actor_id: 'hero-slot-1',
        subclass: state.players.find((hero) => hero.id === 'hero-slot-1')?.subclass ?? tempest.name,
        class_skill_proficiencies: ['insight', 'religion'], selected_feature_ids: [],
        ability_score_level: expectedLevel + 1, ability_score_increases: ['wis', 'con'],
      })).authoritative_state
    }
    state = expectStatus(await api.command(playerCookie, 'tempest-spells-' + expectedLevel, {
      command_type: 'SetSpellSelections', actor_id: 'hero-slot-1',
      known_spell_ids: cantripsForLevel(expectedLevel + 1),
      prepared_spell_ids: ['healing-word'],
    })).authoritative_state
  }
  const hero = state.players.find((entry) => entry.id === 'hero-slot-1')
  assert.equal(hero.level, 9)
  assert.equal(hero.characterSetupRequired, false)
  assert.match(String(hero.subclass), /бур/iu)
  const destructive = hero.combatSpells.find((spell) => spell.id === 'destructive-wave')
  assert.ok(destructive?.prepared)
  assert.equal(destructive.mechanicsSupport, 'partial')

  const roomBeforeEncounter = expectStatus(await api.request('/api/rooms/' + CAMPAIGN, { cookie: adminCookie }))
  const encounter = expectStatus(await api.request('/api/campaigns/' + CAMPAIGN + '/encounters/assemble', {
    method: 'POST', cookie: adminCookie, body: {
      idempotency_key: 'tempest-encounter', expected_state_version: roomBeforeEncounter.state.state_version,
      difficulty: 'easy', theme: 'raiders', seed: 'tempest-http',
    },
  }))
  const combatState = encounter.authoritative_state
  assert.equal(combatState.mechanics.combat.active, true)
  const caster = combatState.players.find((entry) => entry.id === 'hero-slot-1')
  const castCommand = {
    command_type: 'CastSpell', actor_id: 'hero-slot-1', spell_id: 'destructive-wave',
    spell_option: 'radiant', target_ids: [caster.id], slot_level: 5, casting_resource: 'spell_slots_5',
  }
  const cast = expectStatus(await api.command(playerCookie, 'tempest-cast', castCommand))
  assert.ok(cast.mechanics.some((event) => event.event_type === 'SpellCast'))
  assert.equal(cast.authoritative_state.mechanics.resources['hero-slot-1'].spell_slots_5.current,
    combatState.mechanics.resources['hero-slot-1'].spell_slots_5.current - 1)
  const repeated = expectStatus(await api.command(playerCookie, 'tempest-cast', castCommand))
  assert.deepEqual(repeated.authoritative_state, cast.authoritative_state)
  assert.deepEqual(repeated.mechanics, cast.mechanics)
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { shortestTacticalPath } from '../server/rules-engine.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CAMPAIGN = 'LONGSTRIDER-HTTP'
const SETUP_TOKEN = 'longstrider-test-admin'
const effects = (state, id) => (state.mechanics.conditions[id] ?? []).filter((effect) => effect.spell_id === 'longstrider')

async function freePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

async function harness(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-longstrider-api-'))
  let child = null
  let baseUrl = ''
  let logs = ''
  let lastRequest = null
  const slowRequests = []
  const stop = async () => {
    if (!child || child.exitCode != null || child.signalCode != null) return
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Тестовый сервер не завершился')), 5_000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.kill()
    })
  }
  t.after(async () => {
    t.diagnostic(JSON.stringify({ lastRequest, slowRequests }))
    await stop()
    rmSync(storage, { recursive: true, force: true })
  })
  const start = async () => {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(), env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port),
        DND_STORAGE_DIR: storage, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: SETUP_TOKEN,
        COOKIE_SECURE: 'false', NODE_ENV: 'test', GAME_ENGINE_MODE: 'enforce' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-3_000) })
    child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-3_000) })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode != null || child.signalCode != null) throw new Error(`Сервер: exit=${child.exitCode}, signal=${child.signalCode}\n${logs}`)
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* запуск слушателя */ }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Сервер не запустился: exit=${child.exitCode}, signal=${child.signalCode}\n${logs}`)
  }
  const request = async (path, { cookie = '', method = 'GET', body } = {}) => {
    const started = performance.now()
    const label = `${method} ${path} ${(body?.commands ?? [body?.command]).filter(Boolean).map((entry) => entry.command_type).join(',')}`.trim()
    lastRequest = label
    try {
      const response = await fetch(`${baseUrl}${path}`, { method, signal: AbortSignal.timeout(30_000),
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
    } finally {
      const elapsed = Math.round(performance.now() - started)
      if (elapsed >= 1_000) slowRequests.push({ request: label, milliseconds: elapsed })
    }
  }
  const command = (cookie, idempotency_key, command) => request(`/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie, body: { idempotency_key, command },
  })
  await start()
  return { request, command, restart: async () => { await stop(); await start() } }
}

function expect(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify({ code: result.body.code, error: result.body.error }))
  return result.body
}

function wizardDocument(name, knownSpellIds) {
  const baseScores = { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }
  return { schema: 'skazanie.character', schema_version: 1, character: {
    character: name, characterClass: 'wizard', species: 'Человек', background: 'Мудрец', backgroundId: 'sage',
    level: 1, experience: 0, abilities: Object.fromEntries(Object.entries(baseScores).map(([id, value]) => [id, value + 1])),
    abilityGeneration: { policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'standard_array',
      baseScores, originBonusProfileId: 'human', originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speciesOptionId: 'human' },
    speciesChoices: { 'extra-language': ['dwarvish'] }, backgroundChoices: { tools: [], languages: ['elvish', 'draconic'] },
    starterEquipmentChoices: { weapon: ['dagger'], focus: ['component-pouch'], pack: ['explorers-pack'] },
    baseSpeed: 30, hitPointIncreases: [], classSkillProficiencies: ['investigation', 'religion'], selectedFeatureIds: [],
    knownSpellIds, preparedSpellIds: ['longstrider'],
  } }
}

async function normalParty(api) {
  const admin = await api.request('/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Тестовый ведущий', email: 'admin@longstrider.test', password: 'longstrider-admin-password', setupToken: SETUP_TOKEN,
  } })
  expect(admin, 201)
  const sessions = []
  for (const index of [1, 2]) {
    const registration = await api.request('/api/auth/register', { method: 'POST', body: {
      name: `Игрок ${index}`, email: `player-${index}@longstrider.test`, password: `longstrider-player-${index}-password`,
    } })
    expect(registration, 201)
    sessions.push(registration.cookie)
  }
  expect(await api.request('/api/campaigns', { method: 'POST', cookie: sessions[0], body: {
    code: CAMPAIGN, name: 'Час Скорохода', bootstrap: { slotCount: 2, startLevel: 3, rulesetId: 'dnd_5e_2014',
      world: { preset: 'Классическое фэнтези' } },
  } }), 201)
  const invite = expect(await api.request(`/api/campaigns/${CAMPAIGN}/invites`, { method: 'POST', cookie: sessions[0], body: { hero_ids: ['hero-slot-2'] } }), 201)
  expect(await api.request(`/api/campaigns/${CAMPAIGN}/join`, { method: 'POST', cookie: sessions[1], body: { invite_token: invite.token } }))
  const catalog = expect(await api.request('/api/rulesets/dnd_5e_2014/character-creation'))
  const wizard = catalog.classes.find((entry) => entry.id === 'wizard')
  const cantrips = wizard.spell_selection.spells.filter((spell) => spell.level === 0).slice(0, 3).map((spell) => spell.id)
  const book = ['longstrider', ...wizard.spell_selection.spells.filter((spell) => spell.level === 1 && spell.id !== 'longstrider').map((spell) => spell.id)]
  for (const [index, session] of sessions.entries()) {
    const actor_id = `hero-slot-${index + 1}`
    expect(await api.command(session, `import-${index}`, { command_type: 'ImportCharacter', actor_id,
      document: wizardDocument(`Маг ${index + 1}`, [...cantrips, ...book.slice(0, 6)]) }))
    for (const expected_level of [1, 2]) {
      expect(await api.command(session, `level-${index}-${expected_level}`, { command_type: 'LevelUp', actor_id, expected_level }))
      const choices = expected_level === 1 ? [{ command_type: 'SetCharacterChoices', actor_id,
        subclass: wizard.subclasses[0].name, class_skill_proficiencies: ['investigation', 'religion'], selected_feature_ids: [] }] : []
      const selected = expect(await api.request(`/api/campaigns/${CAMPAIGN}/commands`, { method: 'POST', cookie: session,
        body: { idempotency_key: `spells-${index}-${expected_level}`, commands: [...choices, { command_type: 'SetSpellSelections', actor_id,
          known_spell_ids: [...cantrips, ...book.slice(0, 6 + expected_level * 2)], prepared_spell_ids: ['longstrider'] }] } }))
      if (expected_level === 2) assert.equal(selected.authoritative_state.players.find((hero) => hero.id === actor_id).characterSetupRequired, false)
    }
  }
  return { admin: admin.cookie, owner: sessions[0], guest: sessions[1] }
}

test('HTTP: два обычных игрока осваивают Скороход, выбирают усиление, повторяют запрос и восстанавливают его после restart', { timeout: runnerTimeout(90_000) }, async (t) => {
  const api = await harness(t)
  const { admin, owner, guest } = await normalParty(api)
  const room = () => api.request(`/api/rooms/${CAMPAIGN}`, { cookie: owner })
  let state = expect(await room()).state
  const caster = state.players.find((hero) => hero.id === 'hero-slot-1')
  const ally = state.players.find((hero) => hero.id === 'hero-slot-2')
  const near = state.scene.cells.find((cell) => Math.max(Math.abs(cell.x - ally.x), Math.abs(cell.y - ally.y)) <= 1
    && Array.isArray(shortestTacticalPath(state, caster.id, cell)))
  assert.ok(near, 'заклинатель должен иметь доступ к союзнику для касания')
  if (near.x !== caster.x || near.y !== caster.y) {
    state = expect(await api.command(owner, 'approach-ally', { command_type: 'MoveActor', actor_id: caster.id, to: { x: near.x, y: near.y } })).authoritative_state
  }
  const command = { command_type: 'CastSpell', actor_id: caster.id, spell_id: 'longstrider',
    target_ids: [caster.id, ally.id], slot_level: 2, casting_resource: 'spell_slots_2' }
  const beforeSlots = state.mechanics.resources[caster.id].spell_slots_2.current
  const forbidden = await api.command(guest, 'foreign-cast', command)
  expect(forbidden, 403)
  const duplicateTargets = await api.command(owner, 'duplicate-targets', { ...command, target_ids: [ally.id, ally.id] })
  expect(duplicateTargets, 400)
  assert.equal(duplicateTargets.body.code, 'INVALID_SPELL_TARGETS')
  const afterRefusal = expect(await room()).state
  assert.equal(afterRefusal.mechanics.resources[caster.id].spell_slots_2.current, beforeSlots)
  assert.equal(effects(afterRefusal, caster.id).length, 0)

  const result = expect(await api.command(owner, 'cast-upcast', command))
  assert.equal(result.mechanics.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(result.authoritative_state.mechanics.resources[caster.id].spell_slots_2.current, beforeSlots - 1)
  for (const id of [caster.id, ally.id]) assert.equal(effects(result.authoritative_state, id).length, 1)
  const expiry = effects(result.authoritative_state, caster.id)[0].expires_at_seconds
  const repeated = expect(await api.command(owner, 'cast-upcast', command))
  assert.equal(repeated.idempotent_replay, true)
  assert.equal(repeated.state_version, result.state_version)
  assert.equal(repeated.authoritative_state.mechanics.resources[caster.id].spell_slots_2.current, beforeSlots - 1)
  assert.deepEqual(effects(repeated.authoritative_state, caster.id), effects(result.authoritative_state, caster.id))
  const observed = expect(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie: guest })).state
  assert.equal(effects(observed, ally.id).length, 1)
  for (const id of [caster.id, ally.id]) {
    assert.equal(observed.mechanics.movement[id].base_speed, 30)
    assert.equal(observed.mechanics.movement[id].current_speed, 40)
  }
  const explorationOrigin = observed.players.find((hero) => hero.id === caster.id)
  const explorationStep = observed.scene.cells.find((cell) => Math.max(Math.abs(cell.x - explorationOrigin.x), Math.abs(cell.y - explorationOrigin.y)) === 1
    && shortestTacticalPath(observed, caster.id, cell)?.length === 1)
  assert.ok(explorationStep, 'после наложения нужен короткий исследовательский путь')
  const explored = expect(await api.command(owner, 'exploration-movement', { command_type: 'MoveActor', actor_id: caster.id,
    to: { x: explorationStep.x, y: explorationStep.y } }))
  assert.equal(explored.mechanics.find((event) => event.event_type === 'TimeAdvanced').payload.elapsed_seconds, 0.75)
  assert.equal(effects(explored.authoritative_state, caster.id)[0].expires_at_seconds, expiry)
  state = explored.authoritative_state
  // Ведущий создаёт встречу штатной командой. Эффект и ресурсы уже получены
  // обычными игроками, никакой готовый бафф в состояние не подставляется.
  const encounter = expect(await api.request(`/api/campaigns/${CAMPAIGN}/encounters/assemble`, { method: 'POST', cookie: admin,
    body: { idempotency_key: 'create-encounter', expected_state_version: state.state_version,
      difficulty: 'easy', theme: 'beasts', seed: 'longstrider-http-lifecycle' } }))
  state = encounter.authoritative_state
  for (let attempt = 0; attempt < 3 && state.mechanics.combat.initiative[state.mechanics.combat.active_index]?.actor_id !== caster.id; attempt += 1) {
    const active = state.mechanics.combat.initiative[state.mechanics.combat.active_index]?.actor_id
    assert.equal(active, ally.id, 'NPC-планировщик должен отдать ход обычному игроку')
    state = expect(await api.command(guest, `yield-guest-${attempt}`, { command_type: 'EndTurn', actor_id: ally.id })).authoritative_state
  }
  assert.equal(state.mechanics.combat.initiative[state.mechanics.combat.active_index].actor_id, caster.id)
  assert.equal(effects(state, caster.id)[0].expires_at_seconds, expiry)
  const origin = state.players.find((hero) => hero.id === caster.id)
  const safeStep = state.scene.cells.find((cell) => Math.max(Math.abs(cell.x - origin.x), Math.abs(cell.y - origin.y)) === 1
    && shortestTacticalPath(state, caster.id, cell)?.length === 1)
  assert.ok(safeStep, 'в тестовой встрече нужен проходимый соседний путь')
  const movementCommands = Array.from({ length: 8 }, (_, index) => {
    const target = index % 2 === 0 ? safeStep : origin
    return { command_type: 'MoveActor', actor_id: caster.id, to: { x: target.x, y: target.y } }
  })
  const moved = expect(await api.request(`/api/campaigns/${CAMPAIGN}/commands`, { method: 'POST', cookie: owner,
    body: { idempotency_key: 'combat-movement', commands: [
      { command_type: 'UseCombatAction', actor_id: caster.id, action_id: 'disengage' }, ...movementCommands,
    ] } }))
  assert.equal(moved.mechanics.filter((event) => event.event_type === 'ActorMoved').length, 8)
  assert.equal(moved.authoritative_state.mechanics.movement[caster.id].movement_spent, 40)
  const exhausted = await api.command(owner, 'combat-too-far', { command_type: 'MoveActor', actor_id: caster.id, to: { x: safeStep.x, y: safeStep.y } })
  expect(exhausted, 400)
  assert.equal(exhausted.body.code, 'SPEED_EXCEEDED')
  const ended = expect(await api.command(admin, 'end-combat', { command_type: 'EndCombat', actor_id: caster.id }))
  assert.equal(ended.authoritative_state.mechanics.combat.active, false)
  assert.equal(effects(ended.authoritative_state, caster.id)[0].expires_at_seconds, expiry)
  await api.restart()
  const restored = expect(await room()).state
  assert.equal(effects(restored, caster.id)[0].expires_at_seconds, expiry)
  assert.equal(restored.mechanics.resources[caster.id].spell_slots_2.current, beforeSlots - 1)
  const readAgain = expect(await room()).state
  assert.deepEqual(readAgain.mechanics.world_time, restored.mechanics.world_time, 'GET не продвигает игровые часы')
  const now = Number(restored.mechanics.world_time.elapsed_minutes) * 60 + Number(restored.mechanics.world_time.second_remainder ?? 0)
  const advanced = expect(await api.command(admin, 'advance-to-boundary', { command_type: 'AdvanceTime', actor_id: caster.id, amount: expiry - now, unit: 'second' }))
  assert.equal(effects(advanced.authoritative_state, caster.id).length, 0)
  assert.equal(effects(advanced.authoritative_state, ally.id).length, 0)
  assert.equal(advanced.authoritative_state.mechanics.movement[caster.id].current_speed, 30)
  const baseMove = expect(await api.command(owner, 'movement-after-expiry', { command_type: 'MoveActor', actor_id: caster.id,
    to: { x: safeStep.x, y: safeStep.y } }))
  assert.equal(baseMove.mechanics.find((event) => event.event_type === 'TimeAdvanced').payload.elapsed_seconds, 1)
  assert.equal(baseMove.authoritative_state.mechanics.movement[caster.id].current_speed, 30)
  assert.equal(effects(baseMove.authoritative_state, caster.id).length, 0)
})

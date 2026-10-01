import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { freePort } from './free-port.mjs'
import { shortestTacticalPath } from '../server/rules-engine.mjs'

const CAMPAIGN = 'SHILLELAGH-API'
const HERO = 'hero-slot-1'
const SETUP_TOKEN = 'shillelagh-api-setup'
const DETERMINISTIC_DICE_PRELOAD = pathToFileURL(join(process.cwd(), 'test', 'fixtures', 'shillelagh-deterministic-dice.mjs')).href

async function startServer(port, storage, log) {
  const child = spawn(process.execPath, ['--import', DETERMINISTIC_DICE_PRELOAD, 'server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ROUTERAI_BASE_URL: '', ADMIN_SETUP_TOKEN: SETUP_TOKEN,
      COOKIE_SECURE: 'false', NODE_ENV: 'test', GAME_ENGINE_MODE: 'enforce',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => log(String(chunk)))
  child.stderr.on('data', (chunk) => log(String(chunk)))
  const baseUrl = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Сервер завершился: ${log()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return { child, baseUrl }
    } catch { /* сервер запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Сервер не запустился: ${log()}`)
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body, key = '' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null, text, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

function expectStatus(result, expected = 200) {
  assert.equal(result.status, expected, `${result.text}`)
  return result.body
}

function command(baseUrl, cookie, key, value) {
  return request(baseUrl, `/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie, key,
    body: { idempotency_key: key, command: value },
  })
}

const INCAPACITATING_CONDITIONS = new Set(['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious'])

function assertHeroCanContinue(state) {
  const hero = state.players?.find((player) => player.id === HERO)
  const fate = state.mechanics?.death?.heroes?.[HERO]
  const conditions = state.mechanics?.conditions?.[HERO] ?? []
  const incapacitated = conditions.some((condition) => INCAPACITATING_CONDITIONS.has(String(condition?.id ?? condition)))
  assert.ok(hero && hero.alive !== false && Number(hero.hp) > 0 && fate?.status !== 'dead' && !incapacitated,
    `Герой ${HERO} выбыл или недееспособен; положительная проверка заклинания невозможна`)
}

function nextMoveToward(state, targetId) {
  const target = state.mechanics?.positions?.[targetId] ?? state.enemies?.find((enemy) => enemy.id === targetId)
  assert.ok(target, `Цель ${targetId} должна иметь авторитетную позицию`)
  const candidates = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    .map(([dx, dy]) => ({ x: Number(target.x) + dx, y: Number(target.y) + dy }))
  const paths = candidates
    .map((destination) => ({ destination, path: shortestTacticalPath(state, HERO, destination) }))
    .filter((entry) => Array.isArray(entry.path) && entry.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length)
  const best = paths[0]
  assert.ok(best, `До цели ${targetId} нет проходимой клетки для сближения`)
  return best.path[Math.min(6, best.path.length) - 1]
}

function druidDocument() {
  const baseScores = { str: 10, dex: 12, con: 13, int: 8, wis: 15, cha: 14 }
  return {
    schema: 'skazanie.character', schema_version: 1,
    character: {
      character: 'Иара', name: 'Игрок', role: 'Друид · ур. 1',
      characterClass: 'druid', species: 'Человек', background: 'Прислужник', backgroundId: 'acolyte',
      level: 1, experience: 0,
      abilities: Object.fromEntries(Object.entries(baseScores).map(([id, value]) => [id, value + 1])),
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2,
        method: 'standard_array', baseScores, originBonusProfileId: 'human',
        originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speciesOptionId: 'human',
      },
      speciesChoices: { 'extra-language': ['dwarvish'] },
      backgroundChoices: { tools: [], languages: ['elvish', 'draconic'] },
      starterEquipmentChoices: { defense: ['wooden-shield'], weapon: ['simple-melee-club'] },
      phbCreation: {
        schema_version: 1, classChoices: {}, equipmentMode: 'standard',
        backgroundEquipmentChoices: { 'prayer-book-or-prayer-wheel': ['prayer-book'] },
      },
      baseSpeed: 30, hitPointIncreases: [], classSkillProficiencies: ['nature', 'perception'],
      selectedFeatureIds: [], knownSpellIds: ['druidcraft', 'shillelagh'], preparedSpellIds: [],
    },
  }
}

test('обычный друид через API получает Shillelagh, держит клуб и сохраняет cast/attack после restart', { timeout: 120_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-shillelagh-api-'))
  let child = null
  let baseUrl = ''
  let logs = ''
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const restart = async () => {
    await stopServer(child)
    const next = await startServer(await freePort(), storage, (chunk) => { if (chunk) logs = `${logs}${chunk}`.slice(-8_000); return logs })
    child = next.child
    baseUrl = next.baseUrl
  }
  const first = await startServer(await freePort(), storage, (chunk) => { if (chunk) logs = `${logs}${chunk}`.slice(-8_000); return logs })
  child = first.child
  baseUrl = first.baseUrl

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST', body: { name: 'Ведущий', email: 'admin@shillelagh-api.test', password: 'secure-admin-password', setupToken: SETUP_TOKEN },
  })
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Иара', email: 'owner@shillelagh-api.test', password: 'secure-owner-password' },
  })
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Гость', email: 'guest@shillelagh-api.test', password: 'secure-guest-password' },
  })
  expectStatus(admin, 201); expectStatus(owner, 201); expectStatus(guest, 201)
  const adminCookie = admin.cookie
  const ownerCookie = owner.cookie
  const guestCookie = guest.cookie

  expectStatus(await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: ownerCookie,
    body: { code: CAMPAIGN, name: 'API Дубинка', bootstrap: { slotCount: 2, startLevel: 1, rulesetId: 'dnd_5e_2014', world: { preset: 'Классическое фэнтези' } } },
  }), 201)
  const invite = expectStatus(await request(baseUrl, `/api/campaigns/${CAMPAIGN}/invites`, {
    method: 'POST', cookie: ownerCookie, body: { hero_ids: ['hero-slot-2'] },
  }), 201)
  expectStatus(await request(baseUrl, `/api/campaigns/${CAMPAIGN}/join`, {
    method: 'POST', cookie: guestCookie, body: { invite_token: invite.token },
  }))

  const imported = expectStatus(await command(baseUrl, ownerCookie, 'druid-import', {
    command_type: 'ImportCharacter', actor_id: HERO, document: druidDocument(),
  }))
  assert.equal(imported.authoritative_state.players.find((actor) => actor.id === HERO).characterClass, 'druid')

  const selected = expectStatus(await command(baseUrl, ownerCookie, 'druid-spells', {
    command_type: 'SetSpellSelections', actor_id: HERO,
    known_spell_ids: ['druidcraft', 'shillelagh'], prepared_spell_ids: [],
  }))
  const selectedHero = selected.authoritative_state.players.find((actor) => actor.id === HERO)
  assert.ok(selectedHero.combatSpells.some((spell) => spell.id === 'shillelagh'))
  const club = selectedHero.inventory.find((item) => item.catalog_id === 'srd_5_2_1:club')
  const shield = selectedHero.inventory.find((item) => item.catalog_id === 'srd_5_2_1:shield')
  assert.ok(club?.equipped, 'starter equipment must provide an equipped club')
  assert.ok(shield?.equipped, 'starter equipment must provide the selected shield')

  const guestDocument = druidDocument()
  guestDocument.character.character = 'Бор'
  guestDocument.character.name = 'Гость'
  expectStatus(await command(baseUrl, guestCookie, 'guest-druid-import', {
    command_type: 'ImportCharacter', actor_id: 'hero-slot-2', document: guestDocument,
  }))
  expectStatus(await command(baseUrl, guestCookie, 'guest-druid-spells', {
    command_type: 'SetSpellSelections', actor_id: 'hero-slot-2',
    known_spell_ids: ['druidcraft', 'shillelagh'], prepared_spell_ids: [],
  }))

  const released = expectStatus(await command(baseUrl, ownerCookie, 'release-shield', {
    command_type: 'EquipItem', actor_id: HERO, item_id: shield.id, equipped: false,
  }))
  assert.equal(released.authoritative_state.players.find((actor) => actor.id === HERO).inventory.find((item) => item.id === club.id).equipped, true)

  const refusal = await command(baseUrl, ownerCookie, 'bad-shillelagh-item', {
    command_type: 'CastSpell', actor_id: HERO, target_id: HERO, spell_id: 'shillelagh', item_id: shield.id,
  })
  expectStatus(refusal, 400)
  assert.equal(refusal.body.code, 'SHILLELAGH_WEAPON_REQUIRED')

  const castCommand = { command_type: 'CastSpell', actor_id: HERO, target_id: HERO, spell_id: 'shillelagh', item_id: club.id }
  const cast = expectStatus(await command(baseUrl, ownerCookie, 'shillelagh-cast', castCommand))
  const spellCast = cast.mechanics.find((event) => event.event_type === 'SpellCast')
  const conditionAdded = cast.mechanics.find((event) => event.event_type === 'ConditionAdded')
  assert.equal(spellCast.payload.item_instance_id, club.id)
  assert.equal(spellCast.payload.spellcasting_ability, 'wis')
  assert.equal(conditionAdded.payload.source_item_id, club.id)
  assert.equal(conditionAdded.payload.timing_version, 2)
  assert.equal(conditionAdded.payload.duration, 'seconds:60')

  const replay = expectStatus(await command(baseUrl, ownerCookie, 'shillelagh-cast', castCommand))
  assert.equal(replay.idempotent_replay, true)

  const foreign = await command(baseUrl, guestCookie, 'foreign-shillelagh', castCommand)
  expectStatus(foreign, 403)
  assert.equal(foreign.body.code, 'ACTOR_FORBIDDEN')

  const afterCast = expectStatus(await request(baseUrl, `/api/rooms/${CAMPAIGN}`, { cookie: ownerCookie }))
  assert.ok(afterCast.state.mechanics.conditions[HERO].some((condition) => condition.id === 'shillelagh' && condition.source_item_id === club.id))

  const beforeEncounter = expectStatus(await request(baseUrl, `/api/rooms/${CAMPAIGN}`, { cookie: adminCookie }))
  const encounter = expectStatus(await request(baseUrl, `/api/campaigns/${CAMPAIGN}/encounters/assemble`, {
    method: 'POST', cookie: adminCookie,
    body: { idempotency_key: 'shillelagh-encounter', expected_state_version: beforeEncounter.state.state_version, difficulty: 'easy', theme: 'beasts', seed: 'shillelagh-api-encounter' },
  }))
  const enemy = encounter.authoritative_state.enemies.find((candidate) => candidate.alive !== false)
  assert.ok(enemy)
  let combatState = encounter.authoritative_state
  for (let round = 0; round < 8; round += 1) {
    assertHeroCanContinue(combatState)
    let transitions = 0
    const maxTransitions = Math.max(2, (combatState.mechanics.combat.initiative?.length ?? 0) * 2)
    while (combatState.mechanics.combat.initiative[combatState.mechanics.combat.active_index]?.actor_id !== HERO) {
      assert.ok(++transitions <= maxTransitions,
        'За один раунд не удалось дождаться хода героя: очередь инициативы не продвигается')
      const active = combatState.mechanics.combat.initiative[combatState.mechanics.combat.active_index]?.actor_id
      assert.ok(active)
      const beforeEndTurnVersion = Number(combatState.state_version)
      const nextCombatState = expectStatus(await command(
        baseUrl,
        adminCookie,
        `shillelagh-end-turn-${beforeEndTurnVersion}-${round}-${active}`,
        { command_type: 'EndTurn', actor_id: active },
      )).authoritative_state
      assert.ok(Number(nextCombatState.state_version) > beforeEndTurnVersion,
        `EndTurn должен продвинуть состояние для ${active}: ${nextCombatState.state_version} после ${beforeEndTurnVersion}`)
      combatState = nextCombatState
      assertHeroCanContinue(combatState)
    }
    const heroPosition = combatState.mechanics.positions?.[HERO] ?? combatState.players.find((actor) => actor.id === HERO)
    const enemyPosition = combatState.mechanics.positions?.[enemy.id] ?? enemy
    const distance = Math.max(Math.abs(Number(heroPosition.x) - Number(enemyPosition.x)), Math.abs(Number(heroPosition.y) - Number(enemyPosition.y))) * 5
    if (distance <= 5) break
    const to = nextMoveToward(combatState, enemy.id)
    const beforeMoveVersion = Number(combatState.state_version)
    combatState = expectStatus(await command(
      baseUrl,
      ownerCookie,
      `shillelagh-approach-${beforeMoveVersion}-${round}`,
      { command_type: 'MoveActor', actor_id: HERO, to },
    )).authoritative_state
    assert.ok(Number(combatState.state_version) > beforeMoveVersion,
      `Перемещение должно продвинуть состояние: ${combatState.state_version} после ${beforeMoveVersion}`)
    const afterMove = combatState.mechanics.positions?.[HERO] ?? combatState.players.find((actor) => actor.id === HERO)
    const afterDistance = Math.max(Math.abs(Number(afterMove.x) - Number(enemyPosition.x)), Math.abs(Number(afterMove.y) - Number(enemyPosition.y))) * 5
    if (afterDistance > 5) {
      const beforeEndTurnVersion = Number(combatState.state_version)
      combatState = expectStatus(await command(
        baseUrl,
        ownerCookie,
        `shillelagh-approach-end-${beforeEndTurnVersion}-${round}`,
        { command_type: 'EndTurn', actor_id: HERO },
      )).authoritative_state
      assert.ok(Number(combatState.state_version) > beforeEndTurnVersion,
        `EndTurn должен продвинуть состояние для ${HERO}: ${combatState.state_version} после ${beforeEndTurnVersion}`)
    }
  }
  assertHeroCanContinue(combatState)
  assert.equal(combatState.mechanics.combat.initiative[combatState.mechanics.combat.active_index]?.actor_id, HERO)
  const attack = expectStatus(await command(baseUrl, ownerCookie, 'shillelagh-attack', {
    command_type: 'MakeAttack', actor_id: HERO, target_id: enemy.id, item_id: club.id,
  }))
  const resolved = attack.mechanics.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.item_id, club.id)
  assert.equal(resolved.payload.attack_ability, 'wis')
  assert.equal(resolved.payload.damage_expression, '1d8+3')
  assert.equal(resolved.payload.magical, true)

  await restart()
  const reopened = expectStatus(await request(baseUrl, `/api/rooms/${CAMPAIGN}`, { cookie: ownerCookie }))
  assert.ok(reopened.state.mechanics.conditions[HERO].some((condition) => condition.id === 'shillelagh' && condition.source_item_id === club.id))
})

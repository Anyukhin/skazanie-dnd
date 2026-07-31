import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { actorPosition, findActor, shortestTacticalPath } from '../server/rules-engine.mjs'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'mvp-player-cycle-setup-token',
      COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited\n${logs()}`)
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) return }
    catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${logs()}`)
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
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion reports text */ }
  return { response, status: response.status, body: parsed, text }
}

const cookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function hero(index) {
  return {
    id: `mvp-hero-${index + 1}`, name: `Игрок ${index + 1}`, character: `Герой ${index + 1}`,
    role: 'Воин · ур. 1', species: 'Человек', background: 'Странник', backstory: 'Ищет пропавший караван.',
    level: 1, hp: 30, maxHp: 30, armor: 18, speed: 30, proficiency: 2,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: index === 0 ? [
      { id: 'mvp-leather', catalog_id: 'srd_5_2_1:leather-armor', name: 'Кожаный доспех', type: 'armor', quantity: 1, weight: 10, equipped: false },
      { id: 'mvp-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Лечебное зелье', type: 'consumable', quantity: 1, weight: 0.5, equipped: false },
      { id: 'mvp-rations', catalog_id: 'srd_5_2_1:rations-one-day', name: 'Рационы', type: 'consumable', quantity: 2, weight: 2, equipped: false },
    ] : [],
    online: true,
    attackBonus: 7, damageDice: 8, damageBonus: 4, damageType: 'slashing', attackRange: 5,
  }
}

function characterDocument(character, experience = 0) {
  const baseScores = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character,
      name: character,
      role: 'Варвар · ур. 1',
      characterClass: 'barbarian',
      species: 'Человек',
      background: 'Солдат',
      level: 1,
      experience,
      abilities: baseScores,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores,
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30,
      hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: [],
      knownSpellIds: [],
      preparedSpellIds: [],
    },
  }
}

function livingEnemies(state) {
  return (state.enemies ?? []).filter((enemy) => enemy.alive !== false)
}

function nearestEnemy(state, actorId) {
  const from = actorPosition(state, actorId)
  if (!from) return null
  return livingEnemies(state).map((enemy) => {
    const to = actorPosition(state, enemy.id)
    return { enemy, distance: to ? Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5 : Infinity }
  }).sort((left, right) => left.distance - right.distance || String(left.enemy.id).localeCompare(String(right.enemy.id)))[0] ?? null
}

function approachPath(state, actorId, targetId) {
  const target = actorPosition(state, targetId)
  if (!target) return null
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => shortestTacticalPath(state, actorId, { x: target.x + dx, y: target.y + dy }))
    .filter((path) => Array.isArray(path)).sort((left, right) => left.length - right.length)[0] ?? null
}

async function playerCommand(baseUrl, cookieValue, key, commandValue) {
  return request(baseUrl, '/api/campaigns/PLAYER-MVP/commands', {
    method: 'POST', cookie: cookieValue, key,
    body: { idempotency_key: key, message: `UI E2E: ${commandValue.command_type}`, command: commandValue },
  })
}

// Сценарий проигрывает целый бой на настоящих случайных костях: длительность
// плавает втрое (замер 2026-07-26 — от 72 до 217 секунд в одиночном прогоне),
// а весь набор идёт с `--test-concurrency=4`, где на процессор претендуют ещё
// три файла. Прежние 240 секунд лежали внутри этого разброса, и тест падал по
// таймауту на длинном бою, а не из-за механики.
/**
 * Сценарий поднимает настоящий сервер, проигрывает случайный по длине бой и
 * несколько раз перезапускает процесс. Локально одиночный прогон занимает
 * 72–338 с, но на общем раннере GitHub, где рядом идут ещё два job'а, тот же
 * сценарий вышел за 600 с и был отменён по таймауту — при зелёном локальном
 * прогоне той же ревизии.
 *
 * Поэтому лимит зависит от среды: на машине разработчика он прежний и ловит
 * зависание, на общем раннере — вдвое больше, потому что там он мерил бы
 * загруженность чужими job'ами, а не поведение кода.
 */
const SHARED_RUNNER = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
const MVP_TIMEOUT_MS = SHARED_RUNNER ? 1_200_000 : 600_000

test('обычные игроки проходят автономную кампанию, полный бой, награды и три сцены', { timeout: MVP_TIMEOUT_MS }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-mvp-player-cycle-'))
  let logs = ''
  let child = null
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Setup only', email: 'setup@mvp.test', password: 'secure-setup-password', setupToken: 'mvp-player-cycle-setup-token',
  } })
  assert.equal(admin.status, 201, admin.text)

  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Owner', email: 'owner@mvp.test', password: 'secure-owner-password',
  } })
  const guest = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Guest', email: 'guest@mvp.test', password: 'secure-guest-password',
  } })
  const guestThree = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Guest Three', email: 'guest-three@mvp.test', password: 'secure-guest-three-password',
  } })
  const guestFour = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Guest Four', email: 'guest-four@mvp.test', password: 'secure-guest-four-password',
  } })
  assert.equal(owner.status, 201, owner.text)
  assert.equal(guest.status, 201, guest.text)
  assert.equal(guestThree.status, 201, guestThree.text)
  assert.equal(guestFour.status, 201, guestFour.text)
  const ownerCookie = cookie(owner)
  const guestCookie = cookie(guest)
  const guestThreeCookie = cookie(guestThree)
  const guestFourCookie = cookie(guestFour)

  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: ownerCookie, body: {
    code: 'PLAYER-MVP', name: 'Игроки и автономный режиссёр',
    bootstrap: { partyName: 'Четверо', world: { preset: 'Классическое фэнтези' }, players: [0, 1, 2, 3].map(hero) },
  } })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.state.players.length, 4)
  assert.deepEqual(created.body.user.campaignMemberships[0].heroIds, ['mvp-hero-1'])
  assert.equal(created.body.state.worldMemory.quests.length >= 1, true)
  assert.equal(created.body.state.social.npcs.length >= 1, true)

  const unauthorizedRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(unauthorizedRoom.status, 403, unauthorizedRoom.text)
  const bareJoin = await request(baseUrl, '/api/campaigns/PLAYER-MVP/join', { method: 'POST', cookie: guestCookie, body: {} })
  assert.equal(bareJoin.status, 400, bareJoin.text)

  const joinHero = async (heroId, cookieValue) => {
    const issued = await request(baseUrl, '/api/campaigns/PLAYER-MVP/invites', {
      method: 'POST', cookie: ownerCookie, body: { hero_ids: [heroId] },
    })
    assert.equal(issued.status, 201, issued.text)
    const joined = await request(baseUrl, '/api/campaigns/PLAYER-MVP/join', {
      method: 'POST', cookie: cookieValue, body: { invite_token: issued.body.token },
    })
    assert.equal(joined.status, 200, joined.text)
    assert.deepEqual(joined.body.hero_ids, [heroId])
    return { issued, joined }
  }
  const { issued: invite } = await joinHero('mvp-hero-2', guestCookie)
  await joinHero('mvp-hero-3', guestThreeCookie)
  await joinHero('mvp-hero-4', guestFourCookie)
  const joinedAgain = await request(baseUrl, '/api/campaigns/PLAYER-MVP/join', {
    method: 'POST', cookie: guestCookie, body: { invite_token: invite.body.token },
  })
  assert.equal(joinedAgain.status, 200, joinedAgain.text)
  assert.equal(joinedAgain.body.duplicate, true)

  const ownerRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: ownerCookie })
  const guestRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(ownerRoom.status, 200, ownerRoom.text)
  assert.equal(guestRoom.status, 200, guestRoom.text)
  assert.equal(ownerRoom.body.state.state_version, guestRoom.body.state.state_version)

  const heroCookies = new Map([
    ['mvp-hero-1', ownerCookie],
    ['mvp-hero-2', guestCookie],
    ['mvp-hero-3', guestThreeCookie],
    ['mvp-hero-4', guestFourCookie],
  ])
  for (let index = 1; index <= 4; index += 1) {
    const actorId = `mvp-hero-${index}`
    const imported = await playerCommand(baseUrl, heroCookies.get(actorId), `initial-import-${index}`, {
      command_type: 'ImportCharacter',
      actor_id: actorId,
      document: characterDocument(`Герой ${index}`),
    })
    assert.equal(imported.status, 200, imported.text)
    assert.equal(imported.body.authoritative_state.players.find((player) => player.id === actorId).characterSetupRequired, false)
  }

  const retiredRoomWrite = await request(baseUrl, '/api/rooms/PLAYER-MVP', {
    method: 'PUT', cookie: ownerCookie,
    body: { state: ownerRoom.body.state, baseVersion: ownerRoom.body.version },
  })
  assert.equal(retiredRoomWrite.status, 410, retiredRoomWrite.text)
  assert.equal(retiredRoomWrite.body.code, 'ROOM_MUTATION_RETIRED')

  const characterKey = 'character-build-1'
  const characterChoice = await playerCommand(baseUrl, ownerCookie, characterKey, {
    command_type: 'SetCharacterChoices', actor_id: 'mvp-hero-1',
    subclass: '', class_skill_proficiencies: ['athletics', 'perception'],
    selected_feature_ids: [],
  })
  assert.equal(characterChoice.status, 200, characterChoice.text)
  const builtHero = characterChoice.body.authoritative_state.players.find((player) => player.id === 'mvp-hero-1')
  assert.deepEqual(builtHero.classSkillProficiencies, ['athletics', 'perception'])
  assert.deepEqual(builtHero.selectedFeatureIds, [])

  const characterReplayMismatch = await playerCommand(baseUrl, ownerCookie, characterKey, {
    command_type: 'SetCharacterChoices', actor_id: 'mvp-hero-1',
    subclass: '', class_skill_proficiencies: ['nature', 'survival'],
    selected_feature_ids: [],
  })
  assert.equal(characterReplayMismatch.status, 409, characterReplayMismatch.text)

  const forgedItemOwner = await playerCommand(baseUrl, guestCookie, 'item-owner-forgery', {
    command_type: 'EquipItem', actor_id: 'mvp-hero-1', item_id: 'mvp-hero-1-starter-longsword', equipped: false,
  })
  assert.equal(forgedItemOwner.status, 403, forgedItemOwner.text)

  const unequippedItem = await playerCommand(baseUrl, ownerCookie, 'item-unequip-1', {
    command_type: 'EquipItem', actor_id: 'mvp-hero-1', item_id: 'mvp-hero-1-starter-longsword', equipped: false,
  })
  assert.equal(unequippedItem.status, 200, unequippedItem.text)
  assert.equal(unequippedItem.body.authoritative_state.players.find((player) => player.id === 'mvp-hero-1').inventory.find((item) => item.id === 'mvp-hero-1-starter-longsword').equipped, false)
  const equippedItem = await playerCommand(baseUrl, ownerCookie, 'item-equip-1', {
    command_type: 'EquipItem', actor_id: 'mvp-hero-1', item_id: 'mvp-hero-1-starter-longsword', equipped: true,
  })
  assert.equal(equippedItem.status, 200, equippedItem.text)
  assert.equal(equippedItem.body.authoritative_state.players.find((player) => player.id === 'mvp-hero-1').inventory.find((item) => item.id === 'mvp-hero-1-starter-longsword').equipped, true)

  const importDocument = characterDocument('Герой 1', 225)
  const importedCharacter = await playerCommand(baseUrl, ownerCookie, 'character-import-1', {
    command_type: 'ImportCharacter', actor_id: 'mvp-hero-1', document: importDocument,
  })
  assert.equal(importedCharacter.status, 200, importedCharacter.text)
  const importedHero = importedCharacter.body.authoritative_state.players.find((player) => player.id === 'mvp-hero-1')
  assert.equal(importedHero.characterClass, 'barbarian')
  assert.equal(importedHero.experience, 225)
  assert.equal(importedHero.proficiency, 2)
  assert.equal(importedHero.inventory.find((item) => item.id === 'mvp-hero-1-starter-longsword').equipped, true)
  const forgedImport = await playerCommand(baseUrl, ownerCookie, 'character-import-forged', {
    command_type: 'ImportCharacter', actor_id: 'mvp-hero-1',
    document: { ...importDocument, character: { ...importDocument.character, hp: 999, gold: 999 } },
  })
  assert.equal(forgedImport.status, 400, forgedImport.text)
  assert.equal(forgedImport.body.code, 'IMPORT_UNKNOWN_FIELD')

  const forgedIntent = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/intents', {
    method: 'POST', cookie: ownerCookie, key: 'forged-player-intent',
    body: { type: 'request_encounter', theme: 'beasts', difficulty: 'deadly' },
  })
  assert.equal(forgedIntent.status, 403, forgedIntent.text)

  const intentTypes = []
  let resolvedChecks = 0
  for (let turn = 1; turn <= 4; turn += 1) {
    const key = `player-director-${turn}`
    const advanced = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/advance', {
      method: 'POST', cookie: ownerCookie, key, body: { idempotency_key: key, player_action: 'Продолжить приключение' },
    })
    assert.equal(advanced.status, 200, advanced.text)
    assert.equal(advanced.body.admin_commands, 0)
    intentTypes.push(advanced.body.intent.type)
    if (turn === 1) {
      const duplicate = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/advance', {
        method: 'POST', cookie: ownerCookie, key, body: { idempotency_key: key, player_action: 'Повтор сети' },
      })
      assert.equal(duplicate.status, 200, duplicate.text)
      assert.equal(duplicate.body.duplicate, true)
      assert.equal(duplicate.body.state_version, advanced.body.state_version)
    }
    const playerActions = turn === 1
      ? ['Я внимательно осматриваю следы и ищу скрытый проход.']
      : turn === 2
        ? ['Я убеждаю Миру Ветрокрыл рассказать всё, что она знает.', 'Я запугиваю Миру Ветрокрыл, требуя назвать источник угрозы.']
        : []
    let actionState = advanced.body.state
    for (let actionIndex = 0; actionIndex < playerActions.length; actionIndex += 1) {
      const activeId = String(actionState.activePlayerId)
      const activeCookie = heroCookies.get(activeId)
      const action = playerActions[actionIndex]
      const narrated = await request(baseUrl, '/api/narrate', {
        method: 'POST', cookie: activeCookie,
        body: { action, campaignId: 'PLAYER-MVP', idempotency_key: `player-check-${turn}-${actionIndex + 1}` },
      })
      assert.equal(narrated.status, 200, narrated.text)
      assert.ok(narrated.body.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), `action did not resolve a server check: ${action}; ${JSON.stringify(narrated.body)}`)
      resolvedChecks += 1
      actionState = narrated.body.authoritative_state
      if (turn === 2 && actionIndex === 0) {
        const dialogueVersion = actionState.state_version
        const dialogueCount = actionState.social.conversations.length
        await stopServer(child)
        child = null
        port = await freePort()
        baseUrl = `http://127.0.0.1:${port}`
        child = startServer(port, storage, (chunk) => { logs += chunk })
        await waitForHealth(baseUrl, child, () => logs)
        const restoredDialogue = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: activeCookie })
        assert.equal(restoredDialogue.status, 200, restoredDialogue.text)
        assert.equal(restoredDialogue.body.state.state_version, dialogueVersion)
        assert.equal(restoredDialogue.body.state.social.conversations.length, dialogueCount)
        actionState = restoredDialogue.body.state
      }
    }
  }
  assert.equal(resolvedChecks, 3)
  assert.deepEqual(intentTypes, ['continue_exploration', 'open_social_scene', 'advance_quest_clock', 'request_encounter'])

  const combatRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(combatRoom.status, 200, combatRoom.text)
  assert.equal(combatRoom.body.state.players.length, 4)
  assert.ok(combatRoom.body.state.enemies.length >= 3, `expected at least three enemies, received ${combatRoom.body.state.enemies.length}`)
  assert.equal(combatRoom.body.state.mechanics.combat.active, true)
  assert.ok(combatRoom.body.state.mechanics.combat.initiative.length >= 7)

  const stableCombat = structuredClone(combatRoom.body.state.mechanics.combat)
  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const restored = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(restored.status, 200, restored.text)
  assert.deepEqual(restored.body.state.mechanics.combat, stableCombat)
  assert.equal(restored.body.state.enemies.length, combatRoom.body.state.enemies.length)
  assert.equal(restored.body.state.players.find((player) => player.id === 'mvp-hero-1').inventory.find((item) => item.id === 'mvp-hero-1-starter-longsword').equipped, true)
  const repeatedRead = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(repeatedRead.body.version, restored.body.version, 'GET must not mutate the room projection')
  assert.deepEqual(repeatedRead.body.state.mechanics.combat, restored.body.state.mechanics.combat)

  let battleState = restored.body.state
  const combatEvents = []
  let midCombatRestarted = false
  const restoredActorId = String(battleState.mechanics.combat.initiative[battleState.mechanics.combat.active_index]?.actor_id ?? '')
  if (!(battleState.players ?? []).some((heroEntry) => heroEntry.id === restoredActorId)) {
    const ticked = await request(baseUrl, '/api/campaigns/PLAYER-MVP/system-tick', { method: 'POST', cookie: guestCookie })
    assert.equal(ticked.status, 200, ticked.text)
    battleState = ticked.body.state
  }
  let commandIndex = 0
  let playerTurns = 0
  const cookieFor = (actorId) => heroCookies.get(actorId)
  for (let attempt = 0; attempt < 160 && battleState.mechanics.combat.active; attempt += 1) {
    const combat = battleState.mechanics.combat
    if (combat.reaction_window) {
      const reactionActorId = String(combat.reaction_window.actor_id ?? '')
      const declined = await playerCommand(baseUrl, cookieFor(reactionActorId), `player-reaction-${++commandIndex}`, {
        command_type: 'UseCombatAction', actor_id: reactionActorId, action_id: 'decline-reaction',
      })
      assert.equal(declined.status, 200, declined.text)
      combatEvents.push(...(declined.body.mechanics ?? []))
      battleState = declined.body.authoritative_state
      continue
    }
    const actorId = String(combat.initiative[combat.active_index]?.actor_id ?? '')
    const current = findActor(battleState, actorId)
    assert.ok(current, `active actor ${actorId} must exist`)
    assert.ok((battleState.players ?? []).some((heroEntry) => heroEntry.id === actorId), `NPC scheduler left enemy ${actorId} for the browser client`)
    const actorCookie = cookieFor(actorId)

    if (Number(current.hp) > 0 && current.alive !== false) {
      const conditions = battleState.mechanics.conditions?.[actorId] ?? []
      const prone = conditions.some((entry) => String(entry?.id ?? entry) === 'prone')
      if (prone) {
        const stoodUp = await playerCommand(baseUrl, actorCookie, `player-stand-up-${++commandIndex}`, {
          command_type: 'UseCombatAction', actor_id: actorId, action_id: 'stand-up',
        })
        assert.equal(stoodUp.status, 200, stoodUp.text)
        combatEvents.push(...(stoodUp.body.mechanics ?? []))
        battleState = stoodUp.body.authoritative_state
      }
      const raging = conditions.some((entry) => String(entry?.id ?? entry) === 'raging')
      const bonusReady = combat.action_economy?.[actorId]?.bonus_action !== false
      if (!raging && bonusReady) {
        const rage = await playerCommand(baseUrl, actorCookie, `player-rage-${++commandIndex}`, {
          command_type: 'UseCombatAction', actor_id: actorId, action_id: 'rage',
        })
        if (rage.status === 200) {
          combatEvents.push(...(rage.body.mechanics ?? []))
          battleState = rage.body.authoritative_state
        } else {
          assert.equal(rage.body?.code, 'RESOURCE_DEPLETED', rage.text)
        }
      }
      let target = nearestEnemy(battleState, actorId)
      if (target && target.distance > 5) {
        const path = approachPath(battleState, actorId, target.enemy.id)
        const spent = Number(combat.action_economy?.[actorId]?.movement_spent ?? 0)
        const availableSteps = Math.max(0, Math.floor((Number(current.speed) || 30) / 5) - Math.floor(spent / 5))
        if (path?.length && availableSteps > 0) {
          const to = path[Math.min(path.length, availableSteps) - 1]
          const moved = await playerCommand(baseUrl, actorCookie, `player-move-${++commandIndex}`, {
            command_type: 'MoveActor', actor_id: actorId, to,
          })
          if (moved.status === 200) {
            combatEvents.push(...(moved.body.mechanics ?? []))
            battleState = moved.body.authoritative_state
            target = nearestEnemy(battleState, actorId)
          } else {
            // The step count above is a client-side guess and is not
            // authoritative: the server routes around creatures that moved in
            // between, and charges extra for crawling, difficult terrain and
            // reduced speed.  Both refusals below are the server correctly
            // rejecting that guess; neither may change the state.
            assert.ok(
              ['INVALID_DESTINATION', 'SPEED_EXCEEDED', 'PATH_BLOCKED'].includes(moved.body.code),
              `неожиданный отказ на перемещение: ${moved.text}`,
            )
            const afterRefusal = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: actorCookie })
            assert.equal(afterRefusal.status, 200, afterRefusal.text)
            assert.deepEqual(
              actorPosition(afterRefusal.body.state, actorId),
              actorPosition(battleState, actorId),
              'отклонённое перемещение не имеет права сдвинуть героя',
            )
          }
        }
      }
      const actionReady = battleState.mechanics.combat.action_economy?.[actorId]?.action !== false
      let attacked = null
      if (battleState.mechanics.combat.active && actionReady) {
        const from = actorPosition(battleState, actorId)
        const candidates = livingEnemies(battleState).map((enemy) => {
          const to = actorPosition(battleState, enemy.id)
          const distance = from && to ? Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5 : Infinity
          return { enemy, distance }
        }).filter((candidate) => candidate.distance === 5)
          .sort((left, right) => left.distance - right.distance)
        for (const candidate of candidates) {
          const attempted = await playerCommand(baseUrl, actorCookie, `player-attack-${++commandIndex}`, {
            command_type: 'MakeAttack', actor_id: actorId, target_id: candidate.enemy.id,
            item_id: `${actorId}-starter-longsword`,
          })
          if (attempted.status === 200) {
            attacked = attempted
            break
          }
          assert.ok(['TARGET_OUT_OF_RANGE', 'TRAJECTORY_BLOCKED'].includes(attempted.body?.code), attempted.text)
        }
      }
      if (attacked) {
        combatEvents.push(...(attacked.body.mechanics ?? []))
        battleState = attacked.body.authoritative_state
        playerTurns += 1
        if (!midCombatRestarted && battleState.mechanics.combat.active) {
          const committedVersion = battleState.state_version
          const committedCombat = structuredClone(battleState.mechanics.combat)
          const committedEnemies = structuredClone(battleState.enemies)
          const committedHp = battleState.players.map((entry) => [entry.id, entry.hp])
          await stopServer(child)
          child = null
          port = await freePort()
          baseUrl = `http://127.0.0.1:${port}`
          child = startServer(port, storage, (chunk) => { logs += chunk })
          await waitForHealth(baseUrl, child, () => logs)
          const midCombat = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: actorCookie })
          assert.equal(midCombat.status, 200, midCombat.text)
          assert.equal(midCombat.body.state.state_version, committedVersion)
          assert.deepEqual(midCombat.body.state.mechanics.combat, committedCombat)
          assert.deepEqual(midCombat.body.state.enemies, committedEnemies)
          assert.deepEqual(midCombat.body.state.players.map((entry) => [entry.id, entry.hp]), committedHp)
          battleState = midCombat.body.state
          midCombatRestarted = true
        }
      }
    }

    const actorFate = battleState.mechanics.death?.heroes?.[actorId]
    if (battleState.mechanics.combat.active && actorFate?.status === 'dead') {
      const resurrected = await playerCommand(baseUrl, actorCookie, `player-resurrect-${++commandIndex}`, {
        command_type: 'ResolveHeroDeath', actor_id: actorId, resolution: 'resurrect',
      })
      assert.equal(resurrected.status, 200, resurrected.text)
      combatEvents.push(...(resurrected.body.mechanics ?? []))
      battleState = resurrected.body.authoritative_state
      continue
    }
    if (battleState.mechanics.combat.active) {
      const endedTurn = await playerCommand(baseUrl, actorCookie, `player-end-turn-${++commandIndex}`, {
        command_type: 'EndTurn', actor_id: actorId,
      })
      if (endedTurn.status === 400 && endedTurn.body?.code === 'HERO_DEAD_UNRESOLVED') {
        const resurrected = await playerCommand(baseUrl, actorCookie, `player-resurrect-${++commandIndex}`, {
          command_type: 'ResolveHeroDeath', actor_id: actorId, resolution: 'resurrect',
        })
        assert.equal(resurrected.status, 200, resurrected.text)
        combatEvents.push(...(resurrected.body.mechanics ?? []))
        battleState = resurrected.body.authoritative_state
        continue
      }
      assert.equal(endedTurn.status, 200, endedTurn.text)
      combatEvents.push(...(endedTurn.body.mechanics ?? []))
      battleState = endedTurn.body.authoritative_state
    }
  }
  assert.equal(battleState.mechanics.combat.active, false, 'browser-compatible player commands must finish combat')
  assert.ok(playerTurns >= 3, `expected a tactical fight, received ${playerTurns} attacking turns`)
  assert.equal(midCombatRestarted, true, 'combat must survive a restart after at least one committed attack')
  assert.equal(livingEnemies(battleState).length, 0, 'the party must win the mandatory encounter')
  for (const hero of battleState.players ?? []) {
    if (battleState.mechanics.death?.heroes?.[hero.id]?.status !== 'dead') continue
    const resurrected = await playerCommand(baseUrl, cookieFor(hero.id), `player-post-combat-resurrect-${++commandIndex}`, {
      command_type: 'ResolveHeroDeath', actor_id: hero.id, resolution: 'resurrect',
    })
    assert.equal(resurrected.status, 200, resurrected.text)
    assert.ok(resurrected.body.mechanics.some((event) => event.event_type === 'HeroResurrected'))
    combatEvents.push(...(resurrected.body.mechanics ?? []))
    battleState = resurrected.body.authoritative_state
    assert.notEqual(battleState.mechanics.death?.heroes?.[hero.id]?.status, 'dead')
  }
  const uniqueCombatEvents = combatEvents.filter((event, index, all) => all.findIndex((candidate) => candidate.event_id === event.event_id) === index)
  const combatRolls = uniqueCombatEvents.filter((event) => event.event_type === 'DieRolled')
  const hpChanges = uniqueCombatEvents.filter((event) => ['DamageApplied', 'HealingApplied'].includes(event.event_type))
  assert.ok(combatRolls.length > 0)
  assert.ok(hpChanges.length > 0)
  for (const event of combatRolls) {
    assert.ok(event.payload.roll_id, `roll ${event.event_id} has no durable roll_id`)
    assert.ok(event.command_id, `roll ${event.event_id} has no command provenance`)
    assert.ok(event.source_rule_ids.length > 0, `roll ${event.event_id} has no rule provenance`)
  }
  const enemyIds = new Set((battleState.enemies ?? []).map((enemy) => enemy.id))
  for (const event of hpChanges) {
    const targetIsEnemy = (event.target_ids ?? []).some((id) => enemyIds.has(id))
    if (targetIsEnemy) {
      assert.equal(event.payload.hp_before, undefined, `enemy HP leaked from ${event.event_id}`)
      assert.equal(event.payload.hp_after, undefined, `enemy HP leaked from ${event.event_id}`)
    } else {
      assert.ok(Number.isFinite(event.payload.hp_before), `HP event ${event.event_id} has no hp_before`)
      assert.ok(Number.isFinite(event.payload.hp_after), `HP event ${event.event_id} has no hp_after`)
    }
    assert.ok(event.command_id, `HP event ${event.event_id} has no command provenance`)
    assert.ok(event.source_rule_ids.length > 0, `HP event ${event.event_id} has no rule provenance`)
  }

  const continued = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/advance', {
    method: 'POST', cookie: ownerCookie, key: 'player-after-combat',
    body: { idempotency_key: 'player-after-combat', player_action: 'Забрать добычу, восстановиться и продолжить путь' },
  })
  assert.equal(continued.status, 200, continued.text)
  assert.equal(continued.body.admin_commands, 0)
  assert.equal(continued.body.intent.type, 'end_scene')
  assert.ok(continued.body.reward)
  assert.ok(continued.body.reward.xp > 0)
  assert.ok(continued.body.reward.loot.length >= 1)
  assert.ok(continued.body.state.players.some((entry) => entry.inventory.some((item) => String(item.id).startsWith('loot-'))))
  const completedTravel = continued.body.state.autonomy.travel_history.at(-1)
  assert.ok(completedTravel?.duration_minutes > 0)
  // Если бой закончился с героем на 0 ОЗ, отряд сначала ждёт его пробуждения
  // (1d4 часа, не больше четырёх), и только потом отдыхает восемь часов.
  const downtimeMinutes = continued.body.state.autonomy.downtime_history.at(-1)?.duration_minutes
  assert.ok([480, 720].includes(downtimeMinutes), `неожиданная длительность отдыха: ${downtimeMinutes}`)
  assert.equal(continued.body.state.mechanics.world_time.elapsed_minutes, downtimeMinutes + completedTravel.duration_minutes)
  assert.ok(
    continued.body.state.players
      .filter((entry) => continued.body.state.mechanics.death?.heroes?.[entry.id]?.status !== 'dead')
      .every((entry) => entry.hp === entry.maxHp),
    'post-combat long rest must restore every surviving hero',
  )
  assert.equal(continued.body.state.adventure.chapter, 2)

  const levelCandidate = continued.body.state.players.find((entry) => entry.id === 'mvp-hero-1')
  assert.ok(levelCandidate.experience >= 300, `expected enough XP for level 2, received ${levelCandidate.experience}`)
  const leveled = await playerCommand(baseUrl, ownerCookie, 'character-level-up-1', {
    command_type: 'LevelUp', actor_id: 'mvp-hero-1', expected_level: 1,
  })
  assert.equal(leveled.status, 200, leveled.text)
  const leveledHero = leveled.body.authoritative_state.players.find((entry) => entry.id === 'mvp-hero-1')
  assert.equal(leveledHero.level, 2)
  assert.equal(leveledHero.proficiency, 2)
  assert.ok(leveled.body.mechanics.some((event) => event.event_type === 'CharacterLeveledUp'))

  const peacefulIntents = []
  let peacefulState = leveled.body.authoritative_state
  for (let step = 1; step <= 6 && peacefulState.adventure.chapter < 3; step += 1) {
    const key = `player-peaceful-scene-${step}`
    const advanced = await request(baseUrl, '/api/campaigns/PLAYER-MVP/autonomy/advance', {
      method: 'POST', cookie: ownerCookie, key, body: { idempotency_key: key, player_action: 'Продолжить расследование без нового боя' },
    })
    assert.equal(advanced.status, 200, advanced.text)
    peacefulIntents.push(advanced.body.intent.type)
    peacefulState = advanced.body.state
  }
  assert.equal(peacefulState.adventure.chapter, 3)
  assert.equal(peacefulIntents.includes('request_encounter'), false, 'second encounter must remain avoidable')
  const finalGuestRoom = await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })
  assert.equal(finalGuestRoom.status, 200, finalGuestRoom.text)
  assert.equal(finalGuestRoom.body.state.adventure.chapter, 3)
  assert.equal(finalGuestRoom.body.state.state_version, peacefulState.state_version)

  const completed = await request(baseUrl, '/api/campaigns/PLAYER-MVP/lifecycle', {
    method: 'POST', cookie: ownerCookie, key: 'complete-player-mvp',
    body: { action: 'complete', idempotency_key: 'complete-player-mvp' },
  })
  assert.equal(completed.status, 200, completed.text)
  assert.equal(completed.body.lifecycle.status, 'completed')
  assert.match(completed.body.lifecycle.epilogue, /Игроки и автономный режиссёр/u)
  const sessionSummary = completed.body.state.worldMemory.summaries.findLast(
    (entry) => entry.kind === 'session',
  )
  assert.ok(sessionSummary, 'campaign completion must persist a session summary')
  assert.ok(sessionSummary.source_event_ids.some((eventId) => eventId.startsWith('campaign-lifecycle:')))
  const readOnlyCommand = await playerCommand(baseUrl, ownerCookie, 'after-completion', {
    command_type: 'EndTurn', actor_id: 'mvp-hero-1',
  })
  assert.equal(readOnlyCommand.status, 400, readOnlyCommand.text)
  assert.equal(readOnlyCommand.body.code, 'CAMPAIGN_READ_ONLY')
  const archived = await request(baseUrl, '/api/campaigns/PLAYER-MVP/lifecycle', {
    method: 'POST', cookie: ownerCookie, key: 'archive-player-mvp',
    body: { action: 'archive', idempotency_key: 'archive-player-mvp' },
  })
  assert.equal(archived.status, 200, archived.text)
  assert.equal(archived.body.lifecycle.status, 'archived')
  assert.equal((await request(baseUrl, '/api/rooms/PLAYER-MVP', { cookie: guestCookie })).status, 200)
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'character-creation-setup',
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
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* starting */ }
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
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

const cookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function importDocument(overrides = {}) {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character: 'Бранн',
      name: 'Игрок',
      role: 'Воин · ур. 1',
      characterClass: 'fighter',
      species: 'Человек',
      background: 'Солдат',
      level: 1,
      experience: 0,
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
      selectedFeatureIds: ['fighting-style-defense'],
      knownSpellIds: [],
      preparedSpellIds: [],
      ...overrides,
    },
  }
}

async function command(baseUrl, cookieValue, actorId, document, key, campaignCode = 'CREATE-HERO') {
  return request(baseUrl, `/api/campaigns/${campaignCode}/commands`, {
    method: 'POST',
    cookie: cookieValue,
    key,
    body: {
      idempotency_key: key,
      command: { command_type: 'ImportCharacter', actor_id: actorId, document },
    },
  })
}

test('каждый игрок заполняет свой серверный слот через replayable ImportCharacter', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-character-creation-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  const health = await waitForHealth(baseUrl, child, () => logs)
  assert.equal(health.characterCreation.ability_policy.policy_id, 'skazanie.character-abilities.standard-array')
  assert.equal(health.characterCreation.classes.length, 12)
  assert.ok(health.characterCreation.classes.find((entry) => entry.id === 'wizard').spell_selection.spells.length > 0)
  const classicCatalog = await request(baseUrl, '/api/rulesets/dnd_5e_2014/character-creation')
  assert.equal(classicCatalog.status, 200, classicCatalog.text)
  assert.equal(classicCatalog.body.ruleset_id, 'dnd_5e_2014')
  assert.equal(classicCatalog.body.ability_policy.bonus_source, 'species')
  assert.equal(classicCatalog.body.ability_policy.species_options.length, 15)
  assert.equal(classicCatalog.body.backgrounds.options.length, 13)
  assert.equal(classicCatalog.body.starter_equipment.policy_version, 2)
  assert.equal(classicCatalog.body.classes.find((entry) => entry.id === 'fighter').starter_equipment.choice_groups.length, 4)
  assert.ok(classicCatalog.body.ability_policy.species_options.find((entry) => entry.id === 'dragonborn').choice_groups[0].options.length === 10)

  const admin = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Setup', email: 'setup@creation.test', password: 'secure-setup-password', setupToken: 'character-creation-setup',
  } })
  assert.equal(admin.status, 201, admin.text)
  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Owner', email: 'owner@creation.test', password: 'secure-owner-password',
  } })
  const guest = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Guest', email: 'guest@creation.test', password: 'secure-guest-password',
  } })
  const ownerCookie = cookie(owner)
  const guestCookie = cookie(guest)

  const classicCreated = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: ownerCookie,
    body: { code: 'CLASSIC-HERO', name: 'Классический герой', bootstrap: { slotCount: 1, rulesetId: 'dnd_5e_2014' } },
  })
  assert.equal(classicCreated.status, 201, classicCreated.text)
  assert.equal(classicCreated.body.state.ruleset_id, 'dnd_5e_2014')
  const classicBase = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  const classicImported = await command(baseUrl, ownerCookie, 'hero-slot-1', importDocument({
    character: 'Торин',
    species: 'Холмовой дварф',
    background: 'Солдат',
    backgroundId: 'soldier',
    backgroundChoices: { tools: ['dice_set'], languages: [] },
    speciesChoices: { 'artisan-tool': ['smiths_tools'] },
    starterEquipmentChoices: {
      armor: ['chain-mail'], 'melee-loadout': ['longsword-shield'],
      secondary: ['light-crossbow'], pack: ['explorers-pack'],
    },
    abilities: { str: 15, dex: 14, con: 15, int: 12, wis: 11, cha: 8 },
    abilityGeneration: {
      policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'standard_array',
      baseScores: classicBase,
      originBonusProfileId: 'dwarf-hill',
      originBonuses: { str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 },
      speciesOptionId: 'dwarf-hill',
    },
    baseSpeed: 25,
  }), 'classic-owner-character', 'CLASSIC-HERO')
  assert.equal(classicImported.status, 200, classicImported.text)
  const classicHero = classicImported.body.authoritative_state.players[0]
  assert.equal(classicHero.speciesBenefits.species_option_id, 'dwarf-hill')
  assert.equal(classicHero.backgroundBenefits.background_id, 'soldier')
  assert.equal(classicHero.currency.gold, 10)
  assert.deepEqual(classicHero.speciesToolProficiencies, ['smiths_tools'])
  assert.equal(classicHero.starterEquipmentChoices['melee-loadout'][0], 'longsword-shield')
  assert.ok(classicHero.inventory.some((item) => item.catalog_id === 'srd_5_2_1:chain-mail'))

  const rolledCampaign = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: ownerCookie,
    body: { code: 'PHB-ROLLS', name: 'PHB с бросками', bootstrap: { slotCount: 1, rulesetId: 'dnd_5e_2014' } },
  })
  assert.equal(rolledCampaign.status, 201, rolledCampaign.text)
  const rollBody = { idempotency_key: 'phb-ability-roll', command: { command_type: 'RollCharacterAbilities', actor_id: 'hero-slot-1' } }
  const rolled = await request(baseUrl, '/api/campaigns/PHB-ROLLS/commands', { method: 'POST', cookie: ownerCookie, key: rollBody.idempotency_key, body: rollBody })
  assert.equal(rolled.status, 200, rolled.text)
  const savedRoll = rolled.body.authoritative_state.players[0].characterCreationRolls.abilities
  assert.equal(savedRoll.scores.length, 6)
  const rolledAgain = await request(baseUrl, '/api/campaigns/PHB-ROLLS/commands', { method: 'POST', cookie: ownerCookie, key: rollBody.idempotency_key, body: rollBody })
  assert.equal(rolledAgain.status, 200, rolledAgain.text)
  assert.deepEqual(rolledAgain.body.authoritative_state.players[0].characterCreationRolls.abilities, savedRoll)
  const wealthBody = { idempotency_key: 'phb-wealth-roll', command: { command_type: 'RollCharacterWealth', actor_id: 'hero-slot-1', character_class: 'fighter' } }
  const wealth = await request(baseUrl, '/api/campaigns/PHB-ROLLS/commands', { method: 'POST', cookie: ownerCookie, key: wealthBody.idempotency_key, body: wealthBody })
  assert.equal(wealth.status, 200, wealth.text)
  const savedWealth = wealth.body.authoritative_state.players[0].characterCreationRolls.wealth
  const baseRolled = Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map((id, index) => [id, savedRoll.scores[index]]))
  const phbDocument = importDocument({
    abilities: Object.fromEntries(Object.entries(baseRolled).map(([id, value]) => [id, value + 1])),
    speciesChoices: { 'extra-language': ['dwarvish'] },
    backgroundId: 'acolyte', background: 'Прислужник', backgroundChoices: { tools: [], languages: ['elvish', 'giant'], replacementSkills: [], replacementTools: [] },
    abilityGeneration: { policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'rolled', baseScores: baseRolled,
      originBonusProfileId: 'human', originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speciesOptionId: 'human', rollId: savedRoll.id },
    phbCreation: { schema_version: 1, classChoices: {}, equipmentMode: 'wealth', wealthRollId: savedWealth.id, purchases: [{ id: 'srd_5_2_1:dagger', quantity: 1 }] },
  })
  const purchased = await command(baseUrl, ownerCookie, 'hero-slot-1', phbDocument, 'phb-character', 'PHB-ROLLS')
  assert.equal(purchased.status, 200, purchased.text)
  const purchasedHero = purchased.body.authoritative_state.players[0]
  assert.equal(purchasedHero.inventory.length, 1, 'Покупки заменяют, а не дополняют бесплатные комплекты')
  assert.equal(purchasedHero.inventory[0].catalog_id, 'srd_5_2_1:dagger')
  assert.equal(purchasedHero.currency.gold, savedWealth.total_gp - 2)
  assert.equal(purchasedHero.creationBenefits.class.class_key, 'fighter')

  const forgedPlayers = Array.from({ length: 4 }, (_, index) => ({
    id: `slot-${index + 1}`,
    character: `Подделка ${index + 1}`,
    abilities: { str: 30, dex: 30, con: 30, int: 30, wis: 30, cha: 30 },
    hp: 999,
  }))
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: ownerCookie,
    body: { code: 'CREATE-HERO', name: 'Создание героев', bootstrap: { slotCount: 4, players: forgedPlayers } },
  })
  assert.equal(created.status, 201, created.text)
  assert.deepEqual(created.body.user.campaignMemberships.find((entry) => entry.campaignId === 'CREATE-HERO').heroIds, ['slot-1'])
  assert.equal(created.body.state.players.length, 4)
  assert.ok(created.body.state.players.every((hero) => hero.characterSetupRequired))
  assert.notEqual(created.body.state.players[0].abilities.str, 30)

  const invite = await request(baseUrl, '/api/campaigns/CREATE-HERO/invites', {
    method: 'POST',
    cookie: ownerCookie,
    body: {},
  })
  assert.equal(invite.status, 201, invite.text)
  assert.deepEqual(invite.body.hero_ids, ['slot-2', 'slot-3', 'slot-4'])
  const joined = await request(baseUrl, '/api/campaigns/CREATE-HERO/join', {
    method: 'POST',
    cookie: guestCookie,
    body: { invite_token: invite.body.token },
  })
  assert.equal(joined.status, 200, joined.text)
  assert.deepEqual(joined.body.hero_ids, ['slot-2'])

  const beforeSetup = await request(baseUrl, '/api/campaigns/CREATE-HERO/commands', {
    method: 'POST',
    cookie: ownerCookie,
    body: { command: { command_type: 'StartCombat', actor_id: 'slot-1' } },
  })
  assert.equal(beforeSetup.status, 400, beforeSetup.text)
  assert.equal(beforeSetup.body.code, 'CHARACTER_SETUP_REQUIRED')

  const forged = await command(baseUrl, ownerCookie, 'slot-1', importDocument({
    abilities: { str: 30, dex: 30, con: 30, int: 30, wis: 30, cha: 30 },
  }), 'forged-abilities')
  assert.equal(forged.status, 400, forged.text)
  assert.equal(forged.body.code, 'IMPORT_ABILITY_BUDGET_INVALID')

  const imported = await command(baseUrl, ownerCookie, 'slot-1', importDocument(), 'owner-character')
  assert.equal(imported.status, 200, imported.text)
  const ownerHero = imported.body.authoritative_state.players.find((hero) => hero.id === 'slot-1')
  assert.equal(ownerHero.characterSetupRequired, false)
  assert.equal(ownerHero.character, 'Бранн')
  assert.equal(ownerHero.maxHp, 11)
  assert.equal(ownerHero.proficiency, 2)
  assert.ok(ownerHero.inventory.some((item) => item.catalog_id === 'srd_5_2_1:longsword'))

  const duplicate = await command(baseUrl, ownerCookie, 'slot-1', importDocument(), 'owner-character')
  assert.equal(duplicate.status, 200, duplicate.text)
  assert.equal(duplicate.body.state_version, imported.body.state_version)
  assert.deepEqual(duplicate.body.mechanics, imported.body.mechanics)

  const wrongOwner = await command(baseUrl, guestCookie, 'slot-1', importDocument({ character: 'Чужой герой' }), 'wrong-owner')
  assert.equal(wrongOwner.status, 403, wrongOwner.text)
  assert.equal(wrongOwner.body.code, 'ACTOR_FORBIDDEN')

  const guestImported = await command(baseUrl, guestCookie, 'slot-2', importDocument({ character: 'Мира' }), 'guest-character')
  assert.equal(guestImported.status, 200, guestImported.text)

  await stopServer(child)
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const replayed = await request(baseUrl, '/api/rooms/CREATE-HERO', { cookie: ownerCookie })
  assert.equal(replayed.status, 200, replayed.text)
  const replayedOwner = replayed.body.state.players.find((hero) => hero.id === 'slot-1')
  assert.equal(replayedOwner.character, ownerHero.character)
  assert.deepEqual(replayedOwner.abilities, ownerHero.abilities)
  assert.equal(replayedOwner.maxHp, ownerHero.maxHp)
  assert.equal(replayedOwner.characterSetupRequired, false)
})

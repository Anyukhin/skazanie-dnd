import assert from 'node:assert/strict'
import test from 'node:test'
import { shortestTacticalPath } from '../server/rules-engine.mjs'
import { expectStatus, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'

const CAMPAIGN = 'SHILLELAGH-API'
const HERO = 'hero-slot-1'
// Предзагрузка проверяет имя хранилища: только skazanie-shillelagh-api-*.
const DETERMINISTIC_DICE_PRELOAD = 'test/fixtures/shillelagh-deterministic-dice.mjs'

function command(client, key, value) {
  return client.post(`/api/campaigns/${CAMPAIGN}/commands`, { idempotency_key: key, command: value }, { idempotencyKey: key })
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
  const server = await startTestServer(t, {
    preload: DETERMINISTIC_DICE_PRELOAD,
    storagePrefix: 'skazanie-shillelagh-api-',
  })
  const { client: admin } = await setupAdmin(server, { name: 'Ведущий', email: 'admin@shillelagh-api.test', password: 'secure-admin-password' })
  const { client: owner } = await registerUser(server, { name: 'Иара', email: 'owner@shillelagh-api.test', password: 'secure-owner-password' })
  const { client: guest } = await registerUser(server, { name: 'Гость', email: 'guest@shillelagh-api.test', password: 'secure-guest-password' })

  expectStatus(await owner.post('/api/campaigns', { code: CAMPAIGN, name: 'API Дубинка', bootstrap: { slotCount: 2, startLevel: 1, rulesetId: 'dnd_5e_2014', world: { preset: 'Классическое фэнтези' } } }), 201)
  const invite = expectStatus(await owner.post(`/api/campaigns/${CAMPAIGN}/invites`, { hero_ids: ['hero-slot-2'] }), 201)
  expectStatus(await guest.post(`/api/campaigns/${CAMPAIGN}/join`, { invite_token: invite.token }))

  const imported = expectStatus(await command(owner, 'druid-import', {
    command_type: 'ImportCharacter', actor_id: HERO, document: druidDocument(),
  }))
  assert.equal(imported.authoritative_state.players.find((actor) => actor.id === HERO).characterClass, 'druid')

  const selected = expectStatus(await command(owner, 'druid-spells', {
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
  expectStatus(await command(guest, 'guest-druid-import', {
    command_type: 'ImportCharacter', actor_id: 'hero-slot-2', document: guestDocument,
  }))
  expectStatus(await command(guest, 'guest-druid-spells', {
    command_type: 'SetSpellSelections', actor_id: 'hero-slot-2',
    known_spell_ids: ['druidcraft', 'shillelagh'], prepared_spell_ids: [],
  }))

  const released = expectStatus(await command(owner, 'release-shield', {
    command_type: 'EquipItem', actor_id: HERO, item_id: shield.id, equipped: false,
  }))
  assert.equal(released.authoritative_state.players.find((actor) => actor.id === HERO).inventory.find((item) => item.id === club.id).equipped, true)

  const refusal = await command(owner, 'bad-shillelagh-item', {
    command_type: 'CastSpell', actor_id: HERO, target_id: HERO, spell_id: 'shillelagh', item_id: shield.id,
  })
  expectStatus(refusal, 400)
  assert.equal(refusal.body.code, 'SHILLELAGH_WEAPON_REQUIRED')

  const castCommand = { command_type: 'CastSpell', actor_id: HERO, target_id: HERO, spell_id: 'shillelagh', item_id: club.id }
  const cast = expectStatus(await command(owner, 'shillelagh-cast', castCommand))
  const spellCast = cast.mechanics.find((event) => event.event_type === 'SpellCast')
  const conditionAdded = cast.mechanics.find((event) => event.event_type === 'ConditionAdded')
  assert.equal(spellCast.payload.item_instance_id, club.id)
  assert.equal(spellCast.payload.spellcasting_ability, 'wis')
  assert.equal(conditionAdded.payload.source_item_id, club.id)
  assert.equal(conditionAdded.payload.timing_version, 2)
  assert.equal(conditionAdded.payload.duration, 'seconds:60')

  const replay = expectStatus(await command(owner, 'shillelagh-cast', castCommand))
  assert.equal(replay.idempotent_replay, true)

  const foreign = await command(guest, 'foreign-shillelagh', castCommand)
  expectStatus(foreign, 403)
  assert.equal(foreign.body.code, 'ACTOR_FORBIDDEN')

  const afterCast = expectStatus(await owner.get(`/api/rooms/${CAMPAIGN}`))
  assert.ok(afterCast.state.mechanics.conditions[HERO].some((condition) => condition.id === 'shillelagh' && condition.source_item_id === club.id))

  const beforeEncounter = expectStatus(await admin.get(`/api/rooms/${CAMPAIGN}`))
  const encounter = expectStatus(await admin.post(`/api/campaigns/${CAMPAIGN}/encounters/assemble`, { idempotency_key: 'shillelagh-encounter', expected_state_version: beforeEncounter.state.state_version, difficulty: 'easy', theme: 'beasts', seed: 'shillelagh-api-encounter' }))
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
      const nextCombatState = expectStatus(await command(admin,
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
    combatState = expectStatus(await command(owner,
      `shillelagh-approach-${beforeMoveVersion}-${round}`,
      { command_type: 'MoveActor', actor_id: HERO, to },
    )).authoritative_state
    assert.ok(Number(combatState.state_version) > beforeMoveVersion,
      `Перемещение должно продвинуть состояние: ${combatState.state_version} после ${beforeMoveVersion}`)
    const afterMove = combatState.mechanics.positions?.[HERO] ?? combatState.players.find((actor) => actor.id === HERO)
    const afterDistance = Math.max(Math.abs(Number(afterMove.x) - Number(enemyPosition.x)), Math.abs(Number(afterMove.y) - Number(enemyPosition.y))) * 5
    if (afterDistance > 5) {
      const beforeEndTurnVersion = Number(combatState.state_version)
      combatState = expectStatus(await command(owner,
        `shillelagh-approach-end-${beforeEndTurnVersion}-${round}`,
        { command_type: 'EndTurn', actor_id: HERO },
      )).authoritative_state
      assert.ok(Number(combatState.state_version) > beforeEndTurnVersion,
        `EndTurn должен продвинуть состояние для ${HERO}: ${combatState.state_version} после ${beforeEndTurnVersion}`)
    }
  }
  assertHeroCanContinue(combatState)
  assert.equal(combatState.mechanics.combat.initiative[combatState.mechanics.combat.active_index]?.actor_id, HERO)
  const attack = expectStatus(await command(owner, 'shillelagh-attack', {
    command_type: 'MakeAttack', actor_id: HERO, target_id: enemy.id, item_id: club.id,
  }))
  const resolved = attack.mechanics.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.item_id, club.id)
  assert.equal(resolved.payload.attack_ability, 'wis')
  assert.equal(resolved.payload.damage_expression, '1d8+3')
  assert.equal(resolved.payload.magical, true)

  await server.restart()
  const reopened = expectStatus(await owner.get(`/api/rooms/${CAMPAIGN}`))
  assert.ok(reopened.state.mechanics.conditions[HERO].some((condition) => condition.id === 'shillelagh' && condition.source_item_id === club.id))
})

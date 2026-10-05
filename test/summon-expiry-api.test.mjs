import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient, expectStatus, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'

const SESSION = 'SUMMON-HTTP'

function assertStatus(result, expected) {
  expectStatus(result, expected)
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
  const server = await startTestServer(t, { storagePrefix: 'skazanie-summon-expiry-api-' })
  const assertEngineMode = async () => {
    const health = expectStatus(await createClient(server).get('/api/health'))
    assert.equal(health.engineMode, 'enforce')
  }
  await assertEngineMode()

  const { client: admin } = await setupAdmin(server, { name: 'Summon Admin', email: 'summon-admin@test.local', password: 'summon-admin-password' })
  const { client: player } = await registerUser(server, { name: 'Summon Player', email: 'summon-player@test.local', password: 'summon-player-password' })
  const created = await player.post('/api/campaigns', { code: SESSION, name: 'HTTP summon expiry', bootstrap: { slotCount: 1, startLevel: 3, rulesetId: 'dnd_5e_2014', world: { preset: 'Классическое фэнтези' } } })
  assertStatus(created, 201)

  const catalog = await createClient(server).get('/api/rulesets/dnd_5e_2014/character-creation')
  assertStatus(catalog, 200)
  const cleric = catalog.body.classes.find((entry) => entry.id === 'cleric')
  assert.ok(cleric)
  const actorId = 'hero-slot-1'
  const cantrips = cleric.spell_selection.spells.filter((spell) => spell.level === 0).slice(0, 3).map((spell) => spell.id)
  const imported = await player.post(`/api/campaigns/${SESSION}/commands`, commandBody('acquire-import', { command_type: 'ImportCharacter', actor_id: actorId, document: clericDocument('Жрец HTTP') }))
  assertStatus(imported, 200)
  const choices = await player.post(`/api/campaigns/${SESSION}/commands`, commandBody('acquire-choices', { command_type: 'SetCharacterChoices', actor_id: actorId,
      subclass: cleric.subclasses[0]?.name ?? '', class_skill_proficiencies: ['insight', 'religion'], selected_feature_ids: [] }))
  assertStatus(choices, 200)
  const firstSpells = await player.post(`/api/campaigns/${SESSION}/commands`, commandBody('acquire-spells-1', { command_type: 'SetSpellSelections', actor_id: actorId,
      known_spell_ids: cantrips, prepared_spell_ids: ['healing-word'] }))
  assertStatus(firstSpells, 200)
  let acquiredState = firstSpells.body.authoritative_state
  for (const expectedLevel of [1, 2]) {
    const levelUp = await player.post(`/api/campaigns/${SESSION}/commands`, commandBody(`acquire-level-${expectedLevel}`, { command_type: 'LevelUp', actor_id: actorId, expected_level: expectedLevel }))
    assertStatus(levelUp, 200)
    acquiredState = levelUp.body.authoritative_state
  }
  const prepared = await player.post(`/api/campaigns/${SESSION}/commands`, commandBody('acquire-spells-3', { command_type: 'SetSpellSelections', actor_id: actorId,
      known_spell_ids: [...cantrips, 'spiritual-weapon'], prepared_spell_ids: ['healing-word', 'spiritual-weapon'] }))
  assertStatus(prepared, 200)
  acquiredState = prepared.body.authoritative_state
  const caster = acquiredState.players.find((entry) => entry.id === actorId)
  assert.equal(caster.level, 3)
  assert.ok(caster.preparedSpellIds.includes('spiritual-weapon'))
  for (const item of caster.inventory.filter((entry) => entry.equipped === true)) {
    const unequip = await player.post(`/api/campaigns/${SESSION}/commands`, commandBody(`acquire-unequip-${item.id}`, { command_type: 'EquipItem', actor_id: actorId, item_id: item.id, equipped: false }))
    assertStatus(unequip, 200)
  }

  const cast = await player.post(`/api/campaigns/${SESSION}/commands`, commandBody('cast-spiritual-weapon', {
      command_type: 'CastSpell', actor_id: actorId, spell_id: 'spiritual-weapon',
      to: { x: caster.x, y: caster.y }, slot_level: 2,
    }))
  assertStatus(cast, 200)
  const summon = cast.body.authoritative_state.actors.find((actor) => actor.kind === 'summon')
  assert.ok(summon, 'обычный игрок должен получить фишку призыва')
  assert.equal(summon.expires_at_seconds, 60)

  const beforeExpiry = await admin.post(`/api/campaigns/${SESSION}/commands`, commandBody('advance-59', { command_type: 'AdvanceTime', actor_id: actorId, amount: 59, unit: 'second' }))
  assertStatus(beforeExpiry, 200)
  assert.ok(beforeExpiry.body.authoritative_state.actors.some((actor) => actor.id === summon.id))
  assert.equal(beforeExpiry.body.mechanics.some((event) => event.event_type === 'SummonedCreatureDismissed'), false)

  const expired = await admin.post(`/api/campaigns/${SESSION}/commands`, commandBody('advance-60', { command_type: 'AdvanceTime', actor_id: actorId, amount: 1, unit: 'second' }))
  assertStatus(expired, 200)
  assert.equal(expired.body.authoritative_state.actors.some((actor) => actor.id === summon.id), false)
  assert.ok(expired.body.mechanics.some((event) => event.event_type === 'SummonedCreatureDismissed'))
  const playerRoom = await player.get(`/api/rooms/${SESSION}`)
  assertStatus(playerRoom, 200)
  assert.equal(playerRoom.body.state.actors.some((actor) => actor.id === summon.id), false)

  await server.restart()
  await assertEngineMode()
  const afterRestart = await player.get(`/api/rooms/${SESSION}`)
  assertStatus(afterRestart, 200)
  assert.equal(afterRestart.body.state.actors.some((actor) => actor.id === summon.id), false)
})

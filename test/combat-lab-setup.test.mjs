import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCombatLabState, combatLabCatalog } from '../server/combat-lab-setup.mjs'

function sourceCampaign() {
  return {
    sessionCode: 'SOURCE-2014',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_rule_packs: ['dnd_5e_2014'],
    players: [{
      id: 'source-hero',
      name: 'Исходный герой',
      character: 'Исходный герой',
      characterClass: 'fighter',
      level: 1,
      hp: 7,
      maxHp: 12,
      armor: 16,
      speed: 30,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
      inventory: [{ id: 'source-sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true }],
      knownSpellIds: ['bless'],
      preparedSpellIds: ['bless'],
      classSkillProficiencies: ['athletics'],
      selectedFeatureIds: ['fighter-second-wind'],
      x: 0,
      y: 0,
    }],
  }
}

const loadCampaign = async (campaignId) => {
  assert.equal(campaignId, 'SOURCE-2014')
  return sourceCampaign()
}

test('каталог и builder настраиваемой арены используют только 2014 и не меняют героя кампании', async () => {
  const catalog = await combatLabCatalog({ loadCampaign })
  assert.equal(catalog.limits.party, 6)
  assert.equal(catalog.limits.enemies, 12)
  assert.ok(catalog.classes.some((entry) => entry.id === 'fighter'))
  assert.ok(catalog.monsters.some((entry) => entry.id === 'dnd_5e_2014:monster:goblin' && entry.sourceUrl.includes('dnd.su')))
  assert.equal(catalog.maps.length, 4)
  assert.ok(catalog.maps.every((map) => map.map && map.cells.some((cell) => cell.type === 'wall' || cell.difficult)))

  const source = sourceCampaign()
  const before = structuredClone(source)
  const state = await buildCombatLabState({
    mapId: 'open-courtyard',
    party: [
      { source: 'hero', campaignId: 'SOURCE-2014', heroId: 'source-hero', x: 0, y: 0 },
      { source: 'class', classId: 'fighter', level: 3, x: 1, y: 0 },
    ],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }],
  }, { loadCampaign: async () => source })
  assert.equal(state.ruleset_id, 'dnd_5e_2014')
  assert.equal(state.ruleset_version, '2014.1.0')
  assert.deepEqual(state.enabled_rule_packs, ['dnd_5e_2014'])
  assert.equal(state.players[0].name, 'Исходный герой')
  assert.equal(state.players[0].source_hero_id, 'source-hero')
  assert.equal(state.players[0].inventory[0].source_item_id, 'source-sword')
  assert.deepEqual(source, before, 'builder не должен менять состояние кампании-источника')
})

test('builder отклоняет raw state, forged ids, лимит отряда и стену', async () => {
  const validParty = [{ source: 'class', classId: 'fighter', level: 1, x: 0, y: 0 }]
  const validEnemy = [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }]
  await assert.rejects(
    () => buildCombatLabState({ mapId: 'open-courtyard', state: {}, party: validParty, enemies: validEnemy }),
    (error) => error.code === 'UNEXPECTED_COMBAT_LAB_FIELD',
  )
  await assert.rejects(
    () => buildCombatLabState({ mapId: 'open-courtyard', party: validParty, enemies: [{ monsterId: 'srd_5_2_1:goblin-minion', x: 8, y: 5 }] }),
    (error) => error.code === 'UNKNOWN_COMBAT_LAB_MONSTER',
  )
  await assert.rejects(
    () => buildCombatLabState({ mapId: 'open-courtyard', party: Array.from({ length: 7 }, (_, index) => ({ source: 'class', classId: 'fighter', level: 1, x: index, y: 0 })), enemies: validEnemy }),
    (error) => error.code === 'PARTY_LIMIT_EXCEEDED',
  )
  await assert.rejects(
    () => buildCombatLabState({ mapId: 'ruined-hall', party: [{ source: 'class', classId: 'fighter', level: 1, x: 5, y: 0 }], enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }] }),
    (error) => error.code === 'PLACEMENT_BLOCKED',
  )
  await assert.rejects(
    () => buildCombatLabState({ mapId: 'open-courtyard', party: [{ source: 'hero', campaignId: 'SOURCE-2024', heroId: 'source-hero', x: 0, y: 0 }], enemies: validEnemy }, {
      loadCampaign: async () => ({ ruleset_id: 'srd_5_2_1', players: [{ id: 'source-hero', level: 1, maxHp: 10, hp: 10, inventory: [] }] }),
    }),
    (error) => error.code === 'SOURCE_RULESET_UNSUPPORTED',
  )
})

test('учебный профиль сохраняет легальный уровень 2014 и ресурсы заклинателя', async () => {
  const state = await buildCombatLabState({
    mapId: 'open-courtyard',
    party: [{ source: 'class', classId: 'wizard', level: 12, x: 0, y: 0 }],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }],
  })
  const wizard = state.players[0]
  assert.equal(wizard.level, 12)
  assert.equal(wizard.proficiency, 4)
  assert.ok(wizard.knownSpellIds.includes('fireball'))
  assert.ok(wizard.knownSpellIds.includes('scorching-ray'))
  assert.ok(state.mechanics.resources[wizard.id].spell_slots_5.max > 0)
  assert.equal(state.ruleset_id, 'dnd_5e_2014')
})

test('монстры 2014 сохраняют заклинания и мультиатаку в проекции арены', async () => {
  const state = await buildCombatLabState({
    mapId: 'open-courtyard',
    party: [{ source: 'class', classId: 'fighter', level: 1, x: 0, y: 0 }],
    enemies: [
      { monsterId: 'dnd_5e_2014:monster:mage', x: 8, y: 5 },
      { monsterId: 'dnd_5e_2014:monster:cult-fanatic', x: 7, y: 5 },
    ],
  })
  const mage = state.enemies.find((enemy) => enemy.stat_block_id.endsWith(':mage'))
  const fanatic = state.enemies.find((enemy) => enemy.stat_block_id.endsWith(':cult-fanatic'))
  assert.ok(mage.spellcasting.spells.some((spell) => spell.id === 'fireball'))
  assert.ok(fanatic.traits.some((trait) => trait.id === 'multiattack' && trait.sequence.length === 2))
  assert.equal(state.mechanics.resources[mage.id].spell_slots_1.max, 4)
  assert.equal(state.mechanics.resources[mage.id].spell_slots_3.max, 3)
})

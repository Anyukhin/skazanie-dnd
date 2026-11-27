import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCombatLabState } from '../server/combat-lab-setup.mjs'
import { loadDndsu2014Content } from '../server/dndsu-2014-content.mjs'
import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import { enemyLoadoutFor } from '../server/enemy-loadouts.mjs'
import { monsterCombatSpellFor } from '../server/combat-spells.mjs'
import { spellComponentAvailabilityFor } from '../server/rules-engine.mjs'

test('новый 2014 NPC-заклинатель получает сумку компонентов через frozen item instance', async () => {
  const content = await loadDndsu2014Content()
  for (const slug of ['mage', 'acolyte']) {
    const record = content.monsters.find((entry) => entry.id.endsWith(`:monster:${slug}`))
    const enemy = enemyFrom2014(record, { x: 0, y: 0 })
    const loadout = enemyLoadoutFor({ statBlockId: record.id, block: enemy, ownerId: `npc-${slug}`, seed: 'component-loadout' })
    const pouch = loadout.items.find((item) => item.catalog_id === 'srd_5_2_1:component-pouch')
    assert.ok(pouch, `${slug}: component pouch`)
    assert.equal(pouch.snapshot.component_pouch, true, `${slug}: catalog metadata in snapshot`)
    assert.equal(pouch.owner.actor_id, `npc-${slug}`)
    assert.equal(pouch.origin.kind, 'enemy_loadout')
  }
  const skullRecord = content.monsters.find((entry) => entry.id.endsWith(':monster:flameskull'))
  const skull = enemyFrom2014(skullRecord, { x: 0, y: 0 })
  const skullLoadout = enemyLoadoutFor({ statBlockId: skullRecord.id, block: skull, ownerId: 'skull', seed: 'component-loadout' })
  assert.equal(skullLoadout.items.some((entry) => entry.catalog_id === 'srd_5_2_1:component-pouch'), false,
    'Flameskull явно освобождён от M/S и не получает выдуманную сумку')
})

test('явный waiver материального компонента не создаёт NPC-предмет', () => {
  const waived = enemyLoadoutFor({
    statBlockId: 'dnd_5e_2014:monster:waived-caster',
    block: {
      spellcasting: {
        spells: [{ id: 'bless', components_not_required: ['material'] }],
      },
      action_profiles: [],
    },
    ownerId: 'waived-caster',
    seed: 'component-waiver',
  })
  assert.deepEqual(waived.items, [])
  assert.equal(waived.purse_cp, 0)
})

test('CombatLab выдаёт новым классовым героям реальные компоненты, а source hero не пополняется', async () => {
  const cases = [
    ['wizard', 'srd_5_2_1:component-pouch'],
    ['sorcerer', 'srd_5_2_1:component-pouch'],
    ['warlock', 'srd_5_2_1:component-pouch'],
    ['druid', 'srd_5_2_1:druidic-focus-mistletoe'],
    ['cleric', 'srd_5_2_1:holy-symbol-amulet'],
  ]
  for (const [classId, componentId] of cases) {
    const state = await buildCombatLabState({
      mapId: 'open-courtyard',
      party: [{ source: 'class', classId, level: 12, x: 0, y: 0 }],
      enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }],
    })
    const item = state.players[0].inventory.find((candidate) => candidate.catalog_id === componentId)
    assert.ok(item, `${classId}: ${componentId}`)
    if (classId === 'cleric') assert.equal(item.equipped, true, 'worn holy symbol is equipped in its focus slot')
  }

  const combatLabMage = await buildCombatLabState({
    mapId: 'open-courtyard',
    party: [{ source: 'class', classId: 'fighter', level: 12, x: 0, y: 0 }],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:mage', x: 8, y: 5 }],
  })
  assert.equal(combatLabMage.enemies[0].loadout.items.some((item) => item.catalog_id === 'srd_5_2_1:component-pouch'), true)
  const mageSpell = monsterCombatSpellFor(combatLabMage.enemies[0], 'fireball', { rulesetId: 'dnd_5e_2014' })
  assert.equal(spellComponentAvailabilityFor(combatLabMage, combatLabMage.enemies[0], mageSpell).available, true,
    'исполнение читает реальную NPC loadout.items, а не отсутствующий hero inventory')

  const source = {
    sessionCode: 'SOURCE-COMPONENTS',
    ruleset_id: 'dnd_5e_2014',
    players: [{
      id: 'old-wizard', character: 'Старый волшебник', characterClass: 'wizard', level: 12,
      hp: 40, maxHp: 40, armor: 12, speed: 30,
      abilities: { str: 8, dex: 14, con: 13, int: 16, wis: 10, cha: 10 },
      knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'], inventory: [],
    }],
  }
  const copied = await buildCombatLabState({
    mapId: 'open-courtyard',
    party: [{ source: 'hero', campaignId: 'SOURCE-COMPONENTS', heroId: 'old-wizard', x: 0, y: 0 }],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }],
  }, { loadCampaign: async () => structuredClone(source) })
  assert.equal(copied.players[0].inventory.some((item) => item.catalog_id === 'srd_5_2_1:component-pouch'), false)
})

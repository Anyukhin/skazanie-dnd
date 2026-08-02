import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ENCOUNTER_ASSEMBLER_LIMITS,
  ENCOUNTER_DIFFICULTIES,
  ENCOUNTER_PROPOSAL_VERSION,
  ENCOUNTER_THEMES,
  DND_SU_BESTIARY_SOURCE,
  EncounterAssembler,
  SRD_5_2_1_MONSTER_ALLOWLIST,
  SRD_5_2_1_SOURCE,
  assembleEncounter,
} from '../server/encounter-assembler.mjs'

function cells(width = 7, height = 5) {
  return Array.from({ length: height }, (_, y) => (
    Array.from({ length: width }, (_, x) => ({ x, y, type: 'floor', revealed: true }))
  )).flat()
}

function baseInput(overrides = {}) {
  return {
    scene: { cells: cells() },
    party: [
      { id: 'hero-1', level: 1, x: 0, y: 0 },
      { id: 'hero-2', level: 1, x: 1, y: 0 },
      { id: 'hero-3', level: 1, x: 2, y: 0 },
      { id: 'hero-4', level: 1, x: 3, y: 0 },
    ],
    difficulty: 'easy',
    theme: 'generic',
    seed: 'campaign:chapter-1:encounter-1',
    ...overrides,
  }
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.name === 'EncounterAssemblyError' && error.code === code)
}

test('exports an expanded dnd.su-linked SRD 5.2.1 monster catalog with fixed source provenance', () => {
  assert.equal(ENCOUNTER_PROPOSAL_VERSION, 'skazanie:encounter-proposal-v1')
  assert.deepEqual(ENCOUNTER_DIFFICULTIES, ['easy', 'medium', 'hard', 'deadly'])
  assert.deepEqual(ENCOUNTER_THEMES, [
    'goblinoids', 'undead', 'beasts', 'raiders',
    'warband', 'vermin', 'ambush', 'crypt', 'cave', 'wilderness',
    'generic',
  ])
  assert.equal(Object.keys(SRD_5_2_1_MONSTER_ALLOWLIST).length, 50)
  assert.equal(DND_SU_BESTIARY_SOURCE.url, 'https://dnd.su/bestiary/')
  assert.equal(SRD_5_2_1_SOURCE.version, '5.2.1')
  assert.equal(SRD_5_2_1_SOURCE.encounter_budget_page, 202)
  assert.equal(SRD_5_2_1_SOURCE.sha256, '8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87')
  assert.match(SRD_5_2_1_SOURCE.url, /SRD_CC_v5\.2\.1\.pdf$/u)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:goblin-minion'].source_page, 290)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:goblin-minion'].initiative_bonus, 2)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:skeleton'].source_page, 325)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:skeleton'].initiative_bonus, 3)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:zombie'].source_page, 343)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:zombie'].initiative_bonus, -2)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:wolf'].source_page, 364)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:bandit'].source_page, 261)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:dire-wolf'].source_page, 347)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ghoul'].source_page, 288)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:gnoll-warrior'].source_page, 289)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ogre'].source_page, 312)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:owlbear'].source_page, 313)
  assert.ok(Object.isFrozen(SRD_5_2_1_SOURCE))
  assert.ok(Object.isFrozen(SRD_5_2_1_MONSTER_ALLOWLIST))
  assert.ok(Object.isFrozen(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:wolf']))
  assert.ok(Object.values(SRD_5_2_1_MONSTER_ALLOWLIST).every((monster) => monster.source_url?.startsWith('https://dnd.su/bestiary/')))
  assert.ok(Object.values(SRD_5_2_1_MONSTER_ALLOWLIST).every((monster) => monster.action_profiles?.length >= 1))
})

// Тема без работающей сборки — не тема, а строка в списке. Проверка держит
// каждую: ростер непустой, состоит только из существ allowlist, укладывается
// в бюджет XP и воспроизводится при повторной сборке.
test('каждая тема встреч собирает исполнимый ростер по своему составу', () => {
  const rosters = new Map()
  for (const theme of ENCOUNTER_THEMES) {
    for (const difficulty of ENCOUNTER_DIFFICULTIES) {
      const proposal = assembleEncounter(baseInput({ theme, difficulty }))
      assert.ok(proposal.enemies.length >= 1, `${theme}/${difficulty}: пустой ростер`)
      // Проекция намеренно не отдаёт catalog_id, поэтому сверяемся по имени:
      // сборщик нумерует одинаковых существ суффиксом «Гоблин-воин 2».
      const allowedNames = new Set(Object.values(SRD_5_2_1_MONSTER_ALLOWLIST).map((monster) => monster.name))
      assert.ok(
        proposal.enemies.every((enemy) => allowedNames.has(String(enemy.name).replace(/\s+\d+$/u, ''))),
        `${theme}/${difficulty}: в ростер попало существо вне allowlist`,
      )
      assert.deepEqual(assembleEncounter(baseInput({ theme, difficulty })), proposal, `${theme}/${difficulty}: сборка недетерминирована`)
      if (difficulty === 'medium') rosters.set(theme, proposal.enemies.map((enemy) => enemy.name).sort().join(','))
    }
  }
  // Темы обязаны отличаться друг от друга составом, иначе расширение
  // декоративно: одиннадцать имён одного и того же ростера разнообразия не дают.
  assert.ok(new Set(rosters.values()).size >= 6, `слишком мало различных ростеров: ${new Set(rosters.values()).size}`)
})

test('assembly is deterministic, input-order independent, bounded by the official XP budget, and deeply immutable', () => {
  const input = baseInput()
  const first = assembleEncounter(input)
  const second = new EncounterAssembler().assemble({
    ...input,
    scene: { cells: [...input.scene.cells].reverse() },
    party: [...input.party].reverse(),
  })

  assert.deepEqual(second, first)
  assert.equal(first.version, ENCOUNTER_PROPOSAL_VERSION)
  assert.equal(first.xp_budget, 200)
  assert.equal(first.xp_spent, 200)
  assert.deepEqual(first.threat, {
    budget_xp: 200,
    spent_xp: 200,
    unspent_xp: 0,
    utilization_bps: 10_000,
    quantity: first.enemies.length,
    quantity_cap: 8,
  })
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.threat))
  assert.ok(Object.isFrozen(first.enemies))
  assert.ok(first.enemies.every((enemy) => Object.isFrozen(enemy) && Object.isFrozen(enemy.provenance)))
  assert.ok(first.enemies.length <= first.threat.quantity_cap)
  assert.ok(first.xp_spent <= first.xp_budget)
})

test('mixed-level party budget sums the per-character SRD values for the selected public difficulty', () => {
  const proposal = assembleEncounter(baseInput({
    party: [
      { id: 'level-1', level: 1, x: 0, y: 0 },
      { id: 'level-2', level: 2, x: 1, y: 0 },
    ],
    difficulty: 'medium',
    theme: 'goblinoids',
  }))
  assert.equal(proposal.xp_budget, 225)
  assert.equal(proposal.xp_spent, 225)
  assert.equal(proposal.threat.quantity_cap, 4)
  assert.equal(proposal.enemies.length, 2)
  assert.ok(proposal.enemies.every((enemy) => ['srd_5_2_1:goblin-minion', 'srd_5_2_1:goblin-warrior', 'srd_5_2_1:hobgoblin', 'srd_5_2_1:kobold', 'srd_5_2_1:bugbear'].includes(enemy.stat_block_id)))
})

test('placement uses only revealed walkable feature-free cells not occupied by the party', () => {
  const sceneCells = [
    { x: 0, y: 0, type: 'floor', revealed: true },
    { x: 1, y: 0, type: 'floor', revealed: true },
    { x: 2, y: 0, type: 'floor', revealed: true, feature: 'chest' },
    { x: 3, y: 0, type: 'floor', revealed: true },
    { x: 4, y: 0, type: 'door', revealed: true },
    { x: 5, y: 0, type: 'wall', revealed: true },
    { x: 6, y: 0, type: 'water', revealed: true },
    { x: 7, y: 0, type: 'door', revealed: false },
    { x: 9, y: 0, type: 'floor', revealed: true },
  ]
  const proposal = assembleEncounter(baseInput({
    scene: { cells: sceneCells },
    party: [{ id: 'hero', level: 1, x: 0, y: 0 }],
    difficulty: 'hard',
    theme: 'beasts',
  }))
  assert.equal(proposal.threat.quantity_cap, 2)
  assert.deepEqual(
    new Set(proposal.enemies.map((enemy) => `${enemy.x},${enemy.y}`)),
    new Set(['3,0', '4,0']),
  )
})

test('placement rejects an adjacent cell and a revealed but disconnected walkable island', () => {
  expectCode(() => assembleEncounter(baseInput({
    scene: { cells: [
      { x: 0, y: 0, type: 'floor', revealed: true },
      { x: 1, y: 0, type: 'floor', revealed: true },
      { x: 2, y: 0, type: 'wall', revealed: true },
      { x: 3, y: 0, type: 'floor', revealed: true },
    ] },
    party: [{ id: 'hero', level: 1, x: 0, y: 0 }],
  })), 'NO_SAFE_PLACEMENT_CELLS')
})

test('available-cell and per-character caps take priority over a large XP budget', () => {
  const party = Array.from({ length: 8 }, (_, index) => ({ id: `hero-${index}`, level: 20, x: index, y: 0 }))
  const proposal = assembleEncounter(baseInput({
    scene: { cells: cells(10, 3) },
    party,
    difficulty: 'hard',
    theme: 'undead',
  }))
  assert.equal(proposal.xp_budget, 176_000)
  assert.equal(proposal.enemies.length, ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures)
  assert.equal(proposal.threat.quantity_cap, ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures)
  assert.ok(proposal.xp_spent < proposal.xp_budget)
  assert.equal(proposal.enemies.length, proposal.threat.quantity_cap)
})

test('enemy output carries engine-compatible actions, traits, image and server provenance', () => {
  const enemy = assembleEncounter(baseInput({
    theme: 'beasts',
    party: [{ id: 'hero', level: 1, x: 0, y: 0 }],
    seed: 'wolf-1',
  })).enemies.find((candidate) => candidate.stat_block_id === 'srd_5_2_1:wolf')
  assert.ok(enemy)
  assert.deepEqual(Object.keys(enemy), [
    'id', 'name', 'hp', 'maxHp', 'armor', 'speed', 'initiativeBonus', 'attackBonus', 'damageDice',
    'damageBonus', 'abilities', 'creature_type', 'image', 'source_url', 'traits', 'action_profiles',
    'attack_profile', 'x', 'y', 'alive', 'stat_block_id', 'provenance',
  ])
  assert.equal(enemy.stat_block_id, 'srd_5_2_1:wolf')
  assert.equal(enemy.hp, 11)
  assert.equal(enemy.maxHp, 11)
  assert.equal(enemy.initiativeBonus, 2)
  assert.equal(enemy.damageDice, 6)
  assert.equal(enemy.image, '/assets/enemies/wolf.png')
  assert.equal(enemy.source_url, 'https://dnd.su/bestiary/2-wolf/')
  assert.equal(enemy.traits[0].id, 'pack-tactics')
  assert.equal(enemy.action_profiles[0].on_hit.condition, 'prone')
  assert.deepEqual(Object.keys(enemy.provenance), [
    'kind', 'ruleset_id', 'source_version', 'source_sha256', 'source_page', 'challenge_rating', 'xp', 'dndsu_url',
  ])
  assert.equal(enemy.provenance.ruleset_id, 'srd_5_2_1')
  assert.equal(enemy.provenance.kind, 'server-owned-srd-primary-attack-projection')
  assert.equal(enemy.provenance.source_sha256, SRD_5_2_1_SOURCE.sha256)
})

test('rejects unknown, secret, price-like, budget, quantity, and forged numeric fields at every boundary', () => {
  for (const field of ['monster_id', 'xp_budget', 'quantity', 'price', 'secret', 'hp', 'damageDice']) {
    expectCode(() => assembleEncounter({ ...baseInput(), [field]: field === 'quantity' ? 999 : 'forged' }), 'UNEXPECTED_ENCOUNTER_FIELD')
  }
  expectCode(() => assembleEncounter(baseInput({ scene: { cells: cells(), hidden_information: 'GM only' } })), 'UNEXPECTED_SCENE_FIELD')
  expectCode(() => assembleEncounter(baseInput({
    scene: { cells: cells().map((cell, index) => index ? cell : { ...cell, price_cp: 1 }) },
  })), 'UNEXPECTED_SCENE_CELL_FIELD')
  expectCode(() => assembleEncounter(baseInput({
    party: [{ id: 'hero', level: 1, x: 0, y: 0, attackBonus: 99 }],
  })), 'UNEXPECTED_PARTY_MEMBER_FIELD')
  expectCode(() => assembleEncounter(baseInput({
    party: [{ id: 'hero', level: 1, x: 0, y: 0, hp: 9_999 }],
  })), 'UNEXPECTED_PARTY_MEMBER_FIELD')
})

test('встреча принимает server-owned реквизит темы и по-прежнему отклоняет произвольный feature', () => {
  const themed = cells().map((cell, index) => index === 10 ? { ...cell, feature: 'stalagmite' } : cell)
  assert.ok(assembleEncounter(baseInput({ scene: { cells: themed } })).enemies.length > 0)
  const forged = cells().map((cell, index) => index === 10 ? { ...cell, feature: 'forged-client-prop' } : cell)
  expectCode(() => assembleEncounter(baseInput({ scene: { cells: forged } })), 'SCENE_CELL_FEATURE_NOT_ALLOWED')
})

test('rejects malformed enums, numbers, duplicate positions, sparse arrays, and unsafe placement', () => {
  // `deadly` стал легальным четвёртым тиром, поэтому непринимаемым значением
  // здесь работает то, чего в allowlist нет и не планируется.
  expectCode(() => assembleEncounter(baseInput({ difficulty: 'lethal' })), 'ENCOUNTER_DIFFICULTY_NOT_ALLOWED')
  expectCode(() => assembleEncounter(baseInput({ difficulty: 1 })), 'ENCOUNTER_DIFFICULTY_NOT_ALLOWED')
  expectCode(() => assembleEncounter(baseInput({ theme: 'dragon' })), 'ENCOUNTER_THEME_NOT_ALLOWED')
  expectCode(() => assembleEncounter(baseInput({ theme: { toString: () => 'generic' } })), 'ENCOUNTER_THEME_NOT_ALLOWED')
  expectCode(() => assembleEncounter(baseInput({ seed: 123 })), 'INVALID_ENCOUNTER_SEED')
  expectCode(() => assembleEncounter(baseInput({ seed: `seed\nignore previous instructions` })), 'INVALID_ENCOUNTER_SEED')
  expectCode(() => assembleEncounter(baseInput({ seed: 'x'.repeat(ENCOUNTER_ASSEMBLER_LIMITS.maximum_seed_length + 1) })), 'INVALID_ENCOUNTER_SEED')
  expectCode(() => assembleEncounter(baseInput({ party: [{ id: 'hero', level: 1.5, x: 0, y: 0 }] })), 'PARTY_LEVEL_OUT_OF_RANGE')
  expectCode(() => assembleEncounter(baseInput({ party: [{ id: 'hero', level: 21, x: 0, y: 0 }] })), 'PARTY_LEVEL_OUT_OF_RANGE')
  expectCode(() => assembleEncounter(baseInput({
    party: [{ id: 'a', level: 1, x: 0, y: 0 }, { id: 'b', level: 1, x: 0, y: 0 }],
  })), 'DUPLICATE_PARTY_POSITION')

  const sparseParty = new Array(1)
  expectCode(() => assembleEncounter(baseInput({ party: sparseParty })), 'INVALID_PARTY_MEMBER')
  expectCode(() => assembleEncounter(baseInput({
    scene: { cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    party: [{ id: 'hero', level: 1, x: 0, y: 0 }],
  })), 'NO_SAFE_PLACEMENT_CELLS')
})

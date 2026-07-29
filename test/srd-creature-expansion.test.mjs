import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { assembleEncounter, SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'

const EXPECTED_CREATURES = Object.freeze({
  'srd_5_2_1:bandit': {
    name: 'Бандит',
    hp: 11,
    armor: 12,
    speed: 30,
    abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    initiative_bonus: 1,
    challenge_rating: '1/8',
    xp: 25,
    source_page: 261,
    creature_type: 'humanoid',
    image: '/assets/enemies/bandit.png',
    actions: [
      ['scimitar', '1d6+1', 3, 'slashing', 5, undefined],
      ['light-crossbow', '1d8+1', 3, 'piercing', 320, 80],
    ],
  },
  'srd_5_2_1:dire-wolf': {
    name: 'Лютый волк',
    hp: 22,
    armor: 14,
    speed: 50,
    abilities: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 },
    initiative_bonus: 2,
    challenge_rating: '1',
    xp: 200,
    source_page: 347,
    creature_type: 'beast',
    image: '/assets/enemies/dire-wolf.png',
    actions: [['bite', '1d10+3', 5, 'piercing', 5, undefined]],
  },
  'srd_5_2_1:ghoul': {
    name: 'Упырь',
    hp: 22,
    armor: 12,
    speed: 30,
    abilities: { str: 13, dex: 15, con: 10, int: 7, wis: 10, cha: 6 },
    initiative_bonus: 2,
    challenge_rating: '1',
    xp: 200,
    source_page: 288,
    creature_type: 'undead',
    image: '/assets/enemies/ghoul.png',
    actions: [
      ['bite', '1d6+2', 4, 'piercing', 5, undefined],
      ['claw', '1d4+2', 4, 'slashing', 5, undefined],
    ],
  },
  'srd_5_2_1:gnoll-warrior': {
    name: 'Гнолл-воин',
    hp: 27,
    armor: 15,
    speed: 30,
    abilities: { str: 14, dex: 12, con: 11, int: 6, wis: 10, cha: 7 },
    initiative_bonus: 1,
    challenge_rating: '1/2',
    xp: 100,
    source_page: 289,
    creature_type: 'fiend',
    image: '/assets/enemies/gnoll-warrior.png',
    actions: [
      ['rend', '1d6+2', 4, 'piercing', 5, undefined],
      ['bone-bow', '1d10+1', 3, 'piercing', 600, 150],
    ],
  },
  'srd_5_2_1:ogre': {
    name: 'Огр',
    hp: 68,
    armor: 11,
    speed: 40,
    abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
    initiative_bonus: -1,
    challenge_rating: '2',
    xp: 450,
    source_page: 312,
    creature_type: 'giant',
    image: '/assets/enemies/ogre.png',
    actions: [
      ['greatclub', '2d8+4', 6, 'bludgeoning', 5, undefined],
      ['javelin', '2d6+4', 6, 'piercing', 120, 30],
    ],
  },
  'srd_5_2_1:owlbear': {
    name: 'Совомед',
    hp: 59,
    armor: 13,
    speed: 40,
    abilities: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 },
    initiative_bonus: 1,
    challenge_rating: '3',
    xp: 700,
    source_page: 313,
    creature_type: 'monstrosity',
    image: '/assets/enemies/owlbear.png',
    actions: [['rend', '2d8+5', 7, 'slashing', 5, undefined]],
  },
})

function pngDimensions(buffer) {
  assert.ok(buffer.subarray(1, 4).equals(Buffer.from('PNG')), 'файл обязан быть PNG')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

test('новые существа точно проецируют stat blocks из SRD 5.2.1', () => {
  for (const [id, expected] of Object.entries(EXPECTED_CREATURES)) {
    const actual = SRD_5_2_1_MONSTER_ALLOWLIST[id]
    assert.ok(actual, `${id}: запись отсутствует`)
    for (const field of [
      'name', 'hp', 'armor', 'speed', 'initiative_bonus',
      'challenge_rating', 'xp', 'source_page', 'creature_type', 'image',
    ]) {
      assert.equal(actual[field], expected[field], `${id}.${field}`)
    }
    assert.deepEqual(actual.abilities, expected.abilities, `${id}.abilities`)
    assert.ok(actual.source_url?.startsWith('https://'), `${id}.source_url`)
    assert.deepEqual(
      actual.action_profiles.map((action) => [
        action.id,
        action.damage_expression,
        action.attack_modifier,
        action.damage_type,
        action.range_feet,
        action.normal_range_feet,
      ]),
      expected.actions,
      `${id}.action_profiles`,
    )
  }

  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:dire-wolf'].action_profiles[0].on_hit, {
    save_ability: 'str',
    save_dc: 13,
    condition: 'prone',
    duration: 'until-next-turn',
  })
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ghoul'].action_profiles[0].on_hit, {
    damage_expression: '1d6',
    damage_type: 'necrotic',
  })
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ghoul'].action_profiles[1].on_hit, {
    save_ability: 'con',
    save_dc: 10,
    condition: 'paralyzed',
    duration: 'until-next-turn',
  })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ghoul'].traits[0].attacks, 2)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:owlbear'].traits[0].attacks, 2)
})

test('каждое новое существо имеет отдельный локальный портрет 512×512', async () => {
  const hashes = new Set()
  const basenames = new Set()

  for (const [id, expected] of Object.entries(EXPECTED_CREATURES)) {
    const basename = expected.image.replace('/assets/enemies/', '')
    assert.ok(!basenames.has(basename), `${id}: портрет повторно использован`)
    basenames.add(basename)

    const fileUrl = new URL(`../public/assets/enemies/${basename}`, import.meta.url)
    const buffer = await readFile(fileURLToPath(fileUrl))
    assert.ok(buffer.length >= 20_000, `${id}: изображение подозрительно мало`)
    assert.deepEqual(pngDimensions(buffer), { width: 512, height: 512 }, `${id}: размер PNG`)

    const hash = createHash('sha256').update(buffer).digest('hex')
    assert.ok(!hashes.has(hash), `${id}: содержимое портрета повторяется`)
    hashes.add(hash)
  }
})

test('новые существа достижимы через подходящие семантические темы', () => {
  const sceneCells = Array.from({ length: 5 }, (_, y) => (
    Array.from({ length: 7 }, (_, x) => ({ x, y, type: 'floor', revealed: true }))
  )).flat()
  const cases = [
    ['srd_5_2_1:bandit', 'raiders', 1, 'medium', 'reach-0'],
    ['srd_5_2_1:dire-wolf', 'beasts', 2, 'hard', 'reach-0'],
    ['srd_5_2_1:ghoul', 'undead', 2, 'hard', 'reach-0'],
    ['srd_5_2_1:gnoll-warrior', 'warband', 1, 'hard', 'reach-1'],
    ['srd_5_2_1:ogre', 'warband', 4, 'hard', 'reach-0'],
    ['srd_5_2_1:owlbear', 'wilderness', 5, 'medium', 'reach-0'],
  ]

  for (const [id, theme, level, difficulty, seed] of cases) {
    const proposal = assembleEncounter({
      scene: { cells: sceneCells },
      party: [{ id: 'hero', level, x: 0, y: 0 }],
      difficulty,
      theme,
      seed,
    })
    assert.ok(
      proposal.enemies.some((enemy) => enemy.stat_block_id === id),
      `${id}: не собирается темой ${theme}`,
    )
  }
})

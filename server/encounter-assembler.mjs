import { createHash } from 'node:crypto'

export const ENCOUNTER_PROPOSAL_VERSION = 'skazanie:encounter-proposal-v1'

export const ENCOUNTER_ASSEMBLER_LIMITS = Object.freeze({
  maximum_party_size: 8,
  maximum_scene_cells: 500,
  maximum_creatures_per_character: 2,
  maximum_creatures: 12,
  minimum_spawn_distance_cells: 2,
  maximum_seed_length: 120,
  maximum_actor_id_length: 120,
  minimum_character_level: 1,
  maximum_character_level: 20,
  minimum_coordinate: -1_000,
  maximum_coordinate: 1_000,
})

export const SRD_5_2_1_SOURCE = deepFreeze({
  title: 'System Reference Document 5.2.1',
  version: '5.2.1',
  published: '2025-05-01',
  url: 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf',
  landing_url: 'https://www.dndbeyond.com/srd',
  sha256: '8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87',
  license: 'CC-BY-4.0',
  attribution: 'This work includes material from the System Reference Document 5.2.1 (\u201cSRD 5.2.1\u201d) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  encounter_budget_page: 202,
})

// Each entry is a server-owned projection of one SRD 5.2.1 stat block onto the
// combat fields currently supported by the rules engine. damageDice is the
// number of sides in the primary attack's single damage die.
export const SRD_5_2_1_MONSTER_ALLOWLIST = deepFreeze({
  'srd_5_2_1:goblin-minion': {
    name: 'Goblin Minion', hp: 7, armor: 12, speed: 30,
    initiative_bonus: 2, attackBonus: 4, damageDice: 4, damageBonus: 2,
    challenge_rating: '1/8', xp: 25, source_page: 290,
  },
  'srd_5_2_1:goblin-warrior': {
    name: 'Goblin Warrior', hp: 10, armor: 15, speed: 30,
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1/4', xp: 50, source_page: 290,
  },
  'srd_5_2_1:skeleton': {
    name: 'Skeleton', hp: 13, armor: 14, speed: 30,
    initiative_bonus: 3, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '1/4', xp: 50, source_page: 325,
  },
  'srd_5_2_1:zombie': {
    name: 'Zombie', hp: 15, armor: 8, speed: 20,
    initiative_bonus: -2, attackBonus: 3, damageDice: 8, damageBonus: 1,
    challenge_rating: '1/4', xp: 50, source_page: 343,
  },
  'srd_5_2_1:wolf': {
    name: 'Wolf', hp: 11, armor: 12, speed: 40,
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1/4', xp: 50, source_page: 364,
  },
})

const THEMES = deepFreeze({
  goblinoids: ['srd_5_2_1:goblin-minion', 'srd_5_2_1:goblin-warrior'],
  undead: ['srd_5_2_1:skeleton', 'srd_5_2_1:zombie'],
  beasts: ['srd_5_2_1:wolf'],
  generic: Object.keys(SRD_5_2_1_MONSTER_ALLOWLIST),
})

export const ENCOUNTER_THEMES = Object.freeze(Object.keys(THEMES))
export const ENCOUNTER_DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard'])
const SRD_DIFFICULTY = Object.freeze({ easy: 'low', medium: 'moderate', hard: 'high' })

// SRD 5.2.1, printed page 202: XP Budget per Character.
const XP_BUDGET_PER_CHARACTER = deepFreeze({
  1: { low: 50, moderate: 75, high: 100 },
  2: { low: 100, moderate: 150, high: 200 },
  3: { low: 150, moderate: 225, high: 400 },
  4: { low: 250, moderate: 375, high: 500 },
  5: { low: 500, moderate: 750, high: 1_100 },
  6: { low: 600, moderate: 1_000, high: 1_400 },
  7: { low: 750, moderate: 1_300, high: 1_700 },
  8: { low: 1_000, moderate: 1_700, high: 2_100 },
  9: { low: 1_300, moderate: 2_000, high: 2_600 },
  10: { low: 1_600, moderate: 2_300, high: 3_100 },
  11: { low: 1_900, moderate: 2_900, high: 4_100 },
  12: { low: 2_200, moderate: 3_700, high: 4_700 },
  13: { low: 2_600, moderate: 4_200, high: 5_400 },
  14: { low: 2_900, moderate: 4_900, high: 6_200 },
  15: { low: 3_300, moderate: 5_400, high: 7_800 },
  16: { low: 3_800, moderate: 6_100, high: 9_800 },
  17: { low: 4_500, moderate: 7_200, high: 11_700 },
  18: { low: 5_000, moderate: 8_700, high: 14_200 },
  19: { low: 5_500, moderate: 10_700, high: 17_200 },
  20: { low: 6_400, moderate: 13_200, high: 22_000 },
})

const TOP_LEVEL_KEYS = new Set(['scene', 'party', 'difficulty', 'theme', 'seed'])
const SCENE_KEYS = new Set(['cells'])
const CELL_KEYS = new Set(['x', 'y', 'type', 'revealed', 'feature'])
const PARTY_MEMBER_KEYS = new Set(['id', 'level', 'x', 'y'])
const CELL_TYPES = new Set(['wall', 'floor', 'water', 'door'])
const CELL_FEATURES = new Set(['chest', 'altar', 'torch', 'rune', 'stairs', 'enemy'])
const WALKABLE_TYPES = new Set(['floor', 'door'])

export class EncounterAssemblyError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'EncounterAssemblyError'
    this.code = code
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejectUnexpectedKeys(value, allowed, code) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new EncounterAssemblyError('Вход содержит поле, не разрешённое контрактом сборщика столкновения', code)
  }
}

function boundedText(value, maximum, code, label) {
  if (typeof value !== 'string') throw new EncounterAssemblyError(`${label} должен быть строкой`, code)
  const result = value.trim()
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new EncounterAssemblyError(`${label} не прошёл проверку границ`, code)
  }
  return result
}

function coordinate(value, code, label) {
  if (!Number.isSafeInteger(value)
    || value < ENCOUNTER_ASSEMBLER_LIMITS.minimum_coordinate
    || value > ENCOUNTER_ASSEMBLER_LIMITS.maximum_coordinate) {
    throw new EncounterAssemblyError(`${label} должен быть целым числом в разрешённых границах`, code)
  }
  return value
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function positionKey(value) {
  return `${value.x},${value.y}`
}

function validateScene(input) {
  if (!isPlainObject(input)) throw new EncounterAssemblyError('scene должен быть объектом', 'INVALID_SCENE')
  rejectUnexpectedKeys(input, SCENE_KEYS, 'UNEXPECTED_SCENE_FIELD')
  if (!Array.isArray(input.cells) || input.cells.length < 1 || input.cells.length > ENCOUNTER_ASSEMBLER_LIMITS.maximum_scene_cells) {
    throw new EncounterAssemblyError('scene.cells должен быть непустым ограниченным массивом', 'INVALID_SCENE_CELLS')
  }

  const seen = new Set()
  const cells = Array.from(input.cells, (entry) => {
    if (!isPlainObject(entry)) throw new EncounterAssemblyError('Клетка сцены должна быть объектом', 'INVALID_SCENE_CELL')
    rejectUnexpectedKeys(entry, CELL_KEYS, 'UNEXPECTED_SCENE_CELL_FIELD')
    const x = coordinate(entry.x, 'INVALID_SCENE_CELL_COORDINATE', 'cell.x')
    const y = coordinate(entry.y, 'INVALID_SCENE_CELL_COORDINATE', 'cell.y')
    if (typeof entry.type !== 'string' || !CELL_TYPES.has(entry.type)) {
      throw new EncounterAssemblyError('Неизвестный тип клетки', 'SCENE_CELL_TYPE_NOT_ALLOWED')
    }
    if (typeof entry.revealed !== 'boolean') {
      throw new EncounterAssemblyError('cell.revealed должен быть boolean', 'INVALID_SCENE_CELL_VISIBILITY')
    }
    if (entry.feature != null && (typeof entry.feature !== 'string' || !CELL_FEATURES.has(entry.feature))) {
      throw new EncounterAssemblyError('Неизвестный объект в клетке', 'SCENE_CELL_FEATURE_NOT_ALLOWED')
    }
    const key = `${x},${y}`
    if (seen.has(key)) throw new EncounterAssemblyError('Координаты клеток не должны повторяться', 'DUPLICATE_SCENE_CELL')
    seen.add(key)
    return { x, y, type: entry.type, revealed: entry.revealed, ...(entry.feature == null ? {} : { feature: entry.feature }) }
  })
  cells.sort((left, right) => left.y - right.y || left.x - right.x)
  return cells
}

function validateParty(input, cells) {
  if (!Array.isArray(input) || input.length < 1 || input.length > ENCOUNTER_ASSEMBLER_LIMITS.maximum_party_size) {
    throw new EncounterAssemblyError('party должен быть непустым ограниченным массивом', 'INVALID_PARTY')
  }
  const cellsByPosition = new Map(cells.map((cell) => [positionKey(cell), cell]))
  const ids = new Set()
  const positions = new Set()
  const party = Array.from(input, (entry) => {
    if (!isPlainObject(entry)) throw new EncounterAssemblyError('Участник группы должен быть объектом', 'INVALID_PARTY_MEMBER')
    rejectUnexpectedKeys(entry, PARTY_MEMBER_KEYS, 'UNEXPECTED_PARTY_MEMBER_FIELD')
    const id = boundedText(entry.id, ENCOUNTER_ASSEMBLER_LIMITS.maximum_actor_id_length, 'INVALID_PARTY_MEMBER_ID', 'party.id')
    if (ids.has(id)) throw new EncounterAssemblyError('ID участников группы не должны повторяться', 'DUPLICATE_PARTY_MEMBER_ID')
    ids.add(id)
    if (!Number.isSafeInteger(entry.level)
      || entry.level < ENCOUNTER_ASSEMBLER_LIMITS.minimum_character_level
      || entry.level > ENCOUNTER_ASSEMBLER_LIMITS.maximum_character_level) {
      throw new EncounterAssemblyError('Уровень персонажа вне разрешённых границ', 'PARTY_LEVEL_OUT_OF_RANGE')
    }
    const x = coordinate(entry.x, 'INVALID_PARTY_MEMBER_COORDINATE', 'party.x')
    const y = coordinate(entry.y, 'INVALID_PARTY_MEMBER_COORDINATE', 'party.y')
    const key = `${x},${y}`
    const cell = cellsByPosition.get(key)
    if (!cell || !cell.revealed || !WALKABLE_TYPES.has(cell.type)) {
      throw new EncounterAssemblyError('Персонаж должен находиться на открытой проходимой клетке', 'PARTY_POSITION_NOT_WALKABLE')
    }
    if (positions.has(key)) throw new EncounterAssemblyError('Два персонажа не могут занимать одну клетку', 'DUPLICATE_PARTY_POSITION')
    positions.add(key)
    return { id, level: entry.level, x, y }
  })
  party.sort((left, right) => left.id.localeCompare(right.id))
  return party
}

function validateInput(input) {
  if (!isPlainObject(input)) throw new EncounterAssemblyError('Вход сборщика должен быть объектом', 'INVALID_ENCOUNTER_INPUT')
  rejectUnexpectedKeys(input, TOP_LEVEL_KEYS, 'UNEXPECTED_ENCOUNTER_FIELD')
  const cells = validateScene(input.scene)
  const party = validateParty(input.party, cells)
  if (typeof input.difficulty !== 'string' || !ENCOUNTER_DIFFICULTIES.includes(input.difficulty)) {
    throw new EncounterAssemblyError('Неизвестная сложность столкновения', 'ENCOUNTER_DIFFICULTY_NOT_ALLOWED')
  }
  if (typeof input.theme !== 'string' || !Object.hasOwn(THEMES, input.theme)) {
    throw new EncounterAssemblyError('Неизвестная тема столкновения', 'ENCOUNTER_THEME_NOT_ALLOWED')
  }
  const seed = boundedText(input.seed, ENCOUNTER_ASSEMBLER_LIMITS.maximum_seed_length, 'INVALID_ENCOUNTER_SEED', 'seed')
  return { cells, party, difficulty: input.difficulty, theme: input.theme, seed }
}

function safePlacementCells(cells, party) {
  const occupied = new Set(party.map(positionKey))
  const walkable = new Map(cells
    .filter((cell) => cell.revealed && WALKABLE_TYPES.has(cell.type))
    .map((cell) => [positionKey(cell), cell]))
  const reachable = new Set()
  const queue = party.flatMap((member) => walkable.has(positionKey(member)) ? [walkable.get(positionKey(member))] : [])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const key = positionKey(current)
    if (reachable.has(key)) continue
    reachable.add(key)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = walkable.get(`${current.x + dx},${current.y + dy}`)
      if (neighbor && !reachable.has(positionKey(neighbor))) queue.push(neighbor)
    }
  }
  return cells.filter((cell) => (
    cell.revealed
    && WALKABLE_TYPES.has(cell.type)
    && reachable.has(positionKey(cell))
    && cell.feature == null
    && !occupied.has(positionKey(cell))
    && party.every((member) => (
      Math.abs(member.x - cell.x) + Math.abs(member.y - cell.y)
      >= ENCOUNTER_ASSEMBLER_LIMITS.minimum_spawn_distance_cells
    ))
  ))
}

function seededTieBreak(left, right, seed) {
  const leftKey = digest(`${seed}\u0000${left.join('|')}`)
  const rightKey = digest(`${seed}\u0000${right.join('|')}`)
  return leftKey.localeCompare(rightKey) < 0 ? left : right
}

function spendBudget(catalogIds, budgetXp, quantityCap, seed) {
  let states = new Map([[0, []]])
  for (let count = 0; count < quantityCap; count += 1) {
    const next = new Map(states)
    for (const [spent, selection] of states) {
      if (selection.length !== count) continue
      for (const catalogId of catalogIds) {
        const nextSpent = spent + SRD_5_2_1_MONSTER_ALLOWLIST[catalogId].xp
        if (nextSpent > budgetXp) continue
        const candidate = [...selection, catalogId].sort()
        const current = next.get(nextSpent)
        if (!current || current.length > candidate.length) next.set(nextSpent, candidate)
        else if (current.length === candidate.length) next.set(nextSpent, seededTieBreak(current, candidate, seed))
      }
    }
    states = next
  }
  const spentXp = Math.max(...states.keys())
  return { spent_xp: spentXp, stat_block_ids: states.get(spentXp) ?? [] }
}

function deterministicOrder(values, seed, label) {
  return [...values].sort((left, right) => {
    const leftKey = `${left.x},${left.y}`
    const rightKey = `${right.x},${right.y}`
    const leftHash = digest(`${seed}\u0000${label}\u0000${leftKey}`)
    const rightHash = digest(`${seed}\u0000${label}\u0000${rightKey}`)
    return leftHash.localeCompare(rightHash) || leftKey.localeCompare(rightKey)
  })
}

function enemyFrom(statBlockId, position, proposalHash, index, ordinal) {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  const slug = statBlockId.split(':').at(-1)
  return {
    id: `encounter-${proposalHash.slice(0, 16)}-${slug}-${index + 1}`.slice(0, 120),
    name: `${block.name} ${ordinal}`,
    hp: block.hp,
    maxHp: block.hp,
    armor: block.armor,
    speed: block.speed,
    initiativeBonus: block.initiative_bonus,
    attackBonus: block.attackBonus,
    damageDice: block.damageDice,
    damageBonus: block.damageBonus,
    x: position.x,
    y: position.y,
    alive: true,
    stat_block_id: statBlockId,
    provenance: {
      kind: 'server-owned-srd-primary-attack-projection',
      ruleset_id: 'srd_5_2_1',
      source_version: SRD_5_2_1_SOURCE.version,
      source_sha256: SRD_5_2_1_SOURCE.sha256,
      source_page: block.source_page,
      challenge_rating: block.challenge_rating,
      xp: block.xp,
    },
  }
}

export class EncounterAssembler {
  assemble(input) {
    const validated = validateInput(input)
    const canonical = JSON.stringify(validated)
    const proposalHash = digest(`${ENCOUNTER_PROPOSAL_VERSION}\u0000${canonical}`)
    const availableCells = safePlacementCells(validated.cells, validated.party)
    if (!availableCells.length) {
      throw new EncounterAssemblyError('Нет безопасных клеток для размещения противников', 'NO_SAFE_PLACEMENT_CELLS')
    }

    const budgetXp = validated.party.reduce((sum, member) => (
      sum + XP_BUDGET_PER_CHARACTER[member.level][SRD_DIFFICULTY[validated.difficulty]]
    ), 0)
    const quantityCap = Math.min(
      ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures,
      ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures_per_character * validated.party.length,
      availableCells.length,
    )
    const allocation = spendBudget(THEMES[validated.theme], budgetXp, quantityCap, proposalHash)
    if (!allocation.stat_block_ids.length) {
      throw new EncounterAssemblyError('Бюджет не позволяет собрать столкновение выбранной темы', 'BUDGET_CANNOT_FUND_ENCOUNTER')
    }

    const positions = deterministicOrder(availableCells, proposalHash, 'placement')
    const counts = new Map()
    const enemies = allocation.stat_block_ids.map((statBlockId, index) => {
      const ordinal = (counts.get(statBlockId) ?? 0) + 1
      counts.set(statBlockId, ordinal)
      return enemyFrom(statBlockId, positions[index], proposalHash, index, ordinal)
    })
    const spentXp = allocation.spent_xp
    const proposal = {
      proposal_id: `encounter-proposal-${proposalHash.slice(0, 24)}`,
      version: ENCOUNTER_PROPOSAL_VERSION,
      difficulty: validated.difficulty,
      theme: validated.theme,
      xp_budget: budgetXp,
      xp_spent: spentXp,
      threat: {
        budget_xp: budgetXp,
        spent_xp: spentXp,
        unspent_xp: budgetXp - spentXp,
        utilization_bps: Math.floor(spentXp * 10_000 / budgetXp),
        quantity: enemies.length,
        quantity_cap: quantityCap,
      },
      enemies,
      source: SRD_5_2_1_SOURCE,
    }
    return deepFreeze(proposal)
  }
}

export function assembleEncounter(input) {
  return new EncounterAssembler().assemble(input)
}

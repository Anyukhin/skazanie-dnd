import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { planHeroCombatCommand } from '../server/party-tactics.mjs'
import { buildCombatLabState } from '../server/combat-lab-setup.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { runCombatScenario } from '../eval/combat-lab.mjs'

const applyAll = (state, events) => events.reduce(applyGameEvent, state)
const dice = (values = []) => new DiceService({ rng: new SequenceDiceRng(values), idFactory: (() => { let n = 0; return () => `arena-roll-${++n}` })(), now: () => '2026-09-07T12:00:00.000Z' })
const authoritative = (values = []) => ({ diceService: dice(values), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } })
const floor = (size = 12) => Array.from({ length: size * size }, (_, index) => ({ x: index % size, y: Math.floor(index / size), type: 'floor', revealed: true }))
const economy = () => ({ action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, movement_bonus: 0, attacks_used: 0, attacks_allowed: 1 })
const sword = { id: 'sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', equipped: true, quantity: 1, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function arena({ heroes = [], enemies = [], positions = {}, size = 12, resources = {}, conditions = {}, initiative = null } = {}) {
  const state = normalizeCampaignState({
    sessionCode: 'TACTICS-ARENA',
    partyMemberIds: heroes.map((hero) => hero.id),
    activePlayerId: heroes[0]?.id,
    players: heroes,
    enemies,
    scene: { title: 'Арена', location: 'arena', cells: floor(size) },
    mechanics: {
      positions,
      resources,
      conditions,
      death: { saving_throws: {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true,
        round: 1,
        initiative: initiative ?? [...heroes, ...enemies].map((actor, index) => ({ actor_id: actor.id, total: 20 - index })),
        active_index: 0,
        action_economy: Object.fromEntries([...heroes, ...enemies].map((actor) => [actor.id, economy()])),
      },
    },
  })
  return state
}

const hero = (id = 'hero', overrides = {}) => ({
  id, character: id, characterClass: 'fighter', role: 'Воин', level: 1,
  hp: 20, maxHp: 20, armor: 16, speed: 30, proficiency: 2,
  abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
  inventory: [sword], x: 1, y: 1, ...overrides,
})

const enemy = (id = 'enemy', overrides = {}) => ({
  id, name: id, hp: 16, maxHp: 16, armor: 12, speed: 30, alive: true,
  abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
  x: 3, y: 1, ...overrides,
})

test('колдун выбирает усиленный заговор вместо более слабого арбалета', () => {
  const bow = { id: 'crossbow', type: 'weapon', equipped: true, quantity: 1, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 80, longRange: 320 } }
  const state = arena({ heroes: [hero('hero', { characterClass: 'warlock', role: 'Колдун', level: 5,
    abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 10, cha: 16 }, inventory: [bow], knownSpellIds: ['eldritch-blast'], preparedSpellIds: ['eldritch-blast'] })],
    enemies: [enemy('enemy', { x: 7, y: 1 })], positions: { hero: { x: 1, y: 1 }, enemy: { x: 7, y: 1 } } })
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.spell_id, 'eldritch-blast')
  assert.doesNotThrow(() => resolvePlan(state, plan, [15, 4, 15, 4]))
})

function resolvePlan(state, plan, values = []) {
  const result = resolveCommand(plan.command, state, { diceService: dice(values), context: { serverAuthoritativeCombat: true, allowedActorIds: [plan.command.actor_id] } })
  return applyAll(state, result.events)
}

test('планировщик кастера выбирает поддержанное заклинание на visible-projection со скрытыми HP врага', () => {
  const state = arena({
    heroes: [hero('hero', { characterClass: 'wizard', role: 'Волшебник', level: 5, abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 10, cha: 10 }, knownSpellIds: ['fire-bolt'], preparedSpellIds: ['fire-bolt'] })],
    enemies: [enemy('goblin', { hp: 12 })],
    positions: { hero: { x: 1, y: 1 }, goblin: { x: 8, y: 1 } },
    resources: { hero: { spell_slots_1: { current: 2, max: 2 } } },
  })
  const visible = structuredClone(state)
  delete visible.enemies[0].hp
  delete visible.enemies[0].maxHp

  const plan = planHeroCombatCommand(visible, 'hero')
  assert.equal(plan.command.command_type, 'CastSpell')
  assert.equal(plan.command.spell_id, 'fire-bolt')
  assert.match(plan.reason, /плам|атак|заклин/u)
})

test('исчерпанные ячейки не заставляют мага выдумывать боевое заклинание: остаётся заговор', () => {
  const state = arena({
    heroes: [hero('hero', { characterClass: 'wizard', role: 'Волшебник', level: 5, abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 10, cha: 10 }, knownSpellIds: ['fireball', 'fire-bolt'], preparedSpellIds: ['fireball', 'fire-bolt'] })],
    enemies: [enemy('goblin', { x: 8, y: 1 })],
    positions: { hero: { x: 1, y: 1 }, goblin: { x: 8, y: 1 } },
    resources: { hero: { spell_slots_3: { current: 0, max: 1 } } },
  })
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.command_type, 'CastSpell')
  assert.equal(plan.command.spell_id, 'fire-bolt')
})

test('волшебник 12 уровня учитывает все лучи и выбирает Палящий луч вместо заговора', () => {
  const state = arena({
    heroes: [hero('hero', { characterClass: 'wizard', level: 12, abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
      knownSpellIds: ['fire-bolt', 'scorching-ray'], preparedSpellIds: ['scorching-ray'] })],
    enemies: [enemy('enemy', { hp: 100, maxHp: 100 })],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 8, y: 1 } },
    resources: { hero: { spell_slots_2: { current: 3, max: 3 }, ...Object.fromEntries([3, 4, 5, 6].map(level => [`spell_slots_${level}`, { current: 0, max: 1 }])) } },
  })
  const view = campaignStateForViewer(state, { id: 'user', role: 'player', heroIds: ['hero'] }, 'hero')
  const plan = planHeroCombatCommand(view, 'hero')
  assert.equal(plan.command.spell_id, 'scorching-ray')
  const after = resolvePlan(state, plan, Array(100).fill(4))
  assert.equal(after.mechanics.resources.hero.spell_slots_2.current, 2)
})

test('маг сравнивает усиление доступной ячейкой, когда базовая Волшебная стрела слабее заговора', () => {
  const state = arena({
    heroes: [hero('hero', { characterClass: 'wizard', level: 12, knownSpellIds: ['fire-bolt', 'magic-missile'], preparedSpellIds: ['magic-missile'] })],
    enemies: [enemy('enemy', { hp: 100, maxHp: 100 })],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 8, y: 1 } },
    resources: { hero: { spell_slots_1: { current: 4, max: 4 }, spell_slots_2: { current: 3, max: 3 }, spell_slots_6: { current: 1, max: 1 },
      spell_slots_3: { current: 3, max: 3 }, ...Object.fromEntries([4, 5].map(level => [`spell_slots_${level}`, { current: 0, max: 1 }])) } },
  })
  const plan = planHeroCombatCommand(campaignStateForViewer(state, { id: 'user', role: 'player', heroIds: ['hero'] }, 'hero'), 'hero')
  assert.equal(plan.command.spell_id, 'magic-missile')
  assert.equal(plan.command.slot_level, 2, 'Для усиления достаточно второго круга: единственную ячейку шестого бережём')
  assert.doesNotThrow(() => resolvePlan(state, plan, [3]))
})

test('Огненный шар можно сместить за врагов, чтобы не задеть союзника рядом с ними', () => {
  const state = arena({
    heroes: [hero('hero', { characterClass: 'wizard', level: 5, knownSpellIds: ['fire-bolt', 'fireball'], preparedSpellIds: ['fireball'] }), hero('ally')],
    enemies: [enemy('one'), enemy('two')],
    positions: { hero: { x: 1, y: 1 }, ally: { x: 5, y: 5 }, one: { x: 6, y: 5 }, two: { x: 6, y: 6 } },
    resources: { hero: { spell_slots_3: { current: 1, max: 1 } } },
  })
  const plan = planHeroCombatCommand(campaignStateForViewer(state, { id: 'user', role: 'player', heroIds: ['hero'] }, 'hero'), 'hero')
  assert.equal(plan.command.spell_id, 'fireball')
  const after = resolvePlan(state, plan, Array(100).fill(4))
  assert.equal(after.players.find(actor => actor.id === 'ally').hp, state.players[1].hp)
  assert.ok(after.enemies.every(actor => actor.hp < 16))
})

test('заклинатель выбирает открытую цель, если ближайшая закрыта стеной', () => {
  const state = arena({
    heroes: [hero('hero', { characterClass: 'wizard', level: 5, knownSpellIds: ['fire-bolt'], preparedSpellIds: [] })],
    enemies: [enemy('blocked'), enemy('clear')],
    positions: { hero: { x: 1, y: 1 }, blocked: { x: 3, y: 1 }, clear: { x: 1, y: 6 } },
  })
  state.scene.cells = floor().map(cell => cell.x === 2 && cell.y < 3 ? { ...cell, type: 'wall' } : cell)
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.spell_id, 'fire-bolt')
  assert.equal(plan.command.target_id, 'clear')
})

test('колдун накладывает Сглаз на врага перед лучами и сохраняет концентрацию', () => {
  const state = arena({ heroes: [hero('hero', { characterClass: 'warlock', role: 'Колдун', level: 5,
    knownSpellIds: ['eldritch-blast', 'hex'], preparedSpellIds: ['hex'], abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 10, cha: 16 } })],
    enemies: [enemy('enemy', { hp: 100, maxHp: 100 })], positions: { hero: { x: 1, y: 1 }, enemy: { x: 8, y: 1 } } })
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.spell_id, 'hex')
  assert.equal(plan.command.target_id, 'enemy')
  const after = resolvePlan(state, plan)
  assert.equal(planHeroCombatCommand(after, 'hero').command.spell_id, 'eldritch-blast')
})

test('паладин подготавливает Пылающую кару бонусным действием перед ударом', () => {
  const state = arena({ heroes: [hero('hero', { characterClass: 'paladin', role: 'Паладин', level: 5,
    knownSpellIds: ['searing-smite'], preparedSpellIds: ['searing-smite'] })], enemies: [enemy('enemy', { hp: 100, maxHp: 100 })],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 2, y: 1 } } })
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.spell_id, 'searing-smite')
  const after = resolvePlan(state, plan)
  assert.equal(after.mechanics.combat.action_economy.hero.action, true)
  assert.equal(after.mechanics.combat.action_economy.hero.bonus_action, false)
  const attack = planHeroCombatCommand(after, 'hero').command
  assert.ok(attack.command_type === 'MakeAttack' || attack.action_id === 'divine-smite')
  state.mechanics.combat.action_economy.hero = { ...economy(), action: false, attacks_used: 1, attacks_allowed: 2 }
  assert.equal(planHeroCombatCommand(state, 'hero').command.spell_id, 'searing-smite', 'Свободное бонусное действие усиливает и оставшуюся дополнительную атаку')
})

test('лечащий герой поднимает союзника с 0 ОЗ бонусным заклинанием', () => {
  const healer = hero('hero', { characterClass: 'cleric', role: 'Жрец', level: 3, abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 16, cha: 10 }, knownSpellIds: ['healing-word'], preparedSpellIds: ['healing-word'] })
  const fallen = hero('fallen', { hp: 0, x: 2, y: 1, inventory: [] })
  const state = arena({
    heroes: [healer, fallen], enemies: [enemy()],
    positions: { hero: { x: 1, y: 1 }, fallen: { x: 2, y: 1 }, enemy: { x: 8, y: 8 } },
    resources: { hero: { spell_slots_1: { current: 2, max: 2 } } },
    conditions: { fallen: [{ id: 'unconscious' }] },
  })
  state.mechanics.death.saving_throws.fallen = { successes: 1, failures: 0, stable: false }
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.command_type, 'CastSpell')
  assert.equal(plan.command.spell_id, 'healing-word')
  assert.equal(plan.command.target_id, 'fallen')
  const after = resolvePlan(state, plan, [4])
  assert.ok(after.players.find((actor) => actor.id === 'fallen').hp > 0)
})

test('площадное заклинание выбирает точку с врагами и отбрасывает точку, задевающую союзника', () => {
  const caster = hero('hero', { characterClass: 'wizard', role: 'Волшебник', level: 5, abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 10, cha: 10 }, knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'] })
  const state = arena({
    heroes: [caster, hero('ally', { x: 2, y: 2, inventory: [] })],
    enemies: [enemy('one', { x: 7, y: 1 }), enemy('two', { x: 8, y: 1 })],
    positions: { hero: { x: 1, y: 1 }, ally: { x: 2, y: 2 }, one: { x: 7, y: 1 }, two: { x: 8, y: 1 } },
    resources: { hero: { spell_slots_3: { current: 1, max: 1 } } },
  })
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.command_type, 'CastSpell')
  assert.equal(plan.command.spell_id, 'fireball')
  assert.deepEqual(plan.command.to, { x: 7, y: 1 })
})

test('бонусное Второе дыхание не съедает обычную атаку, а затем Extra Attack продолжает разрешённое действие', () => {
  const state = arena({
    heroes: [hero('hero', { level: 5, hp: 5 })], enemies: [enemy('enemy')],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 2, y: 1 } },
    resources: { hero: { second_wind: { current: 1, max: 1 }, action_surge: { current: 1, max: 1 } } },
  })
  const first = planHeroCombatCommand(state, 'hero')
  assert.equal(first.command.action_id, 'second-wind')
  const afterWind = resolvePlan(state, first, [5])
  const attack = planHeroCombatCommand(afterWind, 'hero')
  assert.equal(attack.command.command_type, 'MakeAttack')

  afterWind.mechanics.combat.action_economy.hero.action = false
  afterWind.mechanics.combat.action_economy.hero.attacks_used = 1
  afterWind.mechanics.combat.action_economy.hero.attacks_allowed = 2
  const continuation = planHeroCombatCommand(afterWind, 'hero')
  assert.equal(continuation.command.command_type, 'MakeAttack')
})

test('Всплеск действий возвращает потраченное действие и не подменяет саму атаку', () => {
  const state = arena({ heroes: [hero('hero', { level: 5 })], enemies: [enemy('enemy', { x: 2, y: 1 })], positions: { hero: { x: 1, y: 1 }, enemy: { x: 2, y: 1 } } })
  state.mechanics.combat.action_economy.hero.action = false
  state.mechanics.resources.hero.action_surge = { current: 1, max: 1 }
  const surge = planHeroCombatCommand(state, 'hero')
  assert.equal(surge.command.action_id, 'action-surge')
  const afterSurge = resolvePlan(state, surge)
  assert.equal(afterSurge.mechanics.combat.action_economy.hero.action, true)
  assert.equal(planHeroCombatCommand(afterSurge, 'hero').command.command_type, 'MakeAttack')
})

test('после лечения герой не идёт мимо соседнего врага ради уже недоступной атаки', () => {
  const state = arena({ heroes: [hero('hero', { level: 5 })], enemies: [enemy('near'), enemy('far')],
    positions: { hero: { x: 1, y: 1 }, near: { x: 2, y: 1 }, far: { x: 7, y: 5 } } })
  state.mechanics.combat.action_economy.hero = { ...economy(), action: false, attacks_used: 0, attacks_allowed: 2 }
  state.mechanics.resources.hero.action_surge = { current: 0, max: 1 }
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.command_type, 'EndTurn')
})

test('паладин поднимает павшего союзника Наложением рук, когда нет лечебных заклинаний', () => {
  const state = arena({ heroes: [hero('hero', { characterClass: 'paladin', role: 'Паладин', level: 5, knownSpellIds: [], preparedSpellIds: [] }), hero('fallen', { hp: 0 })], enemies: [enemy()],
    positions: { hero: { x: 1, y: 1 }, fallen: { x: 1, y: 2 }, enemy: { x: 7, y: 5 } },
    resources: { hero: { lay_on_hands: { current: 25, max: 25 } } } })
  state.mechanics.death.saving_throws.fallen = { successes: 0, failures: 1, stable: false }
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.action_id, 'lay-on-hands')
  assert.equal(plan.command.target_id, 'fallen')
  const after = resolvePlan(state, plan)
  assert.equal(after.players[1].hp, 5)
  assert.equal(after.mechanics.resources.hero.lay_on_hands.current, 20)
})

test('паладин сравнивает Божественную кару с обычным ударом по доступной цели', () => {
  const state = arena({ heroes: [hero('hero', { characterClass: 'paladin', role: 'Паладин', level: 5, knownSpellIds: [], preparedSpellIds: [] })], enemies: [enemy('far'), enemy('near', { hp: 100, maxHp: 100 })],
    positions: { hero: { x: 1, y: 1 }, near: { x: 2, y: 1 }, far: { x: 7, y: 5 } },
    resources: { hero: { spell_slots_1: { current: 4, max: 4 } } } })
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.action_id, 'divine-smite')
  assert.equal(plan.command.target_id, 'near')
  const after = resolvePlan(state, plan, Array(30).fill(4))
  assert.equal(after.mechanics.resources.hero.spell_slots_1.current, 3)
})

test('заблокированный маршрут даёт безопасный EndTurn, а не недействительное перемещение', () => {
  const cells = floor(7).map((cell) => cell.x === 2 ? { ...cell, type: 'wall' } : cell)
  const state = arena({ heroes: [hero()], enemies: [enemy('enemy', { x: 5, y: 1 })], positions: { hero: { x: 1, y: 1 }, enemy: { x: 5, y: 1 } }, size: 7 })
  state.scene.cells = cells
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.command_type, 'EndTurn')
  assert.doesNotThrow(() => resolvePlan(state, plan))
})

test('линия к цели за сплошной стеной не превращается в незаконную дальнюю атаку', () => {
  const bow = { id: 'bow', type: 'weapon', equipped: true, quantity: 1, combat: { kind: 'ranged', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 80, longRange: 320 } }
  const state = arena({
    heroes: [hero('hero', { characterClass: 'ranger', role: 'Следопыт', inventory: [bow] })],
    enemies: [enemy('enemy', { x: 5, y: 1 })],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 5, y: 1 } },
    size: 7,
  })
  state.scene.cells = floor(7).map((cell) => cell.x === 2 ? { ...cell, type: 'wall' } : cell)
  const plan = planHeroCombatCommand(state, 'hero')
  assert.notEqual(plan.command.command_type, 'MakeAttack')
  assert.doesNotThrow(() => resolvePlan(state, plan))
})

test('герой продолжает продвижение, если союзник занял единственный проход', () => {
  const state = arena({
    heroes: [
      hero('front', { x: 0, y: 3 }),
      hero('blocker', { x: 5, y: 3, inventory: [] }),
    ],
    enemies: [enemy('enemy', { x: 8, y: 3 })],
    positions: { front: { x: 0, y: 3 }, blocker: { x: 5, y: 3 }, enemy: { x: 8, y: 3 } },
  })
  state.scene.cells = floor(12).map((cell) => cell.x === 5 && cell.y !== 3 ? { ...cell, type: 'wall' } : cell)

  const visible = campaignStateForViewer(state, { id: 'front-user', role: 'player', heroIds: ['front'] }, 'front')
  delete visible.enemies[0].hp
  delete visible.enemies[0].maxHp
  const plan = planHeroCombatCommand(visible, 'front')

  assert.equal(plan.command.command_type, 'MoveActor')
  assert.deepEqual(plan.command.to, { x: 4, y: 3 }, 'нужно занять свободную клетку перед союзником')
  assert.match(plan.reason, /Продвин|Подойти/u)
  assert.doesNotThrow(() => resolvePlan(state, plan))
})

test('бот не предлагает «Потушить союзника» без действующего пламени', () => {
  const state = arena({
    heroes: [hero('front', { x: 3, y: 4 }), hero('blocker', { x: 4, y: 4, inventory: [] })],
    enemies: [enemy('enemy', { x: 8, y: 3 })],
    positions: { front: { x: 3, y: 4 }, blocker: { x: 4, y: 4 }, enemy: { x: 8, y: 3 } },
  })
  const blocked = new Set(['2,4', '3,3', '3,5', '4,2', '4,3', '4,4', '5,3'])
  state.scene.cells = floor(12).map((cell) => blocked.has(`${cell.x},${cell.y}`) ? { ...cell, type: 'wall' } : cell)

  const plan = planHeroCombatCommand(campaignStateForViewer(state, { id: 'front-user', role: 'player', heroIds: ['front'] }, 'front'), 'front')

  assert.notEqual(plan.command.action_id, 'extinguish-ally')
  assert.doesNotThrow(() => resolvePlan(state, plan))
})

test('новый planner отвечает Контрзаклинанием только на реально открытое окно', () => {
  const wizard = hero('hero', {
    characterClass: 'wizard', role: 'Волшебник', level: 5,
    abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
    knownSpellIds: ['counterspell', 'fire-bolt'], preparedSpellIds: ['counterspell', 'fire-bolt'],
  })
  const enemyWizard = enemy('enemy', {
    characterClass: 'wizard', role: 'Волшебник', level: 5,
    abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
    knownSpellIds: ['chromatic-orb'], preparedSpellIds: ['chromatic-orb'], x: 3, y: 1,
  })
  const state = arena({
    heroes: [wizard], enemies: [enemyWizard],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 3, y: 1 } },
    initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }],
    resources: { hero: { spell_slots_3: { current: 1, max: 1 } }, enemy: { spell_slots_1: { current: 1, max: 1 } } },
  })
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'chromatic-orb', target_id: 'hero', target_ids: ['hero'], server_authoritative: true }, state, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(state, cast.events)
  assert.deepEqual(waiting.mechanics.combat.reaction_window.action_ids, ['cast:counterspell'])
  const visible = structuredClone(waiting)
  delete visible.enemies[0].hp
  delete visible.enemies[0].maxHp
  const plan = planHeroCombatCommand(visible, 'hero')
  assert.equal(plan.command.action_id, 'cast:counterspell')
  const after = resolvePlan(waiting, plan)
  assert.ok(after.mechanics.combat.reaction_window == null)
  assert.ok(after.mechanics.resources.hero.spell_slots_3.current < 1)
})

test('новый planner выбирает Парирование из предложенных реакций и не тратит его без урона', () => {
  const state = arena({
    heroes: [hero('hero', { level: 5, subclass: 'Мастер боевых искусств', role: 'Воин · Мастер боевых искусств' })],
    enemies: [enemy('enemy', { attack_profile: { name: 'Коготь', attack_modifier: 4, damage_expression: '1d8', damage_type: 'slashing', range_feet: 5 } })],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 2, y: 1 } },
    initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }],
  })
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'enemy', target_id: 'hero', server_authoritative: true }, state, { diceService: dice([18, 8]), context: { serverAuthoritativeCombat: true } })
  const damaged = applyAll(state, attack.events)
  assert.ok(damaged.mechanics.combat.reaction_window.action_ids.includes('parry'))
  const plan = planHeroCombatCommand(damaged, 'hero')
  assert.equal(plan.command.action_id, 'parry')
  const after = resolvePlan(damaged, plan, [8])
  assert.equal(after.mechanics.combat.reaction_window, null)
  assert.ok(after.players[0].hp > damaged.players[0].hp)
})

test('новый planner выбирает Поглощение стихий для предложенного элементального урона', () => {
  const wizard = hero('hero', {
    characterClass: 'wizard', role: 'Волшебник', level: 3,
    abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
    knownSpellIds: ['absorb-elements'], preparedSpellIds: ['absorb-elements'],
  })
  const state = arena({
    heroes: [wizard],
    enemies: [enemy('enemy', { attack_profile: { name: 'Пламя', attack_modifier: 4, damage_expression: '1d8', damage_type: 'fire', range_feet: 5 } })],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 2, y: 1 } },
    initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }],
    resources: { hero: { spell_slots_1: { current: 1, max: 1 } } },
  })
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'enemy', target_id: 'hero', server_authoritative: true }, state, { diceService: dice([18, 8]), context: { serverAuthoritativeCombat: true } })
  const damaged = applyAll(state, attack.events)
  assert.ok(damaged.mechanics.combat.reaction_window.action_ids.includes('cast:absorb-elements'))
  const plan = planHeroCombatCommand(damaged, 'hero')
  assert.equal(plan.command.action_id, 'cast:absorb-elements')
})

test('новый planner использует Ответный удар только в окне после промаха', () => {
  const state = arena({
    heroes: [hero('hero', { level: 5, subclass: 'Мастер боевых искусств', role: 'Воин · Мастер боевых искусств' })],
    enemies: [enemy('enemy', { attack_profile: { name: 'Коготь', attack_modifier: 4, damage_expression: '1d8', damage_type: 'slashing', range_feet: 5 } })],
    positions: { hero: { x: 1, y: 1 }, enemy: { x: 2, y: 1 } },
    initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }],
  })
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'enemy', target_id: 'hero', server_authoritative: true }, state, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const missed = applyAll(state, attack.events)
  assert.ok(missed.mechanics.combat.reaction_window.action_ids.includes('riposte'))
  assert.equal(planHeroCombatCommand(missed, 'hero').command.action_id, 'riposte')
})

test('новый planner принимает Несгибаемость только из окна проваленного спасброска', () => {
  const state = arena({ heroes: [hero('hero', { level: 9, hp: 0 })], enemies: [enemy()] })
  state.mechanics.conditions.hero = [{ id: 'unconscious' }]
  state.mechanics.death.saving_throws.hero = { successes: 0, failures: 1, stable: false }
  state.mechanics.resources.hero.indomitable = { current: 1, max: 1 }
  state.mechanics.combat.reaction_window = {
    id: 'indomitable-window', trigger: 'failed-saving-throw', actor_id: 'hero', source_actor_id: 'enemy', target_id: 'hero',
    action_ids: ['indomitable'], action_options: [{ id: 'indomitable', resource: 'indomitable', cost: 1 }],
  }
  const plan = planHeroCombatCommand(state, 'hero')
  assert.equal(plan.command.action_id, 'indomitable')
})

test('реальный builder арены даёт бойцу действие или маршрут, а не бесконечный EndTurn', { timeout: 120_000 }, async () => {
  const initialState = await buildCombatLabState({
    mapId: 'open-courtyard',
    party: [{ source: 'class', classId: 'fighter', level: 5, x: 1, y: 1 }],
    enemies: [
      { monsterId: 'dnd_5e_2014:monster:goblin', x: 7, y: 1 },
      { monsterId: 'dnd_5e_2014:monster:goblin', x: 7, y: 3 },
    ],
  })
  const plans = []
  const report = await runCombatScenario({
    scenario: 'custom',
    seed: 1,
    initialState,
    maxSteps: 40,
    chooseCommand: (view, actorId) => {
      const plan = planHeroCombatCommand(view, actorId)
      plans.push(plan)
      return plan
    },
  })
  assert.ok(plans.some(({ command }) => ['MoveActor', 'MakeAttack', 'CastSpell'].includes(command.command_type)), JSON.stringify(plans))
  assert.equal(report.error?.code, undefined, report.error?.message)
})

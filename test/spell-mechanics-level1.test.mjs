import assert from 'node:assert/strict'
import test from 'node:test'

import { combatSpellFor, combatSpellsFor, spellCatalogInfo } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `level1-roll-${++id}`, now: () => '2026-07-13T12:00:00.000Z' })
}

function stateFor(characterClass = 'wizard', level = 3) {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'LEVEL1-SPELLS',
    partyMemberIds: ['caster', 'ally'],
    players: [
      { id: 'caster', character: 'Заклинатель', characterClass, level, hp: 20, maxHp: 20, armor: 10, speed: 30, proficiency: 2, abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 16, cha: 16 }, inventory: [], x: 1, y: 1 },
      { id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 1, hp: 6, maxHp: 20, armor: 12, speed: 30, proficiency: 2, abilities: { str: 12, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, inventory: [], x: 1, y: 2 },
    ],
    enemies: [
      { id: 'weak', name: 'Слабый враг', hp: 5, maxHp: 5, armor: 12, speed: 30, attackBonus: 4, damageDice: 6, damageBonus: 0, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 8 }, x: 2, y: 1, alive: true },
      { id: 'strong', name: 'Сильный враг', hp: 30, maxHp: 30, armor: 13, speed: 30, attackBonus: 4, damageDice: 6, damageBonus: 0, abilities: { str: 12, dex: 10, con: 12, int: 10, wis: 10, cha: 10 }, x: 3, y: 1, alive: true },
    ],
    scene: { turn: 1, cells },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'caster', total: 18 }, { actor_id: 'weak', total: 12 }, { actor_id: 'strong', total: 10 }], active_index: 0, action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }, weak: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }, strong: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
  })
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)

test('каталог консервативно разделяет partial, heuristic и ruling-only заклинания', () => {
  const wizard = stateFor('wizard').players[0]
  const info = spellCatalogInfo()
  assert.equal(info.verifiedMechanics, 0)
  assert.equal(info.partialMechanics, 232)
  assert.equal(info.heuristicMechanics, 204)
  assert.equal(info.rulingOnlyMechanics, 3)
  const classifiedSpells = combatSpellsFor(wizard)
  assert.ok(classifiedSpells.length > 0)
  assert.ok(classifiedSpells.every((spell) => ['verified', 'partial', 'heuristic', 'ruling-only'].includes(spell.mechanicsSupport)))
  assert.equal(combatSpellFor(wizard, 'magic-missile')?.mechanicsSupport, 'partial')
  assert.equal(combatSpellFor(wizard, 'mage-hand')?.mechanicsSupport, 'heuristic')
  assert.equal(combatSpellFor(wizard, 'feather-fall')?.mechanicsSupport, 'ruling-only')
  assert.deepEqual(
    ['magic-missile', 'armor-of-agathys', 'sleep', 'false-life'].map((id) => {
      const ownerClass = id === 'armor-of-agathys' ? 'warlock' : 'wizard'
      const spell = combatSpellFor(stateFor(ownerClass).players[0], id)
      return [id, spell?.mechanicsAccuracy, spell?.kind, spell?.target]
    }),
    [
      ['magic-missile', 'verified-dndsu', 'damage', 'enemy'],
      ['armor-of-agathys', 'verified-dndsu', 'buff', 'self'],
      ['sleep', 'verified-dndsu', 'area-damage', 'point'],
      ['false-life', 'verified-dndsu', 'buff', 'self'],
    ],
  )
  assert.equal(combatSpellFor(wizard, 'magic-missile')?.projectileCount, 3)
})

test('Волшебная стрела автоматически наносит общий урон всех дротиков и усиливается ячейкой', () => {
  const initial = stateFor('wizard', 3)
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'magic-missile', target_id: 'strong', target_ids: ['strong'], slot_level: 2, server_authoritative: true }, initial, { diceService: dice([3]), context: { serverAuthoritativeCombat: true } })
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.automatic_hit, true)
  assert.equal(damage.payload.projectile_count, 4)
  assert.equal(damage.payload.raw_amount, 16)
  assert.equal(applyAll(initial, result.events).enemies.find((enemy) => enemy.id === 'strong').hp, 14)
})

test('непроверенное заклинание отклоняется до серверного разрешения хода', () => {
  const initial = stateFor('wizard', 3)
  const before = structuredClone(initial)
  assert.throws(
    () => resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'mage-hand', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } }),
    (error) => error.code === 'MECHANICS_NOT_VERIFIED',
  )
  assert.deepEqual(initial, before)
})

test('Щит открывается реакцией на Волшебную стрелу и отменяет весь её урон', () => {
  const initial = stateFor('wizard', 3)
  const enemy = initial.enemies.find((candidate) => candidate.id === 'strong')
  enemy.characterClass = 'wizard'
  enemy.level = 3
  enemy.proficiency = 2
  enemy.abilities.int = 16
  const normalized = normalizeCampaignState(initial)
  normalized.mechanics.combat.active_index = 2
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'strong', spell_id: 'magic-missile', target_id: 'caster', target_ids: ['caster'], server_authoritative: true }, normalized, { diceService: dice([3]), context: { serverAuthoritativeCombat: true } })
  const damaged = applyAll(normalized, cast.events)
  assert.equal(damaged.players[0].hp, 8)
  assert.ok(damaged.mechanics.combat.reaction_window.action_ids.includes('cast:shield'))

  const shield = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'caster', action_id: 'cast:shield', server_authoritative: true }, damaged, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(damaged, shield.events)
  assert.equal(after.players[0].hp, 20)
  assert.ok(after.mechanics.conditions.caster.some((condition) => condition.id === 'shielded'))
})

test('Доспех Агатиса даёт временные хиты и отвечает полным холодным уроном на рукопашное попадание', () => {
  const initial = stateFor('warlock', 1)
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'armor-of-agathys', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const protectedState = applyAll(initial, cast.events)
  assert.equal(protectedState.mechanics.temporary_hp.caster, 5)
  assert.ok(protectedState.mechanics.conditions.caster.some((condition) => condition.id === 'armor-of-agathys:5'))

  protectedState.mechanics.combat.active_index = 1
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'weak', target_id: 'caster', server_authoritative: true }, protectedState, { diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(protectedState, attack.events)
  assert.equal(after.mechanics.temporary_hp.caster, 0)
  assert.equal(after.players[0].hp, 19)
  assert.equal(after.enemies.find((enemy) => enemy.id === 'weak').hp, 0)
})

test('Bless поддерживает несколько целей и не расходует бонус 1к4 после одного спасброска', () => {
  const initial = stateFor('cleric', 3)
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'bless', target_id: 'caster', target_ids: ['caster', 'ally'], server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const blessed = applyAll(initial, cast.events)
  assert.ok(blessed.mechanics.conditions.caster.some((condition) => condition.id === 'bless-d4'))
  assert.ok(blessed.mechanics.conditions.ally.some((condition) => condition.id === 'bless-d4'))
  const save = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'caster', ability: 'con', difficulty: 20 }, blessed, { diceService: dice([4, 10]), context: { isAdmin: true } })
  assert.equal(save.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 16)
  const after = applyAll(blessed, save.events)
  assert.ok(after.mechanics.conditions.caster.some((condition) => condition.id === 'bless-d4'))
})

test('Усыпление расходует пул хитов от слабых существ к сильным и игнорирует нежить', () => {
  const initial = stateFor('wizard', 3)
  initial.enemies.find((enemy) => enemy.id === 'strong').creature_type = 'undead'
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'sleep', to: { x: 2, y: 1 }, server_authoritative: true }, initial, { diceService: dice([4, 4, 4, 4, 4]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.ok(after.mechanics.conditions.weak.some((condition) => condition.id === 'magical-sleep'))
  assert.ok(after.mechanics.conditions.ally.some((condition) => condition.id === 'magical-sleep'))
  assert.ok(!(after.mechanics.conditions.strong ?? []).some((condition) => condition.id === 'magical-sleep'))
  assert.ok(!(after.mechanics.conditions.caster ?? []).some((condition) => condition.id === 'magical-sleep'))
})

test('Доспехи мага и Щит веры участвуют в серверном расчёте КД', () => {
  const initial = stateFor('wizard', 3)
  const mageArmor = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'mage-armor', target_id: 'caster', target_ids: ['caster'], server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const armored = applyAll(initial, mageArmor.events)
  armored.mechanics.combat.active_index = 1
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'weak', target_id: 'caster', server_authoritative: true }, armored, { diceService: dice([11, 1]), context: { serverAuthoritativeCombat: true } })
  assert.equal(attack.events.find((event) => event.event_type === 'AttackResolved').payload.armor_class, 15)
  assert.equal(attack.events.find((event) => event.event_type === 'AttackResolved').payload.hit, true)

  armored.mechanics.conditions.caster.push({ id: 'shield-of-faith', duration: 'concentration' })
  const protectedAttack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'weak', target_id: 'caster', server_authoritative: true }, armored, { diceService: dice([11]), context: { serverAuthoritativeCombat: true } })
  assert.equal(protectedAttack.events.find((event) => event.event_type === 'AttackResolved').payload.armor_class, 17)
  assert.equal(protectedAttack.events.find((event) => event.event_type === 'AttackResolved').payload.hit, false)
})

test('Скольжение создаёт постоянную труднопроходимую область и повторяет спасбросок при входе', () => {
  const initial = stateFor('wizard', 3)
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'grease', to: { x: 3, y: 1 }, server_authoritative: true }, initial, { diceService: dice([1, 20]), context: { serverAuthoritativeCombat: true } })
  const greased = applyAll(initial, cast.events)
  assert.ok(greased.mechanics.active_effects.some((effect) => effect.spell_id === 'grease' && effect.difficult_terrain))
  assert.ok(greased.mechanics.conditions.weak.some((condition) => condition.id === 'prone'))
  assert.ok(!(greased.mechanics.conditions.strong ?? []).some((condition) => condition.id === 'prone'))

  greased.mechanics.combat.initiative = [{ actor_id: 'ally', total: 18 }, { actor_id: 'weak', total: 12 }]
  greased.mechanics.combat.active_index = 0
  greased.mechanics.combat.action_economy.ally = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const move = resolveCommand({ command_type: 'MoveActor', actor_id: 'ally', to: { x: 2, y: 2 }, server_authoritative: true }, greased, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const afterMove = applyAll(greased, move.events)
  assert.equal(afterMove.mechanics.combat.action_economy.ally.movement_spent, 10)
  assert.ok(afterMove.mechanics.conditions.ally.some((condition) => condition.id === 'prone'))
  const stand = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'ally', action_id: 'stand-up', server_authoritative: true }, afterMove, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const standing = applyAll(afterMove, stand.events)
  assert.ok(!standing.mechanics.conditions.ally.some((condition) => condition.id === 'prone'))
  assert.equal(standing.mechanics.combat.action_economy.ally.movement_spent, 25)
  assert.equal(standing.mechanics.combat.action_economy.ally.action, true)
})

test('Опутывание создаёт концентрационную труднопроходимую область и снимается вместе с концентрацией', () => {
  const initial = stateFor('druid', 3)
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'entangle', to: { x: 3, y: 1 }, server_authoritative: true }, initial, { diceService: dice([20, 20, 1, 20]), context: { serverAuthoritativeCombat: true } })
  const entangled = applyAll(initial, cast.events)
  assert.ok(entangled.mechanics.conditions.weak.some((condition) => condition.id === 'restrained'))
  assert.ok(entangled.mechanics.active_effects.some((effect) => effect.spell_id === 'entangle' && effect.concentration))
  entangled.mechanics.combat.active_index = 1
  entangled.mechanics.combat.action_economy.weak = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const escape = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'weak', action_id: 'break-free', server_authoritative: true }, entangled, { diceService: dice([20]), context: { serverAuthoritativeCombat: true } })
  const escaped = applyAll(entangled, escape.events)
  assert.ok(!escaped.mechanics.conditions.weak.some((condition) => condition.id === 'restrained'))
  assert.equal(escaped.mechanics.combat.action_economy.weak.action, false)
  escaped.mechanics.combat.active_index = 0
  const ended = resolveCommand({ command_type: 'EndConcentration', actor_id: 'caster', reason: 'voluntary' }, entangled, { diceService: dice(), context: { isAdmin: true } })
  const after = applyAll(entangled, ended.events)
  assert.ok(!(after.mechanics.conditions.weak ?? []).some((condition) => condition.id === 'restrained'))
  assert.ok(!after.mechanics.active_effects.some((effect) => effect.spell_id === 'entangle'))
})

test('Огонь фей даёт преимущество следующей атаке по провалившей спасбросок цели', () => {
  const initial = stateFor('wizard', 3)
  initial.players[0].characterClass = 'bard'
  const normalized = normalizeCampaignState(initial)
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'faerie-fire', to: { x: 3, y: 1 }, server_authoritative: true }, normalized, { diceService: dice([20, 20, 1, 20]), context: { serverAuthoritativeCombat: true } })
  const illuminated = applyAll(normalized, cast.events)
  assert.ok(illuminated.mechanics.conditions.weak.some((condition) => condition.id === 'faerie-fire'))
  illuminated.mechanics.combat.action_economy.caster.action = true
  const attack = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'vicious-mockery', target_id: 'weak', target_ids: ['weak'], server_authoritative: true }, illuminated, { diceService: dice([1, 1]), context: { serverAuthoritativeCombat: true } })
  assert.ok(attack.events.some((event) => event.event_type === 'SpellSavingThrowResolved'))

  illuminated.players[0].inventory = [{ id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 5 } }]
  const weaponAttack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'weak', item_id: 'sword', server_authoritative: true }, illuminated, { diceService: dice([5, 15, 1]), context: { serverAuthoritativeCombat: true } })
  assert.equal(weaponAttack.events.find((event) => event.event_type === 'AttackResolved').payload.mode, 'advantage')
})

test('Сверкающие брызги используют направленный конус и пул 6к10 без спасброска', () => {
  const initial = stateFor('wizard', 3)
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'color-spray', to: { x: 4, y: 1 }, server_authoritative: true }, initial, { diceService: dice([10, 10, 10, 10, 10, 10]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.ok(after.mechanics.conditions.weak.some((condition) => condition.id === 'blinded'))
  assert.ok(after.mechanics.conditions.strong.some((condition) => condition.id === 'blinded'))
  assert.ok(!(after.mechanics.conditions.ally ?? []).some((condition) => condition.id === 'blinded'))
  assert.ok(!result.events.some((event) => event.event_type === 'SpellSavingThrowResolved'))
})

test('Волна грома использует направленный куб, половину урона при успехе и отталкивание только при провале', () => {
  const initial = stateFor('wizard', 3)
  initial.enemies.find((enemy) => enemy.id === 'strong').x = 3
  initial.enemies.find((enemy) => enemy.id === 'strong').y = 3
  initial.mechanics.positions.strong = { x: 3, y: 3 }
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'thunderwave', to: { x: 4, y: 1 }, server_authoritative: true }, initial, { diceService: dice([4, 4, 1]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.equal(after.enemies.find((enemy) => enemy.id === 'weak').hp, 0)
  assert.deepEqual(after.mechanics.positions.weak, { x: 4, y: 1 })
  assert.equal(after.enemies.find((enemy) => enemy.id === 'strong').hp, 30)
  assert.ok(result.events.some((event) => event.event_type === 'ActorMoved' && event.payload.forced_movement))
})

test('Дрожь земли сбивает с ног при провале и оставляет постоянную труднопроходимую область вокруг заклинателя', () => {
  const initial = stateFor('wizard', 3)
  initial.enemies.find((enemy) => enemy.id === 'weak').hp = 20
  initial.enemies.find((enemy) => enemy.id === 'weak').maxHp = 20
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'earth-tremor', target_id: 'caster', server_authoritative: true }, initial, { diceService: dice([6, 20, 1, 20]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.ok(after.mechanics.conditions.weak.some((condition) => condition.id === 'prone'))
  assert.ok(!(after.mechanics.conditions.ally ?? []).some((condition) => condition.id === 'prone'))
  assert.ok(after.mechanics.active_effects.some((effect) => effect.spell_id === 'earth-tremor' && effect.difficult_terrain && effect.expires_round === Number.MAX_SAFE_INTEGER))
})

test('Диссонирующий шёпот расходует реакцию, уводит цель на её скорость и открывает атаку по возможности', () => {
  const initial = stateFor('bard', 3)
  initial.enemies.find((enemy) => enemy.id === 'weak').hp = 20
  initial.enemies.find((enemy) => enemy.id === 'weak').maxHp = 20
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'dissonant-whispers', target_id: 'weak', server_authoritative: true }, initial, { diceService: dice([2, 2, 2, 1]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.equal(after.mechanics.combat.action_economy.weak.reaction, false)
  assert.ok(Math.max(Math.abs(after.mechanics.positions.weak.x - 1), Math.abs(after.mechanics.positions.weak.y - 1)) >= 5)
  assert.equal(after.mechanics.combat.action_economy.weak.movement_spent, 0)
  assert.equal(after.mechanics.combat.reaction_window?.trigger, 'enemy-left-reach')
})

test('Вызов страха повторяет спасбросок в конце хода, а Приказ требует выбранный вариант и исполняет «Падай»', () => {
  const fearInitial = stateFor('warlock', 3)
  const fearCast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'cause-fear', target_id: 'weak', server_authoritative: true }, fearInitial, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const frightened = applyAll(fearInitial, fearCast.events)
  const fear = frightened.mechanics.conditions.weak.find((condition) => condition.id === 'frightened')
  assert.equal(fear.repeat_save_timing, 'turn-end')
  frightened.mechanics.combat.active_index = 1
  const repeat = resolveCommand({ command_type: 'EndTurn', actor_id: 'weak', server_authoritative: true }, frightened, { diceService: dice([20]), context: { serverAuthoritativeCombat: true } })
  assert.ok(!applyAll(frightened, repeat.events).mechanics.conditions.weak.some((condition) => condition.id === 'frightened'))

  const commandInitial = stateFor('cleric', 3)
  assert.throws(() => resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'command', target_id: 'weak', server_authoritative: true }, commandInitial, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'SPELL_OPTION_REQUIRED')
  const commandCast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'command', spell_option: 'grovel', target_id: 'weak', server_authoritative: true }, commandInitial, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const commanded = applyAll(commandInitial, commandCast.events)
  commanded.mechanics.combat.active_index = 1
  assert.throws(() => resolveCommand({ command_type: 'MakeAttack', actor_id: 'weak', target_id: 'caster', server_authoritative: true }, commanded, { diceService: dice([20]), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'COMMAND_RESTRICTS_TURN')
  const ended = resolveCommand({ command_type: 'EndTurn', actor_id: 'weak', server_authoritative: true }, commanded, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const afterCommand = applyAll(commanded, ended.events)
  assert.ok(afterCommand.mechanics.conditions.weak.some((condition) => condition.id === 'prone'))
  assert.ok(!afterCommand.mechanics.conditions.weak.some((condition) => condition.id === 'command:grovel'))
})

test('Жуткий смех Таши запрещает действия и подъём, а урон даёт повторный спасбросок с преимуществом', () => {
  const initial = stateFor('wizard', 3)
  initial.enemies.find((enemy) => enemy.id === 'weak').hp = 20
  initial.enemies.find((enemy) => enemy.id === 'weak').maxHp = 20
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'tasha-s-hideous-laughter', target_id: 'weak', server_authoritative: true }, initial, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const laughing = applyAll(initial, cast.events)
  assert.ok(laughing.mechanics.conditions.weak.some((condition) => condition.id === 'prone'))
  assert.ok(laughing.mechanics.conditions.weak.some((condition) => condition.id === 'incapacitated'))
  laughing.mechanics.combat.active_index = 1
  assert.throws(() => resolveCommand({ command_type: 'UseCombatAction', actor_id: 'weak', action_id: 'stand-up', server_authoritative: true }, laughing, { diceService: dice(), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'ACTOR_INCAPACITATED')
  const damaged = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'ally', target_id: 'weak', amount: 1, damage_type: 'bludgeoning' }, laughing, { diceService: dice([20, 1]), context: { isAdmin: true } })
  const recovered = applyAll(laughing, damaged.events)
  assert.ok(damaged.events.some((event) => event.event_type === 'SpellSavingThrowResolved' && event.payload.trigger === 'damage-repeat' && event.payload.mode === 'advantage'))
  assert.ok(!recovered.mechanics.conditions.weak.some((condition) => ['prone', 'incapacitated'].includes(condition.id)))
  assert.equal(recovered.mechanics.concentration.caster, undefined)
})

test('Очарование личности действует только на гуманоидов, запрещает атаковать заклинателя и снимается уроном его союзника', () => {
  const initial = stateFor('bard', 3)
  const weak = initial.enemies.find((enemy) => enemy.id === 'weak')
  weak.creature_type = 'humanoid'
  weak.hp = 20
  weak.maxHp = 20
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'charm-person', target_id: 'weak', server_authoritative: true }, initial, { diceService: dice([1, 1]), context: { serverAuthoritativeCombat: true } })
  const charmed = applyAll(initial, cast.events)
  assert.ok(charmed.mechanics.conditions.weak.some((condition) => condition.id === 'charmed'))
  charmed.mechanics.combat.active_index = 1
  assert.throws(() => resolveCommand({ command_type: 'MakeAttack', actor_id: 'weak', target_id: 'caster', server_authoritative: true }, charmed, { diceService: dice([20]), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'CHARMED_ATTACK_FORBIDDEN')
  const damaged = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'ally', target_id: 'weak', amount: 1, damage_type: 'bludgeoning' }, charmed, { diceService: dice(), context: { isAdmin: true } })
  assert.ok(!applyAll(charmed, damaged.events).mechanics.conditions.weak.some((condition) => condition.id === 'charmed'))
})

test('Вызов на дуэль использует бонусное действие, мешает атаковать других и прекращается от урона союзника паладина', () => {
  const initial = stateFor('paladin', 3)
  initial.enemies.find((enemy) => enemy.id === 'weak').hp = 20
  initial.enemies.find((enemy) => enemy.id === 'weak').maxHp = 20
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'compelled-duel', target_id: 'weak', server_authoritative: true }, initial, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const dueled = applyAll(initial, cast.events)
  assert.equal(dueled.mechanics.combat.action_economy.caster.bonus_action, false)
  assert.equal(dueled.mechanics.combat.action_economy.caster.action, true)
  dueled.mechanics.combat.active_index = 1
  const divertedAttack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'weak', target_id: 'ally', server_authoritative: true }, dueled, { diceService: dice([20, 1, 1]), context: { serverAuthoritativeCombat: true } })
  assert.equal(divertedAttack.events.find((event) => event.event_type === 'AttackResolved').payload.mode, 'disadvantage')
  const damaged = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'ally', target_id: 'weak', amount: 1, damage_type: 'bludgeoning' }, dueled, { diceService: dice(), context: { isAdmin: true } })
  const ended = applyAll(dueled, damaged.events)
  assert.ok(!ended.mechanics.conditions.weak.some((condition) => condition.id === 'compelled-duel'))
  assert.equal(ended.mechanics.concentration.caster, undefined)
})

test('Огненные ладони и Ледяные пальцы используют направленный конус, половину урона и усиление ячейкой', () => {
  const fireInitial = stateFor('wizard', 3)
  const fire = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'burning-hands', to: { x: 4, y: 1 }, slot_level: 2, server_authoritative: true }, fireInitial, { diceService: dice([6, 6, 6, 6, 1, 20]), context: { serverAuthoritativeCombat: true } })
  const afterFire = applyAll(fireInitial, fire.events)
  assert.equal(afterFire.enemies.find((enemy) => enemy.id === 'weak').hp, 0)
  assert.equal(afterFire.enemies.find((enemy) => enemy.id === 'strong').hp, 18)
  assert.equal(afterFire.players.find((player) => player.id === 'ally').hp, 6)
  assert.equal(fire.events.find((event) => event.event_type === 'DieRolled' && event.payload.purpose?.includes('burning-hands')).payload.expression, '4d6')

  const coldInitial = stateFor('wizard', 3)
  const cold = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'frost-fingers', to: { x: 4, y: 1 }, server_authoritative: true }, coldInitial, { diceService: dice([4, 4, 20, 20]), context: { serverAuthoritativeCombat: true } })
  assert.ok(!cold.events.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('ally')))
  assert.ok(cold.events.some((event) => event.event_type === 'SpellSavingThrowResolved' && event.payload.spell_id === 'frost-fingers'))
})

test('Руки Хадара поражают всех вокруг и запрещают реакции только провалившим спасбросок', () => {
  const initial = stateFor('warlock', 3)
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'arms-of-hadar', target_id: 'caster', server_authoritative: true }, initial, { diceService: dice([3, 3, 20, 1, 20]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.ok(after.mechanics.conditions.weak.some((condition) => condition.id === 'no-reactions'))
  assert.equal(after.mechanics.combat.action_economy.weak.reaction, false)
  assert.ok(!(after.mechanics.conditions.ally ?? []).some((condition) => condition.id === 'no-reactions'))
})

test('Хроматический шар требует выбор стихии, а Луч болезни делает отдельный спасбросок после попадания', () => {
  const orbInitial = stateFor('wizard', 3)
  assert.throws(() => resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'chromatic-orb', target_id: 'strong', server_authoritative: true }, orbInitial, { diceService: dice([15]), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'SPELL_OPTION_REQUIRED')
  const orb = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'chromatic-orb', spell_option: 'fire', target_id: 'strong', slot_level: 2, server_authoritative: true }, orbInitial, { diceService: dice([15, 8, 8, 8, 8]), context: { serverAuthoritativeCombat: true } })
  const orbDamage = orb.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(orbDamage.payload.damage_type, 'fire')
  assert.equal(orbDamage.payload.raw_amount, 32)

  const rayInitial = stateFor('wizard', 3)
  rayInitial.enemies.find((enemy) => enemy.id === 'strong').hp = 40
  rayInitial.enemies.find((enemy) => enemy.id === 'strong').maxHp = 40
  const ray = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'ray-of-sickness', target_id: 'strong', server_authoritative: true }, rayInitial, { diceService: dice([15, 4, 4, 1]), context: { serverAuthoritativeCombat: true } })
  const sickened = applyAll(rayInitial, ray.events)
  assert.ok(ray.events.some((event) => event.event_type === 'SpellSavingThrowResolved' && event.payload.trigger === 'on-hit'))
  assert.ok(sickened.mechanics.conditions.strong.some((condition) => condition.id === 'poisoned' && condition.duration === 'source-turns:2'))
})

test('Ледяной кинжал взрывается даже при промахе и отдельно разрешает спасбросок всем в радиусе', () => {
  const initial = stateFor('wizard', 3)
  initial.enemies.find((enemy) => enemy.id === 'weak').hp = 20
  initial.enemies.find((enemy) => enemy.id === 'weak').maxHp = 20
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'ice-knife', target_id: 'strong', server_authoritative: true }, initial, { diceService: dice([1, 3, 3, 1, 20]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.equal(result.events.find((event) => event.event_type === 'AttackResolved').payload.hit, false)
  assert.equal(after.enemies.find((enemy) => enemy.id === 'weak').hp, 14)
  assert.equal(after.enemies.find((enemy) => enemy.id === 'strong').hp, 30)
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.payload.secondary_burst && event.target_ids.includes('weak')))
})

test('Пылающая кара усиливает следующее рукопашное попадание, переносит концентрацию на пламя и повторяет урон в начале хода', () => {
  const initial = stateFor('paladin', 5)
  const caster = initial.players.find((player) => player.id === 'caster')
  caster.inventory = [{ id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'slashing', normalRange: 5 } }]
  const weak = initial.enemies.find((enemy) => enemy.id === 'weak')
  weak.hp = 50
  weak.maxHp = 50
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'searing-smite', slot_level: 2, server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const armed = applyAll(initial, cast.events)
  assert.ok(armed.mechanics.conditions.caster.some((condition) => condition.id === 'next-weapon-hit:searing-smite' && condition.slot_level === 2))

  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'weak', item_id: 'sword', server_authoritative: true }, armed, { diceService: dice([15, 3, 4, 4]), context: { serverAuthoritativeCombat: true } })
  const burning = applyAll(armed, attack.events)
  assert.ok(!burning.mechanics.conditions.caster.some((condition) => condition.id === 'next-weapon-hit:searing-smite'))
  assert.ok(burning.mechanics.conditions.weak.some((condition) => condition.id === 'searing-smite-flames' && condition.recurring_damage === '1d6'))
  assert.ok(burning.mechanics.concentration.caster)
  assert.equal(attack.events.find((event) => event.event_type === 'DamageApplied' && event.payload.next_weapon_hit).payload.raw_amount, 8)

  const end = resolveCommand({ command_type: 'EndTurn', actor_id: 'caster', server_authoritative: true }, burning, { diceService: dice([1, 5]), context: { serverAuthoritativeCombat: true } })
  assert.ok(end.events.some((event) => event.event_type === 'DamageApplied' && event.payload.recurring && event.payload.raw_amount === 5))
})

test('Громовая кара отталкивает и сбивает с ног, а затем завершает концентрацию', () => {
  const initial = stateFor('paladin', 3)
  initial.players[0].inventory = [{ id: 'hammer', name: 'Молот', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'bludgeoning', normalRange: 5 } }]
  initial.enemies[0].hp = 40
  initial.enemies[0].maxHp = 40
  initial.enemies[1].x = 3
  initial.enemies[1].y = 3
  initial.mechanics.positions.strong = { x: 3, y: 3 }
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'thunderous-smite', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const armed = applyAll(initial, cast.events)
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'weak', item_id: 'hammer', server_authoritative: true }, armed, { diceService: dice([15, 2, 4, 4, 1]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(armed, attack.events)
  assert.deepEqual(after.mechanics.positions.weak, { x: 4, y: 1 })
  assert.ok(after.mechanics.conditions.weak.some((condition) => condition.id === 'prone'))
  assert.equal(after.mechanics.concentration.caster, undefined)
})

test('Гневная кара пугает после спасброска, а проверка Мудрости действием прекращает эффект', () => {
  const initial = stateFor('paladin', 3)
  initial.players[0].inventory = [{ id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'slashing', normalRange: 5 } }]
  initial.enemies[0].hp = 30
  initial.enemies[0].maxHp = 30
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'wrathful-smite', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const armed = applyAll(initial, cast.events)
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'weak', item_id: 'sword', server_authoritative: true }, armed, { diceService: dice([15, 2, 4, 1]), context: { serverAuthoritativeCombat: true } })
  const frightened = applyAll(armed, attack.events)
  assert.ok(frightened.mechanics.conditions.weak.some((condition) => condition.id === 'frightened'))
  assert.ok(frightened.mechanics.conditions.weak.some((condition) => condition.id === 'wrathful-smite-frightened'))
  frightened.mechanics.combat.active_index = 1
  frightened.mechanics.combat.action_economy.weak.action = true
  const recover = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'weak', action_id: 'steady-nerves', server_authoritative: true }, frightened, { diceService: dice([20]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(frightened, recover.events)
  assert.ok(!after.mechanics.conditions.weak.some((condition) => ['frightened', 'wrathful-smite-frightened'].includes(condition.id)))
  assert.equal(after.mechanics.concentration.caster, undefined)
})

test('Опутывающий удар удерживает цель, наносит урон в начале хода и снимается успешным высвобождением', () => {
  const initial = stateFor('ranger', 5)
  initial.players[0].inventory = [{ id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'dex', damage: '1d6', damageType: 'slashing', normalRange: 5 } }]
  initial.enemies[0].hp = 50
  initial.enemies[0].maxHp = 50
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'ensnaring-strike', slot_level: 2, server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const armed = applyAll(initial, cast.events)
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'weak', item_id: 'sword', server_authoritative: true }, armed, { diceService: dice([15, 2, 1]), context: { serverAuthoritativeCombat: true } })
  const restrained = applyAll(armed, attack.events)
  assert.ok(restrained.mechanics.conditions.weak.some((condition) => condition.id === 'restrained' && condition.save_dc === 14))
  assert.ok(restrained.mechanics.conditions.weak.some((condition) => condition.id === 'ensnaring-strike' && condition.recurring_damage === '2d6'))
  const end = resolveCommand({ command_type: 'EndTurn', actor_id: 'caster', server_authoritative: true }, restrained, { diceService: dice([4, 4]), context: { serverAuthoritativeCombat: true } })
  const damaged = applyAll(restrained, end.events)
  assert.ok(end.events.some((event) => event.event_type === 'DamageApplied' && event.payload.recurring && event.payload.raw_amount === 8))
  const escape = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'weak', action_id: 'break-free', server_authoritative: true }, damaged, { diceService: dice([20]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(damaged, escape.events)
  assert.ok(!after.mechanics.conditions.weak.some((condition) => ['restrained', 'ensnaring-strike'].includes(condition.id)))
  assert.equal(after.mechanics.concentration.caster, undefined)
})

test('Град шипов взрывается только после дальнобойного попадания и наносит половину урона при успешном спасброске', () => {
  const initial = stateFor('ranger', 5)
  initial.players[0].inventory = [{ id: 'bow', name: 'Лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 80, longRange: 320 } }]
  initial.enemies[0].hp = 30
  initial.enemies[0].maxHp = 30
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'hail-of-thorns', slot_level: 2, server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const armed = applyAll(initial, cast.events)
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'strong', item_id: 'bow', server_authoritative: true }, armed, { diceService: dice([15, 15, 3, 6, 6, 1, 20]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(armed, attack.events)
  const burstDamage = attack.events.filter((event) => event.event_type === 'DamageApplied' && event.payload.burst)
  assert.equal(burstDamage.length, 2)
  assert.deepEqual(burstDamage.map((event) => event.payload.raw_amount).sort((a, b) => a - b), [6, 12])
  assert.equal(after.mechanics.concentration.caster, undefined)
})

test('Удар Зефира даёт преимущество один раз, добавляет силовой урон и скорость, сохраняя защиту от атак по возможности', () => {
  const initial = stateFor('ranger', 3)
  initial.players[0].inventory = [{ id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'dex', damage: '1d6', damageType: 'slashing', normalRange: 5 } }]
  initial.enemies[0].hp = 30
  initial.enemies[0].maxHp = 30
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'zephyr-strike', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const armed = applyAll(initial, cast.events)
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'caster', target_id: 'weak', item_id: 'sword', server_authoritative: true }, armed, { diceService: dice([5, 15, 3, 4]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(armed, attack.events)
  assert.equal(attack.events.find((event) => event.event_type === 'AttackResolved').payload.mode, 'advantage')
  assert.equal(after.mechanics.combat.action_economy.caster.movement_bonus, 30)
  assert.ok(after.mechanics.conditions.caster.some((condition) => condition.id === 'zephyr-strike'))
  assert.ok(!after.mechanics.conditions.caster.some((condition) => condition.id === 'next-weapon-hit:zephyr-strike'))
  assert.ok(after.mechanics.concentration.caster)
})

test('Героизм снимает испуг, обновляет временные хиты в начале хода и удаляет их при завершении концентрации', () => {
  const initial = stateFor('bard', 3)
  initial.mechanics.conditions.ally = [{ id: 'frightened', source_actor: 'weak' }]
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'heroism', target_id: 'ally', target_ids: ['caster', 'ally'], slot_level: 2, server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const heroic = applyAll(initial, cast.events)
  assert.equal(heroic.mechanics.temporary_hp.caster, 3)
  assert.equal(heroic.mechanics.temporary_hp.ally, 3)
  assert.ok(!heroic.mechanics.conditions.ally.some((condition) => condition.id === 'frightened'))
  heroic.mechanics.temporary_hp.ally = 0
  heroic.mechanics.combat.initiative = [{ actor_id: 'caster', total: 18 }, { actor_id: 'ally', total: 12 }]
  heroic.mechanics.combat.active_index = 0
  heroic.mechanics.combat.action_economy.ally = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const end = resolveCommand({ command_type: 'EndTurn', actor_id: 'caster', server_authoritative: true }, heroic, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const renewed = applyAll(heroic, end.events)
  assert.equal(renewed.mechanics.temporary_hp.ally, 3)
  const stop = resolveCommand({ command_type: 'EndConcentration', actor_id: 'caster', reason: 'voluntary' }, renewed, { diceService: dice(), context: { isAdmin: true } })
  const after = applyAll(renewed, stop.events)
  assert.equal(after.mechanics.temporary_hp.ally, undefined)
  assert.ok(!after.mechanics.conditions.ally.some((condition) => condition.id === 'heroism'))
})

test('Поспешное отступление даёт Рывок при накладывании и повторный Рывок бонусным действием', () => {
  const initial = stateFor('wizard', 3)
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'expeditious-retreat', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const hurried = applyAll(initial, cast.events)
  assert.equal(hurried.mechanics.combat.action_economy.caster.movement_bonus, 30)
  assert.equal(hurried.mechanics.combat.action_economy.caster.bonus_action, false)
  assert.ok(hurried.mechanics.conditions.caster.some((condition) => condition.id === 'expeditious-retreat'))
  hurried.mechanics.combat.action_economy.caster.bonus_action = true
  hurried.mechanics.combat.action_economy.caster.movement_bonus = 0
  const dash = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'caster', action_id: 'expeditious-retreat-dash', server_authoritative: true }, hurried, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(hurried, dash.events)
  assert.equal(after.mechanics.combat.action_economy.caster.movement_bonus, 30)
  assert.equal(after.mechanics.combat.action_economy.caster.bonus_action, false)
  assert.equal(after.mechanics.combat.action_economy.caster.action, true)
})

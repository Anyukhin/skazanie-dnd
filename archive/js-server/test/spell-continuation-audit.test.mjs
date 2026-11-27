import assert from 'node:assert/strict'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function fixture(known = ['shield'], enemySpell = 'magic-missile') {
  return normalizeCampaignState({
    sessionCode: 'CAST-CONTINUATION', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'], partyMemberIds: ['hero', 'ally'],
    players: [{ id: 'hero', character: 'Защитник', characterClass: 'wizard', level: 12, hp: 60, maxHp: 60, armor: 15,
      speed: 30, x: 1, y: 1, inventory: [], abilities: { str: 10, dex: 10, con: 10, int: 18, wis: 10, cha: 10 },
      knownSpellIds: known, preparedSpellIds: known },
    { id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 1, hp: 50, maxHp: 50, armor: 10, x: 0, y: 0, inventory: [] }],
    enemies: [{ id: 'enemy', name: 'Маг', characterClass: 'wizard', level: 5, proficiency: 3, hp: 80, maxHp: 80, armor: 12,
      speed: 30, x: 7, y: 1, alive: true, inventory: [], knownSpellIds: [enemySpell], preparedSpellIds: [enemySpell],
      abilities: { str: 10, dex: 10, con: 10, int: 18, wis: 10, cha: 10 } }],
    scene: { cells: Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true })) },
    mechanics: { combat: { active: true, round: 1, active_index: 1,
      initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'enemy', total: 10 }],
      action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true },
        enemy: { action: true, bonus_action: true, reaction: true, movement: true } } } },
  })
}

let sequence = 0
function run(state, command, values = [], context = {}) {
  return resolveCommand({ command_id: `continuation:${++sequence}`, server_authoritative: true, ...command }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `continuation-roll:${++sequence}` }),
    context: { serverAuthoritativeCombat: true, ...context },
  })
}

const ready = state => run(state, { command_type: 'UseCombatAction', actor_id: 'enemy', action_id: 'ready-action',
  readied_spell_id: 'magic-missile', readied_trigger: 'enemy-approaches' }, [], { isNpcScheduler: true })

function approach(state) {
  const ended = run(state, { command_type: 'EndTurn', actor_id: 'enemy' })
  const next = replayEvents(state, ended.events)
  const moved = run(next, { command_type: 'MoveActor', actor_id: 'hero', to: { x: 6, y: 1 } })
  return replayEvents(next, moved.events)
}

test('Ready → Shield → restart → отказ сохраняет запуск, реакцию и единственную оплату', () => {
  const initial = fixture()
  const prepared = replayEvents(initial, ready(initial).events)
  assert.equal(prepared.mechanics.resources.enemy.spell_slots_1.current, 3)
  const triggered = approach(prepared)
  assert.equal(triggered.mechanics.combat.reaction_window.trigger, 'readied')
  const released = run(triggered, { command_type: 'UseCombatAction', actor_id: 'enemy', action_id: 'readied-spell' }, [3])
  const waiting = replayEvents(triggered, released.events)
  assert.equal(waiting.mechanics.combat.reaction_window.trigger, 'magic-missile-shield-choice')
  assert.equal(waiting.mechanics.combat.readied.enemy, undefined)
  assert.equal(waiting.mechanics.concentration.enemy, undefined)
  assert.equal(waiting.mechanics.combat.action_economy.enemy.reaction, false)
  assert.equal(waiting.players[0].hp, 60, 'защита выбирается до урона')
  const restored = normalizeCampaignState(JSON.parse(JSON.stringify(waiting)))
  const declined = run(restored, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'decline-reaction' })
  const final = replayEvents(restored, declined.events)
  assert.equal(final.players[0].hp, 48)
  assert.equal(final.mechanics.resources.enemy.spell_slots_1.current, 3)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(declined.events.some(event => event.event_type === 'ResourceSpent'), false)
  assert.deepEqual(replayEvents(restored, JSON.parse(JSON.stringify(declined.events))), final)
})

test('Counterspell предлагается при подготовке Ready, а не при выпуске накопленной магии', () => {
  const initial = fixture(['counterspell'])
  const opened = ready(initial)
  assert.equal(opened.events.find(event => event.event_type === 'ReactionWindowOpened')?.payload.trigger, 'spell-cast')
  const waiting = replayEvents(initial, opened.events)
  const declined = run(waiting, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'decline-reaction' })
  const prepared = replayEvents(waiting, declined.events)
  assert.ok(prepared.mechanics.combat.readied.enemy)
  assert.equal(prepared.mechanics.resources.enemy.spell_slots_1.current, 3)
  const triggered = approach(prepared)
  const released = run(triggered, { command_type: 'UseCombatAction', actor_id: 'enemy', action_id: 'readied-spell' }, [3])
  assert.equal(released.events.some(event => event.event_type === 'ReactionWindowOpened'), false)
  assert.equal(replayEvents(triggered, released.events).players[0].hp, 48)
})

test('явно бескомпонентное заклинание NPC не даёт повода для Counterspell', () => {
  const initial = fixture(['counterspell'])
  initial.enemies[0].spellcasting = { ability: 'int', save_dc: 15, spells: [{ id: 'magic-missile', uses: 'at-will',
    components_not_required: ['verbal', 'somatic', 'material'] }] }
  const result = run(initial, { command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'magic-missile', target_id: 'hero' }, [3], { isNpcScheduler: true })
  assert.equal(result.events.some(event => event.event_type === 'ReactionWindowOpened'), false)
  assert.equal(replayEvents(initial, result.events).players[0].hp, 48)
})

test('защита от второго луча не теряет первый и третий и не оплачивает залп повторно', () => {
  const initial = fixture(['shield'], 'scorching-ray')
  initial.mechanics.combat.action_economy.enemy.extra_actions = 1
  const launched = run(initial, { command_id: 'rays', command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'scorching-ray',
    target_ids: ['ally', 'hero'], slot_level: 2 }, [11, 3, 3, 11])
  const waiting = replayEvents(initial, launched.events)
  assert.equal(waiting.mechanics.combat.reaction_window.trigger, 'attack-shield-choice')
  const restored = normalizeCampaignState(JSON.parse(JSON.stringify(waiting)))
  const declined = run(restored, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'decline-reaction' }, [4, 4, 12, 5, 5])
  const final = replayEvents(restored, declined.events)
  assert.equal(final.players.find(actor => actor.id === 'ally').hp, 34)
  assert.equal(final.players.find(actor => actor.id === 'hero').hp, 52)
  assert.equal(final.mechanics.resources.enemy.spell_slots_2.current, 2)
  const economy = final.mechanics.combat.action_economy.enemy
  assert.equal(Number(economy.action) + economy.extra_actions, 1, 'залп тратит одно из двух действий')
  assert.equal(declined.events.filter(event => event.event_type === 'AttackResolved').length, 3)
  assert.equal(declined.events.filter(event => event.event_type === 'ResourceSpent').length, 1)
})

test('ускоренная атака заклинанием расходует бонусное действие, сохраняя обычное', () => {
  const initial = fixture(['fire-bolt'])
  initial.players[0].characterClass = 'sorcerer'
  initial.players[0].abilities.cha = 18
  initial.mechanics.combat.active_index = 0
  initial.mechanics.conditions.hero = [{ id: 'metamagic-quickened', duration: 'until-used' }]
  const cast = run(initial, { command_type: 'CastSpell', actor_id: 'hero', spell_id: 'fire-bolt', target_id: 'enemy' }, [10, 3, 3, 3])
  const final = replayEvents(initial, cast.events)
  assert.equal(final.mechanics.combat.action_economy.hero.action, true)
  assert.equal(final.mechanics.combat.action_economy.hero.bonus_action, false)
  assert.equal(final.mechanics.combat.action_economy.hero.attacks_used, 0)
})

test('Щит против первого луча действует и на последующие лучи того же залпа', () => {
  const initial = fixture(['shield'], 'scorching-ray')
  const launched = run(initial, { command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'scorching-ray', target_id: 'hero', slot_level: 2 }, [11])
  const waiting = replayEvents(initial, launched.events)
  const shield = resolveCommand({ command_id: 'shield-all-rays', command_type: 'UseCombatAction', actor_id: 'hero',
    action_id: 'cast:shield', server_authoritative: true }, waiting, {
    diceService: new DiceService({ rng: { randint: (_min, max) => max === 20 ? 11 : 3 }, idFactory: () => `shield-rays:${++sequence}` }),
    context: { serverAuthoritativeCombat: true },
  })
  const final = replayEvents(waiting, shield.events)
  const attacks = shield.events.filter(event => event.event_type === 'AttackResolved')
  assert.equal(attacks.length, 3)
  assert.ok(attacks.every(event => event.payload.hit === false), 'итог 18 не проходит поднятую до 20 КД')
  assert.equal(final.players[0].hp, 60)
  assert.equal(final.mechanics.resources.hero.spell_slots_1.current, 3)
})

test('провал Counterspell оплачивается до новой паузы Shield и сохраняется после restart', () => {
  let initial = fixture(['counterspell'])
  initial.enemies[0].level = 7
  Object.assign(initial.players[1], { characterClass: 'wizard', level: 5, knownSpellIds: ['shield'], preparedSpellIds: ['shield'],
    abilities: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 } })
  initial = normalizeCampaignState(initial)
  const launched = run(initial, { command_id: 'nested-missiles', command_type: 'CastSpell', actor_id: 'enemy',
    spell_id: 'magic-missile', slot_level: 4, target_id: 'ally' })
  const waiting = replayEvents(initial, launched.events)
  assert.equal(waiting.mechanics.combat.reaction_window.trigger, 'spell-cast')
  const failedCounter = run(waiting, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:counterspell' }, [1, 3])
  const shieldWindow = replayEvents(waiting, failedCounter.events)
  assert.equal(shieldWindow.mechanics.combat.reaction_window.trigger, 'magic-missile-shield-choice')
  assert.equal(shieldWindow.mechanics.resources.hero.spell_slots_3.current, 2)
  assert.equal(shieldWindow.mechanics.combat.action_economy.hero.reaction, false)
  assert.equal(failedCounter.events.find(event => event.event_type === 'CounterspellCheckResolved')?.payload.success, false)
  const restored = normalizeCampaignState(JSON.parse(JSON.stringify(shieldWindow)))
  const shield = run(restored, { command_type: 'UseCombatAction', actor_id: 'ally', action_id: 'cast:shield' })
  const final = replayEvents(restored, shield.events)
  assert.equal(final.mechanics.resources.hero.spell_slots_3.current, 2)
  assert.equal(final.mechanics.resources.ally.spell_slots_1.current, 3)
  assert.equal(final.mechanics.resources.enemy.spell_slots_4.current, 0)
  assert.equal(final.players[1].hp, 50)
})

for (const alreadyResistant of [false, true]) test(`Absorb защищает весь залп и не складывает сопротивления (${alreadyResistant})`, () => {
  const initial = fixture(['absorb-elements'], 'scorching-ray')
  if (alreadyResistant) initial.players[0].damage_resistances = ['fire']
  const launched = run(initial, { command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'scorching-ray', target_id: 'hero', slot_level: 2 }, [11])
  const waiting = normalizeCampaignState(JSON.parse(JSON.stringify(replayEvents(initial, launched.events))))
  const absorbed = run(waiting, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:absorb-elements' }, [3, 3, 11, 3, 3, 11, 3, 3])
  const damage = absorbed.events.filter(event => event.event_type === 'DamageApplied')
  assert.deepEqual(damage.map(event => event.payload.applied_amount), [3, 3, 3])
  assert.ok(damage.every(event => event.payload.resistant === true))
  const final = replayEvents(waiting, absorbed.events)
  assert.equal(final.players[0].hp, 51)
  assert.equal(final.mechanics.resources.hero.spell_slots_1.current, 3)
  assert.equal(final.mechanics.conditions.hero.filter(condition => condition.id === 'absorbing-element-rider:fire').length, 1)
})

test('Absorb сохраняет Death Ward, если после защиты удар больше не смертелен', () => {
  const initial = fixture(['absorb-elements'], 'fire-bolt')
  initial.players[0].hp = 8
  initial.mechanics.conditions.hero = [{ id: 'death-ward', duration: 'until-long-rest' }]
  const attack = run(initial, { command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'fire-bolt', target_id: 'hero' }, [11])
  const waiting = replayEvents(initial, attack.events)
  const response = run(waiting, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:absorb-elements' }, [5, 5])
  const final = replayEvents(waiting, response.events)
  assert.equal(final.players[0].hp, 3)
  assert.ok(final.mechanics.conditions.hero.some(condition => condition.id === 'death-ward'))
  assert.equal(response.events.some(event => event.event_type === 'DamageApplied' && event.payload.death_ward_triggered), false)
})

test('в 2014 Absorb применяется до уязвимости, сохраняя округление нечётного урона', () => {
  const initial = fixture(['absorb-elements'], 'fire-bolt')
  initial.players[0].damage_vulnerabilities = ['fire']
  const attack = run(initial, { command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'fire-bolt', target_id: 'hero' }, [11])
  const waiting = replayEvents(initial, attack.events)
  const response = run(waiting, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:absorb-elements' }, [3, 4])
  const damage = response.events.find(event => event.event_type === 'DamageApplied').payload
  assert.equal(damage.raw_amount, 7)
  assert.equal(damage.applied_amount, 6, 'floor(7 / 2) × 2 = 6')
  assert.equal(replayEvents(waiting, response.events).players[0].hp, 54)
})

test('поглощение первой длящейся области защищает от следующей области в том же конце хода', () => {
  const initial = fixture(['absorb-elements'])
  initial.mechanics.combat.active_index = 0
  initial.mechanics.active_effects = ['first', 'second'].map(id => ({ id, effect_id: id, source_actor: 'enemy',
    spell_id: 'wall-of-fire', center: { x: 1, y: 1 }, radius_feet: 5, area_shape: 'sphere',
    damage: '1d6', damage_type: 'fire', trigger_on_turn_end: true, duration_rounds: 10 }))
  const ended = run(initial, { command_type: 'EndTurn', actor_id: 'hero' }, [6])
  const waiting = replayEvents(initial, ended.events)
  assert.equal(waiting.mechanics.combat.reaction_window.trigger, 'spell-area-damage')
  const response = run(waiting, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:absorb-elements' }, [6])
  assert.deepEqual(response.events.filter(event => event.event_type === 'DamageApplied').map(event => event.payload.applied_amount), [3, 3])
  const final = replayEvents(waiting, response.events)
  assert.equal(final.players[0].hp, 54)
  assert.equal(final.mechanics.resources.hero.spell_slots_1.current, 3)
})

test('иммунитет к огню исключает Absorb из реакции на огненную атаку', () => {
  const initial = fixture(['absorb-elements'], 'fire-bolt')
  initial.players[0].damage_immunities = ['fire']
  const attack = run(initial, { command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'fire-bolt', target_id: 'hero' }, [11, 8, 8])
  assert.equal(attack.events.some(event => event.event_type === 'ReactionWindowOpened'), false)
  assert.equal(replayEvents(initial, attack.events).players[0].hp, 60)
})

// Нападение из исследования открывает бой.
//
// Вне боя панель героя живая, как в BG3: удар, враждебное заклинание или
// приём против противника можно выбрать без кнопки «Начать бой». Первый удар
// вне очереди при этом не проходит — нападение начинается с инициативы
// (решение владельца от 2026-07-27). Сторож проверяет обе стороны: удар
// исполняется, когда нападающий ходит первым, и ждёт его хода, когда нет;
// заведомо незаконный удар бой не начинает; мирные действия панели работают
// вне боя, а привязанные к ходу — нет.
import assert from 'node:assert/strict'
import test from 'node:test'

import { explorationUseFor, combatActionsFor } from '../server/combat-actions.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { BG3_OPENING_STRIKE_HOUSE_RULE_ID } from '../server/ruleset-config.mjs'
import { palaceFixture } from './shared-npc-consequence-fixture.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng([...values, ...Array.from({ length: 60 }, () => 3)]), idFactory: () => `opening-roll-${++id}`, now: () => '2026-10-04T12:00:00.000Z' })
}

/**
 * Воин и жрица у костра, волк в двух клетках от воина. Бой выключен.
 * Инициатива бросается в порядке «герои, затем враги»: воин, жрица, волк.
 */
function camp({ wolfX = 4, hiddenParty = false, bg3 = false } = {}) {
  const cells = Array.from({ length: 72 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'OPEN-1',
    campaign_id: 'OPEN-1',
    enabled_house_rules: bg3 ? [BG3_OPENING_STRIKE_HOUSE_RULE_ID] : [],
    partyMemberIds: ['fighter', 'cleric'],
    players: [
      {
        id: 'fighter', character: 'Брайн', characterClass: 'fighter', level: 3, proficiency: 2,
        hp: 12, maxHp: 30, armor: 16, speed: 30, x: 3, y: 1,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [],
      },
      {
        id: 'cleric', character: 'Мириэль', characterClass: 'cleric', level: 3, proficiency: 2,
        hp: 21, maxHp: 21, armor: 15, speed: 30, x: 1, y: 1,
        abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 16, cha: 10 },
        preparedSpellIds: ['cure-wounds', 'sacred-flame'], inventory: [],
      },
    ],
    enemies: [{
      id: 'wolf', name: 'Волк', creature_type: 'beast', hp: 20, maxHp: 20, armor: 12, speed: 40,
      abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: wolfX, y: 1, alive: true,
    }],
    scene: { turn: 1, location: 'Привал', title: 'Привал', cells },
    mechanics: {
      world_time: { elapsed_minutes: 0 },
      resources: {
        fighter: { second_wind: { current: 1, max: 1 }, action_surge: { current: 1, max: 1 } },
        cleric: { spell_slots_1: { current: 3, max: 3 }, spell_slots_2: { current: 2, max: 2 } },
      },
      conditions: hiddenParty
        ? Object.fromEntries(['fighter', 'cleric'].map((id) => [id, [{ id: 'hidden', duration: 'until-next-turn', check_total: 25 }]]))
        : {},
      combat: { active: false, round: 0, active_index: 0, initiative: [], action_economy: {} },
    },
  })
}

const run = (state, command, rolls) => resolveCommand({
  server_authoritative: true,
  expected_state_version: state.state_version,
  command_id: 'opening-cmd',
  ...command,
}, state, { diceService: dice(rolls), context: {} })

const attack = (extra = {}) => ({ command_type: 'MakeAttack', actor_id: 'fighter', target_id: 'wolf', ...extra })
const started = (result) => result.events.find((event) => event.event_type === 'CombatStarted')

// Инициатива: воин, жрица, волк — по одному d20 на каждого.
const FIGHTER_FIRST = [20, 2, 1]
const WOLF_FIRST = [1, 2, 20]

test('удар из исследования: инициатива, и если нападающий первый — удар сразу', () => {
  const state = camp()
  const result = run(state, attack(), [...FIGHTER_FIRST, 15, 4])
  const types = result.events.map((event) => event.event_type)
  const startIndex = types.indexOf('CombatStarted')
  const attackIndex = types.indexOf('AttackResolved')
  assert.ok(startIndex >= 0, 'удар обязан открыть бой')
  assert.ok(attackIndex > startIndex, 'удар идёт после инициативы, а не до неё')
  assert.deepEqual(started(result).payload.opening_action, {
    actor_id: 'fighter', command_type: 'MakeAttack', status: 'resolved', first_actor_id: 'fighter',
  })
  assert.equal(result.command.command_type, 'MakeAttack')

  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.active, true)
  assert.equal(after.mechanics.combat.initiative[after.mechanics.combat.active_index].actor_id, 'fighter', 'ход остаётся у нападающего')
  assert.equal(after.mechanics.combat.action_economy.fighter.action, false, 'удар потратил действие первого хода')
  assert.ok(result.rolls.some((roll) => roll.purpose === 'initiative'), 'инициатива бросается сервером')
})

test('удар из исследования: если первым ходит противник, бой начат, а удар ждёт хода героя', () => {
  const state = camp()
  const result = run(state, attack(), WOLF_FIRST)
  assert.equal(result.events.some((event) => event.event_type === 'AttackResolved'), false, 'удар вне очереди не проходит')
  assert.deepEqual(started(result).payload.opening_action, {
    actor_id: 'fighter', command_type: 'MakeAttack', status: 'deferred', first_actor_id: 'wolf',
  })
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.active, true)
  assert.equal(after.mechanics.combat.initiative[after.mechanics.combat.active_index].actor_id, 'wolf')
})

test('заведомо незаконный удар бой не начинает — ни первым, ни в ожидании хода', () => {
  // Волк в восьми клетках: голые руки до него не достают.
  for (const rolls of [FIGHTER_FIRST, WOLF_FIRST]) {
    const state = camp({ wolfX: 11 })
    assert.throws(() => run(state, attack(), rolls), (error) => error.code === 'TARGET_OUT_OF_RANGE')
  }
})

test('спрятавшийся отряд застаёт противника врасплох — по обычному правилу внезапности', () => {
  // Внезапность требует, чтобы враг не заметил ни одной угрозы: прячутся оба.
  const result = run(camp({ hiddenParty: true }), attack(), FIGHTER_FIRST)
  assert.deepEqual(started(result).payload.surprised, ['wolf'])
  // Жрица на виду — волк видит угрозу и врасплох не застигнут.
  const seen = camp({ hiddenParty: true })
  seen.mechanics.conditions.cleric = []
  assert.equal(started(run(seen, attack(), FIGHTER_FIRST)).payload.surprised, undefined)
})

test('враждебное заклинание из исследования тоже открывает бой', () => {
  const state = camp()
  const result = run(state, { command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'sacred-flame', target_id: 'wolf' }, [1, 20, 2])
  assert.equal(started(result).payload.opening_action.status, 'resolved')
  assert.equal(started(result).payload.opening_action.command_type, 'CastSpell')
  assert.ok(result.events.some((event) => event.event_type === 'SpellCast'), 'жрица ходит первой и творит сразу')
})

test('приём против противника из исследования открывает бой, привязанный к ходу — отвергается', () => {
  const state = camp({ wolfX: 4 })
  const shove = run(state, { command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'shove', target_id: 'wolf' }, WOLF_FIRST)
  assert.equal(started(shove).payload.opening_action.status, 'deferred')

  assert.throws(
    () => run(state, { command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'dash' }, []),
    (error) => error.code === 'COMBAT_NOT_ACTIVE',
    'Рывок без хода ничего не значит',
  )
})

test('мирное действие панели исполняется вне боя и бой не начинает', () => {
  const state = camp()
  const result = run(state, { command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'second-wind' }, [7])
  assert.equal(result.events.some((event) => event.event_type === 'CombatStarted'), false)
  const after = replayEvents(state, result.events)
  assert.ok(after.players.find((player) => player.id === 'fighter').hp > 12, 'Второе дыхание лечит')
  assert.equal(after.mechanics.resources.fighter.second_wind.current, 0, 'ресурс потрачен')
  assert.equal(after.mechanics.combat.active, false)
  assert.deepEqual(after.mechanics.combat.action_economy, {}, 'вне боя экономика хода не заводится')
})

test('без живых противников удар из исследования отвергается прежним кодом', () => {
  const state = camp()
  state.enemies[0].hp = 0
  state.enemies[0].alive = false
  assert.throws(
    () => run(state, { command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'shove', target_id: 'cleric' }, []),
    (error) => error.code === 'COMBAT_NOT_ACTIVE',
  )
})

test('признак exploration в каталоге: один на сервер и клиент', () => {
  const fighter = camp().players.find((player) => player.id === 'fighter')
  const byId = new Map(combatActionsFor(fighter).map((action) => [action.id, action.exploration]))
  assert.equal(byId.get('shove'), 'opens-combat')
  assert.equal(byId.get('grapple'), 'opens-combat')
  assert.equal(byId.get('second-wind'), 'allowed')
  assert.equal(byId.get('hide'), 'allowed')
  assert.equal(byId.get('help'), 'allowed')
  assert.equal(byId.get('first-aid'), 'allowed')
  assert.equal(byId.get('dash'), 'combat-only')
  assert.equal(byId.get('dodge'), 'combat-only')
  assert.equal(byId.get('disengage'), 'combat-only')
  assert.equal(byId.get('action-surge'), 'combat-only')
  assert.equal(explorationUseFor({ actionType: 'reaction', target: 'enemy' }), 'combat-only')
  assert.equal(explorationUseFor(null), 'combat-only')
})

// Домашнее правило BG3 (решение владельца от 2026-10-04): удар из исследования
// проходит сразу при любой инициативе, а ход нападающего остаётся целым.

test('BG3: противник первый — удар всё равно проходит сразу, бой начат', () => {
  const state = camp({ bg3: true })
  const result = run(state, attack(), [...WOLF_FIRST, 15, 4])
  const types = result.events.map((event) => event.event_type)
  assert.ok(types.indexOf('CombatStarted') >= 0 && types.indexOf('AttackResolved') > types.indexOf('CombatStarted'))
  assert.deepEqual(started(result).payload.opening_action, {
    actor_id: 'fighter', command_type: 'MakeAttack', free_strike: true,
    house_rule_id: BG3_OPENING_STRIKE_HOUSE_RULE_ID, status: 'resolved', first_actor_id: 'wolf',
  })
  const attackEvent = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attackEvent.house_rule_id, BG3_OPENING_STRIKE_HOUSE_RULE_ID, 'отступление от редакции видно в самом событии')
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.initiative[after.mechanics.combat.active_index].actor_id, 'wolf', 'очередь не тронута')
  assert.notEqual(after.mechanics.combat.action_economy.fighter?.action, false, 'удар не отнял ход героя')
})

test('BG3: нападающий первый — после удара его ход начинается целым', () => {
  const state = camp({ bg3: true })
  const result = run(state, attack(), [...FIGHTER_FIRST, 15, 4])
  const types = result.events.map((event) => event.event_type)
  assert.ok(types.indexOf('OpeningStrikeEconomyRestored') > types.indexOf('AttackResolved'))
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.initiative[after.mechanics.combat.active_index].actor_id, 'fighter')
  assert.equal(after.mechanics.combat.action_economy.fighter.action, true, 'действие первого хода не потрачено')
  assert.equal(after.mechanics.combat.action_economy.fighter.bonus_action, true)
})

test('BG3: незаконный удар бой не начинает, а без правила — прежний режим', () => {
  assert.throws(() => run(camp({ wolfX: 11, bg3: true }), attack(), WOLF_FIRST), (error) => error.code === 'TARGET_OUT_OF_RANGE')
  const raw = run(camp(), attack(), WOLF_FIRST)
  assert.equal(started(raw).payload.opening_action.status, 'deferred', 'кампания без правила играет по редакции')
})

test('BG3: спрятавшийся отряд бьёт из укрытия, даже если первым ходит противник', () => {
  const result = run(camp({ hiddenParty: true, bg3: true }), attack(), [...WOLF_FIRST, 15, 15, 4])
  assert.deepEqual(started(result).payload.surprised, ['wolf'])
  const attackEvent = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.ok(attackEvent, 'удар состоялся')
  assert.equal(attackEvent.payload.mode, 'advantage', 'скрытность до боя даёт преимущество удару-открытию')
})

test('удар по нейтральному NPC из исследования делает его противником и открывает бой', async () => {
  const fixture = await palaceFixture({ kingHp: 20, witnesses: false })
  // Герой встаёт вплотную к королю: удар голыми руками достаёт на 5 футов.
  const cells = new Map(fixture.state.scene.cells.map((cell) => [`${cell.x},${cell.y}`, cell]))
  const near = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: fixture.kingPoint.x + dx, y: fixture.kingPoint.y + dy }))
    .find((point) => cells.get(`${point.x},${point.y}`)?.type === 'floor')
  assert.ok(near, 'у короля есть свободная клетка рядом')
  const state = normalizeCampaignState({
    ...fixture.state,
    enabled_house_rules: [...fixture.state.enabled_house_rules, BG3_OPENING_STRIKE_HOUSE_RULE_ID],
    players: fixture.state.players.map((player) => player.id === fixture.heroId ? { ...player, ...near } : player),
    mechanics: { ...fixture.state.mechanics, positions: { ...fixture.state.mechanics.positions, [fixture.heroId]: near } },
  })
  const result = resolveCommand({
    command_type: 'MakeAttack', command_id: 'npc-strike', actor_id: fixture.heroId, target_id: fixture.kingId,
    server_authoritative: true, expected_state_version: state.state_version,
  }, state, { diceService: dice([1, 20, 18, 4]), context: {} })
  const types = result.events.map((event) => event.event_type)
  assert.ok(types.includes('EncounterCreated'), 'NPC становится участником встречи из своего профиля')
  const combat = result.events.find((event) => event.event_type === 'CombatStarted')
  assert.equal(combat.payload.opening_action.npc_id, fixture.kingId)
  assert.equal(combat.payload.opening_action.status, 'resolved')
  const strike = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(strike?.target_ids?.[0], fixture.kingId, 'удар пришёлся по тому самому NPC')
  assert.ok(types.indexOf('AttackResolved') > types.indexOf('CombatStarted'))
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.active, true)
  assert.ok(after.enemies.some((enemy) => enemy.id === fixture.kingId), 'король теперь противник')
})

test('мирное действие на нейтрального NPC бой не открывает', async () => {
  // «Помощь» — не нападение: путь `AttackNpc` не включается, и прежний отказ
  // по цели остаётся отказом, а не стычкой с королём.
  const fixture = await palaceFixture({ kingHp: 20, witnesses: false })
  assert.throws(() => resolveCommand({
    command_type: 'UseCombatAction', command_id: 'npc-help', actor_id: fixture.heroId, action_id: 'help', target_id: fixture.kingId,
    server_authoritative: true, expected_state_version: fixture.state.state_version,
  }, fixture.state, { diceService: dice([]), context: {} }), (error) => error.code === 'TARGET_NOT_FOUND')
})

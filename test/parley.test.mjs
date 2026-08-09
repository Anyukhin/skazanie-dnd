import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  PARLEY_BASE_DC,
  mentionsParley,
  parleyCounterReasonFor,
  parleyLeaderFor,
  parleyMoraleFor,
  parleySkillFor,
  parleyTributeCp,
  standingEnemies,
  truceFor,
  truceHolds,
} from '../server/parley.mjs'
import {
  RulesEngine,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { combatTurnClock } from '../server/combat-turn-coordinator.mjs'
import { runNpcTurnScheduler } from '../server/npc-turn-scheduler.mjs'
import { presentSceneNpcs } from '../server/npc-positioning.mjs'
import { STAGES } from '../server/post-commit-coordinator.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { worldDeedsFeed } from '../server/world-deeds.mjs'
import { combatNarration } from '../server/combat-narration.mjs'

const CAMPAIGN = 'PARLEY'

function dice(values = []) {
  return new DiceService({ rng: new SequenceDiceRng(values) })
}

function cells(width = 8, height = 8) {
  const grid = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  }
  return grid
}

function bandit(id, overrides = {}) {
  return {
    id,
    name: `Разбойник ${id.slice(-1)}`,
    hp: 11,
    maxHp: 11,
    armor: 12,
    speed: 30,
    creature_type: 'humanoid',
    stat_block_id: 'srd_5_2_1:bandit',
    provenance: { xp: 25 },
    attackBonus: 3,
    damageDice: 6,
    damageBonus: 1,
    x: 5,
    y: 1,
    alive: true,
    ...overrides,
  }
}

/**
 * Сцена посреди боя. По умолчанию сторона противника разбита: двое выбыли,
 * уцелевший держится на четверти хитов — именно то положение, в котором за
 * столом и начинают говорить.
 */
function campaign({ enemies, conditions = {}, combat = {}, minutes = 0 } = {}) {
  return normalizeCampaignState({
    sessionCode: CAMPAIGN,
    campaign: 'Парлей',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: {
      title: 'Разбитый тракт',
      location: 'Разбитый тракт',
      location_id: 'road',
      grid: { width: 8, height: 8 },
      cells: cells(),
    },
    players: [{
      id: 'hero',
      character: 'Ада',
      hp: 14,
      maxHp: 14,
      x: 1,
      y: 1,
      speed: 30,
      abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 12, cha: 16 },
      proficiency: 2,
      backgroundSkillProficiencies: ['persuasion'],
      currency: { gp: 1, sp: 0, cp: 0 },
      inventory: [],
    }],
    worldMap: {
      seed: 'parley-seed',
      locations: [{ id: 'road', name: 'Разбитый тракт', kind: 'wilds', x: 10, y: 10 }],
      routes: [],
    },
    enemies: enemies ?? [
      // Предводитель стоит вплотную к герою: под перемирием обе стороны и
      // правда стоят лицом к лицу, и удар в упор проверяется без перемещения.
      bandit('enemy-leader', { hp: 3, maxHp: 11, x: 2, y: 1 }),
      bandit('enemy-fallen-1', { hp: 0, alive: false, x: 5, y: 2 }),
      bandit('enemy-fallen-2', { hp: 0, alive: false, x: 5, y: 3 }),
    ],
    social: { npcs: [] },
    mechanics: {
      world_time: { elapsed_minutes: minutes },
      combat: {
        active: true,
        round: 2,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'enemy-leader', total: 9 }],
        active_index: 0,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 } },
        ...combat,
      },
      conditions,
    },
  })
}

function run(state, commands, { diceValues = [], context = {} } = {}) {
  return resolveCommands(
    commands.map((command, index) => ({ campaign_id: CAMPAIGN, command_id: `cmd-${index + 1}`, ...command })),
    state,
    { diceService: dice(diceValues), context: { allowedActorIds: ['hero'], ...context } },
  )
}

const propose = (skill = 'persuasion') => ({ command_type: 'ProposeParley', actor_id: 'hero', skill })

/**
 * Свежий ход того же героя. Парлей уже потратил действие, а проверяем мы не
 * экономику хода — она у команды своя и покрыта отдельно.
 */
function withFreshAction(state) {
  return normalizeCampaignState({
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: {
        ...state.mechanics.combat,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 } },
      },
    },
  })
}

/** Успешный парлей: перемирие заключено, действие героя снова свободно. */
function truced(state = campaign()) {
  return withFreshAction(run(state, [propose()], { diceValues: [20] }).state)
}

// ---------------------------------------------------------------------------
// Морал-калькулятор
// ---------------------------------------------------------------------------

test('СЛ парлея падает с потерями и ранами противника, а не с уговорами игрока', () => {
  const fresh = parleyMoraleFor(campaign({
    enemies: [bandit('enemy-leader'), bandit('enemy-second', { x: 5, y: 2 })],
  }))
  assert.equal(fresh.refuses, false)
  assert.equal(fresh.difficulty, PARLEY_BASE_DC, 'сторона в полной силе слушать не станет')

  const broken = parleyMoraleFor(campaign())
  assert.ok(broken.difficulty < fresh.difficulty, 'разбитая сторона говорит охотнее')
  assert.equal(broken.standing_count, 1)
  assert.equal(broken.fallen_count, 2)
  assert.equal(broken.leader_id, 'enemy-leader')
})

test('фанатик не отвечает на парлей и не даёт бросить кубик', () => {
  const berserkers = campaign({
    enemies: [
      bandit('enemy-berserker', { hp: 4, maxHp: 67, name: 'Берсерк', stat_block_id: 'srd_5_2_1:berserker', traits: [{ id: 'bloodied-frenzy', name: 'Кровавая ярость' }] }),
      bandit('enemy-fallen', { hp: 0, alive: false, x: 5, y: 2 }),
    ],
  })
  const morale = parleyMoraleFor(berserkers)
  assert.equal(morale.refuses, true)
  assert.equal(morale.refusal_reason, 'zealots')
  assert.deepEqual(morale.outcomes, [])

  const result = run(berserkers, [propose()])
  const types = result.events.map((event) => event.event_type)
  assert.ok(types.includes('ParleyProposed'))
  assert.ok(types.includes('ParleyRejected'))
  assert.equal(types.includes('TruceEstablished'), false, 'фанатик перемирия не даёт')
  assert.equal(result.rolls.length, 0, 'за заведомо невозможное игрок кубиком не платит')
  const rejected = result.events.find((event) => event.event_type === 'ParleyRejected')
  assert.equal(rejected.payload.reason, 'zealots')
  // Действие всё равно потрачено: окрик посреди схватки стоит хода.
  assert.equal(result.state.mechanics.combat.action_economy.hero.action, false)
  assert.equal(truceHolds(result.state), false)
})

test('бессловесная сторона не ведёт переговоров', () => {
  const undead = campaign({
    enemies: [bandit('enemy-skeleton', { hp: 2, maxHp: 13, name: 'Скелет', creature_type: 'undead', stat_block_id: 'srd_5_2_1:skeleton' })],
  })
  const morale = parleyMoraleFor(undead)
  assert.equal(morale.refuses, true)
  assert.equal(morale.refusal_reason, 'mindless')
})

test('предводителем становится самый крепкий уцелевший, а выбывшие в счёт не идут', () => {
  const state = campaign({
    enemies: [
      bandit('enemy-a', { hp: 5, maxHp: 11 }),
      bandit('enemy-b', { hp: 20, maxHp: 40, x: 6, y: 1 }),
      bandit('enemy-c', { hp: 0, alive: false, x: 6, y: 2 }),
    ],
    conditions: { 'enemy-a': [] },
  })
  assert.equal(parleyLeaderFor(state).id, 'enemy-b')
  assert.deepEqual(standingEnemies(state).map((enemy) => enemy.id), ['enemy-a', 'enemy-b'])
})

// ---------------------------------------------------------------------------
// Успех, провал, повтор
// ---------------------------------------------------------------------------

test('разбитая сторона отвечает: успех замораживает бой и открывает условия', () => {
  const state = campaign()
  const morale = parleyMoraleFor(state)
  const result = run(state, [propose()], { diceValues: [20] })
  const truce = truceFor(result.state)
  assert.ok(truce, 'успешный парлей обязан оставить перемирие в состоянии боя')
  assert.equal(truce.leader_id, 'enemy-leader')
  assert.equal(truce.difficulty, morale.difficulty)
  assert.ok(truce.outcomes.includes('resume'))
  assert.ok(truce.outcomes.includes('withdraw'))
  assert.equal(truceHolds(result.state), true)

  // Собеседник появляется как обычный социальный профиль: без него разговор с
  // предводителем невозможен по построению движка.
  const leaderProfile = result.state.social.npcs.find((npc) => npc.id === 'enemy-leader')
  assert.ok(leaderProfile, 'у предводителя обязан появиться профиль собеседника')
  assert.ok(leaderProfile.tags.includes('parley-leader'))
  // Но жителем локации он не становится: допуск к разговору держится на живом
  // перемирии, а не на availability профиля.
  assert.equal(leaderProfile.available, false)
  assert.equal(leaderProfile.location, '')
})

test('провал даёт насмешку, а повторный окрик в том же бою идёт с помехой', () => {
  const state = campaign()
  const failed = run(state, [propose()], { diceValues: [1] })
  const rejected = failed.events.find((event) => event.event_type === 'ParleyRejected')
  assert.ok(rejected, 'провал обязан оставить событие отказа')
  assert.equal(rejected.payload.reason, 'roll_failed')
  assert.ok(rejected.payload.taunt.length > 0, 'насмешка — часть нарратива, а не пустая строка')
  assert.equal(truceHolds(failed.state), false)
  assert.equal(failed.state.mechanics.combat.parley_attempts, 1)

  // Действие вернём: интересна помеха, а не экономика хода.
  const second = run(withFreshAction(failed.state), [propose()], { diceValues: [20, 2] })
  const proposed = second.events.find((event) => event.event_type === 'ParleyProposed')
  assert.equal(proposed.payload.mode, 'disadvantage', 'второй окрик в том же бою идёт с помехой')
  assert.equal(proposed.payload.attempt, 2)
})

/**
 * Режим кубиков у парлея задаёт само правило, а не карточка превью: повторный
 * окрик идёт с помехой независимо от того, что было зарегистрировано. Одна
 * кость помеху не измеряет — `Math.min` от неё же и есть она сама, — поэтому
 * такой бросок правилу не годится и движок бросает сам.
 */
test('помеха повторного окрика не исчезает от броска одной костью', () => {
  const failed = run(campaign(), [propose()], { diceValues: [1] })

  const forged = run(withFreshAction(failed.state), [{
    ...propose(),
    verified_roll: { roll_id: 'roll-single', dice: [20] },
  }], { diceValues: [3, 2] })
  const forgedProposed = forged.events.find((event) => event.event_type === 'ParleyProposed')
  assert.equal(forgedProposed.payload.mode, 'disadvantage')
  assert.notEqual(forgedProposed.payload.roll_id, 'roll-single', 'кость мимо режима правило не принимает')
  assert.deepEqual(forgedProposed.payload.dice, [3, 2], 'серверный бросок честно кидает две кости')

  const honest = run(withFreshAction(failed.state), [{
    ...propose(),
    verified_roll: { roll_id: 'roll-pair', dice: [20, 19] },
  }])
  const honestProposed = honest.events.find((event) => event.event_type === 'ParleyProposed')
  assert.equal(honestProposed.payload.player_rolled, true, 'бросок игрока в своём режиме принимается как есть')
  assert.equal(honestProposed.payload.kept, 19, 'помеха оставляет меньшую кость')
})

test('вне боя и при живом перемирии предложить переговоры нельзя', () => {
  const peace = normalizeCampaignState({
    ...campaign(),
    mechanics: { ...campaign().mechanics, combat: { active: false, round: 0, initiative: [], active_index: -1 } },
  })
  assert.throws(() => run(peace, [propose()]), { code: 'COMBAT_NOT_ACTIVE' })
  assert.throws(() => run(truced(), [propose()]), { code: 'TRUCE_ALREADY_ACTIVE' })
})

// ---------------------------------------------------------------------------
// Вероломство
// ---------------------------------------------------------------------------

test('атака в перемирие рвёт его и пишет вероломство в летопись поступков', () => {
  const held = truced()
  assert.equal(truceHolds(held), true)

  const attack = run(held, [{
    command_type: 'MakeAttack',
    actor_id: 'hero',
    target_id: 'enemy-leader',
  }], { diceValues: [18, 4], context: { serverAuthoritativeCombat: true } })

  const broken = attack.events.find((event) => event.event_type === 'TruceBroken')
  assert.ok(broken, 'удар под перемирием обязан оставить событие разрыва')
  assert.equal(broken.payload.broken_by, 'party')
  assert.equal(broken.payload.leader_id, 'enemy-leader')
  // Разрыв стоит в журнале раньше самого удара: следствие не может опередить причину.
  const brokenIndex = attack.events.findIndex((event) => event.event_type === 'TruceBroken')
  const attackIndex = attack.events.findIndex((event) => event.event_type === 'AttackResolved')
  assert.ok(brokenIndex < attackIndex)
  assert.equal(truceHolds(attack.state), false, 'перемирие снимается тем же событием')

  const deeds = worldDeedsFeed(attack.state)
  const treachery = deeds.find((deed) => deed.kind === 'treachery')
  assert.ok(treachery, 'вероломство обязано попасть в летопись поступков')
  assert.equal(treachery.severity, 'grave')
  assert.deepEqual(treachery.actor_ids, ['hero'])
  assert.ok(treachery.witness_ids.includes('enemy-leader'), 'обманутый и есть первый свидетель')
})

test('лечение союзника под перемирием вероломством не считается', () => {
  const healed = run(truced(), [{
    command_type: 'ApplyHealing',
    actor_id: 'hero',
    target_id: 'hero',
    amount: 3,
  }])
  assert.equal(healed.events.some((event) => event.event_type === 'TruceBroken'), false)
  assert.equal(truceHolds(healed.state), true)
})

// ---------------------------------------------------------------------------
// Исходы
// ---------------------------------------------------------------------------

test('условия ухода исполняются событиями: противник покидает сцену', () => {
  const settled = run(truced(), [{ command_type: 'SettleParley', actor_id: 'hero', outcome: 'withdraw' }])
  const types = settled.events.map((event) => event.event_type)
  assert.ok(types.includes('ParleySettled'))
  const fled = settled.events.filter((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'fled')
  assert.equal(fled.length, 1, 'уцелевший обязан уйти событием, а не описанием')
  const leader = settled.state.enemies.find((enemy) => enemy.id === 'enemy-leader')
  assert.equal(leader.alive, false, 'ушедший снят с поля тем же условием, что и сломленный моралью')
  assert.equal(truceHolds(settled.state), false)
  // Клятва остаётся записью памяти мира, а не строкой карточки.
  const oath = settled.events.find((event) => event.event_type === 'WorldFactRecorded' && event.payload.fact.predicate === 'parley_oath')
  assert.ok(oath)
  assert.equal(oath.payload.fact.visibility, 'party')
})

test('сдача по уговору ведёт противника тем же путём плена, что и слом морали', () => {
  const rich = campaign({
    enemies: [bandit('enemy-leader', { hp: 1, maxHp: 11 }), bandit('enemy-fallen', { hp: 0, alive: false, x: 5, y: 2 })],
  })
  const morale = parleyMoraleFor(rich)
  assert.ok(morale.outcomes.includes('surrender'), 'почти добитая сторона готова сдаться')

  const settled = run(truced(rich), [{ command_type: 'SettleParley', actor_id: 'hero', outcome: 'surrender' }])
  const surrendered = settled.events.filter((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'surrendered')
  assert.equal(surrendered.length, 1)
  assert.equal(settled.state.enemies.find((enemy) => enemy.id === 'enemy-leader').alive, false)

  // Дальше работает уже существующий контур плена: закрытие боя берёт пленных.
  const ended = run(settled.state, [{ command_type: 'EndCombat', actor_id: 'hero', reason: 'enemies_defeated' }])
  assert.ok(ended.events.some((event) => event.event_type === 'CaptiveTaken'))
  // Пленный — житель сцены, в отличие от собеседника переговоров: он идёт с
  // отрядом, стоит на посту и виден на доске. Заглушка профиля заменяется
  // полноценной, иначе сдавшийся по уговору пропал бы из сцены.
  assert.deepEqual(presentSceneNpcs(ended.state).map((npc) => npc.id), ['enemy-leader'])
  const captiveProfile = ended.state.social.npcs.find((npc) => npc.id === 'enemy-leader')
  assert.equal(captiveProfile.available, true)
  assert.ok(captiveProfile.tags.includes('captive'))
  assert.equal(captiveProfile.tags.includes('parley-leader'), false)
})

test('откуп берётся монетой из XP стат-блоков, а не выдуманным предметом', () => {
  const rich = campaign({
    enemies: [
      bandit('enemy-leader', { hp: 2, maxHp: 11, provenance: { xp: 450 } }),
      bandit('enemy-fallen', { hp: 0, alive: false, x: 5, y: 2, provenance: { xp: 450 } }),
    ],
  })
  const expected = parleyTributeCp(rich)
  assert.ok(expected > 0)
  const morale = parleyMoraleFor(rich)
  assert.ok(morale.outcomes.includes('tribute'))

  const held = truced(rich)
  const before = held.players[0].currency
  const settled = run(held, [{ command_type: 'SettleParley', actor_id: 'hero', outcome: 'tribute' }])
  const paid = settled.events.find((event) => event.event_type === 'ParleySettled')
  assert.equal(paid.payload.tribute_cp, expected)
  assert.notDeepEqual(settled.state.players[0].currency, before)
  assert.equal(settled.state.enemies.find((enemy) => enemy.id === 'enemy-leader').alive, false)
})

test('исход вне объявленного списка сервер не принимает', () => {
  // Сторона цела и потерь не понесла: говорить она согласилась, но сдаваться и
  // платить откуп ей не с чего. Список исходов считает мораль, а не клиент.
  const whole = campaign({
    enemies: [bandit('enemy-leader', { x: 2, y: 1 }), bandit('enemy-second', { x: 5, y: 2 })],
  })
  const held = truced(whole)
  const truce = truceFor(held)
  assert.deepEqual(truce.outcomes, ['resume', 'withdraw'])
  for (const outcome of ['surrender', 'tribute']) {
    assert.throws(
      () => run(held, [{ command_type: 'SettleParley', actor_id: 'hero', outcome }]),
      { code: 'PARLEY_OUTCOME_FORBIDDEN' },
    )
  }
})

test('прерванные переговоры возвращают бой без вероломства', () => {
  const resumed = run(truced(), [{ command_type: 'SettleParley', actor_id: 'hero', outcome: 'resume' }])
  assert.equal(truceHolds(resumed.state), false)
  assert.equal(resumed.events.some((event) => event.event_type === 'ConditionAdded'), false)
  assert.equal(worldDeedsFeed(resumed.state).some((deed) => deed.kind === 'treachery'), false)
})

// ---------------------------------------------------------------------------
// Replay, проекция, нарратив
// ---------------------------------------------------------------------------

test('перемирие и его разрыв переживают replay', () => {
  const first = run(campaign(), [propose()], { diceValues: [20] })
  const attack = run(withFreshAction(first.state), [{ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy-leader' }], {
    diceValues: [18, 4],
    context: { serverAuthoritativeCombat: true },
  })
  const events = [...first.events, ...attack.events]
  const replayed = replayEvents(campaign(), events)
  assert.equal(truceHolds(replayed), false)
  assert.deepEqual(
    worldDeedsFeed(replayed).map((deed) => deed.kind).sort(),
    worldDeedsFeed(attack.state).map((deed) => deed.kind).sort(),
  )

  // Повторное применение тех же событий ничего не добавляет: летопись поступков
  // идемпотентна по идентификатору поступка.
  const twice = events.reduce(applyGameEvent, replayed)
  assert.equal(worldDeedsFeed(twice).filter((deed) => deed.kind === 'treachery').length, 1)
})

test('перемирие видно игроку, а летопись поступков — нет', () => {
  const projected = campaignStateForViewer(truced(), { role: 'player' }, 'hero')
  assert.ok(projected.mechanics.combat.truce, 'состояние перемирия обязано доехать до доски')
  assert.equal(projected.mechanics.combat.truce.leader_id, 'enemy-leader')
  assert.ok(Array.isArray(projected.mechanics.combat.truce.outcomes))
  assert.equal(projected.world_deeds, undefined, 'летопись поступков остаётся у ведущего')
})

test('парлей рассказывается детерминированным боевым рассказчиком', () => {
  const result = run(campaign(), [propose()], { diceValues: [20] })
  const text = combatNarration(result.events, result.state)
  assert.match(text, /Поговорим/u)
  assert.match(text, /[Пп]еремирие/u)
})

test('перемирие останавливает продолжение боя, а его снятие — возвращает', () => {
  const continuation = STAGES.find((stage) => stage.name === 'combat-continuation')
  assert.ok(continuation, 'стадия продолжения боя обязана существовать')

  const fighting = campaign()
  assert.equal(continuation.applies({ state: fighting, eventTypes: new Set() }), true)

  const held = truced()
  assert.equal(
    continuation.applies({ state: held, eventTypes: new Set() }),
    false,
    'на перемирии ходов нет ни у кого — стадия не должна даже начинаться',
  )

  const resumed = run(held, [{ command_type: 'SettleParley', actor_id: 'hero', outcome: 'resume' }]).state
  assert.equal(continuation.applies({ state: resumed, eventTypes: new Set() }), true)
})

/**
 * Собеседник переговоров — боевой актор, а не житель локации. Записи в
 * `npc_world.vitals` у него нет, поэтому доступный профиль с адресом текущей
 * сцены `presentSceneNpcs()` возвращал бы вечно: и после бегства, и после
 * смерти. Именно этот список — вход `sceneWitnessIds()` летописи поступков и
 * допуска к разговору, поэтому проверяется он, а не косвенные следствия.
 */
test('собеседник переговоров не остаётся в мире ни живым свидетелем, ни говорящим трупом', () => {
  const held = truced()
  assert.deepEqual(presentSceneNpcs(held).map((npc) => npc.id), [], 'на доске предводитель — враг, а не второй NPC сцены')

  const finished = run(held, [{
    command_type: 'ApplyDamage',
    actor_id: 'hero',
    target_id: 'enemy-leader',
    amount: 99,
  }], { context: { serverAuthoritativeCombat: true, isAdmin: true } })
  assert.equal(finished.state.enemies.find((enemy) => enemy.id === 'enemy-leader').alive, false)
  assert.deepEqual(
    presentSceneNpcs(finished.state).map((npc) => npc.id),
    [],
    'убитый предводитель не может свидетельствовать о следующих поступках отряда',
  )

  // Бой закрыт, перемирия нет — разговаривать с ним больше не с чего.
  const ended = run(finished.state, [{ command_type: 'EndCombat', actor_id: 'hero', reason: 'enemies_defeated' }])
  assert.deepEqual(presentSceneNpcs(ended.state).map((npc) => npc.id), [])
  const projected = campaignStateForViewer(ended.state, { role: 'player' }, 'hero').social.npcs
    .find((npc) => npc.id === 'enemy-leader')
  assert.ok(projected, 'знакомство остаётся в памяти отряда')
  assert.equal(projected.available, false)
  assert.equal(projected.location, '')
})

test('перемирие останавливает часы хода, а снятое перемирие открывает новый срок', () => {
  const startedAt = '2026-08-09T00:00:00.000Z'
  const fighting = campaign({ combat: { turn_started_at: startedAt, turn_started_event_id: 'evt-turn-1' } })
  const now = Date.parse(startedAt) + 1_000
  const fightingClock = combatTurnClock(fighting, [], { now })
  assert.ok(fightingClock, 'вне перемирия у хода героя обязан быть дедлайн')
  assert.deepEqual(fightingClock.actor_ids, ['hero'])

  const held = truced(fighting)
  assert.equal(
    combatTurnClock(held, [], { now }),
    null,
    'на перемирии часы стоят: иначе сервер закоммитил бы EndTurn за героя посреди переговоров',
  )

  // Переговоры за столом идут дольше срока хода — это норма, а не сбой.
  const settledAt = new Date(Date.parse(startedAt) + 30 * 60_000).toISOString()
  const settled = run(held, [{ command_type: 'SettleParley', actor_id: 'hero', outcome: 'resume' }])
  const resumed = replayEvents(held, settled.events.map((event, index) => ({
    ...event, event_id: `settle-${index + 1}`, created_at: settledAt,
  })))
  const resumedClock = combatTurnClock(resumed, [], { now: Date.parse(settledAt) + 1_000 })
  assert.ok(resumedClock, 'снятое перемирие возвращает ход герою')
  assert.deepEqual(resumedClock.actor_ids, ['hero'])
  assert.ok(
    Date.parse(resumedClock.deadline_at) > Date.parse(settledAt),
    'возвращённый ход получает новый срок, а не истёкший ещё во время разговора',
  )
})

test('перемирие морозит планировщик ходов NPC, а снятое — возвращает его', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-parley-scheduler-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  /** Ход противника: без перемирия планировщик обязан за него сходить. */
  const enemyTurn = (state) => normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } },
  })
  const scheduler = async (campaignId, state) => {
    const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
    await eventStore.initializeCampaign({ campaign_id: campaignId, initial_state: state })
    return runNpcTurnScheduler({
      campaignId,
      eventStore,
      rulesEngine: new RulesEngine({ diceService: dice([15, 3, 15, 3]) }),
      npcController: { decide: async () => null },
    })
  }

  const held = truced()
  const frozen = await scheduler('PARLEY-FROZEN', enemyTurn(held))
  assert.deepEqual(frozen.turns, [], 'на перемирии планировщик не делает ни одного хода')
  assert.deepEqual(frozen.events, [])
  assert.equal(truceHolds(frozen.state), true)

  const resumed = run(held, [{ command_type: 'SettleParley', actor_id: 'hero', outcome: 'resume' }]).state
  const running = await scheduler('PARLEY-RESUMED', enemyTurn(resumed))
  assert.ok(running.turns.length > 0, 'без перемирия тот же планировщик за противника ходит')
})

test('фраза о переговорах распознаётся сервером без модели', () => {
  assert.equal(mentionsParley('кричу им: остановитесь, поговорим!'), true)
  assert.equal(mentionsParley('Предлагаю переговоры'), true)
  assert.equal(mentionsParley('Сдавайтесь, и мы вас не тронем'), true)
  assert.equal(mentionsParley('Предлагаю переговоры: хватит драться!'), true)
  assert.equal(mentionsParley('бью топором по щиту'), false)
})

/**
 * Распознавание стоит **до** разбора намерения и тратит действие героя, поэтому
 * цена ложного срабатывания выше цены пропуска: слово о переговорах в боевой
 * фразе окриком не считается.
 */
test('слово о переговорах в боевой фразе окриком не считается', () => {
  const counters = [
    ['Кричу товарищу: поговорим после боя! А сейчас бью гоблина топором', 'attack'],
    ['Помню, староста говорил про переговоры с гильдией — но сейчас атакую', 'attack'],
    ['Перемирием тут и не пахнет, режу его', 'attack'],
    ['Хватит драться, я сдаюсь', 'own_surrender'],
    ['Никаких переговоров с этой швалью', 'negation'],
    ['Предлагаю переговоры, но не сейчас', 'postponed'],
    ['Помню, в трактире говорили про переговоры с бандой', 'recollection'],
  ]
  for (const [phrase, reason] of counters) {
    assert.equal(parleyCounterReasonFor(phrase), reason, phrase)
    assert.equal(mentionsParley(phrase), false, phrase)
  }
})

test('нажим и уговор различает та же функция, что и распознаёт окрик', () => {
  assert.equal(parleySkillFor('кричу им: остановитесь, поговорим!'), 'persuasion')
  assert.equal(parleySkillFor('Сдавайтесь, и мы вас не тронем'), 'intimidation')
  // Угроза в будущем времени — нажим на переговорах, а не наносимый удар.
  assert.equal(mentionsParley('Прекрати бой, гоблин, или я тебя убью'), true)
  assert.equal(parleySkillFor('Прекрати бой, гоблин, или я тебя убью'), 'intimidation')
})

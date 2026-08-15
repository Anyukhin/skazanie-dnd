import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  BLESSING_ATTACK_BONUS,
  BLESSING_CONDITION,
  BLESSING_COOLDOWN_MINUTES,
  BLESSING_DONATION_CP,
  BLESSING_REPUTATION_DELTA,
  PRAYER_DC,
  blessingAvailabilityFor,
  blessingOmenFor,
  blessingPriestsFor,
  blessingRecordFor,
  blessingsForViewer,
  heroIsBlessed,
  isPriestProfile,
  normalizeBlessingState,
} from '../server/blessings.mjs'
import {
  isSceneShrineAsset,
  sceneInteractionDefinition,
  sceneObjectOperationFromText,
  nearestSceneObjectCommand,
} from '../server/scene-interactions.mjs'
import {
  RulesValidationError,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { addProp, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { combatNarration } from '../server/combat-narration.mjs'

const CAMPAIGN = 'SHRINE-1'
const CHAPEL = 'Придорожная часовня'
const PRIEST = 'father'
const SMITH = 'smith'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `blessing-roll-${++id}`,
    now: () => '2026-08-15T09:00:00.000Z',
  })
}

/**
 * Часовня с алтарём и двумя NPC: служителем и кузнецом.
 *
 * Владения у героя пусты намеренно: без списка движок считает его владеющим
 * любым навыком, и модификатор проверки Религии перестал бы быть предсказуемым.
 * С Интеллектом 10 и без владения модификатор равен нулю — значит, кость и есть
 * итог, и СЛ 12 читается прямо в числах теста.
 */
function chapel({
  assetId = 'altar',
  minutes = 0,
  currency = { copper: 0, silver: 0, gold: 2, platinum: 0 },
  blessings,
  conditions = {},
  priestFactions = ['faction:temple-dawn'],
} = {}) {
  const map = createTacticalMap({
    width: 5,
    height: 3,
    locationId: 'chapel',
    seed: 'chapel-seed',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  addProp(map, {
    id: `prop-${assetId}`,
    assetId,
    x: 1.5,
    y: 0.5,
    footprint: [{ x: 1, y: 0 }],
    interactive: true,
  })
  return normalizeCampaignState({
    sessionCode: CAMPAIGN,
    campaign: 'Молитвы и благословения',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    players: [{
      id: 'hero',
      character: 'Ада',
      hp: 12,
      maxHp: 12,
      proficiency: 2,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      classSkillProficiencies: [],
      savingThrowProficiencies: [],
      backgroundSkillProficiencies: [],
      currency,
      inventory: [],
      x: 0,
      y: 0,
    }],
    enemies: [],
    scene: {
      title: CHAPEL,
      location: CHAPEL,
      location_id: 'chapel',
      map: serializeTacticalMap(map),
      turn: 1,
    },
    social: {
      npcs: [
        { id: PRIEST, name: 'Отец Никодим', role: 'жрец Утренней зари', location: CHAPEL, visibility: 'party', tags: priestFactions, public_summary: 'Служитель часовни.' },
        { id: SMITH, name: 'Кузнец Горазд', role: 'кузнец', location: CHAPEL, visibility: 'party', public_summary: 'Зашёл поставить свечу.' },
      ],
    },
    ...(blessings ? { blessings } : {}),
    mechanics: {
      positions: { hero: { x: 0, y: 0 } },
      conditions,
      world_time: { elapsed_minutes: minutes },
    },
  })
}

const pray = (propId = 'prop-altar') => ({ command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: propId, intent: 'pray' })
const ask = (npcId = PRIEST) => ({ command_type: 'ReceiveNpcBlessing', actor_id: 'hero', npc_id: npcId })

function run(state, commands, { diceValues = [], context = {} } = {}) {
  return resolveCommands(
    commands.map((command, index) => ({ campaign_id: CAMPAIGN, command_id: `cmd-${index + 1}`, ...command })),
    state,
    { diceService: dice(diceValues), context: { allowedActorIds: ['hero'], ...context } },
  )
}

function eventOf(result, type) {
  return result.events.find((event) => event.event_type === type) ?? null
}

function rejects(state, commands, code, options = {}) {
  assert.throws(() => run(state, commands, options), (error) => {
    assert.ok(error instanceof RulesValidationError, `ожидался отказ движка, пришло ${error}`)
    assert.equal(error.code, code, `ожидался отказ ${code}, пришёл ${error.code}: ${error.message}`)
    return true
  })
}

function purseCp(state, heroId = 'hero') {
  const currency = state.players.find((player) => player.id === heroId)?.currency ?? {}
  return (Number(currency.copper) || 0)
    + (Number(currency.silver) || 0) * 10
    + (Number(currency.gold) || 0) * 100
    + (Number(currency.platinum) || 0) * 1_000
}

// ---------------------------------------------------------------------------
// Каталог: у чего вообще молятся
// ---------------------------------------------------------------------------

test('глагол молитвы открыт святыне и закрыт всему остальному', () => {
  for (const assetId of ['altar', 'roadside_shrine', 'statue']) {
    assert.equal(isSceneShrineAsset(assetId), true, `${assetId} обязан быть святыней`)
    const definition = sceneInteractionDefinition({
      mapSeed: 'chapel-seed',
      props: [{ id: 'prop', assetId }],
      propId: 'prop',
    })
    assert.ok(definition.verbs.includes('pray'), `${assetId}: кнопка молитвы обязана приехать глаголом`)
    assert.equal(definition.shrine, true)
  }
  // Руна и жаровня — тоже реликвии каталога, но святынями не объявлены: молиться
  // светильнику движок не даст, и кнопки такой у него не появится.
  for (const assetId of ['rune', 'brazier', 'chest', 'prayer_bench', 'reliquary']) {
    assert.equal(isSceneShrineAsset(assetId), false, `${assetId} святыней быть не должен`)
    const definition = sceneInteractionDefinition({
      mapSeed: 'chapel-seed',
      props: [{ id: 'prop', assetId }],
      propId: 'prop',
    })
    assert.equal(definition.verbs.includes('pray'), false, `${assetId}: глагол молитвы просочился`)
  }
})

test('свободный текст узнаёт молитву и не молится ближайшему сундуку', () => {
  assert.equal(sceneObjectOperationFromText('Помолиться у алтаря').intent, 'pray')
  assert.equal(sceneObjectOperationFromText('Преклонить колени и вознести молитву').intent, 'pray')
  assert.equal(sceneObjectOperationFromText('Осмотреть алтарь').intent, 'inspect')
  const props = [
    { id: 'prop-chest', assetId: 'chest', x: 0, y: 0, footprint: [{ x: 0, y: 0 }] },
    { id: 'prop-altar', assetId: 'altar', x: 4, y: 0, footprint: [{ x: 4, y: 0 }] },
  ]
  // Сундук стоит вплотную, святыня — в другом конце зала. Молитва всё равно
  // адресуется святыне: иначе движку уезжала бы команда, которую он же отвергнет.
  assert.deepEqual(nearestSceneObjectCommand({ props, actorPosition: { x: 0, y: 0 }, text: 'Помолиться' }), {
    command_type: 'OperateSceneObject',
    prop_id: 'prop-altar',
    intent: 'pray',
    approach: 'hand',
  })
})

test('служителя опознаёт роль профиля, а не тег и не имя', () => {
  assert.equal(isPriestProfile({ role: 'жрец Утренней зари' }), true)
  assert.equal(isPriestProfile({ role: 'настоятельница обители' }), true)
  assert.equal(isPriestProfile({ role: 'монах' }), true)
  assert.equal(isPriestProfile({ role: 'кузнец' }), false)
  // Основы закреплены слева: «монах» внутри чужого слова служителем не делает.
  assert.equal(isPriestProfile({ role: 'мономах' }), false)
  assert.deepEqual(blessingPriestsFor(chapel()).map((npc) => npc.id), [PRIEST])
})

// ---------------------------------------------------------------------------
// Молитва у святыни
// ---------------------------------------------------------------------------

test('успешная молитва даёт малое благословение, факт мира и суточный слот', () => {
  const state = chapel()
  const result = run(state, [pray()], { diceValues: [15] })

  const check = eventOf(result, 'AbilityCheckResolved')
  assert.equal(check.payload.skill, 'religion')
  assert.equal(check.payload.difficulty, PRAYER_DC)
  assert.equal(check.payload.success, true)

  const prayer = eventOf(result, 'ShrinePrayerResolved')
  assert.equal(prayer.payload.outcome, 'blessed')
  assert.equal(prayer.payload.place_name, CHAPEL)
  assert.equal(prayer.payload.condition, BLESSING_CONDITION)

  const condition = eventOf(result, 'ConditionAdded')
  assert.equal(condition.payload.condition, BLESSING_CONDITION)
  assert.equal(condition.payload.duration, 'until-long-rest')
  assert.equal(condition.payload.source, 'blessing:shrine')

  // Подлежащее факта — локация: память мира хранит факты только о своих
  // сущностях, а героя отряда среди них нет.
  const place = state.worldMemory.entities.find((entity) => entity.kind === 'location' && entity.name === CHAPEL)
  const fact = eventOf(result, 'WorldFactRecorded')
  assert.equal(fact.payload.fact.subject_id, place.id)
  assert.equal(fact.payload.fact.object, 'hero')
  assert.match(fact.payload.fact.summary, /благословение/u)
  assert.deepEqual(fact.payload.fact.source_event_ids, [prayer.event_id])

  const after = replayEvents(state, result.events)
  assert.equal(heroIsBlessed(after, 'hero'), true)
  assert.equal(blessingRecordFor(after, 'hero').granted, true)
  assert.equal(blessingRecordFor(after, 'hero').source, 'shrine')
  // Факт уехал в память мира, а не только в событие: рассказчик читает её.
  assert.ok((after.worldMemory?.facts ?? []).some((entry) => entry.object === 'hero' && /благословение/u.test(entry.summary)),
    'факт обязан пережить нормализацию памяти мира, иначе рассказчику его не прочесть')
})

test('провал ничего не отнимает, но сутки закрывает', () => {
  const state = chapel()
  const result = run(state, [pray()], { diceValues: [5] })
  assert.equal(eventOf(result, 'ShrinePrayerResolved').payload.outcome, 'silence')
  assert.equal(eventOf(result, 'ConditionAdded'), null, 'провал не вешает на героя ничего')
  assert.equal(eventOf(result, 'DamageApplied'), null, 'и ничего не отнимает')

  const after = replayEvents(state, result.events)
  assert.equal(heroIsBlessed(after, 'hero'), false)
  assert.equal(blessingRecordFor(after, 'hero').granted, false)
  // Сутки считаются по попытке, а не по успеху: иначе неудачную молитву
  // повторяли бы до двадцатки — у алтаря никто никуда не спешит.
  rejects(after, [pray()], 'BLESSING_ALREADY_TODAY', { diceValues: [20] })
  rejects(after, [ask()], 'BLESSING_ALREADY_TODAY')
})

test('натуральная единица отвечает знамением — строкой и без единого штрафа', () => {
  const state = chapel()
  const result = run(state, [pray()], { diceValues: [1] })
  const prayer = eventOf(result, 'ShrinePrayerResolved')
  assert.equal(prayer.payload.outcome, 'omen')
  assert.ok(prayer.payload.omen.length > 10, 'знамение обязано быть строкой, а не флагом')
  assert.equal(eventOf(result, 'ConditionAdded'), null)
  assert.equal(eventOf(result, 'DamageApplied'), null)
  // Знамение детерминировано сидом: replay расскажет ровно то же самое.
  assert.equal(blessingOmenFor('seed-one'), blessingOmenFor('seed-one'))
  assert.notEqual(blessingOmenFor('seed-one'), blessingOmenFor('seed-two'))
  assert.match(combatNarration(result.events, state), /знамени|молит/iu)
})

test('через сутки молиться можно снова', () => {
  const first = run(chapel(), [pray()], { diceValues: [5] })
  const spent = replayEvents(chapel(), first.events)
  const availability = blessingAvailabilityFor(spent, 'hero', 0)
  assert.equal(availability.available, false)
  assert.equal(availability.waits_minutes, BLESSING_COOLDOWN_MINUTES)

  const tomorrow = normalizeCampaignState({
    ...spent,
    mechanics: { ...spent.mechanics, world_time: { amount: BLESSING_COOLDOWN_MINUTES, unit: 'minute', elapsed_minutes: BLESSING_COOLDOWN_MINUTES } },
  })
  assert.equal(blessingAvailabilityFor(tomorrow, 'hero', BLESSING_COOLDOWN_MINUTES).available, true)
  assert.equal(eventOf(run(tomorrow, [pray()], { diceValues: [18] }), 'ShrinePrayerResolved').payload.outcome, 'blessed')
})

test('молитва идёт двухфазным ручным кубиком: принесённая кость считается той же СЛ', () => {
  const result = run(chapel(), [{ ...pray(), verified_roll: { roll_id: 'roll-manual', dice: [17] } }], { diceValues: [1] })
  const check = eventOf(result, 'AbilityCheckResolved')
  assert.equal(check.payload.player_rolled, true, 'кость игрока принимается как есть')
  assert.equal(check.payload.roll_id, 'roll-manual')
  assert.equal(check.payload.difficulty, PRAYER_DC)
  assert.equal(eventOf(result, 'ShrinePrayerResolved').payload.outcome, 'blessed')
})

test('молиться можно только святыне и только дотянувшись', () => {
  // Сундук глагола молитвы не объявляет — движок отвергает её до броска.
  rejects(chapel({ assetId: 'chest' }), [{ ...pray('prop-chest') }], 'SCENE_OBJECT_INTENT_NOT_ALLOWED')
  const far = normalizeCampaignState({
    ...chapel(),
    mechanics: { ...chapel().mechanics, positions: { hero: { x: 4, y: 2 } } },
    players: chapel().players.map((player) => ({ ...player, x: 4, y: 2 })),
  })
  rejects(far, [pray()], 'SCENE_OBJECT_OUT_OF_REACH')
})

/**
 * Оба пути к благословению закрываются боем одинаково, и запрет на молитву — не
 * про уместность, а про минуты: обращение стоит четверти часа кампании, а
 * четверть часа посреди раунда в шесть секунд двигает всё, что висит на мировых
 * минутах, — сроки обещаний NPC и подъём стабилизированного героя. Без этого
 * запрета бой обходили бы через алтарь, оставив требе её собственный.
 */
test('в бою не молятся у алтаря — так же, как не просят требу', () => {
  const battle = normalizeCampaignState({
    ...chapel(),
    mechanics: {
      ...chapel().mechanics,
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 12 }] },
    },
  })
  rejects(battle, [pray()], 'BLESSING_DURING_COMBAT', { diceValues: [20] })
  // Боевые глаголы обстановки при этом остаются боевыми: они не стоят ни минуты
  // кампании, и общего запрета на пропсы в бою нет.
  assert.equal(
    run(battle, [{ command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-altar', intent: 'inspect' }], { diceValues: [12] }).events.length > 0,
    true,
  )
})

// ---------------------------------------------------------------------------
// Благословение жреца
// ---------------------------------------------------------------------------

test('жрец благословляет за пожертвование: монета из кошелька, репутация храму', () => {
  const state = chapel()
  const result = run(state, [ask()])

  const granted = eventOf(result, 'NpcBlessingGranted')
  assert.equal(granted.payload.npc_id, PRIEST)
  assert.equal(granted.payload.donation_cp, BLESSING_DONATION_CP)
  assert.equal(granted.payload.balance_before_cp - granted.payload.balance_after_cp, BLESSING_DONATION_CP)
  assert.equal(result.rolls.length, 0, 'за благословение платят, а не бросают')

  const reputation = eventOf(result, 'FactionReputationAdjusted')
  assert.equal(reputation.payload.faction_id, 'temple-dawn')
  assert.equal(reputation.payload.delta, BLESSING_REPUTATION_DELTA)
  assert.equal(reputation.payload.source_event_id, granted.event_id)

  const after = replayEvents(state, result.events)
  assert.equal(purseCp(after), purseCp(state) - BLESSING_DONATION_CP)
  assert.equal(heroIsBlessed(after, 'hero'), true)
  assert.equal(blessingRecordFor(after, 'hero').source, 'priest')
  assert.equal(after.autonomy.reputations['temple-dawn'], BLESSING_REPUTATION_DELTA)
  // Тот же суточный слот: после жреца молиться сегодня уже не о чем.
  rejects(after, [pray()], 'BLESSING_ALREADY_TODAY', { diceValues: [20] })
})

test('жрец без фракции благословляет, но благодарить некого', () => {
  const state = chapel({ priestFactions: [] })
  const result = run(state, [ask()])
  assert.ok(eventOf(result, 'NpcBlessingGranted'))
  assert.equal(eventOf(result, 'FactionReputationAdjusted'), null, 'события репутации без фракции быть не должно')
  assert.equal(heroIsBlessed(replayEvents(state, result.events), 'hero'), true)
})

test('требу отвергают кузнецу, нищему и посреди боя', () => {
  rejects(chapel(), [ask(SMITH)], 'BLESSING_PRIEST_NOT_FOUND')
  rejects(chapel({ currency: { copper: 5, silver: 0, gold: 0, platinum: 0 } }), [ask()], 'INSUFFICIENT_FUNDS')
  const battle = normalizeCampaignState({
    ...chapel(),
    mechanics: {
      ...chapel().mechanics,
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 12 }] },
    },
  })
  rejects(battle, [ask()], 'BLESSING_DURING_COMBAT')
})

// ---------------------------------------------------------------------------
// Что благословение делает и когда кончается
// ---------------------------------------------------------------------------

const SWORD = {
  id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
  combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
}

/** Поле боя: тот же герой, но с мечом и противником в шаге от него. */
function battlefield({ conditions = {} } = {}) {
  const cells = Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SHRINE-2',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Ада', hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
      abilities: { str: 14, dex: 10, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [SWORD], x: 1, y: 1,
    }],
    enemies: [{
      id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 30, maxHp: 30, armor: 15, speed: 30,
      abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 8, cha: 8 }, x: 2, y: 1, alive: true,
    }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const strike = (state, values) => resolveCommand(
  { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'brute', item_id: 'sword', server_authoritative: true },
  state,
  { diceService: dice(values), context: { serverAuthoritativeCombat: true, isAdmin: true } },
)

test('благословение прибавляет к первой атаке и на ней же кончается', () => {
  const plain = strike(battlefield(), [10, 5])
  const blessed = strike(battlefield({ conditions: { hero: [{ id: BLESSING_CONDITION, duration: 'until-long-rest' }] } }), [10, 5])

  const plainAttack = plain.rolls.find((roll) => roll.purpose === 'attack')
  const blessedAttack = blessed.rolls.find((roll) => roll.purpose === 'attack')
  assert.equal(blessedAttack.modifier - plainAttack.modifier, BLESSING_ATTACK_BONUS, 'удар точнее ровно на единицу')

  const removed = blessed.events.find((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === BLESSING_CONDITION)
  assert.ok(removed, 'благословение обязано израсходоваться тем же ударом')
  assert.equal(removed.payload.trigger, 'attack')

  const after = replayEvents(battlefield({ conditions: { hero: [{ id: BLESSING_CONDITION, duration: 'until-long-rest' }] } }), blessed.events)
  assert.equal(heroIsBlessed(after, 'hero'), false, 'второй удар идёт уже без благословения')
  assert.match(combatNarration(blessed.events, battlefield()), /Благословение израсходовано/u)
})

test('продолжительный отдых снимает благословение, не дожидаясь удара', () => {
  const state = chapel()
  const blessed = replayEvents(state, run(state, [pray()], { diceValues: [15] }).events)
  assert.equal(heroIsBlessed(blessed, 'hero'), true)
  const rested = replayEvents(blessed, [{
    campaign_id: CAMPAIGN,
    command_id: 'rest-1',
    event_id: 'rest-event-1',
    event_type: 'RestCompleted',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { kind: 'long' },
    visibility: 'party',
  }])
  assert.equal(heroIsBlessed(rested, 'hero'), false)
})

// ---------------------------------------------------------------------------
// Состояние и проекция
// ---------------------------------------------------------------------------

test('реестр благословений нормализуется, а мусор в нём не выживает', () => {
  const normalized = normalizeBlessingState({
    heroes: {
      hero: { at_minutes: 120, source: 'priest', granted: true, place_name: CHAPEL, npc_id: PRIEST, npc_name: 'Отец Никодим' },
      '': { at_minutes: 10 },
      broken: 'нет',
      weird: { at_minutes: -5, source: 'дракон', granted: 'да' },
    },
  })
  assert.equal(normalized.heroes.hero.at_minutes, 120)
  assert.equal(normalized.heroes[''], undefined)
  assert.equal(normalized.heroes.broken, undefined)
  assert.equal(normalized.heroes.weird.at_minutes, 0)
  assert.equal(normalized.heroes.weird.source, 'shrine', 'незнакомый источник схлопывается в святыню')
  assert.equal(normalized.heroes.weird.granted, false, 'благословением объявляет только булево true')
})

test('карточка благословений собирается сервером, а сырой реестр наружу не идёт', () => {
  const state = chapel()
  const blessed = replayEvents(state, run(state, [ask()]).events)
  const room = campaignStateForViewer(blessed, { role: 'player' }, 'hero')

  assert.equal(room.blessings.blessed, true)
  assert.equal(room.blessings.available, false)
  assert.equal(room.blessings.donation_cp, BLESSING_DONATION_CP)
  assert.equal(room.blessings.prayer_dc, PRAYER_DC)
  assert.deepEqual(room.blessings.priests.map((npc) => npc.id), [PRIEST])
  assert.equal(room.blessings.last.source, 'priest')
  // Сырого реестра суточных слотов в комнате быть не должно: наружу идёт только
  // карточка под конкретного героя.
  assert.equal(room.blessings.heroes, undefined)
  // Иконку на панели рисует общий механизм состояний: благословение обязано
  // приехать обычным условием героя.
  assert.ok((room.mechanics.conditions.hero ?? []).some((condition) => String(condition.id) === BLESSING_CONDITION))

  const empty = blessingsForViewer(chapel(), { playerId: 'hero' })
  assert.equal(empty.blessed, false)
  assert.equal(empty.available, true)
  assert.equal(empty.last, null)
})

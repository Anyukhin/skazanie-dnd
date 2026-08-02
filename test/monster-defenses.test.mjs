// Резисты, иммунитеты и уязвимости монстров: данные SRD 5.2.1, единый счётчик
// урона, иммунитет к состоянию и закрытость списков от игроков.
//
// Сторож ровно того обещания, ради которого строки Vulnerabilities/Resistances/
// Immunities вообще переносились: они обязаны действовать одинаково на любом
// источнике урона. Раньше карта `mechanics.defenses` существовала, но заполнять
// её было нечем, и скелет одинаково получал от дубины и от стрелы.
import assert from 'node:assert/strict'
import test from 'node:test'

import { combatNarration } from '../server/combat-narration.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST, assembleEncounter } from '../server/encounter-assembler.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, resolveCommands } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const DEFENSE_FIELDS = Object.freeze([
  'damage_vulnerabilities', 'damage_resistances', 'damage_immunities', 'condition_immunities',
])

/** Списки защит существа из allowlist — ровно в том виде, в каком их получит враг. */
function defensesOf(statBlockId) {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  return Object.fromEntries(DEFENSE_FIELDS
    .filter((field) => block[field]?.length)
    .map((field) => [field, [...block[field]]]))
}

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `monster-defense-roll-${++id}`,
    now: () => '2026-08-02T12:00:00.000Z',
  })
}

const ABILITIES = Object.freeze({ str: 14, dex: 10, con: 14, int: 6, wis: 10, cha: 6 })

function enemy(id, statBlockId, x) {
  return {
    id,
    name: SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]?.name ?? id,
    hp: 60,
    maxHp: 60,
    armor: 13,
    speed: 30,
    alive: true,
    abilities: { ...ABILITIES },
    x,
    y: 0,
    stat_block_id: statBlockId,
    ...(statBlockId ? defensesOf(statBlockId) : {}),
  }
}

function campaignState({ inCombat = false } = {}) {
  return normalizeCampaignState({
    sessionCode: 'MONSTER-DEFENSES',
    campaign_id: 'MONSTER-DEFENSES',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Мира',
      characterClass: 'wizard',
      level: 3,
      proficiency: 2,
      hp: 30,
      maxHp: 30,
      armor: 14,
      speed: 30,
      abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
      attackBonus: 5,
      damageDice: 6,
      damageBonus: 2,
      x: 0,
      y: 0,
      knownSpellIds: ['fire-bolt'],
      preparedSpellIds: ['fire-bolt'],
    }],
    enemies: [
      enemy('skeleton', 'srd_5_2_1:skeleton', 1),
      enemy('tree', 'srd_5_2_1:awakened-tree', 2),
      enemy('jelly', 'srd_5_2_1:ochre-jelly', 3),
      { ...enemy('wolf', 'srd_5_2_1:wolf', 4), name: 'Волк' },
    ],
    scene: {
      turn: 1,
      cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, skeleton: { x: 1, y: 0 }, tree: { x: 2, y: 0 }, jelly: { x: 3, y: 0 }, wolf: { x: 4, y: 0 } },
      combat: inCombat
        ? {
          active: true,
          round: 1,
          active_index: 0,
          initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'tree', total: 5 }],
          action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
        }
        : { active: false },
    },
  })
}

function damage(state, targetId, damageType, amount, commandId = `damage-${targetId}-${damageType}-${amount}`) {
  return resolveCommand({
    command_type: 'ApplyDamage',
    command_id: commandId,
    actor_id: 'hero',
    target_id: targetId,
    amount,
    damage_type: damageType,
  }, state, { diceService: dice(), context: { isAdmin: true } })
}

function damagePayloadOf(result) {
  return result.events.find((event) => event.event_type === 'DamageApplied').payload
}

function applied(state, targetId, damageType, amount) {
  return damagePayloadOf(damage(state, targetId, damageType, amount)).applied_amount
}

test('профили SRD 5.2.1 несут строки защит и только у тех существ, у кого они есть', () => {
  const expected = {
    'srd_5_2_1:skeleton': { page: 325, damage_vulnerabilities: ['bludgeoning'], damage_immunities: ['poison'], condition_immunities: ['exhaustion', 'poisoned'] },
    'srd_5_2_1:minotaur-skeleton': { page: 326, damage_vulnerabilities: ['bludgeoning'], damage_immunities: ['poison'], condition_immunities: ['exhaustion', 'poisoned'] },
    'srd_5_2_1:zombie': { page: 343, damage_immunities: ['poison'], condition_immunities: ['exhaustion', 'poisoned'] },
    'srd_5_2_1:ogre-zombie': { page: 344, damage_immunities: ['poison'], condition_immunities: ['exhaustion', 'poisoned'] },
    'srd_5_2_1:ghoul': { page: 288, damage_immunities: ['poison'], condition_immunities: ['exhaustion', 'poisoned'] },
    'srd_5_2_1:violet-fungus': { page: 286, condition_immunities: ['blinded', 'charmed', 'deafened', 'frightened'] },
    'srd_5_2_1:awakened-tree': { page: 260, damage_vulnerabilities: ['fire'], damage_resistances: ['bludgeoning', 'piercing'] },
    'srd_5_2_1:giant-elk': { page: 351, damage_resistances: ['necrotic', 'radiant'] },
    'srd_5_2_1:knight': { page: 302, condition_immunities: ['frightened'] },
    'srd_5_2_1:animated-armor': {
      page: 259,
      damage_immunities: ['poison', 'psychic'],
      condition_immunities: ['charmed', 'deafened', 'exhaustion', 'frightened', 'paralyzed', 'petrified', 'poisoned'],
    },
    'srd_5_2_1:ochre-jelly': {
      page: 312,
      damage_resistances: ['acid'],
      damage_immunities: ['lightning', 'slashing'],
      condition_immunities: ['blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'prone'],
    },
    'srd_5_2_1:earth-elemental': {
      page: 282,
      damage_vulnerabilities: ['thunder'],
      damage_immunities: ['poison'],
      condition_immunities: ['exhaustion', 'paralyzed', 'petrified', 'poisoned', 'unconscious'],
    },
    'srd_5_2_1:barbed-devil': { page: 262, damage_resistances: ['cold'], damage_immunities: ['fire', 'poison'], condition_immunities: ['poisoned'] },
  }

  for (const [statBlockId, { page, ...lists }] of Object.entries(expected)) {
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
    assert.ok(block, statBlockId)
    // Номер страницы у строк защит тот же, что у остального стат-блока.
    assert.equal(block.source_page, page, `${statBlockId}: страница SRD`)
    for (const field of DEFENSE_FIELDS) {
      assert.deepEqual(block[field] ?? undefined, lists[field], `${statBlockId}.${field}`)
    }
  }

  // Ничего не выдумано сверх перечисленного: у остальных существ строк нет.
  const withDefenses = Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)
    .filter(([, block]) => DEFENSE_FIELDS.some((field) => block[field]?.length))
    .map(([id]) => id)
  assert.deepEqual(withDefenses.sort(), Object.keys(expected).sort())

  // Значения — строчные идентификаторы, иначе сверка в движке не совпадёт.
  for (const block of Object.values(SRD_5_2_1_MONSTER_ALLOWLIST)) {
    for (const field of DEFENSE_FIELDS) {
      for (const value of block[field] ?? []) assert.equal(value, value.toLowerCase())
    }
  }
})

test('собранное столкновение переносит строки защит во врага вместе с provenance', () => {
  const proposal = assembleEncounter({
    difficulty: 'hard',
    theme: 'undead',
    seed: 'defenses-1',
    party: [{ id: 'hero', level: 3, x: 0, y: 0 }],
    scene: {
      cells: Array.from({ length: 64 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true })),
    },
  })
  const undead = proposal.enemies.filter((candidate) => SRD_5_2_1_MONSTER_ALLOWLIST[candidate.stat_block_id].damage_immunities?.length)
  assert.ok(undead.length, 'тема нежити обязана поднять хотя бы одно существо с иммунитетом')
  for (const candidate of proposal.enemies) {
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[candidate.stat_block_id]
    for (const field of DEFENSE_FIELDS) {
      assert.deepEqual(candidate[field], block[field]?.length ? [...block[field]] : undefined, `${candidate.stat_block_id}.${field}`)
    }
    // Строки защит и номер страницы приходят из одного стат-блока.
    assert.equal(candidate.provenance.source_page, block.source_page)
  }

  const beasts = assembleEncounter({
    difficulty: 'easy',
    theme: 'beasts',
    seed: 'wolf-1',
    party: [{ id: 'hero', level: 1, x: 0, y: 0 }],
    scene: {
      cells: Array.from({ length: 64 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true })),
    },
  })
  // Пустая строка стат-блока не превращается в пустой массив: формы записи
  // врага без защит менять не за что.
  for (const candidate of beasts.enemies) {
    for (const field of DEFENSE_FIELDS) {
      if (!SRD_5_2_1_MONSTER_ALLOWLIST[candidate.stat_block_id][field]) assert.equal(field in candidate, false, `${candidate.stat_block_id}.${field}`)
    }
  }
})

test('сопротивление, иммунитет и уязвимость считаются по SRD и округляются вниз', () => {
  const state = campaignState()

  // Уязвимость — удвоение, иммунитет — ноль, обычный тип — без изменений.
  assert.equal(applied(state, 'skeleton', 'bludgeoning', 9), 18)
  assert.equal(applied(state, 'skeleton', 'poison', 9), 0)
  assert.equal(applied(state, 'skeleton', 'slashing', 9), 9)

  // Сопротивление — половина с округлением вниз.
  assert.equal(applied(state, 'tree', 'bludgeoning', 9), 4)
  assert.equal(applied(state, 'tree', 'piercing', 7), 3)
  assert.equal(applied(state, 'tree', 'fire', 7), 14)
  assert.equal(applied(state, 'jelly', 'acid', 9), 4)
  assert.equal(applied(state, 'jelly', 'lightning', 9), 0)
  assert.equal(applied(state, 'jelly', 'slashing', 9), 0)

  // У существа без строк защит ничего не меняется.
  assert.equal(applied(state, 'wolf', 'bludgeoning', 9), 9)
  assert.equal(applied(state, 'wolf', 'poison', 9), 9)

  const immune = damagePayloadOf(damage(state, 'skeleton', 'poison', 9))
  assert.equal(immune.immune, true)
  assert.equal(immune.raw_amount, 9)
  assert.equal(immune.hp_before, immune.hp_after)

  const resistant = damagePayloadOf(damage(state, 'tree', 'bludgeoning', 9))
  assert.equal(resistant.resistant, true)
  assert.equal(resistant.vulnerable, false)

  const vulnerable = damagePayloadOf(damage(state, 'tree', 'fire', 7))
  assert.equal(vulnerable.vulnerable, true)
  assert.equal(vulnerable.resistant, false)
})

test('сопротивление применяется после модификаторов и до временных хитов', () => {
  const state = campaignState()
  state.mechanics.temporary_hp.jelly = 3
  const payload = damagePayloadOf(damage(state, 'jelly', 'acid', 9))
  // 9 кислоты → 4 после сопротивления → 3 съедают временные хиты → 1 в ОЗ.
  assert.equal(payload.raw_amount, 9)
  assert.equal(payload.temporary_hp_absorbed, 3)
  assert.equal(payload.applied_amount, 1)
  assert.equal(payload.hp_after, payload.hp_before - 1)
})

test('единый путь урона: атака-заклинание и прямой урон дают один и тот же резист', () => {
  const state = campaignState({ inCombat: true })
  // Огненный снаряд: попадание 18+5 против КД 13, урон 1d10 = 7.
  const cast = resolveCommand({
    command_type: 'CastSpell',
    command_id: 'fire-bolt-tree',
    actor_id: 'hero',
    spell_id: 'fire-bolt',
    target_id: 'tree',
    target_ids: ['tree'],
    server_authoritative: true,
  }, state, { diceService: dice([18, 7]), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const spellPayload = damagePayloadOf(cast)
  assert.equal(spellPayload.damage_type, 'fire')
  assert.equal(spellPayload.raw_amount, 7)
  assert.equal(spellPayload.vulnerable, true)
  assert.equal(spellPayload.applied_amount, 14)

  const directPayload = damagePayloadOf(damage(state, 'tree', 'fire', 7))
  assert.equal(directPayload.applied_amount, spellPayload.applied_amount)
  assert.equal(directPayload.vulnerable, spellPayload.vulnerable)
})

test('иммунитет к состоянию отменяет наложение, а причина уходит отдельным событием', () => {
  const state = campaignState()
  const command = (targetId) => ({
    command_type: 'AddCondition',
    command_id: `poison-${targetId}`,
    actor_id: 'hero',
    target_id: targetId,
    condition: 'poisoned',
  })

  const blocked = resolveCommand(command('skeleton'), state, { diceService: dice(), context: { isAdmin: true } })
  assert.deepEqual(blocked.events.map((event) => event.event_type), ['ConditionImmunityResolved'])
  assert.equal(blocked.events[0].payload.condition, 'poisoned')
  assert.equal(blocked.events[0].payload.reason, 'condition-immunity')
  assert.deepEqual(blocked.events[0].target_ids, ['skeleton'])
  const afterBlocked = blocked.events.reduce(applyGameEvent, state)
  assert.deepEqual(afterBlocked.mechanics.conditions.skeleton ?? [], [])

  // Тот же приказ по существу без иммунитета работает как прежде.
  const applied = resolveCommand(command('wolf'), state, { diceService: dice(), context: { isAdmin: true } })
  assert.deepEqual(applied.events.map((event) => event.event_type), ['ConditionAdded'])
  const afterApplied = applied.events.reduce(applyGameEvent, state)
  assert.ok((afterApplied.mechanics.conditions.wolf ?? []).some((condition) => String(condition.id ?? condition) === 'poisoned'))

  // Иммунитет закрыт списком стат-блока, а не всеми состояниями подряд.
  const other = resolveCommand({ ...command('skeleton'), command_id: 'blind-skeleton', condition: 'blinded' }, state, { diceService: dice(), context: { isAdmin: true } })
  assert.deepEqual(other.events.map((event) => event.event_type), ['ConditionAdded'])
})

test('replay даёт то же состояние, а повтор события ничего не удваивает', () => {
  const initial = campaignState()
  const resolution = resolveCommands([
    { command_type: 'ApplyDamage', command_id: 'replay-1', actor_id: 'hero', target_id: 'tree', amount: 9, damage_type: 'bludgeoning' },
    { command_type: 'ApplyDamage', command_id: 'replay-2', actor_id: 'hero', target_id: 'skeleton', amount: 9, damage_type: 'poison' },
    { command_type: 'AddCondition', command_id: 'replay-3', actor_id: 'hero', target_id: 'skeleton', condition: 'poisoned' },
  ], initial, { diceService: dice(), context: { isAdmin: true } })

  const replayed = replayEvents(initial, resolution.events)
  assert.deepEqual(replayed.enemies, resolution.state.enemies)
  assert.deepEqual(replayed.mechanics.conditions, resolution.state.mechanics.conditions)
  assert.equal(replayed.enemies.find((candidate) => candidate.id === 'tree').hp, 60 - 4)
  assert.equal(replayed.enemies.find((candidate) => candidate.id === 'skeleton').hp, 60)

  const immunityEvent = resolution.events.find((event) => event.event_type === 'ConditionImmunityResolved')
  assert.ok(immunityEvent)
  assert.deepEqual(applyGameEvent(replayed, immunityEvent).mechanics.conditions, replayed.mechanics.conditions)
})

test('точные списки защит не доходят до игрока ни в состоянии, ни в событиях', () => {
  const state = campaignState()
  const result = damage(state, 'jelly', 'acid', 9)
  const user = { role: 'player', heroIds: ['hero'] }
  const room = campaignStateForViewer(state, user, 'hero')
  const events = mechanicsForViewer(result.events, user, 'hero', state)
  const encounterEvent = mechanicsForViewer([{
    event_type: 'EncounterCreated',
    actor_id: 'hero',
    target_ids: [],
    visibility: 'public',
    payload: { encounter: { id: 'enc-1', enemies: state.enemies } },
  }], user, 'hero', state)

  for (const [label, surface] of [['состояние кампании', room.enemies], ['события', events], ['столкновение', encounterEvent]]) {
    const json = JSON.stringify(surface)
    for (const field of DEFENSE_FIELDS) assert.doesNotMatch(json, new RegExp(field, 'u'), `${label}: утёк список ${field}`)
  }
  // Состав списков не виден и по значениям: враг в проекции — только имя,
  // клетка и полоса здоровья. Событие урона проверяется отдельно: там вид
  // урона назван законно, это то, что игрок и так видел за столом.
  for (const [label, surface] of [['состояние кампании', room.enemies], ['столкновение', encounterEvent]]) {
    assert.doesNotMatch(JSON.stringify(surface), /lightning|slashing|acid|poison/u, `${label}: утёк состав списка`)
  }

  // Сам факт «урон уполовинен» игрок видит: это наблюдаемый за столом исход.
  assert.equal(events.find((event) => event.event_type === 'DamageApplied').payload.resistant, true)
})

test('рассказчик объясняет исход качественно и не перечисляет защиты', () => {
  const state = campaignState()
  const jelly = combatNarration(damage(state, 'jelly', 'lightning', 9).events, state)
  assert.match(jelly, /Молния не действует на Золотистый студень\./u)
  assert.doesNotMatch(jelly, /slashing|список|иммунитет/iu)

  const resisted = combatNarration(damage(state, 'tree', 'bludgeoning', 9).events, state)
  assert.match(resisted, /вязнет/u)

  const vulnerable = combatNarration(damage(state, 'tree', 'fire', 7).events, state)
  assert.match(vulnerable, /уязвимому месту/u)

  const immuneCondition = resolveCommand({
    command_type: 'AddCondition', command_id: 'narrate-poison', actor_id: 'hero', target_id: 'skeleton', condition: 'poisoned',
  }, state, { diceService: dice(), context: { isAdmin: true } })
  assert.match(combatNarration(immuneCondition.events, state), /Скелет не поддаётся/u)
})

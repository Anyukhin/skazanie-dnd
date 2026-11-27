import assert from 'node:assert/strict'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, attackForecast, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'
import { createTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap, setCell, setDoor } from '../server/tactical-map.mjs'

// Ожидаемые результаты взяты из карточки Blade Ward и раздела «Состояния»
// 5e14.dnd.su, наблюдённых 30 сентября 2026; формулы движка здесь не повторяются.
function fixture({ weapon = 'longsword', enemyX = 2, casterElevation = 0, enemyElevation = 0, walls = [] } = {}) {
  return normalizeCampaignState({
    sessionCode: 'RULES-2014-REVIEW', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [{ id: 'caster', character: 'Волшебник', characterClass: 'wizard', level: 12,
      hp: 100, maxHp: 100, armor: 14, speed: 30, proficiency: 4,
      abilities: { str: 16, dex: 16, con: 14, int: 16, wis: 10, cha: 10 },
      knownSpellIds: ['true-strike', 'fire-bolt', 'blade-ward', 'ice-knife', 'enlarge-reduce'], preparedSpellIds: ['ice-knife', 'enlarge-reduce'],
      inventory: [materializeCatalogItem(`srd_5_2_1:${weapon}`, { id: 'weapon', equipped: true, quantity: 1 }),
        materializeCatalogItem('srd_5_2_1:arrows-20', { id: 'arrows', quantity: 1 }),
        materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'pouch', quantity: 1 })], x: 1, y: 1 }],
    enemies: [{ id: 'enemy', name: 'Противник', hp: 100, maxHp: 100, armor: 12, speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: enemyX, y: 1, alive: true }],
    scene: { turn: 1, cells: Array.from({ length: 48 }, (_, i) => ({ x: i % 12, y: Math.floor(i / 12), type: walls.includes(i) ? 'wall' : 'floor', revealed: true,
      elevation: i === 13 ? casterElevation : i === enemyX + 12 ? enemyElevation : 0 })) },
    mechanics: { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'enemy', total: 10 }],
      action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
  })
}
function condition(state, target, id, source = 'caster') {
  return applyGameEvent(state, { event_id: `condition:${target}:${id}`, event_type: 'ConditionAdded', actor_id: source,
    target_ids: [target], payload: { condition: id, source_actor: source } })
}
function run(state, command, values) {
  let roll = 0
  return resolveCommand({ ...command, server_authoritative: true }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `review-roll-${++roll}` }),
    context: { serverAuthoritativeCombat: true },
  })
}
const attack = (state, values = [15, 15, 8, 8]) => run(state, {
  command_type: 'MakeAttack', actor_id: 'caster', target_id: 'enemy', item_id: 'weapon',
}, values)

test('Blade Ward 2014 не уменьшает физический урон ловушки или прямого эффекта', () => {
  const state = condition(fixture(), 'enemy', 'blade-ward')
  for (const type of ['bludgeoning', 'piercing', 'slashing']) {
    const result = run(state, { command_type: 'ApplyDamage', actor_id: 'caster', target_id: 'enemy', amount: 11, damage_type: type }, [])
    const damage = result.events.find(event => event.event_type === 'DamageApplied')
    assert.equal(damage.payload.applied_amount, 11, type)
    assert.equal(damage.payload.resistant, false, type)
  }
})

test('Blade Ward 2014 делит урон атаки оружием: 11 рубящего урона становится 5', () => {
  const result = attack(condition(fixture(), 'enemy', 'blade-ward'), [15, 8])
  const damage = result.events.find(event => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.raw_amount, 11)
  assert.equal(damage.payload.applied_amount, 5)
})

test('Blade Ward 2014 не защищает от колющего урона атаки Ледяным ножом', () => {
  const result = run(condition(fixture(), 'enemy', 'blade-ward'), {
    command_type: 'CastSpell', actor_id: 'caster', spell_id: 'ice-knife', target_id: 'enemy', target_ids: ['enemy'],
  }, [15, 7, 3, 3, 20, 20])
  const damage = result.events.find(event => event.event_type === 'DamageApplied' && event.payload.damage_type === 'piercing')
  assert.equal(damage.payload.applied_amount, 7)
  assert.equal(damage.payload.resistant, false)
})

test('парализованная цель: попадание дальней атакой с 5 футов критическое', () => {
  const state = condition(fixture({ weapon: 'shortbow' }), 'enemy', 'paralyzed')
  const result = attack(state, [15, 4, 4])
  const hit = result.events.find(event => event.event_type === 'AttackResolved')
  assert.equal(hit.payload.hit, true)
  assert.equal(hit.payload.critical, true)
  assert.equal(hit.payload.automatic_critical, true)
  const forecast = attackForecast(state, 'caster', 'enemy', { itemId: 'weapon' })
  assert.equal(forecast.critical_chance, forecast.hit_chance)
})

test('паралич не даёт автокрит древковому оружию на дистанции 10 футов', () => {
  const result = attack(condition(fixture({ weapon: 'glaive', enemyX: 3 }), 'enemy', 'paralyzed'), [15, 15, 6, 6])
  const hit = result.events.find(event => event.event_type === 'AttackResolved')
  assert.equal(hit.payload.hit, true)
  assert.equal(hit.payload.critical, false)
})

test('сбитая с ног цель на 10 футах даёт помеху даже атаке оружием с досягаемостью', () => {
  const state = condition(fixture({ weapon: 'glaive', enemyX: 3 }), 'enemy', 'prone')
  const result = attack(state, [15, 8, 6])
  const hit = result.events.find(event => event.event_type === 'AttackResolved')
  assert.equal(hit.payload.mode, 'disadvantage')
  assert.deepEqual(hit.payload.condition_disadvantage, ['target:prone'])
})

test('Увеличение 2014 даёт преимущество на проверку Силы', () => {
  const result = run(condition(fixture(), 'caster', 'enlarged'), {
    command_type: 'MakeAbilityCheck', actor_id: 'caster', ability: 'str', difficulty: 14,
  }, [4, 15])
  const check = result.events.find(event => event.event_type === 'AbilityCheckResolved')
  assert.equal(check.payload.kept, 15)
  assert.equal(check.payload.success, true)
})

test('Уменьшение 2014 даёт помеху проверке и спасброску Силы, другие характеристики не меняет', () => {
  const state = condition(fixture(), 'caster', 'reduced')
  for (const commandType of ['MakeAbilityCheck', 'MakeSavingThrow']) {
    const result = run(state, { command_type: commandType, actor_id: 'caster', ability: 'str', difficulty: 14 }, [15, 4])
    const check = result.events.find(event => ['AbilityCheckResolved', 'SavingThrowResolved'].includes(event.event_type))
    assert.equal(check.payload.kept, 4, commandType)
    assert.equal(check.payload.success, false, commandType)
  }
  const result = run(state, { command_type: 'MakeAbilityCheck', actor_id: 'caster', ability: 'dex', difficulty: 14 }, [15, 4])
  assert.equal(result.events.find(event => event.event_type === 'AbilityCheckResolved').payload.kept, 15)
})

const applied = (state, result) => result.events.reduce(applyGameEvent, state)
function trueStrike(state = fixture(), targetId = 'enemy') {
  return applied(state, run(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'true-strike',
    target_id: targetId, target_ids: [targetId] }, []))
}
function nextCasterTurn(state) {
  state = applied(state, run(state, { command_type: 'EndTurn', actor_id: 'caster' }, []))
  return applied(state, run(state, { command_type: 'EndTurn', actor_id: 'enemy' }, []))
}

test('Верный удар 2014 записывает выбранную цель и не даёт преимущество на том же ходу', () => {
  const state = trueStrike()
  const effect = state.mechanics.conditions.caster.find(entry => entry.id === 'true-strike')
  assert.equal(effect.target_actor_id, 'enemy')
  assert.equal(effect.true_strike_armed, false)
  assert.equal(state.mechanics.conditions.enemy?.some(entry => entry.id === 'true-strike') ?? false, false)
  const forecast = attackForecast(state, 'caster', 'enemy', { itemId: 'weapon' })
  assert.equal(forecast.advantage, false)
  // Всплеск действий или другое разрешённое дополнительное действие не меняет «следующий ход».
  state.mechanics.combat.action_economy.caster.action = true
  const result = attack(state, [15, 8])
  assert.equal(result.events.find(event => event.event_type === 'AttackResolved').payload.mode, 'normal')
  assert.equal(applied(state, result).mechanics.conditions.caster.some(entry => entry.id === 'true-strike'), true)
})

test('Верный удар 2014 действует на первую атаку по выбранной цели на следующем ходу', () => {
  const state = nextCasterTurn(trueStrike())
  assert.equal(attackForecast(state, 'caster', 'enemy', { itemId: 'weapon' }).advantage, true)
  const result = attack(state, [4, 15, 8])
  assert.equal(result.events.find(event => event.event_type === 'AttackResolved').payload.mode, 'advantage')
  const after = applied(state, result)
  assert.equal(after.mechanics.conditions.caster.some(entry => entry.id === 'true-strike'), false)
  assert.equal(after.mechanics.concentration.caster, undefined)
  assert.ok(result.events.some(event => event.event_type === 'ConcentrationEnded'))
})

test('атака другой цели не использует и не расходует Верный удар 2014', () => {
  const state = nextCasterTurn(trueStrike())
  state.enemies.push({ ...state.enemies[0], id: 'other', x: 1, y: 2 })
  const result = run(state, { command_type: 'MakeAttack', actor_id: 'caster', target_id: 'other', item_id: 'weapon' }, [15, 8])
  assert.equal(result.events.find(event => event.event_type === 'AttackResolved').payload.mode, 'normal')
  assert.equal(applied(state, result).mechanics.conditions.caster.some(entry => entry.id === 'true-strike'), true)
})

test('Верный удар 2014 может усиливать атаку заклинанием и исчезает после попытки', () => {
  const state = nextCasterTurn(trueStrike())
  const result = run(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fire-bolt', target_id: 'enemy', target_ids: ['enemy'] }, [3, 15, 4, 4, 4])
  assert.equal(result.events.find(event => event.event_type === 'AttackResolved').payload.mode, 'advantage')
  assert.equal(applied(state, result).mechanics.concentration.caster, undefined)
})

test('неиспользованный Верный удар 2014 истекает в конце следующего хода', () => {
  const state = nextCasterTurn(trueStrike())
  const result = run(state, { command_type: 'EndTurn', actor_id: 'caster' }, [])
  const after = applied(state, result)
  assert.equal(after.mechanics.conditions.caster.some(entry => entry.id === 'true-strike'), false)
  assert.equal(after.mechanics.concentration.caster, undefined)
})

test('Верный удар 2014 сохраняет цель и срок после replay и сериализации', () => {
  const initial = fixture()
  const castResult = run(initial, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'true-strike', target_id: 'enemy', target_ids: ['enemy'] }, [])
  const live = applied(initial, castResult)
  const replayed = normalizeCampaignState(JSON.parse(JSON.stringify(applied(initial, castResult))))
  assert.deepEqual(replayed.mechanics.conditions.caster, live.mechanics.conditions.caster)
  const state = nextCasterTurn(replayed)
  assert.equal(attackForecast(state, 'caster', 'enemy', { itemId: 'weapon' }).advantage, true)
})

test('Верный удар 2014 отвергает цель дальше 30 футов до оплаты действия', () => {
  const state = fixture({ enemyX: 8 })
  const before = structuredClone(state)
  assert.throws(() => trueStrike(state), error => error.code === 'TARGET_OUT_OF_RANGE')
  assert.deepEqual(state, before)
})

test('Защита от оружия 2014 сохраняется весь следующий ход и заканчивается в его конце', () => {
  const initial = fixture()
  const state = applied(initial, run(initial, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'blade-ward' }, []))
  const next = nextCasterTurn(state)
  assert.ok(next.mechanics.conditions.caster.some(entry => entry.id === 'blade-ward'))
  const final = applied(next, run(next, { command_type: 'EndTurn', actor_id: 'caster' }, []))
  assert.equal(final.mechanics.conditions.caster.some(entry => entry.id === 'blade-ward'), false)
})

test('эффекты Верного удара и Защиты от оружия 2014 истекают и вне боя', () => {
  for (const spellId of ['true-strike', 'blade-ward']) {
    const state = fixture()
    state.mechanics.combat.active = false
    const casted = applied(state, run(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: spellId,
      ...(spellId === 'true-strike' ? { target_id: 'enemy', target_ids: ['enemy'] } : {}) }, []))
    const result = run(casted, { command_type: 'AdvanceTime', actor_id: 'caster', amount: 6, unit: 'second' }, [])
    const final = applied(casted, result)
    assert.equal(final.mechanics.conditions.caster.some(entry => entry.spell_id === spellId), false, spellId)
    if (spellId === 'true-strike') assert.equal(final.mechanics.concentration.caster, undefined)
  }
})

test('проекция Верного удара скрывает ID цели, ушедшей из публичной сцены', () => {
  const state = trueStrike()
  state.actors = [{ id: 'hidden', name: 'Скрытый', kind: 'summon', visibility: 'gm_only', hp: 10, maxHp: 10, x: 2, y: 2 }]
  state.mechanics.conditions.caster[0].target_actor_id = 'hidden'
  const before = structuredClone(state)
  const user = { role: 'player', heroIds: ['caster'] }
  const view = campaignStateForViewer(state, user, 'caster')
  assert.equal(view.mechanics.conditions.caster[0].target_actor_id, undefined)
  assert.deepEqual(state, before)
  const events = [{ event_id: 'true-strike-condition', event_type: 'ConditionAdded', actor_id: 'caster',
    target_ids: ['caster'], payload: { spell_id: 'true-strike', condition: 'true-strike',
      true_strike_version: 1, source_actor: 'caster', target_actor_id: 'hidden' } }]
  assert.equal(mechanicsForViewer(events, user, 'caster', state)[0].payload.target_actor_id, undefined)
  assert.equal(events[0].payload.target_actor_id, 'hidden')
})

test('D&D 2014: возвышенность сама по себе не даёт преимущество или помеху выстрелу', () => {
  for (const higherActor of ['caster', 'enemy']) {
    const state = fixture({ weapon: 'shortbow', enemyX: 6,
      casterElevation: higherActor === 'caster' ? 10 : 0, enemyElevation: higherActor === 'enemy' ? 10 : 0 })
    const forecast = attackForecast(state, 'caster', 'enemy', { itemId: 'weapon' })
    assert.equal(forecast.advantage, false, higherActor)
    assert.equal(forecast.disadvantage, false, higherActor)
    const result = attack(state, [15, 4])
    const hit = result.events.find(event => event.event_type === 'AttackResolved')
    assert.equal(hit.payload.mode, 'normal', higherActor)
    assert.equal(hit.payload.high_ground, undefined, higherActor)
  }
})

test('D&D 2014: атака заклинанием с уступа тоже использует обычный d20', () => {
  const state = fixture({ enemyX: 6, casterElevation: 10 })
  const result = run(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fire-bolt',
    target_id: 'enemy', target_ids: ['enemy'] }, [15, 4, 4, 4])
  assert.equal(result.events.find(event => event.event_type === 'AttackResolved').payload.mode, 'normal')
})

function timedBuff(spellId, { casterClass = 'wizard', option = undefined, targetId = 'caster', slotLevel = undefined } = {}) {
  const initial = fixture()
  initial.mechanics.combat.active = targetId === 'enemy'
  initial.mechanics.world_time = { amount: 0, unit: 'minute', elapsed_minutes: 0, second_remainder: 39 }
  initial.players[0].characterClass = casterClass
  initial.players[0].knownSpellIds = [spellId]
  initial.players[0].preparedSpellIds = [spellId]
  let result = run(initial, { command_type: 'CastSpell', actor_id: 'caster', spell_id: spellId,
    target_id: targetId, target_ids: [targetId], ...(option ? { spell_option: option } : {}),
    ...(slotLevel ? { slot_level: slotLevel } : {}) }, [])
  let state = applied(initial, result)
  if (state.mechanics.combat.active) {
    const ended = run(state, { command_type: 'EndCombat', actor_id: 'caster' }, [])
    state = applied(state, ended)
    result = { ...result, events: [...result.events, ...ended.events] }
  }
  return { initial, result, state }
}
function advance(state, seconds) {
  return run(state, { command_type: 'AdvanceTime', actor_id: 'caster', amount: seconds, unit: 'second' }, [])
}

test('Наставление 2014 истекает ровно через 60 секунд вне боя и завершает концентрацию', () => {
  const { state } = timedBuff('guidance', { casterClass: 'cleric' })
  const almost = applied(state, advance(state, 59))
  assert.ok(almost.mechanics.conditions.caster.some(entry => entry.id === 'guidance-d4'))
  const result = advance(almost, 1)
  const expired = applied(almost, result)
  assert.equal(expired.mechanics.conditions.caster.some(entry => entry.id === 'guidance-d4'), false)
  assert.equal(expired.mechanics.concentration.caster, undefined)
  assert.equal(result.events.filter(event => event.event_type === 'ConcentrationEnded').length, 1)
})

test('Магические доспехи 2014 истекают через восемь часов, а не только через ходы боя', () => {
  const { state } = timedBuff('mage-armor')
  const almost = applied(state, advance(state, 28_799))
  assert.ok(almost.mechanics.conditions.caster.some(entry => entry.id === 'mage-armor'))
  const expired = applied(almost, advance(almost, 1))
  assert.equal(expired.mechanics.conditions.caster.some(entry => entry.id === 'mage-armor'), false)
})

test('длительности усилений 2014 учитывают минуту, десять минут и час по мировым часам', () => {
  for (const [id, seconds, options] of [
    ['mirror-image', 60, {}], ['fire-shield', 600, { option: 'warm' }], ['tenser-s-transformation', 600, {}],
    ['invisibility', 3_600, {}], ['enhance-ability', 3_600, { option: 'str' }],
    ['pass-without-trace', 3_600, { casterClass: 'druid' }],
  ]) {
    const { state } = timedBuff(id, options)
    const almost = applied(state, advance(state, seconds - 1))
    assert.ok(almost.mechanics.conditions.caster.some(entry => entry.spell_id === id), id)
    const expired = applied(almost, advance(almost, 1))
    assert.equal(expired.mechanics.conditions.caster.some(entry => entry.spell_id === id), false, id)
    assert.equal(expired.mechanics.concentration.caster, undefined, id)
  }
})

test('расход Наставления 2014 завершает концентрацию, не оставляя пустой эффект', () => {
  const { state } = timedBuff('guidance', { casterClass: 'cleric' })
  const result = run(state, { command_type: 'MakeAbilityCheck', actor_id: 'caster', ability: 'str', difficulty: 10 }, [3, 15])
  const final = applied(state, result)
  assert.equal(final.mechanics.conditions.caster.some(entry => entry.id === 'guidance-d4'), false)
  assert.equal(final.mechanics.concentration.caster, undefined)
})

test('секундный срок усиления 2014 сохраняется при replay и нормализации снимка', () => {
  const { initial, result, state } = timedBuff('invisibility')
  const replayed = normalizeCampaignState(JSON.parse(JSON.stringify(applied(initial, result))))
  assert.deepEqual(replayed.mechanics.conditions.caster, state.mechanics.conditions.caster)
  const expired = applied(replayed, advance(replayed, 3_600))
  assert.equal(expired.mechanics.conditions.caster.some(entry => entry.id === 'invisible'), false)
  assert.equal(expired.mechanics.concentration.caster, undefined)
})

test('повтор старого TimeAdvanced не меняет replay неверсированного концентрационного состояния', () => {
  const state = fixture()
  state.mechanics.conditions.caster = [{ id: 'invisible', duration: 'concentration', source_actor: 'caster', effect_id: 'legacy-invisibility', spell_id: 'invisibility' }]
  state.mechanics.concentration.caster = { effect_id: 'legacy-invisibility', spell_id: 'invisibility' }
  const after = applyGameEvent(state, { event_type: 'TimeAdvanced', event_id: 'legacy-time',
    target_ids: [], payload: { elapsed_minutes: 120 } })
  assert.ok(after.mechanics.conditions.caster.some(entry => entry.id === 'invisible'))
  assert.ok(after.mechanics.concentration.caster)
})

test('Метка охотника 2014 на ячейке третьего круга держится восемь часов', () => {
  const { state } = timedBuff('hunter-s-mark', { casterClass: 'ranger', targetId: 'enemy', slotLevel: 3 })
  // При завершении начатого раунда уже прошли 6 секунд времени мира.
  const almost = applied(state, advance(state, 28_793))
  assert.ok(almost.mechanics.conditions.enemy.some(entry => entry.id === 'hunters-mark:caster'))
  const expired = applied(almost, advance(almost, 1))
  assert.equal(expired.mechanics.conditions.enemy.some(entry => entry.id === 'hunters-mark:caster'), false)
  assert.equal(expired.mechanics.concentration.caster, undefined)
})

test('Сглаз 2014 из ячейки договора пятого круга держится сутки', () => {
  const { state } = timedBuff('hex', { casterClass: 'warlock', targetId: 'enemy', slotLevel: 5, option: 'str' })
  const almost = applied(state, advance(state, 86_393))
  assert.ok(almost.mechanics.conditions.enemy.some(entry => entry.id === 'hexed:caster'))
  const expired = applied(almost, advance(almost, 1))
  assert.equal(expired.mechanics.conditions.enemy.some(entry => entry.id === 'hexed:caster'), false)
  assert.equal(expired.mechanics.concentration.caster, undefined)
})

test('часовой срок Превращения 2014 возвращает исходный лист через общий cleanup концентрации', () => {
  const { initial, state } = timedBuff('polymorph')
  assert.equal(state.players[0].hp, 26)
  const expired = applied(state, advance(state, 3_600))
  assert.equal(expired.players[0].hp, initial.players[0].hp)
  assert.equal(expired.players[0].maxHp, initial.players[0].maxHp)
  assert.equal(expired.players[0].armor, initial.players[0].armor)
  assert.equal(expired.mechanics.shapes.caster, undefined)
  assert.equal(expired.mechanics.concentration.caster, undefined)
})

for (const actionId of ['grapple', 'shove']) {
  for (const [conditionId, expected] of [['enlarged', 'advantage'], ['reduced', 'disadvantage']]) {
    test(`${actionId}: ${conditionId} изменяет режим проверки Силы нападающего`, () => {
      const state = condition(fixture(), 'caster', conditionId)
      const result = run(state, { command_type: 'UseCombatAction', actor_id: 'caster', action_id: actionId, target_id: 'enemy' }, [2, 18, 12])
      const contest = result.events.find(event => event.event_type === 'ContestedCheckResolved').payload
      assert.equal(contest.attacker.mode, expected)
      assert.equal(contest.defender.mode, 'normal')
    })
  }
  test(`${actionId}: увеличение защищающегося влияет на Атлетику, но не на Акробатику`, () => {
    const strong = condition(fixture(), 'enemy', 'enlarged')
    const strengthResult = run(strong, { command_type: 'UseCombatAction', actor_id: 'caster', action_id: actionId, target_id: 'enemy' }, [12, 2, 18])
    assert.equal(strengthResult.events.find(event => event.event_type === 'ContestedCheckResolved').payload.defender.mode, 'advantage')
    const nimble = condition(fixture(), 'enemy', 'enlarged')
    nimble.enemies[0].abilities.dex = 18
    const dexterityResult = run(nimble, { command_type: 'UseCombatAction', actor_id: 'caster', action_id: actionId, target_id: 'enemy' }, [12, 18])
    assert.equal(dexterityResult.events.find(event => event.event_type === 'ContestedCheckResolved').payload.defender.mode, 'normal')
  })
}

test('увеличение и отравление взаимно отменяют режим в состязании захвата', () => {
  const state = condition(condition(fixture(), 'caster', 'enlarged'), 'caster', 'poisoned')
  const result = run(state, { command_type: 'UseCombatAction', actor_id: 'caster', action_id: 'grapple', target_id: 'enemy' }, [12, 12])
  assert.equal(result.events.find(event => event.event_type === 'ContestedCheckResolved').payload.attacker.mode, 'normal')
})

for (const [conditionId, mode] of [['enlarged', 'advantage'], ['reduced', 'disadvantage']]) {
  test(`выламывание двери учитывает ${conditionId} и не расходует проверку при предпросмотре`, () => {
    const map = createTacticalMap({ width: 12, height: 4, locationId: 'review-door', seed: 'review-door', sizeClass: 'arena' })
    for (let y = 0; y < 4; y++) for (let x = 0; x < 12; x++) setCell(map, x, y, { passable: true, material: 'stone', revealed: true })
    setDoor(map, { id: 'review-door', x: 1, y: 1, dir: 'e', state: 'locked', lockDc: 15 })
    const raw = fixture()
    raw.scene = { turn: 1, cells: legacyCellsFromTacticalMap(map), map: serializeTacticalMap(map) }
    const state = condition(normalizeCampaignState(raw), 'caster', conditionId)
    const before = structuredClone(state)
    const result = run(state, { command_type: 'OperateDoor', actor_id: 'caster', door_id: 'review-door', intent: 'force' }, [2, 18])
    assert.equal(result.events.find(event => event.event_type === 'AbilityCheckResolved').payload.mode, mode)
    assert.equal(result.events.find(event => event.event_type === 'DoorForced').payload.success, mode === 'advantage')
    assert.deepEqual(state, before)
  })
}

function frightened(wall = false) {
  const state = fixture({ enemyX: 8, walls: wall ? [4, 16, 28, 40] : [] })
  state.enemies.push({ ...state.enemies[0], id: 'near', x: 2, y: 1 })
  return condition(state, 'caster', 'frightened', 'enemy')
}

for (const [wall, mode] of [[false, 'disadvantage'], [true, 'normal']]) {
  test(`испуг: атака оружием и её прогноз ${wall ? 'не получают помеху за стеной' : 'получают помеху при линии обзора'}`, () => {
    const state = frightened(wall)
    const forecast = attackForecast(state, 'caster', 'near', { itemId: 'weapon' })
    assert.equal(forecast.disadvantage, !wall)
    const result = run(state, { command_type: 'MakeAttack', actor_id: 'caster', target_id: 'near', item_id: 'weapon' }, wall ? [15, 4] : [2, 15, 4])
    assert.equal(result.events.find(event => event.event_type === 'AttackResolved').payload.mode, mode)
  })
  test(`испуг: атака заклинанием ${wall ? 'не получает помеху за стеной' : 'получает помеху при линии обзора'}`, () => {
    const state = frightened(wall)
    const result = run(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fire-bolt', target_id: 'near', target_ids: ['near'] }, wall ? [15, 4, 4, 4] : [2, 15, 4, 4, 4])
    assert.equal(result.events.find(event => event.event_type === 'AttackResolved').payload.mode, mode)
  })
  test(`испуг: проверка характеристики ${wall ? 'не получает помеху за стеной' : 'получает помеху при линии обзора'}`, () => {
    const state = frightened(wall)
    const result = run(state, { command_type: 'MakeAbilityCheck', actor_id: 'caster', ability: 'int', difficulty: 12 }, wall ? [15] : [2, 15])
    assert.equal(result.events.find(event => event.event_type === 'AbilityCheckResolved').payload.mode, mode)
  })
}

test('испуг не позволяет добровольно приближаться к источнику даже за стеной', () => {
  const state = frightened(true)
  assert.throws(() => run(state, { command_type: 'MoveActor', actor_id: 'caster', to: { x: 2, y: 2 } }, []), error => error.code === 'FRIGHTENED_CLOSER')
})

test('помеха испуга сохраняется, если хотя бы один из независимых источников виден', () => {
  const state = frightened(true)
  state.mechanics.conditions.caster.push({ id: 'frightened', source_actor: 'near', effect_id: 'another-fear' })
  const result = run(state, { command_type: 'MakeAbilityCheck', actor_id: 'caster', ability: 'int', difficulty: 12 }, [2, 15])
  assert.equal(result.events.find(event => event.event_type === 'AbilityCheckResolved').payload.mode, 'disadvantage')
})

test('Ужас разрешает повторный спасбросок лишь вне линии обзора источника', () => {
  for (const wall of [false, true]) {
    const state = frightened(wall)
    Object.assign(state.mechanics.conditions.caster[0], { spell_id: 'fear', repeat_save_timing: 'turn-end', save_ability: 'wis', save_dc: 15, repeat_save_ends_concentration: false })
    const result = run(state, { command_type: 'EndTurn', actor_id: 'caster' }, wall ? [18] : [])
    assert.equal(result.events.some(event => event.event_type === 'SpellSavingThrowResolved' && event.payload.spell_id === 'fear'), wall)
    assert.equal(applied(state, result).mechanics.conditions.caster.some(entry => entry.id === 'frightened'), !wall)
  }
})

function dispelFixture({ targetSlot = 4, versioned = true } = {}) {
  const raw = fixture()
  raw.players[0].knownSpellIds.push('dispel-magic', 'web')
  raw.players[0].preparedSpellIds.push('dispel-magic', 'web')
  raw.mechanics.active_effects = [{ id: 'review-magic', effect_id: 'review-magic', spell_id: 'web', source_actor: 'enemy', center: { x: 4, y: 1 }, radius_feet: 5, area_shape: 'sphere', expires_round: 100,
    ...(versioned ? { spell_level_version: 1, slot_level: targetSlot } : {}) }]
  return normalizeCampaignState(raw)
}
const dispel = (state, values, slot = 3) => run(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'dispel-magic', slot_level: slot, to: { x: 4, y: 1 } }, values)

test('Рассеивание магии 2014 использует характеристику без бонуса мастерства', () => {
  const state = dispelFixture()
  const result = dispel(state, [10])
  const check = result.events.find(event => event.event_type === 'AbilityCheckResolved').payload
  assert.equal(check.modifier, 3)
  assert.equal(check.difficulty, 14)
  assert.equal(check.total, 13)
  assert.equal(check.success, false)
  assert.ok(applied(state, result).mechanics.active_effects.some(effect => effect.id === 'review-magic'))
})

test('Рассеивание магии учитывает усиление характеристики и уровень ячейки эффекта', () => {
  const state = condition(dispelFixture({ targetSlot: 6 }), 'caster', 'enhanced-int')
  const result = dispel(state, [2, 15])
  const check = result.events.find(event => event.event_type === 'AbilityCheckResolved').payload
  assert.equal(check.mode, 'advantage')
  assert.equal(check.difficulty, 16)
  assert.equal(check.success, true)
  assert.equal(applied(state, result).mechanics.active_effects.length, 0)
  const automatic = dispel(state, [], 6)
  assert.equal(automatic.events.some(event => event.event_type === 'AbilityCheckResolved'), false)
  assert.equal(applied(state, automatic).mechanics.active_effects.length, 0)
})

test('новая область хранит ячейку после replay; старая без версии использует базовый круг', () => {
  const state = dispelFixture()
  const result = run(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'web', slot_level: 6, to: { x: 4, y: 1 } }, [])
  const area = result.events.find(event => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(area.spell_level_version, 1)
  assert.equal(area.slot_level, 6)
  const replayed = normalizeCampaignState(JSON.parse(JSON.stringify(applied(state, result))))
  assert.equal(replayed.mechanics.active_effects.find(effect => effect.id === area.id).slot_level, 6)
  const old = dispel(dispelFixture({ versioned: false }), [])
  assert.equal(old.events.some(event => event.event_type === 'AbilityCheckResolved'), false)
})

function timedDebuff(spellId, { spellOption, slotLevel, creatureType = 'humanoid' } = {}) {
  const raw = fixture()
  raw.players[0].knownSpellIds = [spellId]
  raw.players[0].preparedSpellIds = [spellId]
  raw.enemies[0].creatureType = creatureType
  if (spellId === 'dominate-beast') raw.players[0].characterClass = 'sorcerer'
  const initial = normalizeCampaignState(raw)
  const command = { command_type: 'CastSpell', actor_id: 'caster', spell_id: spellId, target_id: 'enemy', target_ids: ['enemy'],
    ...(spellOption ? { spell_option: spellOption } : {}), ...(slotLevel ? { slot_level: slotLevel } : {}) }
  const result = run(initial, command, [2, 2, 2, 2, 2, 2])
  const casted = applied(initial, result)
  const ended = applied(casted, run(casted, { command_type: 'EndCombat', actor_id: 'caster' }, []))
  return { state: ended, result }
}

for (const [id, conditionId, duration] of [['blindness-deafness', 'blinded', 60], ['hold-monster', 'paralyzed', 60], ['enlarge-reduce', 'enlarged', 60], ['charm-person', 'charmed', 3600]]) {
  test(`${id}: срок состояния истекает по мировым часам после завершения боя`, () => {
    const { state, result } = timedDebuff(id, { spellOption: id === 'blindness-deafness' ? 'blinded' : id === 'enlarge-reduce' ? 'enlarge' : undefined })
    const added = result.events.find(event => event.event_type === 'ConditionAdded' && event.payload.condition === conditionId)
    assert.ok(added, 'заклинание действительно наложило состояние')
    assert.equal(added.payload.expires_at_seconds - added.payload.started_at_seconds, duration)
    const almost = applied(state, advance(state, duration - 7))
    assert.ok(almost.mechanics.conditions.enemy.some(entry => entry.id === conditionId))
    const expired = applied(almost, advance(almost, 1))
    assert.equal(expired.mechanics.conditions.enemy.some(entry => entry.id === conditionId), false)
    if (id !== 'blindness-deafness' && id !== 'charm-person') assert.equal(expired.mechanics.concentration.caster, undefined)
  })
}

test('Сон истекает через минуту вне боя и не оставляет независимое бессознательное состояние', () => {
  const raw = fixture({ enemyX: 6 })
  raw.players[0].knownSpellIds = ['sleep']
  raw.players[0].preparedSpellIds = ['sleep']
  raw.enemies[0].hp = 10
  const initial = normalizeCampaignState(raw)
  const result = run(initial, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'sleep', to: { x: 6, y: 1 } }, [8, 8, 8, 8, 8])
  const casted = applied(initial, result)
  assert.ok(casted.mechanics.conditions.enemy.some(entry => entry.id === 'magical-sleep'))
  const state = applied(casted, run(casted, { command_type: 'EndCombat', actor_id: 'caster' }, []))
  const expired = applied(state, advance(state, 54))
  assert.equal(expired.mechanics.conditions.enemy.some(entry => ['magical-sleep', 'unconscious'].includes(entry.id)), false)
})

for (const [id, slot, seconds, creatureType] of [['dominate-beast', 5, 600, 'beast'], ['dominate-beast', 6, 3600, 'beast'], ['dominate-person', 6, 600, 'humanoid']]) {
  test(`${id}: ячейка ${slot} сохраняет очарование ${seconds} секунд`, () => {
    const { state, result } = timedDebuff(id, { slotLevel: slot, creatureType })
    const added = result.events.find(event => event.event_type === 'ConditionAdded' && event.payload.condition === 'charmed')
    assert.equal(added.payload.expires_at_seconds - added.payload.started_at_seconds, seconds)
    assert.ok(applied(state, advance(state, seconds - 7)).mechanics.conditions.enemy.some(entry => entry.id === 'charmed'))
    assert.equal(applied(state, advance(state, seconds - 6)).mechanics.concentration.caster, undefined)
  })
}

test('Продлённое заклинание удваивает новый срок состояния и усиления, ограничивая его сутками', () => {
  for (const [id, seconds] of [['hold-monster', 120], ['invisibility', 7200], ['mass-suggestion', 86400]]) {
    const raw = fixture()
    raw.players[0].characterClass = 'sorcerer'
    raw.players[0].knownSpellIds = [id]
    raw.players[0].preparedSpellIds = [id]
    const state = condition(normalizeCampaignState(raw), 'caster', 'metamagic-extended')
    const targetId = id === 'invisibility' ? 'caster' : 'enemy'
    const result = run(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: id, target_id: targetId, target_ids: [targetId] }, [2, 2, 2, 2])
    const added = result.events.find(event => event.event_type === 'ConditionAdded' && event.payload.expiry_policy === 'dnd2014-timed-buff/v1')
    assert.ok(added, id)
    assert.equal(added.payload.expires_at_seconds - added.payload.started_at_seconds, seconds, id)
  }
})

function hexFixture(ability = 'str') {
  const raw = fixture()
  raw.players[0].characterClass = 'warlock'
  raw.players[0].knownSpellIds = ['hex', 'eldritch-blast']
  raw.players[0].preparedSpellIds = []
  const state = normalizeCampaignState(raw)
  const command = { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'hex', target_id: 'enemy', target_ids: ['enemy'], ...(ability ? { spell_option: ability } : {}) }
  return { state, command }
}

test('Сглаз требует выбор характеристики до расхода бонусного действия и ячейки', () => {
  const { state, command } = hexFixture(null)
  const before = structuredClone(state)
  assert.throws(() => run(state, command, []), error => error.code === 'SPELL_OPTION_REQUIRED' || error.code === 'INVALID_SPELL_OPTION')
  assert.deepEqual(state, before)
})

test('Сглаз ухудшает только выбранную проверку, не спасбросок, и сохраняет выбор после replay', () => {
  const { state, command } = hexFixture('str')
  const casted = normalizeCampaignState(JSON.parse(JSON.stringify(applied(state, run(state, command, [])))))
  assert.equal(casted.mechanics.conditions.enemy.find(entry => entry.id === 'hexed:caster').spell_option, 'str')
  const str = run(casted, { command_type: 'MakeAbilityCheck', actor_id: 'enemy', ability: 'str', difficulty: 10 }, [2, 18])
  assert.equal(str.events.find(event => event.event_type === 'AbilityCheckResolved').payload.mode, 'disadvantage')
  const dex = run(casted, { command_type: 'MakeAbilityCheck', actor_id: 'enemy', ability: 'dex', difficulty: 10 }, [18])
  assert.equal(dex.events.find(event => event.event_type === 'AbilityCheckResolved').payload.mode, 'normal')
  const save = run(casted, { command_type: 'MakeSavingThrow', actor_id: 'enemy', ability: 'str', difficulty: 10 }, [18])
  assert.equal(save.events.find(event => event.event_type === 'SavingThrowResolved').payload.mode, 'normal')
})

test('Сглаз участвует в защите Атлетикой при захвате', () => {
  const { state, command } = hexFixture('str')
  const casted = applied(state, run(state, command, []))
  const result = run(casted, { command_type: 'UseCombatAction', actor_id: 'caster', action_id: 'grapple', target_id: 'enemy' }, [12, 2, 18])
  assert.equal(result.events.find(event => event.event_type === 'ContestedCheckResolved').payload.defender.mode, 'disadvantage')
})

for (const actionId of ['grapple', 'shove']) {
  test(`${actionId}: недееспособная цель 2014 проигрывает без бросков`, () => {
    const state = condition(fixture(), 'enemy', 'paralyzed')
    const result = run(state, { command_type: 'UseCombatAction', actor_id: 'caster', action_id: actionId, target_id: 'enemy' }, [])
    const contest = result.events.find(event => event.event_type === 'ContestedCheckResolved').payload
    assert.equal(contest.automatic_success, true)
    assert.equal(contest.attacker, null)
    assert.equal(contest.defender, null)
    assert.equal(result.rolls.length, 0)
    assert.ok(applied(state, result).mechanics.conditions.enemy.some(entry => entry.id === (actionId === 'shove' ? 'prone' : 'grappled')))
  })
}

test('сбитая толчком цель 2014 остаётся ничком в начале хода до явного вставания', () => {
  const state = fixture()
  const shoved = applied(state, run(state, { command_type: 'UseCombatAction', actor_id: 'caster', action_id: 'shove', target_id: 'enemy' }, [18, 2]))
  const ending = applied(shoved, run(shoved, { command_type: 'EndTurn', actor_id: 'caster' }, []))
  assert.ok(ending.mechanics.conditions.enemy.some(entry => entry.id === 'prone'))
  const stood = applied(ending, run(ending, { command_type: 'UseCombatAction', actor_id: 'enemy', action_id: 'stand-up' }, []))
  assert.equal(stood.mechanics.conditions.enemy.some(entry => entry.id === 'prone'), false)
  assert.equal(stood.mechanics.combat.action_economy.enemy.movement_spent, 15)
})

test('движение при испуге проверяет каждый источник страха, а не только первый', () => {
  const state = frightened(true)
  state.enemies.push({ ...state.enemies[0], id: 'south-fear', x: 1, y: 3 })
  state.mechanics.conditions.caster.push({ id: 'frightened', source_actor: 'south-fear', effect_id: 'south-fear-effect' })
  assert.throws(() => run(state, { command_type: 'MoveActor', actor_id: 'caster', to: { x: 1, y: 2 } }, []), error => error.code === 'FRIGHTENED_CLOSER')
})

test('Воображаемый убийца пугает образом: стена перед заклинателем не снимает помеху', () => {
  const state = frightened(true)
  state.mechanics.conditions.caster[0].spell_id = 'phantasmal-killer'
  const result = run(state, { command_type: 'MakeAbilityCheck', actor_id: 'caster', ability: 'int', difficulty: 10 }, [2, 18])
  assert.equal(result.events.find(event => event.event_type === 'AbilityCheckResolved').payload.mode, 'disadvantage')
  assert.equal(attackForecast(state, 'caster', 'near', { itemId: 'weapon' }).disadvantage, true)
})

test('Воображаемый убийца не подменяет источник кошмара позицией заклинателя', () => {
  const state = frightened(true)
  state.mechanics.conditions.caster[0].spell_id = 'phantasmal-killer'
  const result = run(state, { command_type: 'MoveActor', actor_id: 'caster', to: { x: 2, y: 2 } }, [])
  assert.ok(result.events.some(event => event.event_type === 'ActorMoved'))
})

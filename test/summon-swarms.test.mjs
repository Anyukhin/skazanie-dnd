import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `sw-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function field({ casterClass = 'druid', level = 12, width = 16, height = 6, casterAt = { x: 1, y: 2 }, foeAt = { x: 14, y: 2 } } = {}) {
  const cells = Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SW-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 60, maxHp: 60, armor: 14, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 16 }, inventory: [], x: casterAt.x, y: casterAt.y }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 90, maxHp: 90, armor: 12, speed: 30, abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { mage: Object.fromEntries([1, 2, 3, 4, 5, 6].map((slot) => [`spell_slots_${slot}`, { current: 3, max: 3 }])) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: Object.fromEntries(['mage', 'brute'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

const summonAt = (state, spellId, to = { x: 7, y: 2 }, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: spellId, to, ...extra }),
  state,
  options(dice()),
)
const created = (result) => result.events.filter((event) => event.event_type === 'SummonedCreatureCreated').map((event) => event.payload.summon)

test('Призыв животных ставит восемь отдельных фишек', () => {
  const result = summonAt(field(), 'conjure-animals')
  const beasts = created(result)
  assert.equal(beasts.length, 8, 'вся стая, а не одна фишка с умноженным уроном')

  // Каждая — самостоятельное существо: свои хиты и своя клетка.
  assert.equal(new Set(beasts.map((beast) => beast.id)).size, 8, 'идентификаторы не совпадают')
  assert.equal(new Set(beasts.map((beast) => `${beast.x}:${beast.y}`)).size, 8, 'никто не стоит друг на друге')
  assert.equal(beasts.every((beast) => beast.hp === 7 && beast.maxHp === 7), true)
  assert.equal(beasts.every((beast) => beast.attack_profile.damage_expression === '1d6+2'), true)
})

test('вся стая встаёт в очередь сразу за призвавшим', () => {
  const state = field()
  const after = replayEvents(state, summonAt(state, 'conjure-animals').events)
  const order = after.mechanics.combat.initiative.map((entry) => String(entry.actor_id))
  assert.equal(order[0], 'mage')
  assert.equal(order.slice(1, 9).every((id) => id.startsWith('summon-mage-')), true, 'восемь духов идут подряд после хозяина')
  assert.equal(order.at(-1), 'brute', 'враг остался последним')
  assert.equal(after.actors.filter((actor) => actor.kind === 'summon').length, 8)
})

test('в тесноте встаёт столько, сколько поместилось', () => {
  // Каморка 2×3: шесть клеток, две заняты живыми — на восьмерых места нет.
  const cramped = field({ width: 2, height: 3, casterAt: { x: 1, y: 2 }, foeAt: { x: 0, y: 0 } })
  const beasts = created(summonAt(cramped, 'conjure-animals', { x: 1, y: 1 }))
  assert.ok(beasts.length > 0 && beasts.length < 8, `в тесноте помещается меньше стаи, получено ${beasts.length}`)
  assert.equal(beasts.some((beast) => beast.x === 1 && beast.y === 2), false, 'на заклинателя никто не встал')
  assert.equal(beasts.some((beast) => beast.x === 0 && beast.y === 0), false, 'и на врага тоже')
})

test('ячейка выше добавляет призванных, где это по правилу', () => {
  const base = created(summonAt(field({ casterClass: 'warlock' }), 'summon-lesser-demons')).length
  const upcast = created(summonAt(field({ casterClass: 'warlock' }), 'summon-lesser-demons', { x: 7, y: 2 }, { slot_level: 5 })).length
  assert.equal(base, 4)
  assert.equal(upcast, 8, 'две ячейки сверх третьей дают четырёх лишних')
})

test('одиночные призывы остались одиночными', () => {
  assert.equal(created(summonAt(field({ casterClass: 'warlock' }), 'summon-greater-demon')).length, 1)
  assert.equal(created(summonAt(field({ casterClass: 'cleric' }), 'spiritual-weapon')).length, 1, 'старый одиночный призыв не размножился')
})

test('призывы с накладыванием в минуту в бою недоступны', () => {
  // Правило проекта: не объявляем исполняемым то, чего нельзя применить в бою.
  // Стихийный элементаль, феи и поднятие нежити творятся минуту — их нет.
  for (const spellId of ['conjure-elemental', 'conjure-fey', 'animate-dead', 'conjure-minor-elementals', 'flock-of-familiars']) {
    // Заблокированы боевым правилом о длинном накладывании, непроверенной
    // механикой или недоступностью герою. С 2026-07-27 длинное накладывание
    // отвечает первым и только про бой: вне боя такие заклинания разрешены
    // (см. test/out-of-combat-casting.test.mjs), в бою — нет.
    assert.throws(() => summonAt(field({ casterClass: 'wizard' }), spellId), (error) => ['SPELL_CAST_TIME_TOO_LONG', 'MECHANICS_NOT_VERIFIED', 'SPELL_NOT_AVAILABLE'].includes(error.code), `${spellId} не должен быть исполняемым`)
  }
})

test('Оживление предметов поднимает десяток', () => {
  const objects = created(summonAt(field({ casterClass: 'bard' }), 'animate-objects'))
  assert.equal(objects.length, 10)
  assert.equal(objects.every((object) => object.armor === 18), true)
})

test('призванные исчезают вместе с концентрацией', () => {
  const state = field()
  const summoned = replayEvents(state, summonAt(state, 'conjure-animals').events)
  assert.equal(summoned.actors.filter((actor) => actor.kind === 'summon').length, 8)

  const ended = resolveCommand(
    authoritative({ command_type: 'EndConcentration', actor_id: 'mage' }),
    summoned,
    options(dice()),
  )
  const after = replayEvents(summoned, ended.events)
  assert.equal(after.actors.filter((actor) => actor.kind === 'summon').length, 0, 'стая ушла целиком')
})

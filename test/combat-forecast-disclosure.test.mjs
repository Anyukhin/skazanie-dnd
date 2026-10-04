import test from 'node:test'
import assert from 'node:assert/strict'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { withCombatForecast } from '../server/combat-forecast-view.mjs'

// Скрытая КД и публичный прогноз (U01 из исследования PR #136). До правки две
// одинаковые проекции врага давали 65% и 40% при скрытой КД 13 и 18, а знание
// одних хитов открывало в прогнозе точную КД.

function fixture(armor, knowledge = {}) {
  return normalizeCampaignState({
    partyMemberIds: ['hero', 'ally'],
    players: [
      { id: 'hero', character: 'Герой', hp: 12, maxHp: 12, armor: 14,
        proficiency: 2, abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 8 },
        x: 0, y: 0, inventory: [
          { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
            combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } },
        ] },
      { id: 'ally', character: 'Союзник', hp: 12, maxHp: 12, armor: 14,
        proficiency: 2, abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 8 },
        x: 0, y: 1, inventory: [] },
    ],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 10, maxHp: 10, armor, alive: true, x: 1, y: 0 }],
    scene: { turn: 1, cells: [
      { x: 0, y: 0, type: 'floor', revealed: true },
      { x: 1, y: 0, type: 'floor', revealed: true },
      { x: 0, y: 1, type: 'floor', revealed: true },
    ] },
    mechanics: { enemy_knowledge: knowledge, combat: {
      active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }],
      action_economy: { hero: { action: true } },
    } },
  })
}

// Тот же путь, что `viewerStateFor` в server/index.mjs для room GET и SSE.
const viewerState = (state, actor = 'hero') =>
  withCombatForecast(campaignStateForViewer(state, { role: 'player', id: actor }, actor), state, actor)

const swordShot = (state, actor = 'hero') =>
  viewerState(state, actor).combatForecast.targets.goblin.find((entry) => entry.item_id === 'sword')

const paralyze = (state) => applyGameEvent(state, { event_id: 'condition:goblin:paralyzed',
  event_type: 'ConditionAdded', actor_id: 'ally', target_ids: ['goblin'],
  payload: { condition: 'paralyzed', source_actor: 'ally' } })

test('при скрытой КД прогноз не зависит от неё: КД 13 и 18 дают одинаковую выдачу', () => {
  const low = fixture(13)
  const high = fixture(18)
  for (const actor of ['hero', 'ally']) {
    assert.deepEqual(viewerState(low, actor), viewerState(high, actor), `зритель ${actor}`)
  }
  const shot = swordShot(high)
  assert.equal(shot.armor_class, null)
  assert.equal(shot.hit_chance, null)
  assert.equal(shot.armor_known, false)
  // Натуральная 20 попадает при любой КД — этот шанс ничего не выдаёт.
  assert.equal(shot.critical_chance, 5)
  // Публичное остаётся: дальность, бонус атаки, досягаемость, урон.
  assert.equal(shot.in_range, true)
  assert.equal(shot.distance_feet, 5)
  assert.equal(shot.attack_modifier, 5)
  assert.equal(shot.average_damage, 8)
})

test('знание одних хитов КД в прогнозе не открывает', () => {
  const state = fixture(18, { party: { goblin: { health: 'exact' } } })
  const view = viewerState(state)
  assert.equal(view.enemies[0].healthKnown, 'exact')
  assert.equal(Object.hasOwn(view.enemies[0], 'armor'), false)
  const shot = swordShot(state)
  assert.equal(shot.armor_class, null)
  assert.equal(shot.hit_chance, null)
})

test('известная отряду КД открывает и КД, и шанс попасть — герою и союзнику', () => {
  const low = fixture(13, { party: { goblin: { armor_class: 'exact' } } })
  const high = fixture(18, { party: { goblin: { armor_class: 'exact' } } })
  for (const actor of ['hero', 'ally']) {
    assert.equal(viewerState(high, actor).enemies[0].armor, 18)
    assert.deepEqual(
      { ac: swordShot(low, actor).armor_class, hit: swordShot(low, actor).hit_chance, known: swordShot(low, actor).armor_known },
      { ac: 13, hit: 65, known: true },
    )
    assert.deepEqual(
      { ac: swordShot(high, actor).armor_class, hit: swordShot(high, actor).hit_chance },
      { ac: 18, hit: 40 },
    )
  }
})

test('гарантированный крит в упор при скрытой КД прячет и шанс крита', () => {
  const low = paralyze(fixture(13))
  const high = paralyze(fixture(18))
  assert.deepEqual(viewerState(low), viewerState(high))
  const shot = swordShot(high)
  assert.equal(shot.critical_on_hit, true)
  assert.equal(shot.hit_chance, null)
  assert.equal(shot.critical_chance, null)
  assert.equal(shot.advantage, true, 'преимущество по парализованному — видимый факт и остаётся')

  const known = paralyze(fixture(18, { party: { goblin: { armor_class: 'exact' } } }))
  const open = swordShot(known)
  assert.equal(open.critical_on_hit, true)
  assert.equal(open.critical_chance, open.hit_chance)
  assert.ok(open.hit_chance > 40, 'с преимуществом шанс выше, чем без него')
})

test('вне боя и для чужого хода прогноз не выдаётся', () => {
  const state = fixture(13)
  const idle = { ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active: false } } }
  assert.equal(viewerState(idle).combatForecast, undefined)
  const goblinTurn = { ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } }
  assert.equal(viewerState(goblinTurn).combatForecast, undefined)
})

test('ведущий видит стат-блок целиком, поэтому и КД, и шанс попасть', () => {
  const state = fixture(18)
  const view = withCombatForecast(campaignStateForViewer(state, { role: 'admin', id: 'gm' }, ''), state, '')
  const shot = view.combatForecast.targets.goblin.find((entry) => entry.item_id === 'sword')
  assert.deepEqual({ ac: shot.armor_class, hit: shot.hit_chance, known: shot.armor_known }, { ac: 18, hit: 40, known: true })
})

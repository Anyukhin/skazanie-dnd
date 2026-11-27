import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { Adjudicator } from '../server/adjudicator.mjs'
import { applyGameEvent, defaultAttackItemIdFor, normalizeCampaignState, previewApproachAttack, resolveCommand } from '../server/rules-engine.mjs'
import { STARTER_KIT_2024_POLICY, withStarterKit } from '../server/starter-kit.mjs'

// HTTP-прогон боёв 2026-10-04: плут с коротким мечом в руке «подбегал и бил»
// на 0 урона. Свободная заявка строила атаку без оружия, и движок честно
// считал безоружный удар — 1 + модификатор Силы, у плута с Силой 8 это ноль.

function arena({ enemyAt = { x: 4, y: 1 } } = {}) {
  const rogue = withStarterKit({ id: 'rogue', character: 'Плут', characterClass: 'rogue', level: 3, hp: 24, maxHp: 24, abilities: { str: 8, dex: 16, con: 14, int: 13, wis: 10, cha: 12 }, inventory: [], currency: {}, x: 1, y: 1 },
    { rulesetId: 'srd_5_2_1', starterPolicyId: STARTER_KIT_2024_POLICY.policy_id })
  const cells = []
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 12; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  return normalizeCampaignState({
    sessionCode: 'FREE-ATTACK', ruleset_id: 'srd_5_2_1', partyMemberIds: ['rogue'], players: [rogue],
    enemies: [{ id: 'wolf', name: 'Волк', hp: 30, maxHp: 30, armor: 5, speed: 40, ...enemyAt, alive: true }],
    scene: { cells },
    mechanics: { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'rogue', total: 18 }, { actor_id: 'wolf', total: 5 }],
      action_economy: { rogue: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
  })
}
const sword = (state) => state.players[0].inventory.find((item) => item.catalog_id === 'srd_5_2_1:shortsword').id
const bow = (state) => state.players[0].inventory.find((item) => item.catalog_id === 'srd_5_2_1:shortbow').id
const dice = () => new DiceService({ rng: { randint: (min, max) => max } })

test('«подбегаю и бью» бьёт надетым коротким мечом, а не голой рукой', () => {
  const state = arena()
  const route = previewApproachAttack(state, 'rogue', 'wolf')
  const attack = route.commands.at(-1)
  assert.equal(attack.item_id, sword(state))
  let live = state
  for (const command of route.commands) {
    const result = resolveCommand({ ...command, command_id: `free-${command.command_type}` }, live, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
    if (command.command_type === 'MakeAttack') {
      const damage = result.events.find((event) => event.event_type === 'DamageApplied')
      assert.ok(damage.payload.applied_amount > 0, 'удар мечом наносит урон')
    }
    live = result.events.reduce(applyGameEvent, live)
  }
})

test('удар с места: вплотную — ближнее оружие, вдали — надетый лук', () => {
  const adjacent = arena({ enemyAt: { x: 2, y: 1 } })
  assert.equal(defaultAttackItemIdFor(adjacent, 'rogue', 'wolf'), sword(adjacent))
  const far = arena({ enemyAt: { x: 9, y: 1 } })
  assert.equal(defaultAttackItemIdFor(far, 'rogue', 'wolf'), null, 'лук не надет — удара с места нет')
  far.players[0].inventory = far.players[0].inventory.map((item) => item.id === bow(far) ? { ...item, equipped: true } : item.id === sword(far) ? { ...item, equipped: false } : item)
  assert.equal(defaultAttackItemIdFor(far, 'rogue', 'wolf'), bow(far))
})

test('судья действий предлагает атаку надетым оружием', async () => {
  const state = arena({ enemyAt: { x: 2, y: 1 } })
  const plan = await new Adjudicator().createPlan({ intent: { intent: 'attack', actor_id: 'rogue', targets: ['wolf'], raw_message: 'бью волка' }, state, retrievedRules: null })
  assert.equal(plan.proposed_commands[0].command_type, 'MakeAttack')
  assert.equal(plan.proposed_commands[0].item_id, sword(state))
})

test('безоружный удар героя — дробящий урон', () => {
  const state = arena({ enemyAt: { x: 2, y: 1 } })
  const result = resolveCommand({ command_type: 'MakeAttack', actor_id: 'rogue', target_id: 'wolf', command_id: 'unarmed', server_authoritative: true }, state, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage?.payload?.damage_type, 'bludgeoning')
})

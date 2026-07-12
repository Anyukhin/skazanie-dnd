import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { Narrator } from '../server/narrator.mjs'
import { RULE_IDS, RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { FileTraceStore } from '../server/trace-store.mjs'

function sequenceFactory(prefix) {
  let value = 0
  return () => `${prefix}-${++value}`
}

test('полный enforce-flow воспроизводит исследование, social ruling, проверки, бой, магию, отдых, replay и /why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-flow-'))
  const eventRoot = join(root, 'engine')
  const traceRoot = join(root, 'traces')
  const initial = normalizeCampaignState({
    sessionCode: 'FLOW-1', activePlayerId: 'hero', campaign: 'Integration flow',
    scene: { title: 'Зал', objective: 'Исследовать руины', cells: [{ x: 0, y: 0, revealed: false }, { x: 1, y: 0, revealed: false }] },
    players: [
      { id: 'hero', character: 'Ада', hp: 7, maxHp: 10, armor: 14, proficiency: 2, abilities: { str: 16, dex: 14, con: 12, int: 12, wis: 12, cha: 12 }, inventory: [] },
      { id: 'goblin', character: 'Гоблин', hp: 8, maxHp: 8, armor: 12, proficiency: 2, abilities: { str: 8, dex: 12, con: 10, int: 8, wis: 8, cha: 8 }, inventory: [] },
    ],
    mechanics: { resources: { hero: { spell_slots: { current: 2, max: 2 } } } },
  })
  const eventStore = new FileEventStore({
    rootDir: eventRoot,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotEvery: 3,
    idFactory: sequenceFactory('commit'),
  })
  const traceStore = new FileTraceStore({ rootDir: traceRoot })
  const diceService = new DiceService({
    rng: new SequenceDiceRng([12, 11, 18, 5, 15, 4]),
    idFactory: sequenceFactory('roll'),
    now: () => '2026-07-11T00:00:00.000Z',
  })
  const orchestrator = new GameOrchestrator({
    modeResolver: () => 'enforce',
    rulesEngine: new RulesEngine({ diceService }),
    eventStore,
    traceStore,
    narrator: new Narrator(),
    idFactory: sequenceFactory('turn'),
  })

  let step = 0
  const run = async (message, command) => orchestrator.handle({
    state: initial,
    playerId: 'hero',
    message,
    commands: [command],
    idempotencyKey: `flow-${++step}`,
    allowedActorIds: ['hero'],
  })

  await run('Исследую комнату', { command_type: 'RevealArea', actor_id: 'hero', cells: [{ x: 0, y: 0 }] })
  await run('Перехожу к двери', { command_type: 'MoveActor', actor_id: 'hero', from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, distance: 5, ruling_id: 'ruling-movement-1' })
  await run('Договариваюсь со стражем', {
    command_type: 'RecordRuling', actor_id: 'hero', ruling_id: 'ruling-social-1',
    ruling: { id: 'ruling-social-1', campaign_id: 'FLOW-1', question: 'Страж пропускает отряд?', selected_interpretation: 'Да, после обещания вернуться.', rationale: 'Временное решение сцены.', supporting_rule_ids: [], scope: 'single_event', approved_by_owner: false, overrides_rule_ids: [] },
  })
  await run('Проверяю дверь', { command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'str', difficulty: 14, source_rule_ids: [RULE_IDS.abilityCheck] })
  await run('Спасбросок от ловушки', { command_type: 'MakeSavingThrow', actor_id: 'hero', ability: 'dex', difficulty: 12, source_rule_ids: [RULE_IDS.savingThrow] })
  await run('Поддерживаю заклинание', { command_type: 'CastSpell', actor_id: 'hero', target_id: 'goblin', name: 'Опутывание', spell_id: 'spell:entangle', resource: 'spell_slots', cost: 1, max: 2, concentration: true, source_rule_ids: [RULE_IDS.concentration] })
  await run('Начинаем бой', { command_type: 'StartCombat', actor_id: 'hero', participant_ids: ['hero', 'goblin'], source_rule_ids: [RULE_IDS.initiative] })
  const attack = await run('Атакую гоблина', { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', attack_modifier: 5, damage_expression: '1d6', damage_type: 'slashing', source_rule_ids: [RULE_IDS.attack, RULE_IDS.damage] })
  assert.equal(attack.authoritative_state.players.find((actor) => actor.id === 'goblin').hp, 4)
  await run('Лечу рану', { command_type: 'ApplyHealing', actor_id: 'hero', amount: 3, source_rule_ids: [RULE_IDS.healing] })
  const condition = await run('Гоблин отравлен', { command_type: 'AddCondition', actor_id: 'hero', target_id: 'goblin', condition: 'poisoned', source_rule_ids: [RULE_IDS.conditions] })

  const why = await orchestrator.handle({ state: initial, playerId: 'hero', message: '/why', turnId: condition.turn_id })
  assert.equal(why.turn_consumed, false)
  assert.equal(why.explanation.turn_id, condition.turn_id)
  assert.ok(why.explanation.rules_used.includes(RULE_IDS.conditions))
  assert.equal(why.explanation.events[0].event_type, 'ConditionAdded')

  await run('Бой завершён', { command_type: 'EndCombat', actor_id: 'hero', reason: 'противник обезврежен', source_rule_ids: [RULE_IDS.initiative, RULE_IDS.turns] })
  await run('Начинаю короткий отдых', { command_type: 'StartRest', actor_id: 'hero', kind: 'short', source_rule_ids: [RULE_IDS.resource] })
  await run('Завершаю короткий отдых', { command_type: 'CompleteRest', actor_id: 'hero', kind: 'short', source_rule_ids: [RULE_IDS.resource] })

  const loaded = await eventStore.load('FLOW-1')
  assert.equal(loaded.state.scene.cells[0].revealed, true)
  assert.deepEqual(loaded.state.mechanics.positions.hero, { x: 1, y: 0 })
  assert.equal(loaded.state.rulings[0].id, 'ruling-social-1')
  assert.equal(loaded.state.mechanics.resources.hero.spell_slots.current, 1)
  assert.equal(loaded.state.mechanics.concentration.hero.effect_id, 'spell:entangle')
  assert.equal(loaded.state.players.find((actor) => actor.id === 'hero').hp, 10)
  assert.equal(loaded.state.players.find((actor) => actor.id === 'goblin').hp, 4)
  assert.equal(loaded.state.mechanics.conditions.goblin[0].id, 'poisoned')
  assert.equal(loaded.state.mechanics.combat.active, false)

  const reopened = new FileEventStore({ rootDir: eventRoot, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const replayed = await reopened.replay('FLOW-1', { useSnapshots: false })
  assert.deepEqual(replayed.state, loaded.state)
  assert.equal(replayed.state_version, loaded.state_version)
})

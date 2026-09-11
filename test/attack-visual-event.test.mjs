import assert from 'node:assert/strict'
import test from 'node:test'

import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { attackVisualFor } from '../server/actor-appearance.mjs'

const SWORD = {
  id: 'sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
}
const SHIELD = {
  id: 'shield', catalog_id: 'srd_5_2_1:shield', name: 'Щит', type: 'armor', quantity: 1, equipped: true,
}

function state() {
  return normalizeCampaignState({
    sessionCode: 'ATTACK-VISUAL',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Лира', characterClass: 'fighter', level: 3, hp: 20, maxHp: 20,
      armor: 16, speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 12 },
      inventory: [SWORD, SHIELD], x: 0, y: 0,
    }],
    enemies: [{
      id: 'enemy', name: 'Враг', creature_type: 'humanoid', hp: 20, maxHp: 20,
      armor: 12, speed: 30, abilities: { str: 10, dex: 10, con: 10 }, x: 1, y: 0, alive: true,
    }],
    scene: {
      title: 'Зал', location: 'Зал', turn: 1,
      cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }],
    },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 15 }, { actor_id: 'enemy', total: 5 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
    battleLog: [],
  })
}

function event(payload = {}) {
  return {
    event_id: 'attack-visual-event', command_id: 'attack-visual-command', event_type: 'AttackResolved',
    actor_id: 'hero', target_ids: ['enemy'], visibility: 'public', payload,
  }
}

test('AttackResolved сохраняет безопасный snapshot в BattleLog и replay', () => {
  const initial = state()
  const raw = event({
    kept: 15, modifier: 5, total: 20, armor_class: 12, hit: true,
    attack_visual: { version: 1, equipment: 'sword-shield', private_url: 'https://private.invalid/model.glb', nested: { inventory: ['secret'] } },
  })
  const applied = applyGameEvent(initial, raw)
  const replayed = replayEvents(initial, [raw])
  assert.deepEqual(applied.battleLog.at(-1).attackVisual, { version: 1, equipment: 'sword-shield' })
  assert.deepEqual(replayed.battleLog.at(-1).attackVisual, { version: 1, equipment: 'sword-shield' })
  assert.deepEqual(replayed.battleLog, applied.battleLog)

  const projected = mechanicsForViewer([raw], { role: 'player' }, 'hero', initial)
  assert.deepEqual(projected[0].payload.attack_visual, { version: 1, equipment: 'sword-shield' })
  assert.doesNotMatch(JSON.stringify(projected), /private|inventory|secret/u)
})

test('неизвестная версия или equipment не проходят whitelist', () => {
  const initial = state()
  const invalid = event({
    kept: 1, modifier: 0, total: 1, armor_class: 12, hit: false,
    attack_visual: { version: 2, equipment: 'sword', url: 'https://private.invalid/model.glb' },
  })
  const after = applyGameEvent(initial, invalid)
  assert.equal(after.battleLog.at(-1).attackVisual, undefined)
  assert.equal(mechanicsForViewer([invalid], { role: 'player' }, 'hero', initial)[0].payload.attack_visual, undefined)
})

test('новая проекция атаки не удаляет прежние координаты движения и заклинания', () => {
  const initial = state()
  initial.battleLog = [
    { id: 'old-move', type: 'move', actorId: 'hero', from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, distanceFeet: 5 },
    { id: 'old-spell', type: 'spell', actorId: 'hero', targetId: 'enemy', spellId: 'magic-missile', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
  ]
  const projected = campaignStateForViewer(initial, { role: 'player' }, 'hero')
  assert.deepEqual(projected.battleLog, initial.battleLog)
})

test('BattleLog хранит только концы новой траектории и replay сохраняет их', () => {
  const initial = state()
  const raw = event({
    kept: 15, modifier: 5, total: 20, armor_class: 12, hit: true,
    attack_visual: { version: 1, equipment: 'bow' },
    trajectory: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }],
  })
  const applied = applyGameEvent(initial, raw)
  assert.deepEqual(applied.battleLog.at(-1).from, { x: 0, y: 0 })
  assert.deepEqual(applied.battleLog.at(-1).to, { x: 1, y: 0 })
  assert.equal(applied.battleLog.at(-1).trajectory, undefined)
  assert.deepEqual(replayEvents(initial, [raw]).battleLog, applied.battleLog)

  const projected = campaignStateForViewer(applied, { role: 'player' }, 'hero')
  assert.deepEqual(projected.battleLog.at(-1).from, { x: 0, y: 0 })
  assert.deepEqual(projected.battleLog.at(-1).to, { x: 1, y: 0 })
})

test('projection прячет концы, если цель скрыта или клетка не раскрыта', () => {
  const raw = event({
    kept: 15, modifier: 5, total: 20, armor_class: 12, hit: true,
    attack_visual: { version: 1, equipment: 'bow' },
    trajectory: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  })
  const hiddenTarget = state()
  hiddenTarget.enemies[0].visibility = 'gm_only'
  const hiddenTargetLog = campaignStateForViewer(applyGameEvent(hiddenTarget, raw), { role: 'player' }, 'hero').battleLog.at(-1)
  assert.equal(hiddenTargetLog.from, undefined)
  assert.equal(hiddenTargetLog.to, undefined)

  const hiddenCell = state()
  hiddenCell.scene.cells[1].revealed = false
  const hiddenCellLog = campaignStateForViewer(applyGameEvent(hiddenCell, raw), { role: 'player' }, 'hero').battleLog.at(-1)
  assert.equal(hiddenCellLog.from, undefined)
  assert.equal(hiddenCellLog.to, undefined)
})

test('новая атака героя фиксирует выбранный меч и публичный щит', () => {
  const result = resolveCommand({
    campaign_id: 'campaign-1', command_id: 'hero-attack', command_type: 'MakeAttack',
    actor_id: 'hero', target_id: 'enemy', item_id: 'sword', server_authoritative: true,
  }, state(), {
    diceService: new DiceService({ rng: new SequenceDiceRng([12, 4]), idFactory: () => 'attack-roll', now: () => '2026-09-11T12:00:00.000Z' }),
    context: { serverAuthoritativeCombat: true },
  })
  const attack = result.events.find((candidate) => candidate.event_type === 'AttackResolved')
  assert.deepEqual(attack.payload.attack_visual, { version: 1, equipment: 'sword-shield' })
})

test('закрытый щит не меняет публичный snapshot, а старый replay не получает поле', () => {
  const initial = state()
  const hiddenShield = { ...SHIELD, visibility: 'gm_only' }
  initial.players[0].inventory = [SWORD, hiddenShield]
  assert.deepEqual(attackVisualFor({ item: SWORD, items: initial.players[0].inventory }), { version: 1, equipment: 'sword' })
  for (const key of ['visibility_level', 'visibilityLevel']) {
    assert.deepEqual(attackVisualFor({ item: SWORD, items: [SWORD, { ...SHIELD, [key]: 'gm_only' }] }), { version: 1, equipment: 'sword' })
    assert.deepEqual(attackVisualFor({ item: SWORD, items: [SWORD, { ...SHIELD, [key]: 'specific_player' }] }), { version: 1, equipment: 'sword' })
  }
  assert.deepEqual(attackVisualFor({ item: SWORD, items: [SWORD, { ...SHIELD, visibility: 'party' }] }), { version: 1, equipment: 'sword-shield' })
  const raw = event({ kept: 15, modifier: 5, total: 20, armor_class: 12, hit: true, attack_visual: { version: 1, equipment: 'sword' } })
  assert.deepEqual(applyGameEvent(initial, raw).battleLog.at(-1).attackVisual, { version: 1, equipment: 'sword' })

  const legacy = applyGameEvent(initial, event({
    kept: 15, modifier: 5, total: 20, armor_class: 12, hit: true,
    trajectory: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  }))
  assert.equal(legacy.battleLog.at(-1).attackVisual, undefined)
  assert.equal(legacy.battleLog.at(-1).from, undefined)
  assert.equal(legacy.battleLog.at(-1).to, undefined)
})

test('NPC visual берётся из публичного действия, а не из скрытой привязки', () => {
  assert.deepEqual(attackVisualFor({
    actionName: 'Дальний удар', attackKind: 'ranged',
    npcBinding: { catalog_id: 'srd_5_2_1:longbow', item_instance_id: 'secret-bow' },
  }), { version: 1, equipment: 'unknown' })
  assert.deepEqual(attackVisualFor({ actionName: 'Короткий лук', attackKind: 'ranged' }), { version: 1, equipment: 'bow' })
  assert.deepEqual(attackVisualFor({ actionName: 'crossbow', attackKind: 'ranged' }), { version: 1, equipment: 'unknown' })
  assert.deepEqual(attackVisualFor({ actionName: 'Арбалет', attackKind: 'ranged' }), { version: 1, equipment: 'unknown' })
})

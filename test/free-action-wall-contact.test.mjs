import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  bindFreeActionReadingToState,
  interpretFreeAction,
  resolveHazardContact,
} from '../server/free-action-adjudication.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { addProp, createTacticalMap, serializeTacticalMap, setCell, setEdge } from '../server/tactical-map.mjs'

function actor(id, x, y) {
  return {
    id, character: id, hp: 20, maxHp: 20, x, y,
    abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    inventory: [],
  }
}

function nativeState({ wall = true, originRevealed = true, wallRevealed = true, wallX = 1, edgeKind = null, actorX = 0 } = {}) {
  const map = createTacticalMap({
    width: 4, height: 1, locationId: 'wall-contact', seed: 'wall-contact',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  if (wall || edgeKind) {
    setEdge(map, wallX - 1, 0, wallX, 0, { kind: edgeKind ?? 'wall', blocksMove: wall, blocksSight: wall })
    if (!originRevealed) setCell(map, wallX - 1, 0, { revealed: false })
    if (!wallRevealed) setCell(map, wallX, 0, { revealed: false })
  }
  return normalizeCampaignState({
    sessionCode: 'WALL-CONTACT', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [actor('hero', actorX, 0), actor('other', actorX === 3 ? 0 : 3, 0)],
    scene: {
      title: 'Зал', location: 'Зал', cells: [],
      map: serializeTacticalMap(map),
    },
  })
}

function legacyState({ revealed = true } = {}) {
  const result = normalizeCampaignState({
    sessionCode: 'WALL-LEGACY', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [actor('hero', 0, 0), actor('other', 3, 0)],
    scene: {
      title: 'Старый зал', location: 'Старый зал',
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'wall', revealed },
        { x: 2, y: 0, type: 'floor', revealed: true },
        { x: 3, y: 0, type: 'floor', revealed: true },
      ],
    },
  })
  delete result.scene.map
  return result
}

function reading(state, text) {
  return bindFreeActionReadingToState(state, 'hero', text, interpretFreeAction(text))
}

test('явное столкновение требует видимую стену и не путается с касанием, подходом или проломом', () => {
  for (const [state, sourceKind] of [[nativeState(), 'wall-edge'], [legacyState(), 'wall-cell']]) {
    const contact = resolveHazardContact(state, 'hero', 'врезаюсь в стену', reading(state, 'врезаюсь в стену'))
    assert.equal(contact?.status, 'contact')
    assert.equal(contact.hazard_id, 'crush')
    assert.equal(contact.damage_type, 'bludgeoning')
    assert.equal(contact.expression, '2d6')
    assert.equal(contact.source.kind, sourceKind)
  }
  const state = nativeState()
  for (const text of ['со всего разбега врезаюсь в стену', 'врезаюсь в стену']) {
    assert.equal(resolveHazardContact(state, 'hero', text, reading(state, text))?.status, 'contact', text)
  }
  for (const text of [
    'не врезаюсь в стену', 'касаюсь стены', 'подхожу к стене',
    'врезаю нож в стену', 'врезаюсь в стенного стража',
    'могу ли врезаться в стену?', 'если я врежусь в стену',
    'хочу врезаться в стену', 'врезаюсь в стену, чтобы проломить её',
  ]) {
    assert.equal(resolveHazardContact(state, 'hero', text, reading(state, text)), null, text)
  }
  const staleLegacy = nativeState({ wall: false, edgeKind: 'door' })
  staleLegacy.scene.cells = [
    { x: 0, y: 0, type: 'floor', revealed: true },
    { x: 1, y: 0, type: 'wall', revealed: true },
  ]
  assert.equal(resolveHazardContact(staleLegacy, 'hero', 'врезаюсь в стену', reading(staleLegacy, 'врезаюсь в стену'))?.status, 'unavailable')
  const boundary = nativeState({ wallX: 4, actorX: 3 })
  assert.equal(resolveHazardContact(boundary, 'hero', 'врезаюсь в стену', reading(boundary, 'врезаюсь в стену'))?.status, 'contact')
})

test('стена должна быть соседней и раскрытой', () => {
  const far = nativeState({ wallX: 2 })
  assert.equal(resolveHazardContact(far, 'hero', 'врезаюсь в стену', reading(far, 'врезаюсь в стену'))?.status, 'unavailable')
  const hidden = nativeState({ originRevealed: false })
  assert.equal(resolveHazardContact(hidden, 'hero', 'врезаюсь в стену', reading(hidden, 'врезаюсь в стену'))?.status, 'unavailable')
  const unknownRoom = nativeState({ wallRevealed: false })
  assert.equal(resolveHazardContact(unknownRoom, 'hero', 'врезаюсь в стену', reading(unknownRoom, 'врезаюсь в стену'))?.status, 'contact')
  const legacyHidden = legacyState({ revealed: false })
  assert.equal(resolveHazardContact(legacyHidden, 'hero', 'врезаюсь в стену', reading(legacyHidden, 'врезаюсь в стену'))?.status, 'unavailable')
})

test('столкновение наносит crush-урон, не двигает героя и переживает replay/idempotency', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-wall-contact-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initial = nativeState()
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([3, 4]) }) }),
    narrator: { render: async () => { throw new Error('wall contact must not call narrator') } },
  })
  await eventStore.initializeCampaign({ campaignId: 'WALL-CONTACT', initialState: initial })
  const input = {
    campaignId: 'WALL-CONTACT', playerId: 'hero', allowedActorIds: ['hero'], state: initial,
    message: 'со всего разбега врезаюсь в стену', idempotencyKey: 'wall-contact-once',
  }
  const first = await orchestrator.handle(input)
  assert.equal(first.free_action_outcome, 'hazard_contact')
  assert.match(first.narration, /Удар о стену:.*7 дробящего урона/u)
  assert.equal(first.verification.valid, true)
  assert.deepEqual(first.authoritative_state.mechanics.positions.hero, { x: 0, y: 0 })
  assert.equal(first.mechanics.some((event) => event.event_type === 'ActorMoved'), false)
  const damage = first.mechanics.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.damage_type, 'bludgeoning')
  assert.equal(damage.payload.applied_amount, 7)
  assert.deepEqual(damage.target_ids, ['hero'])
  assert.equal(first.authoritative_state.players.find((entry) => entry.id === 'hero').hp, 13)

  const replay = await orchestrator.handle(input)
  assert.equal(replay.idempotent_replay, true)
  assert.deepEqual(replay.mechanics, first.mechanics)
  assert.equal((await eventStore.load('WALL-CONTACT')).state.players.find((entry) => entry.id === 'hero').hp, 13)

  const wrongActor = resolveHazardContact(initial, 'other', input.message, reading(initial, input.message))
  assert.equal(wrongActor?.status, 'unavailable')
  assert.equal((await eventStore.load('WALL-CONTACT')).state.players.find((entry) => entry.id === 'other').hp, 20)
})

test('вопрос о столкновении не исполняет контакт', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-wall-question-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initial = nativeState()
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([3, 4]) }) }),
  })
  await eventStore.initializeCampaign({ campaignId: 'WALL-CONTACT', initialState: initial })
  const result = await orchestrator.handle({
    campaignId: 'WALL-CONTACT', playerId: 'hero', allowedActorIds: ['hero'], state: initial,
    message: 'могу ли врезаться в стену?', requestKind: 'question', idempotencyKey: 'wall-question',
  })
  assert.deepEqual(result.mechanics, [])
  assert.equal(result.turn_consumed, false)
  assert.equal((await eventStore.load('WALL-CONTACT')).state_version, 0)
})

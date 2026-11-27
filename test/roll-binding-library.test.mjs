// Привязка механического броска к объявленной проверке (аудит PR #131, SEC-01).
//
// До исправления `/api/roll` без `check_id` выдавал «ничейный» серверный d20, а
// обычная проверка принимала его `roll_id`: игрок объявлял проверку один раз,
// бросал сколько угодно таких костей и подставлял лучшую. Здесь закреплено, что
// механическую проверку исполняет только кость, выданная под её карточку, —
// того же героя, той же проверки и ещё не потреблённая, — а повтор с тем же
// ключом по-прежнему возвращает прежний commit. Здесь — оркестратор
// JS-библиотеки в процессе; HTTP-путь — roll-binding.test.mjs.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

const SESSION = 'ROLL-BINDING'
const ACTION = 'Проверяю силу'

test('кость другой карточки того же героя обычной проверкой не становится', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-roll-binding-unit-'))
  try {
    const initial = normalizeCampaignState({
      sessionCode: SESSION,
      activePlayerId: 'hero',
      scene: { title: 'Зал', location: 'Старый трактир', objective: 'Осмотреть зал', cells: [] },
      players: [{
        id: 'hero', character: 'Ада', name: 'Ада', hp: 10, maxHp: 10, armor: 14,
        abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [],
      }],
    })
    const eventStore = new FileEventStore({
      rootDir: join(root, 'events'),
      reducer: applyGameEvent,
      normalizeState: normalizeCampaignState,
      idFactory: (() => { let id = 0; return () => `binding-event-${++id}` })(),
    })
    const registry = new RollRegistry({
      diceService: new DiceService({ rng: new SequenceDiceRng([20, 4]), idFactory: (() => { let id = 0; return () => `binding-roll-${++id}` })() }),
    })
    const orchestrator = new GameOrchestrator({
      rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([11]) }) }),
      eventStore,
      narrator: { render: async () => ({ narration: 'Описание.', provider: 'deterministic-test' }) },
      rollRegistry: registry,
      idFactory: (() => { let id = 0; return () => `binding-turn-${++id}` })(),
    })
    await eventStore.initializeCampaign({ campaign_id: SESSION, initial_state: initial })
    const input = (key, extra = {}) => ({
      state: initial, campaignId: SESSION, playerId: 'hero', allowedActorIds: ['hero'],
      message: ACTION, idempotencyKey: key, ...extra,
    })

    // Карточка парлея того же героя: реестр сверит кампанию и актора, но
    // ветка обычной проверки обязана отказать по виду карточки.
    const parley = registry.registerCheck({ campaignId: SESSION, actorId: 'hero', label: 'Убеждение', difficulty: 10, context: { kind: 'parley' } })
    const parleyRoll = registry.issue({ checkId: parley.check_id, campaignId: SESSION, actorId: 'hero' })
    assert.equal(parleyRoll.kept, 20)
    const parleyVerified = registry.consume(parleyRoll.roll_id, { campaignId: SESSION, actorId: 'hero', idempotencyKey: 'binding-parley' })
    await assert.rejects(orchestrator.handle(input('binding-parley', { verifiedRoll: parleyVerified })), { code: 'ROLL_CONTEXT_MISMATCH' })
    assert.equal((await eventStore.load(SESSION)).state_version, 0, 'чужая кость не создаёт событий')

    // Своя карточка той же ветки исполняется выпавшей костью.
    const offer = await orchestrator.handle(input('binding-offer', { manualRoll: true }))
    assert.ok(offer.check?.check_id, JSON.stringify(offer))
    const own = registry.issue({ checkId: offer.check.check_id, campaignId: SESSION, actorId: 'hero' })
    const verifiedRoll = registry.consume(own.roll_id, { campaignId: SESSION, actorId: 'hero', idempotencyKey: 'binding-own' })
    const resolved = await orchestrator.handle(input('binding-own', { verifiedRoll }))
    const ability = (resolved.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
    assert.ok(ability, JSON.stringify(resolved.mechanics))
    assert.equal(ability.payload.roll_id, own.roll_id)
    assert.equal(ability.payload.kept, 4)
    assert.equal(ability.payload.player_rolled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

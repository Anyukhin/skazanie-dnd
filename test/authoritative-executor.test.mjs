import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AuthoritativeExecutor,
  CAMPAIGN_CONTROL_CAPABILITY,
  CAMPAIGN_LIFECYCLE_CAPABILITY,
  CAMPAIGN_RULESET_CAPABILITY,
  PARTY_DECISION_CAPABILITY,
  PUBLIC_DICE_CAPABILITY,
  derivedEventAllowlistForReview,
} from '../server/authoritative-executor.mjs'
import { campaignRulesetChangeEvent } from '../server/campaign-ruleset.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

/**
 * Шаг 3 плана `docs/agent-architecture-plan.md`: один исполнитель, два входа.
 *
 * Модуль пока не подключён к боевым путям — миграция это шаги 4 и 5. Тесты
 * проверяют ровно то, ради чего он заводится: единую политику устойчивости и
 * невозможность записать через производный вход то, чем владеет Rules Engine.
 */

function fixture() {
  return normalizeCampaignState({
    sessionCode: 'EXECUTOR',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Ада', hp: 20, maxHp: 20, armor: 14, speed: 30,
      abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    }],
    scene: { location: 'Лагерь', turn: 1, cells: [] },
    mechanics: {},
  })
}

async function storeFor(t, campaignId = 'EXECUTOR') {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-executor-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await store.initializeCampaign({ campaign_id: campaignId, initial_state: fixture() })
  return store
}

function engine() {
  return new RulesEngine({
    diceService: new DiceService({
      rng: new SequenceDiceRng([]), idFactory: () => 'roll-1', now: () => '2026-07-31T12:00:00.000Z',
    }),
  })
}

/** Делает `expected_state_version` устаревшим ровно один раз. */
function racingStore(store, campaignId) {
  let raced = false
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'commit' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (input) => {
        if (!raced) {
          raced = true
          const loaded = await target.load(campaignId)
          await target.commit({
            campaign_id: campaignId,
            expected_state_version: loaded.state_version,
            idempotency_key: `foreign:${loaded.state_version}`,
            command_id: `foreign:${loaded.state_version}`,
            events: [{
              event_type: 'ObjectiveUpdated',
              actor_id: 'system',
              target_ids: [],
              payload: { objective: 'Чужой коммит опередил исполнителя' },
              source_rule_ids: [],
              visibility: 'public',
            }],
          })
        }
        return target.commit(input)
      }
    },
  })
}

const objectiveCommand = { command_type: 'UpdateObjective', objective: 'Дойти до переправы' }

test('конфликт версии переживается одинаково — там, где раньше терялся ход', async (t) => {
  const store = await storeFor(t)
  const executor = new AuthoritativeExecutor({ eventStore: racingStore(store, 'EXECUTOR'), rulesEngine: engine() })

  const committed = await executor.executeCommands({
    campaignId: 'EXECUTOR',
    idempotencyKey: 'objective-1',
    commands: [objectiveCommand],
  })

  assert.equal(committed.replayed, false)
  assert.ok(committed.events.length > 0, 'команда обязана дойти до журнала несмотря на чужой коммит')
  const loaded = await store.load('EXECUTOR')
  assert.equal(loaded.state.scene.objective, 'Дойти до переправы')
})

test('повтор того же ключа отдаёт прежний коммит и не пишет второй раз', async (t) => {
  const store = await storeFor(t)
  const executor = new AuthoritativeExecutor({ eventStore: store, rulesEngine: engine() })

  const first = await executor.executeCommands({
    campaignId: 'EXECUTOR', idempotencyKey: 'objective-2', commands: [objectiveCommand],
  })
  const versionAfterFirst = (await store.load('EXECUTOR')).state_version
  const second = await executor.executeCommands({
    campaignId: 'EXECUTOR', idempotencyKey: 'objective-2', commands: [objectiveCommand],
  })

  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal((await store.load('EXECUTOR')).state_version, versionAfterFirst)
})

test('пустой набор команд не коммитится', async (t) => {
  const store = await storeFor(t)
  const executor = new AuthoritativeExecutor({ eventStore: store, rulesEngine: engine() })
  await assert.rejects(
    () => executor.executeCommands({ campaignId: 'EXECUTOR', idempotencyKey: 'empty', commands: [] }),
    (error) => error.code === 'EMPTY_COMMAND_SET',
  )
})

test('производное событие проходит только со своей capability и только своего типа', async (t) => {
  const store = await storeFor(t)
  const executor = new AuthoritativeExecutor({ eventStore: store })
  const publicDie = {
    event_type: 'PublicDieRolled',
    actor_id: 'hero',
    target_ids: [],
    visibility: 'public',
    source_rule_ids: [],
    payload: { expression: '1d20', total: 14 },
  }

  await assert.rejects(
    () => executor.commitDerived({ campaignId: 'EXECUTOR', idempotencyKey: 'die-1', events: [publicDie] }),
    (error) => error.code === 'PRODUCER_CAPABILITY_REQUIRED',
    'без capability производный вход обязан отказать',
  )
  await assert.rejects(
    () => executor.commitDerived({
      campaignId: 'EXECUTOR', idempotencyKey: 'die-2', events: [publicDie],
      producerCapability: CAMPAIGN_LIFECYCLE_CAPABILITY,
    }),
    (error) => error.code === 'DERIVED_EVENT_NOT_ALLOWED',
    'чужой производитель не может писать чужой тип события',
  )

  const committed = await executor.commitDerived({
    campaignId: 'EXECUTOR', idempotencyKey: 'die-3', events: [publicDie],
    producerCapability: PUBLIC_DICE_CAPABILITY,
  })
  assert.equal(committed.replayed, false)
  assert.equal(committed.events[0].event_type, 'PublicDieRolled')
})

test('производный вход не может тронуть ничего, чем владеет Rules Engine', async (t) => {
  const store = await storeFor(t)
  const executor = new AuthoritativeExecutor({ eventStore: store })

  for (const payload of [
    { expression: '1d20', total: 20, hp: 3 },
    { expression: '1d20', total: 20, result: { damage: 7 } },
    { expression: '1d20', total: 20, inventory: [] },
  ]) {
    await assert.rejects(
      () => executor.commitDerived({
        campaignId: 'EXECUTOR',
        idempotencyKey: `forged:${JSON.stringify(payload)}`,
        events: [{
          event_type: 'PublicDieRolled', actor_id: 'hero', target_ids: [], visibility: 'public',
          source_rule_ids: [], payload,
        }],
        producerCapability: PUBLIC_DICE_CAPABILITY,
      }),
      (error) => error.code === 'DERIVED_EVENT_TOUCHES_RULES_STATE',
      `payload ${JSON.stringify(payload)} обязан быть отклонён`,
    )
  }
})

test('повтор производного события идемпотентен', async (t) => {
  const store = await storeFor(t)
  const executor = new AuthoritativeExecutor({ eventStore: store })
  const event = {
    event_type: 'CampaignPaused', actor_id: 'owner', target_ids: [], visibility: 'party',
    source_rule_ids: [], payload: { reason: 'перерыв' },
  }
  const first = await executor.commitDerived({
    campaignId: 'EXECUTOR', idempotencyKey: 'pause-1', events: [event],
    producerCapability: CAMPAIGN_LIFECYCLE_CAPABILITY,
  })
  const second = await executor.commitDerived({
    campaignId: 'EXECUTOR', idempotencyKey: 'pause-1', events: [event],
    producerCapability: CAMPAIGN_LIFECYCLE_CAPABILITY,
  })
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
})

test('смена ruleset повторно проверяет lock после конфликта версии', async (t) => {
  const store = await storeFor(t)
  const executor = new AuthoritativeExecutor({ eventStore: racingStore(store, 'EXECUTOR') })

  await assert.rejects(
    () => executor.commitDerived({
      campaignId: 'EXECUTOR',
      idempotencyKey: 'ruleset-race',
      producerCapability: CAMPAIGN_RULESET_CAPABILITY,
      deriveEvents: async (freshState) => {
        const event = campaignRulesetChangeEvent('dnd_5e_2014', freshState, await store.getEvents('EXECUTOR'))
        return event ? [event] : []
      },
    }),
    (error) => error.code === 'CAMPAIGN_RULESET_LOCKED',
  )
  assert.equal((await store.load('EXECUTOR')).state.ruleset_id, 'srd_5_2_1')
})

test('откат кампании идёт отдельным управляющим входом, а не производным', async (t) => {
  const store = await storeFor(t)
  const executor = new AuthoritativeExecutor({ eventStore: store })
  const rewind = {
    event_type: 'CampaignRewound', actor_id: 'owner', target_ids: [], visibility: 'party',
    source_rule_ids: [], payload: { target_version: 0, state: fixture() },
  }

  await assert.rejects(
    () => executor.commitDerived({
      campaignId: 'EXECUTOR', idempotencyKey: 'rewind-1', events: [rewind],
      producerCapability: CAMPAIGN_LIFECYCLE_CAPABILITY,
    }),
    (error) => error.code === 'DERIVED_EVENT_NOT_ALLOWED',
    'откат переписывает состояние целиком и через производный вход проходить не должен',
  )
  await assert.rejects(
    () => executor.commitControl({
      campaignId: 'EXECUTOR', idempotencyKey: 'rewind-2', event: rewind,
      capability: PARTY_DECISION_CAPABILITY,
    }),
    (error) => error.code === 'PRODUCER_CAPABILITY_REQUIRED',
  )
  const committed = await executor.commitControl({
    campaignId: 'EXECUTOR', idempotencyKey: 'rewind-3', event: rewind,
    capability: CAMPAIGN_CONTROL_CAPABILITY,
  })
  assert.equal(committed.events[0].event_type, 'CampaignRewound')
})

test('таблица производных событий читается целиком и не пуста ни у кого', () => {
  const table = derivedEventAllowlistForReview()
  assert.deepEqual(Object.keys(table).sort(),
    ['campaignLifecycle', 'campaignRuleset', 'economyClock', 'partyDecision', 'presence', 'publicDice', 'worldRumor'])
  for (const [producer, types] of Object.entries(table)) {
    assert.ok(types.length > 0, `${producer}: пустой список превращает capability в формальность`)
    assert.deepEqual(types, [...types].sort(), `${producer}: список обязан быть отсортирован для ревью`)
  }
  // Пополнение лавки остаётся за Rules Engine: часы — единственный производитель,
  // который расщепляется на два входа, и это записано в плане.
  assert.deepEqual(table.economyClock, ['MerchantEconomyClockAdvanced'])
  assert.deepEqual(table.campaignRuleset, ['CampaignRulesetChanged'])
  // Часы молвы расщепляются так же: слухи — команды памяти мира через
  // `executeCommands`, а сюда приходит только реакция мира на дошедший слух.
  assert.deepEqual(table.worldRumor, ['FactionReputationAdjusted'])
})

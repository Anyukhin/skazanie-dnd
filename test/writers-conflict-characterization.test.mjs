import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { runNpcTurnScheduler } from '../server/npc-turn-scheduler.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

/**
 * Шаг 0 плана `docs/agent-architecture-plan.md`: зафиксировать **сегодняшнее**
 * поведение писателей при гонке версий и повторе ключа — как факт, а не как
 * норму. Реестр писателей стережёт `test/authoritative-writers.test.mjs`; здесь
 * проверяется, что именно происходит, когда чужой коммит опередил свой.
 *
 * Расхождение, ради которого тест написан: ход игрока переживает конфликт
 * версии прозрачно (три попытки в `GameOrchestrator`), а планировщик NPC —
 * нет. Один и тот же класс сбоя для игрока незаметен, а для NPC означает
 * потерянный ход.
 *
 * **Ожидания ниже станут неверными на шаге 4 плана** — там писатели получают
 * общую политику. Обновлять их полагается явным коммитом с обоснованием, а не
 * «чтобы позеленело».
 */

function cells(width = 9, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true,
  }))
}

function fixture() {
  return normalizeCampaignState({
    sessionCode: 'WRITER-RACE',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      attackBonus: 7, damageDice: 6, damageBonus: 2, x: 0, y: 1,
    }],
    enemies: [{
      id: 'wolf', hp: 20, maxHp: 20, armor: 11, speed: 10, attackBonus: 4, damageDice: 4, damageBonus: 1,
      abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: 3, y: 1, alive: true,
    }],
    scene: { turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 1,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'wolf', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values), idFactory: () => `roll-${++id}`, now: () => '2026-07-12T00:00:00.000Z',
  })
}

function storeFor(t, campaignId, state) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-writer-race-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  return store.initializeCampaign({ campaign_id: campaignId, initial_state: state }).then(() => store)
}

/**
 * Делает `expected_state_version` устаревшим ровно один раз: перед первым
 * `commit` вставляет чужой коммит. Приватных полей у `FileEventStore` нет,
 * поэтому `Proxy` с привязкой методов к цели безопасен и ничего не подменяет
 * в самом сторе.
 *
 * @param {import('../server/event-store.mjs').FileEventStore} store
 * @param {string} campaignId
 */
function racingStore(store, campaignId) {
  let raced = false
  const foreignCommit = async () => {
    const loaded = await store.load(campaignId)
    await store.commit({
      campaign_id: campaignId,
      expected_state_version: loaded.state_version,
      idempotency_key: `foreign:${loaded.state_version}`,
      command_id: `foreign:${loaded.state_version}`,
      events: [{
        event_type: 'ObjectiveUpdated',
        actor_id: 'system',
        target_ids: [],
        payload: { objective: 'Чужой коммит опередил писателя' },
        source_rule_ids: [],
        visibility: 'public',
      }],
    })
  }
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'commit' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (input) => {
        if (!raced) {
          raced = true
          await foreignCommit()
        }
        return target.commit(input)
      }
    },
  })
}

test('планировщик NPC сегодня не переживает конфликт версии — это фиксируется, а не одобряется', async (t) => {
  const store = await storeFor(t, 'WRITER-RACE', fixture())
  const raced = racingStore(store, 'WRITER-RACE')

  await assert.rejects(
    () => runNpcTurnScheduler({
      campaignId: 'WRITER-RACE',
      eventStore: raced,
      rulesEngine: new RulesEngine({ diceService: dice([15, 3]) }),
      npcController: { decide: async () => ({ disposition: 'fight', provider: 'test' }) },
    }),
    (error) => String(error?.code || error?.message).includes('STATE_VERSION_CONFLICT'),
    'ожидался проброс конфликта версии: у планировщика нет ни retry, ни перечитывания по ключу',
  )

  // Ход NPC при этом потерян: чужой коммит прошёл, а событий боя не появилось.
  const loaded = await store.load('WRITER-RACE')
  const combatEvents = (loaded.events ?? []).filter((event) => event.event_type !== 'ObjectiveUpdated')
  assert.equal(combatEvents.length, 0,
    'если события хода появились — планировщик научился переживать гонку, это шаг 4 плана')
})

test('повтор того же ключа отдаёт прежний коммит, а не второй ход NPC', async (t) => {
  const store = await storeFor(t, 'WRITER-REPLAY', fixture())
  const engine = () => new RulesEngine({ diceService: dice([15, 3]) })
  const first = await runNpcTurnScheduler({
    campaignId: 'WRITER-REPLAY', eventStore: store, rulesEngine: engine(),
    npcController: { decide: async () => ({ disposition: 'fight', provider: 'test' }) },
  })
  assert.ok(first.turns.length > 0, 'первый прогон обязан дать ход NPC')

  const versionAfterFirst = (await store.load('WRITER-REPLAY')).state_version
  const second = await runNpcTurnScheduler({
    campaignId: 'WRITER-REPLAY', eventStore: store, rulesEngine: engine(),
    npcController: { decide: async () => ({ disposition: 'fight', provider: 'test' }) },
  })
  const versionAfterSecond = (await store.load('WRITER-REPLAY')).state_version

  // Ключ планировщика собран из позиции в бою, а не из случайного идентификатора,
  // поэтому повтор на том же месте очереди не создаёт второй ход.
  assert.equal(second.turns.length, 0,
    'повторный запуск на той же позиции очереди не должен давать второй ход NPC')
  assert.equal(versionAfterSecond, versionAfterFirst,
    'повтор изменил состояние — значит ключ перестал зависеть от позиции хода')
})

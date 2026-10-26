import assert from 'node:assert/strict'
import test from 'node:test'

import { addPlayer, createCampaign, readJournal, sendCommand, setupAdmin, startTestServer } from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

// Легендарное действие босса тратит только планировщик NPC на сервере
// (`test/boss-mechanics.test.mjs`). Вторая дверь — HTTP: команду
// `UseLegendaryAction` не принимает от браузера никто, ни игрок, ни ведущий.
// Раньше это держала проверка текста `server/index.mjs` («имя команды в
// маршрутах не встречается»); здесь — поведение, одинаковое у JS и Rust.

const CODE = 'LEGENDARY-HTTP'

const LEGENDARY = {
  uses: 3,
  resistance: 2,
  actions: [
    { id: 'tail', name: 'Удар хвостом', cost: 1, kind: 'attack', attack_modifier: 9, damage_expression: '2d8+5', damage_type: 'bludgeoning', range_feet: 15 },
  ],
}

function cells(width = 12, height = 6) {
  return Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true }))
}

/** Бой идёт, очередь — на герое: ровно то окно, где легендарное действие законно для планировщика. */
function bossState() {
  const initiative = [{ actor_id: 'hero', total: 22 }, { actor_id: 'boss', total: 12 }]
  return {
    sessionCode: CODE, campaign: 'Курган', partyMemberIds: ['hero'], activePlayerId: 'hero', messages: [],
    players: [{ id: 'hero', name: 'Ильма', character: 'Ильма', hp: 44, maxHp: 44, armor: 16, speed: 30, proficiency: 3, level: 5,
      abilities: { str: 14, dex: 16, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [], x: 4, y: 2 }],
    enemies: [{ id: 'boss', name: 'Владыка кургана', hp: 120, maxHp: 120, armor: 18, speed: 30, proficiency: 4, creature_type: 'humanoid',
      abilities: { str: 20, dex: 14, con: 18, int: 16, wis: 15, cha: 19 }, attackBonus: 9, damageDice: 8, damageBonus: 5, x: 6, y: 2, alive: true,
      action_profiles: [{ id: 'claw', name: 'Коготь', kind: 'melee', attack_modifier: 9, damage_expression: '2d6+5', damage_type: 'slashing', range_feet: 5 }],
      legendary: LEGENDARY }],
    scene: { turn: 1, title: 'Курган', location: 'Курган', cells: cells() },
    mechanics: { combat: { active: true, round: 1, active_index: 0, initiative,
      action_economy: Object.fromEntries(initiative.map((entry) => [entry.actor_id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) } },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
}

test('UseLegendaryAction не принимается по HTTP ни от игрока, ни от ведущего', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-legendary-http-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: CODE, state: bossState() })
  const { client: player } = await addPlayer(server, gm, CODE, { heroIds: ['hero'] })

  const legendary = { command_type: 'UseLegendaryAction', actor_id: 'boss', legendary_action_id: 'tail', target_id: 'hero' }
  const attempts = [
    ['игрок за босса', player, 'legendary-player-boss', legendary],
    ['игрок за своего героя', player, 'legendary-player-hero', { ...legendary, actor_id: 'hero' }],
    ['ведущий', gm, 'legendary-gm', legendary],
  ]
  for (const [who, client, key, command] of attempts) {
    const refused = await sendCommand(client, CODE, key, command)
    assert.ok(refused.status >= 400 && refused.status < 500, `${who}: ожидался отказ 4xx, получен ${refused.status}: ${refused.text.slice(0, 300)}`)
    assert.ok(refused.body?.code, `${who}: отказ называет код: ${refused.text.slice(0, 300)}`)
  }

  // Планировщик NPC сам вправе тратить легендарные действия в окне чужого
  // хода, поэтому журнал сверяется по ключам отказанных запросов, а не по
  // типу события вообще.
  const journal = await readJournal(server, CODE)
  const refusedKeys = new Set(attempts.map(([, , key]) => key))
  assert.deepEqual(journal.commits.filter((commit) => refusedKeys.has(commit.idempotency_key)), [], 'отказы не оставили коммитов')
})

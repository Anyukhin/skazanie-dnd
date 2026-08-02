// Recharge (X–6): способность тратится, уходит из плана NPC и возвращается
// броском в начале хода существа.
//
// До этого «Паутина» гигантского паука стояла как `uses: 1` — способность
// тратилась навсегда, хотя в стат-блоке SRD 5.2.1 у неё Recharge 5–6. Бой из-за
// этого становился тем скучнее, чем дольше шёл: сильный приём существо
// использовало один раз за всё столкновение.
import assert from 'node:assert/strict'
import test from 'node:test'

import { combatNarration } from '../server/combat-narration.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST, assembleEncounter } from '../server/encounter-assembler.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { RulesValidationError, applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const SPIDER_BLOCK = SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-spider']
const NPC_CONTEXT = Object.freeze({ isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true })

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `recharge-roll-${++id}`,
    now: () => '2026-08-02T12:00:00.000Z',
  })
}

function campaignState() {
  return normalizeCampaignState({
    sessionCode: 'MONSTER-RECHARGE',
    campaign_id: 'MONSTER-RECHARGE',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Мира',
      characterClass: 'fighter',
      level: 3,
      proficiency: 2,
      hp: 30,
      maxHp: 30,
      armor: 14,
      speed: 30,
      abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      attackBonus: 5,
      damageDice: 8,
      damageBonus: 2,
      x: 0,
      y: 0,
    }],
    enemies: [{
      id: 'spider',
      name: SPIDER_BLOCK.name,
      hp: SPIDER_BLOCK.hp,
      maxHp: SPIDER_BLOCK.hp,
      armor: SPIDER_BLOCK.armor,
      speed: SPIDER_BLOCK.speed,
      alive: true,
      abilities: { ...SPIDER_BLOCK.abilities },
      traits: SPIDER_BLOCK.traits.map((trait) => ({ ...trait })),
      action_profiles: SPIDER_BLOCK.action_profiles.map((action) => JSON.parse(JSON.stringify(action))),
      attack_profile: JSON.parse(JSON.stringify(SPIDER_BLOCK.action_profiles[0])),
      stat_block_id: 'srd_5_2_1:giant-spider',
      x: 3,
      y: 0,
    }],
    scene: {
      turn: 1,
      cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, spider: { x: 3, y: 0 } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'spider', total: 20 }, { actor_id: 'hero', total: 10 }],
        action_economy: {
          spider: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

/** Паук стреляет паутиной: 18 попадает по КД 14, урона у приёма нет. */
function shootWeb(state, commandId = 'web-1') {
  return resolveCommand({
    command_type: 'MakeAttack',
    command_id: commandId,
    actor_id: 'spider',
    target_id: 'hero',
    action_id: 'web',
    server_authoritative: true,
  }, state, { diceService: dice([18]), context: NPC_CONTEXT })
}

function endTurn(state, actorId, rolls, commandId = `end-${actorId}`) {
  return resolveCommand({
    command_type: 'EndTurn',
    command_id: commandId,
    actor_id: actorId,
    server_authoritative: true,
  }, state, { diceService: dice(rolls), context: NPC_CONTEXT })
}

function spentWeb(state) {
  return (state.mechanics.conditions.spider ?? []).some((condition) => String(condition.id ?? condition) === 'monster-action-used:web')
}

/** Паук потратил Паутину и передал ход герою: следующий ход паука — с броском recharge. */
function afterWebAndSpiderTurn() {
  let state = campaignState()
  state = shootWeb(state).events.reduce(applyGameEvent, state)
  assert.equal(spentWeb(state), true, 'Паутина обязана потратиться')
  return endTurn(state, 'spider', []).events.reduce(applyGameEvent, state)
}

test('Паутина объявлена как Recharge 5–6 и это единственная такая способность allowlist', () => {
  const web = SPIDER_BLOCK.action_profiles.find((action) => action.id === 'web')
  assert.ok(web)
  assert.equal(web.recharge, 5)
  assert.equal(web.uses, undefined, 'одноразовость снята: приём возвращается броском')
  assert.equal(SPIDER_BLOCK.source_page, 305)

  // Честность данных: recharge стоит только там, где он есть в стат-блоке.
  const withRecharge = Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)
    .filter(([, block]) => (block.action_profiles ?? []).some((action) => Number(action?.recharge) > 0))
    .map(([id]) => id)
  assert.deepEqual(withRecharge, ['srd_5_2_1:giant-spider'])

  // Диапазон объявлен числом 1..6 везде, где вообще объявлен.
  for (const block of Object.values(SRD_5_2_1_MONSTER_ALLOWLIST)) {
    for (const action of block.action_profiles ?? []) {
      if (action.recharge == null) continue
      assert.ok(Number.isInteger(action.recharge) && action.recharge >= 1 && action.recharge <= 6, `${block.name}.${action.id}`)
    }
  }

  const proposal = assembleEncounter({
    difficulty: 'hard',
    theme: 'vermin',
    seed: 'spider-recharge',
    party: [{ id: 'hero', level: 3, x: 0, y: 0 }],
    scene: { cells: Array.from({ length: 64 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true })) },
  })
  for (const enemy of proposal.enemies.filter((candidate) => candidate.stat_block_id === 'srd_5_2_1:giant-spider')) {
    assert.equal(enemy.action_profiles.find((action) => action.id === 'web').recharge, 5)
  }
})

test('потраченная способность недоступна до восстановления', () => {
  // Круг замкнулся: ход снова паучий, действие свежее — и всё равно отказ.
  const spent = afterWebAndSpiderTurn()
  const stillSpent = endTurn(spent, 'hero', [2], 'end-hero-spent').events.reduce(applyGameEvent, spent)
  assert.equal(spentWeb(stillSpent), true)
  assert.equal(stillSpent.mechanics.combat.action_economy.spider.action, true)
  assert.throws(
    () => shootWeb(stillSpent, 'web-again'),
    (error) => error instanceof RulesValidationError && error.code === 'MONSTER_ACTION_SPENT',
  )
})

test('бросок из диапазона возвращает способность, бросок ниже — нет', () => {
  const spent = afterWebAndSpiderTurn()

  for (const value of [5, 6]) {
    const result = endTurn(spent, 'hero', [value], `end-hero-${value}`)
    const recharged = result.events.filter((event) => event.event_type === 'MonsterAbilityRecharged')
    assert.equal(recharged.length, 1, `бросок ${value} обязан вернуть приём`)
    assert.equal(recharged[0].payload.action_id, 'web')
    assert.deepEqual(recharged[0].target_ids, ['spider'])
    const after = result.events.reduce(applyGameEvent, spent)
    assert.equal(spentWeb(after), false)
    // И движок снова принимает команду — а не только маркер исчез из состояния.
    assert.equal(shootWeb(after, `web-after-${value}`).events.some((event) => event.event_type === 'AttackResolved'), true)
  }

  for (const value of [1, 2, 3, 4]) {
    const result = endTurn(spent, 'hero', [value], `end-hero-${value}`)
    assert.equal(result.events.some((event) => event.event_type === 'MonsterAbilityRecharged'), false, `бросок ${value} не должен возвращать приём`)
    assert.equal(spentWeb(result.events.reduce(applyGameEvent, spent)), true)
  }
})

test('заряженная способность не бросается зря: кость катится только у потраченной', () => {
  // У полностью заряженного паука начало хода не тратит ни одного броска —
  // иначе детерминированные последовательности бросков разъехались бы всюду.
  const fresh = campaignState()
  const result = endTurn(fresh, 'spider', [])
  assert.equal(result.events.some((event) => event.event_type === 'DieRolled'), false)
  assert.equal(result.rolls.length, 0)
})

test('планировщик открывает Паутиной, исключает разряженную и снова берёт восстановленную', () => {
  const fresh = campaignState()
  const opening = planNpcTurn(fresh, 'spider')
  assert.equal(opening[0].command_type, 'MakeAttack')
  assert.equal(opening[0].action_id, 'web', 'заряженный приём — сильнейший ход и идёт первым')

  const spent = afterWebAndSpiderTurn()
  const withoutWeb = planNpcTurn(spent, 'spider')
  assert.equal(withoutWeb.some((command) => command.action_id === 'web'), false)
  assert.ok(withoutWeb.some((command) => command.command_type === 'MakeAttack' || command.command_type === 'MoveActor'))

  const recharged = endTurn(spent, 'hero', [6], 'end-hero-plan').events.reduce(applyGameEvent, spent)
  assert.equal(planNpcTurn(recharged, 'spider')[0].action_id, 'web')
})

test('replay событий восстановления даёт то же состояние и не удваивается', () => {
  const spent = afterWebAndSpiderTurn()
  const result = endTurn(spent, 'hero', [6], 'end-hero-replay')
  const applied = result.events.reduce(applyGameEvent, spent)
  assert.deepEqual(replayEvents(spent, result.events), applied)

  const recharged = result.events.find((event) => event.event_type === 'MonsterAbilityRecharged')
  assert.deepEqual(applyGameEvent(applied, recharged).mechanics.conditions, applied.mechanics.conditions)
})

test('порог recharge и бросок восстановления не доходят до игрока', () => {
  const spent = afterWebAndSpiderTurn()
  const result = endTurn(spent, 'hero', [6], 'end-hero-projection')
  const user = { role: 'player', heroIds: ['hero'] }
  const visible = mechanicsForViewer(result.events, user, 'hero', spent)
  const json = JSON.stringify(visible)

  assert.equal(visible.some((event) => event.event_type === 'MonsterAbilityRecharged'), false, 'служебное событие видно игроку')
  assert.doesNotMatch(json, /monster_recharge|recharge_minimum|recharge_action_id/u)
  // Точный профиль существа игроку тоже не выдаётся — ни его действия, ни порог.
  const room = campaignStateForViewer(spent, user, 'hero')
  assert.doesNotMatch(JSON.stringify(room.enemies), /recharge|action_profiles/u)

  // Ведущий видит и бросок, и событие: механика остаётся проверяемой.
  const gm = mechanicsForViewer(result.events, { role: 'admin' }, 'hero', spent)
  assert.equal(gm.some((event) => event.event_type === 'MonsterAbilityRecharged'), true)
})

test('рассказчик объявляет применение приёма и его возвращение без чисел', () => {
  const state = campaignState()
  const used = combatNarration(shootWeb(state).events, state)
  assert.match(used, /пускает в ход «Паутина»/u)

  const spent = afterWebAndSpiderTurn()
  const restored = combatNarration(endTurn(spent, 'hero', [6], 'end-hero-narration').events, spent)
  assert.match(restored, /«Паутина» снова наготове/u)
  assert.doesNotMatch(restored, /[1-6]\s*(?:–|-)\s*6|recharge/iu, 'порог из стат-блока попал в текст')
})

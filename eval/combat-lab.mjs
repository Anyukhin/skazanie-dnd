import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { AuthoritativeExecutor } from '../server/authoritative-executor.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { runNpcTurnScheduler } from '../server/npc-turn-scheduler.mjs'
import { planHeroReaction } from '../server/party-tactics.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState, actorPosition, eventSummary, movementCostOfPath, shortestTacticalPath } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { withStarterKit } from '../server/starter-kit.mjs'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { cellAt, deserializeTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap, setCell, tacticalMapFromLegacyCells } from '../server/tactical-map.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NOW = '2026-09-06T12:00:00.000Z'
const sequence = (prefix) => { let id = 0; return () => `${prefix}-${++id}` }
const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 5
export const COMBAT_SCENARIOS = ['duel', 'approach', 'difficult-terrain', 'two-heroes', 'ranged', 'healing', 'concentration', 'opportunity-attack']

function fixture(scenario) {
  const hero = (id, x, y) => ({ id, character: id, characterClass: 'fighter', level: 1,
    hp: 35, maxHp: 35, armor: 16, speed: 30, proficiency: 2,
    abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
    attackBonus: 5, damageDice: 8, damageBonus: 3, damageType: 'slashing', attackRange: 5,
    inventory: [], x, y })
  const enemy = (id, x, y) => ({ ...hero(id, x, y), name: id, hp: 16, maxHp: 16,
    armor: 12, attackBonus: 4, damageDice: 6, damageBonus: 2, alive: true })
  const players = [hero('hero', 1, 2)]
  const enemies = [enemy('enemy', ['duel', 'opportunity-attack', 'concentration'].includes(scenario) ? 2 : 7, 2)]
  if (scenario === 'approach') enemies[0].speed = 10
  if (scenario === 'two-heroes' || scenario === 'healing') {
    players.push(hero('ally', 1, 3))
    enemies.push(enemy('enemy-2', 7, 3))
  }
  if (scenario === 'ranged') {
    players[0].inventory = withStarterKit({ id: 'hero', characterClass: 'ranger' }, { rulesetId: 'dnd_5e_2014' }).inventory
    for (const item of players[0].inventory) if (item.type === 'weapon') item.equipped = item.combat?.kind === 'ranged'
    players[0].attackRange = players[0].inventory.find((item) => item.type === 'weapon' && item.equipped).combat.normalRange
    players[0].damageType = 'piercing'
    enemies[0].speed = 10
  }
  if (scenario === 'healing') {
    players[1].hp = 1
    players[0].inventory.push({ id: 'potion', catalog_id: 'srd_5_2_1:potion-of-healing',
      name: 'Зелье лечения', type: 'consumable', quantity: 1 })
  }
  if (scenario === 'concentration') {
    Object.assign(players[0], { characterClass: 'cleric', level: 3,
      preparedSpellIds: ['bless', 'sacred-flame'], abilities: { ...players[0].abilities, wis: 16 } })
    enemies[0].hp = enemies[0].maxHp = 30
  }
  const cells = Array.from({ length: 50 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true }))
  const map = tacticalMapFromLegacyCells(cells, { locationId: 'combat-lab' })
  if (scenario === 'difficult-terrain') {
    for (let x = 2; x <= 6; x++) for (let y = 0; y < 5; y++) setCell(map, x, y, { moveCost: 2 })
  }
  return normalizeCampaignState({ sessionCode: 'COMBAT-LAB', campaign: 'Боевой стенд',
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_rule_packs: ['dnd_5e_2014'],
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    partyMemberIds: players.map((actor) => actor.id), activePlayerId: 'hero', players, enemies,
    scene: { title: 'Арена стенда', location: 'combat-lab', turn: 1, cells, map: serializeTacticalMap(map) } })
}

// Бот получает только проекцию игрока. Его стратегия намеренно проста:
// лечение рядом, сближение и атака; правила исполняет настоящий Rules Engine.
function chooseLabCommand(view, actorId, report) {
  const combat = view.mechanics.combat
  if (combat.reaction_window) return planHeroReaction(view, combat.reaction_window).commands[0]
  const hero = view.players.find((actor) => actor.id === actorId)
  const end = { command_type: 'EndTurn', actor_id: actorId }
  if (!hero || hero.hp <= 0) return end
  const economy = combat.action_economy[actorId]
  const from = actorPosition(view, actorId)
  if (economy?.action === false) return end
  const used = (type) => report.steps.some((entry) => entry.command.actor_id === actorId && entry.command.command_type === type)
  if (report.scenario === 'opportunity-attack' && !used('MoveActor')) {
    return { command_type: 'MoveActor', actor_id: actorId, to: { x: 4, y: 2 } }
  }
  if (report.scenario === 'concentration' && !used('CastSpell')) {
    return { command_type: 'CastSpell', actor_id: actorId, spell_id: 'bless', target_id: actorId, target_ids: [actorId] }
  }
  const potion = hero.inventory?.find((item) => item.id === 'potion' && item.quantity > 0)
  const wounded = view.players.find((actor) => actor.hp < actor.maxHp / 3 && distance(from, actorPosition(view, actor.id)) <= 5)
  if (potion && wounded) return { command_type: 'UseItem', actor_id: actorId, item_id: potion.id, target_id: wounded.id }
  const target = [...view.enemies].filter((actor) => actor.alive !== false)
    .sort((a, b) => distance(from, actorPosition(view, a.id)) - distance(from, actorPosition(view, b.id)) || a.id.localeCompare(b.id))[0]
  if (!target) return end
  if (report.scenario === 'concentration') return { command_type: 'CastSpell', actor_id: actorId, spell_id: 'sacred-flame', target_id: target.id }
  const to = actorPosition(view, target.id)
  if (distance(from, to) <= (hero.attackRange ?? 5)) {
    const weapon = hero.inventory?.find((item) => item.type === 'weapon' && item.equipped)
    return { command_type: 'MakeAttack', actor_id: actorId, target_id: target.id, ...(weapon ? { item_id: weapon.id } : {}) }
  }
  // Серверный поиск ожидает точные ОЗ для определения занятости. В проекции
  // врагов их нет: бот дополнительно останавливается перед видимой фишкой.
  const occupied = new Set([...view.players, ...view.enemies]
    .filter((actor) => actor.id !== actorId && actor.alive !== false && (actor.hp == null || actor.hp > 0))
    .map((actor) => { const at = actorPosition(view, actor.id); return `${at.x},${at.y}` }))
  let path = (shortestTacticalPath(view, actorId, to, { allowOccupiedDestination: true }) ?? []).slice(0, -1)
  const blocked = path.findIndex((at) => occupied.has(`${at.x},${at.y}`))
  if (blocked >= 0) path = path.slice(0, blocked)
  const budget = hero.speed + (economy?.movement_bonus ?? 0) - (economy?.movement_spent ?? 0)
  while (path.length && movementCostOfPath(view, actorId, path) > budget) path.pop()
  return path.length ? { command_type: 'MoveActor', actor_id: actorId, to: path.at(-1) } : end
}

function assertState(state) {
  for (const actor of [...state.players, ...state.enemies]) {
    assert.ok(Number.isFinite(actor.hp) && actor.hp >= 0 && actor.hp <= actor.maxHp, `ОЗ вне диапазона: ${actor.id}`)
    if (actor.hp === 0) assert.equal(state.mechanics.concentration[actor.id], undefined, `Концентрация сохранилась при 0 ОЗ: ${actor.id}`)
  }
  for (const [id, economy] of Object.entries(state.mechanics.combat.action_economy)) {
    assert.ok(Number.isFinite(economy.movement_spent) && economy.movement_spent >= 0, `Некорректное движение: ${id}`)
  }
  for (const [id, resources] of Object.entries(state.mechanics.resources)) {
    for (const [name, resource] of Object.entries(resources)) {
      assert.ok(Number.isFinite(resource.current) && resource.current >= 0 && resource.current <= resource.max,
        `Ресурс вне диапазона: ${id}/${name}`)
    }
  }
  const initiative = state.mechanics.combat.initiative.map((entry) => entry.actor_id)
  assert.equal(new Set(initiative).size, initiative.length, 'Участник продублирован в инициативе')
}

// Независимые проверки для состава этих арен: одно оружейное действие за ход,
// без Extra Attack/Action Surge. Здесь не вызываются расчётчики Rules Engine.
export function combatEventChecker(initial) {
  const actors = new Map([...initial.players, ...initial.enemies].map((actor) => [actor.id, actor]))
  const map = deserializeTacticalMap(initial.scene.map)
  const economies = new Map()
  const positions = new Map([...actors].map(([id, actor]) => [id, { x: actor.x, y: actor.y }]))
  const concentration = new Set()
  const failedConcentration = new Set()
  const opportunityAttacks = new Map()
  const damage = new Map()
  let initiative = []
  let active = null
  const spend = (id, kind) => {
    const budget = economies.get(id) ?? { action: 0, bonus_action: 0, reaction: 0, movement: 0 }
    budget[kind]++
    assert.ok(budget[kind] <= 1, `${id}: повторно потрачено ${kind} до следующего хода`)
    if (kind !== 'reaction') assert.equal(id, active, `${id}: действие вне своего хода`)
    economies.set(id, budget)
  }
  return (events) => {
    for (const event of events) {
      const p = event.payload
      const id = event.actor_id
      if (event.event_type === 'CombatStarted') initiative = p.initiative.map((entry) => entry.actor_id)
      if (event.event_type === 'TurnStarted') {
        active = initiative[p.active_index]
        economies.set(active, { action: 0, bonus_action: 0, reaction: 0, movement: 0 })
      }
      if (event.event_type === 'AttackResolved') {
        if (!p.reaction_attack) spend(id, 'action')
        else {
          assert.equal(opportunityAttacks.get(id), p.target_id, 'Атака реакцией не соответствует владельцу или цели реакции')
          opportunityAttacks.delete(id)
        }
        assert.equal(p.total, p.kept + p.modifier, 'Неверная сумма броска атаки')
        assert.equal(p.hit, p.kept === 20 || (p.kept !== 1 && p.total >= p.armor_class), 'Неверный результат атаки')
      }
      if (event.event_type === 'SpellCast') spend(id, p.action_type)
      if (event.event_type === 'ItemUsed') spend(id, p.combat_action)
      if (event.event_type === 'CombatActionUsed' && ['action', 'bonus_action', 'reaction'].includes(p.action_type)) spend(id, p.action_type)
      if (event.event_type === 'CombatActionUsed' && p.action_id === 'opportunity-attack') opportunityAttacks.set(id, p.target_id)
      if (event.event_type === 'ActorMoved') {
        assert.deepEqual(p.from, positions.get(id), 'Перемещение начинается не из текущей клетки')
        assert.deepEqual(p.path.at(-1), p.to, 'Конец пути расходится с целью')
        let previous = p.from
        let cost = 0
        for (const at of p.path) {
          assert.equal(distance(previous, at), 5, 'Путь перескакивает клетку')
          const cell = cellAt(map, at.x, at.y)
          assert.ok(cell?.passable, 'Путь проходит сквозь стену')
          cost += cell.moveCost > 1 ? 10 : 5
          previous = at
        }
        assert.equal(p.movement_cost, cost, 'Неверная стоимость пути по правилам 2014')
        if (p.spend_movement) {
          const budget = economies.get(id)
          budget.movement += cost
          assert.ok(budget.movement <= actors.get(id).speed, `${id}: превышена скорость`)
        }
        positions.set(id, p.to)
      }
      if (event.event_type === 'ConcentrationStarted') {
        assert.ok(!concentration.has(id), 'Две концентрации одновременно')
        concentration.add(id)
      }
      if (event.event_type === 'ConcentrationEnded') {
        concentration.delete(id)
        failedConcentration.delete(id)
      }
      if (event.event_type === 'DamageApplied') {
        damage.set(event.target_ids[0], p.applied_amount)
        assert.equal(p.hp_after, Math.max(0, p.hp_before - p.applied_amount), 'ОЗ после урона не соответствуют событию')
      }
      if (event.event_type === 'HealingApplied') assert.equal(p.hp_after, p.hp_before + p.applied_amount, 'ОЗ после лечения не соответствуют событию')
      if (event.event_type === 'ConcentrationSavingThrowResolved') {
        assert.ok(concentration.has(id), 'Спасбросок без концентрации')
        assert.equal(p.difficulty, Math.max(10, Math.floor(damage.get(id) / 2)), 'Неверная СЛ концентрации')
        assert.equal(p.saved, p.total >= p.difficulty, 'Неверный исход спасброска концентрации')
        if (!p.saved) failedConcentration.add(id)
      }
      if (event.event_type === 'ResourceSpent') assert.equal(p.after, p.before - p.amount, 'Неверное списание ресурса')
    }
    assert.equal(failedConcentration.size, 0, 'Провал спасброска не завершил концентрацию')
    assert.equal(opportunityAttacks.size, 0, 'Потраченная реакция не разрешила атаку')
  }
}

function abortIfRequested(signal) {
  if (!signal?.aborted) return
  const error = new Error('Бой отменён')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  throw error
}

function frameCells(state) {
  const sceneCells = Array.isArray(state?.scene?.cells) ? state.scene.cells : []
  let map = null
  try {
    map = state?.scene?.map ? deserializeTacticalMap(state.scene.map) : null
  } catch { /* повреждённую карту не даём наблюдателю уронить сам прогон */ }
  const cells = sceneCells.length
    ? sceneCells
    : map ? legacyCellsFromTacticalMap(map) : []
  return cells.map((raw) => {
    const cell = map ? cellAt(map, Number(raw.x), Number(raw.y)) : null
    const result = {
      x: Number(raw.x),
      y: Number(raw.y),
      type: String(raw.type || (cell?.passable === false ? 'wall' : 'floor')),
    }
    if (Boolean(raw.difficult) || Number(raw.moveCost ?? cell?.moveCost) > 1) result.difficult = true
    return result
  })
}

const FRAME_ACTOR_NAMES = Object.freeze({
  hero: 'Воин',
  ally: 'Союзник',
  enemy: 'Противник',
  'enemy-2': 'Второй противник',
})

function actorDisplayName(actor) {
  const id = String(actor?.id ?? '')
  const name = String(actor?.name || actor?.character || '').trim()
  return name && name !== id ? name : (FRAME_ACTOR_NAMES[id] || id)
}

function frameEventText(event, names) {
  const resolveName = (id) => names.get(String(id)) ?? id
  const summary = eventSummary(event, resolveName)
  const payload = event.payload ?? {}
  if (event.event_type === 'SpellCast') {
    return `${resolveName(event.actor_id) || 'Герой'} накладывает заклинание «${payload.spell_name || payload.name || payload.spell_id || 'заклинание'}»`
  }
  if (event.event_type === 'ConcentrationStarted') return `${resolveName(event.actor_id) || 'Герой'} начинает концентрацию`
  if (event.event_type === 'ConcentrationEnded') return 'Концентрация прекращена'
  if (event.event_type === 'ConcentrationCheckRequired') return 'Получен урон: требуется проверка концентрации'
  if (event.event_type === 'ReactionWindowOpened') return 'Открыта возможность реакции'
  if (event.event_type === 'ReactionWindowClosed') return 'Реакция разрешена; бой продолжается'
  if (event.event_type === 'ReactionDamageReduced') return 'Реакция уменьшила полученный урон'
  if (event.event_type === 'ConditionAdded' && payload.condition === 'shielded') return 'Действует заклинание «Щит»'
  if (event.event_type === 'ConditionAdded' && payload.condition === 'bless-d4') return 'Действует «Благословение»'
  if (event.event_type === 'ResourceSpent' && String(payload.resource || '').startsWith('spell_slots_')) {
    return `${resolveName(event.actor_id) || 'Герой'} расходует ячейку заклинания`
  }
  return payload.spell_id ? summary.replace(String(payload.spell_id), canonicalCombatSpellFor(payload.spell_id)?.name ?? String(payload.spell_id)) : summary
}

function combatFrame(state, events, index) {
  const players = Array.isArray(state?.players) ? state.players : []
  const enemies = Array.isArray(state?.enemies) ? state.enemies : []
  const all = [...players.map((actor) => ({ actor, side: 'party' })), ...enemies.map((actor) => ({ actor, side: 'enemy' }))]
  const names = new Map(all.map(({ actor }) => [String(actor.id), actorDisplayName(actor)]))
  const combat = state?.mechanics?.combat
  const initiative = Array.isArray(combat?.initiative) ? combat.initiative : []
  const activeIndex = Number.isSafeInteger(combat?.active_index) ? combat.active_index : -1
  return {
    index,
    round: Number(combat?.round ?? state?.scene?.turn ?? 0),
    activeActorId: initiative[activeIndex]?.actor_id ?? null,
    actors: all.map(({ actor, side }) => {
      const position = actorPosition(state, actor.id) ?? { x: actor.x, y: actor.y }
      return {
        id: String(actor.id),
        name: actorDisplayName(actor),
        side,
        hp: Number(actor.hp ?? 0),
        maxHp: Number(actor.maxHp ?? actor.hp ?? 0),
        x: Number(position?.x ?? 0),
        y: Number(position?.y ?? 0),
        image: actor.image || actor.portrait,
        conditions: (state.mechanics?.conditions?.[actor.id] ?? []).map((condition) => String(condition.id ?? condition)),
        resources: state.mechanics?.resources?.[actor.id] ?? {},
        arsenal: [
          ...(actor.combatSpells ?? []).filter((spell) => spell.prepared !== false).map((spell) => ({ name: spell.name, status: spell.mechanicsSupport ?? 'partial' })),
          ...(actor.combatActions ?? []).filter((action) => action.category !== 'common').map((action) => ({ name: action.name, status: action.mechanicsSupport ?? 'partial' })),
          ...(actor.action_profiles ?? []).map((action) => ({ name: action.name, status: 'verified' })),
          ...(actor.spellcasting?.spells ?? []).map((spell) => ({ name: canonicalCombatSpellFor(spell.spell_id ?? spell.id)?.name ?? spell.spell_id ?? spell.id, status: canonicalCombatSpellFor(spell.spell_id ?? spell.id)?.mechanicsSupport ?? 'partial' })),
        ],
      }
    }),
    cells: frameCells(state),
    map: state.scene?.map,
    gameEvents: events,
    events: (Array.isArray(events) ? events : []).map((event, eventIndex) => ({
      id: String(event.event_id || `${index}-${eventIndex}-${event.event_type}`),
      text: String(frameEventText(event, names)),
      actorId: event.actor_id == null ? null : String(event.actor_id),
    })),
  }
}

function observedEventStore(eventStore, { onFrame, signal, takeTactic = () => null }) {
  let frameIndex = 0
  const notify = async (state, events) => {
    if (typeof onFrame !== 'function') return
    const frame = combatFrame(state, events, ++frameIndex)
    const tactic = takeTactic()
    if (tactic) frame.events.unshift({ id: `tactic-${frameIndex}`, actorId: tactic.actorId, text: `Тактика: ${tactic.text}` })
    await onFrame(frame)
  }
  return new Proxy(eventStore, {
    get(target, property, receiver) {
      if (property === 'commit') {
        return async (input) => {
          abortIfRequested(signal)
          const committed = await target.commit(input)
          await notify(committed.state, committed.events)
          abortIfRequested(signal)
          return committed
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Один воспроизводимый бой. Отчёт содержит также отказавшую команду. */
export async function runCombatScenario({ scenario = 'duel', seed = 1, maxSteps = 160, onFrame, signal, initialState: customState = null, chooseCommand = null } = {}) {
  assert.ok(COMBAT_SCENARIOS.includes(scenario) || (scenario === 'custom' && customState && typeof chooseCommand === 'function'), `Неизвестный сценарий: ${scenario}`)
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'seed: целое число 0..4294967295')
  assert.ok(Number.isSafeInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1000, 'maxSteps: целое число 1..1000')
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-combat-lab-'))
  let rngState = seed >>> 0
  const rolls = []
  const rng = { randint(min, max) {
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0
    const value = min + Math.floor(rngState / 0x100000000 * (max - min + 1))
    rolls.push({ min, max, value })
    return value
  } }
  const options = { rootDir: storage, reducer: applyGameEvent, normalizeState: normalizeCampaignState,
    snapshotEvery: 7, clock: () => new Date(NOW), idFactory: sequence('commit') }
  const eventStore = new FileEventStore(options)
  const rulesEngine = new RulesEngine({ diceService: new DiceService({ rng, idFactory: sequence('roll'), now: () => NOW }) })
  const initialState = customState ? normalizeCampaignState(structuredClone(customState)) : fixture(scenario)
  // Независимый счётчик маленьких арен не применим к Extra Attack, легендарным
  // действиям и произвольным эффектам. Общие проверки состояния/replay остаются.
  const checkEvents = customState ? () => {} : combatEventChecker(initialState)
  const report = { schema: 'combat-lab/v1', rng: 'lcg32-1664525-1013904223/v1', scenario, seed, initial_state: initialState, steps: [], rolls, passed: false }
  const campaignId = initialState.sessionCode
  let pendingTactic = null
  const observedStore = observedEventStore(eventStore, { onFrame, signal, takeTactic: () => {
    const value = pendingTactic; pendingTactic = null; return value
  } })
  const observedExecutor = new AuthoritativeExecutor({ eventStore: observedStore, rulesEngine })
  try {
    abortIfRequested(signal)
    await eventStore.initializeCampaign({ campaign_id: campaignId, initial_state: initialState })
    if (typeof onFrame === 'function') await onFrame(combatFrame(initialState, [], 0))
    abortIfRequested(signal)
    let command = { command_type: 'StartCombat', actor_id: initialState.players[0].id }
    let tactic = null
    for (let step = 0; step < maxSteps; step++) {
      abortIfRequested(signal)
      const before = (await eventStore.load(campaignId)).state
      const key = `lab-${step}`
      const entry = { step, command, before_version: before.state_version, ...(tactic ? { tactic } : {}) }
      report.steps.push(entry)
      pendingTactic = tactic ? { text: tactic, actorId: command.actor_id } : null
      const input = { campaignId, idempotencyKey: key, commands: [{ ...command, command_id: `lab-command-${step}`, server_authoritative: true }],
        actorIds: [command.actor_id], context: { serverAuthoritativeCombat: true, allowedActorIds: [command.actor_id] } }
      const committed = await observedExecutor.executeCommands(input)
      entry.events = committed.events
      checkEvents(committed.events)
      const rollCount = rolls.length
      const duplicate = await observedExecutor.executeCommands(input)
      assert.equal(duplicate.replayed, true, 'Повтор команды создал новый коммит')
      assert.equal(rolls.length, rollCount, 'Повтор команды сделал новые броски')
      assert.deepEqual(duplicate.events, committed.events)
      assert.equal((await eventStore.load(campaignId)).state_version, committed.state_version)
      const afterPlayer = (await eventStore.load(campaignId)).state
      assertState(afterPlayer)
      if (!customState && command.command_type === 'MakeAttack' && !afterPlayer.mechanics.combat.reaction_window
        && afterPlayer.enemies.some((actor) => actor.id === command.target_id && actor.hp > 0 && actor.alive !== false)) {
        // Новый ключ не должен превращать вторую атаку в разрешённую. В этих
        // аренах у героев нет Extra Attack и Action Surge.
        entry.rejected_probe = { command, idempotency_key: `${key}-extra-attack` }
        await assert.rejects(() => observedExecutor.executeCommands({ ...input, idempotencyKey: entry.rejected_probe.idempotency_key,
          commands: [{ ...input.commands[0], command_id: `${key}-extra-attack` }] }), (error) => {
          entry.rejected_probe.code = error.code
          return error.code === 'ACTION_SPENT'
        })
        assert.deepEqual((await eventStore.load(campaignId)).state, afterPlayer, 'Отказ второй атаке изменил состояние')
        assert.equal(rolls.length, rollCount, 'Отказ второй атаке сделал новый бросок')
      }
      const settled = await runNpcTurnScheduler({ campaignId, eventStore: observedStore, rulesEngine,
        advanceNpc: ['StartCombat', 'EndTurn'].includes(command.command_type) || Boolean(before.mechanics.combat.reaction_window) })
      entry.npc_turns = settled.turns
      entry.npc_events = settled.events
      checkEvents(settled.events)
      const state = (await eventStore.load(campaignId)).state
      assertState(state)
      entry.after_version = state.state_version
      // Проверка воспроизведения выполняется после каждого шага, включая ходы NPC.
      assert.deepEqual((await eventStore.replay(campaignId, { use_snapshots: false })).state, state, 'Replay расходится с текущим состоянием')
      if (!state.mechanics.combat.active) {
        const incapacitated = (actor) => actor.hp <= 0 || actor.alive === false
          || state.mechanics.resting?.[actor.id]?.reason === 'knockout'
          || (state.mechanics.conditions?.[actor.id] ?? []).some((condition) => (condition.id ?? condition) === 'unconscious')
        assert.equal(state.mechanics.combat.reaction_window, null, 'Бой завершился с открытой реакцией')
        for (const hero of state.players) {
          if (hero.hp === 0 && state.mechanics.death.heroes[hero.id]?.status !== 'dead') {
            assert.equal(state.mechanics.death.saving_throws[hero.id]?.stable, true, 'Бой завершился до спасбросков от смерти')
          }
        }
        assert.ok(state.enemies.every(incapacitated)
          || state.players.every(incapacitated), 'Бой завершился при двух боеспособных сторонах')
        const ended = [...committed.events, ...settled.events].findLast((event) => event.event_type === 'CombatEnded')
        assert.ok(ended, 'Нет события завершения боя')
        if (ended.payload.reason === 'enemies_defeated') {
          assert.ok(state.enemies.every(incapacitated), 'Объявлена победа над боеспособным противником')
        } else {
          assert.ok(['party_defeated', 'party_incapacitated'].includes(ended.payload.reason), 'Неожиданная причина завершения арены')
          assert.ok(state.players.every(incapacitated), 'Объявлено поражение боеспособного отряда')
        }
        assert.deepEqual((await new FileEventStore(options).load(campaignId)).state, state, 'Состояние изменилось при повторном открытии хранилища')
        report.passed = true
        report.final_state = state
        break
      }
      const actorId = state.mechanics.combat.reaction_window?.actor_id
        ?? state.mechanics.combat.initiative[state.mechanics.combat.active_index]?.actor_id
      assert.ok(state.players.some((actor) => actor.id === actorId), 'Планировщик не вернул управление игроку')
      const view = campaignStateForViewer(state, { id: `user-${actorId}`, role: 'player', heroIds: [actorId] }, actorId)
      for (const enemy of view.enemies) assert.equal(enemy.hp, undefined, 'Проекция раскрывает точные ОЗ противника')
      if (chooseCommand) {
        const plan = chooseCommand(view, actorId)
        command = plan.command
        tactic = plan.reason
      } else command = chooseLabCommand(view, actorId, report)
    }
    assert.ok(report.passed, `Бой не завершён за ${maxSteps} шагов`)
  } catch (error) {
    report.error = { message: error.message, code: error.code, stack: error.stack }
  } finally {
    report.events = await eventStore.getEvents(campaignId).catch(() => [])
    report.event_counts = {}
    for (const event of report.events) report.event_counts[event.event_type] = (report.event_counts[event.event_type] ?? 0) + 1
    report.outcome = report.events.findLast((event) => event.event_type === 'CombatEnded')?.payload.reason ?? null
    report.final_state ??= (await eventStore.load(campaignId).catch(() => null))?.state
    // Планировщик мог записать часть ходов NPC, а затем выбросить ошибку.
    // Читаемый журнал должен включать и эти последние подтверждённые события.
    const last = report.steps.at(-1)
    if (last && !last.npc_events) {
      const recorded = new Set((last.events ?? []).map((event) => event.event_id))
      last.npc_events = report.events.filter((event) => event.state_version_before >= last.before_version && !recorded.has(event.event_id))
    }
    rmSync(storage, { recursive: true, force: true })
  }
  return report
}

async function main() {
  const { values } = parseArgs({ options: { scenario: { type: 'string' }, seed: { type: 'string', default: '1' },
    runs: { type: 'string', default: '3' }, out: { type: 'string', default: 'tmp/combat-lab' } } })
  const runs = Number(values.runs)
  const seed = Number(values.seed)
  assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 1000, 'runs: целое число 1..1000')
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed + runs - 1 <= 0xffffffff, 'Недопустимый диапазон seed')
  const scenarios = values.scenario ? [values.scenario] : COMBAT_SCENARIOS
  assert.ok(scenarios.every((scenario) => COMBAT_SCENARIOS.includes(scenario)), 'Неизвестный сценарий')
  const out = resolve(ROOT, values.out)
  mkdirSync(out, { recursive: true })
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim())
  const harness_sha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  const summary = { revision, dirty, harness_sha256, complete: false, runs: [], passed: true }
  const saveSummary = () => writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  saveSummary()
  for (const scenario of scenarios) for (let index = 0; index < runs; index++) {
    const report = await runCombatScenario({ scenario, seed: seed + index })
    const filename = `${scenario}-${report.seed}.json`
    writeFileSync(join(out, filename), JSON.stringify({ revision, dirty, harness_sha256, ...report }, null, 2))
    const journal = [`# ${scenario} · seed ${report.seed}`, '', report.passed ? 'Проверки пройдены.' : `Ошибка: ${report.error.message}`,
      '', `Повтор: \`pnpm combat:lab --scenario ${scenario} --seed ${report.seed} --runs 1\``,
      '', `Версия: ${revision}${dirty ? ' (есть незакоммиченные изменения)' : ''}`, '', '## Ходы', '']
    for (const step of report.steps) {
      journal.push(`### ${step.step + 1}. ${step.command.actor_id}: ${step.command.command_type}`, '',
        `Команда: \`${JSON.stringify(step.command)}\``, '')
      for (const event of [...(step.events ?? []), ...(step.npc_events ?? [])]) journal.push(`- ${event.actor_id}: ${eventSummary(event)}`)
      if (step.rejected_probe) journal.push(`- Проверка запрета второй атаки: ${step.rejected_probe.code ?? 'неожиданный результат'}`)
      journal.push('')
    }
    writeFileSync(join(out, `${scenario}-${report.seed}.md`), journal.join('\n'))
    summary.runs.push({ scenario, seed: report.seed, passed: report.passed, outcome: report.outcome,
      steps: report.steps.length, file: filename, error: report.error?.message })
    summary.passed &&= report.passed
    saveSummary()
    console.log(`${report.passed ? 'PASS' : 'FAIL'} ${scenario} seed=${report.seed} шагов=${report.steps.length}${report.error ? `: ${report.error.message}` : ''}`)
  }
  summary.complete = true
  saveSummary()
  if (!summary.passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

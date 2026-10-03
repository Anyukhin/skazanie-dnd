/**
 * Прогон боёв через настоящий HTTP (eval, в тесты не входит).
 *
 * Поднимает изолированный сервер на временном хранилище, создаёт отряд 2024 из
 * четырёх героев 3-го уровня со стартовыми наборами и прогоняет встречи,
 * которые собирает сам сервер, по всем темам бестиария. За героев играет
 * простой бот: жрица лечит упавших и бьёт «Священным пламенем», маг —
 * «Огненным снарядом», остальные подходят и бьют надетым оружием. Ячейки,
 * «Всплеск действий» и скрытую атаку бот не тратит — исход боя показывает
 * нижнюю границу силы отряда, а не баланс.
 *
 * Печатает исходы со статистикой попаданий и урона и аномалии: ответы 500,
 * отказы на законные команды, зависший или затянувшийся бой.
 *
 *   node eval/combat-http-soak.mjs
 *   SOAK_DIFFICULTIES=medium,hard SOAK_SEEDS=2 SOAK_THEME=crypt node eval/combat-http-soak.mjs
 *
 * Найдено им 2026-10-04: свободная заявка «бью» уходила безоружным ударом.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveCharacterSheet } from '../server/character-lifecycle.mjs'
import { ENCOUNTER_THEMES } from '../server/encounter-assembler.mjs'
import { applyGameEvent, normalizeCampaignState, previewApproachAttack } from '../server/rules-engine.mjs'
import { shortestTacticalPath } from '../server/rules/tactical-geometry.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { STARTER_KIT_2024_POLICY, withStarterKit } from '../server/starter-kit.mjs'

const PORT = Number(process.env.SOAK_PORT || 8797)
const base = `http://127.0.0.1:${PORT}`
const storage = mkdtempSync(join(tmpdir(), 'skazanie-http-soak-'))
const setupToken = 'http-soak-setup'
let logs = ''
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(PORT), DND_STORAGE_DIR: storage, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: setupToken, GAME_ENGINE_MODE: 'enforce', COOKIE_SECURE: 'false', NODE_ENV: 'test', DND_COMBAT_TURN_TIMEOUT_MS: '3600000' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => { logs += chunk })
child.stderr.on('data', (chunk) => { logs += chunk })
const stop = () => { try { child.kill() } catch {} }
process.on('exit', stop)

async function request(path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: response.status, body: json, text, response }
}
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { if ((await request('/api/health')).status === 200) break } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100))
}
const setup = await request('/api/auth/setup-admin', { method: 'POST', body: { name: 'Soak', email: 'soak@example.test', password: 'soak-admin-password-1', setupToken } })
const cookie = setup.response.headers.get('set-cookie')?.split(';')[0]
const users = await request('/api/admin/users', { cookie })
const adminId = users.body.users.find((user) => user.email === 'soak@example.test').id

const HEROES = [
  { id: 'fighter', character: 'Воин', characterClass: 'fighter', abilities: { str: 16, dex: 12, con: 15, int: 10, wis: 13, cha: 8 }, x: 1, y: 5 },
  { id: 'cleric', character: 'Жрица', characterClass: 'cleric', subclass: 'Домен жизни', abilities: { str: 13, dex: 10, con: 14, int: 8, wis: 16, cha: 12 }, x: 1, y: 7, preparedSpellIds: ['sacred-flame', 'healing-word', 'guiding-bolt', 'cure-wounds'], knownSpellIds: ['sacred-flame', 'healing-word', 'guiding-bolt', 'cure-wounds'] },
  { id: 'rogue', character: 'Плут', characterClass: 'rogue', abilities: { str: 8, dex: 16, con: 14, int: 13, wis: 10, cha: 12 }, x: 2, y: 6 },
  { id: 'wizard', character: 'Маг', characterClass: 'wizard', abilities: { str: 8, dex: 14, con: 13, int: 16, wis: 12, cha: 10 }, x: 0, y: 6, preparedSpellIds: ['fire-bolt', 'magic-missile'], knownSpellIds: ['fire-bolt', 'magic-missile'] },
]
function hero(seed) {
  const kitted = withStarterKit({ ...seed, level: 3, inventory: [], currency: {} }, { rulesetId: 'srd_5_2_1', starterPolicyId: STARTER_KIT_2024_POLICY.policy_id })
  const sheet = deriveCharacterSheet(kitted, { rulesetId: 'srd_5_2_1' })
  return { ...kitted, name: seed.character, hp: sheet.hit_points.value, maxHp: sheet.hit_points.value, armor: sheet.armor_class.value, speed: sheet.speed.value, proficiency: sheet.proficiency_bonus }
}
function cells(width = 22, height = 13) {
  const result = []
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) result.push({ x, y, type: 'floor', revealed: true })
  return result
}
const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 5
const anomalies = []
const outcomes = []
let commandSeq = 0
async function send(code, commandOrList, label) {
  const commands = Array.isArray(commandOrList) ? commandOrList : [commandOrList]
  const result = await request(`/api/campaigns/${code}/commands`, { method: 'POST', cookie, body: { commands, idempotency_key: `soak-${code}-${commandSeq += 1}`, message: label } })
  if (result.status >= 500) anomalies.push({ code, kind: 'http-500', label, commands, error: result.text.slice(0, 300) })
  return result
}

async function runEncounter(code, theme, difficulty, seed) {
  const state = { sessionCode: code, campaign: `Прогон ${code}`, partyMemberIds: HEROES.map((entry) => entry.id), activePlayerId: 'fighter', messages: [],
    players: HEROES.map(hero), scene: { turn: 1, title: 'Поле', location: `soak-${code.toLowerCase()}`, cells: cells() }, engine_mode: 'enforce' }
  const created = await request('/api/campaigns', { method: 'POST', cookie, body: { code, name: state.campaign, state } })
  if (created.status !== 201) { anomalies.push({ code, kind: 'create', error: created.text.slice(0, 300) }); return }
  await request(`/api/admin/users/${adminId}`, { method: 'PATCH', cookie, body: { heroIds: HEROES.map((entry) => entry.id) } })
  const room = await request(`/api/rooms/${code}`, { cookie })
  const assembled = await request(`/api/campaigns/${code}/encounters/assemble`, { method: 'POST', cookie, body: { expected_state_version: room.body.state.state_version, difficulty, theme, seed: `soak-${seed}`, idempotency_key: `soak-enc-${code}` } })
  if (assembled.status !== 200) { anomalies.push({ code, kind: 'assemble', theme, difficulty, error: assembled.text.slice(0, 300) }); return }
  let lastVersion = -1
  let stuck = 0
  for (let step = 0; step < 400; step += 1) {
    const current = (await request(`/api/rooms/${code}`, { cookie })).body.state
    const combat = current.mechanics.combat
    if (!combat.active) {
      const ended = (current.battleLog ?? []).findLast((entry) => entry.type === 'combat-end')
      outcomes.push({ code, theme, difficulty, round: combat.round, reason: ended?.reason ?? '?', enemies: (current.enemies ?? []).map((enemy) => enemy.name).join(', '), heroesUp: current.players.filter((player) => player.hp > 0).length })
      const store = new FileEventStore({ rootDir: join(storage, 'engine'), reducer: applyGameEvent, normalizeState: normalizeCampaignState })
      const list = await store.getEvents(code, { after_version: 0 })
      const heroIds = new Set(current.players.map((player) => player.id))
      const stat = { heroAttacks: 0, heroHits: 0, heroDamage: 0, enemyAttacks: 0, enemyHits: 0, enemyDamage: 0, heroSpells: 0, perHero: {} }
      for (const event of list) {
        const side = heroIds.has(String(event.actor_id)) ? 'hero' : 'enemy'
        if (event.event_type === 'AttackResolved') { stat[side + 'Attacks'] += 1; if (event.payload?.hit) stat[side + 'Hits'] += 1 }
        if (event.event_type === 'DamageApplied') { const target = String(event.target_ids?.[0] ?? ''); const amount = Number(event.payload?.applied_amount) || 0; if (heroIds.has(target)) stat.enemyDamage += amount; else { stat.heroDamage += amount; stat.perHero[event.actor_id] = (stat.perHero[event.actor_id] ?? 0) + amount } }
        if (event.event_type === 'SpellCast' && heroIds.has(String(event.actor_id))) stat.heroSpells += 1
      }
      outcomes.at(-1).stat = { ...stat, events: list.length, heroes: current.players.map((p) => p.id + ':' + p.maxHp + '/AC' + p.armor).join(' '), enemyHp: (current.enemies ?? []).map((e) => e.name + ':' + e.maxHp + '/AC' + e.armor).join(' ') }
      return
    }
    if (current.state_version === lastVersion) stuck += 1
    else { stuck = 0; lastVersion = current.state_version }
    if (stuck > 3) { anomalies.push({ code, kind: 'stuck', theme, difficulty, active: combat.initiative[combat.active_index]?.actor_id, window: combat.reaction_window?.trigger ?? null }); return }
    if (combat.round > 40) {
      anomalies.push({ code, kind: 'long', theme, difficulty, round: combat.round })
      console.log('LONG players', JSON.stringify(current.players.map((p) => [p.id, p.hp, current.mechanics.death?.saving_throws?.[p.id], (current.mechanics.conditions[p.id] ?? []).map((c) => c.id)])))
      console.log('LONG enemies', JSON.stringify((current.enemies ?? []).map((e) => [e.name, e.hp, e.alive, current.mechanics.positions[e.id]])))
      console.log('LONG log', JSON.stringify((current.battleLog ?? []).slice(-25).map((e) => [e.round, e.type, e.actorId, e.targetId, e.roll?.hit, e.damage])))
      return
    }
    const window = combat.reaction_window
    if (window) {
      const declined = await send(code, { command_type: 'UseCombatAction', actor_id: window.actor_id, action_id: 'decline-reaction' }, 'Пропустить реакцию')
      if (declined.status !== 200) anomalies.push({ code, kind: 'decline', status: declined.status, error: declined.text.slice(0, 200) })
      continue
    }
    const activeId = String(combat.initiative[combat.active_index]?.actor_id ?? '')
    const me = current.players.find((player) => player.id === activeId)
    if (!me) { await new Promise((resolve) => setTimeout(resolve, 200)); continue }
    const at = current.mechanics.positions[activeId] ?? me
    const enemies = (current.enemies ?? []).filter((enemy) => enemy.alive !== false && enemy.hp > 0)
      .map((enemy) => ({ enemy, at: current.mechanics.positions[enemy.id] ?? enemy }))
      .sort((left, right) => distance(at, left.at) - distance(at, right.at))
    if (me.hp > 0 && enemies.length) {
      const target = enemies[0]
      let acted = false
      if (activeId === 'cleric') {
        const fallen = current.players.find((player) => player.hp <= 0 && current.mechanics.death?.heroes?.[player.id]?.status !== 'dead' && distance(at, current.mechanics.positions[player.id] ?? player) <= 60)
        if (fallen && (current.mechanics.resources.cleric?.spell_slots_1?.current ?? 0) > 0) {
          const healed = await send(code, { command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'healing-word', target_id: fallen.id, slot_level: 1 }, 'Лечащее слово')
          if (healed.status !== 200) anomalies.push({ code, kind: 'heal-refused', status: healed.status, error: healed.text.slice(0, 200) })
        }
        if (distance(at, target.at) <= 60) {
          const flame = await send(code, { command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'sacred-flame', target_id: target.enemy.id }, 'Священное пламя')
          acted = flame.status === 200
          if (flame.status !== 200 && flame.status < 500) anomalies.push({ code, kind: 'flame-refused', error: flame.text.slice(0, 160) })
        }
      } else if (activeId === 'wizard' && distance(at, target.at) <= 120) {
        const bolt = await send(code, { command_type: 'CastSpell', actor_id: 'wizard', spell_id: 'fire-bolt', target_id: target.enemy.id }, 'Огненный снаряд')
        acted = bolt.status === 200
        if (bolt.status !== 200 && bolt.status < 500 && !/TRAJECTORY|COVER|VISIBLE/u.test(bolt.text)) anomalies.push({ code, kind: 'bolt-refused', error: bolt.text.slice(0, 160) })
      }
      if (!acted) {
        const fresh = (await request(`/api/rooms/${code}`, { cookie })).body.state
        if (fresh.mechanics.combat.active && fresh.mechanics.combat.initiative[fresh.mechanics.combat.active_index]?.actor_id === activeId && fresh.mechanics.combat.action_economy[activeId]?.action !== false) {
          const freshTarget = (fresh.enemies ?? []).find((enemy) => enemy.id === target.enemy.id && enemy.hp > 0)
          if (freshTarget) {
            let route = null
            try { route = previewApproachAttack(fresh, activeId, freshTarget.id) } catch (error) { route = null }
            if (!route) {
              // Не дотянуться за ход — подойти ближе.
              const targetAt = fresh.mechanics.positions[freshTarget.id] ?? freshTarget
              const fromAt = fresh.mechanics.positions[activeId]
              const path = (shortestTacticalPath(fresh, activeId, targetAt, { allowOccupiedDestination: true }) ?? []).slice(0, -1)
              const budget = Math.floor((Number(fresh.players.find((p) => p.id === activeId)?.speed) || 30) / 5)
              const stop = path.slice(0, budget)
              const occupied = new Set([...fresh.players, ...(fresh.enemies ?? [])].filter((a) => a.id !== activeId).map((a) => { const p = fresh.mechanics.positions[a.id] ?? a; return p.x + ',' + p.y }))
              while (stop.length && occupied.has(stop.at(-1).x + ',' + stop.at(-1).y)) stop.pop()
              if (stop.length && fromAt) {
                const moved = await send(code, { command_type: 'MoveActor', actor_id: activeId, to: stop.at(-1) }, 'Подойти')
                if (moved.status !== 200 && moved.status < 500 && !/SPEED|PATH|DIFFICULT|OCCUPIED|DESTINATION/u.test(moved.text)) anomalies.push({ code, kind: 'move-refused', actor: activeId, error: moved.text.slice(0, 200) })
              }
            }
            if (route) {
              for (const command of route.commands) {
                const { server_authoritative, ...clean } = command
                const sent = await send(code, clean, command.command_type === 'MoveActor' ? 'Подойти' : 'Ударить')
                if (sent.status !== 200 && sent.status < 500) { anomalies.push({ code, kind: 'approach-refused', actor: activeId, step: command.command_type, error: sent.text.slice(0, 200) }); break }
              }
            }
          }
        }
      }
    }
    const after = (await request(`/api/rooms/${code}`, { cookie })).body.state
    if (!after.mechanics.combat.active || after.mechanics.combat.reaction_window) continue
    if (after.mechanics.combat.initiative[after.mechanics.combat.active_index]?.actor_id !== activeId) continue
    const ended = await send(code, { command_type: 'EndTurn', actor_id: activeId }, 'Завершить ход')
    if (ended.status !== 200 && ended.status < 500) anomalies.push({ code, kind: 'endturn-refused', actor: activeId, error: ended.text.slice(0, 200) })
  }
  anomalies.push({ code, kind: 'step-cap', theme, difficulty })
}

const difficulties = (process.env.SOAK_DIFFICULTIES ?? 'medium,hard').split(',')
const seeds = Number(process.env.SOAK_SEEDS ?? 2)
let index = 0
for (const theme of ENCOUNTER_THEMES) {
  for (const difficulty of difficulties) {
    for (let seed = 1; seed <= seeds; seed += 1) {
      index += 1
      const code = `SOAK-${index}`
      if (process.env.SOAK_ONLY && process.env.SOAK_ONLY !== theme + ':' + difficulty + ':' + seed) continue
      if (process.env.SOAK_THEME && process.env.SOAK_THEME !== theme) continue
      try { await runEncounter(code, theme, difficulty, seed) } catch (error) { anomalies.push({ code, kind: 'script', theme, difficulty, error: String(error?.stack ?? error).slice(0, 400) }) }
    }
  }
}
const byReason = {}
for (const outcome of outcomes) byReason[outcome.reason] = (byReason[outcome.reason] ?? 0) + 1
console.log('OUTCOMES', outcomes.length, JSON.stringify(byReason))
for (const outcome of outcomes) console.log(' ', outcome.code, outcome.theme, outcome.difficulty, 'r' + outcome.round, outcome.reason, 'up', outcome.heroesUp, '|', outcome.enemies.slice(0, 80), '\n    ', JSON.stringify(outcome.stat))
console.log('ANOMALIES', anomalies.length)
for (const anomaly of anomalies) console.log(JSON.stringify(anomaly))
const serverErrors = logs.split('\n').filter((line) => /error|ошибк|Не удалось/iu.test(line)).slice(0, 20)
console.log('SERVER LOG ERRORS', serverErrors.length)
for (const line of serverErrors) console.log(' ', line.slice(0, 300))
stop()
rmSync(storage, { recursive: true, force: true })
process.exit(0)

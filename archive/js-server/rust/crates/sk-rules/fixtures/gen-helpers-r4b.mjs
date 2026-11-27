import '../../../fixtures-env.mjs'
// Эталон помощников Р4б: аргументы и метаданные перехода сцены, план
// торговли, ссылка на решение группы, поля жизненного цикла торговцев
// (`normalize/scene.rs`), срок призывов (`normalize/summons.rs`) и общество
// (`society_helpers.rs`).
//
// Чистые функции снимаются на синтетических входах (лежат целиком);
// зависящие от состояния — ещё и на состояниях корпуса паритета (по sha, тест
// `#[ignore]` читает их из `SK_CORPUS`): у кого есть NPC, таверна с открытыми
// раундами, призывы со сроком.
//
//   node rust/crates/sk-rules/fixtures/gen-helpers-r4b.mjs <корпус>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const [corpus] = process.argv.slice(2)
if (!corpus) throw new Error('Укажите каталог корпуса')
const E = await loadOpenCopy()
const json = (value) => (value === undefined ? { undefined: true } : JSON.parse(JSON.stringify(value)))
const attempt = (fn) => {
  try {
    return { ok: json(fn()) }
  } catch (error) {
    return { throws: String(error?.message ?? error).slice(0, 200), code: error?.code ?? null }
  }
}

let seed = 0x4b4b2026
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const maybe = (p, value) => (random() < p ? value : {})

const pure = []
// Аргумент `undefined` пишется как { "$undefined": true }: JSON.stringify сделал бы из него null.
const encode = (args) => args.map((arg) => (arg === undefined ? { $undefined: true } : json(arg)))
const call = (f, args, fn) => pure.push({ f, a: encode(args), ...attempt(fn) })

// --- переход сцены ----------------------------------------------------------------
for (let index = 0; index < 300; index += 1) {
  const value = pick([null, 'x', [], {
    ...maybe(0.5, { title: pick(['Таверна', '', 5]) }),
    ...maybe(0.4, { location: 'Город' }),
    ...maybe(0.4, { location_id: pick(['tavern', '  ', '', 5, 'x'.repeat(121), 'ok-id']) }),
    ...maybe(0.4, { theme: pick(['  лес   тёмный ', 5, null, '']) }),
    ...maybe(0.4, { danger: pick(['низкая', 'средняя', 'жуткая', null]) }),
    ...maybe(0.4, { scene_kind: pick(['settlement', 'dungeon', 'nope', null]) }),
    ...maybe(0.4, { settlement_type: pick(['village', 'city', 'megapolis', null, '']) }),
    ...maybe(0.4, { map: pick([null, 'x', { layout: pick(['rooms', 'maze', null]), scale: pick(['room', 'galaxy', undefined]), pattern: pick(['keep', 'x', undefined]), material: pick(['stone', 'cheese', undefined]), width: 20, junk: 1 }]) }),
    ...maybe(0.3, { secrets: [{ id: 's1' }], levels: [{ offset: -1 }], scene_summary: 'Итог', junk: true, seed: 'abc' }),
  }])
  call('normalizeSceneAdvanceArgs', [value], () => E.normalizeSceneAdvanceArgs(value))
  const args = { theme: pick(['', '  Тень  над   рекой ', 'x'.repeat(90), undefined, 0]), danger: pick(['высокая', 'x', undefined]), ...maybe(0.6, { scene_kind: 'other', settlement_type: pick([null, 'town']) }) }
  const transition = pick([undefined, null, { scene: { location: pick(['', 'Порт', 0]), title: pick(['Сцена', '']) } }])
  call('canonicalSceneMetadata', [args, transition], () => E.canonicalSceneMetadata(args, transition))
  const commerce = pick([null, undefined, 'x', {
    version: pick(['skazanie:scene-commerce-plan-v1', 'v0']),
    action: pick(['create', 'none', 'burn']),
    settlement_type: pick(['village', 'city', 'x']),
    theme: pick(['general', 'arms', 'x']),
    budget_cp: pick([100, 99, 1_000_000, 1_000_001, 2.5, '500', 5000]),
    reason: pick(['  Рынок  у ворот ', '', 5, 'ﬁ  x']),
    outcome: pick(['created', 'reused', 'not-requested', 'x']),
    ...maybe(0.5, { merchant_id: pick(['m-1', ' m-2 ', '', '-bad', null, 5]) }),
    ...maybe(0.1, { junk: 1 }),
  }])
  call('normalizeSceneCommerce', [commerce], () => E.normalizeSceneCommerce(commerce))
  const reference = pick([null, undefined, 'x', { interaction_id: pick(['i-1', '', 5]), resolved_option_id: pick(['o-1', ' o.2 ', '!']) }, { interaction_id: 'i', resolved_option_id: 'o', junk: 1 }])
  const required = random() < 0.4
  call('normalizePartyDecisionReference', [reference, required], () => E.normalizePartyDecisionReference(reference, { required }))
  const text = pick([undefined, null, 5, '  текст  ', '', 'x'.repeat(50)])
  const textRequired = random() < 0.4
  call('lifecycleText', [text, 20, textRequired, 'запас'], () => E.lifecycleText(text, 20, { required: textRequired, fallback: 'запас', code: 'C', label: 'Поле' }))
  const number = pick([undefined, null, 5, '7', 2.5, 'x', -10, 1e6, true])
  call('lifecycleInteger', [number], () => E.lifecycleInteger(number, 0, 100, 3, 'C', 'Число'))
  const purse = pick([undefined, null, 0, 500, -1, 9_000_000_001, '5', 2.5])
  call('lifecyclePurseCp', [purse], () => E.lifecyclePurseCp(purse))
  const id = pick([undefined, 'ok', ' ok ', '', '-x', 'a'.repeat(121), 'a:b.c-d_e', 'ж'])
  call('lifecycleId', [id], () => E.lifecycleId(id, 'C', 'id'))
  const object = pick([null, 'x', [], { a: 1, b: 2, zz: 3 }])
  call('lifecycleObject', [object], () => E.lifecycleObject(object, 'C', 'Торговец'))
  if (object && typeof object === 'object' && !Array.isArray(object)) call('assertLifecycleKeys', [object], () => E.assertLifecycleKeys(object, new Set(['a']), 'C', 'Торговец'))
  const buckets = pick([null, 'x', { gm_only: { a: 1 }, party: 'p', secret: null, public: 1, trueState: [1] }])
  call('privateAdventureBuckets', [buckets], () => E.privateAdventureBuckets(buckets))
  call('pickpocketSpentCondition', [id], () => E.pickpocketSpentCondition(id))
  const inventory = pick([null, [], [{ id: 'a', name: 'Стрела', catalog_id: 'arrow', quantity: 5 }, { id: 'b', name: 'Меч', equipped: true }]])
  const incoming = pick([null, { id: 'c', name: 'Стрела', catalog_id: 'arrow', quantity: pick([3, '2', 9999]) }, { id: 'd', name: 'Меч', equipped: true }])
  call('addInventoryItem', [inventory, incoming], () => E.addInventoryItem(inventory, incoming))
}

// --- состояния корпуса --------------------------------------------------------------
const FEATURES = {
  npcs: (s) => (s.social?.npcs ?? []).length > 0,
  tavern: (s) => Object.values(s.tavern?.patrons ?? {}).some((p) => p?.round),
  summons: (s) => [...(s.actors ?? []), ...(s.enemies ?? [])].some((a) => a?.expires_at_seconds != null),
  merchants: (s) => (s.merchants ?? []).length > 0,
}
const picked = new Map()
const counts = Object.fromEntries(Object.keys(FEATURES).map((name) => [name, 0]))
for (const name of readdirSync(join(corpus, 'states')).filter((entry) => entry.endsWith('.json')).sort()) {
  if (Object.values(counts).every((count) => count >= 10)) break
  const state = JSON.parse(readFileSync(join(corpus, 'states', name), 'utf8'))
  for (const [feature, test] of Object.entries(FEATURES)) {
    if (counts[feature] >= 10 || picked.has(name)) continue
    if (test(state)) {
      counts[feature] += 1
      picked.set(name, feature)
    }
  }
}
const stateful = []
const command = { campaign_id: 'c1', command_id: 'cmd-1', command_type: 'X', actor_id: 'hero', target_ids: [], source_rule_ids: [], visibility: 'party' }
for (const [name, feature] of picked) {
  const raw = JSON.parse(readFileSync(join(corpus, 'states', name), 'utf8'))
  const state = E.normalizeCampaignState(raw)
  const npcs = (state.social?.npcs ?? []).map((npc) => npc.id)
  const heroes = (state.players ?? []).map((player) => player.id)
  const cases = []
  const add = (f, args, fn) => cases.push({ f, a: encode(args), ...attempt(fn) })
  for (const npc of [...npcs.slice(0, 3), 'ghost', '']) {
    for (const delta of [5, -30, 0, '3']) add('npcRelationshipEventsFrom', [npc, heroes[0] ?? 'hero', delta, 'причина'], () => E.npcRelationshipEventsFrom(command, state, { npcId: npc, heroId: heroes[0] ?? 'hero', delta, reason: 'причина' }))
    add('fenceStanceFor', [npc, { origin: 'stolen' }], () => E.fenceStanceFor(state, npc, { origin: 'stolen' }))
    add('npcDepartureEvents', [npc], () => E.npcDepartureEvents(command, state, npc))
  }
  for (const merchant of (state.merchants ?? []).slice(0, 2)) add('fenceStanceFor', [merchant.id, { origin: 'stolen' }], () => E.fenceStanceFor(state, merchant.id, { origin: 'stolen' }))
  add('livingPartySize', [], () => E.livingPartySize(state))
  add('tavernRoundsClosedByDeparture', [90], () => E.tavernRoundsClosedByDeparture(command, state, 90))
  for (const round of E.tavernOpenRounds(state)) add('tavernRoundCancelledEvent', [round, 60], () => E.tavernRoundCancelledEvent(command, state, round, 60))
  add('partySummonsForExpiry', [], () => E.partySummonsForExpiry(state).map((summon) => summon.id))
  for (const now of [0, 600, 6000, 1e9]) add('summonIdsExpiredAt', [now], () => E.summonIdsExpiredAt(state, now))
  for (const [before, after] of [[0, 600], [0, 1e9], [600, 0]]) {
    add('expiredSummonsBetween', [before, after], () => E.expiredSummonsBetween(state, before, after).map((summon) => summon.id))
    add('summonExpiryEvents', [before, after], () => E.summonExpiryEvents(command, state, E.expiredSummonsBetween(state, before, after), E.commandWithRules))
  }
  stateful.push({ state_hash: name.slice(0, -5), feature, cases })
}
const output = new URL('./helpers-r4b.json', import.meta.url)
writeFileSync(output, `${JSON.stringify({ source_sha256: sourceSha256(), command, pure, stateful })}\n`)
console.log(`helpers-r4b.json: чистых ${pure.length}, состояний ${stateful.length}, случаев на состояниях ${stateful.reduce((sum, entry) => sum + entry.cases.length, 0)}`, counts)

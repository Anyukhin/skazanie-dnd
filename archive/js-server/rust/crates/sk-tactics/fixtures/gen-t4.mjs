import '../../../fixtures-env.mjs'
// Эталоны #188 (`sk-tactics`): `server/weapon-attack-view.mjs` и
// `weaponAttackSummary` из `server/rules-engine.mjs` — сводка удара для куклы
// героя.
//
//   node rust/crates/sk-tactics/fixtures/gen-t4.mjs
//
// Состояния — учебные отряды `buildCombatLabState` всех классов и уровней с
// инвентарём из каталога (оружие надетое и в сумке, доспехи, мусорные записи)
// и состояниями с `attackBonus`. Случаи:
// - `summary` — `weaponAttackSummary(state, actorId, itemId)`;
// - `view` — `withWeaponAttackSummaries(projected, trusted, viewer)` на копии
//   игроков (`{ $fromState: i }` — `{ sessionCode: 'T4', players }` состояния i)
//   и на рыхлых проекциях (`null`, `players` не массив, мусор в списке);
//   ответ — SHA-256 `JSON.stringify`, `same: true` — та же проекция (без копии).
//
// Выход — `t4.json.gz`.
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const storage = mkdtempSync(join(tmpdir(), 'sk-t4-'))
process.env.DND_STORAGE_DIR = storage
const { buildCombatLabState } = await import('../../../../server/combat-lab-setup.mjs')
const { ITEM_CATALOG, materializeCatalogItem } = await import('../../../../server/item-catalog.mjs')
const { weaponAttackSummary } = await import('../../../../server/rules-engine.mjs')
const { withWeaponAttackSummaries } = await import('../../../../server/weapon-attack-view.mjs')
const { hash, mulberry32, plain } = await import('./common.mjs')

const random = mulberry32(0x0188_d011)
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p

const CLASSES = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard']
const CATALOG = Object.keys(ITEM_CATALOG).filter((id) => id.startsWith('srd_5_2_1:'))
const WEAPONS = CATALOG.filter((id) => materializeCatalogItem(id, {}).combat)
const OTHERS = CATALOG.filter((id) => !materializeCatalogItem(id, {}).combat)
const CONDITIONS = ['magic-weapon', 'bless', 'bane', 'poisoned', 'frightened', 'nope']

const item = (id, catalogId, extra = {}) => ({ ...materializeCatalogItem(catalogId, {}), id, quantity: 1, equipped: false, rarity: 'обычный', ...extra })

const states = []
const cases = []
for (let index = 0; index < 24; index += 1) {
  const size = 1 + int(4)
  const party = Array.from({ length: size }, (_, slot) => ({ source: 'class', classId: pick(CLASSES), level: 1 + int(12), x: 1, y: 2 + slot }))
  const state = await buildCombatLabState({ mapId: 'forest-clearing', party, enemies: [{ monsterId: 'dnd_5e_2014:monster:orc', x: 9, y: 9 }] })
  for (const [slot, player] of state.players.entries()) {
    const inventory = Array.from({ length: 1 + int(6) }, (_, n) => {
      const weapon = chance(0.75)
      return item(`item-${slot}-${n}`, weapon ? pick(WEAPONS) : pick(OTHERS), { equipped: chance(0.6) })
    })
    if (chance(0.2)) inventory.push({ id: `junk-${slot}`, equipped: true, combat: chance(0.5) ? null : { kind: 'melee' } })
    if (chance(0.1)) inventory.push(null)
    if (chance(0.1)) inventory.push({ equipped: true, combat: { kind: 'melee' } })
    // Сохранённая ранее сводка в проекции перезаписывается на своём месте.
    if (chance(0.1) && inventory[0]) inventory[0].attack_summary = { stale: true }
    player.inventory = inventory
    if (chance(0.3)) {
      state.mechanics.conditions = { ...(state.mechanics.conditions ?? {}), [player.id]: Array.from({ length: 1 + int(2) }, () => pick(CONDITIONS)) }
    }
  }
  states.push(plain(state))
  const ref = states.length - 1
  for (const player of state.players) {
    for (const entry of player.inventory) {
      if (!entry?.id) continue
      cases.push({ kind: 'summary', state: ref, actor: player.id, item: entry.id, result: plain(weaponAttackSummary(state, player.id, entry.id)) ?? null })
    }
    cases.push({ kind: 'summary', state: ref, actor: player.id, item: 'missing', result: plain(weaponAttackSummary(state, player.id, 'missing')) ?? null })
  }
  cases.push({ kind: 'summary', state: ref, actor: 'nobody', item: 'item-0-0', result: plain(weaponAttackSummary(state, 'nobody', 'item-0-0')) ?? null })
  const projected = { sessionCode: 'T4', players: state.players.map((player) => ({ ...player, inventory: player.inventory.map((entry) => (entry && typeof entry === 'object' ? { ...entry } : entry)) })) }
  for (const viewer of [...state.players.map((player) => player.id), '', null, 'stranger', undefined]) {
    const output = withWeaponAttackSummaries(projected, state, viewer)
    cases.push({ kind: 'view', state: ref, projected: { $fromState: ref }, viewer: viewer === undefined ? { $js: 'undefined' } : viewer, same: output === projected, hash: hash(output) })
  }
}

// Рыхлые проекции и доверенное состояние.
const trusted = states[0]
const loose = [
  null,
  { players: 'x' },
  { players: [] },
  { players: [null, 1, 'abc', { id: trusted.players[0].id }, { id: trusted.players[0].id, inventory: 'x' }, { inventory: [{ id: 'item-0-0', equipped: true, combat: {} }] }] },
  { players: [{ id: trusted.players[0].id, inventory: trusted.players[0].inventory }] },
]
for (const projected of loose) {
  for (const [trustedRef, viewer] of [[0, trusted.players[0].id], [0, ''], [null, '']]) {
    const output = withWeaponAttackSummaries(projected, trustedRef === null ? null : trusted, viewer)
    cases.push({ kind: 'view', state: trustedRef, projected: plain(projected) ?? null, viewer, same: output === projected, hash: hash(output) })
  }
}

const text = JSON.stringify({ states, cases })
writeFileSync(new URL('./t4.json.gz', import.meta.url), gzipSync(text, { level: 9 }))
rmSync(storage, { recursive: true, force: true })
const counts = cases.reduce((total, entry) => ({ ...total, [entry.kind]: (total[entry.kind] ?? 0) + 1 }), {})
const withSummary = cases.filter((entry) => entry.kind === 'summary' && entry.result).length
console.log(`t4.json.gz: состояний ${states.length}, случаев ${JSON.stringify(counts)}, сводок с ответом ${withSummary} (${text.length} байт до сжатия)`)

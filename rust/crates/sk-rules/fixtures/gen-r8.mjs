import '../../../fixtures-env.mjs'
// Эталоны задачи Р8: форма броска атаки (`attackSwingShape`), шанс d20,
// прогноз удара (`attackForecast`), оружие по умолчанию, предпросмотры
// составных манёвров (подход, прыжок, swing, люстра по тексту), особое
// действие существа (`previewMonsterAction`, `serverOwnedMonsterActor`),
// блоки проверки 28–29 и 66–68 (строки движка в области имён открытой копии)
// и полный `resolveCommand` веток Р8: `MakeAttack`, `ChangeWeapon`,
// `MakeAreaAttack`, `UseMonsterAction`, `UseLegendaryAction`.
//
// Состояния: записи корпуса этих команд (`tmp/corpus-v1`, с картой сцены) и
// их синтетические варианты — состояния атакующего и цели, черты существ,
// заготовленные удары заклинаний, ресурсы, классы героев.
//
// Вызов — `{ f, s, a, o }`, как у `gen-r5.mjs` (`U` — `undefined`).
// Разбор — `{ s, input, context, v, o }`: кости — `SequenceDiceRng(v)`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-r8.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { materializeCatalogItem } from '../../../../server/item-catalog.mjs'
import { DiceService } from '../../../../server/dice-service.mjs'
import { blockFunction, loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const FULL = process.env.SK_R8_FULL === '1'

let seed = 0x0008_5eed
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const U = '__undefined__'

let uuidCounter = 0
globalThis.__SK_OPEN_COPY_UUID__ = () => `uuid-${++uuidCounter}`

function out(value) {
  if (value === undefined) return U
  if (value instanceof Set) value = [...value].sort()
  const text = JSON.stringify(value)
  if (text === undefined) return U
  return text.length > 160 && !FULL ? `sha256:${sha(value)}` : JSON.parse(text)
}
function failure(error) {
  if (E.isCombatPause(error)) return { pause: error.constructor.name, window: out(error.windowEvent), command: out(error.command), prefix: out(error.prefixEvents ?? []) }
  if (error?.name !== 'RulesValidationError') return { fault: String(error?.name), message: String(error?.message ?? '') }
  return { err: [error.code, error.message] }
}
function attempt(fn) {
  try {
    return { ok: out(fn()) }
  } catch (error) {
    return failure(error)
  }
}
/** Кости по кругу: значение `v` даёт `min + (v - 1) % (max - min + 1)` — любой кубик получает допустимую грань. */
class CycleDiceRng {
  constructor(values) {
    this.values = [...values]
    this.index = 0
  }

  randint(minimum, maximum) {
    const value = this.values[this.index % this.values.length]
    this.index += 1
    return minimum + ((value - 1) % (maximum - minimum + 1))
  }
}
function service(values) {
  let counter = 0
  return new DiceService({ rng: new CycleDiceRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
const diceValues = (n = 40) => Array.from({ length: n }, () => 1 + int(20))
function deepUndefined(value) {
  if (value === U) return undefined
  if (Array.isArray(value)) return value.map(deepUndefined)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, deepUndefined(field)]))
  return value
}

// --- состояния корпуса ----------------------------------------------------------------

const TYPES = ['MakeAttack', 'ChangeWeapon', 'MakeAreaAttack', 'UseMonsterAction', 'UseLegendaryAction']
const templates = []
const stateIndex = new Map()
const states = []
function addState(state) {
  const key = sha(state)
  if (!stateIndex.has(key)) {
    stateIndex.set(key, states.length)
    states.push(state)
  }
  return stateIndex.get(key)
}
if (!existsSync(corpusDir)) throw new Error(`нет корпуса в ${corpusDir}`)
const quota = { MakeAttack: 70, ChangeWeapon: 4, MakeAreaAttack: 7, UseMonsterAction: 12, UseLegendaryAction: 10 }
const taken = { ...Object.fromEntries(TYPES.map((type) => [type, 0])), chandelier: 0 }
for (const file of readdirSync(corpusDir).filter((name) => name.startsWith('corpus') && name.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    const type = record.command?.command_type
    if (!TYPES.includes(type)) continue
    const full = taken[type] >= quota[type]
    if (full && (type !== 'MakeAttack' || taken.chandelier >= 8)) continue
    const path = join(corpusDir, 'states', `${record.state}.json`)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    if (text.length > 70_000) continue
    const chandelier = text.includes('"chandelier"') && taken.chandelier < 8
    if (full && !chandelier) continue
    if (type === 'MakeAttack' && int(3) !== 0 && !chandelier) continue
    if (chandelier) taken.chandelier += 1
    const state = JSON.parse(text)
    try { E.normalizeCampaignState(state) } catch { continue }
    if (!full) taken[type] += 1
    templates.push({ s: addState(state), command: record.command, context: record.context ?? {} })
  }
}
const baseCount = states.length

// --- синтетические варианты -------------------------------------------------------------
//
// Вариант строится вокруг команды шаблона: состояния и черты получают сам
// атакующий и его цель, чтобы ветки урона и реакций действительно сработали.

const NEXT_WEAPON_HIT_SPELLS = ['flame-arrows', 'lightning-arrow', 'branding-smite', 'blinding-smite', 'searing-smite', 'wrathful-smite', 'thunderous-smite', 'ensnaring-strike', 'hail-of-thorns', 'zephyr-strike']
const ATTACKER_CONDITIONS = ['bless-d4', 'bane-d4', 'helped', 'hidden', 'reckless', 'steady-aim', 'silvery-fortune', 'divine-favor', 'raging', 'sacred-weapon', 'minor-blessing', 'disadvantage-next-attack',
  'disadvantage-next-weapon-attack', 'blinded', 'enfeebled', 'elemental-weapon', 'magic-weapon', 'spirit-shroud', 'enlarged', 'holy-weapon', 'poisoned', 'prone', 'restrained', 'invisible', 'frightened', 'crusader-s-mantle']
const TARGET_CONDITIONS = ['mirror-image:3', 'mirror-image:2', 'mirror-image:1', 'guiding-bolt-advantage', 'faerie-fire', 'dodging', 'reckless', 'uncanny-dodge', 'heroism', 'prone', 'paralyzed', 'restrained',
  'unconscious', 'shielded', 'fire-shield-warm', 'fire-shield-chill', 'shadow-of-moil', 'favored-foe', 'hunters-mark', 'blinded', 'invisible', 'stunned', 'petrified']
const TRAITS = ['pack-tactics', 'bloodied-frenzy', 'martial-advantage', 'surprise-attack', 'charge', 'undead-fortitude']
const WEAPONS = ['srd_5_2_1:longsword', 'srd_5_2_1:dagger', 'srd_5_2_1:shortbow', 'srd_5_2_1:light-crossbow', 'srd_5_2_1:greatsword', 'srd_5_2_1:rapier', 'srd_5_2_1:handaxe', 'srd_5_2_1:javelin',
  'srd_5_2_1:shortsword', 'srd_5_2_1:greataxe', 'srd_5_2_1:longbow', 'srd_5_2_1:shield', 'srd_5_2_1:arrows-20', 'srd_5_2_1:bolts-20', 'srd_5_2_1:alchemists-fire', 'srd_5_2_1:hand-crossbow']
const ON_HIT = [
  { save_ability: 'con', save_dc: 12, damage_expression: '2d6', damage_type: 'poison', half_on_save: true, condition: 'poisoned', duration_minutes: 10, poison_on_zero: { stable: true, poisoned_minutes: 60, paralyzed_while_poisoned: true } },
  { save_ability: 'con', save_dc: 11, damage_expression: '3d6', damage_type: 'poison', poison_on_zero: { stable: true } },
  { condition: 'grappled', escape_dc: 13, target_size_max: 'medium' },
  { damage_expression: '1d6', damage_type: 'fire' },
  { damage_expression: '2d4' },
  { save_ability: 'str', save_dc: 14, condition: 'prone', repeat_save_timing: 'end-of-turn', duration: '1-round', required_target_type: 'humanoid' },
  { condition: 'restrained', duration_minutes: '5', excluded_targets: ['elf'] },
]
function item(catalogId, id, extra = {}) {
  try { return materializeCatalogItem(catalogId, { id, quantity: 1, equipped: chance(0.5), ...extra }) } catch { return null }
}
function addCondition(state, id, value) {
  state.mechanics.conditions ??= {}
  state.mechanics.conditions[id] = [...(state.mechanics.conditions[id] ?? []), value]
}
function variant(base, template) {
  const state = json(base)
  state.mechanics ??= {}
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  if (!ids.length) return state
  const command = template.command
  const attackerId = String(command.actor_id ?? '')
  const targetId = String(command.target_id ?? command.target_ids?.[0] ?? '')
  const attacker = E.findActor(state, attackerId)
  const target = E.findActor(state, targetId)
  const others = ids.filter((id) => id !== attackerId && id !== targetId)
  if (chance(0.25)) state.ruleset_id = pick(['dnd_5e_2014', 'srd_5_2_1'])
  for (let n = 1 + int(4); n > 0; n -= 1) {
    switch (int(22)) {
      case 0: case 1: case 2: addCondition(state, attackerId, chance(0.85) ? { id: pick(ATTACKER_CONDITIONS), source_actor: pick(ids) } : pick(ATTACKER_CONDITIONS)); break
      case 3: case 4: case 5: addCondition(state, targetId, chance(0.85) ? { id: pick(TARGET_CONDITIONS), source_actor: pick(ids) } : pick(TARGET_CONDITIONS)); break
      case 6: addCondition(state, targetId, { id: 'sanctuary', source_actor: targetId, save_dc: pick([12, 15, '13', undefined]) }); break
      case 7: addCondition(state, targetId, { id: pick([`hunters-mark:${attackerId}`, `hexed:${attackerId}`, 'favored-foe']), source_actor: attackerId }); break
      case 8:
        addCondition(state, targetId, { id: `armor-of-agathys:${pick([5, 10, 'x'])}`, source_actor: targetId })
        state.mechanics.temporary_hp = { ...(state.mechanics.temporary_hp ?? {}), [targetId]: pick([3, 10, 0]) }
        break
      case 9: addCondition(state, attackerId, { id: 'compelled-duel', source_actor: pick([targetId, ...others]) }); break
      case 10: case 11: {
        const spell = pick(NEXT_WEAPON_HIT_SPELLS)
        if (attacker) attacker.creationSpellGrants = [...(attacker.creationSpellGrants ?? []), { id: spell }]
        addCondition(state, attackerId, { id: `next-weapon-hit:${spell}`, spell_id: spell, source_actor: attackerId, ...(chance(0.6) ? { slot_level: pick([1, 2, 3]) } : {}), ...(chance(0.5) ? { save_dc: pick([13, 15]) } : {}), ...(chance(0.5) ? { effect_id: 'eff-nwh' } : {}) })
        if (chance(0.5)) state.mechanics.concentration = { ...(state.mechanics.concentration ?? {}), [attackerId]: { effect_id: 'eff-nwh', spell_id: spell } }
        break
      }
      case 12: addCondition(state, attackerId, { id: `absorbing-element-rider:${pick(['fire', 'cold', 'acid'])}`, source_actor: attackerId, absorb_elements_rider_armed: chance(0.85), ...(chance(0.5) ? { rider_damage_type: pick(['fire', 'cold']) } : {}), ...(chance(0.5) ? { slot_level: pick([1, 2]) } : {}) }); break
      case 13: {
        const weapons = (attacker?.inventory ?? []).filter((entry) => entry?.type === 'weapon').map((entry) => entry.id)
        const bound = E.isEnemyActor(state, attackerId) ? (E.npcWeaponBindings?.(attacker) ?? []).map((binding) => binding.item_instance_id) : []
        const weapon = pick([...weapons, ...bound, 'x'])
        addCondition(state, attackerId, { id: `weapon-coated:${weapon}`, source_actor: attackerId, rider_damage: pick(['1d4', '2d6']), ...(chance(0.5) ? { rider_damage_type: 'poison' } : {}) })
        break
      }
      case 14: addCondition(state, attackerId, { id: 'true-strike', source_actor: attackerId, target_id: targetId }); break
      case 15:
        if (attacker && E.isEnemyActor(state, attackerId)) {
          attacker.traits = [...(Array.isArray(attacker.traits) ? attacker.traits : []), ...Array.from({ length: 1 + int(2) }, () => {
            const id = pick(TRAITS)
            if (id === 'charge') return { id, minimum_distance_feet: pick([10, 20]), ...(chance(0.7) ? { damage_expression: '2d6' } : {}), ...(chance(0.6) ? { save_ability: 'str', save_dc: 13, condition: 'prone' } : {}), ...(chance(0.3) ? { target_size_max: 'medium' } : {}) }
            if (id === 'bloodied-frenzy') return chance(0.5) ? { id, attack_kinds: pick([['melee'], ['ranged']]) } : id
            return chance(0.6) ? { id, ...(chance(0.5) ? { damage_expression: pick(['1d6', '2d6']) } : {}) } : id
          })]
          if (chance(0.5)) attacker.hp = Math.max(1, Math.floor((attacker.maxHp ?? attacker.hp ?? 10) / 2))
          const economy = state.mechanics.combat?.action_economy
          if (economy && chance(0.5)) economy[attackerId] = { ...(economy[attackerId] ?? {}), movement_path: Array.from({ length: 6 }, (_, step) => ({ x: step, y: 0 })) }
        }
        break
      case 16:
        if (attacker && E.isEnemyActor(state, attackerId)) {
          const onHit = pick(ON_HIT)
          if (attacker.attack_profile && typeof attacker.attack_profile === 'object') attacker.attack_profile = { ...attacker.attack_profile, on_hit: onHit }
          if (Array.isArray(attacker.action_profiles)) attacker.action_profiles = attacker.action_profiles.map((action) => (action && typeof action === 'object' ? { ...action, on_hit: onHit } : action))
        }
        break
      case 17:
        if (target) {
          target.hp = pick([1, 2, 4])
          if (E.isEnemyActor(state, targetId) && chance(0.6)) target.traits = [...(Array.isArray(target.traits) ? target.traits : []), 'undead-fortitude']
        }
        break
      case 18:
        if (attacker && !E.isEnemyActor(state, attackerId)) {
          const roll = int(7)
          if (roll === 0) Object.assign(attacker, { class: 'rogue', characterClass: 'rogue', level: pick([1, 3, 5, 11]) })
          else if (roll === 1) Object.assign(attacker, { class: 'fighter', characterClass: 'fighter', subclass: pick(['Чемпион', 'champion']), level: pick([3, 15]), selectedFeatureIds: [...(attacker.selectedFeatureIds ?? []), 'fighting-style-great-weapon-fighting'] })
          else if (roll === 2) Object.assign(attacker, { class: 'ranger', characterClass: 'ranger', subclass: pick(['Охотник', 'hunter']), level: pick([3, 6, 10]) })
          else if (roll === 3) attacker.speciesBenefits = { ...(attacker.speciesBenefits ?? {}), mechanics: { ...(attacker.speciesBenefits?.mechanics ?? {}), savage_attacks: true, reroll_natural_one: chance(0.5) } }
          else if (roll === 4) Object.assign(attacker, { class: 'barbarian', characterClass: 'barbarian', level: pick([2, 9]) })
          const extra = Array.from({ length: 1 + int(2) }, (_, index) => item(pick(WEAPONS), `gen-${attackerId}-${index}`)).filter(Boolean)
          attacker.inventory = [...(Array.isArray(attacker.inventory) ? attacker.inventory : []), ...extra]
        }
        break
      case 19:
        // Союзники цели-героя: «Оборона» со щитом и бард Знаний с вдохновением.
        for (const id of others.filter((other) => !E.isEnemyActor(state, other))) {
          const ally = E.findActor(state, id)
          if (!ally || !chance(0.6)) continue
          if (chance(0.5)) {
            Object.assign(ally, { class: 'fighter', characterClass: 'fighter', level: 3, selectedFeatureIds: [...(ally.selectedFeatureIds ?? []), 'fighting-style-protection'] })
            const shield = item('srd_5_2_1:shield', `shield-${id}`, { equipped: true })
            if (shield) ally.inventory = [...(Array.isArray(ally.inventory) ? ally.inventory : []), shield]
          } else {
            Object.assign(ally, { class: 'bard', characterClass: 'bard', subclass: 'Коллегия знаний', level: pick([3, 5, 10]) })
            state.mechanics.resources = { ...(state.mechanics.resources ?? {}), [id]: { ...(state.mechanics.resources?.[id] ?? {}), bardic_inspiration: { current: 2, max: 3 } } }
          }
          const at = E.actorPosition(state, targetId)
          if (at && chance(0.7)) state.mechanics.positions = { ...(state.mechanics.positions ?? {}), [id]: { x: at.x + pick([-1, 1]), y: at.y } }
        }
        break
      case 20:
        if (target && !E.isEnemyActor(state, targetId)) {
          target.creationSpellGrants = [...(target.creationSpellGrants ?? []), { id: pick(['shield', 'absorb-elements', 'silvery-barbs', 'hellish-rebuke']) }]
          state.mechanics.resources = { ...(state.mechanics.resources ?? {}), [targetId]: { ...(state.mechanics.resources?.[targetId] ?? {}), spell_slots_1: { current: 2, max: 2 } } }
          if (chance(0.4)) Object.assign(target, { class: 'rogue', characterClass: 'rogue', level: 5 })
        }
        break
      default: {
        const economy = state.mechanics.combat?.action_economy
        if (economy) economy[targetId] = { ...(economy[targetId] ?? {}), reaction: chance(0.6) }
        if (chance(0.5) && attacker) addCondition(state, targetId, { id: 'charmed', source_actor: attackerId })
      }
    }
  }
  return state
}

const variantsOf = new Map()
for (let n = 0, made = 0; n < 9000 && made < 300; n += 1) {
  const index = int(templates.length)
  const template = templates[index]
  const state = variant(states[template.s], template)
  try { E.normalizeCampaignState(state) } catch { continue }
  const s = addState(state)
  variantsOf.set(index, [...(variantsOf.get(index) ?? []), s])
  made += 1
}
// Герой у опоры люстры: без этого swing упирается в «подойдите вплотную».
for (const base of [...states]) {
  const props = (base.scene?.map?.props ?? []).filter((prop) => /chandelier/u.test(String(prop.assetId)))
  const heroes = (base.players ?? []).map(E.actorId)
  if (!props.length || !heroes.length) continue
  for (let k = 0; k < 6; k += 1) {
    const copy = json(base)
    const prop = pick(props)
    const anchor = prop.footprint?.[0] ?? { x: Math.floor(Number(prop.x)), y: Math.floor(Number(prop.y)) }
    copy.mechanics.positions = { ...(copy.mechanics.positions ?? {}), [pick(heroes)]: { x: Number(anchor.x) + pick([-1, 0, 1]), y: Number(anchor.y) + pick([-1, 1]) } }
    if (chance(0.5)) for (const player of copy.players ?? []) player.abilities = { ...(player.abilities ?? {}), str: pick([16, 18, 20]) }
    try { E.normalizeCampaignState(copy) } catch { continue }
    addState(copy)
  }
}
const snapshots = states.map((state) => JSON.stringify(state))
console.log(`состояний: корпус ${baseCount}, всего ${states.length}; шаблонов ${templates.length}`, taken)

// --- предпросмотры и помощники -------------------------------------------------------------

const calls = []
function call(f, s, args, fn) {
  const normalized = E.normalizeCampaignState(states[s])
  const resolved = args.map((arg) => deepUndefined(arg))
  calls.push({ f, s, a: args, o: attempt(() => fn(normalized, ...resolved)) })
}
const inventoryIds = (state, id) => (E.findActor(state, id)?.inventory ?? []).map((entry) => entry?.id).filter(Boolean)
const TEXTS = ['Прыгаю на люстру и бью', 'chandelier', 'люстра 3,4', 'прыгнуть к люстре у 2,2', 'бью гоблина', 'Люстра', '']
for (let s = 0; s < states.length; s += 1) {
  const state = E.normalizeCampaignState(states[s])
  const ids = E.listActors(state).map(E.actorId)
  if (!ids.length) continue
  const heroes = (state.players ?? []).map(E.actorId)
  const enemies = (state.enemies ?? []).map(E.actorId)
  const props = (state.scene?.map?.props ?? []).filter((prop) => /chandelier/u.test(String(prop.assetId))).map((prop) => prop.id)
  for (let rep = 0; rep < 4; rep += 1) {
    const attacker = pick([...ids, ...heroes, 'ghost'])
    const target = pick([...ids, ...enemies, 'ghost'])
    const itemId = pick([U, null, ...inventoryIds(state, attacker), 'missing'])
    const actionId = pick([U, null, ...((E.findActor(state, attacker)?.action_profiles ?? []).map((action) => action?.id)), 'missing'])
    call('attackForecast', s, [attacker, target, { actionId, itemId, attackMode: pick([U, null, 'melee', 'thrown', 'ranged']), attackAbility: pick([U, null, 'str', 'dex']) }], (st, a, b, c) => E.attackForecast(st, a, b, c))
    call('attackSwingShape', s, [attacker, target, pick(['trusted', 'item', 'none']), itemId, pick([U, true, false]), pick([U, true, false]), pick([U, true, false])], (st, a, b, kind, item, adv, dis, extra) => {
      const actor = E.findActor(st, a)
      const profile = kind === 'trusted' ? (actor ? E.trustedAttackProfile(st, actor, null) : null) : kind === 'item' ? (actor && item ? E.itemAttackProfile(st, actor, item) : null) : null
      const actorAt = E.actorPosition(st, a)
      const targetAt = E.actorPosition(st, b)
      const distanceFeet = actorAt && targetAt ? E.distanceBetweenActorPositions(st, a, actorAt, b, targetAt) : null
      return E.attackSwingShape(st, a, b, profile, { actorAt, targetAt, distanceFeet, commandAdvantage: adv, commandDisadvantage: dis, extraAdvantage: extra })
    })
    if (rep === 0) {
      call('defaultAttackItemIdFor', s, [pick(heroes.length ? heroes : ids), pick([...enemies, ...ids])], (st, a, b) => E.defaultAttackItemIdFor(states[s], a, b))
      call('serverOwnedMonsterActor', s, [pick([...enemies, ...ids])], (st, a) => Boolean(E.serverOwnedMonsterActor(E.findActor(st, a), st)))
    }
    if (rep < 2) {
      call('previewApproachAttack', s, [pick(heroes.length ? heroes : ids), pick([...enemies, ...ids])], (st, a, b) => E.previewApproachAttack(states[s], a, b))
      call('previewLongJumpAttack', s, [pick(heroes.length ? heroes : ids), pick([...enemies, ...ids]), chance(0.4)], (st, a, b, c) => E.previewLongJumpAttack(states[s], a, b, { runningStart: c }))
    }
    if (rep === 0 || props.length) {
      call('previewSwingAttack', s, [pick(heroes.length ? heroes : ids), pick([...enemies, ...ids]), pick([...props, ...props, 'missing', U]), chance(0.4)], (st, a, b, c, d) => E.previewSwingAttack(states[s], a, b, c, { runningStart: d }))
      call('swingPropForText', s, [pick([...TEXTS, ...props.map((id) => `к ${id}`)])], (st, a) => E.swingPropForText(states[s], a))
    }
    const monsters = (state.enemies ?? []).filter((enemy) => (enemy.special_actions ?? []).length)
    if (monsters.length || rep === 0) {
      const monster = monsters.length ? pick(monsters) : E.findActor(state, pick(ids))
      const actions = (monster?.special_actions ?? []).map((action) => action.id)
      const toward = pick([U, null, { x: int(12), y: int(12) }, E.actorPosition(state, pick(ids)), { x: 'a' }])
      call('previewMonsterAction', s, [monster ? E.actorId(monster) : 'ghost', pick([...actions, ...actions, 'missing']), toward], (st, a, b, c) => {
        const preview = E.previewMonsterAction(states[s], a, b, c)
        return { action: preview.action, origin: preview.origin, to: preview.to, affectedIds: preview.affectedIds }
      })
    }
  }
}
for (let n = 0; n < 400; n += 1) {
  const target = pick([1, 2, 5, 9.5, 10, 13, 15.2, 18, 20, 21, 25, -3, 0])
  const args = [target, pick([U, true, false]), pick([U, true, false])]
  calls.push({ f: 'd20HitChance', s: 0, a: args, o: attempt(() => E.d20HitChance(target, { advantage: deepUndefined(args[1]), disadvantage: deepUndefined(args[2]) })) })
}

// --- блоки проверки 28–29 и 66–68 ----------------------------------------------------------

const legendaryBlock = await blockFunction([[6703, 6710]], ["if (command.command_type === 'UseLegendaryAction')"], ['state', 'command', 'context'], 'return command')
const attackBlock = await blockFunction([[7222, 7324]], ["if (command.command_type === 'MakeAttack')"], ['state', 'command', 'context'], 'return command')
const blocks = []
const BLOCK_CONTEXTS = [{}, { isNpcScheduler: true }, { serverAuthoritativeCombat: true }, { isAdmin: true, isNpcScheduler: true }, { isNpcScheduler: 'yes' }]
for (let n = 0; n < 2600; n += 1) {
  const template = pick(templates)
  const s = chance(0.5) ? template.s : int(states.length)
  const state = E.normalizeCampaignState(states[s])
  const ids = E.listActors(state).map(E.actorId)
  const actor = pick([...ids, template.command.actor_id, 'ghost'])
  const type = pick(['MakeAttack', 'MakeAttack', 'MakeAttack', 'ChangeWeapon', 'MakeAreaAttack', 'UseMonsterAction', 'UseLegendaryAction', template.command.command_type])
  const actorRecord = E.findActor(state, actor)
  const items = inventoryIds(state, actor)
  const input = {
    command_type: type, command_id: `blk-${n}`, campaign_id: 'camp', actor_id: actor,
    ...(chance(0.7) ? { target_id: pick([...ids, actor, 'ghost', template.command.target_id]) } : {}),
    ...(chance(0.5) ? { item_id: pick([...items, 'missing', '']) } : {}),
    ...(chance(0.2) ? { attack_mode: pick(['melee', 'thrown', 'ranged', 'bad']) } : {}),
    ...(chance(0.15) ? { attack_ability: pick(['str', 'dex', 'wis']) } : {}),
    ...(chance(0.15) ? { sneak_attack: pick([true, 1]) } : {}),
    ...(chance(0.12) ? { knock_out: true } : {}),
    ...(chance(0.3) ? { action_id: pick([...(actorRecord?.action_profiles ?? []).map((action) => action?.id), ...(actorRecord?.special_actions ?? []).map((action) => action?.id), 'missing']) } : {}),
    ...(chance(0.2) ? { server_authoritative: true } : {}),
    ...(type === 'MakeAreaAttack' || type === 'UseMonsterAction' ? { to: pick([{ x: int(12), y: int(12) }, { x: 'a', y: 2 }, E.actorPosition(state, pick(ids)), U]) } : {}),
    ...(type === 'UseLegendaryAction' ? { legendary_action_id: pick([...(actorRecord?.legendary?.actions ?? []).map((action) => action?.id), 'missing', U]) } : {}),
  }
  if (type === template.command.command_type && chance(0.4)) Object.assign(input, json(template.command), { command_id: `blk-${n}` })
  let command
  try { command = E.normalizeCommand(deepUndefined(json(input)), state) } catch { continue }
  const context = pick([...BLOCK_CONTEXTS, template.context])
  const block = pick(['legendary', 'attack'])
  blocks.push({ s, block, command: json(command), context: json(context), o: attempt(() => (block === 'legendary' ? legendaryBlock : attackBlock)(state, structuredClone(command), context)) })
}

// --- разбор веток Р8 целиком ---------------------------------------------------------------

const resolves = []
const seen = new Map()
const flags = new Map()
const note = (events) => {
  for (const event of events ?? []) {
    seen.set(event.event_type, (seen.get(event.event_type) ?? 0) + 1)
    for (const key of ['sneak_attack', 'mirror_image_intercepted', 'cutting_words', 'protected_by', 'critical_prevented', 'automatic_critical', 'improved_critical', 'bardic_inspiration', 'knocked_out', 'undead_fortitude',
      'next_weapon_hit', 'burst', 'retaliation', 'item_damage_rider', 'spell_damage_rider', 'secondary_damage', 'great_weapon_fighting', 'savage_attacks', 'colossus_slayer', 'divine_smite', 'pack_tactics', 'charge',
      'bloodied_frenzy', 'cover', 'high_ground', 'loading_weapon', 'thrown', 'shielded_by_reaction', 'trait_id', 'monster_action', 'legendary_action_id', 'spell_id']) {
      if (event.payload?.[key] !== undefined && event.payload?.[key] !== false) flags.set(key, (flags.get(key) ?? 0) + 1)
    }
  }
}
const RESOLVE_CONTEXTS = [{ isAdmin: true, serverAuthoritativeCombat: true }, { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true }, { serverAuthoritativeCombat: true }, { isAdmin: true }]
function resolveInput(template, state, n) {
  const ids = E.listActors(state).map(E.actorId)
  const heroes = (state.players ?? []).map(E.actorId)
  const enemies = (state.enemies ?? []).map(E.actorId)
  const input = { ...json(template.command), command_id: `r8-${n}`, expected_state_version: state.state_version }
  delete input.idempotency_key
  if (input.command_type !== 'MakeAttack' || chance(0.25)) return input
  if (chance(0.12)) {
    const actor = pick([...heroes, ...heroes, ...enemies])
    const foes = E.isEnemyActor(state, actor) ? heroes : enemies
    input.actor_id = actor
    input.target_id = pick(foes.length ? foes : ids)
    delete input.target_ids
    delete input.action_id
    delete input.item_id
  }
  const actor = E.findActor(state, input.actor_id)
  if (chance(0.4)) input.item_id = pick([...inventoryIds(state, input.actor_id), U])
  if (chance(0.15)) input.attack_mode = pick(['melee', 'thrown', 'ranged'])
  if (chance(0.25) && (actor?.class === 'rogue' || chance(0.15))) input.sneak_attack = true
  if (chance(0.15)) input.knock_out = true
  if (chance(0.15) && E.isEnemyActor(state, input.actor_id)) input.action_id = pick([...(actor?.action_profiles ?? []).map((action) => action?.id), U])
  if (chance(0.1)) Object.assign(input, { reaction_attack: true, ...(chance(0.5) ? { reaction_target_position: E.actorPosition(state, input.target_id) ?? { x: 1, y: 1 } } : {}) })
  if (chance(0.15)) Object.assign(input, { advantage: true, armor_class: 3, attack_modifier: 9 })
  if (chance(0.1)) input.request_fingerprint = 'fp-1'
  return input
}
function resolveContext(template, input, state) {
  const base = chance(0.6) ? json(template.context) : pick(RESOLVE_CONTEXTS)
  const target = input.target_id ?? input.target_ids?.[0]
  if (chance(0.25)) {
    const kind = pick(['attack', 'protection', 'cutting-words'])
    const key = `${kind}:${input.command_id}:${target}`
    base.protectiveReactionChoice = { key, use: chance(0.6), kind: pick(['shield', 'uncanny-dodge', 'absorb-elements', kind]), reactor_id: pick([U, ...(state.players ?? []).map(E.actorId)]), ...(chance(0.3) ? { damage_type: 'fire', slot_level: 2 } : {}) }
  }
  return deepUndefined(base)
}
for (let n = 0; n < 30000 && resolves.length < 6000; n += 1) {
  const template = pick(templates)
  const variants = variantsOf.get(templates.indexOf(template)) ?? []
  const s = chance(0.25) || !variants.length ? template.s : pick(variants)
  const raw = states[s]
  let state
  try { state = E.normalizeCampaignState(raw) } catch { continue }
  const input = resolveInput(template, state, n)
  if (!E.findActor(state, input.actor_id)) continue
  const context = resolveContext(template, input, state)
  const values = diceValues(50)
  uuidCounter = 0
  const o = attempt(() => {
    const result = E.resolveCommand(json(deepUndefined(input)), json(raw), { diceService: service(values), context: json(context) })
    note(result.events)
    return { command: result.command, events: result.events, rolls: result.rolls }
  })
  resolves.push({ s, input, context, v: values, o })
}

const mutated = states.map((state, index) => (JSON.stringify(state) === snapshots[index] ? null : index)).filter((index) => index != null)
if (mutated.length) throw new Error(`эталон: вызовы JS изменили состояния ${mutated.join(', ')}`)
const output = { source_sha256: sourceSha256(), states, calls, blocks, resolves }
const text = `${JSON.stringify(output)}\n`
writeFileSync(new URL(FULL ? 'r8.full.json.gz' : 'r8.json.gz', import.meta.url), gzipSync(text, { level: 9 }))
const count = (list) => list.filter((entry) => entry.o.ok !== undefined).length
const byKind = (list) => { const m = new Map(); for (const entry of list) { const k = entry.o.ok !== undefined ? 'ok' : entry.o.err ? `err:${entry.o.err[0]}` : entry.o.pause ? 'pause' : `fault:${entry.o.fault}`; m.set(k, (m.get(k) ?? 0) + 1) } return [...m].sort((a, b) => b[1] - a[1]).slice(0, 25) }
console.log([...seen].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log('флаги:', [...flags].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log('разборы:', JSON.stringify(byKind(resolves)))
console.log('вызовы:', JSON.stringify([...new Set(calls.map((c) => c.f))].map((f) => [f, calls.filter((c) => c.f === f).length, count(calls.filter((c) => c.f === f))])))
console.log('блоки:', JSON.stringify(byKind(blocks)))
console.log(`r8.json.gz: ${(text.length / 1e6).toFixed(1)} МБ JSON, состояний ${states.length}, вызовов ${calls.length}, блоков ${blocks.length}, разборов ${resolves.length} (ok ${count(resolves)})`)

import '../../../fixtures-env.mjs'
// Эталоны `server/npc-equipment.mjs` для Rust-переноса (`sk-economy`):
// привязки оружия, расход боеприпасов и метательного, недоступность
// действий и расходники противника на всём бестиарии SRD 5.2.1 и 2014 —
// с полными, опустевшими, разоружёнными и подправленными инвентарями.
//
// Противник записывается только полями, которые читает модуль
// (`stat_block_id`, `action_profiles`, `hp`, `maxHp`, `loadout`).
//
// Запуск: node rust/crates/sk-economy/fixtures/gen-npc-equipment.mjs
import { PROTOTYPE_KEYS, recorder, rng } from './record.mjs'
import { junkFactory } from './junk.mjs'

const url = (path) => new URL(`../../../../server/${path}`, import.meta.url).href
const N = await import(url('npc-equipment.mjs'))
const E = await import(url('enemy-loadouts.mjs'))
const C = await import(url('item-catalog.mjs'))
const { SRD_5_2_1_MONSTER_ALLOWLIST } = await import(url('encounter-assembler.mjs'))
const { loadDndsu2014Content } = await import(url('dndsu-2014-content.mjs'))
const { enemyFrom2014 } = await import(url('combat-lab-monsters.mjs'))

const ALL_IDS = [...Object.keys(C.ITEM_CATALOG), ...Object.keys(C.SCENARIO_ITEM_CATALOG)]
const random = rng(20261018)
const J = junkFactory(random, ALL_IDS)
const { pick, int, chance } = J

const content = await loadDndsu2014Content()
const BLOCKS = [
  ...Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST),
  ...content.monsters.map((record, index) => [record.id, enemyFrom2014(record, { x: 0, y: 0 }, index)]),
]

function enemyFor(statBlockId, block, seed, hp = null) {
  const maximum = Number(block.hp ?? block.maxHp ?? 10)
  return {
    stat_block_id: statBlockId,
    action_profiles: block.action_profiles ?? [],
    hp: hp ?? maximum,
    maxHp: maximum,
    loadout: E.enemyLoadoutFor({ statBlockId, block, ownerId: 'foe', seed }),
  }
}

const r = recorder('server/npc-equipment.mjs')
for (const name of ['NPC_EQUIPMENT_POLICY_ID', 'NPC_EQUIPMENT_EVENT_SCHEMA_VERSION', 'NPC_HEALING_POTION_HP_PERCENT', 'NPC_TACTIC_CONDITION_PREFIX',
  'NPC_ATTACK_FORMULA_DEVIATIONS', 'NPC_ITEM_TACTICS', 'NPC_ITEM_TACTIC_IDS', 'NPC_ACTION_UNAVAILABLE_MESSAGES']) r.constant(name, N[name])

for (const id of [...Object.keys(N.NPC_ITEM_TACTICS), ' srd_5_2_1:acid ', 'srd_5_2_1:dagger', '', undefined, 7]) r.call('npcItemTacticFor', N.npcItemTacticFor, id)
for (const [a, b] of [['srd_5_2_1:bugbear', 'morningstar'], [' x ', ' y '], [undefined, null], [7, 'ｍ']]) r.call('npcAttackFormulaDeviationKey', N.npcAttackFormulaDeviationKey, a, b)
for (const tactic of ['heal', ' coat ', '', undefined, 'x'.repeat(50)]) r.call('npcTacticCondition', N.npcTacticCondition, tactic)

const FNS = {
  npcWeaponBindings: N.npcWeaponBindings,
  npcWeaponBindingFor: N.npcWeaponBindingFor,
  npcMeleeWeaponBindingForItem: N.npcMeleeWeaponBindingForItem,
  npcActionUnavailableReason: N.npcActionUnavailableReason,
  npcAttackExpenditureFor: N.npcAttackExpenditureFor,
  npcUsableItems: N.npcUsableItems,
  npcUsableItemFor: N.npcUsableItemFor,
  npcLoadoutItem: N.npcLoadoutItem,
  npcNeedsHealingPotion: N.npcNeedsHealingPotion,
}

function recordEnemy(enemy) {
  const calls = [['npcWeaponBindings'], ['npcNeedsHealingPotion']]
  const actionIds = [...new Set([...(Array.isArray(enemy.action_profiles) ? enemy.action_profiles : []).map((profile) => profile?.id), 'missing', '', ' longsword '])]
  for (const actionId of actionIds) {
    calls.push(['npcWeaponBindingFor', actionId], ['npcActionUnavailableReason', actionId], ['npcAttackExpenditureFor', actionId])
  }
  const itemIds = [...(Array.isArray(enemy.loadout?.items) ? enemy.loadout.items : []).map((item) => item?.item_instance_id), 'missing', '']
  for (const itemId of itemIds) {
    calls.push(['npcMeleeWeaponBindingForItem', itemId], ['npcLoadoutItem', itemId], ['npcUsableItemFor', itemId, pick([undefined, { rulesetId: 'dnd_5e_2014' }])])
  }
  for (const options of [undefined, { rulesetId: 'dnd_5e_2014' }, { rulesetId: 'srd_5_2_1' }]) calls.push(['npcUsableItems', options])
  r.bundle('enemy', enemy, calls, FNS)
}

function mutate(enemy) {
  const next = structuredClone(enemy)
  const items = next.loadout.items
  const roll = random()
  if (roll < 0.2) {
    // Опустевший колчан: заряды на исходе или ноль.
    for (const item of items) if (/arrows|bolts|bullets|needles/u.test(item.catalog_id)) item.charges = pick([{ current: 0, max: 20 }, { current: 1, max: 20 }, { current: 21, max: 20 }, { current: 'x', max: 20 }, { current: 2.5, max: 20 }])
  } else if (roll < 0.35) {
    next.loadout.items = items.filter(() => chance(0.5))
  } else if (roll < 0.5) {
    for (const item of items) item.quantity = pick([0, 1, 2, -1, '3', 40, null])
  } else if (roll < 0.6) {
    next.action_profiles = next.action_profiles.map((profile) => ({ ...profile, damage_expression: pick([profile.damage_expression, '1d12+2', '4d8+2', ' 007d0006 + 1', 'x', null]) }))
  } else if (roll < 0.68) {
    next.stat_block_id = pick(['srd_5_2_1:bugbear', 'srd_5_2_1:guard-captain', 'srd_5_2_1:knight', ''])
  } else if (roll < 0.76) {
    for (const item of items) if (item.snapshot?.combat && chance(0.5)) item.snapshot.combat = pick([{ kind: 'ranged', damage: '1d8', damageType: 'piercing', ammunition: true }, { modes: [null, 'x', { kind: 'melee', damage: '1d6', damageType: 'Slashing' }] }, { id: 'own', kind: 'melee', damage: '1d8', damageType: 'slashing', '3': 'индекс' }, null])
  } else if (roll < 0.84) {
    next.loadout.template_id = pick(['', null, 'srd_5_2_1:bandit'])
  } else if (roll < 0.9) {
    next.action_profiles = [...next.action_profiles, { id: pick(PROTOTYPE_KEYS) }, { id: 'longbow', kind: 'ranged', damage_type: 'piercing', damage_expression: '1d8+2' }]
  } else {
    for (const item of items) item.equipped = pick([true, false, 'true'])
  }
  next.hp = pick([next.hp, 0, 1, Math.floor(next.maxHp * 0.3), Math.floor(next.maxHp * 0.3) + 1, -5, '4'])
  return next
}

const humanoids = []
for (const [statBlockId, block] of BLOCKS) {
  const seeds = E.ENEMY_LOADOUT_TEMPLATE_IDS.includes(statBlockId) ? 6 : 1
  for (let index = 0; index < seeds; index += 1) {
    const enemy = enemyFor(statBlockId, block, `npc-equipment-${index}`)
    recordEnemy(enemy)
    if (enemy.loadout.items.length) humanoids.push(enemy)
  }
}
for (let index = 0; index < 300; index += 1) recordEnemy(mutate(pick(humanoids)))
for (const junk of [undefined, null, {}, { loadout: 'нет' }, { loadout: { template_id: 'x', items: 'нет' }, action_profiles: 'нет' }, J.junk()]) {
  r.bundle('enemy', junk, [['npcWeaponBindings'], ['npcUsableItems'], ['npcNeedsHealingPotion'], ['npcLoadoutItem', 'x'], ['npcAttackExpenditureFor', 'longbow']], FNS)
}
for (const [hp, maxHp, max_hp] of [[3, 10, undefined], [4, 10, undefined], [0, 10, undefined], [3, undefined, 10], [3, null, 10], [30, 100, 5], ['3', '10', undefined], [-1, 0, undefined], [1, 'x', undefined]]) {
  r.call('npcNeedsHealingPotion', N.npcNeedsHealingPotion, { hp, ...(maxHp === undefined ? {} : { maxHp }), ...(max_hp === undefined ? {} : { max_hp }) })
}

// Сверка формулы вне инвентаря: профиль × снимок оружия.
for (let index = 0; index < 300; index += 1) {
  const enemy = pick(humanoids)
  const profile = pick(enemy.action_profiles) ?? {}
  const catalogId = pick([...Object.values(E.WEAPON_CATALOG_BY_ACTION), 'srd_5_2_1:greatclub'])
  r.call('npcWeaponBindingCheck', N.npcWeaponBindingCheck, { stat_block_id: pick([enemy.stat_block_id, 'srd_5_2_1:bugbear', undefined]) },
    chance(0.8) ? profile : J.junk(), chance(0.85) ? C.catalogItem(catalogId)?.combat : J.junk())
}
r.write('npc-equipment.json')

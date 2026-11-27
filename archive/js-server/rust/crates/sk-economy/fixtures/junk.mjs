// Мусорные и правдоподобные входы для эталонов sk-economy: значения, которые
// переживают JSON без потерь (никаких `-0`, `NaN`, `undefined` внутри
// объектов), чтобы Rust получил ровно то, что видел JS.
import { chooser, PROTOTYPE_KEYS } from './record.mjs'

export function junkFactory(random, catalogIds) {
  const { pick, int, chance } = chooser(random)
  const ATOMS = [
    null, true, false, 0, 1, 2, 3, 5, 7, 10, 15, 19, 20, 40, 99, 100, 1000, 5000, 10_000, 1_000_001, -1, -7, -5000, 2.5, 0.25,
    1e21, 9_007_199_254_740_993, 9_007_199_254_740_991, '', ' ', '0', '1', '7', ' 3 ', '2.5', '-4', 'abc', '0x10', '1e3',
    'Infinity', 'stolen', ' gifted ', 'weapon', 'treasure', 'quest', 'сюжетный', '１２', 'catalog', 'success',
  ]
  const KEYS = ['a', 'kind', 'current', 'max', 'id', 'name', 'value', '0', '7']

  const atom = () => pick(ATOMS)

  function junk(depth = 0) {
    const roll = random()
    if (depth > 2 || roll < 0.6) return atom()
    if (roll < 0.75) return Array.from({ length: int(0, 3) }, () => junk(depth + 1))
    if (roll < 0.85) return pick(catalogIds)
    const object = {}
    for (let index = int(0, 3); index > 0; index -= 1) object[pick(KEYS)] = junk(depth + 1)
    return object
  }

  function shuffle(entries) {
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const other = int(0, index)
      ;[entries[index], entries[other]] = [entries[other], entries[index]]
    }
    return entries
  }

  function catalogRef({ prototypes = true } = {}) {
    const roll = random()
    if (roll < 0.62) return pick(catalogIds)
    if (roll < 0.7) return ` ${pick(catalogIds)} `
    if (roll < 0.78) return pick(['custom:compass', 'srd_5_2_1:unknown', 'homebrew:ring', 'srd_5_2_1:DAGGER', ''])
    if (prototypes && roll < 0.84) return pick(PROTOTYPE_KEYS.filter((key) => key !== '__proto__'))
    return junk(1)
  }

  function passiveEffect() {
    if (chance(0.3)) return junk(1)
    const effect = {}
    if (chance(0.85)) effect.schema_version = pick([1, 1, 1, '1', 2, 0, null])
    if (chance(0.85)) effect.effect_id = pick(['ring-ac', ' cloak ', '', 'forged', 7])
    if (chance(0.85)) effect.group = pick(['protection', ' x ', '', 'forged'])
    if (chance(0.5)) effect.armor_class_bonus = pick([0, 1, 2, 50, 5_000, -3, '2', null])
    if (chance(0.4)) effect.saving_throw_bonus = pick([0, 1, 101, '1'])
    if (chance(0.3)) effect.damage_resistances = pick([['Fire', 'cold', 'fire', ''], 'fire', [], ['acid', 7, null]])
    if (chance(0.2)) effect.spell_immunities = pick([['magic-missile', 'Magic-Missile'], []])
    if (chance(0.25)) effect.weapon_damage_rider = pick([{ expression: '1D6', damage_type: 'Fire', critical_doubles: true }, { expression: ' 2 d 8 ', damage_type: 'cold' }, { expression: '21d6', damage_type: 'x' }, { expression: '1d6' }, 'x'])
    if (chance(0.15)) effect.prevents_critical_hits = pick([true, 'true'])
    if (chance(0.15)) effect.initiative_advantage = pick([true, 1])
    if (chance(0.15)) effect.requires_equipped = pick([true, false])
    if (chance(0.15)) effect.requires_attunement = pick([true, 'yes'])
    if (chance(0.1)) effect.requires_activated = pick([true, false])
    return effect
  }

  function charges() {
    if (chance(0.6)) return { current: pick([0, 1, 3, 7, 20, -3, 2.5, '4', null]), max: pick([0, 1, 3, 7, 10, 2_000_000, -2, '7', null]) }
    return junk(1)
  }

  function rechargeProfile() {
    const roll = random()
    if (roll < 0.4) return { schema_version: 1, trigger: 'dawn', formula: '1d6+1' }
    if (roll < 0.6) return { schema_version: pick([1, '1', 2, null]), trigger: pick(['dawn', ' Dawn ', 'dusk']), formula: pick(['1d6+1', ' 1D6 + 1 ', '2d6']) }
    return junk(1)
  }

  /** Вещь инвентаря: каталожная, самодельная или мусорная, поля в случайном порядке. */
  function inventoryItem(index) {
    const fields = []
    const idRoll = random()
    if (idRoll < 0.65) fields.push(['catalog_id', catalogRef()])
    else if (idRoll < 0.75) fields.push(['catalogId', catalogRef()])
    else if (idRoll < 0.8) fields.push(['catalog_id', null], ['catalogId', catalogRef()])
    if (chance(0.85)) fields.push(['id', chance(0.9) ? `item-${index}` : junk(1)])
    if (chance(0.15)) fields.push(['item_id', chance(0.8) ? `legacy-${index}` : junk(1)])
    if (chance(0.6)) fields.push(['name', chance(0.7) ? pick(['Лук следопыта', '  Старый меч  ', '', '   ', 'Флакон', 'x'.repeat(130)]) : junk(1)])
    if (chance(0.5)) fields.push(['type', pick(['weapon', 'armor', 'tool', 'other', 'consumable', 'Trade_Good', 'valuable', 'quest', 'TREASURE', null, 7, 'потрох'])])
    if (chance(0.6)) fields.push(['quantity', pick([1, 1, 2, 3, 0, -1, 2.5, '2', null, 20, 1e21, 1_000_000, 'abc'])])
    if (chance(0.4)) fields.push(['weight', pick([0, 0.25, 0.5, 2, 999, -5, '2', null, 'x', 1e21])])
    if (chance(0.4)) fields.push(['equipped', pick([true, false, 'yes', 1, null])])
    if (chance(0.1)) fields.push(['activated', pick([true, false, 'true'])])
    if (chance(0.3)) fields.push(['rarity', pick(['сюжетный', 'Редкий', 'обычный', 'ОЧЕНЬ РЕДКИЙ', 'легендарный ', '', null, 'rare'])])
    if (chance(0.3)) fields.push(['description', chance(0.7) ? pick(['Самодельный амулет', '', ' ', 'y'.repeat(1_010)]) : junk(1)])
    if (chance(0.25)) fields.push(['properties', chance(0.7) ? pick(['Тяжёлый', '']) : junk(1)])
    if (chance(0.15)) fields.push(['image', pick(['/assets/items/x.png', '', null, 5])])
    if (chance(0.08)) fields.push(['imagePosition', pick(['center', null, { x: 1 }])])
    if (chance(0.06)) fields.push(['imagePrompt', 'меч'])
    if (chance(0.06)) fields.push(['imageStatus', 'ready'])
    if (chance(0.3)) fields.push(['combat', chance(0.7) ? { kind: pick(['melee', 'ranged']), damage: '1d6', damageType: 'slashing' } : junk(1)])
    if (chance(0.25)) fields.push(['passive_effects', chance(0.8) ? Array.from({ length: int(0, 3) }, passiveEffect) : junk(1)])
    if (chance(0.3)) fields.push(['charges', charges()])
    if (chance(0.25)) fields.push(['recharge', rechargeProfile()])
    if (chance(0.15)) fields.push(['requires_attunement', pick([true, false, 'true', null])])
    if (chance(0.15)) fields.push(['attuned_to', pick(['hero', null, '', '  hero  ', 7])])
    if (chance(0.1)) fields.push(['sellable', pick([true, false, 'false'])])
    if (chance(0.1)) fields.push(['quest_item', pick([true, false])])
    if (chance(0.15)) fields.push(['price_provenance', pick(['catalog', 'custom-appraisal', null, 'server_appraisal_policy'])])
    if (chance(0.1)) fields.push(['appraisal_policy_id', pick(['agent:free', null, 'skazanie:economy:merchant-policy-v1'])])
    if (chance(0.25)) fields.push(['origin', pick(['stolen', 'purchased', ' looted ', 'украдено', null, { kind: 'stolen' }, 'unknown'])])
    if (chance(0.2)) fields.push(['base_price_cp', pick([1, 0, 5_000, '10', 99_999_999])])
    if (chance(0.08)) fields.push(['catalog_schema_version', pick(['skazanie:item-catalog:v1', '', null, 999])])
    if (chance(0.08)) fields.push(['mechanics_status', pick(['verified', 'partial', '', 7])])
    if (chance(0.05)) fields.push(['spellcasting_focus', ['wizard']])
    if (chance(0.05)) fields.push(['component_pouch', true])
    if (chance(0.05)) fields.push(['material_component', { kind: 'diamond', value_cp: 100 }])
    if (chance(0.05)) fields.push(['focus_mode', 'held'])
    if (chance(0.1)) fields.push(['stack_key', 'forged'])
    if (chance(0.1)) fields.push(['secret_supplier', 'не показывать'])
    if (chance(0.04)) fields.push(['0', 'индекс'], ['12', 'ещё индекс'])
    return Object.fromEntries(shuffle(fields))
  }

  return { pick, int, chance, atom, junk, shuffle, catalogRef, inventoryItem, passiveEffect, charges, rechargeProfile }
}

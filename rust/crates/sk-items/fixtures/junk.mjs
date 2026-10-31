// Мусорные и правдоподобные входы для эталонов sk-items: значения, которые
// переживают JSON без потерь (никаких `-0`, `NaN`, функций), чтобы Rust
// получил ровно то, что видел JS.
import { chooser, PROTOTYPE_KEYS } from './record.mjs'

export function junkFactory(random, catalogIds) {
  const { pick, int, chance } = chooser(random)
  const ATOMS = [
    null, true, false, 0, 1, 2, 3, 5, 7, 10, 19, 20, 40, 99, 1000, 1_000_001, -1, -7, 2.5, 0.25, 1e21,
    9_007_199_254_740_993, 9_007_199_254_740_991, '', ' ', '0', '1', '7', ' 3 ', '2.5', '-4', 'abc', '0x10', '1e3',
    'Infinity', 'NaN', 'dawn', ' DAWN ', '1d6+1', '1 D 6 + 1', 'stolen', ' gifted ', 'украдено', 'weapon', 'armor',
    'light', 'main_hand', '１２', 'ｓｔｏｌｅｎ',
  ]
  const KEYS = ['a', 'kind', 'current', 'max', 'id', 'name', 'value']

  function atom() {
    return pick(ATOMS)
  }

  function junk(depth = 0) {
    const roll = random()
    if (depth > 2 || roll < 0.6) return atom()
    if (roll < 0.75) return Array.from({ length: int(0, 3) }, () => junk(depth + 1))
    if (roll < 0.85) return pick(catalogIds)
    const object = {}
    for (let index = int(0, 3); index > 0; index -= 1) object[pick(KEYS)] = junk(depth + 1)
    return object
  }

  function rechargeProfile() {
    const roll = random()
    if (roll < 0.35) return { schema_version: 1, trigger: 'dawn', formula: '1d6+1' }
    if (roll < 0.5) return { schema_version: pick([1, '1', ' 1 ', 2, null, [1]]), trigger: pick(['dawn', ' Dawn ', 'DAWN', 'dusk', '', null]), formula: pick(['1d6+1', ' 1D6 + 1 ', '1d6 +\t1', '1d20+20', '2d6', null]) }
    if (roll < 0.6) return { schema_version: 999, trigger: 'midnight', formula: '100d100' }
    if (roll < 0.7) return { trigger: 'dawn', formula: '1d6+1' }
    return junk(1)
  }

  function charges() {
    const roll = random()
    if (roll < 0.5) return { current: pick([0, 1, 2, 3, 5, 6, 7, 9, 10, 19, 20, 99, -3, 2.5, '4', null, ' 7 ', 'abc']), max: pick([0, 1, 3, 7, 10, 20, 40, 999, 2.5, -2, '7', null, 1e21, 'Infinity']) }
    if (roll < 0.65) return { current: pick([0, 1, 3, 7, 19]) }
    if (roll < 0.75) return { max: pick([7, 10, 20]) }
    return junk(1)
  }

  /** Код каталога, как он встречается в сохранениях: свой, чужой, с пробелами. */
  function catalogRef({ prototypes = false } = {}) {
    const roll = random()
    if (roll < 0.62) return pick(catalogIds)
    if (roll < 0.7) return ` ${pick(catalogIds)} `
    if (roll < 0.78) return pick(['custom:compass', 'srd_5_2_1:unknown', 'scenario_astohan:unknown', 'srd_5_2_1:DAGGER', ''])
    if (prototypes && roll < 0.84) return pick(PROTOTYPE_KEYS)
    return junk(1)
  }

  function shuffle(entries) {
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const other = int(0, index)
      ;[entries[index], entries[other]] = [entries[other], entries[index]]
    }
    return entries
  }

  /** Вещь инвентаря: каталожная, самодельная или мусорная, поля в случайном порядке. */
  function inventoryItem(index, { prototypes = false } = {}) {
    const fields = []
    const ref = catalogRef({ prototypes })
    const idRoll = random()
    if (idRoll < 0.7) fields.push(['catalog_id', ref])
    else if (idRoll < 0.8) fields.push(['catalogId', ref])
    else if (idRoll < 0.85) fields.push(['catalog_id', null], ['catalogId', ref])
    if (chance(0.85)) fields.push(['id', chance(0.9) ? `item-${index}` : junk(1)])
    if (chance(0.15)) fields.push(['item_id', chance(0.8) ? `legacy-${index}` : junk(1)])
    if (chance(0.15)) fields.push(['stock_id', `stock-${index}`])
    if (chance(0.5)) fields.push(['name', chance(0.6) ? pick(['Лук следопыта', '  Старый меч  ', '', '   ', 'Флакон']) : junk(1)])
    if (chance(0.3)) fields.push(['description', chance(0.6) ? pick(['Самодельный амулет', '', ' ']) : junk(1)])
    if (chance(0.25)) fields.push(['properties', chance(0.6) ? pick(['Тяжёлый', '']) : junk(1)])
    if (chance(0.7)) fields.push(['quantity', pick([1, 1, 1, 2, 3, 0, -1, 2.5, '2', null, 20, 1e21, 9_007_199_254_740_993, 'abc'])])
    if (chance(0.4)) fields.push(['equipped', pick([true, false, 'yes', 1, null])])
    if (chance(0.15)) fields.push(['attuned_to', pick(['hero', null, ''])])
    if (chance(0.4)) fields.push(['charges', charges()])
    if (chance(0.3)) fields.push(['recharge', rechargeProfile()])
    if (chance(0.2)) fields.push(['activated', pick([true, false, 'true', 1])])
    if (chance(0.5)) fields.push(['type', pick(['weapon', 'armor', 'tool', 'other', 'consumable', null, 7])])
    if (chance(0.35)) fields.push(['combat', chance(0.6) ? { kind: pick(['melee', 'ranged', 'ruling']), damage: '1d6', twoHanded: pick([true, false]), properties: pick([['light'], ['finesse', 'light'], [], 'light']) } : junk(1)])
    if (chance(0.2)) fields.push(['requires_attunement', pick([true, false, 'true', null])])
    if (chance(0.2)) fields.push(['rarity', pick(['сюжетный', 'обычный', '', null])])
    if (chance(0.2)) fields.push(['origin', pick(['stolen', 'purchased', 'украдено', null, { kind: 'stolen' }])])
    if (chance(0.15)) fields.push(['secret', 'не переносить'])
    if (chance(0.3)) fields.push(['weight', pick([0, 0.25, 999, '2', null])])
    if (chance(0.2)) fields.push(['base_price_cp', pick([1, 0, 5_000, '10'])])
    if (chance(0.1)) fields.push(['passive_effects', [{ schema_version: 1, effect_id: 'forged', group: 'forged', armor_class_bonus: 99 }]])
    if (chance(0.08)) fields.push(['spellcasting_focus', ['wizard']])
    if (chance(0.08)) fields.push(['imagePosition', { x: 1, y: 2 }])
    if (chance(0.06)) fields.push(['appraisal', { value_cp: 10 }])
    if (chance(0.05)) fields.push(['sellable', pick([true, false])])
    if (chance(0.05)) fields.push(['quest_item', true])
    if (chance(0.05)) fields.push(['0', 'индекс'], ['12', 'ещё индекс'])
    return Object.fromEntries(shuffle(fields))
  }

  return { pick, int, chance, atom, junk, rechargeProfile, charges, catalogRef, inventoryItem, shuffle }
}

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const inventory = readFileSync(new URL('../src/InventoryViews.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('перетаскивание на куклу идёт той же командой, что и кнопка, и подчиняется тем же отказам', () => {
  // Сброс на место куклы и в сумку вызывает onEquip — серверную команду EquipItem
  // через App, а не меняет инвентарь в браузере.
  assert.match(inventory, /if \(itemId && allowed\) \{ onEquip\(itemId, true\)/u)
  assert.match(inventory, /if \(itemId && allowed\) \{ onEquip\(itemId, false\)/u)
  // В бою сброс запрещён теми же причинами, что и кнопка «Надеть».
  assert.match(inventory, /const dragBlockedReason = dragItem \? equipDisabledReasonFor\(dragItem\) : ''/u)
  assert.match(inventory, /!busy && !dragBlockedReason && dragItem\.capabilities\?\.equippable/u)
  // Место куклы принимает только вещь своего серверного слота.
  assert.match(inventory, /spec\.accepts\(equipSlotOf\(dragItem\)\)/u)
  assert.match(inventory, /item\.capabilities\?\.equip_slot \?\?/u)
})

test('кукла не считает бонус атаки сама: число приходит сводкой сервера', () => {
  assert.match(inventory, /const summary = item\.attack_summary/u)
  assert.doesNotMatch(inventory, /proficiency\s*\+|abilityModifier\(/u)
})

test('переключатель героев во вкладке ограничен доступными зрителю героями', () => {
  assert.match(app, /onSelectHero=\{setSelectedHeroId\}/u)
  assert.match(app, /selectableHeroIds=\{accessibleHeroIds\}/u)
  assert.match(inventory, /party\.filter\(\(candidate\) => !selectableHeroIds \|\| selectableHeroIds\.includes\(candidate\.id\)\)/u)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = ['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const inventorySource = readFileSync(new URL('../src/InventoryViews.tsx', import.meta.url), 'utf8')
const inventoryStyles = readFileSync(new URL('../src/inventory.css', import.meta.url), 'utf8')

test('замечания из ролика закреплены в компоновке основного игрового экрана', () => {
  assert.match(appSource, /saved\s*:\s*100/u, 'масштаб по умолчанию должен быть 100%')
  assert.match(appSource, /className="pending-check-overlay"/u, 'ожидающая проверка должна находиться поверх карты')
  assert.doesNotMatch(appSource, /Шаги не считаны/u)
  assert.doesNotMatch(appSource, /className="actions-resize"/u, 'нижняя панель не должна иметь лишний разделитель ширины')
  assert.doesNotMatch(appSource, /<TokenHealthBar fill=\{player/u, 'ОЗ героя не должны дублироваться под фишкой')
  assert.doesNotMatch(appSource, /<TokenHealthBar fill=\{summon/u, 'ОЗ призванного союзника не должны дублироваться под фишкой')
  assert.match(appSource, /size=\{76\}/u, 'рисунок заклинания в полном каталоге должен быть крупным')
  assert.match(stylesSource, /\.spellbook-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/su)
  assert.match(stylesSource, /\.players-list\s*\{[^}]*78px \* 6/su, 'до прокрутки должны помещаться шесть крупных строк отряда')
  // Колонка расширена до 44%, но не шире 680px: на 2560 она занимала почти
  // тысячу пикселей под два абзаца, а плиткам не хватало места.
  assert.match(stylesSource, /\.hotbar-main\s*\{[^}]*minmax\(460px,\s*min\(44%, 680px\)\)/su, 'описанию действия отведена расширенная колонка')
})

test('выбор получателя в инвентаре оформлен как часть тёмного интерфейса', () => {
  assert.match(inventorySource, /className="inventory-recipient"/u)
  assert.match(inventoryStyles, /\.inventory-recipient select\s*\{/u)
  assert.match(inventoryStyles, /\.inventory-recipient select:focus-visible\s*\{/u)
  assert.match(inventoryStyles, /\.inventory-recipient select:disabled\s*\{/u)
})

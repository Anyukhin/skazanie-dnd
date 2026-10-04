// Черновик мастера создания героя и бюджет стартовых покупок — плейтест
// 2026-10-04 (OB-01 и цикл 02 «стартовое богатство»).
//
// OB-01: мастер обещал «можно закрыть и вернуться позже», а второй Escape или
// крестик стирали вручную собранного героя — черновик жил только в state
// компонента. Богатство: при остатке 85 зм кираса за 400 зм ложилась в
// корзину, и мастер писал «осталось -315 зм», будто покупка состоялась.
//
// Чистая половина обоих исправлений живёт в `src/character-creation-draft.mjs`
// и проверяется здесь поведением; подключение к мастеру держится контрактом
// исходника ниже.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CREATION_DRAFT_VERSION,
  clearCreationDraft,
  creationDraftKey,
  goldLabel,
  mergeCreationDraft,
  purchaseShortfallCp,
  readCreationDraft,
  sessionDraftStorage,
  startingPurchaseBudget,
  writeCreationDraft,
} from '../src/character-creation-draft.mjs'

const wizard = readFileSync(new URL('../src/CharacterCreationWizard.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

/** Хранилище вкладки в памяти — то же API, что у `sessionStorage`. */
function memoryStorage() {
  const values = new Map()
  return {
    values,
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: (key) => { values.delete(key) },
  }
}

/** Хранилище, которое бросает на любом обращении: приватный режим, запрет сайта. */
const brokenStorage = {
  getItem: () => { throw new Error('SecurityError') },
  setItem: () => { throw new Error('QuotaExceededError') },
  removeItem: () => { throw new Error('SecurityError') },
}

const alna = {
  classId: 'sorcerer',
  speciesOptionId: 'elf-wood',
  character: 'Ална Верес',
  abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
  abilitiesCustomized: true,
  purchases: [{ id: 'longsword', quantity: 1 }],
}

test('черновик переживает закрытие мастера и возвращается тому же месту той же кампании', () => {
  const storage = memoryStorage()
  const key = creationDraftKey({ campaignCode: 'ESC0410', accountName: 'playtest-agent02', playerId: 'hero-slot-1', rulesetId: 'dnd_5e_2014' })
  assert.ok(key)
  assert.equal(writeCreationDraft(storage, key, { draft: alna, step: 'abilities', furthestStep: 'abilities' }), true)

  // Мастер размонтирован и открыт снова: ключ собирается из тех же частей.
  const reopenedKey = creationDraftKey({ campaignCode: 'ESC0410', accountName: 'playtest-agent02', playerId: 'hero-slot-1', rulesetId: 'dnd_5e_2014' })
  assert.deepEqual(readCreationDraft(storage, reopenedKey), { draft: alna, step: 'abilities', furthestStep: 'abilities' })
})

test('черновик не переходит к другому месту, кампании, аккаунту или редакции', () => {
  const storage = memoryStorage()
  const parts = { campaignCode: 'ESC0410', accountName: 'playtest-agent02', playerId: 'hero-slot-1', rulesetId: 'dnd_5e_2014' }
  writeCreationDraft(storage, creationDraftKey(parts), { draft: alna, step: 'abilities' })

  for (const other of [
    { ...parts, playerId: 'hero-slot-2' },
    { ...parts, campaignCode: 'ONB0410' },
    { ...parts, accountName: 'playtest-agent01' },
    { ...parts, rulesetId: 'srd_5_2_1' },
  ]) {
    const key = creationDraftKey(other)
    assert.notEqual(key, creationDraftKey(parts))
    assert.equal(readCreationDraft(storage, key), null, JSON.stringify(other))
  }
  // Без кампании или места ключа нет — и черновика тоже.
  assert.equal(creationDraftKey({ ...parts, campaignCode: '' }), null)
  assert.equal(creationDraftKey({ ...parts, playerId: undefined }), null)
  assert.equal(writeCreationDraft(storage, null, { draft: alna }), false)
  // Разделитель в имени аккаунта не склеивает части ключа.
  assert.notEqual(
    creationDraftKey({ ...parts, accountName: 'a:b', playerId: 'c' }),
    creationDraftKey({ ...parts, accountName: 'a', playerId: 'b:c' }),
  )
})

test('после создания героя черновик стирается', () => {
  const storage = memoryStorage()
  const key = creationDraftKey({ campaignCode: 'ESC0410', accountName: 'a', playerId: 'hero-slot-1' })
  writeCreationDraft(storage, key, { draft: alna, step: 'identity' })
  clearCreationDraft(storage, key)
  assert.equal(readCreationDraft(storage, key), null)
  assert.equal(storage.values.size, 0)
})

test('битая, чужая и недоступная запись не роняет мастер, а просто не читается', () => {
  const storage = memoryStorage()
  const key = creationDraftKey({ campaignCode: 'ESC0410', accountName: 'a', playerId: 'hero-slot-1' })
  for (const raw of ['{не json', 'null', '[]', JSON.stringify({ version: CREATION_DRAFT_VERSION + 1, draft: alna }), JSON.stringify({ version: CREATION_DRAFT_VERSION, draft: [] })]) {
    storage.setItem(key, raw)
    assert.equal(readCreationDraft(storage, key), null, raw)
  }
  assert.equal(readCreationDraft(brokenStorage, key), null)
  assert.equal(writeCreationDraft(brokenStorage, key, { draft: alna }), false)
  assert.doesNotThrow(() => clearCreationDraft(brokenStorage, key))
  assert.equal(readCreationDraft(null, key), null)
  // В Node `sessionStorage` нет — доступ к нему не бросает, а даёт `null`.
  assert.doesNotThrow(() => sessionDraftStorage())
})

test('сохранённый черновик ложится на свежий только полями той же формы', () => {
  const fresh = { classId: 'barbarian', character: '', abilities: { str: 15 }, purchases: [], knownSpellIds: [], purchaseQuantity: 1 }
  const merged = mergeCreationDraft(fresh, {
    classId: 'sorcerer',
    character: 'Ална Верес',
    abilities: null,
    purchases: 'кираса',
    knownSpellIds: ['fire-bolt'],
    purchaseQuantity: '3',
    injected: 'не из мастера',
    abilitiesCustomized: true,
  }, { abilitiesCustomized: 'boolean' })
  assert.deepEqual(merged, {
    classId: 'sorcerer',
    character: 'Ална Верес',
    abilities: { str: 15 },
    purchases: [],
    knownSpellIds: ['fire-bolt'],
    purchaseQuantity: 1,
    abilitiesCustomized: true,
  })
  assert.deepEqual(mergeCreationDraft(fresh, null), fresh)
})

const items = [
  { id: 'longsword', price_cp: 1500 },
  { id: 'shield', price_cp: 1000 },
  { id: 'explorers-pack', price_cp: 1000 },
  { id: 'breastplate', price_cp: 40000 },
]

test('протокол богатства: 120 зм, три покупки на 35 зм, кираса за 400 зм не помещается на 315 зм', () => {
  const purchases = [{ id: 'longsword', quantity: 1 }, { id: 'shield', quantity: 1 }, { id: 'explorers-pack', quantity: 1 }]
  const budget = startingPurchaseBudget({ budgetGp: 120, purchases, items })
  assert.deepEqual(budget, { spentCp: 3500, budgetCp: 12000, remainingCp: 8500, overBudgetCp: 0 })
  assert.equal(goldLabel(budget.remainingCp), '85 зм')
  const shortfall = purchaseShortfallCp({ remainingCp: budget.remainingCp, priceCp: 40000, quantity: 1 })
  assert.equal(shortfall, 31500)
  assert.equal(goldLabel(shortfall), '315 зм')
  // Ровно на остаток — можно; на медяк дороже — нельзя.
  assert.equal(purchaseShortfallCp({ remainingCp: 8500, priceCp: 8500, quantity: 1 }), 0)
  assert.equal(purchaseShortfallCp({ remainingCp: 8500, priceCp: 4251, quantity: 2 }), 2)
})

test('корзина дороже бюджета называет точное превышение, а без броска остаток неизвестен', () => {
  const over = startingPurchaseBudget({ budgetGp: 120, purchases: [{ id: 'longsword', quantity: 1 }, { id: 'breastplate', quantity: 1 }], items })
  assert.equal(over.remainingCp, -29500)
  assert.equal(over.overBudgetCp, 29500)
  const unrolled = startingPurchaseBudget({ budgetGp: undefined, purchases: [{ id: 'breastplate', quantity: 1 }], items })
  assert.deepEqual(unrolled, { spentCp: 40000, budgetCp: null, remainingCp: null, overBudgetCp: 0 })
  assert.equal(purchaseShortfallCp({ remainingCp: null, priceCp: 40000 }), 0)
  assert.equal(goldLabel(30), '0.3 зм')
})

test('мастер хранит черновик под ключом кампании и места и стирает его после создания', () => {
  assert.match(wizard, /creationDraftKey\(\{ campaignCode, accountName, playerId: player\.id, rulesetId: rulesetId \?\? catalog\.ruleset_id \}\)/u)
  assert.match(wizard, /readCreationDraft\(draftStorage, draftKey\)/u)
  assert.match(wizard, /writeCreationDraft\(draftStorage, draftKey, \{ draft, step, furthestStep \}\)/u)
  // Стирание — после успешного импорта и до закрытия; при отказе сервера черновик остаётся.
  assert.match(wizard, /await onImport\(JSON\.stringify\(document\)\)[\s\S]{0,240}clearCreationDraft\(draftStorage, draftKey\)\s*\n\s*onClose\(\)/u)
  // Шаг тоже восстанавливается: игрок возвращается туда, где закрыл мастер.
  assert.match(wizard, /useState<CreationStepId>\(restored\?\.step \?\? 'class'\)/u)
  assert.match(app, /<CharacterCreationWizard[\s\S]{0,600}campaignCode=\{state\.sessionCode\}/u)
  // Обещание «вернуться позже» звучит, только когда черновику есть где лежать.
  assert.match(wizard, /draftPersists\s*\n?\s*\? 'Пока герой не создан, ходить он не может\. Мастер можно закрыть и вернуться позже: выбор сохранится в этой вкладке до создания героя\.'/u)
  assert.doesNotMatch(wizard, /'Пока герой не создан, ходить он не может\. Мастер можно закрыть и вернуться позже\.'/u)
  // Escape по-прежнему закрывает мастер одним обработчиком: первый Escape в
  // открытом списке select гасит сам браузер, и это поведение не трогаем.
  assert.match(wizard, /event\.key === 'Escape' && !busy\) onClose\(\)/u)
})

test('«Добавить покупку» гаснет сверх остатка и называет нехватку', () => {
  assert.match(wizard, /purchaseShortfallCp\(\{ remainingCp: purchaseBudget\.remainingCp, priceCp: purchaseCandidatePriceCp, quantity: draft\.purchaseQuantity \}\)/u)
  assert.match(wizard, /draft\.purchaseQuantity < 1 \|\| purchaseShortfall > 0\}/u)
  assert.match(wizard, /if \(purchaseShortfall > 0\) return; patch\('purchases'/u)
  assert.match(wizard, /Не хватает \{goldLabel\(purchaseShortfall\)\}/u)
  assert.match(wizard, /корзина дороже бюджета на \{goldLabel\(purchaseBudget\.overBudgetCp\)\}/u)
  // Отрицательного остатка мастер больше не пишет.
  assert.doesNotMatch(wizard, /осталось \{\(wealthRoll\.total_gp \* 100 - purchaseTotal\) \/ 100\} зм/u)
  // Последняя защита на месте: шаг не пропускает корзину дороже бюджета.
  assert.match(wizard, /purchaseTotal > wealthRoll\.total_gp \* 100/u)
})

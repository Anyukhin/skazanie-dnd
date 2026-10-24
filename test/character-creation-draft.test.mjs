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
  abilityPreview,
  addStartingPurchase,
  clearCreationDraft,
  creationChecklist,
  creationDraftKey,
  firstIncompleteStepIndex,
  goldLabel,
  isRolledAssignment,
  mergeCreationDraft,
  pointBuySpent,
  pointBuyStep,
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
  // Escape закрывает мастер одним обработчиком, но в поле ввода только снимает
  // фокус: прежде Escape посреди предыстории закрывал весь мастер.
  assert.match(wizard, /if \(event\.key !== 'Escape' \|\| busy\) return/u)
  assert.match(wizard, /target instanceof HTMLInputElement \|\| target instanceof HTMLTextAreaElement \|\| target instanceof HTMLSelectElement\) \{\s*target\.blur\(\)\s*return\s*\}\s*onClose\(\)/u)
})

test('«Добавить покупку» гаснет сверх остатка и называет нехватку', () => {
  assert.match(wizard, /purchaseShortfallCp\(\{ remainingCp: purchaseBudget\.remainingCp, priceCp: purchaseCandidatePriceCp, quantity: draft\.purchaseQuantity \}\)/u)
  assert.match(wizard, /draft\.purchaseQuantity < 1 \|\| purchaseShortfall > 0\}/u)
  assert.match(wizard, /if \(purchaseShortfall > 0\) return; patch\('purchases', addStartingPurchase\(draft\.purchases, draft\.purchaseId, draft\.purchaseQuantity\)\)/u)
  assert.match(wizard, /Не хватает \{goldLabel\(purchaseShortfall\)\}/u)
  assert.match(wizard, /корзина дороже бюджета на \{goldLabel\(purchaseBudget\.overBudgetCp\)\}/u)
  // Отрицательного остатка мастер больше не пишет.
  assert.doesNotMatch(wizard, /осталось \{\(wealthRoll\.total_gp \* 100 - purchaseTotal\) \/ 100\} зм/u)
  // Последняя защита на месте: шаг не пропускает корзину дороже бюджета.
  assert.match(wizard, /purchaseTotal > wealthRoll\.total_gp \* 100/u)
})

// Ревью создания героя 2026-10-24: ошибки мастера, найденные в браузере и по коду.

test('одинаковая покупка прибавляется к своей строке', () => {
  const once = addStartingPurchase([], 'srd_5_2_1:dagger', 1)
  assert.deepEqual(addStartingPurchase(once, 'srd_5_2_1:dagger', 2), [{ id: 'srd_5_2_1:dagger', quantity: 3 }])
  assert.deepEqual(addStartingPurchase(once, 'srd_5_2_1:rope', 1), [{ id: 'srd_5_2_1:dagger', quantity: 1 }, { id: 'srd_5_2_1:rope', quantity: 1 }])
  assert.deepEqual(once, [{ id: 'srd_5_2_1:dagger', quantity: 1 }], 'корзина не меняется на месте')
})

test('восстановленная расстановка бросков 4к6 не сбрасывается в порядок бросков', () => {
  const scores = [12, 15, 9, 14, 11, 13]
  assert.equal(isRolledAssignment({ str: 15, dex: 14, con: 13, int: 12, wis: 11, cha: 9 }, scores), true)
  assert.equal(isRolledAssignment({ str: 15, dex: 14, con: 13, int: 12, wis: 11, cha: 10 }, scores), false)
  assert.equal(isRolledAssignment({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, scores), false)
  assert.match(wizard, /setDraft\(\(current\) => isRolledAssignment\(current\.abilities, abilityRoll\.scores\)\s*\? current/u)
})

test('создание героя проверяет все шаги и ведёт к первому незавершённому', () => {
  const issues = { class: '', race: '', proficiencies: 'Выберите 4 классовых навыка.', magic: 'Выберите 2 заговора.', identity: '' }
  assert.equal(firstIncompleteStepIndex(Object.keys(issues), (step) => issues[step]), 2)
  assert.equal(firstIncompleteStepIndex(['class', 'identity'], () => ''), -1)
  // Кнопка «Создать героя» не шлёт документ, пока хоть один шаг не завершён,
  // а переводит на этот шаг; галочка в навигации — только до него.
  assert.match(wizard, /const submit = async \(\) => \{\s*const incomplete = steps\[firstIncompleteIndex\]\s*if \(incomplete\) \{\s*setStep\(incomplete\.id\)/u)
  assert.match(wizard, /const verified = firstIncompleteIndex < 0 \|\| index < firstIncompleteIndex/u)
})

test('заклинания расширенного списка покровителя колдуна выбираются', () => {
  // Расширенный список приходит из каталога PHB, а не из списка класса:
  // поиск только в `spellRules.spells` молча отбрасывал щелчок.
  assert.match(wizard, /const spell = \[\.\.\.cantrips, \.\.\.leveledSpells\]\.find\(\(entry\) => entry\.id === id\)/u)
  assert.doesNotMatch(wizard, /const spell = spellRules\.spells\.find\(\(entry\) => entry\.id === id\)/u)
})

test('богатство, брошенное за другой класс, не запирает шаг снаряжения', () => {
  assert.match(wizard, /wealthRollForOtherClass = Boolean\(wealthRoll && wealthRoll\.class_id !== draft\.classId\)/u)
  assert.match(wizard, /draft\.equipmentMode === 'wealth' && wealthRollForOtherClass\) return wealthRollMismatchMessage/u)
  assert.match(wizard, /onClick=\{\(\) => patch\('equipmentMode', 'standard'\)\}>Взять наборы класса и предыстории/u)
})

test('случайный герой сразу открывает все шаги и ведёт к «Личности»', () => {
  assert.match(wizard, /character: pick\(RANDOM_NAMES\) \?\? 'Безымянный герой',\s*\}\)\)[\s\S]{0,240}setStep\('identity'\)\s*setFurthestStep\('identity'\)/u)
})

test('мелочи мастера: имя первым, мастерство после навыков, сокращения и aria-pressed', () => {
  const identity = wizard.slice(wizard.indexOf("currentStep === 'identity' && <div"))
  assert.ok(identity.indexOf('aria-label="Имя героя"') < identity.indexOf('Мировоззрение'), 'имя — первое поле личности')
  const choices = wizard.slice(wizard.indexOf("currentStep === 'proficiencies' && <div"))
  assert.ok(choices.indexOf('Классовые навыки') < choices.indexOf('<PhbCharacterOptions'), 'классовые выборы PHB — после навыков')
  assert.match(wizard, /wis: 'Мдр'/u)
  assert.match(wizard, /key=\{skill\.id\} type="button" aria-pressed=\{draft\.classSkillIds\.includes\(skill\.id\)\}/u)
  assert.match(wizard, /recommendedStandardArray\(current\.classId, catalog\.ability_policy\.standard_array\)/u)
})

test('импорт листа в редакторе виден игроку только у неготового героя', () => {
  assert.match(app, /onImport=\{isAdmin \|\| state\.players\.find\(\(player\) => player\.id === editingPlayerId\)\?\.characterSetupRequired/u)
})

// Шаг характеристик (−/+, бюджет, предпросмотр) и итоговый шаг — перенос с холста дизайна.

const POINT_BUY_COSTS = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 }

test('покупка за очки: шаг −/+ укладывается в 8–15 и бюджет 27', () => {
  const scores = { str: 15, dex: 14, con: 14, int: 8, wis: 10, cha: 8 }
  assert.equal(pointBuySpent(scores, POINT_BUY_COSTS), 25)
  assert.deepEqual(pointBuyStep({ scores, ability: 'wis', delta: 1, costs: POINT_BUY_COSTS }), { ok: true, score: 11, cost: 1 })
  // 14 → 15 стоит два очка, осталось ровно два — можно.
  assert.deepEqual(pointBuyStep({ scores, ability: 'dex', delta: 1, costs: POINT_BUY_COSTS }), { ok: true, score: 15, cost: 2 })
  const tight = { ...scores, wis: 11 }
  const refused = pointBuyStep({ scores: tight, ability: 'dex', delta: 1, costs: POINT_BUY_COSTS })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /Нужно 2 оч\., осталось 1/u)
  assert.equal(pointBuyStep({ scores, ability: 'str', delta: 1, costs: POINT_BUY_COSTS }).ok, false, 'выше 15 до прибавок нельзя')
  assert.equal(pointBuyStep({ scores, ability: 'int', delta: -1, costs: POINT_BUY_COSTS }).ok, false, 'ниже 8 нельзя')
  assert.deepEqual(pointBuyStep({ scores, ability: 'str', delta: -1, costs: POINT_BUY_COSTS }), { ok: true, score: 14, cost: -2 })
})

test('предпросмотр 1 уровня считает хиты, инициативу, атаку, спасброски и СЛ заклинаний', () => {
  const fighter = abilityPreview({
    abilities: { str: 15, dex: 16, con: 14, int: 8, wis: 11, cha: 8 },
    hitDie: 10, savingThrows: ['str', 'con'], primaryAbility: 'str',
  })
  assert.equal(fighter.hitPoints, 12)
  assert.equal(fighter.initiative, 3)
  assert.deepEqual(fighter.attack, { ability: 'str', bonus: 4 })
  assert.deepEqual(fighter.savingThrows, [{ ability: 'str', bonus: 4 }, { ability: 'con', bonus: 4 }])
  assert.equal(fighter.spell, null)
  const wizard = abilityPreview({ abilities: { str: 8, dex: 14, con: 8, int: 16, wis: 12, cha: 10 }, hitDie: 6, spellcastingAbility: 'int' })
  assert.equal(wizard.hitPoints, 5)
  assert.deepEqual(wizard.spell, { ability: 'int', saveDc: 13, attack: 5 })
  assert.equal(abilityPreview({ abilities: { con: 3 }, hitDie: 6 }).hitPoints, 2, 'не ниже 1 и с модификатором −4')
  assert.equal(abilityPreview({ abilities: {} }).hitPoints, null, 'без кости хитов не выдумывает число')
})

test('итоговый шаг показывает каждый шаг с отметкой и тем, чего не хватает', () => {
  const issues = { class: '', proficiencies: 'Выберите 2 классовых навыка.', identity: 'Назовите персонажа.' }
  assert.deepEqual(creationChecklist([
    { id: 'class', title: 'Класс' }, { id: 'proficiencies', title: 'Владения' }, { id: 'identity', title: 'Итог' },
  ], (step) => issues[step]), [
    { id: 'class', title: 'Класс', done: true, message: '' },
    { id: 'proficiencies', title: 'Владения', done: false, message: 'Выберите 2 классовых навыка.' },
    { id: 'identity', title: 'Итог', done: false, message: 'Назовите персонажа.' },
  ])
})

test('мастер подключает −/+, бюджет, предпросмотр и список «перед созданием»', () => {
  assert.match(wizard, /pointBuyStep\(\{ scores: draft\.abilities, ability, delta, costs: pointBuyCosts, budget: pointBuyBudget \}\)/u)
  assert.match(wizard, /aria-label=\{`Увеличить: \$\{abilityLabels\[ability\]\}`\} title=\{up\.ok \? undefined : up\.reason\} disabled=\{!up\.ok\}/u)
  assert.match(wizard, /className="creation-point-cells" role="img"/u)
  assert.match(wizard, /hitDie: classOption\?\.hit_die \?\? null, savingThrows: classOption\?\.saving_throws \?\? \[\]/u)
  assert.match(wizard, /creationChecklist\(steps, \(stepId\) => validateStepFor\(stepId as CreationStepId\)\)/u)
  assert.match(wizard, /\{ id: 'identity' as const, title: 'Итог', description: 'Имя и проверка' \}/u)
  // Порядок итогового шага: список недостающего, имя, затем лист героя.
  const identity = wizard.slice(wizard.indexOf("currentStep === 'identity' && <div"))
  assert.ok(identity.indexOf('creation-review-checklist') < identity.indexOf('creation-identity-name'))
  assert.ok(identity.indexOf('creation-identity-name') < identity.indexOf('creation-review-sheet'))
})

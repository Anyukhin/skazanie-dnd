import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { auditDndsuSpellCatalog, EXPECTED_SPELL_COUNT } from '../tools/verify-dndsu-spell-catalog.mjs'

const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const dictionary = JSON.parse(readFileSync(new URL('../data/spell-descriptions-ru.json', import.meta.url), 'utf8'))
const catalogIds = new Set(catalog.spells.map((spell) => spell.id))
const wordCount = (value) => String(value ?? '').trim().split(/\s+/u).filter(Boolean).length
const hasRussianText = (value) => typeof value === 'string' && value.trim() && /\p{Script=Cyrillic}/u.test(value)

test('читательский контракт покрывает ровно 439 карточек и не обещает серверную полноту', () => {
  assert.equal(catalog.spells.length, EXPECTED_SPELL_COUNT)
  assert.equal(Object.keys(dictionary.details ?? {}).length, EXPECTED_SPELL_COUNT)
  assert.equal(Object.keys(dictionary.higherLevels ?? {}).length, EXPECTED_SPELL_COUNT)
  assert.deepEqual(new Set(Object.keys(dictionary.details ?? {})), catalogIds)
  assert.deepEqual(new Set(Object.keys(dictionary.higherLevels ?? {})), catalogIds)

  for (const spell of catalog.spells) {
    const details = dictionary.details[spell.id]
    const higherLevels = dictionary.higherLevels[spell.id]
    assert.ok(hasRussianText(details), `${spell.id}: подробный текст должен быть русским и непустым`)
    assert.ok(wordCount(`${details} ${higherLevels ?? ''}`) <= 190, `${spell.id}: текст вместе с усилением длиннее 190 слов`)
    assert.ok(higherLevels === null || hasRussianText(higherLevels), `${spell.id}: higherLevels должен быть null или русским текстом`)
    if (typeof higherLevels === 'string') assert.ok(wordCount(higherLevels) <= 190, `${spell.id}: higherLevels длиннее 190 слов`)
    assert.equal(spell.higherLevels, higherLevels, `${spell.id}: каталог и редакционная карта higherLevels расходятся`)
    assert.equal(Object.hasOwn(spell, 'details'), false, `${spell.id}: details не должен входить в серверный каталог`)
    assert.ok(Array.isArray(spell.sourceClasses) && spell.sourceClasses.length, `${spell.id}: нет полного списка классов источника`)
    assert.ok(Array.isArray(spell.subclasses), `${spell.id}: список подклассов не проверен`)
  }
})

test('читательские карточки сохраняют проверенные значения масштабирования и длительности', () => {
  const details = dictionary.details
  assert.match(`${details.enervation} ${dictionary.higherLevels.enervation ?? ''}`, /1\s*к8/u, 'Enervation должен добавлять 1к8 за круг')
  assert.match(`${details['mass-cure-wounds']} ${dictionary.higherLevels['mass-cure-wounds'] ?? ''}`, /1\s*к8/u, 'Mass Cure Wounds должен добавлять 1к8 за круг')

  const geas = `${details.geas} ${dictionary.higherLevels.geas}`
  assert.match(geas, /7[^.]{0,100}год/iu, 'Geas: ячейки 7-го круга должны продлевать эффект до года')
  assert.match(geas, /8[^.]{0,100}год/iu, 'Geas: ячейки 8-го круга должны продлевать эффект до года')
  assert.match(geas, /9[^.]{0,150}(?:пока|снят|оконч|прекращ)/iu, 'Geas: ячейка 9-го круга должна продлевать эффект до снятия')

  const massSuggestion = `${details['mass-suggestion']} ${dictionary.higherLevels['mass-suggestion']}`
  assert.match(massSuggestion, /7[^.]{0,100}10\s*дн/iu, 'Mass Suggestion: ячейка 7-го круга должна длиться 10 дней')
  assert.match(massSuggestion, /8[^.]{0,100}30\s*дн/iu, 'Mass Suggestion: ячейка 8-го круга должна длиться 30 дней')
  assert.match(massSuggestion, /9[^.]{0,100}(?:год|365\s*дн)/iu, 'Mass Suggestion: ячейка 9-го круга должна длиться год')
  assert.match(massSuggestion, /год[^.]{0,20}день/iu, 'Mass Suggestion: к году добавляется один день')
})

test('аудит читательских данных сообщает точные нарушения контракта', () => {
  const changedCatalog = structuredClone(catalog)
  const changedDictionary = structuredClone(dictionary)
  changedDictionary.details['acid-splash'] = ''
  changedDictionary.details['unused-spell'] = 'Лишняя карточка.'
  changedDictionary.higherLevels['acid-splash'] = ''
  changedDictionary.higherLevels['unused-spell'] = null
  changedCatalog.spells[0].higherLevels = null
  changedCatalog.spells[1].subclasses = 'не массив'

  const report = auditDndsuSpellCatalog({ catalog: changedCatalog, dictionary: changedDictionary })
  const codes = new Set(report.problems.map((problem) => problem.code))
  assert.ok(codes.has('DETAILS_MISSING'))
  assert.ok(codes.has('DETAILS_UNKNOWN_ID'))
  assert.ok(codes.has('HIGHER_LEVELS_EMPTY'))
  assert.ok(codes.has('HIGHER_LEVELS_UNKNOWN_ID'))
  assert.ok(codes.has('HIGHER_LEVELS_DRIFT'))
  assert.ok(codes.has('INVALID_SUBCLASSES'))
})

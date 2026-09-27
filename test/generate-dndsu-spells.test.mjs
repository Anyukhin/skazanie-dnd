import assert from 'node:assert/strict'
import test from 'node:test'

import {
  areaFacts,
  classify,
  componentsFromPage,
  field,
  fnv1a64Hex,
  numberFromFeet,
  subclassesFromPage,
  sourceClassesFromPage,
  parseComponents,
  pageFacts,
  sourceMetadataForPage,
} from '../tools/generate-dndsu-spells.mjs'
import { normalizeSourceSchool } from '../tools/audit-dndsu-spell-sources.mjs'

test('парсер полей принимает реальную семантику строки, а не только точный HTML-шаблон', () => {
  const html = `
    <ul class="spell-facts">
      <li class="casting"><strong>Время накладывания:</strong><span>1 действие</span></li>
      <li><strong>Дистанция:&nbsp;</strong> <span>120 футов</span></li>
      <li data-kind="duration"><strong>Длительность:</strong><em>Концентрация, вплоть до 10 минут</em></li>
    </ul>`

  assert.equal(field(html, 'Время накладывания'), '1 действие')
  assert.equal(field(html, 'Дистанция'), '120 футов')
  assert.equal(field(html, 'Длительность'), 'Концентрация, вплоть до 10 минут')
  assert.deepEqual(pageFacts(html), {
    castingTime: '1 действие',
    rangeText: '120 футов',
    duration: 'концентрация, вплоть до 10 минут',
    description: '',
  })
})

test('парсер полей принимает карточку, где строки обёрнуты в p/div', () => {
  const html = `
    <section>
      <p class="fact"><strong>Время накладывания:</strong> 10 минут</p>
      <div class="fact"><strong>Дистанция:</strong><br>Касание</div>
      <p class="fact"><strong>Длительность:</strong> 24 часа</p>
    </section>`

  assert.deepEqual(pageFacts(html), {
    castingTime: '10 минут',
    rangeText: 'Касание',
    duration: '24 часа',
    description: '',
  })
})

test('геометрия распознаёт число перед формой области и не превращает конус в дальность', () => {
  assert.deepEqual(areaFacts('Высыпаете карты 15-футовым конусом.'), { areaShape: 'cone', radius: 15 })
  assert.deepEqual(areaFacts('Линия длиной 30-футовая линия.'), { areaShape: 'line', radius: 30 })
  assert.deepEqual(areaFacts('Куб со стороной 90 футов.'), { areaShape: 'cube', radius: 90 })
  assert.deepEqual(areaFacts('Цилиндр радиусом 30 футов.'), { areaShape: 'cylinder', radius: 30 })
  assert.equal(numberFromFeet('15-футовый конус'), 0)
  assert.equal(numberFromFeet('60 футов'), 60)
})

test('генератор выдаёт одинаковую форму area-полей для обычной и площадной карточки', () => {
  const base = { castingTime: '1 действие', rangeText: '60 футов', duration: 'мгновенная', description: 'Эффект без области.' }
  const regular = classify({}, base)
  assert.equal(regular.areaShape, null)
  assert.equal(regular.radius, null)
  const area = classify({}, { ...base, description: 'Существа в 15-футовом конусе совершают спасбросок Ловкости.' })
  assert.equal(area.areaShape, 'cone')
  assert.equal(area.radius, 15)
})

test('происхождение и пересказ усиления сохраняются при повторной генерации', () => {
  const html = '<title>Огненный шар / Заклинания D&D 5 / Player’s Handbook</title><article>source bytes</article>'
  const first = sourceMetadataForPage({
    card: {},
    html,
    fetchedAt: '2026-09-19T00:00:00.000Z',
    higherLevels: 'За каждый круг ячейки выше третьего: урон +1к6.',
  })
  const rerun = sourceMetadataForPage({
    card: {},
    html,
    fetchedAt: '2026-09-20T00:00:00.000Z',
    previous: first,
  })
  assert.equal(first.sourceHashFnv1a64, fnv1a64Hex(html))
  assert.equal(rerun.sourceHashFnv1a64, first.sourceHashFnv1a64)
  assert.deepEqual(rerun.sourceBooks, ['Player’s Handbook'])
  assert.equal(rerun.higherLevels, 'За каждый круг ячейки выше третьего: урон +1к6.')
  assert.equal(rerun.sourceFetchedAt, '2026-09-20T00:00:00.000Z')
})

test('проверенное отсутствие усиления очищает старую формулу и сохраняется при следующей генерации', () => {
  const args = { card: {}, html: '<title>Карточка заклинания</title>', fetchedAt: '2026-09-26T00:00:00.000Z' }
  const reviewed = sourceMetadataForPage({ ...args, previous: { higherLevels: 'Ошибочная прибавка урона.' }, higherLevels: null })
  assert.equal(reviewed.higherLevels, null)
  assert.equal(sourceMetadataForPage({ ...args, previous: reviewed }).higherLevels, null)
})

test('подклассы читаются из строки карточки, а фильтр страницы не считается списком', () => {
  const html = `<select><option>Подкласс</option></select><ul>
    <li><strong>Подклассы:</strong><a href="/classes/druid">круг дикого огня</a> (друид),
    <a href="/classes/cleric">домен жизни</a> (жрец), боевой кузнец (изобретатель)</li></ul>`
  const expected = ['круг дикого огня (друид)', 'домен жизни (жрец)', 'боевой кузнец (изобретатель)']
  assert.deepEqual(subclassesFromPage(html), expected)
  const args = { card: {}, fetchedAt: '2026-09-26T00:00:00.000Z' }
  const first = sourceMetadataForPage({ ...args, html })
  assert.deepEqual(sourceMetadataForPage({ ...args, html, previous: first }).subclasses, expected)
  assert.deepEqual(sourceMetadataForPage({ ...args, html: '<select><option>Подкласс</option></select>', previous: first }).subclasses, [])
})

test('названия подклассов сохраняют скобки и декодируют десятичные и шестнадцатеричные HTML-сущности', () => {
  const html = '<li><strong>Подклассы:</strong>Клятва &#171;Короны&#187; (паладин), Круг &amp; Пламя (&#x434;руид)</li>'
  assert.deepEqual(subclassesFromPage(html), ['Клятва «Короны» (паладин)', 'Круг & Пламя (друид)'])
})

test('справочник сохраняет изобретателя и пометки расширенного списка TCE отдельно от игровых классов', () => {
  const html = '<li><strong>Классы:</strong>волшебник, изобретатель, бард<sup>TCE</sup>, друид^{TCE}</li>'
  const expected = ['волшебник', 'изобретатель', 'бард (TCE)', 'друид (TCE)']
  assert.deepEqual(sourceClassesFromPage(html), expected)
  assert.deepEqual(sourceMetadataForPage({ card: {}, html, fetchedAt: '2026-09-26T00:00:00.000Z' }).sourceClasses, expected)
})

test('ритуальная пометка школы нормализуется отдельно от названия школы', () => {
  assert.equal(normalizeSourceSchool('Ограждение (ритуал)'), 'ограждение')
  assert.equal(normalizeSourceSchool('Ограждение'), 'ограждение')
  assert.notEqual(normalizeSourceSchool('Ограждение'), normalizeSourceSchool('Вызов'))
})

test('компоненты читаются только из отдельной строки источника', () => {
  assert.deepEqual(parseComponents('В, С'), { verbal: true, somatic: true, material: null })
  assert.deepEqual(parseComponents('В, С, М (крошечный шарик из гуано летучей мыши и серы)'), {
    verbal: true,
    somatic: true,
    material: {
      description: 'крошечный шарик из гуано летучей мыши и серы',
      costGp: null,
      consumed: false,
      focusSubstitutable: true,
    },
  })
  assert.equal(parseComponents(''), null)
  assert.equal(parseComponents('текст описания, который не является строкой компонентов'), null)
})

test('дорогой и расходуемый компонент сохраняет отказоустойчивое требование', () => {
  assert.deepEqual(parseComponents('В, С, М (алмаз стоимостью не менее 50 зм)'), {
    verbal: true,
    somatic: true,
    material: {
      description: 'алмаз стоимостью не менее 50 зм',
      costGp: 50,
      consumed: false,
      focusSubstitutable: false,
    },
  })
  assert.deepEqual(parseComponents('С, М (25 зм серебра, расходуемого заклинанием)'), {
    verbal: false,
    somatic: true,
    material: {
      description: '25 зм серебра, расходуемого заклинанием',
      costGp: 25,
      consumed: true,
      focusSubstitutable: false,
    },
  })
})

test('сложная стоимость не сворачивается в ложную одну цену', () => {
  const parsed = parseComponents('В, С, М (пара колец по 50 зм каждое)')
  assert.equal(parsed.material.costGp, null)
  assert.equal(parsed.material.focusSubstitutable, false)
  assert.equal(parsed.material.unresolved, true)
  assert.match(parsed.material.requirementNote, /количеств/u)
  const homunculus = parseComponents('В, С, М (глина, пепел и корень мандрагоры, расходуемые заклинанием, и украшенный кинжал стоимостью 1000 зм)')
  assert.equal(homunculus.material.unresolved, true)
  assert.equal(homunculus.material.focusSubstitutable, false)
  assert.match(homunculus.material.requirementNote, /Часть набора/u)
})

test('стоимость сохраняет тысячи, дробную сумму и серебряные монеты', () => {
  assert.equal(parseComponents('В, С, М (кубок стоимостью 1000 зм)').material.costGp, 1000)
  assert.equal(parseComponents('В, С, М (кубок стоимостью 1 000 зм)').material.costGp, 1000)
  assert.equal(parseComponents('В, С, М (порошок стоимостью 0,5 зм)').material.costGp, 0.5)
  assert.equal(parseComponents('С, М (оружие стоимостью не менее 1 см)').material.costGp, 0.1)
  assert.equal(parseComponents('В, М (две иголки или щепка)').material.focusSubstitutable, true)
  assert.equal(parseComponents('В, М (камень, который не расходуется)').material.consumed, false)
})

test('компоненты извлекаются из source row, а не из общего описания', () => {
  const html = `
    <ul>
      <li><strong>Компоненты:</strong> В, С, М (алмаз стоимостью 50 зм)</li>
      <li><strong>Длительность:</strong> Мгновенная</li>
    </ul>
    <div itemprop="description">В описании упоминается серебряная монета, но это не строка компонентов.</div>`
  assert.deepEqual(componentsFromPage(html), {
    verbal: true,
    somatic: true,
    material: {
      description: 'алмаз стоимостью 50 зм',
      costGp: 50,
      consumed: false,
      focusSubstitutable: false,
    },
  })
})

test('подпись строки и особый А-компонент не теряются; комментарии не подменяют источник', () => {
  assert.deepEqual(parseComponents('* Компоненты: В, С'), { verbal: true, somatic: true, material: null })
  assert.deepEqual(parseComponents('В, С, А (1 зм)'), {
    verbal: true, somatic: true, material: null, special: [{ kind: 'royalty', description: '1 зм' }],
  })
  assert.equal(componentsFromPage('<div itemprop="description">Нет строки компонентов.</div><h2>Комментарии</h2><li><strong>Компоненты:</strong> В, С</li>'), null)
})

test('монета и отчисления Джима разбираются как независимые M и А', () => {
  const expected = {
    verbal: false, somatic: true,
    material: { description: 'монетка', costGp: null, consumed: false, focusSubstitutable: true },
    special: [{ kind: 'royalty', description: '2 зм' }],
  }
  assert.deepEqual(parseComponents('С, М (монетка), А (2 зм)'), expected)
  assert.deepEqual(parseComponents('S, A (2 зм), M (монетка)'), expected)
  assert.deepEqual(componentsFromPage('<li><strong>Компоненты:</strong> С, М (монетка), А (2 зм)</li>'), expected)
  const costly = parseComponents('В, М (алмаз стоимостью 50 зм), А (2 зм)')
  assert.equal(costly.material.costGp, 50, 'авторские отчисления не меняют стоимость вещи')
  assert.equal(costly.material.unresolved, undefined)
  assert.deepEqual(costly.special, [{ kind: 'royalty', description: '2 зм' }])
})

test('отчисления в source-форме Подарка болтуна не становятся материальной вещью', () => {
  assert.deepEqual(parseComponents('В, С, М (А 2 зм)'), {
    verbal: true, somatic: true, material: null,
    special: [{ kind: 'royalty', description: '2 зм' }],
  })
  assert.equal(parseComponents('В, М (алмаз стоимостью 2 зм)').material.costGp, 2)
  assert.equal(parseComponents('В, М (А 2 камня)').material.description, 'А 2 камня')
})

test('вложенное пояснение и запятые остаются внутри материала, повреждённая строка отвергается', () => {
  assert.equal(parseComponents('В, М (веточка (дуба), нить)').material.description, 'веточка (дуба), нить')
  for (const source of ['В, М (монетка), А (2 зм', 'М (монетка)), А (2 зм)', 'В, С,', 'В, В', 'В, М (монетка), неизвестный компонент', 'В, М (А 2 зм), А (2 зм)']) {
    assert.equal(parseComponents(source), null, source)
  }
})

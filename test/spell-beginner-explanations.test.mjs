import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'skazanie-spell-beginner-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/spell-explanations.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--noCheck', '--noResolve', '--target', 'ES2022', '--module', 'ESNext', '--outDir', root, source], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
writeFileSync(join(root, 'spell-explanations.mjs'), readFileSync(join(root, 'spell-explanations.js')))
const { beginnerComponentDetails, beginnerSpellGuide, readableSpellText, spellTextExplanations } = await import(pathToFileURL(join(root, 'spell-explanations.mjs')).href)
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url))).spells
const dictionary = JSON.parse(readFileSync(new URL('../data/spell-descriptions-ru.json', import.meta.url)))
const spell = id => catalog.find(s => s.id === id)
const components = id => beginnerComponentDetails(spell(id).components).join(' ')
const guide = id => beginnerSpellGuide(spell(id)).map(row => row.text).join(' ')

test('Щит объясняет слова, свободную руку и отсутствие предметов, а реакцию связывает с попаданием', () => {
  assert.match(components('shield'), /Магические слова.*вербальный.*Жесты рукой.*соматический.*свободная рука/su)
  assert.match(components('shield'), /Материальный компонент.*не требуется/u)
  assert.match(guide('shield'), /реакция.*когда по вам попадает атака.*начала своего следующего хода/su)
  assert.match(guide('shield'), /дождитесь окна реакции/u)
})
test('дорогой расходуемый материал требует настоящих предметов и нового набора', () => {
  const text = components('revivify')
  assert.match(text, /300 золотых монет/u)
  assert.match(text, /уплата денег не заменяет сам предмет/u)
  assert.match(text, /расходуются.*новый набор/su)
  assert.match(text, /фокусировка.*их не заменяют/su)
  assert.doesNotMatch(text, /можно использовать мешочек/u)
})
test('дорогой нерасходуемый материал сохраняется, но не заменяется фокусировкой', () => {
  assert.match(components('identify'), /100 золотых монет/u)
  assert.match(components('identify'), /не расходуются.*повторно/su)
  assert.match(components('identify'), /фокусировка.*их не заменяют/su)
})
test('обычный заменяемый материал объясняет фокусировку и общую руку для жестов', () => {
  assert.match(components('fireball'), /можно использовать мешочек с компонентами либо магическую фокусировку/u)
  assert.match(components('fireball'), /жезл или священный символ/u)
  assert.match(components('fireball'), /Ею же можно выполнить жесты/u)
})
test('ошибочный флаг замены не даёт обещание заменить дорогой или расходуемый материал', () => {
  for (const material of [{ costGp: 50, consumed: false }, { costGp: null, consumed: true }]) {
    const text = beginnerComponentDetails({ verbal: false, somatic: false, material: { description: 'особый предмет', focusSubstitutable: true, ...material } }).join(' ')
    assert.doesNotMatch(text, /можно использовать мешочек/u)
    assert.match(text, /Нужны именно указанные предметы/u)
  }
})
test('сложный материал не выдаёт неподтверждённую замену или расходование всего набора', () => {
  const text = beginnerComponentDetails({ verbal: false, somatic: false, material: { description: 'особый набор', costGp: null, consumed: true, focusSubstitutable: true, unresolved: true } }).join(' ')
  assert.match(text, /замена и расходование всего набора не подтверждены/u)
  assert.doesNotMatch(text, /новый набор|могут использоваться повторно|можно использовать мешочек/u)
})
test('ритуал требует разрешения класса, добавляет 10 минут и сохраняет компоненты', () => {
  assert.match(guide('identify'), /Ритуал.*без расхода ячейки.*10 минут.*Нужна особенность.*Компоненты всё равно нужны.*нельзя.*усиления/su)
  assert.match(guide('identify'), /всё время сохранять концентрацию.*без концентрации после применения/su)
})
test('бонусное заклинание сохраняет ограничение других заклинаний на том же ходу', () => {
  assert.match(guide('hex'), /только заговором со временем «1 действие».*порядок применения.*не меняет/su)
})
test('концентрация объясняет один эффект, отдельный спасбросок и независимость от обычных атак', () => {
  assert.match(guide('hex'), /только одно.*прежнее.*Телосложения.*10 или половиной.*большее/su)
  assert.match(guide('hex'), /недееспособность или смерть/u)
  assert.match(guide('hex'), /движение и атаки сами по себе её не прекращают/u)
})
test('кубики и постоянные прибавки объясняются численно без смешивания уровня ячейки', () => {
  const rows = spellTextExplanations('1d4 + 1, 8к6, к4, 1к4 − 1, 1к4+1. КД. Спасбросок Мудрости Сл 15.')
  assert.equal(rows.filter(r => r.label === '1к4+1').length, 1)
  assert.match(rows.find(r => r.label === '1к4+1').text, /прибавьте 1.*от 2 до 5/su)
  assert.match(rows.find(r => r.label === '8к6').text, /8 кубиков.*6 гранями.*от 8 до 48/su)
  assert.match(rows.find(r => r.label === '1к4-1').text, /вычтите 1.*от 0 до 3/su)
  assert.ok(rows.some(r => r.label.startsWith('Класс доспеха')))
  assert.match(rows.find(r => r.label.startsWith('Спасбросок')).text, /не имеет автоматического успеха на 20/u)
})
test('текст раскрывает золото, футы и английские кубики, сохраняя метрические единицы', () => {
  assert.equal(readableSpellText('100 зм; 30 фт; 1d8+2; 5 см и 2 мм.'), '100 золотых монет; 30 футов; 1к8+2; 5 см и 2 мм.')
})
test('показатель опасности раскрывается для ПО, но не для обычного слова «по»', () => {
  assert.ok(spellTextExplanations('Зверь с ПО 1/2.').some(r => r.label.startsWith('Показатель опасности')))
  assert.ok(!spellTextExplanations('Бонус по цели.').some(r => r.label.startsWith('Показатель опасности')))
})
test('все 439 карточек получают требования и пояснения без изменения исходных данных и поддержки', () => {
  const before = JSON.stringify(catalog)
  for (const entry of catalog) {
    const rows = beginnerSpellGuide(entry)
    for (const label of ['Кто может применить', 'Что расходуется', 'Когда применять', 'Как выбрать цель']) assert.ok(rows.some(r => r.label === label && r.text.length > 30), `${entry.id}: ${label}`)
    const terms = spellTextExplanations(`${dictionary.details[entry.id]} ${dictionary.higherLevels[entry.id] ?? ''} ${entry.castingTime} ${entry.rangeText}`)
    assert.ok(terms.length, `${entry.id}: нет пояснений`)
    assert.equal(new Set(terms.map(r => r.label)).size, terms.length, `${entry.id}: повтор пояснения`)
    assert.ok(beginnerComponentDetails(entry.components).length >= 3)
  }
  assert.equal(JSON.stringify(catalog), before)
})

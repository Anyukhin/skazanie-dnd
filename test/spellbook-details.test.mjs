import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { spellCatalogInfo } from '../server/combat-spells.mjs'

const catalog = JSON.parse(await readFile(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const overrides = JSON.parse(await readFile(new URL('../data/dndsu-spell-mechanics-overrides.json', import.meta.url), 'utf8'))
const [spellbook, detail, styles, combatSpells, dungeonMap] = await Promise.all([
  readFile(new URL('../src/Spellbook.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/SpellDetail.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/spellbook.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/combat-spells.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8'),
])

test('каталог сохраняет 439 карточек и все обязательные поля источника', () => {
  assert.equal(catalog.spells.length, 439)
  for (const spell of catalog.spells) {
    for (const field of ['id', 'name', 'level', 'school', 'castingTime', 'rangeText', 'components', 'ritual', 'concentration', 'duration', 'classes', 'description', 'sourceUrl', 'sourceBooks', 'sourceFetchedAt', 'sourceHashFnv1a64']) {
      assert.ok(Object.hasOwn(spell, field), `${spell.id}: нет поля ${field}`)
    }
  }
})

test('подробности выводят базовые характеристики, классы, подклассы, повышение и источник', () => {
  for (const field of ['school', 'castingTime', 'rangeText', 'components', 'ritual', 'concentration', 'duration', 'classes', 'sourceClasses', 'subclasses', 'spellUpcastText', 'sourceUrl']) {
    assert.match(detail, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `нет поля ${field}`)
  }
  assert.match(detail, /Отдельные сведения о повышении уровня отсутствуют/u)
  assert.match(detail, /spell.higherLevels === null/u)
  assert.match(detail, /Усиление ячейкой более высокого круга не предусмотрено/u)
  assert.match(detail, /Заговор не использует ячейки/u)
  assert.match(detail, /Подробности карточки доступны для чтения/u)
  assert.match(detail, /CombatIcon/u)
  assert.match(detail, /Эффект в игре/u)
  assert.match(detail, /damageTypeLabel/u)
  assert.match(detail, /conditionPresentation/u)
  assert.match(detail, /runtimeConditionLabel/u)
  assert.match(detail, /runtimeUnsupported/u)
  assert.match(detail, /mechanicsSupport === 'heuristic'/u)
  assert.match(detail, /Параметры эффекта пока не подтверждены/u)
  assert.match(detail, /spellDescriptionParagraphs/u)
  assert.match(detail, /details\?\.trim\(\) \|\| spell\.description/u)
  assert.match(detail, /\\r\?\\n\\s\*\\r\?\\n/u)
  assert.match(detail, /длина конуса/u)
  assert.match(detail, /сторона .*футов/u)
  assert.match(detail, /Книга источника/u)
  assert.match(detail, /5e14\.dnd\.su/u)
})

test('карточка заблокированного заклинания остаётся открываемой, а описание не обрезается', () => {
  assert.match(spellbook, /aria-expanded=\{active\}/u)
  assert.match(spellbook, /Весь каталог/u)
  assert.match(spellbook, /CombatIcon/u)
  assert.match(spellbook, /selectedVisibleId/u)
  assert.match(spellbook, /в списке/u)
  assert.match(spellbook, /cleanReason/u)
  assert.match(spellbook, /spellDescriptionCatalog/u)
  assert.match(spellbook, /Открыто для чтения/u)
  assert.doesNotMatch(spellbook, /disabled=.*blocked/u)
  assert.doesNotMatch(styles, /line-clamp|text-overflow:\s*ellipsis/u)
  assert.match(styles, /white-space:\s*normal/u)
})

test('полный каталог даёт всем 439 карточкам тот же статус, что и серверный canonical helper', () => {
  const statusFor = (spell) => overrides.spells[spell.id]?.mechanicsSupport
    ?? (overrides.spells[spell.id] ? 'partial' : 'heuristic')
  const counts = Object.groupBy(catalog.spells.map(statusFor), (status) => status)
  const info = spellCatalogInfo()
  assert.equal(catalog.spells.length, 439)
  assert.deepEqual({
    verified: counts.verified?.length ?? 0,
    partial: counts.partial?.length ?? 0,
    heuristic: counts.heuristic?.length ?? 0,
    'ruling-only': counts['ruling-only']?.length ?? 0,
  }, {
    verified: info.verifiedMechanics,
    partial: info.partialMechanics,
    heuristic: info.heuristicMechanics,
    'ruling-only': info.rulingOnlyMechanics,
  })
  assert.match(combatSpells, /const mechanicsSupport = projected\.mechanicsSupport[\s\S]*staticOverride\.mechanicsSupport/u)
  assert.match(combatSpells, /const components = projected\.components \?\? staticOverride\.components \?\? catalogSpell\.components/u)
  assert.match(dungeonMap, /const Spellbook = lazy\(\(\) => import\('\.\/Spellbook'\)/u)
  assert.match(dungeonMap, /<Suspense fallback=/u)
})

// Плейтест 2026-10-04, MG-03: плитка и панель параметров «Скорохода» писали
// «5 фт», а книга — «Касание». Подпись дальности одна — `spellRangeLabel` из
// карточки книги; футы остаются только в подсказке как мерка доски.
test('плитка и панель параметров подписывают дальность тем же spellRangeLabel, что и книга', () => {
  const longstrider = catalog.spells.find((spell) => spell.id === 'longstrider')
  assert.equal(longstrider.rangeText, 'Касание')
  assert.equal(longstrider.range, 5, 'футы касания нужны доске, но не подписи')
  assert.match(detail, /\['Дистанция', spellRangeLabel\(spell\)\]/u)
  assert.match(dungeonMap, /import \{ spellRangeLabel \} from '\.\/SpellDetail'/u)
  assert.match(dungeonMap, /<small>\{spell\.level \? `\$\{spell\.level\} круг` : 'заговор'\} · \{spellRangeLabel\(spell\)\}<\/small>/u)
  assert.match(dungeonMap, /title=\{selectedSpellRange > 0 \? `Дальность на карте: \$\{selectedSpellRange\} фт` : 'Заклинание на себя'\}>\{spellRangeLabel\(selectedSpell\)\}<\/i>/u)
  assert.doesNotMatch(dungeonMap, /\{spellRange\(spell\)\} фт/u)
  assert.doesNotMatch(dungeonMap, />\{selectedSpellRange\} фт<\/i>/u)
})

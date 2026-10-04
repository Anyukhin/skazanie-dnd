// Счётчики книги заклинаний — плейтест 2026-10-04, OB-02 / MG-02.
//
// Кнопка «Книга» писала «45 в списке», книга — «45 из 45», хотя у волшебника
// было 3 заговора, 6 заклинаний в книге и 3 подготовленных. Сорок пять — это
// список класса, который сервер отдаёт целиком, помечая неизученное
// `prepared: false`. Счётчики разведены в `src/spellbook-summary.mjs`; здесь
// они считаются по настоящей серверной проекции (`combatSpellsFor`) — тому же
// источнику, которым решается доступность заклинания на панели.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { combatSpellsFor, spellSelectionRulesFor } from '../server/combat-spells.mjs'
import { heroSpellCounts, heroSpellSummary, heroSpellTileLabel } from '../src/spellbook-summary.mjs'

const dungeonMap = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const spellbook = readFileSync(new URL('../src/Spellbook.tsx', import.meta.url), 'utf8')
const RULESET = 'dnd_5e_2014'

/** Герой с выбором заклинаний поверх полного списка класса. */
function caster(characterClass, ability, pick) {
  const base = { id: 'hero', characterClass, level: 1, abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 10, cha: 10, [ability]: 16 } }
  const list = combatSpellsFor(base, { rulesetId: RULESET })
  const hero = { ...base, ...pick(list) }
  return { hero, spells: combatSpellsFor(hero, { rulesetId: RULESET }), mode: spellSelectionRulesFor(hero)?.mode ?? null }
}

const ids = (spells, level, count) => spells.filter((spell) => spell.level === level).slice(0, count).map((spell) => spell.id)

test('волшебник из протокола: заговоры 3 · книга 6 · подготовлено 3, а список класса — отдельно', () => {
  const { hero, spells, mode } = caster('wizard', 'int', (list) => {
    const book = ids(list, 1, 6)
    return { knownSpellIds: [...ids(list, 0, 3), ...book], preparedSpellIds: book.slice(0, 3) }
  })
  assert.equal(mode, 'spellbook')
  const counts = heroSpellCounts(spells, { mode, knownSpellIds: hero.knownSpellIds })
  assert.ok(spells.length > 20, 'список класса длиннее книги — ради этого счётчики и разведены')
  assert.deepEqual(counts, { mode: 'spellbook', cantrips: 3, book: 6, prepared: 3, innate: 0, list: spells.length })
  assert.equal(heroSpellSummary(counts), `Заговоры 3 · книга 6 · подготовлено 3 · список класса ${spells.length}`)
  assert.equal(heroSpellTileLabel(counts), 'книга 6 · подг. 3')
  // Неизученный заговор остаётся в списке класса, но героем не считается.
  const unlearned = spells.find((spell) => spell.level === 0 && !hero.knownSpellIds.includes(spell.id))
  assert.equal(unlearned?.prepared, false)
})

test('известные заклинания барда и подготовленные жреца подписаны своим словом', () => {
  const bard = caster('bard', 'cha', (list) => ({ knownSpellIds: [...ids(list, 0, 2), ...ids(list, 1, 4)] }))
  assert.equal(bard.mode, 'known')
  const bardCounts = heroSpellCounts(bard.spells, { mode: bard.mode, knownSpellIds: bard.hero.knownSpellIds })
  assert.equal(heroSpellSummary(bardCounts), `Заговоры 2 · известно 4 · список класса ${bard.spells.length}`)
  assert.equal(heroSpellTileLabel(bardCounts), 'известно 4')

  const cleric = caster('cleric', 'wis', (list) => ({ knownSpellIds: ids(list, 0, 3), preparedSpellIds: ids(list, 1, 4) }))
  assert.equal(cleric.mode, 'prepared')
  const clericCounts = heroSpellCounts(cleric.spells, { mode: cleric.mode, knownSpellIds: cleric.hero.knownSpellIds })
  assert.equal(clericCounts.book, null, 'книги у жреца нет')
  assert.equal(heroSpellTileLabel(clericCounts), 'подготовлено 4')
})

test('старый герой без выбора: в книге всё, как и в правилах доступности', () => {
  const { spells, mode } = caster('wizard', 'int', () => ({}))
  const counts = heroSpellCounts(spells, { mode, knownSpellIds: undefined })
  const leveled = spells.filter((spell) => spell.level > 0).length
  assert.equal(counts.book, leveled)
  assert.equal(counts.prepared, leveled)
})

test('врождённые заклинания расы идут отдельной строкой и в лимиты класса не входят', () => {
  const spells = [
    { id: 'fire-bolt', level: 0, prepared: true },
    { id: 'acid-splash', level: 0, prepared: false },
    { id: 'dancing-lights', level: 0, prepared: true, innateSpell: true },
    { id: 'magic-missile', level: 1, prepared: true },
    { id: 'shield', level: 1, prepared: false },
  ]
  const counts = heroSpellCounts(spells, { mode: 'spellbook', knownSpellIds: ['fire-bolt', 'magic-missile', 'shield'] })
  assert.deepEqual(counts, { mode: 'spellbook', cantrips: 1, book: 2, prepared: 1, innate: 1, list: 5 })
  assert.equal(heroSpellSummary(counts), 'Заговоры 1 · книга 2 · подготовлено 1 · врождённые 1 · список класса 5')
  // Не заклинатель: ни книги, ни «списка класса» — только то, что есть.
  const tiefling = heroSpellCounts([{ id: 'thaumaturgy', level: 0, prepared: true, innateSpell: true }], { mode: null })
  assert.equal(heroSpellSummary(tiefling), 'Врождённые 1 · в списке 1')
  assert.equal(heroSpellTileLabel(tiefling), 'врождённые 1')
  assert.equal(heroSpellTileLabel(heroSpellCounts([], {})), 'в списке 0')
})

test('плитка и книга показывают разведённые счётчики, а не длину списка класса', () => {
  assert.match(dungeonMap, /heroSpellCounts\(spells, \{ mode: spellSelectionRules\(activeHero\)\?\.mode \?\? null, knownSpellIds: activeHero\?\.knownSpellIds \?\? null \}\)/u)
  assert.match(dungeonMap, /<strong>Книга<\/strong><small>\{heroSpellTileLabel\(heroSpellTally\)\}<\/small>/u)
  assert.doesNotMatch(dungeonMap, /\{spells\.length\} в списке/u)
  assert.doesNotMatch(dungeonMap, /заклинаний в списке героя/u)
  assert.match(dungeonMap, /heroSummary=\{heroSpellLine\}/u)
  assert.match(spellbook, /\$\{activeName\} · \$\{heroSummary \|\| `\$\{spells\.length\} в списке`\}/u)
  // Вкладка называет список класса списком класса, а не «героя».
  assert.match(spellbook, />Список класса<\/button>/u)
  assert.doesNotMatch(spellbook, />Героя<\/button>/u)
  assert.match(spellbook, /Показано \{filtered\.length\} из \{visibleSpells\.length\}/u)
  // Неизученная карточка по-прежнему объясняет, почему её нельзя применить.
  assert.match(dungeonMap, /if \(spell\.prepared === false\) return 'Заклинание не изучено или не подготовлено'/u)
})

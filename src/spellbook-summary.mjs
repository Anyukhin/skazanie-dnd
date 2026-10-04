/**
 * Счётчики книги заклинаний героя.
 *
 * Плейтест 2026-10-04, OB-02 / MG-02: кнопка «Книга» и сама книга писали
 * «45 в списке» и «45 из 45», хотя у волшебника было 3 заговора, 6 заклинаний
 * в книге и 3 подготовленных. Сорок пять — это список заклинаний класса до
 * доступного круга, который сервер отдаёт целиком (`combatSpellsFor`), помечая
 * неизученное `prepared: false`. Новичок читал его как «мои 45 заклинаний».
 *
 * Здесь счётчики разведены: заговоры, книга (у волшебника), известные (у
 * барда, чародея, колдуна, следопыта), подготовленные и список класса.
 * Источник тот же, что решает доступность заклинания на панели: флаг
 * `prepared` из проекции и `knownSpellIds` героя для книги — как в мастере
 * развития (`src/InventoryViews.tsx`). Своих лимитов здесь нет: сколько можно
 * знать и готовить, решает сервер.
 *
 * Отдельный `.mjs` — чтобы корпус проверял счёт поведением, а не регуляркой.
 */

/**
 * @typedef {{ id: string, level: number, prepared?: boolean, innateSpell?: boolean }} SummarySpell
 * @typedef {'spellbook' | 'known' | 'prepared'} SpellSelectionMode
 * @typedef {{
 *   mode: SpellSelectionMode | null,
 *   cantrips: number,
 *   book: number | null,
 *   prepared: number,
 *   innate: number,
 *   list: number,
 * }} HeroSpellCounts
 */

const usable = (/** @type {SummarySpell} */ spell) => spell?.prepared !== false

/**
 * @param {readonly SummarySpell[]} spells заклинания героя из проекции (вместе с запасными)
 * @param {{ mode?: SpellSelectionMode | null, knownSpellIds?: readonly string[] | null }} [options]
 *   `mode` — из `spellSelectionRules` героя; `knownSpellIds` — книга волшебника.
 *   Нет поля у старого героя — в книге всё, как и в правилах доступности.
 * @returns {HeroSpellCounts}
 */
export function heroSpellCounts(spells, { mode = null, knownSpellIds = null } = {}) {
  const list = Array.isArray(spells) ? spells : []
  // Врождённые заклинания расы и черт идут отдельной строкой: в лимиты класса
  // они не входят, и мастер развития их тоже не считает.
  const own = list.filter((spell) => spell?.innateSpell !== true)
  const known = Array.isArray(knownSpellIds) ? new Set(knownSpellIds.map(String)) : null
  const leveled = own.filter((spell) => Number(spell?.level) > 0)
  return {
    mode: mode ?? null,
    cantrips: own.filter((spell) => Number(spell?.level) === 0 && usable(spell)).length,
    book: mode === 'spellbook' ? leveled.filter((spell) => !known || known.has(String(spell.id))).length : null,
    prepared: leveled.filter(usable).length,
    innate: list.filter((spell) => spell?.innateSpell === true && usable(spell)).length,
    list: list.length,
  }
}

/**
 * Полная строка: «Заговоры 3 · книга 6 · подготовлено 3 · список класса 45».
 * Список класса подписан как список, а не как владение героя.
 *
 * @param {HeroSpellCounts} counts
 * @returns {string}
 */
export function heroSpellSummary(counts) {
  const parts = []
  if (counts.cantrips > 0) parts.push(`заговоры ${counts.cantrips}`)
  if (counts.mode === 'spellbook') parts.push(`книга ${counts.book ?? 0}`, `подготовлено ${counts.prepared}`)
  else if (counts.mode === 'known') parts.push(`известно ${counts.prepared}`)
  else if (counts.mode === 'prepared') parts.push(`подготовлено ${counts.prepared}`)
  if (counts.innate > 0) parts.push(`врождённые ${counts.innate}`)
  parts.push(counts.mode ? `список класса ${counts.list}` : `в списке ${counts.list}`)
  const line = parts.join(' · ')
  return line[0].toLocaleUpperCase('ru-RU') + line.slice(1)
}

/**
 * Короткая подпись плитки «Книга»: на плитке место только под главное —
 * сколько у героя есть, а не сколько в списке класса.
 *
 * @param {HeroSpellCounts} counts
 * @returns {string}
 */
export function heroSpellTileLabel(counts) {
  if (counts.mode === 'spellbook') return `книга ${counts.book ?? 0} · подг. ${counts.prepared}`
  if (counts.mode === 'known') return `известно ${counts.prepared}`
  if (counts.mode === 'prepared') return `подготовлено ${counts.prepared}`
  if (counts.innate > 0) return `врождённые ${counts.innate}`
  return `в списке ${counts.list}`
}

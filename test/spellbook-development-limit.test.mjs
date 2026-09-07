import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { combatSpellsFor, spellSelectionRulesFor } from '../server/combat-spells.mjs'
import { validateCharacterBuildCommand } from '../server/character-build.mjs'

// Проверяем именно выражение лимита, используемое счётчиком, переключателем
// и проверкой мастера, а результат отправляем в настоящий серверный валидатор.
const source = readFileSync(new URL('../src/InventoryViews.tsx', import.meta.url), 'utf8')
const expression = source.match(/const spellbookMaximum = ([^\r\n]+)/u)?.[1]
assert.ok(expression, 'мастер объявляет общий лимит книги')

for (const level of [1, 2, 4]) {
  test(`заговоры в сохранённом листе не увеличивают лимит книги на уровне ${level}`, () => {
    const player = { id: 'wizard', characterClass: 'wizard', level, abilities: { int: 16 } }
    const spellRules = spellSelectionRulesFor(player)
    const catalog = combatSpellsFor(player)
    const cantrips = catalog.filter((spell) => spell.level === 0).slice(0, spellRules.cantrips).map((spell) => spell.id)
    const spells = catalog.filter((spell) => spell.level > 0).map((spell) => spell.id)
    player.knownSpellIds = [...cantrips, ...spells.slice(0, level <= 2 ? 6 : spellRules.spellbookMinimum - 2)]
    const maximum = runInNewContext(expression, { spellRules, player })
    const state = { players: [player] }
    const command = { command_type: 'SetSpellSelections', actor_id: player.id, known_spell_ids: [...cantrips, ...spells.slice(0, maximum)], prepared_spell_ids: [] }
    assert.doesNotThrow(() => validateCharacterBuildCommand(command, state, { allowedActorIds: [player.id] }), 'выбор, разрешённый мастером, должен приниматься сервером')
    assert.equal(maximum, spellRules.spellbookMinimum)
    assert.throws(() => validateCharacterBuildCommand({ ...command, known_spell_ids: [...cantrips, ...spells.slice(0, maximum + 1)] }, state, { allowedActorIds: [player.id] }), { code: 'SPELL_SELECTION_NOT_ALLOWED' })
  })
}

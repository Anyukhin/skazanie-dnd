import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { combatActionsFor, combatClassCatalogInfo, combatResourceMaximumsFor } from '../server/combat-actions.mjs'
import { combatSpellsFor, spellCatalogInfo, spellSelectionRulesFor, spellSlotMaximumsFor } from '../server/combat-spells.mjs'
import { classBuildCatalogInfo, featureChoiceGroupsFor } from '../server/character-progression.mjs'

const classPayload = JSON.parse(readFileSync(new URL('../data/dndsu-class-actions-1-12.json', import.meta.url), 'utf8'))
const spellPayload = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const normalizeName = (value) => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim()
const abilities = { str: 18, dex: 18, con: 18, int: 18, wis: 18, cha: 18 }

function actor(classKey, level, subclass) {
  return { id: `${classKey}-${level}`, characterClass: classKey, level, subclass, proficiency: 2 + Math.floor((level - 1) / 4), abilities, inventory: [] }
}

test('матрица 12 классов × 12 уровней всегда строит серверный каталог действий, ресурсов и заклинаний', () => {
  const classInfo = combatClassCatalogInfo()
  const buildInfo = classBuildCatalogInfo()
  assert.equal(classInfo.classes.length, 12)
  assert.equal(buildInfo.classes.length, 12)
  for (const classEntry of classPayload.classes) {
    for (let level = 1; level <= 12; level += 1) {
      const current = actor(classEntry.classKey, level, level >= classEntry.subclassLevel ? classEntry.subclasses[0]?.name : undefined)
      const actions = combatActionsFor(current)
      assert.ok(actions.some((entry) => entry.id === 'dash'), `${classEntry.classKey} level ${level} has no common actions`)
      assert.ok(actions.every((entry) => Number(entry.minimumLevel ?? 1) <= level), `${classEntry.classKey} level ${level} leaked a locked action`)
      assert.ok(actions.every((entry) => String(entry.sourceUrl).startsWith('https://www.dnd.su/')), `${classEntry.classKey} level ${level} has an untraceable action`)
      const resources = combatResourceMaximumsFor(current)
      assert.ok(Object.values(resources).every((maximum) => Number.isFinite(maximum) && maximum >= 0), `${classEntry.classKey} level ${level} has an invalid resource`)
      const spells = combatSpellsFor(current)
      const rules = spellSelectionRulesFor(current)
      if (rules) {
        assert.ok(rules.maximumSpellLevel <= 6)
        assert.ok(spells.every((spell) => spell.level === 0 || spell.level <= rules.maximumSpellLevel), `${classEntry.classKey} level ${level} leaked a high-level spell`)
        assert.ok(Object.values(spellSlotMaximumsFor(current)).every((maximum) => Number.isInteger(maximum) && maximum >= 0))
      } else {
        assert.deepEqual(spells, [])
      }
      for (const group of featureChoiceGroupsFor(current)) {
        assert.ok(group.choiceCount >= 0 && group.choiceCount <= group.options.length, `${group.id} has an impossible choice count at level ${level}`)
      }
    }
  }
})

test('каждое активируемое умение dnd.su до 12 уровня достижимо своим классом и подклассом', () => {
  let verified = 0
  for (const classEntry of classPayload.classes) {
    for (const candidate of classEntry.actions) {
      assert.ok(candidate.minimumLevel >= 1 && candidate.minimumLevel <= 12)
      assert.ok(String(candidate.sourceUrl).startsWith('https://www.dnd.su/class/'))
      if (candidate.actionType === 'free') continue
      const current = actor(classEntry.classKey, candidate.minimumLevel, candidate.subclass ?? undefined)
      const available = combatActionsFor(current)
      const found = available.some((entry) => entry.id === candidate.id || normalizeName(entry.name) === normalizeName(candidate.name))
      assert.equal(found, true, `${classEntry.classKey}/${candidate.subclass ?? 'base'}/${candidate.id} is not reachable`)
      verified += 1
    }
  }
  assert.ok(verified >= 150, `only ${verified} activatable actions were verified`)
})

test('все 439 заклинаний 0–6 круга уникальны и имеют источник; доступные к 12 уровню карточки достижимы', () => {
  const info = spellCatalogInfo()
  assert.equal(info.count, 439)
  assert.equal(spellPayload.spells.length, 439)
  assert.equal(new Set(spellPayload.spells.map((spell) => spell.id)).size, 439)
  const supportedKinds = new Set(['attack', 'save', 'area-save', 'debuff', 'damage', 'area-damage', 'healing', 'buff', 'utility', 'teleport', 'summon'])
  const level12ByClass = new Map(classPayload.classes.map((entry) => [entry.classKey, new Set(combatSpellsFor(actor(entry.classKey, 12)).map((spell) => spell.id))]))
  const aboveLevel12 = []
  for (const spell of spellPayload.spells) {
    assert.ok(spell.level >= 0 && spell.level <= 6, `${spell.id} has an invalid level`)
    assert.ok(String(spell.sourceUrl).startsWith('https://www.dnd.su/spells/'), `${spell.id} has no dnd.su source`)
    assert.ok(supportedKinds.has(spell.kind), `${spell.id} has unsupported kind ${spell.kind}`)
    assert.ok(['action', 'bonus_action', 'reaction', 'long_cast'].includes(spell.actionType), `${spell.id} has unsupported cast time`)
    if (!spell.classes.some((classKey) => level12ByClass.get(classKey)?.has(spell.id))) aboveLevel12.push(spell.id)
  }
  assert.equal(439 - aboveLevel12.length, 432)
  assert.deepEqual(aboveLevel12.sort(), ['banishing-smite', 'circle-of-power', 'conjure-volley', 'destructive-wave', 'find-greater-steed', 'staggering-smite', 'swift-quiver'])
})

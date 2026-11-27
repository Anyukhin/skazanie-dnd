import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { combatSpellsFor, spellSelectionRulesFor, spellSlotMaximumsFor } from '../server/combat-spells.mjs'

const rulesetId = 'dnd_5e_2014'
const level = 7
const classes = ['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard', 'ranger', 'paladin']
const abilities = { int: 21, wis: 21, cha: 21 }
const catalog = JSON.parse(readFileSync(resolve('data/dndsu-spells-0-6.json'), 'utf8')).spells
const sourceById = new Map(catalog.map((spell) => [spell.id, spell]))
const overrides = JSON.parse(readFileSync(resolve('data/dndsu-spell-mechanics-overrides.json'), 'utf8')).spells

const partyPlans = {
  cleric: {
    cantrips: ['sacred-flame', 'guidance', 'spare-the-dying', 'thaumaturgy', 'light'],
    spells: ['healing-word', 'cure-wounds', 'guiding-bolt', 'bless', 'spiritual-weapon', 'prayer-of-healing', 'spirit-guardians', 'mass-healing-word', 'revivify', 'aid', 'lesser-restoration', 'guardian-of-faith', 'death-ward'],
  },
  wizard: {
    cantrips: ['fire-bolt', 'ray-of-frost', 'mage-hand', 'light', 'shocking-grasp'],
    spells: ['magic-missile', 'fireball', 'shield', 'misty-step', 'scorching-ray', 'mage-armor', 'lightning-bolt', 'ice-storm', 'thunderwave', 'burning-hands', 'sleep', 'hold-person', 'web', 'counterspell', 'haste', 'fly', 'polymorph', 'greater-invisibility', 'detect-magic', 'absorb-elements', 'banishment', 'dimension-door', 'chromatic-orb', 'ice-knife'],
  },
}

function actorFor(characterClass) {
  return { characterClass, level, abilities, rulesetId }
}

function cardFor(spell, classKey) {
  const source = sourceById.get(spell.id)
  return {
    id: spell.id,
    name: spell.name,
    englishName: spell.englishName,
    level: spell.level,
    classes: source?.classes ?? [],
    availableTo: [classKey],
    sourceUrl: spell.sourceUrl,
    caveatRef: spell.mechanicsSupport === 'verified' || !Object.hasOwn(overrides, spell.id) ? null : {
      file: 'data/dndsu-spell-mechanics-overrides.json',
      id: spell.id,
    },
    mechanicsSupport: spell.mechanicsSupport,
    kind: spell.kind ?? null,
    target: spell.target ?? null,
    actionType: spell.actionType ?? null,
    resourcesByClass: {},
    range: spell.range ?? null,
    rangeText: spell.rangeText ?? null,
    castingTime: spell.castingTime ?? null,
    duration: spell.duration ?? null,
    concentration: Boolean(spell.concentration),
    saveAbility: spell.saveAbility ?? null,
    areaShape: spell.areaShape ?? null,
    radius: spell.radius ?? null,
    damage: spell.damage ?? null,
    damageTypes: spell.damageTypes ?? [],
    healing: spell.healing ?? null,
    spellOptions: spell.spellOptions ?? [],
    choices: {
      maxTargets: spell.maxTargets ?? null,
      projectileCount: spell.projectileCount ?? null,
      upcastProjectilesPerLevel: spell.upcastProjectilesPerLevel ?? null,
      upcastTargetsPerLevel: spell.upcastTargetsPerLevel ?? null,
    },
    components: spell.components ?? null,
    higherLevels: spell.higherLevels ?? null,
    description: spell.description,
    supportNote: spell.supportNote ?? null,
  }
}

const classEntries = {}
const byId = new Map()
for (const classKey of classes) {
  const actor = actorFor(classKey)
  const rules = spellSelectionRulesFor(actor)
  const spells = combatSpellsFor(actor, { rulesetId })
  const ids = spells.map((spell) => spell.id)
  for (const spell of spells) {
    const entry = byId.get(spell.id) ?? {
      ...cardFor(spell, classKey),
      availableTo: [],
    }
    if (!entry.availableTo.includes(classKey)) entry.availableTo.push(classKey)
    entry.resourcesByClass[classKey] = { resource: spell.slotResource ?? null, slotLevel: spell.slotLevel ?? spell.level }
    byId.set(spell.id, entry)
  }
  const statusCounts = Object.fromEntries([...new Set(spells.map((spell) => spell.mechanicsSupport))].map((status) => [status, spells.filter((spell) => spell.mechanicsSupport === status).length]))
  classEntries[classKey] = {
    selection: rules,
    slots: spellSlotMaximumsFor(actor),
    statusCounts,
    availableSpellIds: ids,
  }
}

const selected = {}
for (const [classKey, plan] of Object.entries(partyPlans)) {
  const actor = actorFor(classKey)
  const rules = spellSelectionRulesFor(actor)
  const spells = combatSpellsFor(actor, { rulesetId })
  const bySpell = new Map(spells.map((spell) => [spell.id, spell]))
  const cantrips = [...new Set(plan.cantrips)].filter((id) => bySpell.get(id)?.level === 0).slice(0, rules.cantrips)
  const leveledPool = [...new Set([...plan.spells, ...spells.filter((spell) => spell.level > 0).map((spell) => spell.id)])].filter((id) => (bySpell.get(id)?.level ?? 0) > 0)
  const bookOrKnown = rules.mode === 'spellbook' ? leveledPool.slice(0, rules.spellbookMinimum) : rules.mode === 'known' ? leveledPool.slice(0, rules.spellsKnown) : []
  const prepared = rules.mode === 'known' ? [] : leveledPool.slice(0, rules.preparedLimit)
  selected[classKey] = {
    cantrips,
    knownOrInBook: bookOrKnown,
    prepared,
    activeIds: [...cantrips, ...prepared],
  }
}

mkdirSync(resolve('docs/reviews'), { recursive: true })
writeFileSync(resolve('docs/reviews/astohan-level7-spells.json'), JSON.stringify({
  schemaVersion: 1,
  rulesetId,
  level,
  generatedFrom: ['data/dndsu-spells-0-6.json', 'data/dndsu-spell-mechanics-overrides.json', 'server/combat-spells.mjs'],
  classes: classEntries,
  partySelections: selected,
  spells: [...byId.values()].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id)),
}, null, 2) + '\n')

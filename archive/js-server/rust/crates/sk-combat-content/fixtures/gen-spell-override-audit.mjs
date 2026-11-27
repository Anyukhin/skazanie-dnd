import '../../../fixtures-env.mjs'
// Эталон server/spell-override-audit.mjs для Rust:
//
//   node rust/crates/sk-combat-content/fixtures/gen-spell-override-audit.mjs
//
// Отчёт по настоящим правкам и отчёты по синтетическим наборам: модуль JS
// читает файлы по своему пути, поэтому для синтетики он копируется во
// временный каталог вместе с dice-service.mjs, рядом кладутся свой каталог,
// свои правки и свой «исходник движка». Ветви отказа (круг, ячейка, вид,
// цель, формулы, варианты, типы существ, поля без читателя, дубли) видны
// только на таких наборах.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { auditSpellOverrides } from '../../../../server/spell-override-audit.mjs'
import { writeFixture } from './common.mjs'

const server = new URL('../../../../server/', import.meta.url)
const catalog = JSON.parse(readFileSync(new URL('../../../../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const realOverrides = JSON.parse(readFileSync(new URL('../../../../data/dndsu-spell-mechanics-overrides.json', import.meta.url), 'utf8')).spells

const pickSpells = (ids) => ids.map((id) => catalog.spells.find((spell) => spell.id === id)).filter(Boolean)
const smallCatalog = { spells: pickSpells(['fireball', 'bless', 'cure-wounds', 'hex', 'magic-missile', 'thunderwave', 'web', 'shield', 'command', 'mass-cure-wounds', 'heal', 'summon-undead', 'fire-bolt', 'sleep']) }

const engineSource = 'const a = spell.kind; spell?.damage; if (spell.target) spell.saveAbility; spell.radius; spell?.conditions; spell.range\nnot_spell.level; spell .x; spell.upcastDicePerLevel; spell.damageType; spell.spellOptions; spell.conditionsByOption'

const synthetic = [
  {
    label: 'отказы формы и инвариантов',
    source: JSON.stringify({ spells: {
      fireball: { level: 4, slotResource: 'spell_slots_4', concentration: true, kind: 'blast', target: 'everyone', saveAbility: 'luck', areaShape: 'donut', damage: '8d6', mechanicsSupport: 'partial' },
      bless: { kind: 'area-save', radius: 0, target: 'ally', healing: 'xd4', saveDamage: 5, bonusDamage: '1d4', delayedDamage: '2d6+1', recurringDamage: '1d10', hitPointPoolDice: 'bad', temporaryHpDice: '1d4+4' },
      'cure-wounds': { kind: 'healing', conditions: ['poisoned', 'wobbly', 'spell-effect:x', 'mark:y', 'prone', 'wobbly'], onHitConditions: ['dazzled'], requiredCreatureTypes: ['humanoid', 'robot'], immuneCreatureTypes: ['undead', 5] },
      hex: { kind: 'debuff', spellOptions: ['str', 'dex'], conditionsByOption: { str: ['hexed-str'], wis: ['hexed-wis'] }, removesConditionsByOption: { str: [] }, conditionsByOptionExtra: 1 },
      'magic-missile': { kind: 'damage', conditionsByOption: { a: 'x' }, unknownField: true, mechanics2014: { kind: 'attack', range: 120, mysteryField: 1 } },
      thunderwave: 'oops',
      web: null,
      'not-a-spell': { kind: 'buff' },
      shield: { kind: 'buff', target: 'self', saveAbility: null, range: 0, damage: null, damageType: 'force', recurringDamage: '1d4', conditions: ['shielded'] },
      command: { kind: 'save', target: 'enemy', saveAbility: 'wis', conditions: ['commanded'], mechanicsSupport: 'heuristic' },
      'mass-cure-wounds': { kind: 'healing', target: 'point', upcastHealingDicePerLevel: '1d8' },
      heal: { kind: 'healing' },
      'summon-undead': { kind: 'summon', target: 'point' },
      sleep: { kind: 'area-debuff', radius: 20, mechanicsSupport: 'ruling-only' },
      'fire-bolt': { kind: 'attack', createsAreaEffect: { upcastDicePerLevel: '1d6' } },
    } }, null, 2),
  },
  {
    label: 'дубли в тексте и чистый набор',
    source: '{\n  "spells": {\n    "bless": {\n      "kind": "buff"\n    },\n    "bless": {\n      "kind": "buff",\n      "target": "ally"\n    },\n    "fire-bolt": {\n      "kind": "attack"\n    },\n    "fire-bolt": {\n      "kind": "attack"\n    },\n    "fire-bolt": {\n      "kind": "attack"\n    }\n  }\n}\n',
  },
  { label: 'без правок', source: '{}' },
  { label: 'все настоящие правки на малом каталоге', source: JSON.stringify({ spells: realOverrides }, null, 2) },
]

const directory = mkdtempSync(join(tmpdir(), 'sk-spell-override-audit-'))
const cases = []
try {
  mkdirSync(join(directory, 'server'))
  mkdirSync(join(directory, 'data'))
  copyFileSync(new URL('spell-override-audit.mjs', server), join(directory, 'server', 'spell-override-audit.mjs'))
  copyFileSync(new URL('dice-service.mjs', server), join(directory, 'server', 'dice-service.mjs'))
  writeFileSync(join(directory, 'server', 'rules-engine.mjs'), engineSource)
  writeFileSync(join(directory, 'data', 'dndsu-spells-0-6.json'), JSON.stringify(smallCatalog))
  for (const [index, scenario] of synthetic.entries()) {
    writeFileSync(join(directory, 'data', 'dndsu-spell-mechanics-overrides.json'), scenario.source)
    const module = await import(`${pathToFileURL(join(directory, 'server', 'spell-override-audit.mjs')).href}?case=${index}`)
    cases.push({ label: scenario.label, source: scenario.source, report: module.auditSpellOverrides() })
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

writeFixture(new URL('spell-override-audit.json', import.meta.url), {
  real: auditSpellOverrides(),
  smallCatalog,
  engineSource,
  synthetic: cases,
})

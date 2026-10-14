// Эталон dndsu-2014-content для Rust: загруженный справочник (по хешу
// JSON.stringify), поиск, токены, кости, фрагменты для индекса, выдача записей
// и сотни правок справочника с ожидаемым отказом проверки.
//
//   node rust/crates/sk-combat-base/fixtures/gen-dndsu-2014-content.mjs
//
// Пишет dndsu-2014-content.json рядом с собой. Правка — путь в справочнике и
// новое значение (`set`) или удаление поля (`delete`).
import './force-en-collation.mjs'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  diceAverage,
  getContentRecord,
  loadDndsu2014Content,
  mechanicalTokens,
  searchContent,
  toRetrievalChunks,
  validateDndsu2014Content,
} from '../../../../server/dndsu-2014-content.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(2014)
const pick = (items) => items[Math.floor(random() * items.length)]

const loaded = await loadDndsu2014Content()
const { directory, ...withoutDirectory } = loaded
const content = JSON.parse(JSON.stringify(withoutDirectory))
const contentHash = sha256(JSON.stringify(withoutDirectory))

function outcome(run) {
  try {
    return { ok: run() }
  } catch (error) {
    return { name: error.name, error: error.message }
  }
}

// --- токены и кости -------------------------------------------------------
const tokenTexts = ['Roll 2d6 + 3, DC 10, 1/2 or 50%.', 'урон 2d8 − 1 и 1d4–2, ×2, 1,5 м', '3—4 + 5 — 6', 'X2 2X 2 x 3 ５０％', '']
for (const rule of content.rules) tokenTexts.push(`${rule.title_en}\n${rule.text_en}`, `${rule.title_ru}\n${rule.text_ru}`)
const tokens = tokenTexts.map((text) => ({ text, tokens: mechanicalTokens(text) }))

const diceCases = ['2d6-2', '1d4', '10d10+10', '1000d1000+10000', '1d6+10001', '0d6', '2d1', '1d6;rm', 'process.exit()', ' 2d6', '2d6 ', '2D6', 'd6', '1d6+-1', '01d06+05', '1d6-0', '', null, 5, '99999999999999999999d6']
const dice = diceCases.map((expression) => ({ expression, result: outcome(() => diceAverage(expression)) }))

// --- поиск ----------------------------------------------------------------
const words = new Set()
for (const record of [...content.monsters, ...content.magicItems, ...content.rules]) {
  for (const text of [record.name_ru, record.name_en, record.title_ru, record.title_en]) {
    if (text) for (const word of text.split(/\s+/u)) if (word.length > 2) words.add(word)
  }
}
const wordList = [...words]
const searches = []
const search = (query, options) => {
  const result = outcome(() => searchContent(content, query, options).map(({ record, score }) => [record.id, score]))
  searches.push({ query, options: options ?? null, result })
}
search('лютый волк', { kind: 'monster' })
search('концентрация', { kind: 'rule' })
search(' ')
search('волк', { limit: 1000 })
search('волк', { limit: 0 })
search('волк', { limit: 2.5 })
search('волк', { limit: '5' })
search('волк', { limit: null })
search('волк', { kind: 'spell' })
search('волк', { kind: null })
search(5)
search(null)
search('ЁЖ ёж', {})
search('potion of healing', { kind: 'magic_item', limit: 3 })
for (let index = 0; index < 220; index += 1) {
  const count = 1 + Math.floor(random() * 3)
  const query = Array.from({ length: count }, () => {
    const word = pick(wordList)
    return random() < 0.3 ? word.slice(0, Math.max(3, word.length - 2)).toUpperCase() : word
  }).join(random() < 0.1 ? '\t ' : ' ')
  const options = {}
  if (random() < 0.4) options.kind = pick(['monster', 'magic_item', 'rule'])
  if (random() < 0.5) options.limit = 1 + Math.floor(random() * 30)
  search(query, options)
}

// --- фрагменты и записи ---------------------------------------------------
const chunkSummary = (chunks) => chunks.map(({ text, ...rest }) => ({ ...rest, text_sha256: sha256(text) }))
const chunks = {
  all: chunkSummary(toRetrievalChunks(content)),
  monster: chunkSummary(toRetrievalChunks(content, { kind: 'monster' })),
  rule: chunkSummary(toRetrievalChunks(content, { kind: 'rule' })),
  invalid: outcome(() => toRetrievalChunks(content, { kind: 'spell' })),
}
const recordCases = [
  ['dnd_5e_2014:monster:goblin'], ['dnd_5e_2014:monster:missing'], ['srd_5_2_1:goblin'], ['dnd_5e_2014:item:potion-of-healing'],
  ['dnd_5e_2014:compendium:combat:grapple'], [' '], [5], ['dnd_5e_2014:monster:goblin', { ruleset_id: 'srd_5_2_1' }],
  ['dnd_5e_2014:monster:goblin', { ruleset_id: 'dnd_5e_2014' }], ['dnd_5e_2014:monster:goblin', null], ['dnd_5e_2014:'],
]
const records = recordCases.map(([id, campaign]) => ({
  id,
  campaign: campaign === undefined ? null : campaign,
  hasCampaign: campaign !== undefined,
  result: outcome(() => getContentRecord(content, id, campaign === undefined ? {} : { campaign })?.id ?? null),
}))

// --- правки ---------------------------------------------------------------
const mutations = []
const add = (patch) => mutations.push({ patch })
const set = (path, value) => ({ op: 'set', path, value })
const del = (path) => ({ op: 'delete', path })
const firstIndex = (list, predicate) => list.findIndex(predicate)
const m = content.monsters
const monster = (predicate) => firstIndex(m, predicate)
const actionIndex = (index, predicate) => firstIndex(m[index].actions, predicate)

for (const value of [null, 5, [], 'x']) add([set([], value)])
add([])
for (const key of ['sources', 'monsters', 'magicItems', 'rules', 'ontologyEdges', 'coverage']) {
  add([del([key])])
  for (const value of [null, {}, 'x', 5]) add([set([key], value)])
}
add([set(['sources', 'ruleset_id'], 'srd_5_2_1')])
add([set(['sources', 'sources'], null)])
add([set(['sources', 'sources', 0], null)])
for (const key of ['id', 'title', 'url', 'revision_id', 'accessed_at', 'rights_status', 'edition_family', 'bundled']) {
  add([del(['sources', 'sources', 1, key])])
  for (const value of ['', 5, true]) add([set(['sources', 'sources', 2, key], value)])
}
add([set(['sources', 'sources', 3, 'id'], content.sources.sources[0].id)])
add([set(['sources', 'sources', 0, 'edition_family'], '5e_2024')])
const urls = [
  'https://dnd.su/x/', 'HTTPS://DND.SU/a/../b', 'https:dnd.su/bestiary/', 'https://u:p@dnd.su/', 'https://u@dnd.su/', 'https://:p@dnd.su/',
  'https://dnd.su:99999/', 'https://dnd.su:443/x', 'https://dnd.su:/x', 'https://next.dnd.su/', 'https://NEXT.dnd.su/', 'https:\\\\dnd.su\\homebrew\\x',
  'mailto:x', 'foo', 'http://', 'http://dnd.su/', 'https://dnd.su/a/./b/%2e%2e/homebrew/', 'https://dnd.su/homebrew', 'https://dnd.su/homebrew/x',
  'https://dnd.su/a/homebrew/../x', 'https://xn--d1acufc.xn--p1ai/', 'https://ｄｎｄ.ｓｕ/', 'https://dnd.su./', 'https://1.2.3.999/', 'https://0x7f.1/',
  'https://[::1]/', 'https://dnd su/', 'https://dnd.su/home brew/', '  https://dnd.su/\t\n ', 'https://@dnd.su/', 'https://dnd.su?x#y',
  'https://dnd%2esu/', 'https://DnD.Su/HomeBrew/', 'https://www.5e14.dnd.su/spells/', 'https://media.dndbeyond.com/x.pdf', 'https://example.com/',
  'https://dnd.su/#/homebrew/', 'https://dnd.su/?/homebrew/', 'ftp://dnd.su/', 'https://dn­d.su/', 'https://dnd。su/', 'https://5e14.dnd.su',
  'https://dnd.su/%2E%2e/homebrew/', 'https://u:@dnd.su/', 'https://dnd.su@evil.com/', 'https://evil.com@dnd.su/', 'https://next./', 'https://1.2.3.4/',
  'https://08.1/', 'https://1..2/', '', ' ', 'https://', 'https:///dnd.su/', 'HtTpS://www.DND.su/Homebrew/',
]
for (const url of urls) add([set(['sources', 'sources', 0, 'url'], url)])

const goblin = monster((record) => record.id.endsWith(':goblin'))
const multi = monster((record) => record.actions.some((action) => action.kind === 'multiattack' && action.sequences.some((sequence) => sequence.some((step) => step.mode))))
const multiAction = actionIndex(multi, (action) => action.kind === 'multiattack')
const ranged = monster((record) => record.actions.some((action) => action.kind === 'weapon_attack' && action.range_ft && action.ranged_damage))
const rangedAction = actionIndex(ranged, (action) => action.kind === 'weapon_attack' && action.range_ft && action.ranged_damage)
const caster = monster((record) => record.spellcasting && record.spellcasting.spell_slots.length > 1)
const innate = monster((record) => record.spellcasting?.innate_spells?.length)
const area = monster((record) => record.actions.some((action) => action.kind === 'save_area'))
const areaAction = actionIndex(area, (action) => action.kind === 'save_area')
const conditional = monster((record) => record.damage_resistances.some((entry) => typeof entry === 'object'))
const weapon = actionIndex(goblin, (action) => action.kind === 'weapon_attack')
const legendary = monster((record) => record.legendary_actions.length > 0)

for (const key of ['name_ru', 'name_en', 'size', 'creature_type', 'alignment', 'challenge_rating', 'book_code', 'source_url', 'armor_class', 'hit_points', 'abilities', 'ability_modifiers', 'initiative_bonus', 'saving_throws', 'skills', 'speed_ft', 'senses', 'xp', 'proficiency_bonus', 'traits', 'lore', 'kind', 'id', 'ruleset_id', 'source_ref', 'mechanics_status', 'runtime_activation_allowed', 'spellcasting']) {
  add([del(['monsters', goblin, key])])
  for (const value of [null, '', 0, 'x', []]) add([set(['monsters', goblin, key], value)])
}
add([set(['monsters', 1, 'id'], m[0].id)])
add([set(['monsters', 0, 'source_ref'], 'unknown')])
add([set(['monsters', 0, 'kind'], 'rule')])
add([set(['monsters', 0, 'book_code'], 'XGE')])
add([set(['monsters', 0, 'id'], 'srd_5_2_1:monster:goblin')])
add([set(['monsters', goblin, 'hit_points', 'average'], m[goblin].hit_points.average + 1)])
add([set(['monsters', goblin, 'hit_points', 'formula'], 'bad')])
add([set(['monsters', goblin, 'abilities', 'str'], 31)])
add([set(['monsters', goblin, 'ability_modifiers', 'dex'], 9)])
add([set(['monsters', goblin, 'abilities', 'luck'], 10)])
add([set(['monsters', goblin, 'saving_throws'], { foo: 1 })])
add([set(['monsters', goblin, 'saving_throws'], { dex: 31 })])
add([set(['monsters', goblin, 'skills'], { stealth: 'x' })])
add([set(['monsters', goblin, 'speed_ft'], { walk: -1 })])
add([set(['monsters', goblin, 'senses', 'passive_perception'], 51)])
add([set(['monsters', goblin, 'challenge_rating'], '31')])
add([set(['monsters', goblin, 'xp'], -1)])
add([set(['monsters', goblin, 'proficiency_bonus'], 10)])
add([set(['monsters', goblin, 'damage_resistances'], ['laser'])])
add([set(['monsters', goblin, 'damage_resistances'], [{ types: ['fire'], condition: 'nonmagical' }])])
add([set(['monsters', goblin, 'damage_resistances'], [{ types: [], condition: 'x' }])])
add([set(['monsters', goblin, 'damage_resistances'], [{ types: ['laser'], condition: 'x' }])])
add([set(['monsters', goblin, 'damage_resistances'], [{ types: ['fire'] }])])
add([set(['monsters', goblin, 'damage_immunities'], [5])])
add([set(['monsters', goblin, 'lore', 'full_text_included'], true)])
add([set(['monsters', goblin, 'lore', 'summary_ru'], '')])
add([set(['monsters', goblin, 'actions', 1, 'id'], m[goblin].actions[0].id)])
add([set(['monsters', goblin, 'actions', 0], null)])
for (const [key, values] of [
  ['mechanics_status', ['executable']],
  ['attack_modifier', [31, '5', 2.5]],
  ['modes', [[''], 'melee', null]],
  ['damage', [null, [{ type: 'laser', expression: '1d6', average: 3 }], [{ type: 'fire', expression: '1d6', average: 4 }], [{ type: 'fire', expression: '1d6', amount: 3, average: 3 }], [{ type: 'fire', amount: 3, average: 4 }], [{ type: 'fire', amount: -1, average: -1 }], [null], [{ type: 'fire', expression: 'bad', average: 3 }]]],
  ['range_ft', [{ normal: 0, long: 10 }, { normal: 10, long: 5 }, 5, 'x', null]],
  ['reach_ft', [0, 101, '5']],
  ['ranged_damage', ['bad', 5]],
  ['versatile_damage', ['1d8+1', 'oops']],
  ['name_ru', ['']],
  ['kind', ['']],
]) {
  for (const value of values) add([set(['monsters', goblin, 'actions', weapon, key], value)])
}
add([del(['monsters', goblin, 'actions', weapon, 'reach_ft'])])
add([del(['monsters', goblin, 'actions', weapon, 'id'])])
const multiPath = ['monsters', multi, 'actions', multiAction]
const firstStep = [...multiPath, 'sequences', 0, 0]
for (const [path, value] of [
  [[...multiPath, 'sequences'], null], [[...multiPath, 'sequences'], 5], [[...multiPath, 'sequences', 0], 5], [[...multiPath, 'sequences', 0], 'ab'],
  [[...multiPath, 'sequences', 0, 0], null], [[...firstStep, 'action_id'], 'missing'], [[...firstStep, 'action_id'], m[multi].actions[multiAction].id],
  [[...firstStep, 'count'], 0], [[...firstStep, 'count'], 21], [[...firstStep, 'mode'], 'teleport'],
]) add([set(path, value)])
const stepWithMode = m[multi].actions[multiAction].sequences.flatMap((sequence, sequenceIndex) => sequence.map((step, stepIndex) => ({ step, sequenceIndex, stepIndex }))).find(({ step }) => step.mode)
const modeTarget = actionIndex(multi, (action) => action.id === stepWithMode.step.action_id)
for (const value of [null, 'melee,ranged', 5, [], ['ranged', 'melee']]) add([set(['monsters', multi, 'actions', modeTarget, 'modes'], value)])
const rangedPath = ['monsters', ranged, 'actions', rangedAction]
add([set([...rangedPath, 'ranged_damage'], '1d6+x')])
add([set([...rangedPath, 'range_ft', 'long'], m[ranged].actions[rangedAction].range_ft.normal - 1)])
add([set(['monsters', area, 'actions', areaAction, 'damage'], [{ type: 'acid', expression: '2d6', average: 6 }])])
add([set(['monsters', area, 'actions', areaAction, 'damage'], 'x')])
for (const [key, value] of [['ability', 'xyz'], ['save_dc', 0], ['caster_level', 21], ['attack_modifier', 31], ['spell_slots', null], ['casting_mode', 'innate'], ['innate_spells', 5]]) {
  add([set(['monsters', caster, 'spellcasting', key], value)])
}
add([del(['monsters', caster, 'spellcasting', 'caster_level'])])
add([set(['monsters', caster, 'spellcasting', 'casting_mode', ], 'innate'), del(['monsters', caster, 'spellcasting', 'caster_level']), del(['monsters', caster, 'spellcasting', 'attack_modifier'])])
const slots = m[caster].spellcasting.spell_slots
add([set(['monsters', caster, 'spellcasting', 'spell_slots', 1, 'level'], slots[0].level)])
add([set(['monsters', caster, 'spellcasting', 'spell_slots', 0, 'slots'], 1)])
add([set(['monsters', caster, 'spellcasting', 'spell_slots', 1, 'slots'], 21)])
add([set(['monsters', caster, 'spellcasting', 'spell_slots', 1, 'spells', 0], { name_ru: 'x' })])
add([set(['monsters', caster, 'spellcasting', 'spell_slots', 1, 'spells', 0], null)])
add([set(['monsters', caster, 'spellcasting', 'spell_slots', 0], null)])
if (innate >= 0) {
  for (const value of [0, 'at-will', 101, null]) add([set(['monsters', innate, 'spellcasting', 'innate_spells', 0, 'uses'], value)])
  add([set(['monsters', innate, 'spellcasting', 'innate_spells', 0, 'spells'], [{ key: 'x' }])])
  add([set(['monsters', innate, 'spellcasting', 'innate_spells', 0], null)])
}
if (conditional >= 0) add([set(['monsters', conditional, 'damage_resistances', 0, 'types'], ['fire', 'laser'])])
if (legendary >= 0) add([set(['monsters', legendary, 'legendary_actions'], null)])

const items = content.magicItems
const itemIndex = (predicate) => firstIndex(items, predicate)
const charged = itemIndex((item) => item.charges)
const based = itemIndex((item) => item.requires_base_item)
const healer = itemIndex((item) => item.effects.some((effect) => effect.kind === 'heal'))
const spellItem = itemIndex((item) => item.effects.some((effect) => effect.kind === 'cast_spell'))
const resist = itemIndex((item) => item.effects.some((effect) => effect.kind === 'damage_resistance' && effect.damage_type_from))
for (const key of ['name_ru', 'rarity', 'summary_ru', 'book_code', 'source_url', 'attunement', 'activation', 'effects', 'price_gp', 'weight_lb', 'full_source_text_included']) {
  add([del(['magicItems', 0, key])])
  for (const value of [null, '', 0, 'x', -1, []]) add([set(['magicItems', 1, key], value)])
}
add([set(['magicItems', 0, 'attunement', 'required'], 'yes')])
add([set(['magicItems', 0, 'attunement', 'requirements'], [''])])
add([set(['magicItems', 0, 'activation'], [{ action_cost: 'free' }])])
add([set(['magicItems', 0, 'activation'], [{}])])
add([set(['magicItems', 0, 'activation'], [{ action_cost: null }])])
add([set(['magicItems', 0, 'activation'], [null])])
add([set(['magicItems', 0, 'weight_lb'], '1')])
add([set(['magicItems', 0, 'weight_lb'], 0.5)])
add([set(['magicItems', charged, 'charges', 'maximum'], 0)])
add([set(['magicItems', charged, 'charges', 'regain', 'expression'], 'bad')])
add([set(['magicItems', charged, 'charges', 'regain', 'cap_at_maximum'], false)])
add([del(['magicItems', charged, 'charges', 'regain'])])
add([set(['magicItems', 0, 'charges'], 5)])
add([del(['magicItems', based, 'variant'])])
add([set(['magicItems', healer, 'effects', 0, 'expression'], 'heal-me')])
add([set(['magicItems', healer, 'effects', 0, 'kind'], '')])
add([set(['magicItems', healer, 'effects', 0], null)])
if (spellItem >= 0) {
  const effect = items[spellItem].effects.findIndex((entry) => entry.kind === 'cast_spell')
  add([set(['magicItems', spellItem, 'effects', effect, 'ruleset_id'], 'srd_5_2_1')])
  add([set(['magicItems', spellItem, 'effects', effect, 'spell_key'], '')])
}
if (resist >= 0) add([set(['magicItems', resist, 'variant', 'kind'], 'other')])

for (const key of ['title_ru', 'title_en', 'text_ru', 'text_en', 'source_hash', 'license_id', 'section_path', 'tags', 'entity_refs', 'aliases_en', 'aliases_ru', 'formalization_level', 'source_page_start', 'source_page_end', 'mechanics']) {
  add([del(['rules', 0, key])])
  for (const value of [null, '', [''], 'x', -1, 20000]) add([set(['rules', 1, key], value)])
}
add([set(['rules', 0, 'text_ru'], `${content.rules[0].text_ru} 9999`)])
add([set(['rules', 2, 'source_page_start'], 5), set(['rules', 2, 'source_page_end'], 4)])
add([set(['rules', 3, 'id'], m[0].id)])
for (const key of ['ruleset_id', 'from_id', 'to_id', 'weight']) {
  for (const value of ['srd_5_2_1', 'missing', 0, 1.5, '0.5', [0.5], true, null, 1, { valueOf: 1 }]) add([set(['ontologyEdges', 0, key], value)])
}
add([set(['ontologyEdges', 1], null)])
add([set(['coverage', 'ruleset_id'], 'srd_5_2_1')])
for (const key of ['rules', 'monsters', 'magic_items', 'ontology_edges', 'sources']) add([set(['coverage', 'counts', key], 0)])
add([set(['coverage', 'counts'], null)])
add([del(['coverage', 'counts'])])

function applyPatch(base, patch) {
  const root = { value: structuredClone(base) }
  for (const step of patch) {
    const path = ['value', ...step.path]
    let target = root
    for (const key of path.slice(0, -1)) target = target[key]
    if (step.op === 'delete') delete target[path.at(-1)]
    else target[path.at(-1)] = structuredClone(step.value)
  }
  return root.value
}
const validation = mutations.map(({ patch }) => ({ patch, result: outcome(() => validateDndsu2014Content(applyPatch(content, patch))) }))

const fixture = { contentHash, summary: content.summary, tokens, dice, searches, chunks, records, validation }
const lines = Object.entries(fixture).map(([key, value]) => Array.isArray(value)
  ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
  : `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
writeFileSync(here('dndsu-2014-content.json'), `{\n${lines.join(',\n')}\n}\n`)
const byName = {}
for (const entry of validation) byName[entry.result.name ?? 'ok'] = (byName[entry.result.name ?? 'ok'] ?? 0) + 1
console.log(`dndsu-2014-content.json: ${tokens.length} текстов, ${dice.length} костей, ${searches.length} поисков, ${validation.length} правок ${JSON.stringify(byName)}`)

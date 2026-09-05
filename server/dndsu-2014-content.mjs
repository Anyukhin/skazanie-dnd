/** Local, read-only D&D 2014 reference data. No network, commands, migrations or combat execution. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve, join, relative, isAbsolute } from 'node:path'

export const CONTENT_RULESET_ID = 'dnd_5e_2014'
export const DEFAULT_CONTENT_DIRECTORY = fileURLToPath(new URL('../data/compendia/dnd_5e_2014/', import.meta.url))
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha']
const DAMAGE_TYPES = new Set(['acid','bludgeoning','cold','fire','force','lightning','necrotic','piercing','poison','psychic','radiant','slashing','thunder'])
const BOOKS = new Set(['PHB14','DMG14','MM14','SRD51'])
const RECORD_KINDS = new Set(['monster','magic_item','rule'])

export class ContentValidationError extends Error {
  constructor(message) { super(message); this.name = 'ContentValidationError' }
}
function requireThat(condition, message) { if (!condition) throw new ContentValidationError(message) }
function object(value, label) { requireThat(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`) }
function string(value, label) { requireThat(typeof value === 'string' && value.trim().length > 0, `${label}: expected nonempty string`) }
function integer(value, min, max, label) { requireThat(Number.isInteger(value) && value >= min && value <= max, `${label}: integer outside ${min}..${max}`) }
function array(value, label) { requireThat(Array.isArray(value), `${label}: expected array`) }
function strings(value, label) { array(value,label); value.forEach(v => string(v,label)) }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function jsonLines(text, filename) {
  return text.split(/\r?\n/u).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line) } catch (error) { throw new ContentValidationError(`${filename}:${i + 1}: ${error.message}`) }
  })
}
function safePath(root, name) {
  string(name, 'file path')
  requireThat(!name.includes('\\'), 'Use POSIX paths in the manifest')
  const target = resolve(root, name), rel = relative(resolve(root), target)
  requireThat(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`), `Unsafe file path: ${name}`)
  return target
}
export function mechanicalTokens(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase().replace(/[−–]/gu, '-').replace(/(\d),(\d)/gu, '$1.$2')
  const pattern = /(?<![\p{L}\p{N}_])(?:\d+\s*d\s*\d+(?:\s*[+-]\s*\d+)?|d\s*\d+(?:\s*[+-]\s*\d+)?|\d+\s*\/\s*\d+|\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*[x×]|[+-]?\d+(?:\.\d+)?)(?![\p{L}\p{N}_])/giu
  return [...normalized.matchAll(pattern)].map(m => m[0].replace(/\s+/gu, '').replace(/×/gu, 'x')).sort()
}
/** Validation only, never eval(). Returns the floor of the mathematical average. */
export function diceAverage(expression) {
  string(expression, 'dice expression')
  const match = /^(\d+)d(\d+)([+-]\d+)?$/u.exec(expression)
  requireThat(match, `Invalid dice expression: ${expression}`)
  const count = Number(match[1]), sides = Number(match[2]), modifier = Number(match[3] || 0)
  integer(count,1,1000,'dice count'); integer(sides,2,1000,'dice sides'); integer(modifier,-10000,10000,'dice modifier')
  return Math.floor(count * (sides + 1) / 2 + modifier)
}
function sourceUrl(url) {
  string(url, 'source URL')
  let parsed
  try { parsed = new URL(url) } catch { throw new ContentValidationError(`Invalid source URL: ${url}`) }
  requireThat(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'Source URL must use HTTPS without credentials')
  requireThat(!parsed.hostname.startsWith('next.') && !parsed.pathname.includes('/homebrew/'), '2024 or homebrew source is not allowed')
  requireThat(['dnd.su','www.dnd.su','5e14.dnd.su','www.5e14.dnd.su','media.dndbeyond.com'].includes(parsed.hostname), 'Unapproved source host')
}
function common(record, sourceMap, seen) {
  object(record,'record')
  for (const k of ['id','ruleset_id','version','kind','source_ref','book_code']) string(record[k], `${record.id}.${k}`)
  requireThat(record.ruleset_id === CONTENT_RULESET_ID && record.id.startsWith(`${CONTENT_RULESET_ID}:`), `Mixed edition: ${record.id}`)
  requireThat(!seen.has(record.id), `Duplicate record: ${record.id}`); seen.add(record.id)
  requireThat(RECORD_KINDS.has(record.kind), `Unknown record kind: ${record.kind}`)
  requireThat(BOOKS.has(record.book_code), `Disallowed book: ${record.book_code}`)
  requireThat(sourceMap.has(record.source_ref), `Unknown source: ${record.source_ref}`)
  requireThat(record.mechanics_status === 'data_only' && record.runtime_activation_allowed === false, 'This pack may not claim runtime support')
}
function validateDamage(damage, label) {
  array(damage,label)
  for (const d of damage) {
    requireThat(DAMAGE_TYPES.has(d.type), `${label}: unknown damage type`)
    requireThat(diceAverage(d.expression) === d.average, `${label}: incorrect average for ${d.expression}`)
  }
}
function validateMonster(m) {
  for (const k of ['name_ru','name_en','size','creature_type','alignment','challenge_rating']) string(m[k],`${m.id}.${k}`)
  requireThat(m.book_code === 'MM14', 'Monster must be MM14')
  sourceUrl(m.source_url)
  integer(m.armor_class?.value,1,40,'armor class')
  integer(m.hit_points?.average,1,10000,'hit points')
  requireThat(diceAverage(m.hit_points.formula) === m.hit_points.average, `${m.id}: HP average mismatch`)
  object(m.abilities,'abilities'); object(m.ability_modifiers,'ability modifiers')
  for (const a of ABILITIES) {
    integer(m.abilities[a],1,30,`${m.id}.${a}`)
    requireThat(m.ability_modifiers[a] === Math.floor((m.abilities[a]-10)/2), `${m.id}: modifier ${a}`)
  }
  requireThat(Object.keys(m.abilities).length === 6,'Expected exactly six abilities')
  integer(m.initiative_bonus,-10,30,'initiative')
  object(m.saving_throws,'saving throws'); object(m.skills,'skills'); object(m.speed_ft,'speed')
  Object.entries(m.saving_throws).forEach(([a,v]) => { requireThat(ABILITIES.includes(a),'Unknown save ability'); integer(v,-10,30,'save') })
  Object.values(m.skills).forEach(v => integer(v,-10,40,'skill bonus'))
  Object.values(m.speed_ft).forEach(v => integer(v,0,1000,'speed'))
  integer(m.senses?.passive_perception,0,50,'passive perception')
  requireThat(/^(?:0|1\/8|1\/4|1\/2|[1-9]|[12]\d|30)$/u.test(m.challenge_rating),'Invalid CR')
  integer(m.xp,0,200000,'XP'); integer(m.proficiency_bonus,2,9,'proficiency')
  for (const k of ['traits','actions','bonus_actions','reactions','legendary_actions','lair_actions','damage_resistances','damage_immunities','damage_vulnerabilities','condition_immunities','habitats','field_notes']) array(m[k],k)
  for (const k of ['damage_immunities','damage_vulnerabilities']) m[k].forEach(t => requireThat(DAMAGE_TYPES.has(t),'Unknown damage type'))
  const actionIds = new Set(m.actions.map(a => a.id))
  requireThat(actionIds.size === m.actions.length,'Duplicate local action ID')
  for (const a of m.actions) {
    string(a.id,'action.id'); string(a.name_ru,'action name'); string(a.kind,'action kind')
    requireThat(a.mechanics_status === 'requires_handler','Action cannot claim executable support')
    if (a.kind === 'weapon_attack') {
      integer(a.attack_modifier,-10,30,'attack modifier'); strings(a.modes,'attack modes')
      validateDamage(a.damage,`${m.id}.${a.id}`)
      if (a.range_ft) { integer(a.range_ft.normal,1,10000,'normal range'); integer(a.range_ft.long,a.range_ft.normal,10000,'long range') }
      if (a.reach_ft !== null) integer(a.reach_ft,1,100,'reach')
      for (const k of ['ranged_damage','versatile_damage']) if (a[k]) diceAverage(a[k])
    }
    if (a.kind === 'multiattack') {
      array(a.sequences,'multiattack sequences')
      for (const sequence of a.sequences) for (const step of sequence) {
        requireThat(actionIds.has(step.action_id) && step.action_id !== a.id, 'Unresolved or recursive multiattack')
        integer(step.count,1,20,'multiattack count')
        if (step.mode) requireThat(m.actions.find(x => x.id === step.action_id).modes?.includes(step.mode),'Invalid multiattack mode')
      }
    }
    if (a.kind === 'save_area') validateDamage(a.damage, 'area damage')
  }
  if (m.spellcasting) {
    const s=m.spellcasting
    requireThat(ABILITIES.includes(s.ability),'Spellcasting ability missing'); integer(s.save_dc,1,40,'spell save DC')
    integer(s.caster_level,1,20,'caster level'); integer(s.attack_modifier,-10,30,'spell attack')
    array(s.spell_slots,'spell slots')
    const levels=new Set()
    for (const level of s.spell_slots) {
      integer(level.level,0,9,'spell level'); requireThat(!levels.has(level.level),'Duplicate slot level'); levels.add(level.level)
      if (level.level===0) requireThat(level.slots===null,'Cantrips are at will, not slots')
      else integer(level.slots,0,20,'slot count')
      array(level.spells,'spell list'); level.spells.forEach(spell=>{string(spell.key,'spell key');string(spell.name_ru,'spell name')})
    }
  }
  object(m.lore,'lore'); string(m.lore.summary_ru,'lore summary'); requireThat(m.lore.full_text_included===false,'Full page prose must not be bundled')
}
function validateItem(i) {
  for (const k of ['name_ru','name_en','item_type','rarity','summary_ru']) string(i[k],`${i.id}.${k}`)
  requireThat(i.book_code==='DMG14','Item must be DMG14'); sourceUrl(i.source_url)
  requireThat(['common','uncommon','rare','very_rare','legendary'].includes(i.rarity),'Invalid rarity')
  object(i.attunement,'attunement'); requireThat(typeof i.attunement.required==='boolean','Attunement flag missing'); strings(i.attunement.requirements,'attunement requirements')
  array(i.activation,'activation'); array(i.effects,'effects')
  for (const a of i.activation) requireThat(['action','bonus_action','reaction',null].includes(a.action_cost),'Unknown action cost')
  requireThat(i.price_gp===null,'This reviewed release does not provide market prices')
  if (i.weight_lb!==null) requireThat(Number.isFinite(i.weight_lb) && i.weight_lb>=0,'Invalid weight')
  if (i.charges) {
    integer(i.charges.maximum,1,100,'maximum charges'); diceAverage(i.charges.regain.expression)
    requireThat(i.charges.regain.cap_at_maximum===true,'Charge recovery must be capped')
  }
  if (i.requires_base_item) requireThat(i.variant?.kind==='base_item_required','Base item selection required')
  for (const effect of i.effects) {
    string(effect.kind,'effect kind')
    if (effect.kind==='heal') diceAverage(effect.expression)
    if (effect.kind==='cast_spell') { requireThat(effect.ruleset_id===CONTENT_RULESET_ID,'Mixed spell edition'); string(effect.spell_key,'spell key') }
    if (effect.kind==='damage_resistance' && effect.damage_type_from) requireThat(i.variant?.kind==='damage_type_required','Unresolved damage type variant')
  }
  requireThat(i.full_source_text_included===false,'Full item prose must not be bundled')
}
/** Validate identity, invariants, sources and the repository rule-row contract. Does not prove book accuracy. */
export function validateDndsu2014Content(content) {
  object(content,'content'); object(content.sources,'sources'); requireThat(content.sources.ruleset_id===CONTENT_RULESET_ID,'Mixed source registry')
  array(content.sources.sources,'source records')
  const sourceMap=new Map(), seen=new Set()
  for (const s of content.sources.sources) {
    for (const k of ['id','title','url','revision_id','accessed_at','rights_status']) string(s[k],`source.${k}`)
    requireThat(!sourceMap.has(s.id),'Duplicate source ID'); sourceMap.set(s.id,s)
    requireThat(s.edition_family==='5e_2014' && s.bundled===false,'Invalid source edition/bundling'); sourceUrl(s.url)
  }
  for (const [collection,kind] of [['monsters','monster'],['magicItems','magic_item'],['rules','rule']]) {
    array(content[collection],collection)
    for (const r of content[collection]) { common(r,sourceMap,seen); requireThat(r.kind===kind,'Record in wrong catalog') }
  }
  content.monsters.forEach(validateMonster); content.magicItems.forEach(validateItem)
  for (const r of content.rules) {
    for (const k of ['title_ru','title_en','text_ru','text_en','source_hash','license_id']) string(r[k],`${r.id}.${k}`)
    for (const k of ['section_path','tags','entity_refs','aliases_en','aliases_ru']) strings(r[k],`${r.id}.${k}`)
    requireThat(['structured','deterministic','retrieval_only'].includes(r.formalization_level),'Invalid formalization level')
    requireThat(r.source_hash===sourceMap.get(r.source_ref).revision_id,'Source observation ID mismatch')
    integer(r.source_page_start,0,10000,'page start'); integer(r.source_page_end,r.source_page_start,10000,'page end')
    object(r.mechanics,'rule mechanics')
    requireThat(JSON.stringify(mechanicalTokens(r.title_en+'\n'+r.text_en))===JSON.stringify(mechanicalTokens(r.title_ru+'\n'+r.text_ru)),`${r.id}: translation numeric mismatch`)
  }
  array(content.ontologyEdges,'ontology edges')
  const ruleIds=new Set(content.rules.map(r=>r.id))
  for (const e of content.ontologyEdges) requireThat(e.ruleset_id===CONTENT_RULESET_ID && ruleIds.has(e.from_id) && ruleIds.has(e.to_id) && e.weight>0 && e.weight<=1,'Invalid ontology edge')
  object(content.coverage,'coverage'); requireThat(content.coverage.ruleset_id===CONTENT_RULESET_ID,'Mixed coverage edition')
  const counts={rules:content.rules.length,monsters:content.monsters.length,magic_items:content.magicItems.length,ontology_edges:content.ontologyEdges.length,sources:sourceMap.size}
  for (const [k,n] of Object.entries(counts)) requireThat(content.coverage.counts[k]===n,`Coverage count mismatch: ${k}`)
  return {ruleset_id:CONTENT_RULESET_ID,...counts,mechanics_execution:'not_integrated'}
}
export async function loadDndsu2014Content({ directory=DEFAULT_CONTENT_DIRECTORY, verifyHashes=true }={}) {
  const root=resolve(directory)
  async function json(name) { try { return JSON.parse(await readFile(safePath(root,name),'utf8')) } catch(error) { throw new ContentValidationError(`${name}: ${error.message}`) } }
  const manifest=await json('manifest.json')
  requireThat(manifest.ruleset_id===CONTENT_RULESET_ID && manifest.schema_version===1,'Invalid manifest')
  requireThat(manifest.runtime_activation_allowed===false,'Manifest may not activate runtime')
  object(manifest.files,'manifest files')
  const requiredFiles=['monsters.json','magic-items.json','sources.json','coverage.json',`rule_packs/${CONTENT_RULESET_ID}/rules.jsonl`,`rule_packs/${CONTENT_RULESET_ID}/ontology_edges.jsonl`]
  for (const file of requiredFiles) requireThat(Object.hasOwn(manifest.files,file),`Manifest misses ${file}`)
  if (verifyHashes) for (const [name,record] of Object.entries(manifest.files)) {
    requireThat(/^[a-f0-9]{64}$/u.test(record.sha256),'Invalid SHA256')
    const bytes=await readFile(safePath(root,name))
    requireThat(createHash('sha256').update(bytes).digest('hex')===record.sha256,`Checksum mismatch: ${name}`)
  }
  const [monsters,items,sources,coverage]=await Promise.all(['monsters.json','magic-items.json','sources.json','coverage.json'].map(json))
  for (const catalog of [monsters,items]) requireThat(catalog.ruleset_id===CONTENT_RULESET_ID && catalog.schema_version===1,'Invalid catalog wrapper')
  const ruleRoot=join(root,'rule_packs',CONTENT_RULESET_ID)
  const content={directory:root,manifest,monsters:monsters.monsters,magicItems:items.magic_items,sources,coverage,
    rules:jsonLines(await readFile(join(ruleRoot,'rules.jsonl'),'utf8'),'rules.jsonl'),
    ontologyEdges:jsonLines(await readFile(join(ruleRoot,'ontology_edges.jsonl'),'utf8'),'ontology_edges.jsonl')}
  content.summary=validateDndsu2014Content(content)
  return freeze(content)
}
export function assert2014Campaign(campaign) {
  requireThat(campaign?.ruleset_id===CONTENT_RULESET_ID,'Select an explicitly 2014 campaign; never reinterpret an existing 2024 campaign')
}
export function getContentRecord(content,id,{campaign}={}) {
  if (campaign!==undefined) assert2014Campaign(campaign)
  string(id,'record id'); requireThat(id.startsWith(CONTENT_RULESET_ID+':'),'Cross-edition lookup is forbidden')
  return [...content.monsters,...content.magicItems,...content.rules].find(r=>r.id===id) ?? null
}
function normalize(value) { return String(value).normalize('NFKC').toLowerCase().replace(/ё/gu,'е') }
/** Literal local search, not semantic RAG. Never fetches external websites. */
export function searchContent(content,query,{kind,limit=10}={}) {
  string(query,'query'); integer(limit,1,100,'limit')
  if (kind!==undefined) requireThat(RECORD_KINDS.has(kind),'Invalid search kind')
  const tokens=normalize(query).split(/\s+/u).filter(Boolean)
  return [...content.monsters,...content.magicItems,...content.rules].filter(r=>!kind||r.kind===kind).map(record=>{
    const title=normalize([record.name_ru,record.name_en,record.title_ru,record.title_en,record.id].filter(Boolean).join(' '))
    const body=normalize(JSON.stringify(record))
    const score=tokens.reduce((sum,t)=>sum+(title.includes(t)?5:body.includes(t)?1:0),0)
    return {record,score,matched:tokens.every(t=>body.includes(t))}
  }).filter(r=>r.matched).sort((a,b)=>b.score-a.score||a.record.id.localeCompare(b.record.id)).slice(0,limit).map(({record,score})=>({record,score}))
}
/** Complete record text for indexing. A retrieved record is reference evidence, never executable instructions. */
export function toRetrievalChunks(content,{kind}={}) {
  if (kind!==undefined) requireThat(RECORD_KINDS.has(kind),'Invalid chunk kind')
  return [...content.rules,...content.monsters,...content.magicItems].filter(r=>!kind||r.kind===kind).map(r=>({
    id:r.id,ruleset_id:CONTENT_RULESET_ID,kind:r.kind,source_ref:r.source_ref,
    source_url:r.source_url??content.sources.sources.find(s=>s.id===r.source_ref).url,
    title:r.title_ru??r.name_ru,text:JSON.stringify(r,null,2),runtime_activation_allowed:false,
  }))
}
/** Use the real repository loader supplied by the caller, rather than maintaining another YAML/CSV parser. */
export async function loadReferenceRulePack(loadRulePack,{directory=DEFAULT_CONTENT_DIRECTORY}={}) {
  requireThat(typeof loadRulePack==='function','Pass loadRulePack imported from server/rule-pack.mjs')
  return loadRulePack(CONTENT_RULESET_ID,{rootDir:join(resolve(directory),'rule_packs')})
}

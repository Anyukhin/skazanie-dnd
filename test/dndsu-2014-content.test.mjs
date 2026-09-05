import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRulePack } from '../server/rule-pack.mjs'
import {
  loadDndsu2014Content, validateDndsu2014Content, diceAverage, mechanicalTokens,
  getContentRecord, searchContent, toRetrievalChunks, assert2014Campaign,
  loadReferenceRulePack, DEFAULT_CONTENT_DIRECTORY, ContentValidationError,
} from '../server/dndsu-2014-content.mjs'

const content = await loadDndsu2014Content()
const monster = key => getContentRecord(content, `dnd_5e_2014:monster:${key}`)
const item = key => getContentRecord(content, `dnd_5e_2014:item:${key}`)
const rule = key => getContentRecord(content, `dnd_5e_2014:compendium:${key}`)
const copy = () => structuredClone(content)
const action = (m,key) => m.actions.find(a => a.id === key)

test('справочное расширение загружается настоящим загрузчиком без замены базового пакета', async () => {
  const [base, reference] = await Promise.all([loadRulePack('dnd_5e_2014'), loadReferenceRulePack(loadRulePack)])
  assert.equal(reference.summary.rule_count, 91)
  assert.notEqual(base.summary.pack_id, reference.summary.pack_id)
  const baseIds = new Set(base.rules.map(record => record.id))
  assert.ok(reference.rules.every(record => !baseIds.has(record.id)))
})

// Golden cases protect these recorded 2014 values, not every possible D&D rule.
test('catalog counts and unactivated state', () => {
  assert.equal(content.monsters.length,24); assert.equal(content.magicItems.length,32)
  assert.equal(content.rules.length,91); assert.equal(content.sources.sources.length,56)
  assert.equal(content.manifest.runtime_activation_allowed,false)
  assert.equal(content.summary.mechanics_execution,'not_integrated')
})
test('all local data hashes checked on load', () => {
  assert.equal(Object.keys(content.manifest.files).length,13)
  for (const value of Object.values(content.manifest.files)) assert.match(value.sha256,/^[a-f0-9]{64}$/u)
})
test('Goblin is the 2014 baseline', () => {
  const m=monster('goblin'); assert.equal(m.hit_points.average,7); assert.equal(m.armor_class.value,15)
  assert.equal(m.bonus_actions[0].mechanics.action_cost,'bonus_action')
})
test('Dire Wolf is 37 HP, not a renamed 2024 profile', () => {
  const m=monster('dire-wolf'); assert.equal(m.hit_points.average,37)
  assert.equal(m.hit_points.formula,'5d10+10'); assert.equal(action(m,'bite').damage[0].expression,'2d6+3')
})
test('Skeleton keeps 2014 armor and Dexterity', () => {
  const m=monster('skeleton'); assert.equal(m.armor_class.value,13); assert.equal(m.abilities.dex,14)
  assert.deepEqual(m.damage_vulnerabilities,['bludgeoning'])
})
test('Bugbear thrown javelin does not gain Brute dice', () => {
  const a=action(monster('bugbear'),'javelin')
  assert.equal(a.damage[0].expression,'2d6+2'); assert.equal(a.ranged_damage,'1d6+2')
})
test('Ghoul bite preserves the printed +2 attack', () => assert.equal(action(monster('ghoul'),'bite').attack_modifier,2))
test('Bandit Captain preserves explicit skills and alternate multiattack', () => {
  const m=monster('bandit-captain')
  assert.deepEqual(m.skills,{athletics:4,deception:4}); assert.equal(action(m,'multiattack').sequences.length,2)
  assert.equal(m.field_notes[0].source_ref,'srd51:stat-block-corroboration')
})
test('Mage keeps saves and five levels of real spell slots', () => {
  const m=monster('mage'); assert.deepEqual(m.saving_throws,{int:6,wis:4})
  assert.deepEqual(m.spellcasting.spell_slots.filter(x=>x.level>0).map(x=>x.slots),[4,3,3,3,1])
  assert.equal(m.spellcasting.spell_resolution,'external_spell_key_requires_2014_catalog')
})
test('Acolyte printed slot count is not inferred from class level', () => {
  const s=monster('acolyte').spellcasting
  assert.equal(s.caster_level,1); assert.equal(s.spell_slots.find(x=>x.level===1).slots,3)
})
test('Gelatinous Cube has 84 HP and no invented acid immunity', () => {
  const m=monster('gelatinous-cube'); assert.equal(m.hit_points.average,84)
  assert.equal(m.damage_immunities.includes('acid'),false)
  const pull=m.traits.find(x=>x.id==='ooze-cube').mechanics.pull_out
  assert.equal(pull.damage_applies,'regardless_of_check_result'); assert.deepEqual(pull.targets,['creature','object'])
})
test('Troll regeneration remains conditional and unimplemented', () => {
  const t=monster('troll').traits.find(x=>x.id==='regeneration')
  assert.equal(t.mechanics.heal_hp,10); assert.deepEqual(t.mechanics.suppressing_damage_types,['acid','fire'])
  assert.equal(t.mechanics_status,'requires_handler')
})
test('Young Red Dragon does not acquire adult legendary actions', () => {
  const m=monster('young-red-dragon'); assert.equal(m.hit_points.average,178)
  assert.equal(m.legendary_actions.length,0); assert.equal(m.lair_actions.length,0)
  assert.equal(action(m,'bite').damage.length,2); assert.equal(action(m,'fire-breath').damage[0].expression,'16d6')
})
test('all monster HP and weapon averages are mathematically consistent', () => {
  for (const m of content.monsters) {
    assert.equal(diceAverage(m.hit_points.formula),m.hit_points.average)
    for(const a of m.actions) for(const d of a.damage??[]) assert.equal(diceAverage(d.expression),d.average)
  }
})
test('full source histories are not falsely marked as present', () => {
  assert.equal(content.monsters.filter(m=>m.lore.history_status==='no_source_history_bundled').length,6)
  content.monsters.forEach(m=>assert.equal(m.lore.full_text_included,false))
})
test('healing potion consumes an action and has correct dice', () => {
  const i=item('potion-of-healing'); assert.equal(i.effects[0].expression,'2d4+2')
  assert.equal(i.activation[0].action_cost,'action'); assert.equal(i.attunement.required,false)
  const potions=content.magicItems.filter(i=>i.effects.some(e=>e.kind==='heal'))
  assert.deepEqual(potions.map(i=>i.effects[0].expression),['2d4+2','4d4+4','8d4+8','10d4+20'])
})
test('Water Breathing potion lasts 1 hour in the recorded 2014 profile', () => assert.equal(item('potion-of-water-breathing').duration_minutes,60))
test('weapon, armor and shield enhancements are base-item templates', () => {
  for(const base of ['weapon','armor','shield']) for(const n of [1,2,3]) {
    const i=item(`${base}-plus-${n}`); assert.equal(i.requires_base_item,true)
    assert.equal(i.variant.enhancement_bonus,n); assert.equal(i.attunement.required,false)
  }
  assert.equal(item('armor-plus-3').rarity,'legendary'); assert.equal(item('weapon-plus-3').rarity,'very_rare')
})
test('resistance ring grants one chosen resistance and requires attunement', () => {
  const i=item('ring-of-resistance'); assert.equal(i.attunement.required,true)
  assert.equal(i.variant.kind,'damage_type_required'); assert.equal(i.variant.options.length,10)
  assert.equal(i.effects[0].damage_type_from,'variant.damage_type')
})
test('Web wand uses charges, attunement and concentration', () => {
  const i=item('wand-of-web'); assert.equal(i.attunement.required,true)
  assert.equal(i.charges.maximum,7); assert.equal(i.charges.regain.expression,'1d6+1')
  assert.equal(i.effects[0].concentration_required,true); assert.equal(i.effects[0].save_dc,15)
  assert.equal(item('wand-of-magic-missiles').attunement.required,false)
})
test('unknown prices are null rather than free', () => content.magicItems.forEach(i=>assert.equal(i.price_gp,null)))
test('grapple replaces one attack and uses an opposed check', () => {
  const m=rule('combat:grapple').mechanics
  assert.equal(m.action_cost,'one_attack_of_attack_action')
  assert.equal(m.attacker_check,'str:athletics'); assert.deepEqual(m.defender_choices,['str:athletics','dex:acrobatics'])
})
test('bonus-action spell rule is not universal one leveled spell per turn', () => {
  const m=rule('spells:bonus-action').mechanics
  assert.equal(m.other_spells_this_turn,'only_cantrips_with_casting_time_one_action')
  assert.equal(m.not_universal_one_leveled_spell_per_turn,true)
})
test('2014 exhaustion uses six cumulative levels', () => {
  const e=rule('condition:exhaustion').mechanics.effects
  assert.equal(e.levels.length,6); assert.equal(e.levels[5].effect,'death'); assert.equal(e.cumulative,true)
})
test('long rest recovers only half Hit Dice and respects 24-hour limit', () => {
  const m=rule('rest:long').mechanics
  assert.equal(m.hit_dice_recovery,'max(1, floor(total_hit_dice / 2))'); assert.equal(m.benefit_at_most_once_per_hours,24)
})
test('encounter tables cover levels 1–20 without multiplying awarded XP', () => {
  const t=rule('encounters:thresholds').mechanics.levels; assert.equal(t.length,20)
  assert.equal(t[0].deadly,100); assert.equal(t[19].deadly,12700)
  assert.equal(rule('encounters:multipliers').mechanics.reward_xp,'unadjusted_sum_monster_xp')
  assert.deepEqual(rule('encounters:party-size').mechanics.multiplier_scale,[0.5,1,1.5,2,2.5,3,4,5])
})
test('retrieval includes complete mechanics, not only short flavor text', () => {
  const chunks=toRetrievalChunks(content); assert.equal(chunks.length,147)
  const r=rule('combat:grapple'); assert.ok(r.text_ru.includes('str:athletics'))
  assert.deepEqual(mechanicalTokens(r.text_ru),mechanicalTokens(r.text_en))
  assert.ok(chunks.find(c=>c.id===r.id).text.includes('free_hands_required'))
})
test('local search supports Russian names and kind filtering', () => {
  const found=searchContent(content,'лютый волк',{kind:'monster'})
  assert.equal(found[0].record.id,monster('dire-wolf').id)
  assert.ok(searchContent(content,'концентрация',{kind:'rule'}).length>0)
  assert.throws(()=>searchContent(content,' '),ContentValidationError)
  assert.throws(()=>searchContent(content,'волк',{limit:1000}),ContentValidationError)
})
test('loaded records and nested values are immutable', () => {
  assert.ok(Object.isFrozen(content)); assert.ok(Object.isFrozen(monster('goblin').abilities))
  assert.throws(()=>{monster('goblin').abilities.str=30},TypeError)
})
test('cross-edition records and campaigns are rejected', () => {
  assert.throws(()=>getContentRecord(content,'srd_5_2_1:goblin'),ContentValidationError)
  assert.throws(()=>getContentRecord(content,monster('goblin').id,{campaign:{ruleset_id:'srd_5_2_1'}}),ContentValidationError)
  assert.doesNotThrow(()=>assert2014Campaign({ruleset_id:'dnd_5e_2014'}))
  assert.equal(getContentRecord(content,'dnd_5e_2014:monster:missing'),null)
})
test('duplicate IDs, false activation and unknown source are rejected', () => {
  for(const mutate of [c=>{c.monsters[1].id=c.monsters[0].id},c=>{c.monsters[0].runtime_activation_allowed=true},c=>{c.monsters[0].source_ref='unknown'}]) {
    const c=copy(); mutate(c); assert.throws(()=>validateDndsu2014Content(c),ContentValidationError)
  }
})
test('invalid arithmetic and broken multiattack references are rejected', () => {
  const c=copy(); c.monsters[0].hit_points.average+=1
  assert.throws(()=>validateDndsu2014Content(c),/HP average mismatch/u)
  const d=copy(); d.monsters.find(m=>m.id.endsWith(':bandit-captain')).actions[0].sequences[0][0].action_id='missing'
  assert.throws(()=>validateDndsu2014Content(d),/multiattack/u)
})
test('translation numerical drift is rejected', () => {
  const c=copy(); c.rules[0].text_ru+=' 9999'; assert.throws(()=>validateDndsu2014Content(c),/numeric mismatch/u)
})
test('2024 source host cannot be imported', () => {
  const c=copy(); c.sources.sources[0].url='https://next.dnd.su/bestiary/4-goblin/'
  assert.throws(()=>validateDndsu2014Content(c),/2024/u)
})
test('dice parser does not execute expressions', () => {
  assert.equal(diceAverage('2d6-2'),5)
  for(const bad of ['process.exit()','1d6;rm','0d6','2d1','Math.random()']) assert.throws(()=>diceAverage(bad),ContentValidationError)
})
test('changed data bytes fail checksum verification', async () => {
  const root=await mkdtemp(join(tmpdir(),'skazanie-2014-'))
  try {
    await cp(DEFAULT_CONTENT_DIRECTORY,root,{recursive:true})
    const path=join(root,'monsters.json'); await writeFile(path,(await readFile(path,'utf8'))+'\n')
    await assert.rejects(loadDndsu2014Content({directory:root}),/Checksum mismatch/u)
  } finally { await rm(root,{recursive:true,force:true}) }
})
test('manifest path traversal is rejected before accessing outside files', async () => {
  const root=await mkdtemp(join(tmpdir(),'skazanie-path-'))
  try {
    const manifest=structuredClone(content.manifest)
    manifest.files={'../outside.txt':{sha256:'0'.repeat(64)},...manifest.files}
    await writeFile(join(root,'manifest.json'),JSON.stringify(manifest))
    await assert.rejects(loadDndsu2014Content({directory:root}),/Unsafe file path/u)
  } finally { await rm(root,{recursive:true,force:true}) }
})
test('rule-pack adapter passes isolated root to caller-supplied loader', async () => {
  let called
  const value=await loadReferenceRulePack(async (...args)=>{called=args;return {ok:true}})
  assert.equal(value.ok,true); assert.equal(called[0],'dnd_5e_2014')
  assert.equal(called[1].rootDir,join(DEFAULT_CONTENT_DIRECTORY,'rule_packs'))
  // This verifies the adapter call, not the real repository loader or replay.
})

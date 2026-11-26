import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {Box3,Vector3} from 'three'
import {compileClientModules} from './kit/client-ts.mjs'
import {classicMonstersForTheme} from '../server/encounter-assembler.mjs'
import {actorAppearanceFor} from '../server/actor-appearance.mjs'

const {modules:[models,figures]} = await compileClientModules(['src/actor-models.ts','src/astohan-enemy-figures.ts'])
const manifest=JSON.parse(readFileSync(new URL('../public/assets/models/manifest.json',import.meta.url)))
const scenario=JSON.parse(readFileSync(new URL('../data/campaign-scenarios-v1.json',import.meta.url))).scenarios.find(s=>s.id==='astohan-dragon-hunt')
const themes=new Set(scenario.locations.flatMap(l=>l.encounter?[l.encounter.theme]:[]))
themes.add(scenario.attention.finale.ready_ambush.theme)
const records=new Map([...themes].flatMap(theme=>classicMonstersForTheme(theme).map(m=>[m.id,m])))

test('каждый вид из встреч Асстохана и финальной засады имеет исполнимую модель', async () => {
  assert.equal(records.size,53)
  for(const monster of records.values()) {
    const slug=monster.id.split(':').at(-1)
    const input={kind:'enemy',id:'opaque',label:monster.name_ru+' 1',archetype:monster.creature_type,
      appearance:actorAppearanceFor('enemy',{name:monster.name_ru,creature_type:monster.creature_type,size:monster.size})}
    assert.equal(figures.campaignEnemySlug(input),slug)
    const entry=models.resolveModelProfile(input,manifest)
    if(entry.url){
      assert.ok(manifest.models.some(m=>m.key===entry.key && m.url===entry.url))
      continue
    }
    assert.equal(entry.key,'astohan-figure-'+slug)
    const model=await models.createActorModel(input,{manifest})
    try {
      assert.equal(model.source,'procedural')
      const body=model.getObjectByName('actor-motion')
      assert.ok(body?.children.length && !model.getObjectByName('procedural-body'),slug)
      for(const pose of ['idle','walk','attack','hit','death']) {
        model.setPose(pose,.35)
        const size=new Box3().setFromObject(model,true).getSize(new Vector3())
        assert.ok(size.toArray().every(v=>Number.isFinite(v)&&v>.01),slug+'/'+pose)
      }
    } finally {model.dispose()}
  }
})

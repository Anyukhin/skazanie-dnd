import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { FakeLLM } from '../server/llm-client.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import {
  SCENE_REQUIREMENTS_VERSION,
  SCENE_REQUIREMENT_KINDS,
  normalizeSceneRequirements,
  normalizeScenePosts,
  requirementAssets,
  requirementLabel,
  requirementsCoverage,
  sceneMapRequirementsFor,
  sceneRequirementsFromText,
} from '../server/scene-requirements.mjs'
import { listAssets } from '../server/asset-registry.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

/**
 * Обязательные объекты сцены: что текст сцены пообещал увидеть на карте.
 * Модуль детерминированный и без модели, поэтому проверяется прямыми
 * примерами — в том числе русской морфологией, на которой `\b` в JS ломается.
 */

const ids = (text) => sceneRequirementsFromText(text).map((item) => item.id)

test('пролог живой кампании даёт навес, ящик, три настила и камни на порогах', () => {
  const prologue = 'Деревня проснулась рано. Под общим навесом стоит ящик с документами старосты, '
    + 'к воде спускаются три дощатых настила, а на каждом крыльце — камни на порогах от сырости.'
  assert.deepEqual(sceneRequirementsFromText(prologue), [
    { id: 'shelter', count: 1 },
    { id: 'crate', count: 1 },
    { id: 'platform', count: 3 },
    { id: 'threshold_stone', count: 1 },
  ])
})

test('русская морфология: падежи ловятся, похожие слова — нет', () => {
  assert.deepEqual(ids('У колодца, у костра и под навесами'), ['well', 'campfire', 'shelter'])
  assert.deepEqual(ids('Сундуки, ларец и шкатулка'), ['chest'])
  assert.deepEqual(ids('Он навеселе. Столица шумит, у столба дежурит стража. Котлован пуст.'), [],
    '«навеселе» не навес, «столица» и «столб» не стол, «котлован» не котёл')
  assert.deepEqual(ids('Подстолье и заборщик'), [], 'слово внутри другого слова не считается')
  assert.deepEqual(ids('СТАРЫЙ КОЛОДЕЦ'), ['well'], 'регистр не важен')
})

test('отрицание снимает объект, а соседнее число без связи не считается количеством', () => {
  assert.deepEqual(ids('Здесь нет колодца, а площадь без навеса.'), [])
  assert.deepEqual(ids('Нет ни одного колодца у мельницы.'), [])
  assert.deepEqual(ids('Без старого навеса пусто, но колодец на месте.'), ['well'])
  assert.deepEqual(sceneRequirementsFromText('В двух шагах от колодца'), [{ id: 'well', count: 1 }])
  assert.deepEqual(sceneRequirementsFromText('Их было три. Настилы прогнили'), [{ id: 'platform', count: 1 }])
  assert.deepEqual(sceneRequirementsFromText('Две бочки и 4 ящика'), [{ id: 'barrels', count: 2 }, { id: 'crate', count: 4 }])
  assert.deepEqual(sceneRequirementsFromText('Двенадцать фонарей'), [{ id: 'lantern', count: 1 }], 'незнакомое числительное — просто «есть»')
  assert.deepEqual(sceneRequirementsFromText('20 бочек'), [{ id: 'barrels', count: 6 }], 'количество ограничено')
  // Повтор берёт наибольшее количество и первое место упоминания.
  assert.deepEqual(sceneRequirementsFromText(['Костёр у дороги.', 'Два костра дымят.']), [{ id: 'campfire', count: 2 }])
})

test('поле сцены появляется только когда обещать есть что, и переживает нормализацию', () => {
  assert.equal(sceneMapRequirementsFor(['Пустая дорога в поле.', null, 42]), null)
  const field = sceneMapRequirementsFor('У колодца стоит телега')
  assert.deepEqual(field, { version: SCENE_REQUIREMENTS_VERSION, items: [{ id: 'well', count: 1 }, { id: 'cart', count: 1 }], focus: 'well' })
  assert.deepEqual(normalizeSceneRequirements(field), field.items)
  assert.deepEqual(normalizeSceneRequirements([{ id: 'well', count: 0 }, { id: 'well', count: 3 }, { id: 'ufo' }, 'x']), [{ id: 'well', count: 1 }])
  assert.deepEqual(normalizeSceneRequirements(null), [])
})

test('каждый объект словаря воплощается предметами реестра — или честно не воплощается', () => {
  const registered = new Set(listAssets().map((asset) => asset.id))
  for (const kind of SCENE_REQUIREMENT_KINDS) {
    for (const assetId of kind.assets) assert.ok(registered.has(assetId), `${kind.id}: предмета ${assetId} нет в реестре`)
    assert.ok(requirementLabel(kind.id))
  }
  // Навес воплощает торговый навес из набора детализации; настила в реестре
  // пока нет — генератор его не даст, и это должно быть видно, а не
  // замаскировано похожим предметом.
  assert.deepEqual(requirementAssets('shelter'), ['market_awning'])
  assert.deepEqual(requirementAssets('platform'), [])
  assert.deepEqual(requirementsCoverage([{ id: 'shelter', count: 1 }, { id: 'crate', count: 2 }], { crate: 1, chest: 1 }),
    { met: ['crate'], missing: ['shelter'] })
})

test('первая сцена кампании хранит обещанное прологом, игрок служебный список не видит', async () => {
  const opening = {
    campaignName: 'Навес', partyName: 'Путники',
    worldSummary: 'Долина с тихими деревнями.',
    openingNarration: 'Деревня Кленовка встречает вас тишиной. Под общим навесом у колодца стоит ящик с документами.',
    scene: { title: 'Кленовка', location: 'Деревня Кленовка', mood: 'Тревожная тишина', objective: 'Найти старосту', theme: 'тихая деревня', danger: 'низкая', map: { layout: 'streets', pattern: 'organic', material: 'earth', width: 26, height: 22, openness: .6, water: 0, featureCount: 6 } },
    hook: 'Пропавший староста',
  }
  const created = await new CampaignBootstrapper({ llmClient: new FakeLLM([{ content: JSON.stringify(opening) }]) }).create({
    code: 'NAVES-1', name: 'Навес', partyName: 'Путники', world: { startingLocation: 'Деревня Кленовка' },
    players: [{ id: 'hero', name: 'Анна', character: 'Нова', role: 'Воин · ур. 1', species: 'Человек', speed: 30, maxHp: 12, armor: 13, online: true }],
  })
  const expected = { version: SCENE_REQUIREMENTS_VERSION, items: [{ id: 'shelter', count: 1 }, { id: 'well', count: 1 }, { id: 'crate', count: 1 }], focus: 'shelter' }
  assert.deepEqual(created.scene.map_requirements, expected)
  const state = normalizeCampaignState(created)
  assert.deepEqual(state.scene.map_requirements, expected)
  assert.equal(campaignStateForViewer(state, { id: 'player', role: 'player' }, 'hero').scene.map_requirements, undefined)
})

test('программа сцены: центр, посты жителей и предмет поста в обещанном', () => {
  // Живая кампания 2026-10-02 «Скит Трёх Настилов»: староста под навесом,
  // хранитель записей у запертого ящика, мастер настилов у помостов.
  const field = sceneMapRequirementsFor('В центре скита — общий навес, к воде спускаются три настила.', {
    npcs: [
      { name: 'Илва', role: 'староста скита', summary: 'Держит раскрытую копию соглашения о проходе.' },
      { name: 'Терен', role: 'хранитель записей', summary: 'Стоит у запертого ящика для документов.' },
      { name: 'Вейра', role: 'мастер настилов', summary: 'Пахнет смолой и мокрым деревом.' },
      { name: 'Гость', role: 'странник', summary: 'Молча слушает.' },
    ],
  })
  assert.equal(field.version, 'scene-requirements/v3')
  assert.equal(field.focus, 'shelter')
  assert.deepEqual(field.posts, [
    { npc: 'Илва', id: 'shelter' },
    { npc: 'Терен', id: 'crate' },
    { npc: 'Вейра', id: 'platform' },
  ])
  assert.ok(field.items.some((item) => item.id === 'crate'), 'ящик хранителя попал в обещанное, хотя в описании сцены его нет')
  assert.deepEqual(normalizeScenePosts(field), field.posts)
  assert.deepEqual(normalizeScenePosts({ items: [], posts: [{ npc: 'x', id: 'ufo' }, { npc: '', id: 'well' }] }), [])
  assert.deepEqual(normalizeScenePosts({ version: 'scene-requirements/v1', items: [{ id: 'well', count: 1 }] }), [], 'старая сцена — без постов')
  // Кузнец без описания — по роли; странник поста не получает.
  assert.deepEqual(sceneMapRequirementsFor('Площадь с колодцем.', { npcs: [{ name: 'Тор', role: 'кузнец', summary: '' }] }).posts, [{ npc: 'Тор', id: 'forge' }])
})

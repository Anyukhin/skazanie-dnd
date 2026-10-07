import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Box3, Vector3 } from 'three'

import { actorAppearanceFor, actorProfileFor } from '../server/actor-appearance.mjs'
import { compileClientModules } from './kit/client-ts.mjs'

// Саргат — молодой красный дракон: в 3D он не волк и не воин, а отдельная
// фигура дракона Cethiel/Drummyfish (CC0) со стойкой, шагом, укусом и смертью.
const { modules: [models] } = await compileClientModules(['src/actor-models.ts', 'src/model-assets.ts'])
const manifest = JSON.parse(readFileSync(new URL('../public/assets/models/manifest.json', import.meta.url), 'utf8'))
const dragon = manifest.models.find((entry) => entry.key === 'dragon')

test('сервер выдаёт дракону профиль dragon, а замаскированному — нет', () => {
  assert.equal(actorProfileFor({ kind: 'enemy', name: 'Саргат', role: 'молодой красный дракон и наследник Вулканиса' }), 'dragon')
  assert.equal(actorProfileFor({ kind: 'enemy', name: 'Red Wyrmling' }), 'dragon')
  // Боевая карточка Саргата несёт только имя и публичный тип существа.
  assert.equal(actorAppearanceFor('enemy', { id: 'astohan-sargat', name: 'Саргат', creature_type: 'dragon' }).profile, 'dragon')
  assert.equal(actorProfileFor({ kind: 'enemy', name: 'Волк' }), 'beast')
  // Маска не выдаёт породу через модель.
  assert.equal(actorProfileFor({ kind: 'enemy', name: 'Неизвестная тень', role: 'дракон', masked: true }), 'warrior')
})

// Обзор карт 2026-10-08: король Арес «прославленный драконоборец» стоял в
// галерее Штормберга фигурой красного дракона — шаблон ловил «дракон» внутри
// слова. Дракон — только целым словом и не как добыча.
test('драконоборец, охотник на драконов и драконорождённый — не дракон', () => {
  for (const role of ['король Валедора и прославленный драконоборец', 'охотник на драконов', 'dragon slayer', 'драконорождённый паладин']) {
    assert.notEqual(actorProfileFor({ kind: 'npc', name: 'Арес', role }), 'dragon', role)
    assert.notEqual(models.resolveModelProfile({ id: 'npc', label: 'Арес', kind: 'neutral', archetype: role }, manifest).profile, 'dragon', role)
  }
  assert.equal(actorProfileFor({ kind: 'enemy', name: 'Тварь', role: 'виверна' }), 'dragon')
  assert.equal(models.resolveModelProfile({ id: 'x', label: 'Красный дракон', kind: 'enemy', archetype: 'красный дракон' }, manifest).key, 'dragon')
})

test('каталог ведёт профиль dragon к модели дракона с правами CC0', () => {
  assert.ok(dragon, 'запись dragon в manifest')
  assert.equal(dragon.profile, 'dragon')
  assert.equal(dragon.rights.license, 'CC0-1.0')
  const appearance = { version: 2, profile: 'dragon', equipment: 'unarmed', loadout: {} }
  assert.equal(models.resolveModelProfile({ id: 'astohan-sargat', label: 'Саргат', kind: 'enemy', appearance }, manifest).key, 'dragon')
  assert.equal(models.resolveModelProfile({ id: 'x', label: 'Дракон', kind: 'enemy', archetype: 'дракон' }, manifest).key, 'dragon')
  // Без каталога остаётся процедурная фигура того же профиля.
  assert.equal(models.resolveModelProfile({ id: 'astohan-sargat', label: 'Саргат', kind: 'enemy', appearance }).profile, 'dragon')
})

test('клипы драконов получают позы: укус, полёт и удар головой — атака или ход', () => {
  const pose = (name) => models.actorClipInfo(name)?.pose ?? null
  assert.equal(pose('CharacterArmature|Flying_Idle'), 'idle')
  assert.equal(pose('CharacterArmature|Fast_Flying'), 'walk')
  assert.equal(pose('CharacterArmature|Headbutt'), 'attack')
  assert.equal(pose('CharacterArmature|HitReact'), 'hit')
  assert.equal(pose('CharacterArmature|Death'), 'death')
  assert.equal(pose('Bite_Attack'), 'attack')
  assert.equal(pose('Bite'), 'attack')
})

test('GLB дракона загружается, проходит позы и стоит на полу', async () => {
  const previousSelf = globalThis.self
  globalThis.self = globalThis
  try {
    const bytes = readFileSync(join(fileURLToPath(new URL('../public/', import.meta.url)), dragon.url.slice(1)))
    const report = models.validateGlbContainer(bytes)
    const clips = report.json.animations.map((animation) => animation.name)
    for (const clip of ['Idle', 'Walk', 'Bite_Attack', 'Death']) assert.ok(clips.includes(clip), clip)
    for (const clip of clips) assert.ok(models.actorClipInfo(clip), `клип ${clip} получает позу`)
    const actor = await models.createActorModel({ id: 'astohan-sargat', label: 'Саргат', kind: 'enemy', modelKey: 'dragon' }, {
      manifest,
      fetcher: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
    })
    assert.equal(actor.source, 'glb')
    assert.equal(actor.profile, 'dragon')
    for (const pose of ['idle', 'walk', 'attack', 'hit', 'death']) {
      actor[pose](.5)
      actor.update(.001)
    }
    actor.idle()
    actor.update(.2)
    const bounds = new Box3().setFromObject(actor)
    assert.ok(Number.isFinite(bounds.max.y) && bounds.min.y >= -.0001, 'дракон стоит на полу')
    assert.ok(actor.modelHeight > 2, 'дракон выше героя')
    // Доска поворачивает фигуру к цели, считая, что голова смотрит в +Z.
    const head = actor.getObjectByName('jaw_upper')?.getWorldPosition(new Vector3())
    const base = actor.getObjectByName('base')?.getWorldPosition(new Vector3())
    assert.ok(head && base, 'кости головы и таза')
    assert.ok(Math.abs(Math.atan2(head.x - base.x, head.z - base.z)) < .5, 'голова дракона смотрит в +Z')
    actor.dispose()
  } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
  }
})

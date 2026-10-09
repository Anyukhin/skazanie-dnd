import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { actorAppearanceFor, actorProfileFor } from '../server/actor-appearance.mjs'
import { compileClientModules, repositoryRoot } from './kit/client-ts.mjs'

/**
 * Звери Quaternius «Animated Easy Enemies» (2026-10-09): крыса, паук, оса,
 * лягушка и змея получили свои фигурки. Раньше всё незнакомое по имени
 * рисовалось человеком-воином, а звери — одним волком.
 */

const { modules: [models] } = await compileClientModules(['src/actor-models.ts'])
const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'public/assets/models/manifest.json'), 'utf8'))

test('сервер узнаёт зверя по слову имени и по типу существа, но не по части слова', () => {
  for (const name of ['Гигантская крыса 1', 'Рой крыс', 'Гигантский паук', 'Гигантская оса 2', 'Гигантская жаба', 'Ядовитая змея', 'Giant Spider']) {
    assert.equal(actorProfileFor({ kind: 'enemy', name }), 'beast', name)
  }
  for (const name of ['Крысолов', 'Осада', 'Паукообразный жрец', 'Сотник Жуков']) {
    assert.notEqual(actorProfileFor({ kind: 'enemy', name }), 'beast', name)
  }
  assert.equal(actorProfileFor({ kind: 'enemy', name: 'Тень в кустах', creature_type: 'beast' }), 'beast')
  // Замаскированное имя не раскрывается и типом существа.
  assert.equal(actorProfileFor({ kind: 'enemy', name: 'Неизвестный', creature_type: 'beast', masked: true }), 'warrior')
  assert.equal(actorAppearanceFor('enemy', { name: 'Гигантская крыса', size: 'small' }).stature, 'small')
})

const enemy = (label) => ({ id: label, label, kind: 'enemy', appearance: { version: 2, profile: actorProfileFor({ kind: 'enemy', name: label }), equipment: 'unknown', loadout: {} } })

test('фигурка зверя выбирается по имени врага, волк остаётся общим зверем', () => {
  const pick = (label) => models.resolveModelProfile(enemy(label), manifest).key
  assert.equal(pick('Гигантская крыса 1'), 'rat')
  assert.equal(pick('Гигантский паук 2'), 'spider')
  assert.equal(pick('Гигантская оса'), 'wasp')
  assert.equal(pick('Гигантская лягушка'), 'frog')
  assert.equal(pick('Гигантская ядовитая змея'), 'snake')
  assert.equal(pick('Волк 3'), 'wolf')
  assert.equal(pick('Бурый медведь'), 'wolf', 'своей модели медведя нет')
  // Членистоногие без своей модели рисуются пауком, а не волком.
  assert.equal(pick('Скорпион'), 'spider')
  assert.equal(pick('Гигантский огненный жук'), 'spider')
  assert.equal(pick('Гигантская многоножка 1'), 'spider')
})

test('модели зверей лежат в каталоге, их хеши совпадают с NOTICE, рост — по категории размера', () => {
  const entries = manifest.models.filter((entry) => ['rat', 'spider', 'wasp', 'frog', 'snake'].includes(entry.key))
  assert.equal(entries.length, 5)
  for (const entry of entries) {
    assert.equal(entry.profile, 'beast')
    assert.equal(entry.rights.license, 'CC0-1.0')
    const file = join(repositoryRoot, 'public', entry.url)
    const notice = JSON.parse(readFileSync(join(file, '..', 'NOTICE.json'), 'utf8'))
    const output = notice.outputs.find((item) => item.key === entry.key)
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), output.sha256, entry.key)
    assert.ok(output.clips.some((clip) => models.actorClipInfo(clip)?.pose === 'attack'), `${entry.key}: есть клип атаки`)
  }
  // Крошечная крыса ниже маленькой, большой паук 2×2 выше среднего.
  const rat = entries.find((entry) => entry.key === 'rat')
  assert.ok(models.figureHeightFor(rat.height, 'beast', 1, 'tiny') < models.figureHeightFor(rat.height, 'beast', 1, 'small'))
  const spider = entries.find((entry) => entry.key === 'spider')
  assert.ok(models.figureHeightFor(spider.height, 'beast', 2) > spider.height)
})

test('гигантская крыса каталога 2014 приходит во встречи мелочи, склепа и пещеры и рисуется крысой', async () => {
  const { assembleEncounter } = await import('../server/encounter-assembler.mjs')
  const field = Array.from({ length: 10 }, (_, y) => Array.from({ length: 14 }, (_, x) => ({ x, y, type: 'floor', revealed: true }))).flat()
  const party = [1, 2, 3, 4].map((index) => ({ id: `hero-${index}`, level: 1, x: index - 1, y: 0 }))
  for (const theme of ['vermin', 'crypt', 'cave']) {
    let rats = []
    for (let seed = 1; seed <= 12 && !rats.length; seed += 1) {
      const proposal = assembleEncounter({ scene: { cells: field }, party, difficulty: 'easy', theme, seed: `rats:${theme}:${seed}`, ruleset_id: 'dnd_5e_2014' })
      rats = proposal.enemies.filter((enemy) => enemy.stat_block_id === 'dnd_5e_2014:monster:giant-rat' || /Гигантская крыса/u.test(enemy.name))
    }
    assert.ok(rats.length, `${theme}: гигантская крыса не пришла ни в одну из 12 встреч`)
    const rat = rats[0]
    assert.equal(rat.size, 'small')
    assert.equal(rat.image, '/assets/enemies/giant-rat.png')
    const appearance = actorAppearanceFor('enemy', rat)
    assert.deepEqual([appearance.profile, appearance.stature], ['beast', 'small'])
    assert.equal(models.resolveModelProfile({ id: rat.id, label: rat.name, kind: 'enemy', appearance }, manifest).key, 'rat')
  }
})

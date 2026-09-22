import assert from 'node:assert/strict'
import test from 'node:test'

import { auditCombatPresentation } from '../tools/audit-combat-presentation.mjs'

test('аудит перечисляет весь spell corpus, canonical weapons и actor models', async () => {
  const report = await auditCombatPresentation()
  assert.equal(report.counts.spells, 439)
  assert.equal(report.counts.weapons, 39)
  assert.equal(report.counts.attackModels, 40)
  assert.equal(report.counts.equipmentModels, 76)
  assert.ok(report.counts.actorModels >= 6)
  assert.equal(report.spells.length, 439)
  assert.equal(new Set(report.spells.map((spell) => spell.id)).size, 439)
  assert.ok(report.spells.every((spell) => spell.visualProfile.family && spell.visualProfile.familyNote && spell.visualProfile.soundFamily && spell.cue?.kind))
  assert.ok(report.spells.every((spell) => spell.sound.phases.length > 0))
  assert.equal(report.weapons.length, 40)
  assert.ok(report.weapons.every((weapon) => weapon.key && weapon.renderFamily && weapon.modelUrl && weapon.sound.phases.length > 0))
  assert.equal(report.weapons.find((weapon) => weapon.key === 'net')?.canonical, true)
  assert.equal(report.weapons.find((weapon) => weapon.key === 'wand')?.canonical, false)
  assert.ok(report.equipmentModels.some((model) => model.key === 'wand' && model.variant === 'enchanted' && model.category === 'accessory' && model.modelExists), 'wand-enchanted должен проверяться как accessory asset')
  assert.ok(report.equipmentModels.some((model) => model.key === 'arcane-crystal' && model.category === 'accessory' && model.modelExists), 'arcane-crystal не должен считаться оружием')
  assert.ok(report.equipmentModels.some((model) => model.key === 'bagpipes' && model.category === 'accessory' && model.modelExists), 'музыкальный фокус не должен считаться оружием')
  assert.deepEqual(report.mechanicsSupport, { partial: 242, heuristic: 189, 'ruling-only': 8 })
  assert.equal(report.counts.unsupportedSpellMechanics, 197)
  assert.equal(report.presentationReview.status, 'pending', 'структурный PASS не подтверждает просмотр или уникальность эффектов')
  assert.ok(report.presentationReview.configuredVisualProfiles <= report.counts.spells)
  const sharedIds = report.presentationReview.sharedVisualProfiles.flat()
  assert.equal(new Set(sharedIds).size, sharedIds.length)
  assert.ok(sharedIds.every((id) => report.spells.some((spell) => spell.id === id)))
  assert.equal(report.spells.find((spell) => spell.id === 'silence')?.visualProfile.visualVariant, 'silence')
  assert.equal(report.spells.find((spell) => spell.id === 'silence')?.sound.intentionalSilence, true)
  const firearm = report.weapons.find((weapon) => weapon.key === 'musket')
  const bludgeon = report.weapons.find((weapon) => weapon.key === 'club')
  assert.deepEqual(firearm?.sound.phases.find((phase) => phase.phase === 'start')?.clipIds, [], 'gunshot не должен звучать до launch')
  assert.ok((firearm?.sound.phases.find((phase) => phase.phase === 'launch')?.clipIds.length ?? 0) > 0, 'gunshot должен звучать на launch')
  assert.deepEqual(bludgeon?.sound.phases.find((phase) => phase.phase === 'start')?.clipIds, [], 'дробящий удар не должен получать шумовой cast fallback')
  assert.ok(report.integration.every((check) => check.ok), report.integration.filter((check) => !check.ok).map((check) => check.id).join(', '))
  assert.equal(report.ok, true, report.issues.map((entry) => `${entry.code}: ${entry.message}`).join('\n'))
})

test('аудит не пропускает отсутствующий или пустой sound asset', async () => {
  const report = await auditCombatPresentation({
    manifest: {
      version: 1,
      clips: {
        broken: { url: '/assets/audio/combat/does-not-exist.ogg', durationMs: 0, sourceId: '' },
      },
      profiles: {
        'spell:flame': { cast: ['broken'], impact: ['broken'] },
      },
    },
  })
  assert.equal(report.ok, false)
  assert.ok(report.issues.some((entry) => entry.code === 'audio.file-missing'))
  assert.ok(report.issues.some((entry) => entry.code === 'audio.duration-invalid'))
  assert.ok(report.issues.some((entry) => entry.code === 'audio.source-missing'))
})

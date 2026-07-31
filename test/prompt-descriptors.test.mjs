import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROMPT_DESCRIPTORS,
  availablePromptIds,
  descriptorForPromptId,
  loadedPromptIds,
} from '../server/prompt-descriptors.mjs'

/**
 * Шаг 8 плана `docs/agent-architecture-plan.md`: реестр промптов живёт рядом с
 * реальными загрузчиками и сверяется с ними, а не с чьей-то памятью.
 *
 * До реестра единственным списком ролей был `covered` в `test/security.test.mjs`,
 * и он дважды расходился с кодом при слиянии веток второй волны: ветка поднимала
 * версию промпта, список оставался прежним, сторож молчал.
 */

test('реестр совпадает с тем, что модули действительно читают с диска', () => {
  const loaded = loadedPromptIds()
  const byModule = new Map(PROMPT_DESCRIPTORS.map((descriptor) => [descriptor.module, descriptor.promptId]))

  for (const [module, promptId] of loaded) {
    assert.ok(byModule.has(module),
      `${module} читает ${promptId}, но его нет в реестре — роль появилась мимо PROMPT_DESCRIPTORS`)
    assert.equal(byModule.get(module), promptId,
      `${module}: реестр обещает ${byModule.get(module)}, а модуль читает ${promptId}`)
  }
  for (const descriptor of PROMPT_DESCRIPTORS) {
    if (!descriptor.loads) continue
    assert.ok(loaded.has(descriptor.module),
      `${descriptor.module} объявлен загрузчиком ${descriptor.promptId}, но ничего не читает`)
  }
})

test('каждый промпт реестра существует на диске', () => {
  const available = new Set(availablePromptIds())
  for (const descriptor of PROMPT_DESCRIPTORS) {
    assert.ok(available.has(descriptor.promptId),
      `${descriptor.promptId} объявлен в реестре, но файла нет`)
  }
})

test('старые версии промптов остаются на диске и это не ошибка', () => {
  const available = availablePromptIds()
  const registered = new Set(PROMPT_DESCRIPTORS.map((descriptor) => descriptor.promptId))
  const historical = available.filter((id) => !registered.has(id))
  assert.ok(historical.length > 0,
    'исторические версии нужны для чтения сохранённых трасс — если их снесли, миграция шага 8 станет невозможной')
  for (const id of historical) {
    assert.equal(descriptorForPromptId(id), null, `${id} не должен считаться активным`)
  }
})

test('роли не дублируются и не делят один промпт молча', () => {
  const roles = PROMPT_DESCRIPTORS.map((descriptor) => descriptor.role)
  assert.equal(new Set(roles).size, roles.length, 'роль объявлена дважды')
  const byPrompt = new Map()
  for (const descriptor of PROMPT_DESCRIPTORS) {
    const previous = byPrompt.get(descriptor.promptId)
    assert.equal(previous, undefined,
      `${descriptor.promptId} читают и ${previous?.role}, и ${descriptor.role} — общий промпт должен быть решением, а не совпадением`)
    byPrompt.set(descriptor.promptId, descriptor)
  }
})

test('имя роли Архитектора сцены — единое, без старого AgentCartographer', () => {
  const architect = PROMPT_DESCRIPTORS.find((descriptor) => descriptor.promptId.startsWith('map_architect/'))
  assert.equal(architect?.role, 'scene_architect',
    'после шага 2 роль называется одинаково в коде, трассах и реестре')
})

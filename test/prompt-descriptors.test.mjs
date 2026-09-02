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
  // Модуль может объявлять несколько промптов: у Режиссёра вариант выбирается
  // режимом импровизации кампании. Сверяются наборы целиком, а не одна строка.
  const byModule = new Map()
  for (const descriptor of PROMPT_DESCRIPTORS) {
    byModule.set(descriptor.module, [...(byModule.get(descriptor.module) ?? []), descriptor.promptId].sort())
  }

  for (const [module, promptIds] of loaded) {
    assert.ok(byModule.has(module),
      `${module} читает ${promptIds.join(', ')}, но его нет в реестре — роль появилась мимо PROMPT_DESCRIPTORS`)
    assert.deepEqual([...promptIds].sort(), byModule.get(module),
      `${module}: реестр обещает ${byModule.get(module).join(', ')}, а модуль читает ${[...promptIds].sort().join(', ')}`)
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

test('вариант промпта Режиссёра объявлен на каждый режим импровизации', () => {
  const director = PROMPT_DESCRIPTORS.filter((descriptor) => descriptor.promptId.startsWith('director/'))
  assert.deepEqual(director.map((descriptor) => descriptor.promptId).sort(), ['director/v3_chaos', 'director/v3_story'],
    'режимов импровизации два, и у каждого свой промпт Режиссёра')
  for (const descriptor of director) {
    assert.equal(descriptor.module, 'director-agent.mjs', 'оба варианта грузит один модуль')
  }
  assert.equal(descriptorForPromptId('director/v1'), null,
    'v1 остаётся на диске для чтения сохранённых трасс, но активным больше не считается')
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

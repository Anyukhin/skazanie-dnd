import assert from 'node:assert/strict'

import { normalizePartyDecision } from '../../../../server/party-decision.mjs'
import { classifyPartyDecision } from '../../../../server/party-exit-intent.mjs'
import { proposeAgentInteraction, resolvePartyDecision } from '../../../../server/player-request-router.mjs'

const destination = 'Старая арка у провала после соляных складов и разлома под маяком'
const sourceState = {
  scene: {
    location: 'Смотровая дамба по маршруту от Высокой пристани вдоль соляных складов',
  },
  worldMemory: {
    quests: [{ id: 'quest:main', title: 'Найти следы', status: 'active', visibility: 'party' }],
  },
}

const proposal = proposeAgentInteraction(`Отправляемся в «${destination}»`, sourceState)
assert.equal(proposal?.type, 'vote')
assert.ok(proposal?.options?.length >= 2)
const options = proposal.options.map((label, index) => ({ id: `option-${index + 1}`, label }))
const selected = options[0]
const resolvedState = {
  ...sourceState,
  agentInteraction: {
    id: 'decision-probe',
    type: 'vote',
    status: 'resolved',
    resolvedOptionId: selected.id,
    options,
    destinationLocationId: 'location:old-arc',
  },
}

const resolved = resolvePartyDecision(`[РЕШЕНИЕ ГРУППЫ] ${selected.label}`, resolvedState)
assert.equal(resolved.type, 'scene_request')
assert.equal(resolved.destinationLocationId, 'location:old-arc')
assert.ok(destination.startsWith(resolved.destinationHint), `${resolved.destinationHint} ← ${destination}`)

// Текст после маркера не является источником смысла, когда interaction уже
// разрешён: selectedDecision() читает option по стабильному resolvedOptionId.
const renamedInAction = resolvePartyDecision('[РЕШЕНИЕ ГРУППЫ] Остаться и исследовать дальше', resolvedState)
assert.deepEqual(renamedInAction, resolved, 'action-label changes alone do not change current semantics')

// Изменение сохранённой подписи при том же option ID меняет результат, потому
// что interpretResolvedPartyDecision сейчас классифицирует именно эту подпись.
const renamedInState = resolvePartyDecision('[РЕШЕНИЕ ГРУППЫ] ignored', {
  ...resolvedState,
  agentInteraction: {
    ...resolvedState.agentInteraction,
    options: [{ ...selected, label: 'Остаться и исследовать дальше' }, ...options.slice(1)],
  },
})
assert.equal(renamedInState.type, 'narration')
assert.equal(renamedInState.destinationLocationId, undefined)

// В старых карточках нет семантических метаданных. Текущая защитная правка
// оставляет обрезанное место без hint, сохраняя kind=move.
const truncated = 'Уходим из «Смотровая дамба по маршруту от Высокой пристани вдоль соляных складов» и идём в «Другой п'
assert.deepEqual(classifyPartyDecision(truncated), { kind: 'move', destinationHint: '', abandonsQuest: false })
const legacyResolved = resolvePartyDecision(`[РЕШЕНИЕ ГРУППЫ] ${truncated}`, {
  agentInteraction: {
    id: 'legacy-card', status: 'resolved', resolvedOptionId: 'option-1',
    options: [{ id: 'option-1', label: truncated }],
  },
})
assert.equal(legacyResolved.type, 'scene_request')
assert.equal(legacyResolved.destinationHint, '')

// Верхнеуровневый destination ID уже переживает legacy-путь и позднее
// используется планировщиком сцены; эта проба проверяет только текущий resolver.
const legacyWithId = resolvePartyDecision(`[РЕШЕНИЕ ГРУППЫ] ${truncated}`, {
  agentInteraction: {
    id: 'legacy-card-id', status: 'resolved', resolvedOptionId: 'option-1',
    options: [{ id: 'option-1', label: truncated }],
    destinationLocationId: 'location:other-path',
  },
})
assert.equal(legacyWithId.destinationLocationId, 'location:other-path')

// Текущая нормализация намеренно ограничена id/label. Будущий intent v1 нельзя
// сделать исполнимым, пока этот владелец не начнёт сохранять и проверять его.
const normalized = normalizePartyDecision({
  id: 'metadata-probe',
  options: [{ id: 'go', label: 'Уходим в «Эствуд»', intent: { schemaVersion: 1, kind: 'move' } }],
})
assert.equal(Object.hasOwn(normalized.options[0], 'intent'), false)

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  runtime_commit: 'cb045a8466f35696ff24abe9020d6f39dee89462',
  scope: 'pure current party-decision resolver and normalization; no HTTP, browser, LLM or storage',
  checks: {
    long_label_roundtrip: resolved.destinationHint,
    action_text_rename_keeps_semantics: true,
    persisted_label_rename_changes_semantics: true,
    legacy_truncated_hint: legacyResolved.destinationHint,
    legacy_top_level_destination_id: legacyWithId.destinationLocationId,
    option_intent_currently_preserved: false,
  },
}, null, 2)}\n`)

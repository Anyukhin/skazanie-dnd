// Ключи `Object.prototype` (`constructor`, `toString`, `__proto__`) как id,
// код каталога, навык, тема или вид не находят в таблицах-объектах функцию или
// сам прототип: таблицы читаются по собственному ключу (docs/rust-port-js-findings.md,
// P2 «ключи прототипа»). Rust читает те же входы так же — закреплено тестами крейтов.
import assert from 'node:assert/strict'
import test from 'node:test'

import { suggestedActionsFor } from '../server/action-hints.mjs'
import { serverReputationDelta } from '../server/autonomous-campaign.mjs'
import { beastChronicleEntry, beastStageLabel, isTameableBeast } from '../server/beast-taming.mjs'
import { dialogueCheckLine } from '../server/campaign-dialogues.mjs'
import { phbSpellId, phbToolId } from '../server/character-creation-phb.mjs'
import { damageTypeLabel } from '../server/combat-narration.mjs'
import { tacticLead } from '../server/combat-phrases.mjs'
import { encounterDifficultyLabel } from '../server/encounter-assembler.mjs'
import { itemVisualForCatalogId } from '../server/equipment-visuals.mjs'
import { resolvePresentSocialActors } from '../server/intent-parser.mjs'
import { catalogItem } from '../server/item-catalog.mjs'
import { staticNpcPortrait } from '../server/npc-portraits.mjs'
import { parleyTermsFor } from '../server/parley.mjs'
import { attackForecast, eventSummary } from '../server/rules-engine.mjs'
import { themeFromMapRequest } from '../server/scene-themes.mjs'
import { createTacticalMap } from '../server/tactical-map.mjs'
import { weatherOnDay, worldClockNarration } from '../server/weather.mjs'

const PROTOTYPE_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']

test('каталог, модели и портреты: ключ прототипа — неизвестный код', () => {
  for (const key of PROTOTYPE_KEYS) {
    assert.ok(!catalogItem(key), key)
    assert.equal(itemVisualForCatalogId(key), null, key)
    // Предзаготовленного портрета нет — ролевая картинка с адресом.
    assert.equal(typeof staticNpcPortrait({ id: key, name: 'Марта', role: 'стражник', tags: [] }, 'secondary_npc').url, 'string', key)
  }
})

test('подписи и фразы: ключ прототипа не печатает исходник функции', () => {
  for (const key of PROTOTYPE_KEYS) {
    assert.equal(tacticLead(key), '', key)
    assert.equal(encounterDifficultyLabel(key), 'средний', key)
    assert.equal(damageTypeLabel(key), 'Этот урон', key)
    assert.equal(dialogueCheckLine({ skill: key }), `Проверка «${key}»: провал.`, key)
    assert.equal(beastStageLabel(key), '', key)
    assert.equal(worldClockNarration({ event_type: 'TimeOfDayChanged', payload: { phase_after: key } }), '', key)
    assert.doesNotMatch(eventSummary({ event_type: 'TimeAdvanced', payload: { amount: 2, unit: key } }), /native code|object Object/u, key)
  }
  assert.equal(beastChronicleEntry({ event_type: 'BeastFed', payload: { beast_id: 'b', diet: 'constructor' } }).beast.diet_label, '')
  const loot = suggestedActionsFor({ loot_containers: { containers: [{ id: 'c', name: 'Тело: Волк', kind: 'constructor', item_count: 1, can_inspect: true }] } })
  assert.ok(loot.some((hint) => hint.text === 'Можно обыскать добычу: Волк'), JSON.stringify(loot))
})

test('таблицы правил и создания героя: ключ прототипа не проходит проверку', () => {
  for (const key of PROTOTYPE_KEYS) {
    assert.equal(phbToolId(key), key.replaceAll('-', '_'), key)
    assert.equal(phbSpellId(key), key.replaceAll('_', '-'), key)
    assert.equal(isTameableBeast({ creature_type: 'beast', stat_block_id: key }), false, key)
    assert.equal(serverReputationDelta({ severity: key }), 0, key)
    assert.equal(serverReputationDelta({ outcome: key, severity: key }), 0, key)
    assert.deepEqual(parleyTermsFor({ outcomes: [key] }), [], key)
    assert.notEqual(createTacticalMap({ width: 12, height: 12, sizeClass: key }).sizeClass, key, key)
  }
  // Узор-ключ прототипа — незнакомое слово: тему даёт планировка.
  assert.equal(themeFromMapRequest({ pattern: '__proto__', layout: 'cavern' })?.id, 'cave')
  // Климат-ключ прототипа — веса равнины, а не пустая таблица (вечно ясно).
  const days = Array.from({ length: 9 }, (_, day) => weatherOnDay({ seed: 'weather-seed', day, biome: 'constructor' }))
  assert.ok(days.some((weather) => weather !== 'clear'), days.join(','))
})

test('собеседник с ролью-ключом прототипа не находится по исходнику функции', () => {
  const state = { scene: { location: 'X' }, social: { npcs: [{ id: 'n1', name: 'Пётр', role: 'constructor', location: 'X' }] } }
  assert.deepEqual(resolvePresentSocialActors('function object native code', state), [])
})

test('прогноз удара по врагу с id `__proto__` не падает', () => {
  const state = {
    players: [{ id: 'hero', name: 'Герой', hp: 10, maxHp: 10, ac: 12, attackBonus: 3 }],
    enemies: [{ id: '__proto__', name: 'Тень', hp: 5, maxHp: 5, ac: 10 }],
    mechanics: { conditions: {}, positions: {} },
  }
  assert.doesNotThrow(() => attackForecast(state, 'hero', '__proto__'))
})

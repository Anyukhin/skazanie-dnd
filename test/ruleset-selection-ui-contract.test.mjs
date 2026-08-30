import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const wizard = readFileSync(new URL('../src/CharacterCreationWizard.tsx', import.meta.url), 'utf8')
const inventoryViews = readFileSync(new URL('../src/InventoryViews.tsx', import.meta.url), 'utf8')
const combatActions = readFileSync(new URL('../src/combat-actions.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('мастер мира выбирает ruleset, отправляет его серверу и показывает в итогах', () => {
  assert.match(views, /const \[rulesetId, setRulesetId\].*'dnd_5e_2014'/u)
  assert.match(views, /bootstrap: \{ partyName: partyName\.trim\(\), world, slotCount, rulesetId \}/u)
  assert.match(views, /className="ruleset-picker" role="group" aria-label="Правила кампании"/u)
  assert.match(views, /<dt>Правила<\/dt><dd>\{rulesets\.find/u)
  assert.match(styles, /\.ruleset-picker button\.selected/u)
})

test('настройки читают редакцию кампании, а не выдают global health default за её правила', () => {
  assert.match(views, /campaignAi\?\.ruleset\.current\.id/u)
  assert.match(views, /disabled=\{!campaignAi\?\.ruleset\.canChange \|\| campaignAiBusy\}/u)
  assert.match(views, /campaignAi\?\.ruleset\.current\.label/u)
  assert.match(app, /idempotency_key: globalThis\.crypto\?\.randomUUID/u)
  assert.match(app, /onCampaignRulesetChange=\{\(rulesetId\)/u)
  assert.match(app, /\[state\.sessionCode, state\.state_version, view\]/u)
  assert.match(views, /campaignAiError && <p className="admin-error" role="alert">/u)
})

test('мастер героя загружает отдельный каталог редакции и показывает правила 2014', () => {
  assert.match(app, /getCharacterCreationCatalog\(rulesetId\)/u)
  assert.match(app, /key=\{`\$\{creatingPlayerId\}:\$\{state\.ruleset_id/u)
  assert.match(app, /rulesetId=\{state\.ruleset_id\}/u)
  assert.match(wizard, /D&D 5e 2014\./u)
  assert.match(wizard, /Прибавки расы и подрасы/u)
  assert.match(wizard, /Выборы предыстории/u)
  assert.match(wizard, /bonusSource === 'species'/u)
  assert.match(inventoryViews, /classFeatureCatalogFor\(draft, true, rulesetId\)/u)
  assert.match(combatActions, /classicPassiveFeatureOverrides/u)
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const testRoot = mkdtempSync(join(tmpdir(), 'skazanie-spell-components-ui-'))
const buildDir = join(testRoot, 'build')
mkdirSync(buildDir, { recursive: true })
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/types.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--noCheck', '--noResolve', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--outDir', buildDir, source], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const output = readFileSync(join(buildDir, 'types.js'), 'utf8')
writeFileSync(join(buildDir, 'types.mjs'), output)
const { spellComponentAvailabilityFor, spellComponentsPresentation } = await import(pathToFileURL(join(buildDir, 'types.mjs')).href)
process.on('exit', () => rmSync(testRoot, { recursive: true, force: true }))

test('карточка показывает В, С, М и полное описание материального компонента', () => {
  const presentation = spellComponentsPresentation({
    verbal: true,
    somatic: true,
    material: { description: 'кусочек серы', costGp: 1000, consumed: true, focusSubstitutable: false },
  })
  assert.deepEqual(presentation?.markers, ['В', 'С', 'М'])
  assert.match(presentation?.text ?? '', /^В С М · кусочек серы · .*зм · расходуется$/u)
  assert.match(presentation?.ariaLabel ?? '', /вербальный.*соматический.*материальный/u)
})

test('aria-label компонентов не получает двойную точку из требования источника', () => {
  const presentation = spellComponentsPresentation({
    verbal: false,
    somatic: true,
    material: { description: 'серебряная проволока.', costGp: null, consumed: false, focusSubstitutable: false, requirementNote: 'Нужна для ритуала.' },
  })
  assert.equal(presentation?.ariaLabel.includes('..'), false)
  assert.match(presentation?.ariaLabel ?? '', /серебряная проволока.*Нужна для ритуала\.$/u)
})

test('материал с фокусом и нулевая стоимость читаются без ложной блокировки', () => {
  const presentation = spellComponentsPresentation({
    verbal: false,
    somatic: true,
    material: { description: 'веточка омелы', costGp: 0, consumed: false, focusSubstitutable: true },
  })
  assert.deepEqual(presentation?.markers, ['С', 'М'])
  assert.match(presentation?.materialText ?? '', /веточка омелы.*0 зм.*можно заменить фокусом/u)
  assert.deepEqual(spellComponentAvailabilityFor({}), { blocked: false, reason: null })
  assert.deepEqual(spellComponentAvailabilityFor({ componentAvailability: { available: true } }), { blocked: false, reason: null })
})

test('неподтверждённый материал не обещает замену фокусом', () => {
  const presentation = spellComponentsPresentation({
    verbal: false,
    somatic: false,
    material: { description: 'редкий порошок', costGp: null, consumed: true, focusSubstitutable: true, unresolved: true, requirementNote: 'Требуется особый порошок из источника.' },
  })
  assert.match(presentation?.text ?? '', /редкий порошок.*Требуется особый порошок/u)
  assert.doesNotMatch(presentation?.text ?? '', / · расходуется/u)
  assert.doesNotMatch(presentation?.text ?? '', /фокусом/u)
})

test('авторские отчисления показываются отдельным компонентом А', () => {
  const presentation = spellComponentsPresentation({
    verbal: false,
    somatic: false,
    material: null,
    special: [{ kind: 'royalty', description: 'плата правообладателю при каждом использовании' }],
  })
  assert.deepEqual(presentation?.markers, ['А'])
  assert.equal(presentation?.specialText, 'Авторские отчисления: плата правообладателю при каждом использовании')
  assert.match(presentation?.text ?? '', /^А · Авторские отчисления:/u)
  assert.match(presentation?.ariaLabel ?? '', /авторские отчисления/u)
})

test('клиент блокирует заклинание только при явном решении сервера', () => {
  assert.deepEqual(spellComponentAvailabilityFor({ componentAvailability: { available: false, code: 'MISSING_FOCUS', reason: 'Нужен хрустальный шар' } }), {
    blocked: true,
    reason: 'Нужен хрустальный шар',
  })
  assert.deepEqual(spellComponentAvailabilityFor({ componentAvailability: { available: false } }), {
    blocked: true,
    reason: 'Недоступны необходимые компоненты заклинания',
  })
})

test('компоненты встроены в существующие карточки и не создают кнопку «Применить»', () => {
  const dungeonMap = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  const combatSpells = readFileSync(new URL('../src/combat-spells.ts', import.meta.url), 'utf8')
  assert.match(dungeonMap, /export function SpellComponentsLine/u)
  assert.match(dungeonMap, /<SpellComponentsLine spell=\{spell\} compact \/>/u)
  assert.match(dungeonMap, /<SpellComponentsLine spell=\{spell\} \/>/u)
  assert.match(dungeonMap, /<SpellComponentsLine spell=\{selectedSpell\} \/>/u)
  assert.match(dungeonMap, /spellbook-availability/u)
  assert.match(dungeonMap, /spell-component-lock/u)
  assert.match(dungeonMap, /aria-describedby=\{componentAvailability\.blocked \? componentReasonId : undefined\}/u)
  assert.match(dungeonMap, /disabled=\{support\.blocked \|\| spell\.actionType === 'long_cast'/u)
  assert.match(dungeonMap, /Недоступно:/u)
  assert.match(dungeonMap, /fallback\?\.components && !spell\.components/u)
  assert.match(dungeonMap, /componentAvailability\.blocked/u)
  assert.doesNotMatch(dungeonMap, /Применить/u)
  assert.match(combatSpells, /componentAvailability: _catalogAvailability/u)
  assert.match(combatSpells, /componentAvailability: _overrideAvailability/u)
  assert.match(combatSpells, /rulesetId = 'srd_5_2_1'/u)
  assert.match(combatSpells, /sourceBackedComponents = rulesetId === 'dnd_5e_2014'/u)
  assert.match(dungeonMap, /fallbackCombatSpells\(activeHero, state\.ruleset_id\)/u)
  const inventory = readFileSync(new URL('../src/InventoryViews.tsx', import.meta.url), 'utf8')
  assert.match(inventory, /fallbackCombatSpells\(draft, rulesetId\)/u)
})

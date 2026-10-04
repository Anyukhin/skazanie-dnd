import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-combat-icon-mapping-'))
test.after(() => rmSync(buildDir, { recursive: true, force: true }))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = [
  fileURLToPath(new URL('../src/CombatIcon.tsx', import.meta.url)),
  fileURLToPath(new URL('../src/action-icons.ts', import.meta.url)),
]
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--jsx', 'react-jsx', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
writeFileSync(join(buildDir, 'ui-runtime.mjs'), [
  'export const jsx = () => null',
  'export const jsxs = () => null',
  'export const useEffect = () => {}',
  'export const useRef = (value) => ({ current: value })',
  'export const useState = (value) => [value, () => {}]',
  '',
].join('\n'))
for (const name of readdirSync(buildDir).filter((entry) => entry.endsWith('.js'))) {
  const source = readFileSync(join(buildDir, name), 'utf8')
    .replace(/(from\s+["'])(\.\/[^"']+)(["'])/gu, '$1$2.mjs$3')
    .replace(/from (["'])react(?:\/jsx-runtime)?\1/gu, 'from "./ui-runtime.mjs"')
  writeFileSync(join(buildDir, name.replace(/\.js$/u, '.mjs')), source)
}
const icon = await import(pathToFileURL(join(buildDir, 'CombatIcon.mjs')).href)

test('служебные IDs получают свой HUD-рисунок, а динамические команды не сталкиваются', () => {
  assert.equal(icon.hudIconUrl('end-turn', 'end-turn'), '/assets/ui/hud-icons/end-turn.png')
  assert.equal(icon.hudIconUrl('movement', 'movement'), '/assets/ui/hud-icons/movement.png')
  assert.equal(icon.hudIconUrl('common-movement-command', 'movement'), '/assets/ui/hud-icons/movement.png')
  assert.equal(icon.hudIconUrl('scene-object-inspect', 'spellbook'), '/assets/ui/hud-icons/interact.png')
  assert.equal(icon.hudIconUrl('swap-rapier', 'swap'), '/assets/ui/hud-icons/swap-weapons.png')
  assert.equal(icon.hudIconUrl('door-lockpick-east', 'action'), '/assets/ui/hud-icons/lockpick.png')
  assert.equal(icon.hudIconUrl('propose-parley', 'action'), '/assets/ui/hud-icons/parley.png')
  assert.equal(icon.hudIconUrl('level-transition-up', 'swap'), null)
  assert.equal(icon.hudIconUrl('constructor', 'action'), null)
  assert.equal(icon.hudIconUrl('__proto__', 'action'), null)
  assert.equal(new Set(Object.values(icon.HUD_ICON_ASSET_IDS)).size, Object.keys(icon.HUD_ICON_ASSET_IDS).length)
})

test('индивидуальный action PNG имеет приоритет над HUD и неизвестный ID остаётся атласом', () => {
  assert.equal(icon.combatIconArtworkUrl('fireball', 'spell'), '/assets/ui/action-icons/fireball.png')
  assert.equal(icon.combatIconArtworkUrl('movement', 'movement'), '/assets/ui/hud-icons/movement.png')
  assert.equal(icon.combatIconArtworkUrl('homebrew-action', 'action'), null)
  assert.equal(icon.ownIconUrl('enervation-repeat'), '/assets/ui/action-icons/enervation.png')
})

test('reaction cast IDs reuse canonical spell artwork without widening the asset path', () => {
  assert.equal(icon.iconAssetIdFor('cast:shield'), 'shield')
  assert.equal(icon.ownIconUrl('cast:shield'), '/assets/ui/action-icons/shield.png')
  assert.equal(icon.iconAssetIdFor('cast:counterspell'), 'counterspell')
  assert.equal(icon.ownIconUrl('cast:counterspell'), '/assets/ui/action-icons/counterspell.png')
  assert.equal(icon.ownIconUrl('cast:unknown-spell'), null)
  assert.equal(icon.iconAssetIdFor('cast:../../shield'), 'cast:../../shield')
  assert.equal(icon.ownIconUrl('cast:../../shield'), null)
})

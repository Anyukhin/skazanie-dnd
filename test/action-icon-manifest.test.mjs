import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { iconIdsOnDisk, manifestIsCurrent, manifestSource } from '../tools/build-icon-manifest.mjs'

const manifestPath = new URL('../src/action-icons.ts', import.meta.url)
const iconDirectory = new URL('../public/assets/ui/action-icons/', import.meta.url)
const rightsSource = new URL('../data/asset-rights.json', import.meta.url)
const componentSource = readFileSync(new URL('../src/CombatIcon.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('манифест иконок не отстал от каталога', () => {
  // Картинку легко положить и забыть пересобрать список — тогда она молча не
  // покажется. Тест ловит это, а не полагается на память.
  assert.equal(manifestIsCurrent(), true, 'запусти pnpm icons:manifest — список разошёлся с public/assets/ui/action-icons')
})

test('в манифесте только те идентификаторы, под которые есть файлы', () => {
  const ids = iconIdsOnDisk()
  const source = readFileSync(manifestPath, 'utf8')
  assert.ok(ids.length > 0, 'хотя бы один рисунок должен быть')
  for (const id of ids) assert.ok(source.includes(`'${id}',`), `${id} отсутствует в манифесте`)
  // Обратная сторона: в списке нет того, чего нет на диске.
  const listed = [...source.matchAll(/^\s{2}'([^']+)',$/gmu)].map((match) => match[1])
  assert.deepEqual(listed, ids, 'состав манифеста должен совпадать с каталогом')
})

test('идентификаторы рисунков совпадают с идентификаторами движка', async () => {
  const { combatActionsFor } = await import('../server/combat-actions.mjs')
  const spells = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8')).spells
  const available = new Set(iconIdsOnDisk())
  const known = new Set(spells.map((spell) => String(spell.id)))
  for (const characterClass of ['fighter', 'rogue', 'wizard', 'cleric', 'druid', 'paladin', 'ranger', 'barbarian', 'bard', 'monk', 'sorcerer', 'warlock']) {
    for (const action of combatActionsFor({ characterClass, level: 12, abilities: {} })) known.add(String(action.id))
  }
  // Иначе рисунок никогда не найдётся: компонент ищет строго по идентификатору.
  for (const id of available) assert.ok(known.has(id), `рисунок ${id}.png не соответствует ни одному действию или заклинанию`)
  for (const id of known) assert.ok(available.has(id), `${id}: у каждого заклинания и доступного игроку действия должен быть свой PNG`)
})

test('каждая action-icon имеет уникальное содержимое и зарегистрированный хеш', () => {
  const rights = JSON.parse(readFileSync(rightsSource, 'utf8'))
  const declaredRights = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  const contentOwners = new Map()
  for (const id of iconIdsOnDisk()) {
    const bytes = readFileSync(new URL(`${id}.png`, iconDirectory))
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${id}: нужен PNG`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const relative = `ui/action-icons/${id}.png`
    const tuple = declaredRights.get(relative)
    assert.ok(tuple, `${relative}: права не зарегистрированы`)
    assert.equal(tuple[1], hash, `${relative}: хеш разошёлся с реестром прав`)
    assert.equal(tuple[2], bytes.length, `${relative}: размер разошёлся с реестром прав`)
    const owners = contentOwners.get(hash) ?? []
    owners.push(id)
    contentOwners.set(hash, owners)
  }
  const duplicates = [...contentOwners.values()].filter((owners) => owners.length > 1)
  assert.deepEqual(duplicates, [], 'каждому действию и заклинанию нужен собственный рисунок, а не байтовая копия')
  assert.equal(contentOwners.size, iconIdsOnDisk().length)
})

test('компонент берёт свой рисунок, а атлас остаётся запасным', () => {
  assert.ok(componentSource.includes('ACTION_ICON_IDS'), 'компонент обязан читать манифест')
  assert.ok(componentSource.includes('combat-icon-art own'), 'для своего рисунка нужен отдельный класс')
  assert.ok(componentSource.includes('--combat-icon-x'), 'запасной вариант через атлас должен остаться')
  assert.ok(styles.includes('.combat-icon-art.own'), 'стиль для своего рисунка должен существовать')
  assert.ok(styles.includes('background-size: contain'), 'своя картинка вписывается целиком, а не режется как клетка атласа')
  assert.ok(componentSource.includes('abilityIconBackgroundUrl(theme)'), 'свой рисунок обязан получить тематический фон')
  assert.ok(componentSource.includes('combat-icon-symbol'), 'символ и фон должны оставаться отдельными слоями')
  assert.ok(styles.includes('var(--combat-icon-bg)'), 'фоновая плитка должна отрисовываться из переменной компонента')
})

test('манифест собирается детерминированно и отсортирован', () => {
  const ids = iconIdsOnDisk()
  assert.deepEqual([...ids].sort(), ids, 'список должен быть отсортирован — иначе дифф скачет')
  assert.equal(manifestSource(ids), manifestSource(ids))
})

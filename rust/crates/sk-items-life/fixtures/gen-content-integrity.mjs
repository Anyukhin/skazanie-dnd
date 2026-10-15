import '../../../fixtures-env.mjs'
// Эталон content-integrity для Rust: отчёт по настоящему корню проекта и по
// маленькому корню-шаблону (копия файлов происхождения, пакетов правил и
// каталогов, три синтетических ассета), а затем — по сотне испорченных копий
// шаблона: убранное поле, задвоенный id, сломанная ссылка, чужой тип значения.
//
//   node rust/crates/sk-items-life/fixtures/gen-content-integrity.mjs
//
// Пишет content-integrity.json рядом с собой. Правка — список операций:
//   { op: 'json', file, path, action: 'set' | 'delete' | 'push', value }
//   { op: 'write', file, text }        — файл целиком
//   { op: 'remove', file }             — удалить файл
//   { op: 'replace', file, from, to }  — первая подстрока в тексте
// JSON пишется `JSON.stringify(x, null, 2)`. После правок (если у случая нет
// `seal: false`) хеши и размеры артефактов content-provenance пересчитываются
// — иначе любая правка каталога упиралась бы в CONTENT_HASH_MISMATCH. Rust
// повторяет те же шаги и сверяет исход.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyContentIntegrity, verifyDeclaredArtifact } from '../../../../server/content-integrity.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const projectRoot = resolve(here('.'), '../../../..')
const readText = (file) => readFileSync(join(projectRoot, file), 'utf8')
const readJsonFile = (file) => JSON.parse(readText(file))

const provenance = readJsonFile('data/content-provenance.json')
const realRegistry = readJsonFile('data/asset-rights.json')

// --- шаблон ---------------------------------------------------------------
const ASSET_FILES = {
  'public/assets/a.txt': 'alpha\n',
  'public/assets/sub/b.txt': 'bravo bravo\n',
  'public/assets/sub/deep/c.txt': 'charlie\n',
}
const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const registry = {
  ...realRegistry,
  assets: Object.entries(ASSET_FILES).map(([path, text]) => [path.slice('public/assets/'.length), sha(text), Buffer.byteLength(text)]),
}
const copy = [...new Set([...provenance.artifacts.map((artifact) => artifact.path), 'data/content-provenance.json', 'data/rules-coverage-matrix.json', 'ATTRIBUTION.md'])]
const write = { ...ASSET_FILES, 'data/asset-rights.json': `${JSON.stringify(registry, null, 2)}\n` }
const template = { copy, write }

const workRoot = join(tmpdir(), `sk-items-life-content-integrity-${process.pid}`)
rmSync(workRoot, { recursive: true, force: true })
function buildTemplate() {
  for (const file of copy) {
    mkdirSync(dirname(join(workRoot, file)), { recursive: true })
    copyFileSync(join(projectRoot, file), join(workRoot, file))
  }
  for (const [file, text] of Object.entries(write)) {
    mkdirSync(dirname(join(workRoot, file)), { recursive: true })
    writeFileSync(join(workRoot, file), text)
  }
}
buildTemplate()

// --- правки ---------------------------------------------------------------
function setAt(target, path, action, value) {
  let node = target
  for (const key of path.slice(0, -1)) node = node[key]
  const last = path.at(-1)
  if (action === 'set') node[last] = value
  else if (action === 'delete') {
    if (Array.isArray(node)) node.splice(last, 1)
    else delete node[last]
  } else if (action === 'push') node[last].push(value)
  else throw new Error(`unknown action ${action}`)
}

function applyOps(ops) {
  for (const op of ops) {
    const file = join(workRoot, op.file)
    if (op.op === 'json') {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      setAt(value, op.path, op.action, op.value)
      writeFileSync(file, JSON.stringify(value, null, 2))
    } else if (op.op === 'write') {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, op.text)
    } else if (op.op === 'remove') rmSync(file, { recursive: true, force: true })
    else if (op.op === 'replace') {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(op.from)) throw new Error(`replace: нет «${op.from}» в ${op.file}`)
      writeFileSync(file, text.replace(op.from, op.to))
    } else throw new Error(`unknown op ${op.op}`)
  }
}

/** Пересчёт sha256/size_bytes артефактов, файлы которых есть на диске. */
function seal() {
  const file = join(workRoot, 'data/content-provenance.json')
  let value
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.artifacts)) return
  let changed = false
  for (const artifact of value.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || typeof artifact.path !== 'string') continue
    const target = join(workRoot, artifact.path)
    if (!existsSync(target) || !statSync(target).isFile()) continue
    const bytes = readFileSync(target)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (artifact.sha256 !== hash || artifact.size_bytes !== bytes.length) {
      artifact.sha256 = hash
      artifact.size_bytes = bytes.length
      changed = true
    }
  }
  if (changed) writeFileSync(file, JSON.stringify(value, null, 2))
}

const clean = (text) => String(text).split(workRoot).join('<root>').split(projectRoot).join('<project>').replaceAll('\\', '/')
const DETAIL_KEYS = ['path', 'expected', 'actual', 'undeclared', 'missing', 'unknown', 'problems']

function errorJson(error) {
  if (error?.name === 'ContentIntegrityError') {
    const details = {}
    for (const key of DETAIL_KEYS) if (key in error) details[key] = error[key]
    const message = error.code === 'CONTENT_MANIFEST_INVALID' ? clean(error.message.split(': ')[0]) : clean(error.message)
    return { name: error.name, code: error.code, message, details: JSON.parse(JSON.stringify(details)) }
  }
  if (error?.name === 'RulePackValidationError') return { name: error.name, message: clean(error.message) }
  if (error instanceof TypeError) return { name: 'TypeError' }
  return { name: 'Error', code: error?.code ?? null }
}

async function outcome(run) {
  try {
    return { ok: JSON.parse(JSON.stringify(await run())) }
  } catch (error) {
    return { error: errorJson(error) }
  }
}

// --- случаи ---------------------------------------------------------------
const P = 'data/content-provenance.json'
const R = 'data/asset-rights.json'
const SPELLS = 'data/dndsu-spells-0-6.json'
const OVERRIDES = 'data/dndsu-spell-mechanics-overrides.json'
const ACTIONS = 'data/dndsu-class-actions-1-12.json'
const BUILD = 'data/dndsu-class-build-rules-1-12.json'
const STARTER = 'data/starter-equipment-dnd-5e-2014.json'
const BACKGROUNDS = 'data/backgrounds-dnd-5e-2014.json'
const MATRIX = 'data/rules-coverage-matrix.json'
const SRD = 'data/rule_packs/srd_5_2_1'
const PHB = 'data/rule_packs/dnd_5e_2014'
const json = (file, path, action, value) => ({ op: 'json', file, path, action, ...(value === undefined ? {} : { value }) })
const set = (file, path, value) => json(file, path, 'set', value)
const del = (file, path) => json(file, path, 'delete')
const push = (file, path, value) => json(file, path, 'push', value)

const cases = []
const add = (name, ops, extra = {}) => cases.push({ name, ops, ...extra })

add('шаблон без правок', [])

// Происхождение: артефакты, источники, блокеры.
const artifactCount = provenance.artifacts.length
for (const index of [0, 3, 11, artifactCount - 1]) {
  const a = ['artifacts', index]
  add(`артефакт ${index}: нулевой хеш`, [set(P, [...a, 'sha256'], '0'.repeat(64))], { seal: false })
  add(`артефакт ${index}: хеш не hex`, [set(P, [...a, 'sha256'], 'XYZ')], { seal: false })
  add(`артефакт ${index}: хеш в верхнем регистре`, [set(P, [...a, 'sha256'], 'A'.repeat(64))], { seal: false })
  add(`артефакт ${index}: без хеша`, [del(P, [...a, 'sha256'])], { seal: false })
  add(`артефакт ${index}: размер +1`, [set(P, [...a, 'size_bytes'], provenance.artifacts[index].size_bytes + 1)], { seal: false })
  add(`артефакт ${index}: размер строкой`, [set(P, [...a, 'size_bytes'], String(provenance.artifacts[index].size_bytes))], { seal: false })
  add(`артефакт ${index}: размер -1`, [set(P, [...a, 'size_bytes'], -1)], { seal: false })
  add(`артефакт ${index}: размер дробный`, [set(P, [...a, 'size_bytes'], 1.5)], { seal: false })
  add(`артефакт ${index}: без размера`, [del(P, [...a, 'size_bytes'])], { seal: false })
  add(`артефакт ${index}: неизвестный статус прав`, [set(P, [...a, 'rights_status'], 'bogus')])
  add(`артефакт ${index}: без статуса прав`, [del(P, [...a, 'rights_status'])])
  add(`артефакт ${index}: права verified`, [set(P, [...a, 'rights_status'], 'verified')])
  add(`артефакт ${index}: права cleared`, [set(P, [...a, 'rights_status'], 'cleared')])
  add(`артефакт ${index}: права blocked`, [set(P, [...a, 'rights_status'], 'blocked')])
  add(`артефакт ${index}: неизвестный источник`, [set(P, [...a, 'source_id'], 'nowhere')])
  add(`артефакт ${index}: без источника`, [del(P, [...a, 'source_id'])])
}
const a0 = ['artifacts', 0]
const firstPath = provenance.artifacts[0].path
for (const [label, value] of [
  ['выход вверх', '../outside.json'],
  ['выход вверх в середине', 'data/../../outside.json'],
  ['абсолютный', '/etc/passwd'],
  ['пустой', ''],
  ['обратные слэши вверх', 'data\\..\\..\\x'],
  ['обратные слэши внутри', firstPath.replaceAll('/', '\\')],
  ['точка в пути', firstPath.replace('data/', 'data/./')],
  ['двойной слэш', firstPath.replace('data/', 'data//')],
  ['имя с двумя точками', '..foo'],
  ['точка', '.'],
  ['точка-слэш', './'],
  ['нет файла', 'data/missing.json'],
  ['каталог', 'data/rule_packs'],
  ['число', 5],
  ['null', null],
  ['массив пути', [firstPath]],
  ['массив из двух', ['data', 'x']],
  ['объект', { a: 1 }],
]) add(`путь артефакта: ${label}`, [set(P, [...a0, 'path'], value)])
add('путь артефакта убран', [del(P, [...a0, 'path'])])
add('артефакт null', [set(P, a0, null)])
add('артефакт строкой', [set(P, a0, 'str')])
add('артефакт числом', [set(P, a0, 5)])
add('артефакт массивом', [set(P, a0, [1, 2])])
add('артефакт строкой при источнике без id', [push(P, ['external_sources'], { label: 'x' }), set(P, a0, 'str')])
add('артефакт массивом при источнике без id', [push(P, ['external_sources'], {}), set(P, a0, [])])
add('без источников', [del(P, ['external_sources'])])
add('источники null', [set(P, ['external_sources'], null)])
add('источники объектом', [set(P, ['external_sources'], {})])
add('источники строкой', [set(P, ['external_sources'], 'ab')])
add('источник null', [set(P, ['external_sources', 0], null)])
add('источник id числом', [set(P, ['external_sources', 0, 'id'], 7)])
add('без артефактов', [del(P, ['artifacts'])])
add('артефакты пустые', [set(P, ['artifacts'], [])])
add('артефакты строкой', [set(P, ['artifacts'], 'ab')])
add('артефакты объектом', [set(P, ['artifacts'], {})])
add('артефакты числом', [set(P, ['artifacts'], 5)])
add('артефакт задвоен', [push(P, ['artifacts'], provenance.artifacts[0])])
add('без блокеров', [del(P, ['release_blockers'])])
add('блокеры null', [set(P, ['release_blockers'], null)])
add('блокеры с повтором', [set(P, ['release_blockers'], ['Z', 'A', 'A', 'RIGHTS:public/assets'])])
add('блокеры строкой', [set(P, ['release_blockers'], 'ba')])
add('блокеры числами', [set(P, ['release_blockers'], [3, 'B', 1, 20, 'a'])])
add('блокеры объектом', [set(P, ['release_blockers'], {})])
add('блокеры с null', [set(P, ['release_blockers'], [null, 'X', true])])
add('все права verified', provenance.artifacts.map((_, index) => set(P, ['artifacts', index, 'rights_status'], 'verified')))
add('происхождение — не JSON', [{ op: 'write', file: P, text: '{ not json' }])
add('происхождение — пусто', [{ op: 'write', file: P, text: '' }])
add('происхождение удалено', [{ op: 'remove', file: P }])
add('происхождение null', [{ op: 'write', file: P, text: 'null' }])
add('происхождение число', [{ op: 'write', file: P, text: '5' }])
add('происхождение массив', [{ op: 'write', file: P, text: '[]' }])
add('происхождение с BOM', [{ op: 'write', file: P, text: `﻿${readText(P)}` }])
add('файл артефакта удалён', [{ op: 'remove', file: provenance.artifacts[2].path }])
add('файл артефакта изменён без пересчёта', [{ op: 'replace', file: `${SRD}/manifest.yaml`, from: 'ruleset_id', to: 'ruleset_id' }, { op: 'write', file: `${SRD}/manifest.yaml`, text: `${readText(`${SRD}/manifest.yaml`)}# x\n` }], { seal: false })

// Реестр ассетов.
add('реестр: схема 2', [set(R, ['schema_version'], 2)])
add('реестр: схема строкой', [set(R, ['schema_version'], '1')])
add('реестр: схема 1.0', [{ op: 'replace', file: R, from: '"schema_version": 1', to: '"schema_version": 1.0' }])
add('реестр: другой корень', [set(R, ['assets_root'], 'public/other')])
add('реестр: ассеты объектом', [set(R, ['assets'], {})])
add('реестр: запись из двух', [set(R, ['assets', 0], registry.assets[0].slice(0, 2))])
add('реестр: запись из четырёх', [set(R, ['assets', 0], [...registry.assets[0], 1])])
add('реестр: запись объектом', [set(R, ['assets', 0], { path: 'a.txt' })])
add('реестр: запись null', [set(R, ['assets', 0], null)])
add('реестр: задвоенная запись', [push(R, ['assets'], registry.assets[1])])
add('реестр: хеш не совпал', [set(R, ['assets', 1, 1], 'f'.repeat(64))])
add('реестр: хеш не hex', [set(R, ['assets', 1, 1], 'nope')])
add('реестр: размер не совпал', [set(R, ['assets', 2, 2], 3)])
add('реестр: размер null', [set(R, ['assets', 2, 2], null)])
add('реестр: файл удалён', [{ op: 'remove', file: 'public/assets/sub/b.txt' }])
add('реестр: лишний файл', [{ op: 'write', file: 'public/assets/sub/extra.txt', text: 'x' }])
add('реестр: лишние файлы по-разному', [{ op: 'write', file: 'public/assets/Z.txt', text: 'x' }, { op: 'write', file: 'public/assets/_.txt', text: 'x' }, { op: 'write', file: 'public/assets/ё.txt', text: 'x' }])
add('реестр: запись убрана', [del(R, ['assets', 0])])
add('реестр: все записи убраны', [set(R, ['assets'], [])])
add('реестр: путь числом', [set(R, ['assets', 0, 0], 5)])
add('реестр: путь выходит вверх', [set(R, ['assets', 0, 0], '../../ATTRIBUTION.md')])
add('реестр: права verified и раздача allowed', [set(R, ['rights_status'], 'verified'), set(R, ['distribution'], 'allowed')])
add('реестр: права cleared и раздача blocked', [set(R, ['rights_status'], 'cleared')])
add('реестр: раздача allowed', [set(R, ['distribution'], 'allowed')])
add('реестр: права bogus', [set(R, ['rights_status'], 'bogus')])
add('реестр: права bogus без ассетов', [set(R, ['rights_status'], 'bogus'), set(R, ['assets'], []), { op: 'remove', file: 'public/assets' }, { op: 'write', file: 'public/assets/.keep', text: '' }, set(R, ['assets'], [['.keep', sha(''), 0]])])
add('реестр: каталог ассетов удалён', [set(R, ['assets'], []), { op: 'remove', file: 'public/assets' }])
add('реестр null', [{ op: 'write', file: R, text: 'null' }])
add('реестр строкой', [{ op: 'write', file: R, text: '"x"' }])
add('реестр удалён', [{ op: 'remove', file: R }])

// Пакеты правил (после правки хеши пересчитываются).
const srdRules = readText(`${SRD}/rules.jsonl`)
const firstRuleLine = srdRules.split('\n')[0]
add('SRD: правило убрано', [{ op: 'replace', file: `${SRD}/rules.jsonl`, from: `${firstRuleLine}\n`, to: '' }])
add('SRD: счёт deterministic', [{ op: 'replace', file: `${SRD}/coverage.yaml`, from: 'deterministic_rule_count: 16', to: 'deterministic_rule_count: 15' }])
add('SRD: счёт structured строкой', [{ op: 'replace', file: `${SRD}/coverage.yaml`, from: 'structured_rule_count: 7', to: 'structured_rule_count: seven' }])
add('SRD: счёт retrieval_only убран', [{ op: 'replace', file: `${SRD}/coverage.yaml`, from: 'retrieval_only_rule_count: 0\n', to: '' }])
add('SRD: манифест удалён', [{ op: 'remove', file: `${SRD}/manifest.yaml` }], { seal: false })
add('SRD: пакет удалён', [{ op: 'remove', file: SRD }], { seal: false })
const firstRule = JSON.parse(firstRuleLine)
const glossaryLines = readText(`${SRD}/glossary.csv`).split('\n')
const referencedTerm = firstRule.entity_refs?.[0]
const referencedLine = glossaryLines.find((line) => line.startsWith(`${referencedTerm},`))
if (referencedLine) {
  add('SRD: термин из ссылок убран', [
    { op: 'replace', file: `${SRD}/glossary.csv`, from: `${referencedLine}\n`, to: '' },
    { op: 'replace', file: `${SRD}/coverage.yaml`, from: 'glossary_term_count: 25', to: 'glossary_term_count: 24' },
  ])
}
add('SRD: ссылка на несуществующий термин', [{ op: 'replace', file: `${SRD}/rules.jsonl`, from: `"${referencedTerm}"`, to: '"term:nowhere"' }])
const phbRules = readText(`${PHB}/rules.jsonl`)
const phbFirst = JSON.parse(phbRules.split('\n')[0])
add('2014: ссылка на несуществующий термин', [{ op: 'replace', file: `${PHB}/rules.jsonl`, from: `"${phbFirst.entity_refs?.[0]}"`, to: '"term:nowhere"' }])
const phbCoverage = readText(`${PHB}/coverage.yaml`)
const phbDet = phbCoverage.match(/deterministic_rule_count: (\d+)/u)
if (phbDet) add('2014: счёт deterministic', [{ op: 'replace', file: `${PHB}/coverage.yaml`, from: phbDet[0], to: `deterministic_rule_count: ${Number(phbDet[1]) + 2}` }])
add('2014: манифест удалён', [{ op: 'remove', file: `${PHB}/manifest.yaml` }], { seal: false })

// Каталоги совместимости.
const spells = readJsonFile(SPELLS)
const actions = readJsonFile(ACTIONS)
const build = readJsonFile(BUILD)
add('заклинания: count не совпал', [set(SPELLS, ['count'], spells.count + 1)])
add('заклинания: count убран', [del(SPELLS, ['count'])])
add('заклинания: заклинание убрано', [del(SPELLS, ['spells', 5])])
add('заклинания: неизвестный класс', [push(SPELLS, ['spells', 0, 'classes'], 'bard2')])
add('заклинания: классы null', [set(SPELLS, ['spells', 0, 'classes'], null)])
add('заклинания: классы строкой', [set(SPELLS, ['spells', 0, 'classes'], 'xy')])
add('заклинания: классы объектом', [set(SPELLS, ['spells', 0, 'classes'], {})])
add('заклинания: чужой источник', [set(SPELLS, ['spells', 1, 'sourceUrl'], 'http://evil.example/')])
add('заклинания: источник убран', [del(SPELLS, ['spells', 1, 'sourceUrl'])])
add('заклинания: источник массивом', [set(SPELLS, ['spells', 1, 'sourceUrl'], ['https://www.dnd.su/x'])])
add('заклинания: источник без www', [set(SPELLS, ['spells', 1, 'sourceUrl'], 'https://dnd.su/spells/1/')])
add('заклинания: массив объектом', [set(SPELLS, ['spells'], {})])
add('заклинания: заклинание null', [set(SPELLS, ['spells', 0], null)])
add('заклинания: id задвоен', [set(SPELLS, ['spells', 1, 'id'], spells.spells[0].id)])
add('заклинания: id убран', [del(SPELLS, ['spells', 1, 'id'])])
add('заклинания: больше 20 замечаний', Array.from({ length: 25 }, (_, index) => set(SPELLS, ['spells', index, 'classes'], [`x${index}`])))
add('заклинания: файл не JSON', [{ op: 'write', file: SPELLS, text: '{' }])
add('заклинания: null', [{ op: 'write', file: SPELLS, text: 'null' }])
const overrideIds = Object.keys(readJsonFile(OVERRIDES).spells)
add('override: неизвестное заклинание', [set(OVERRIDES, ['spells', 'no-such-spell'], {})])
add('override: убран список', [del(OVERRIDES, ['spells'])])
add('override: список строкой', [set(OVERRIDES, ['spells'], 'abc')])
add('override: список массивом', [set(OVERRIDES, ['spells'], [1])])
add('override: список числом', [set(OVERRIDES, ['spells'], 5)])
add('override: ключ constructor', [set(OVERRIDES, ['spells', 'constructor'], {})])
add('override: убран один', [del(OVERRIDES, ['spells', overrideIds[0]])])
add('действия: чужой класс действия', [set(ACTIONS, ['classes', 0, 'actions', 0, 'classKey'], 'bard')])
add('действия: classKey действия убран', [del(ACTIONS, ['classes', 1, 'actions', 0, 'classKey'])])
add('действия: действия строкой', [set(ACTIONS, ['classes', 0, 'actions'], 'ab')])
add('действия: действия убраны', [del(ACTIONS, ['classes', 0, 'actions'])])
add('действия: действия пустые', [set(ACTIONS, ['classes', 0, 'actions'], [])])
add('действия: действие null', [set(ACTIONS, ['classes', 0, 'actions', 0], null)])
add('действия: подклассы объектом', [set(ACTIONS, ['classes', 0, 'subclasses'], {})])
add('действия: подклассы строкой', [set(ACTIONS, ['classes', 0, 'subclasses'], 'abc')])
add('действия: подклассы убраны', [del(ACTIONS, ['classes', 0, 'subclasses'])])
add('действия: подкласс убран', [del(ACTIONS, ['classes', 2, 'subclasses', 0])])
add('действия: класс убран', [del(ACTIONS, ['classes', 11])])
add('действия: классы объектом', [set(ACTIONS, ['classes'], {})])
add('действия: класс null', [set(ACTIONS, ['classes', 3], null)])
add('действия: classKey класса переименован', [set(ACTIONS, ['classes', 4, 'classKey'], 'knight')])
add('сборка: класс убран', [del(BUILD, ['classes', 0])])
add('сборка: лишний класс', [push(BUILD, ['classes'], { classKey: 'knight' })])
add('сборка: классы пустые', [set(BUILD, ['classes'], [])])
add('сборка: классы строкой', [set(BUILD, ['classes'], 'x')])
add('сборка: класс null', [set(BUILD, ['classes', 0], null)])
add('сборка: classKey убран', [del(BUILD, ['classes', 0, 'classKey'])])
void build

// Каталоги создания героя.
const starter = readJsonFile(STARTER)
const backgrounds = readJsonFile(BACKGROUNDS)
const bgWithItem = backgrounds.backgrounds.findIndex((entry) => entry.equipment?.catalogItems?.length)
const choiceProfile = starter.classes.findIndex((profile) => profile.choice_groups?.some((group) => group.options?.length > 1))
const choiceGroup = starter.classes[choiceProfile].choice_groups.findIndex((group) => group.options?.length > 1)
const cg = ['classes', choiceProfile, 'choice_groups', choiceGroup]
add('стартовое: схема 1', [set(STARTER, ['schema_version'], 1)])
add('стартовое: политика 3', [set(STARTER, ['policy_version'], 3)])
add('стартовое: редакция srd', [set(STARTER, ['ruleset_id'], 'srd_5_2_1')])
add('стартовое: класс убран', [del(STARTER, ['classes', 11])])
add('стартовое: классы убраны', [del(STARTER, ['classes'])])
add('стартовое: классы null', [set(STARTER, ['classes'], null)])
add('стартовое: классы строкой из 12', [set(STARTER, ['classes'], 'abcdefghijkl')])
add('стартовое: классы объектом', [set(STARTER, ['classes'], {})])
add('стартовое: класс задвоен', [set(STARTER, ['classes', 1, 'class_id'], starter.classes[0].class_id)])
add('стартовое: класс null', [set(STARTER, ['classes', 2], null)])
add('стартовое: прежний предмет неизвестен', [set(STARTER, ['classes', 0, 'legacy_default_items', 0, 'catalog_id'], 'srd_5_2_1:laser')])
add('стартовое: прежний предмет constructor', [set(STARTER, ['classes', 0, 'legacy_default_items', 0, 'catalog_id'], 'constructor')])
add('стартовое: прежний предмет toString', [set(STARTER, ['classes', 0, 'legacy_default_items', 0, 'catalog_id'], 'toString')])
add('стартовое: прежний предмет __proto__', [set(STARTER, ['classes', 0, 'legacy_default_items', 0, 'catalog_id'], '__proto__')])
add('стартовое: прежний предмет hasOwnProperty', [set(STARTER, ['classes', 0, 'legacy_default_items', 0, 'catalog_id'], 'hasOwnProperty')])
add('стартовое: прежний предмет без id', [del(STARTER, ['classes', 0, 'legacy_default_items', 0, 'catalog_id'])])
add('стартовое: прежний предмет id массивом', [set(STARTER, ['classes', 0, 'legacy_default_items', 0, 'catalog_id'], [starter.classes[0].legacy_default_items[0].catalog_id])])
add('стартовое: прежний предмет null', [set(STARTER, ['classes', 0, 'legacy_default_items', 0], null)])
add('стартовое: прежние предметы объектом', [set(STARTER, ['classes', 0, 'legacy_default_items'], {})])
add('стартовое: постоянный предмет неизвестен', [set(STARTER, ['classes', 0, 'fixed_items', 0, 'catalog_id'], 'srd_5_2_1:laser')])
add('стартовое: постоянные предметы убраны', [del(STARTER, ['classes', 0, 'fixed_items'])])
add('стартовое: группа без id', [del(STARTER, [...cg, 'id'])])
add('стартовое: группа id пустой', [set(STARTER, [...cg, 'id'], '')])
add('стартовое: группа задвоена', [set(STARTER, [...cg, 'id'], starter.classes[choiceProfile].choice_groups[choiceGroup === 0 ? 1 : 0].id)])
add('стартовое: группа без вариантов', [set(STARTER, [...cg, 'options'], [])])
add('стартовое: варианты убраны', [del(STARTER, [...cg, 'options'])])
add('стартовое: варианты объектом', [set(STARTER, [...cg, 'options'], {})])
add('стартовое: варианты строкой', [set(STARTER, [...cg, 'options'], 'ab')])
add('стартовое: счёт больше вариантов', [set(STARTER, [...cg, 'count'], 9)])
add('стартовое: счёт строкой', [set(STARTER, [...cg, 'count'], 'x')])
add('стартовое: счёт null', [set(STARTER, [...cg, 'count'], null)])
add('стартовое: вариант задвоен', [set(STARTER, [...cg, 'options', 1, 'id'], starter.classes[choiceProfile].choice_groups[choiceGroup].options[0].id)])
add('стартовое: вариант без id', [del(STARTER, [...cg, 'options', 0, 'id'])])
add('стартовое: вариант null', [set(STARTER, [...cg, 'options', 0], null)])
add('стартовое: предмет варианта неизвестен', [set(STARTER, [...cg, 'options', 0, 'items', 0, 'catalog_id'], 'nope')])
add('стартовое: предметы варианта убраны', [del(STARTER, [...cg, 'options', 0, 'items'])])
add('стартовое: группы объектом', [set(STARTER, ['classes', 0, 'choice_groups'], {})])
add('стартовое: группа null', [set(STARTER, [...cg], null)])
add('стартовое: null', [{ op: 'write', file: STARTER, text: 'null' }])
add('стартовое: удалено', [{ op: 'remove', file: STARTER }], { seal: false })
add('предыстории: неизвестный предмет', [set(BACKGROUNDS, ['backgrounds', bgWithItem, 'equipment', 'catalogItems', 0, 'catalogId'], 'nope')])
add('предыстории: предмет constructor', [set(BACKGROUNDS, ['backgrounds', bgWithItem, 'equipment', 'catalogItems', 0, 'catalogId'], 'constructor')])
add('предыстории: снаряжение убрано', [del(BACKGROUNDS, ['backgrounds', bgWithItem, 'equipment'])])
add('предыстории: снаряжение null', [set(BACKGROUNDS, ['backgrounds', bgWithItem, 'equipment'], null)])
add('предыстории: предметы объектом', [set(BACKGROUNDS, ['backgrounds', bgWithItem, 'equipment', 'catalogItems'], {})])
add('предыстории: предыстория null', [set(BACKGROUNDS, ['backgrounds', 0], null)])
add('предыстории: список убран', [del(BACKGROUNDS, ['backgrounds'])])
add('предыстории: null', [{ op: 'write', file: BACKGROUNDS, text: 'null' }])
add('много замечаний создания героя', [set(STARTER, ['schema_version'], 1), set(STARTER, ['classes', 0, 'fixed_items', 0, 'catalog_id'], 'a'), set(BACKGROUNDS, ['backgrounds', bgWithItem, 'equipment', 'catalogItems', 0, 'catalogId'], 'b')])

// Матрица покрытия.
const matrix = readJsonFile(MATRIX)
const featsIndex = matrix.categories.findIndex((category) => category.id === 'feats')
add('матрица: схема 2', [set(MATRIX, ['schema_version'], 2)])
add('матрица: категории объектом', [set(MATRIX, ['categories'], {})])
add('матрица: категории пустые', [set(MATRIX, ['categories'], [])])
add('матрица: категория задвоена', [push(MATRIX, ['categories'], matrix.categories[0])])
add('матрица: категория без id', [del(MATRIX, ['categories', 1, 'id'])])
add('матрица: категория null', [set(MATRIX, ['categories', 1], null)])
add('матрица: покрытие bogus', [set(MATRIX, ['categories', 2, 'coverage'], 'bogus')])
add('матрица: неизвестная категория', [set(MATRIX, ['categories', 2, 'id'], 'unknown_cat')])
for (const key of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) add(`матрица: категория ${key}`, [set(MATRIX, ['categories', 2, 'id'], key)])
add('матрица: категория id числом', [set(MATRIX, ['categories', 2, 'id'], 7)])
add('матрица: счёт не совпал', [set(MATRIX, ['categories', 4, 'expected_count'], 144)])
add('матрица: счёт строкой', [set(MATRIX, ['categories', 4, 'expected_count'], '145')])
add('матрица: счёт убран', [del(MATRIX, ['categories', 4, 'expected_count'])])
add('матрица: черты complete', [set(MATRIX, ['categories', featsIndex, 'coverage'], 'complete')])
add('матрица: черты не обязательны', [set(MATRIX, ['categories', featsIndex, 'mandatory_for_release'], false)])
add('матрица: обязательность строкой', [set(MATRIX, ['categories', 0, 'mandatory_for_release'], 'true')])
add('матрица: все complete', matrix.categories.map((_, index) => set(MATRIX, ['categories', index, 'coverage'], 'complete')))
add('матрица: категория убрана', [del(MATRIX, ['categories', 0])])
add('матрица: null', [{ op: 'write', file: MATRIX, text: 'null' }])
add('матрица: удалена', [{ op: 'remove', file: MATRIX }])
add('подклассы NaN доходят до матрицы', [set(ACTIONS, ['classes', 0, 'subclasses'], { a: 1 })])

// Атрибуция.
const attribution = readText('ATTRIBUTION.md')
for (const notice of ['System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC', '5e14.dnd.su', 'data/rule_packs/dnd_5e_2014']) {
  if (attribution.includes(notice)) add(`атрибуция без «${notice.slice(0, 20)}»`, [{ op: 'write', file: 'ATTRIBUTION.md', text: attribution.split(notice).join('') }])
}
add('атрибуция пустая', [{ op: 'write', file: 'ATTRIBUTION.md', text: '' }])
add('атрибуция удалена', [{ op: 'remove', file: 'ATTRIBUTION.md' }])

// --- прогон ---------------------------------------------------------------
const results = []
for (const testCase of cases) {
  applyOps(testCase.ops)
  if (testCase.seal !== false) seal()
  results.push({ ...testCase, outcome: await outcome(() => verifyContentIntegrity({ rootDir: workRoot })) })
  rmSync(workRoot, { recursive: true, force: true })
  buildTemplate()
}

// verifyDeclaredArtifact напрямую: тот же шаблон, разные объявления.
const firstArtifact = provenance.artifacts[0]
const declared = []
for (const artifact of [
  firstArtifact,
  { ...firstArtifact, rights_status: 'verified' },
  { ...firstArtifact, sha256: '0'.repeat(64) },
  { ...firstArtifact, size_bytes: 0 },
  { ...firstArtifact, size_bytes: Number.MAX_SAFE_INTEGER + 1 },
  { ...firstArtifact, path: 'data/nope' },
  { path: 'ATTRIBUTION.md' },
  { path: 'public/assets/a.txt', sha256: sha('alpha\n'), size_bytes: 6, rights_status: 'review_required' },
  { path: 'public/assets/a.txt', sha256: sha('alpha\n'), size_bytes: 6 },
  { path: 'public/assets/a.txt', sha256: [sha('alpha\n')], size_bytes: 6, rights_status: 'verified' },
  { path: 'public/assets/a.txt', sha256: sha('alpha\n'), size_bytes: '6', rights_status: 'verified' },
  { path: 'public/assets/a.txt', sha256: sha('alpha\n'), size_bytes: true, rights_status: 'verified' },
  null,
  [],
  'path',
  5,
  {},
  { path: '' },
  { path: '../x' },
  { path: 'a/../b' },
  { path: '...' },
  { path: '.../x' },
  { path: 'public\\assets\\a.txt', sha256: sha('alpha\n'), size_bytes: 6, rights_status: 'verified' },
]) declared.push({ artifact, outcome: await outcome(() => verifyDeclaredArtifact(workRoot, artifact)) })
rmSync(workRoot, { recursive: true, force: true })

// Настоящий корень проекта и сторож из test/content-integrity.test.mjs.
const real = await outcome(() => verifyContentIntegrity())
const changedRules = await outcome(() => verifyDeclaredArtifact(projectRoot, { path: 'data/rule_packs/srd_5_2_1/rules.jsonl', sha256: '0'.repeat(64), size_bytes: 29517, rights_status: 'verified' }))

writeFileSync(here('content-integrity.json'), `${JSON.stringify({ template, cases: results, declared, real, changed_rules: changedRules }, null, 1)}\n`)
console.log(`content-integrity: ${results.length} случаев, ${declared.length} объявлений`)

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalCombatSpellFor } from './combat-spells.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CATALOG_PATH = 'data/dndsu-spells-0-6.json'
const OVERRIDES_PATH = 'data/dndsu-spell-mechanics-overrides.json'
export const SPELL_ACCEPTANCE_BASELINE = '9277df04985856208f2bfd1590a5916c60b3ef82'
export const SPELL_ACCEPTANCE_DIMENSIONS = Object.freeze(['rules', 'playerPath', 'resilience', 'permissions', 'presentation'])
const SUPPORT_STATUSES = new Set(['verified', 'partial', 'heuristic', 'ruling-only'])
const BLOCKED_STATUSES = new Set(['heuristic', 'ruling-only'])
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const CATALOG_IDS = new Set(JSON.parse(read(CATALOG_PATH)).spells.map((spell) => spell.id))
const countBy = (entries, select) => entries.reduce((counts, entry) => {
  const key = select(entry)
  counts[key] = (counts[key] ?? 0) + 1
  return counts
}, {})

// Это очередь проверки четырёх пилотов, а не второй каталог заклинаний.
// Наличие требования или сценария никогда не означает пройденную приёмку.
const PILOTS = {
  longstrider: {
    publication: 'Legacy Basic Rules (2014), p. 256',
    reviewReferences: [{ url: 'https://www.dndbeyond.com/spells/2171-longstrider', scope: 'rule-description' }],
    remainder: 'Не подтверждены эффективная скорость маршрута и Рывка, клиентский предпросмотр, час игровых минут в бою и после перехода в исследование.',
    dependencies: ['timed-speed-modifier', 'upcast-targets', 'effect-source-identity', 'world-time-expiry'],
    choices: ['цели касанием', 'источник и круг ячейки', 'дополнительные цели при усилении'],
    lifecycle: ['наложение', 'движение и Рывок', 'бой → исследование', 'истечение часа', 'снятие конкретного источника'],
    scenarios: [
      ['speed-and-dash', 'rules', '+10 футов изменяют допустимый маршрут и Рывок; иконка без изменения движения недостаточна.'],
      ['touch-and-upcast', 'rules', 'Касание каждой цели, дополнительные цели по кругу; отказ до расхода при лишней или далёкой цели.'],
      ['hour-and-sources', 'rules', 'Час игровых минут, переход бой/исследование, повторное наложение и несколько источников без сложения одинакового эффекта.'],
    ],
  },
  'mass-cure-wounds': {
    publication: 'Legacy Basic Rules (2014), p. 258',
    reviewReferences: [{ url: 'https://www.dndbeyond.com/spells/2181-mass-cure-wounds', scope: 'rule-description' }],
    remainder: 'Нужны точка и выбранное подмножество до шести целей, 3к8 с усилением, исключения по типам существ; текущая общая карточка этого не доказывает.',
    dependencies: ['point-and-selected-targets', 'healing-upcast', 'creature-type-filter', 'zero-hp-lifecycle'],
    choices: ['точка в пределах дальности', 'до шести существ вокруг точки', 'источник и круг ячейки'],
    lifecycle: ['проверка точки и всех целей', 'однократное лечение и расход', 'обновление ОЗ и состояний'],
    scenarios: [
      ['point-and-six-targets', 'rules', 'Точка в пределах 60 футов, до шести выбранных существ в радиусе 30 футов; усиление не увеличивает их число.'],
      ['healing-and-types', 'rules', '3к8 + модификатор, +1к8 за круг выше пятого, предел максимума ОЗ, исключение нежити и конструктов, состояние при 0 ОЗ.'],
      ['select-targets-on-site', 'playerPath', 'Обычный игрок выбирает точку и получателей с разными ID даже при одинаковых именах, отменяет и подтверждает выбор.'],
    ],
  },
  'protection-from-energy': {
    publication: 'Legacy Basic Rules (2014)',
    reviewReferences: [{ url: 'https://www.dndbeyond.com/spells/2220-protection-from-energy', scope: 'rule-description' }],
    remainder: 'Нужны настоящее сопротивление выбранному типу, серверное согласие цели, концентрация и час действия; маркер преимущества спасброска не заменяет сопротивление урону.',
    dependencies: ['typed-resistance', 'concentration', 'effect-source-identity', 'world-time-expiry', 'willing-target-policy'],
    choices: ['согласная цель касанием', 'кислота / холод / огонь / электричество / звук', 'источник ячейки'],
    lifecycle: ['получение согласия', 'наложение', 'смешанный урон', 'срыв концентрации', 'истечение часа', 'снятие конкретного эффекта'],
    scenarios: [
      ['selected-resistance', 'rules', 'Сопротивление выбранному типу; другой и смешанный урон, пересечение с другими источниками сопротивления и иммунитетом.'],
      ['concentration-and-expiry', 'rules', 'Концентрация до часа; прекращение снимает только соответствующий экземпляр защиты.'],
      ['willing-player', 'permissions', 'Согласие другого игрока определяется серверной политикой; произвольное клиентское поле согласие не подтверждает.'],
    ],
  },
  'destructive-wave': {
    publication: 'PH14 по карточке 5e14.dnd.su; полный официальный текст независимо не подтверждён',
    reviewReferences: [
      { url: 'https://5e14.dnd.su/spells/296-destructive-wave/', scope: 'project-source-description' },
      { url: 'https://www.dndbeyond.com/spells/class/4-paladin', scope: 'catalog-only' },
    ],
    remainder: 'Нужны выбранные цели, спасбросок, две составляющие урона и падение при провале; законный доступ героя до 12-го уровня требует проверки прогрессии домена Бури.',
    dependencies: ['selected-area-targets', 'mixed-damage', 'saving-throw', 'condition-immunity', 'zero-hp-lifecycle', 'legal-spell-acquisition'],
    choices: ['выбранные существа в пределах 30 футов', 'излучение или некротическая энергия', 'допустимый источник магии'],
    lifecycle: ['выбор и проверка целей', 'спасбросок каждой цели', 'два типа урона', 'падение только при провале', 'однократная фиксация выбытия'],
    scenarios: [
      ['mixed-save-and-prone', 'rules', 'Спасбросок Телосложения: 5к6 звуком + 5к6 выбранным типом, половина при успехе; ничком только при провале с учётом иммунитета.'],
      ['mixed-resistance-and-death', 'rules', 'Раздельные сопротивления к двум составляющим, выбранные цели, одно выбытие при последовательных компонентах урона.'],
      ['legal-level-twelve-path', 'playerPath', 'Получение заклинания допустимым способом при ограничении героя 12-м уровнем; административная выдача этого не доказывает.'],
    ],
  },
}

const COMMON_SCENARIOS = [
  ['source-and-exceptions', 'rules', 'Сверить принятую редакцию, публикацию, исключения и все ветки конкретной карточки; профиль сам по себе не подтверждает правило.'],
  ['refusal-before-spending', 'rules', 'Недопустимая цель, дальность, видимость, компоненты, ресурс и экономика хода отклоняются до расхода.'],
  ['normal-acquisition-and-cast', 'playerPath', 'Получение/изучение, подготовка, компоненты и применение обычным игроком через основной HTTP/UI-путь.'],
  ['replay-restart-idempotency', 'resilience', 'Тот же результат после replay/restart, повтор запроса без второго расхода, конфликт версии и совместимость старых событий.'],
  ['ownership-and-projection', 'permissions', 'Владение, членство, недоверенные поля и скрытые цели; два игрока видят только разрешённое.'],
  ['two-player-2d-3d-av', 'presentation', 'Ручной основной сценарий с двумя игроками: 2D/3D, отмена, подтверждённый эффект, анимация и звук без раскрытия скрытого.'],
]

/** История нужна только аудиту; runtime и публикационный экспорт от Git не зависят. */
export function readSpellAcceptanceBaseline(repositoryRoot = ROOT) {
  try {
    const git = (path) => execFileSync('git', ['show', `${SPELL_ACCEPTANCE_BASELINE}:${path}`], {
      cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    })
    const catalogText = git(CATALOG_PATH)
    const overridesText = git(OVERRIDES_PATH)
    const catalog = JSON.parse(catalogText)
    const overrides = JSON.parse(overridesText).spells ?? {}
    // Значение зафиксировано семантикой загрузчика исходной контрольной точки.
    const statuses = Object.fromEntries(catalog.spells.map(({ id }) => [id,
      overrides[id]?.mechanicsSupport ?? (overrides[id] ? 'partial' : 'heuristic'),
    ]))
    return {
      status: 'available', commit: SPELL_ACCEPTANCE_BASELINE, statuses,
      catalogSha256: sha256(catalogText), overridesSha256: sha256(overridesText),
    }
  } catch {
    return {
      status: 'unavailable', commit: SPELL_ACCEPTANCE_BASELINE, statuses: null,
      reason: 'В этой копии нет исходного коммита: поимённые исходные группы не подтверждены. Аудит текущего каталога доступен.',
    }
  }
}

function currentRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch { return null }
}

function workingTreeSnapshot(revision) {
  if (!revision) return null
  try {
    const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
    const diff = git(['diff', '--no-ext-diff', '--binary', 'HEAD'])
    const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean).sort()
    return sha256(JSON.stringify({ revision, diffSha256: sha256(diff), untracked: untracked.map((path) => [path, sha256(readFileSync(join(ROOT, path)))]) }))
  } catch { return null }
}

function dependencyCandidates(spell) {
  return [...new Set([
    'spell-acquisition', 'target-validation', 'resource-selection', 'component-contract',
    ...(spell.concentration ? ['concentration'] : []),
    ...(spell.actionType === 'long_cast' ? ['long-casting-phases'] : []),
    ...(spell.radius ? ['area-geometry'] : []),
    ...(spell.kind === 'healing' ? ['healing-and-target-types'] : []),
    ...(spell.kind === 'summon' ? ['summon-lifecycle'] : []),
    ...(spell.conditions?.length ? ['condition-lifecycle'] : []),
  ])]
}

/** Схема аудита не принимает заявления о готовности без привязанных доказательств. */
export function validateSpellAcceptanceReport(report) {
  const problems = []
  const add = (id, code, message) => problems.push({ id, code, message })
  if (report?.schemaVersion !== 'spell-acceptance/v1' || !Array.isArray(report?.spells)) {
    return [{ id: null, code: 'INVALID_SCHEMA', message: 'Ожидается spell-acceptance/v1 с массивом spells.' }]
  }
  if (!['available', 'unavailable'].includes(report.baseline?.status) || report.baseline?.commit !== SPELL_ACCEPTANCE_BASELINE) add(null, 'INVALID_BASELINE', 'Нужна исходная ревизия и явная доступность истории.')
  const ids = new Set()
  for (const card of report.spells) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      add(null, 'INVALID_CARD', 'Паспорт должен быть объектом.')
      continue
    }
    const id = card?.spellId
    if (typeof id !== 'string' || !id || ids.has(id)) add(id, 'INVALID_SPELL_ID', 'ID должен быть непустым и уникальным.')
    ids.add(id)
    if (!CATALOG_IDS.has(id)) add(id, 'UNKNOWN_SPELL_ID', 'ID отсутствует в рабочем каталоге.')
    if (!Number.isInteger(card.level) || card.level < 0 || card.level > 6 || typeof card.name !== 'string' || !card.name) add(id, 'INVALID_IDENTITY', 'Нужны название и круг от 0 до 6.')
    if (!SUPPORT_STATUSES.has(card?.availability?.supportStatus)) add(id, 'INVALID_SUPPORT_STATUS', 'Неизвестный статус доступности.')
    if (card?.availability?.blocked !== BLOCKED_STATUSES.has(card?.availability?.supportStatus)) add(id, 'AVAILABILITY_MISMATCH', 'Блокировка расходится с контрактом каталога.')
    const initial = card?.baseline?.supportStatus
    if (initial !== null && !SUPPORT_STATUSES.has(initial)) add(id, 'INVALID_BASELINE_STATUS', 'Недопустимая исходная группа.')
    const expectedGroup = initial == null ? null : BLOCKED_STATUSES.has(initial) ? 'blocked' : initial
    if (card?.baseline?.group !== expectedGroup) add(id, 'BASELINE_GROUP_MISMATCH', 'Исходная группа расходится с исходным статусом.')
    if (report.baseline?.status === 'unavailable' && initial !== null) add(id, 'UNPROVEN_BASELINE', 'Без истории нельзя восстановить исходный статус из текущего.')
    if (!/^[a-f0-9]{64}$/u.test(card?.source?.cardSha256 ?? '') || card?.source?.rulesetId !== 'dnd_5e_2014') add(id, 'INVALID_SOURCE', 'Нужны хеш исходной карточки и закреплённый ruleset.')
    if (!['inventory-only', 'pilot-draft', 'reviewed'].includes(card?.specification?.status)) add(id, 'INVALID_SPECIFICATION', 'Неизвестный уровень спецификации.')
    if (!Array.isArray(card?.remaining) || !card.remaining.length || !Array.isArray(card?.dependencies?.items) || !card.dependencies.items.length) add(id, 'MISSING_REMAINDER', 'Нужны остаток и зависимости, включая ещё не проверенные.')
    const scenarios = Array.isArray(card?.scenarios) ? card.scenarios : []
    const requiredScenarios = [...COMMON_SCENARIOS, ...(PILOTS[id]?.scenarios ?? [])]
    for (const [requiredId, requiredDimension] of requiredScenarios) {
      const scenario = scenarios.find((candidate) => candidate?.id === requiredId)
      if (!scenario || scenario.dimension !== requiredDimension) add(id, 'MISSING_REQUIRED_SCENARIO', `Обязательный сценарий ${requiredId} нельзя удалить или перенести в другое измерение.`)
      else if (scenario.status === 'not-applicable') add(id, 'REQUIRED_SCENARIO_NOT_APPLICABLE', `Обязательный сценарий ${requiredId} нельзя исключить из приёмки.`)
    }
    const scenarioIds = new Set()
    for (const scenario of scenarios) {
      if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
        add(id, 'INVALID_SCENARIO', 'Сценарий должен быть объектом.')
        continue
      }
      if (!scenario?.id || scenarioIds.has(scenario.id) || !SPELL_ACCEPTANCE_DIMENSIONS.includes(scenario.dimension) || !scenario.description) add(id, 'INVALID_SCENARIO', 'У сценария нужны уникальный ID, измерение и описание.')
      scenarioIds.add(scenario.id)
      if (!['pending', 'passed', 'not-applicable'].includes(scenario.status)) add(id, 'INVALID_SCENARIO_STATUS', 'Неизвестный статус сценария.')
      if (scenario.status === 'not-applicable' && !scenario.reason) add(id, 'MISSING_NOT_APPLICABLE_REASON', 'Неприменимость требует объяснения для конкретного ID.')
      if (!Array.isArray(scenario.evidence)) add(id, 'INVALID_EVIDENCE', 'Доказательства должны быть массивом.')
      if (scenario.status === 'passed' && !scenario.evidence?.length) add(id, 'UNPROVEN_SCENARIO', 'Пройденный сценарий требует доказательств.')
      for (const evidence of Array.isArray(scenario.evidence) ? scenario.evidence : []) {
        if (!evidence || !['test-run', 'manual-run'].includes(evidence.kind) || !evidence.reference || !Number.isFinite(Date.parse(evidence.observedAt)) || !report.workingTreeSha256 || evidence.treeSha256 !== report.workingTreeSha256) add(id, 'INVALID_EVIDENCE', 'Нужны вид, ссылка, дата и совпадающий хеш проверенного дерева.')
      }
    }
    for (const dimension of SPELL_ACCEPTANCE_DIMENSIONS) {
      const relevant = scenarios.filter((scenario) => scenario?.dimension === dimension)
      const actual = card?.readiness?.[dimension]
      const expected = relevant.length && relevant.every((scenario) => ['passed', 'not-applicable'].includes(scenario.status)) ? 'verified' : 'pending'
      if (!relevant.length || actual !== expected) add(id, 'READINESS_MISMATCH', `Измерение ${dimension} не подтверждено сценариями.`)
    }
    const allVerified = SPELL_ACCEPTANCE_DIMENSIONS.every((dimension) => card?.readiness?.[dimension] === 'verified')
    if (card?.accepted !== allVerified || (card?.accepted && (card.availability?.blocked || card.specification?.status !== 'reviewed' || card.specification?.individuallyReviewed !== true || !card.source?.publication || !card.source?.acceptedRevision))) add(id, 'UNPROVEN_ACCEPTANCE', 'Полная приёмка требует всех измерений, поимённой спецификации, публикации, сверенной ревизии и доступного пути.')
  }
  if (report.spells.length !== 439 || ids.size !== 439) add(null, 'CATALOG_SCOPE_MISMATCH', 'Эта очередь приёмки охватывает ровно 439 уникальных ID кругов 0–6.')
  const accepted = report.spells.filter((card) => card?.accepted === true).length
  if (report.summary?.accepted !== accepted || report.summary?.catalog !== report.spells.length) add(null, 'SUMMARY_MISMATCH', 'Сводка должна считаться из паспортов, а не задаваться вручную.')
  return problems
}

/** Read-only проекция единственного рабочего каталога. Проверку игры этот отчёт не заменяет. */
export function auditSpellAcceptance({ baseline = readSpellAcceptanceBaseline() } = {}) {
  const catalogText = read(CATALOG_PATH)
  const catalog = JSON.parse(catalogText)
  const fingerprints = Object.fromEntries([
    CATALOG_PATH, OVERRIDES_PATH, 'server/combat-spells.mjs', 'server/rules-engine.mjs',
    'data/rule_packs/dnd_5e_2014/manifest.yaml', 'server/spell-acceptance-audit.mjs',
  ].map((path) => [path, sha256(read(path))]))
  const spells = catalog.spells.map((raw) => {
    const spell = canonicalCombatSpellFor(raw.id, { rulesetId: 'dnd_5e_2014' })
    const pilot = PILOTS[raw.id]
    const initialStatus = baseline.statuses?.[raw.id] ?? null
    const componentDependencies = [
      ...(spell.components?.material?.unresolved ? ['unresolved-material-requirement'] : []),
      ...(spell.components?.special?.some((component) => component.kind === 'royalty') ? ['royalty-payment'] : []),
    ]
    return {
      spellId: raw.id, name: spell.name, englishName: spell.englishName, level: spell.level,
      baseline: { supportStatus: initialStatus, group: initialStatus == null ? null : BLOCKED_STATUSES.has(initialStatus) ? 'blocked' : initialStatus },
      availability: { supportStatus: spell.mechanicsSupport, blocked: BLOCKED_STATUSES.has(spell.mechanicsSupport), actorEligibilityChecked: false },
      source: {
        rulesetId: 'dnd_5e_2014', url: raw.sourceUrl, publication: pilot?.publication ?? null, acceptedRevision: null,
        reviewReferences: pilot?.reviewReferences ?? [],
        cardSha256: sha256(JSON.stringify(raw)), runtimeCardSha256: sha256(JSON.stringify(spell)),
        note: 'Хеш фиксирует локальный текст; редакция публикации и исключения требуют поимённой сверки. Правила профиля не доказывают происхождение каждой карточки.',
      },
      implementation: {
        owner: 'server/rules-engine.mjs', command: 'CastSpell', catalogOwner: 'server/combat-spells.mjs', kind: spell.kind, supportNote: spell.supportNote ?? null, executionVerified: false,
        profile: Object.fromEntries(['target', 'range', 'radius', 'damage', 'healing', 'saveAbility', 'maxTargets', 'concentration', 'durationRounds', 'actionType'].map((field) => [field, spell[field] ?? null])),
      },
      specification: { status: pilot ? 'pilot-draft' : 'inventory-only', individuallyReviewed: false, detailedReference: pilot ? 'docs/spell-pilot-acceptance.md' : null },
      dependencies: { status: pilot ? 'planned' : 'candidates', items: [...new Set([...(pilot?.dependencies ?? dependencyCandidates(spell)), ...componentDependencies])] },
      componentRequirements: structuredClone(spell.components ?? null),
      choices: { status: pilot ? 'planned' : 'unreviewed', items: pilot?.choices ?? [] },
      lifecycle: { status: pilot ? 'planned' : 'unreviewed', stages: pilot?.lifecycle ?? [] },
      remaining: [
        ...(spell.supportNote ? [spell.supportNote] : []),
        ...(pilot?.remainder ? [pilot.remainder] : []),
        ...(BLOCKED_STATUSES.has(spell.mechanicsSupport) ? ['Применение заблокировано; наличие вида карточки не подтверждает обработчик конкретного эффекта.'] : []),
        pilot ? 'Индивидуальные сценарии пилота ещё требуют доказательств по окончательному дереву.' : 'Поимённая спецификация остатка и опасных взаимодействий ещё не проведена; общие кандидаты не заменяют её.',
      ],
      scenarios: [...COMMON_SCENARIOS, ...(pilot?.scenarios ?? [])].map(([id, dimension, description]) => ({ id, dimension, description, status: 'pending', evidence: [] })),
      readiness: Object.fromEntries(SPELL_ACCEPTANCE_DIMENSIONS.map((dimension) => [dimension, 'pending'])),
      accepted: false,
    }
  })
  const { statuses, ...baselineInfo } = baseline
  const initialCounts = statuses ? countBy(Object.values(statuses), (status) => status) : null
  const revision = currentRevision()
  const unresolvedMaterial = spells.filter((spell) => spell.componentRequirements?.material?.unresolved).map((spell) => ({ spellId: spell.spellId, ...spell.componentRequirements.material }))
  const royalties = spells.filter((spell) => spell.componentRequirements?.special?.some((component) => component.kind === 'royalty')).map((spell) => ({ spellId: spell.spellId, requirements: spell.componentRequirements.special.filter((component) => component.kind === 'royalty') }))
  const report = {
    schemaVersion: 'spell-acceptance/v1', auditScope: 'inventory-and-checklist', revision, workingTreeSha256: workingTreeSnapshot(revision), fingerprints,
    baseline: { ...baselineInfo, counts: initialCounts, expectedCounts: { heuristic: 191, 'ruling-only': 8, partial: 240 } },
    summary: {
      catalog: spells.length, support: countBy(spells, (spell) => spell.availability.supportStatus),
      initialGroups: countBy(spells, (spell) => spell.baseline.group ?? 'unavailable'),
      blocked: spells.filter((spell) => spell.availability.blocked).length,
      accepted: spells.filter((spell) => spell.accepted).length,
      specifications: countBy(spells, (spell) => spell.specification.status),
      components: { material: spells.filter((spell) => spell.componentRequirements?.material).length, unresolvedMaterialIds: unresolvedMaterial.map((entry) => entry.spellId), royaltyIds: royalties.map((entry) => entry.spellId) },
    },
    componentGaps: { unresolvedMaterial, royalties },
    warnings: baseline.status === 'unavailable' ? [baseline.reason] : [],
    spells,
  }
  const problems = validateSpellAcceptanceReport(report)
  if (statuses && (Object.keys(statuses).length !== 439 || initialCounts.heuristic !== 191 || initialCounts['ruling-only'] !== 8 || initialCounts.partial !== 240)) {
    problems.push({ id: null, code: 'BASELINE_COUNTS_MISMATCH', message: 'Исходная ревизия не подтверждает группы 191 heuristic, 8 ruling-only, 240 partial.' })
  }
  if (statuses && spells.some((spell) => !Object.hasOwn(statuses, spell.spellId))) problems.push({ id: null, code: 'BASELINE_IDS_MISMATCH', message: 'Набор текущих ID расходится с исходной ревизией.' })
  return { ok: problems.length === 0, ...report, problems }
}

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-spell-effects-'))
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['src/spell-effects.ts', 'src/combat-animation.ts', 'src/area-geometry.ts', 'src/tactical-map-client.ts', 'src/board-render.ts']
  .map((relative) => join(repositoryRoot, relative))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--resolveJsonModule', '--esModuleInterop',
  '--rootDir', repositoryRoot, '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)

function emittedFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? emittedFiles(path) : [path]
  })
}

for (const path of emittedFiles(buildDir).filter((candidate) => candidate.endsWith('.js'))) {
  const rewritten = readFileSync(path, 'utf8')
    .replace(/(from\s+["'])(\.\.?\/[^"']+\.json)(["'])/gu, '$1$2$3 with { type: "json" }')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => (
      specifier.endsWith('.json') || specifier.endsWith('.mjs') || specifier.endsWith('.js')
        ? match
        : `${before}${specifier}.mjs${after}`
    ))
  writeFileSync(path, rewritten)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}

const animation = await import(pathToFileURL(join(buildDir, 'src/combat-animation.mjs')).href)
const effects = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)
const render = await import(pathToFileURL(join(buildDir, 'src/board-render.mjs')).href)
const client = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function scene(width = 8, height = 8) {
  const tactical = createTacticalMap({
    width,
    height,
    locationId: 'spell-test',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  return {
    map: client.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(tactical)))),
    palette: render.DEFAULT_BOARD_PALETTE,
    cellSize: 24,
  }
}

function recordingContext() {
  const ops = []
  const styles = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  }
  const context = {
    ops,
    save() { ops.push({ op: 'save' }) },
    restore() { ops.push({ op: 'restore' }) },
    translate(x, y) { ops.push({ op: 'translate', x, y }) },
    rotate(angle) { ops.push({ op: 'rotate', angle }) },
    beginPath() { ops.push({ op: 'beginPath' }) },
    closePath() { ops.push({ op: 'closePath' }) },
    moveTo(x, y) { ops.push({ op: 'moveTo', x, y }) },
    lineTo(x, y) { ops.push({ op: 'lineTo', x, y }) },
    arc(x, y, radius) { ops.push({ op: 'arc', x, y, radius, strokeStyle: styles.strokeStyle }) },
    fill() { ops.push({ op: 'fill', fillStyle: styles.fillStyle }) },
    stroke() { ops.push({ op: 'stroke', strokeStyle: styles.strokeStyle }) },
    fillRect(x, y, width, height) { ops.push({ op: 'fillRect', x, y, width, height, fillStyle: styles.fillStyle }) },
    strokeRect(x, y, width, height) { ops.push({ op: 'strokeRect', x, y, width, height, strokeStyle: styles.strokeStyle }) },
    clearRect(x, y, width, height) { ops.push({ op: 'clearRect', x, y, width, height }) },
    setLineDash(value) { ops.push({ op: 'setLineDash', value }) },
    drawImage(...args) { ops.push({ op: 'drawImage', args }) },
    fillText(text, x, y) { ops.push({ op: 'fillText', text, x, y, fillStyle: styles.fillStyle }) },
  }
  for (const property of Object.keys(styles)) {
    Object.defineProperty(context, property, {
      get: () => styles[property],
      set: (value) => { styles[property] = value; ops.push({ op: 'set', property, value }) },
    })
  }
  return context
}

const actor = (id, x, y) => ({ id, x, y })

test('каталог выбирает школу, геометрию и характер ключевых заклинаний', () => {
  assert.deepEqual(
    ['magic-missile', 'fire-bolt', 'hail-of-thorns'].map((id) => effects.spellVisualProfile(id).kind),
    ['projectile', 'projectile', 'projectile'],
  )
  assert.equal(effects.spellVisualProfile('magic-missile').projectileCount, 3)
  assert.equal(effects.spellVisualProfile('magic-missile').school, 'evocation')
  assert.equal(effects.spellVisualProfile('aura-of-life').kind, 'aura')
  assert.equal(effects.spellVisualProfile('aura-of-life').radiusFeet, 30)
  assert.deepEqual(
    {
      kind: effects.spellVisualProfile('chain-lightning').kind,
      chain: effects.spellVisualProfile('chain-lightning').chain,
    },
    { kind: 'beam', chain: true },
  )
  assert.equal(effects.spellVisualProfile('summon-beast').kind, 'channel')
  assert.equal(effects.spellVisualProfile('summon-beast').school, 'conjuration')
  assert.equal(effects.spellVisualProfile('fireball').areaShape, 'sphere')
  assert.equal(effects.spellVisualProfile('fireball').sizeFeet, 20)
})

test('шесть основных школ различаются и цветом, и поведением', () => {
  const schools = ['evocation', 'abjuration', 'necromancy', 'enchantment', 'conjuration', 'transmutation']
  const styles = schools.map((school) => effects.SPELL_SCHOOL_STYLES[school])
  assert.equal(new Set(styles.map((style) => style.primary)).size, schools.length)
  assert.deepEqual(
    styles.map((style) => style.behavior),
    ['flash', 'dome', 'inward', 'wave', 'materialize', 'morph'],
  )
  assert.ok(styles.every((style) => /^#[0-9a-f]{6}$/iu.test(style.primary)), 'палитра должна оставаться контролируемой, без CSS-неона')
})

test('живой пакет создаёт projectile, burst, beam, aura, channel, лечение, призыв и концентрацию', () => {
  const cues = animation.combatAnimationCuesFromEvents([
    { event_id: 'cast-mm', command_id: 'mm', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'magic-missile', kind: 'damage', damage_type: 'force' } },
    { event_id: 'cast-fireball', command_id: 'fireball', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin', 'orc'], payload: { spell_id: 'fireball', kind: 'area-save', damage_type: 'fire' } },
    { event_id: 'cast-chain', command_id: 'chain', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin', 'orc', 'troll'], payload: { spell_id: 'chain-lightning', kind: 'save', damage_type: 'lightning' } },
    { event_id: 'cast-aura', command_id: 'aura', event_type: 'SpellCast', actor_id: 'cleric', target_ids: ['cleric'], payload: { spell_id: 'aura-of-life', kind: 'buff', concentration: true } },
    { event_id: 'concentration-start', command_id: 'aura', event_type: 'ConcentrationStarted', actor_id: 'cleric', target_ids: ['cleric'], payload: { effect_id: 'aura-of-life:aura' } },
    { event_id: 'heal', command_id: 'heal', event_type: 'HealingApplied', actor_id: 'cleric', target_ids: ['fighter'], payload: { spell_id: 'healing-word', applied_amount: 7 } },
    { event_id: 'summon', command_id: 'summon', event_type: 'SummonedCreatureCreated', actor_id: 'druid', target_ids: ['beast'], payload: { summon: { id: 'beast', sourceSpellId: 'summon-beast', x: 4, y: 3 } } },
    { event_id: 'concentration-end', command_id: 'aura-end', event_type: 'ConcentrationEnded', actor_id: 'cleric', target_ids: ['cleric'], payload: { effect_id: 'aura-of-life:aura', reason: 'failed-save' } },
  ])
  assert.ok(cues.some((cue) => cue.kind === 'projectile' && cue.projectileCount === 3))
  assert.ok(cues.some((cue) => cue.kind === 'burst' && cue.shape === 'sphere' && cue.sizeFeet === 20))
  assert.ok(cues.some((cue) => cue.kind === 'beam' && cue.chain && cue.targetIds.length === 3))
  assert.ok(cues.some((cue) => cue.kind === 'aura' && cue.auraType === 'spell' && cue.radiusFeet === 30))
  assert.ok(cues.some((cue) => cue.kind === 'aura' && cue.auraType === 'concentration' && cue.active))
  assert.ok(cues.some((cue) => cue.kind === 'aura' && cue.auraType === 'concentration' && !cue.active))
  assert.ok(cues.some((cue) => cue.kind === 'channel' && cue.channelType === 'healing' && cue.amount === 7))
  assert.equal(cues.some((cue) => cue.kind === 'impact' && cue.tone === 'healing'), false)
  assert.ok(cues.some((cue) => cue.kind === 'channel' && cue.channelType === 'summon' && cue.position.x === 4))
})

test('лечение без величины доходит до клетки словом: пакет отдаёт отсутствие, а не ноль', () => {
  // У чужого лечения санитайзер снимает `applied_amount` целиком
  // (`eventForViewer`, `server/viewer-projection.mjs`), и «ноль вместо
  // отсутствия» — единственная развилка, которая отличает «зелье не
  // сработало» от «сработало, но числа не видно». Живёт она в `safeAmount`, и
  // без этой проверки подмена `null` на `0` оставляла корпус зелёным:
  // рисующий сторож ниже подаёт `amount: null` уже готовой репликой и до
  // разбора события не доходит вовсе.
  const [cue] = animation.combatAnimationCuesFromEvents([
    { event_id: 'heal-hidden', command_id: 'sip', event_type: 'HealingApplied', actor_id: 'goblin', target_ids: ['goblin'], payload: {} },
  ])
  assert.equal(cue.channelType, 'healing')
  assert.equal(cue.amount, null, 'снятая сервером величина обязана остаться отсутствующей, а не стать нулём')

  const context = recordingContext()
  render.drawBoardEffects(context, scene(), [
    effects.createSpellEffectRenderer({ cue, progress: .65, actors: [actor('goblin', 3, 3)], reducedMotion: false }),
  ])
  assert.ok(context.ops.some((operation) => operation.op === 'fillText' && operation.text === 'ЛЕЧЕНИЕ'))
  assert.equal(
    context.ops.some((operation) => operation.op === 'fillText' && String(operation.text).startsWith('+')),
    false,
    'над клеткой не должно быть «+0»',
  )
})

test('смазанный клинок над клеткой подписан в обеих формах — и чужой, и свой', () => {
  // Проекция обезличивает только карман противника (`publicConditionsFor`,
  // `server/viewer-projection.mjs`): у врага в клиент приезжает
  // `weapon-coated`, у героя — точная `weapon-coated:<item_instance_id>`.
  // Качественная подпись стоит под первую форму, и без запасной ветки над
  // клеткой героя общий гуманизатор рисовал «Weapon Coated:hero Blade» —
  // ключ вещи прямо на доске.
  const cues = animation.combatAnimationCuesFromEvents([
    { event_id: 'coat-foe', command_id: 'coat-foe', event_type: 'ConditionAdded', actor_id: 'spy', target_ids: ['spy'], payload: { condition: 'weapon-coated' } },
    { event_id: 'coat-hero', command_id: 'coat-hero', event_type: 'ConditionAdded', actor_id: 'hero', target_ids: ['hero'], payload: { condition: 'weapon-coated:hero-blade' } },
  ])
  assert.deepEqual(
    cues.filter((cue) => cue.kind === 'condition').map((cue) => cue.label),
    ['Клинок смазан', 'Клинок смазан ядом'],
  )
})

test('SpellAreaCreated использует точные клетки и не дублирует приблизительный burst', () => {
  const cues = animation.combatAnimationCuesFromEvents([
    { event_id: 'cast-web', command_id: 'web', event_type: 'SpellCast', actor_id: 'mage', payload: { spell_id: 'web', kind: 'area-save' } },
    {
      event_id: 'area-web',
      command_id: 'web',
      event_type: 'SpellAreaCreated',
      actor_id: 'mage',
      payload: {
        effect: {
          id: 'web:web',
          spell_id: 'web',
          center: { x: 3, y: 3 },
          cells: [{ x: 2, y: 2 }, { x: 3, y: 2 }],
          radius_feet: 20,
          area_shape: 'cube',
        },
      },
    },
  ])
  const bursts = cues.filter((cue) => cue.kind === 'burst')
  assert.equal(bursts.length, 1)
  assert.deepEqual(bursts[0].cells, [{ x: 2, y: 2 }, { x: 3, y: 2 }])
})

test('резервный боевой журнал сохраняет типы магии при повторном подключении', () => {
  const cues = animation.combatAnimationCuesFromBattleLog([
    { id: 'spell', type: 'spell', actorId: 'mage', targetId: 'goblin', spellId: 'magic-missile', spellName: 'Волшебная стрела' },
    { id: 'heal', type: 'healing', actorId: 'cleric', targetId: 'fighter', spellId: 'healing-word', healing: 5 },
    { id: 'summon', type: 'summon', actorId: 'druid', targetId: 'beast', spellId: 'summon-beast' },
    { id: 'focus-end', type: 'concentration-end', actorId: 'druid', spellId: 'summon-beast' },
  ])
  assert.deepEqual(
    cues.map((cue) => cue.kind),
    ['projectile', 'channel', 'channel', 'aura'],
  )
  assert.equal(cues[1].channelType, 'healing')
  assert.equal(cues[2].channelType, 'summon')
  assert.equal(cues[3].active, false)
})

test('burst renderer получает клетки из общей areaCells и проходит через drawBoardEffects', () => {
  const context = recordingContext()
  const boardScene = scene()
  const cue = {
    id: 'fireball',
    kind: 'burst',
    actorId: 'mage',
    targetIds: [],
    spellId: 'fireball',
    school: 'evocation',
    origin: { x: 0, y: 0 },
    center: { x: 3, y: 3 },
    shape: 'sphere',
    sizeFeet: 5,
    durationMs: 480,
    motion: 'full',
    detail: 'full',
  }
  const renderer = effects.createSpellEffectRenderer({ cue, progress: .45, actors: [actor('mage', 0, 0)], reducedMotion: false })
  render.drawBoardEffects(context, boardScene, [renderer])
  assert.equal(context.ops.filter((operation) => operation.op === 'fillRect').length, 9)
  assert.equal(context.ops.filter((operation) => operation.op === 'strokeRect').length, 9)
  assert.equal(context.ops.filter((operation) => operation.op === 'save').length, context.ops.filter((operation) => operation.op === 'restore').length)
})

test('projectile, цепной beam, aura, лечение и призыв остаются читаемыми без частиц', () => {
  const boardScene = scene()
  const actors = [actor('mage', 1, 1), actor('goblin', 4, 1), actor('orc', 5, 3), actor('cleric', 2, 5), actor('beast', 4, 5)]
  const cases = [
    {
      cue: { id: 'p', kind: 'projectile', actorId: 'mage', targetIds: ['goblin'], projectileCount: 3, spellId: 'magic-missile', school: 'evocation', durationMs: 520 },
      expected: (ops) => ops.some((operation) => operation.op === 'lineTo') && ops.filter((operation) => operation.op === 'fill').length === 3,
    },
    {
      cue: { id: 'b', kind: 'beam', actorId: 'mage', targetIds: ['goblin', 'orc'], chain: true, spellId: 'chain-lightning', school: 'evocation', durationMs: 560 },
      expected: (ops) => ops.filter((operation) => operation.op === 'lineTo').length >= 2,
    },
    {
      cue: { id: 'a', kind: 'aura', actorId: 'cleric', radiusFeet: 30, auraType: 'spell', active: true, spellId: 'aura-of-life', school: 'abjuration', durationMs: 440 },
      expected: (ops) => ops.some((operation) => operation.op === 'arc' && operation.radius > 100),
    },
    {
      cue: { id: 'h', kind: 'channel', actorId: 'cleric', targetId: 'cleric', channelType: 'healing', amount: 6, spellId: 'healing-word', school: 'evocation', durationMs: 480 },
      expected: (ops) => ops.some((operation) => operation.op === 'fillText' && operation.text === '+6'),
    },
    {
      // Лечение без величины: у неопознанного противника сервер число не
      // присылает, и «+0» означало бы, что зелье не сработало.
      cue: { id: 'h0', kind: 'channel', actorId: 'goblin', targetId: 'goblin', channelType: 'healing', amount: null, spellId: '', school: 'evocation', durationMs: 480 },
      expected: (ops) => ops.some((operation) => operation.op === 'fillText' && operation.text === 'ЛЕЧЕНИЕ'),
    },
    {
      cue: { id: 's', kind: 'channel', actorId: 'cleric', targetId: 'beast', channelType: 'summon', spellId: 'summon-beast', school: 'conjuration', durationMs: 480 },
      expected: (ops) => ops.some((operation) => operation.op === 'fillText' && operation.text === 'ПРИЗЫВ'),
    },
  ]
  for (const entry of cases) {
    const context = recordingContext()
    render.drawBoardEffects(context, boardScene, [
      effects.createSpellEffectRenderer({ cue: entry.cue, progress: .65, actors, reducedMotion: false }),
    ])
    assert.ok(entry.expected(context.ops), `${entry.cue.kind} не получил читаемый рисунок`)
  }
})

test('постоянный renderer показывает радиус ауры и метку концентрации', () => {
  const context = recordingContext()
  const persistent = effects.createPersistentSpellEffectsRenderer([
    { id: 'aura', kind: 'aura', actorId: 'cleric', spellId: 'aura-of-life', radiusFeet: 30 },
    { id: 'focus', kind: 'concentration', actorId: 'cleric', spellId: 'aura-of-life' },
  ], [actor('cleric', 3, 3)], { detail: 'reduced', reducedMotion: false })
  render.drawBoardEffects(context, scene(), [persistent])
  assert.ok(context.ops.some((operation) => operation.op === 'arc' && operation.radius > 100))
  assert.ok(context.ops.some((operation) => operation.op === 'fillText' && operation.text === 'К'))
})

test('проекция сохраняет точные клетки области, ауру и актуальную концентрацию', () => {
  assert.equal(effects.spellIdFromEffect('spell:web'), 'web')
  assert.equal(effects.spellIdFromEffect('aura-of-life:command-1'), 'aura-of-life')
  const projected = effects.persistentSpellEffectsFromProjection([
    {
      id: 'web-area',
      effect_id: 'web:command-1',
      spell_id: 'web',
      source_actor: 'mage',
      center: { x: 3, y: 3 },
      cells: [{ x: 2, y: 2 }, { x: 3, y: 2 }],
      radius_feet: 20,
      area_shape: 'cube',
    },
    {
      id: 'life-aura',
      effect_id: 'aura-of-life:command-2',
      spell_id: 'aura-of-life',
      source_actor: 'cleric',
      center: { x: 4, y: 4 },
      radius_feet: 30,
    },
  ], {
    mage: { effect_id: 'spell:web' },
    cleric: { effect_id: 'aura-of-life:command-2' },
  })
  const area = projected.find((effect) => effect.kind === 'area')
  assert.deepEqual(area?.cells, [{ x: 2, y: 2 }, { x: 3, y: 2 }])
  assert.equal(area?.shape, 'cube')
  assert.ok(projected.some((effect) => effect.kind === 'aura' && effect.radiusFeet === 30))
  assert.deepEqual(
    projected.filter((effect) => effect.kind === 'concentration').map((effect) => effect.spellId),
    ['web', 'aura-of-life'],
  )

  const context = recordingContext()
  const renderer = effects.createPersistentSpellEffectsRenderer(
    projected.filter((effect) => effect.kind === 'area'),
    [actor('mage', 1, 1)],
    { detail: 'reduced', reducedMotion: false },
  )
  render.drawBoardEffects(context, scene(), [renderer])
  assert.equal(context.ops.filter((operation) => operation.op === 'strokeRect').length, 2)
})

test('пакет не превышает 1,8 с и деградирует до доступной детализации', () => {
  const cues = Array.from({ length: 20 }, (_, index) => ({
    id: `impact-${index}`,
    kind: 'impact',
    targetId: `target-${index}`,
    amount: 1,
    tone: 'damage',
    durationMs: 500,
  }))
  const fitted = animation.fitCombatAnimationBudget(cues, { reducedMotion: false })
  assert.equal(fitted.length, animation.COMBAT_ANIMATION_QUEUE_LIMIT)
  assert.ok(fitted.reduce((sum, cue) => sum + cue.durationMs, 0) <= animation.COMBAT_ANIMATION_BATCH_BUDGET_MS)
  assert.ok(fitted.every((cue) => cue.detail === 'minimal' || cue.detail === 'reduced'))
})

test('просадка кадра упрощает эффект сразу, а восстанавливает плавно', () => {
  const budget = effects.createSpellEffectBudgetController({ frameBudgetMs: 16, recoveryFrames: 2, reducedMotion: false })
  assert.equal(budget.detail, 'full')
  assert.equal(budget.recordFrame(24), 'reduced')
  assert.equal(budget.recordFrame(40), 'minimal')
  assert.equal(budget.recordFrame(8), 'minimal')
  assert.equal(budget.recordFrame(8), 'reduced')
  assert.equal(budget.recordFrame(8), 'reduced')
  assert.equal(budget.recordFrame(8), 'full')
})

test('reduced motion превращает пакет и projectile в статические акценты', () => {
  const cues = animation.combatAnimationCuesFromEvents([
    { event_id: 'cast', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'magic-missile', kind: 'damage' } },
  ], { reducedMotion: true })
  assert.equal(cues.length, 1)
  assert.equal(cues[0].durationMs, 1)
  assert.equal(cues[0].detail, 'minimal')
  assert.equal(cues[0].motion, 'reduced')

  const context = recordingContext()
  render.drawBoardEffects(context, scene(), [
    effects.createSpellEffectRenderer({
      cue: cues[0],
      progress: .1,
      actors: [actor('mage', 1, 1), actor('goblin', 4, 1)],
      reducedMotion: true,
    }),
  ])
  assert.equal(context.ops.some((operation) => operation.op === 'lineTo'), false, 'снаряд не должен лететь при reduced motion')
  assert.ok(context.ops.some((operation) => operation.op === 'arc'), 'статическая точка попадания остаётся видимой')
})

test('системная prefers-reduced-motion применяется без отдельной настройки приложения', () => {
  const previous = globalThis.matchMedia
  globalThis.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' })
  try {
    const cues = animation.combatAnimationCuesFromBattleLog([
      { id: 'spell', type: 'spell', actorId: 'mage', targetId: 'goblin', spellId: 'fire-bolt' },
    ])
    assert.equal(effects.systemPrefersReducedMotion(), true)
    assert.equal(cues[0].motion, 'reduced')
    assert.equal(cues[0].durationMs, 1)
  } finally {
    if (previous) globalThis.matchMedia = previous
    else delete globalThis.matchMedia
  }
})

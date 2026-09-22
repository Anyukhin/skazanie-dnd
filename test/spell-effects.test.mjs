import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-spell-effects-'))
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(buildDir, 'server'), { recursive: true })
copyFileSync(join(repositoryRoot, 'server', 'actor-footprint.mjs'), join(buildDir, 'server', 'actor-footprint.mjs'))
copyFileSync(join(repositoryRoot, 'server', 'equipment-visuals.mjs'), join(buildDir, 'server', 'equipment-visuals.mjs'))
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

function scene(width = 8, height = 8, hidden = []) {
  const tactical = createTacticalMap({
    width,
    height,
    locationId: 'spell-test',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  hidden.forEach(({ x, y }) => setCell(tactical, x, y, { revealed: false }))
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

test('Скороход, Прыжок и Ускорение рисуют разные геометрические знаки в 2D', () => {
  const signatures = ['longstrider', 'jump', 'haste'].map((spellId) => {
    const context = recordingContext()
    effects.drawSpellEffect(context, scene(), {
      cue: { id: spellId, kind: 'channel', actorId: 'caster', targetId: 'caster', targetIds: ['caster'],
        spellId, school: 'transmutation', channelType: 'cast', durationMs: 500 },
      progress: .5, detail: 'full', reducedMotion: false, actors: [actor('caster', 2, 2)],
    })
    const geometry = context.ops.filter((operation) => ['arc', 'moveTo', 'lineTo'].includes(operation.op))
    assert.ok(geometry.length > 0)
    return JSON.stringify(geometry)
  })
  assert.equal(new Set(signatures).size, 3, 'различаются примитивы, а не только подпись заклинания')
})

const actor = (id, x, y) => ({ id, x, y })

test('Скороход сохраняет одинаковый cue для HTTP и SSE и отмечает обе видимые цели в 2D', () => {
  const event = { event_id: 'cast-longstrider', event_type: 'SpellCast', command_id: 'cast-command', actor_id: 'caster', target_ids: ['caster', 'ally'], payload: { spell_id: 'longstrider', kind: 'buff' } }
  const live = animation.combatAnimationCuesFromEvents([event,
    { event_id: 'condition-a', event_type: 'ConditionAdded', actor_id: 'caster', target_ids: ['caster'], payload: { condition: 'longstrider' } },
    { event_id: 'condition-b', event_type: 'ConditionAdded', actor_id: 'caster', target_ids: ['ally'], payload: { condition: 'longstrider' } },
  ])
  const synced = animation.combatAnimationCuesFromBattleLog([{ id: 'cast-longstrider', type: 'spell', actorId: 'caster', targetId: 'caster', targetIds: ['caster', 'ally'], spellId: 'longstrider' }])
  assert.equal(live.length, 1)
  assert.equal(synced.length, 1)
  assert.equal(live[0].id, synced[0].id)
  assert.deepEqual(effects.spellChannelTargetIds(live[0]), ['caster', 'ally'])
  assert.deepEqual(effects.spellChannelTargetIds(synced[0]), ['caster', 'ally'])
  const context = recordingContext()
  effects.drawSpellEffect(context, scene(), { cue: live[0], progress: .5, actors: [actor('caster', 1, 1), actor('ally', 2, 1)] })
  assert.equal(context.ops.filter((op) => op.op === 'fillText').length, 2)
  const hiddenContext = recordingContext()
  effects.drawSpellEffect(hiddenContext, scene(8, 8, [{ x: 2, y: 1 }]), { cue: live[0], progress: .5, actors: [actor('caster', 1, 1), actor('ally', 2, 1)] })
  assert.equal(hiddenContext.ops.filter((op) => op.op === 'fillText').length, 1)
  const neutralCue = { ...live[0], targetIds: ['npc'] }
  const neutralContext = recordingContext()
  effects.drawSpellEffect(neutralContext, scene(), { cue: neutralCue, progress: .5, actors: [{ ...actor('npc', 2, 1), kind: 'neutral' }] })
  assert.equal(neutralContext.ops.filter((op) => op.op === 'fillText').length, 1)
  const empty = animation.combatAnimationCuesFromBattleLog([{ id: 'empty', type: 'spell', actorId: 'caster', targetIds: [], spellId: 'longstrider' }])[0]
  assert.deepEqual(effects.spellChannelTargetIds(empty), [], 'фильтрация не подменяет скрытых получателей кастером')
  const emptyContext = recordingContext()
  effects.drawSpellEffect(emptyContext, scene(), { cue: empty, progress: .5, actors: [actor('caster', 1, 1)] })
  assert.equal(emptyContext.ops.filter((op) => op.op === 'fillText').length, 0)
})

test('2D combat endpoint центрирует large actor и безопасно возвращается к anchor в неполном тумане', () => {
  const actors = [
    { id: 'mage', x: 1, y: 1, footprint: { version: 1, size: 2 } },
    { id: 'target', x: 4, y: 1, footprint: { version: 1, size: 2 } },
  ]
  const cue = {
    id: 'large-channel', kind: 'channel', actorId: 'mage', targetId: 'target',
    spellId: 'healing-word', school: 'evocation', channelType: 'healing', amount: 4,
    durationMs: 480,
  }
  const fullContext = recordingContext()
  render.drawBoardEffects(fullContext, scene(), [effects.createSpellEffectRenderer({ cue, progress: .5, actors })])
  const fullArc = fullContext.ops.find((operation) => operation.op === 'arc')
  assert.equal(fullArc.x, 120, 'полностью раскрытая 2×2 цель получает центр x+1')
  assert.equal(fullArc.y, 48, 'полностью раскрытая 2×2 цель получает центр y+1')

  const partialContext = recordingContext()
  render.drawBoardEffects(partialContext, scene(8, 8, [{ x: 5, y: 1 }]), [
    effects.createSpellEffectRenderer({ cue, progress: .5, actors }),
  ])
  const partialArc = partialContext.ops.find((operation) => operation.op === 'arc')
  assert.equal(partialArc.x, 108, 'неполный footprint остаётся на одноклеточном anchor')
  assert.equal(partialArc.y, 36, 'неполный footprint не раскрывает вторую строку')
})

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

test('геометрия важнее названия: молния остаётся линией, луч холода — снарядом', () => {
  assert.equal(effects.spellVisualProfile('lightning-bolt').kind, 'burst')
  assert.equal(effects.spellVisualProfile('lightning-bolt').areaShape, 'line')
  assert.equal(effects.spellVisualProfile('ray-of-frost').kind, 'projectile')
  assert.equal(effects.spellVisualProfile('ray-of-enfeeblement').kind, 'beam')
  assert.notEqual(effects.spellEffectPalette('fireball').primary, effects.SPELL_SCHOOL_STYLES.evocation.primary)
  assert.equal(effects.spellEffectPalette('healing-word', { kind: 'healing' }).primary, '#75c993')
})

test('семантические исключения сохраняют фазу и форму действующего эффекта', () => {
  assert.equal(effects.spellVisualProfile('investiture-of-ice').kind, 'channel')
  assert.equal(effects.spellVisualProfile('investiture-of-ice').family, 'cold')
  assert.equal(effects.spellVisualProfile('investiture-of-flame').kind, 'channel')
  assert.equal(effects.spellVisualProfile('investiture-of-flame').family, 'fire')
  assert.equal(effects.spellVisualProfile('dispel-evil-and-good').visualVariant, 'cancellation')
  assert.equal(effects.spellVisualProfile('counterspell').visualVariant, 'cancellation')
  assert.equal(effects.spellVisualProfile('mordenkainen-s-private-sanctum').kind, 'burst')
  assert.equal(effects.spellVisualProfile('mordenkainen-s-private-sanctum').areaShape, 'cube')
  assert.equal(effects.spellVisualProfile('mordenkainen-s-private-sanctum').sizeFeet, 100)
  const forbiddance = effects.spellVisualProfile('forbiddance')
  assert.equal(forbiddance.kind, 'channel')
  assert.match(forbiddance.familyNote, /не передал/u)
})

test('семантические семьи покрывают каталог, а школа остаётся только fallback', () => {
  const catalog = JSON.parse(readFileSync(join(repositoryRoot, 'data', 'dndsu-spells-0-6.json'), 'utf8')).spells
  const overrides = JSON.parse(readFileSync(join(repositoryRoot, 'data', 'dndsu-spell-mechanics-overrides.json'), 'utf8')).spells
  const allowed = new Set(['fire', 'cold', 'lightning', 'thunder', 'acid', 'poison', 'necrotic', 'radiant', 'force', 'psychic', 'healing', 'protection', 'control', 'teleport', 'summon', 'earth', 'wind', 'water', 'swarm', 'weapon', 'illusion', 'divination', 'light', 'darkness', 'environment', 'enchantment', 'restoration', 'invisibility', 'flight', 'mobility', 'transmutation', 'communication', 'utility', 'school'])
  const families = new Set(catalog.map((spell) => effects.spellEffectPalette(spell.id).family))
  const isExecutable = (spell) => overrides[spell.id] && ['partial', 'verified'].includes(overrides[spell.id].mechanicsSupport ?? 'partial')
  const executable = catalog.filter(isExecutable)
  const schoolFallback = executable.filter((spell) => effects.spellEffectPalette(spell.id).family === 'school').map((spell) => spell.id)
  const unsupported = catalog.filter((spell) => !isExecutable(spell))
  assert.ok(catalog.length > 400)
  assert.equal(executable.length, 242, 'исполняемый набор должен совпадать с partial/verified override-карточками')
  assert.equal(unsupported.length, 197, 'heuristic/ruling-only карточки не входят в реализованный набор')
  assert.ok(catalog.every((spell) => allowed.has(effects.spellEffectPalette(spell.id).family)))
  assert.deepEqual(schoolFallback, [], 'каждая executable-карточка должна иметь semantic family')
  for (const family of ['fire', 'cold', 'lightning', 'thunder', 'acid', 'poison', 'necrotic', 'radiant', 'force', 'psychic', 'healing', 'protection', 'control', 'teleport', 'summon', 'earth', 'wind', 'water', 'swarm', 'weapon', 'illusion', 'divination', 'light', 'darkness', 'environment', 'enchantment', 'restoration', 'invisibility', 'flight', 'mobility', 'transmutation', 'communication', 'utility']) {
    assert.ok(families.has(family), `каталог не дал семейство ${family}`)
  }
  assert.equal([...families].includes('school'), false, 'каталог не должен молча падать в школьный fallback')
  const expected = {
    fireball: 'fire', 'ice-storm': 'cold', 'lightning-bolt': 'lightning', 'thunderwave': 'thunder',
    'melf-s-acid-arrow': 'acid', 'poison-spray': 'poison', 'inflict-wounds': 'necrotic', 'guiding-bolt': 'radiant',
    'magic-missile': 'force', 'vicious-mockery': 'psychic', 'healing-word': 'healing', shield: 'protection',
    web: 'control', 'silence': 'control', 'misty-step': 'teleport', 'summon-beast': 'summon', 'minor-illusion': 'illusion',
    catapult: 'earth', 'gust-of-wind': 'wind', maelstrom: 'water', 'insect-plague': 'swarm', 'cloud-of-daggers': 'weapon', knock: 'thunder',
  }
  for (const [spellId, family] of Object.entries(expected)) assert.equal(effects.spellEffectPalette(spellId).family, family, spellId)
  const soundExpected = {
    'shape-water': 'water', 'create-or-destroy-water': 'water', 'wall-of-water': 'water', 'water-breathing': 'water',
    'mold-earth': 'earth', 'move-earth': 'earth', 'stone-shape': 'earth', 'wall-of-stone': 'earth',
    'gust-of-wind': 'wind', 'air-bubble': 'wind', 'fog-cloud': 'wind', infestation: 'swarm', 'insect-plague': 'swarm',
  }
  for (const [spellId, soundFamily] of Object.entries(soundExpected)) assert.equal(effects.spellEffectPalette(spellId).soundFamily, soundFamily, spellId)
  const audit = effects.spellVisualAudit()
  assert.equal(audit.length, 439)
  assert.equal(new Set(audit.map((entry) => entry.id)).size, audit.length)
  assert.ok(audit.every((entry) => ['projectile', 'burst', 'beam', 'aura', 'channel'].includes(entry.kind)))
  assert.ok(audit.every((entry) => entry.family !== 'school' && entry.note && entry.soundFamily && entry.kind))
})

test('каждое семейство имеет читаемый Canvas-след в общей burst-отрисовке', () => {
  const representatives = {
    fire: 'fireball', cold: 'ice-storm', lightning: 'lightning-bolt', thunder: 'thunderwave', acid: 'melf-s-acid-arrow',
    poison: 'cloudkill', necrotic: 'inflict-wounds', radiant: 'guiding-bolt', force: 'magic-missile', psychic: 'vicious-mockery',
    healing: 'healing-word', protection: 'shield', control: 'web', teleport: 'misty-step', summon: 'summon-beast',
    earth: 'catapult', wind: 'gust-of-wind', water: 'maelstrom', swarm: 'insect-plague', weapon: 'cloud-of-daggers',
    illusion: 'minor-illusion', divination: 'detect-magic', light: 'light', darkness: 'darkness', environment: 'mold-earth',
    enchantment: 'charm-person', restoration: 'lesser-restoration', invisibility: 'invisibility', flight: 'fly', mobility: 'longstrider',
    transmutation: 'polymorph', communication: 'message', utility: 'mage-hand', silence: 'silence', school: 'unknown-arcane-spell',
  }
  for (const [family, spellId] of Object.entries(representatives)) {
    const context = recordingContext()
    const line = family === 'lightning'
    effects.drawSpellEffect(context, scene(), {
      cue: {
        id: `family-${family}`, kind: 'burst', actorId: 'mage', targetIds: [], spellId, school: 'evocation',
        origin: { x: 1, y: 1 }, center: { x: 3, y: 3 }, shape: line ? 'line' : 'sphere', sizeFeet: 10, durationMs: 480,
      }, actors: [actor('mage', 1, 1)], progress: .75, detail: 'full', reducedMotion: false,
    })
    assert.ok(
      context.ops.some((operation) => operation.op === 'lineTo' || operation.op === 'arc' || operation.op === 'strokeRect'),
      `${family} (${spellId}) не оставил читаемого Canvas-следа`,
    )
  }
})

test('cue Fireball читает точку из реального SpellCast engine event', () => {
  const target = { x: 6, y: 2 }
  const cells = Array.from({ length: 12 * 8 }, (_, index) => ({
    x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true,
  }))
  const state = normalizeCampaignState({
    players: [{ id: 'mage', character: 'Маг', role: 'Волшебник', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { int: 18, dex: 12 }, inventory: [], x: 1, y: 2 }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 20, maxHp: 20, armor: 10, speed: 30, abilities: { dex: 8 }, x: target.x, y: target.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { mage: { spell_slots_3: { current: 2, max: 2 } } },
      combat: {
        active: true, round: 1, initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'goblin', total: 8 }], active_index: 0,
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          goblin: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  const dice = new DiceService({ rng: new SequenceDiceRng(Array(30).fill(2)), idFactory: (() => { let id = 0; return () => `spell-effect-roll-${++id}` })(), now: () => '2026-09-17T12:00:00.000Z' })
  const result = resolveCommand({ command_type: 'CastSpell', command_id: 'engine-fireball', actor_id: 'mage', spell_id: 'fireball', to: target, server_authoritative: true }, state, {
    diceService: dice,
    context: { serverAuthoritativeCombat: true, isAdmin: true },
  })
  const event = result.events.find((entry) => entry.event_type === 'SpellCast')
  assert.deepEqual(event?.payload?.to, target, 'engine должен записать авторитетную точку заклинания')
  const [cue] = animation.combatAnimationCuesFromEvents([event])
  assert.equal(cue.kind, 'burst')
  assert.deepEqual(cue.center, target, '3D и 2D cue должны лететь к точке, а не к первой цели')
})

test('реальный Misty Step становится одним teleport channel без walk cue', () => {
  const target = { x: 4, y: 2 }
  const cells = Array.from({ length: 8 * 6 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    players: [{ id: 'mage', character: 'Маг', role: 'Волшебник', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { int: 18, dex: 12 }, inventory: [], x: 1, y: 2 }],
    enemies: [], scene: { turn: 1, cells },
    mechanics: {
      resources: { mage: { spell_slots_2: { current: 2, max: 2 } } },
      combat: { active: true, round: 1, initiative: [{ actor_id: 'mage', total: 20 }], active_index: 0, action_economy: { mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } },
    },
  })
  const result = resolveCommand({ command_type: 'CastSpell', command_id: 'engine-misty-step', actor_id: 'mage', spell_id: 'misty-step', to: target, server_authoritative: true }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng([]), idFactory: (() => { let id = 0; return () => `teleport-roll-${++id}` })(), now: () => '2026-09-18T12:00:00.000Z' }),
    context: { serverAuthoritativeCombat: true, isAdmin: true },
  })
  assert.ok(result.events.some((event) => event.event_type === 'ActorMoved' && event.payload?.teleport === true))
  const cues = animation.combatAnimationCuesFromEvents(result.events)
  const teleport = cues.filter((cue) => cue.kind === 'channel' && cue.channelType === 'teleport')
  assert.equal(teleport.length, 1)
  assert.equal(cues.filter((cue) => cue.kind === 'move').length, 0)
  assert.deepEqual(teleport[0].from, { x: 1, y: 2 })
  assert.deepEqual(teleport[0].position, target)
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

test('AttackResolved передаёт вид атаки, снимок снаряжения и концы серверной траектории', () => {
  const [cue] = animation.combatAnimationCuesFromEvents([{
    event_id: 'attack-bow', command_id: 'attack-bow', event_type: 'AttackResolved', actor_id: 'hero', target_ids: ['goblin'],
    payload: {
      hit: true,
      attack_kind: 'ranged',
      attack_visual: { version: 1, equipment: 'bow' },
      trajectory: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 5, y: 3 }],
    },
  }])
  assert.equal(cue.kind, 'strike')
  assert.equal(cue.attackKind, 'ranged')
  assert.equal(cue.equipment, 'bow')
  assert.deepEqual(cue.from, { x: 1, y: 2 })
  assert.deepEqual(cue.to, { x: 5, y: 3 })
  assert.equal(animation.strikeImpactProgress(cue), .72)
})

test('v2 attack snapshot доносит loadout в strike cue и сохраняет старый anchor trajectory', () => {
  const [cue] = animation.combatAnimationCuesFromEvents([{
    event_id: 'attack-crossbow', command_id: 'attack-crossbow', event_type: 'AttackResolved', actor_id: 'hero', target_ids: ['goblin'],
    payload: {
      hit: true,
      attack_visual: {
        version: 2,
        equipment: 'unknown',
        loadout: { main_hand: { model_key: 'heavy-crossbow', variant: 'default' }, off_hand: null },
      },
      trajectory: [{ x: 2, y: 1 }, { x: 6, y: 1 }],
    },
  }])
  assert.deepEqual(cue.loadout, { main_hand: { model_key: 'heavy-crossbow' }, off_hand: null })
  assert.deepEqual(cue.from, { x: 2, y: 1 })
  assert.deepEqual(cue.to, { x: 6, y: 1 })
  assert.equal(animation.strikeImpactProgress(cue), .72)
})

test('старый AttackResolved остаётся generic strike и не угадывает дальний бой по дальности', () => {
  const [cue] = animation.combatAnimationCuesFromEvents([{
    event_id: 'attack-old', command_id: 'attack-old', event_type: 'AttackResolved', actor_id: 'goblin', target_ids: ['hero'],
    payload: { hit: true, range_feet: 60, item_name: 'Метательное копьё' },
  }])
  assert.equal(cue.kind, 'strike')
  assert.equal(cue.attackKind, undefined)
  assert.equal(cue.equipment, undefined)
  assert.equal(cue.from, undefined)
  assert.equal(cue.to, undefined)
  assert.equal(animation.strikeImpactProgress(cue), .3)
})

test('итоговая поза смерти ждёт начала своего клипа и не опережает удар', () => {
  const cues = animation.combatAnimationCuesFromEvents([
    {
      event_id: 'attack-defeat', command_id: 'attack-defeat', event_type: 'AttackResolved', actor_id: 'hero', target_ids: ['goblin'],
      payload: { hit: true, attack_kind: 'ranged', attack_visual: { version: 1, equipment: 'bow' }, trajectory: [{ x: 1, y: 1 }, { x: 5, y: 1 }] },
    },
    {
      event_id: 'damage-defeat', command_id: 'attack-defeat', event_type: 'DamageApplied', actor_id: 'hero', target_ids: ['goblin'],
      payload: { applied_amount: 9, hp_after: 0, damage_type: 'piercing' },
    },
  ])
  assert.deepEqual(cues.map((cue) => cue.kind), ['strike', 'death'])
  assert.equal(animation.shouldDeferDefeat('goblin', undefined, cues), true)
  assert.equal(animation.shouldDeferDefeat('goblin', cues[0], [cues[1]]), true)
  assert.equal(animation.shouldDeferDefeat('goblin', undefined, [cues[1]]), true, 'между ударом и началом death клипа труп не мелькает на один кадр')
  assert.equal(animation.shouldDeferDefeat('goblin', cues[1], []), false)
  assert.equal(animation.shouldDeferDefeat('goblin', undefined, [{ id: 'impact', kind: 'impact', targetId: 'goblin', amount: 4, tone: 'damage', durationMs: 360 }, cues[1]]), true)
  assert.equal(animation.shouldDeferDefeat('goblin', undefined, []), false)
})

test('резервный журнал доставляет те же поля атаки без чтения текущего инвентаря', () => {
  const [cue] = animation.combatAnimationCuesFromBattleLog([{
    id: 'attack-thrown', type: 'attack', actorId: 'hero', targetId: 'goblin',
    roll: { total: 17, difficulty: 12, hit: true }, damage: 4,
    attackKind: 'thrown', attackVisual: { version: 1, equipment: 'dagger' },
    trajectory: [{ x: 2, y: 1 }, { x: 6, y: 1 }],
  }])
  assert.equal(cue.attackKind, 'thrown')
  assert.equal(cue.equipment, 'dagger')
  assert.deepEqual(cue.from, { x: 2, y: 1 })
  assert.deepEqual(cue.to, { x: 6, y: 1 })
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

test('observer battle log Misty Step объединяет spell и teleport move в один channel', () => {
  const cues = animation.combatAnimationCuesFromBattleLog([
    {
      id: 'misty-spell', type: 'spell', actorId: 'mage', spellId: 'misty-step', spellName: 'Туманный шаг',
      from: { x: 1, y: 2 }, to: { x: 4, y: 2 }, sceneTurn: 3, commandId: 'misty-command',
    },
    {
      id: 'misty-move', type: 'move', actorId: 'mage', from: { x: 1, y: 2 }, to: { x: 4, y: 2 },
      path: [{ x: 4, y: 2 }], sceneTurn: 3, commandId: 'misty-command', teleport: true,
    },
  ])
  const teleport = cues.filter((cue) => cue.kind === 'channel' && cue.channelType === 'teleport')
  assert.equal(teleport.length, 1)
  assert.equal(cues.some((cue) => cue.kind === 'move'), false)
  assert.deepEqual(teleport[0].from, { x: 1, y: 2 })
  assert.deepEqual(teleport[0].position, { x: 4, y: 2 })
})

test('Thunder Step даёт departure thunder burst перед teleport channel и уроном', () => {
  const cues = animation.combatAnimationCuesFromEvents([
    {
      event_id: 'thunder-cast', command_id: 'thunder-command', event_type: 'SpellCast', actor_id: 'mage', target_ids: [],
      payload: { spell_id: 'thunder-step', kind: 'teleport', damage_type: 'thunder', from: { x: 1, y: 2 }, to: { x: 8, y: 2 } },
    },
    {
      event_id: 'thunder-move', command_id: 'thunder-command', event_type: 'ActorMoved', actor_id: 'mage', target_ids: ['mage'],
      payload: { from: { x: 1, y: 2 }, to: { x: 8, y: 2 }, teleport: true },
    },
    {
      event_id: 'thunder-damage', command_id: 'thunder-command', event_type: 'DamageApplied', actor_id: 'mage', target_ids: ['goblin'],
      payload: { applied_amount: 12, damage_type: 'thunder', hp_after: 8 },
    },
  ])
  const departure = cues.find((cue) => cue.kind === 'burst' && cue.presentationPhase === 'departure')
  const teleport = cues.find((cue) => cue.kind === 'channel' && cue.channelType === 'teleport')
  const impact = cues.find((cue) => cue.kind === 'impact' && cue.targetId === 'goblin')
  assert.ok(departure)
  assert.equal(departure.visualFamily, 'thunder')
  assert.deepEqual(departure.center, { x: 1, y: 2 })
  assert.ok(teleport)
  assert.equal(teleport.presentationPhase, 'arrival')
  assert.deepEqual(teleport.from, { x: 1, y: 2 })
  assert.deepEqual(teleport.position, { x: 8, y: 2 })
  assert.ok(impact)
  assert.equal(cues.some((cue) => cue.kind === 'move'), false)
  assert.equal(new Set(cues.map((cue) => cue.id)).size, cues.length)
  assert.ok(cues.indexOf(teleport) < cues.indexOf(departure))
  assert.ok(cues.indexOf(departure) < cues.indexOf(impact))
})

test('observer Thunder Step связывает departure с teleport move и не создаёт walk', () => {
  const cues = animation.combatAnimationCuesFromBattleLog([
    {
      id: 'thunder-spell', type: 'spell', actorId: 'mage', spellId: 'thunder-step', spellName: 'Громовой шаг',
      from: { x: 1, y: 2 }, to: { x: 8, y: 2 }, sceneTurn: 4, commandId: 'thunder-command', damageType: 'thunder',
    },
    {
      id: 'thunder-move', type: 'move', actorId: 'mage', from: { x: 1, y: 2 }, to: { x: 8, y: 2 },
      path: [{ x: 8, y: 2 }], sceneTurn: 4, commandId: 'thunder-command', teleport: true,
    },
  ])
  const departure = cues.find((cue) => cue.kind === 'burst' && cue.presentationPhase === 'departure')
  const teleport = cues.find((cue) => cue.kind === 'channel' && cue.channelType === 'teleport')
  assert.ok(departure)
  assert.equal(departure.visualFamily, 'thunder')
  assert.deepEqual(departure.center, { x: 1, y: 2 })
  assert.ok(teleport)
  assert.equal(teleport.presentationPhase, 'arrival')
  assert.equal(cues.some((cue) => cue.kind === 'move'), false)
})

test('обычная spell attack не дублируется physical strike, а weapon cantrip сохраняет его', () => {
  const hitCues = animation.combatAnimationCuesFromEvents([
    { event_id: 'bolt-cast', command_id: 'bolt-command', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'fire-bolt', kind: 'attack', damage_type: 'fire' } },
    { event_id: 'bolt-attack', command_id: 'bolt-command', event_type: 'AttackResolved', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'fire-bolt', hit: true, critical: false, target_id: 'goblin' } },
    { event_id: 'bolt-damage', command_id: 'bolt-command', event_type: 'DamageApplied', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'fire-bolt', applied_amount: 7, damage_type: 'fire', hp_after: 13 } },
  ])
  assert.equal(hitCues.filter((cue) => cue.kind === 'strike').length, 0)
  assert.deepEqual(hitCues.find((cue) => cue.kind === 'projectile')?.targetOutcomes, { goblin: 'hit' })
  assert.equal(hitCues.filter((cue) => cue.kind === 'impact' && cue.tone === 'damage').length, 1)

  const missCues = animation.combatAnimationCuesFromEvents([
    { event_id: 'bolt-miss-cast', command_id: 'bolt-miss-command', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'fire-bolt', kind: 'attack', damage_type: 'fire' } },
    { event_id: 'bolt-miss-attack', command_id: 'bolt-miss-command', event_type: 'AttackResolved', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'fire-bolt', hit: false, target_id: 'goblin' } },
  ])
  assert.equal(missCues.filter((cue) => cue.kind === 'strike').length, 0)
  assert.equal(missCues.find((cue) => cue.kind === 'impact')?.tone, 'miss')

  const cantripCues = animation.combatAnimationCuesFromEvents([
    { event_id: 'blade-cast', command_id: 'blade-command', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'booming-blade', kind: 'attack', damage_type: 'thunder' } },
    { event_id: 'blade-attack', command_id: 'blade-command', event_type: 'AttackResolved', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'booming-blade', hit: true, attack_kind: 'melee', attack_visual: { version: 1, equipment: 'sword' }, target_id: 'goblin' } },
    { event_id: 'blade-damage', command_id: 'blade-command', event_type: 'DamageApplied', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'booming-blade', applied_amount: 8, damage_type: 'slashing', hp_after: 12 } },
  ])
  assert.equal(cantripCues.filter((cue) => cue.kind === 'strike').length, 1)
})

test('Shield блокирует Magic Missile в presentation path без impact flash', () => {
  const events = [
    { event_id: 'shield-mm-cast', command_id: 'shield-mm', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'magic-missile', kind: 'damage', damage_type: 'force' } },
    { event_id: 'shield-mm-damage', command_id: 'shield-mm', event_type: 'DamageApplied', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'magic-missile', blocked_by_shield: true, applied_amount: 0, hp_before: 20, hp_after: 20, damage_type: 'force' } },
  ]
  const cues = animation.combatAnimationCuesFromEvents(events)
  const projectile = cues.find((cue) => cue.kind === 'projectile')
  assert.deepEqual(projectile?.targetOutcomes, { goblin: 'blocked' })
  assert.equal(cues.some((cue) => cue.kind === 'impact'), false)
})

test('обычное попадание Magic Missile сохраняет damage impact, а shield marker блокирует только miss', () => {
  const hitCues = animation.combatAnimationCuesFromEvents([
    { event_id: 'mm-hit-cast', command_id: 'mm-hit', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'magic-missile', kind: 'damage', damage_type: 'force' } },
    { event_id: 'mm-hit-damage', command_id: 'mm-hit', event_type: 'DamageApplied', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'magic-missile', blocked_by_shield: false, applied_amount: 5, hp_before: 20, hp_after: 15, damage_type: 'force' } },
  ])
  assert.equal(hitCues.find((cue) => cue.kind === 'projectile')?.targetOutcomes, undefined)
  assert.equal(hitCues.filter((cue) => cue.kind === 'impact' && cue.tone === 'damage').length, 1)

  const blocked = animation.combatAnimationCuesFromEvents([
    { event_id: 'blade-shielded-cast', command_id: 'blade-shielded', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'booming-blade', kind: 'attack', damage_type: 'thunder' } },
    { event_id: 'blade-shielded-attack', command_id: 'blade-shielded', event_type: 'AttackResolved', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'booming-blade', hit: false, shielded_by_reaction: true, target_id: 'goblin' } },
  ])
  const blockedStrike = blocked.find((cue) => cue.kind === 'strike')
  assert.equal(blockedStrike?.blocked, true)
  assert.equal(animation.attackOutcome(blockedStrike), 'blocked')

  const realHit = animation.combatAnimationCuesFromEvents([
    { event_id: 'blade-hit-cast', command_id: 'blade-hit', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'booming-blade', kind: 'attack', damage_type: 'thunder' } },
    { event_id: 'blade-hit-attack', command_id: 'blade-hit', event_type: 'AttackResolved', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'booming-blade', hit: true, critical: true, shielded_by_reaction: true, target_id: 'goblin' } },
  ])
  const hitStrike = realHit.find((cue) => cue.kind === 'strike')
  assert.equal(hitStrike?.blocked, undefined)
  assert.equal(animation.attackOutcome(hitStrike), 'critical')
})

test('battle log сохраняет только shield-blocked marker и не создаёт impact cue', () => {
  const initial = normalizeCampaignState({
    players: [{ id: 'mage', character: 'Маг', hp: 20, maxHp: 20, armor: 12, abilities: { int: 16 }, x: 1, y: 1 }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 20, maxHp: 20, armor: 12, abilities: { dex: 10 }, x: 3, y: 1, alive: true }],
    scene: { turn: 1, cells: Array.from({ length: 24 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true })) },
    battleLog: [],
  })
  const cast = { event_id: 'battle-mm-cast', command_id: 'battle-mm', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'magic-missile', name: 'Волшебная стрела', kind: 'damage', damage_type: 'force' } }
  const damage = { event_id: 'battle-mm-damage', command_id: 'battle-mm', event_type: 'DamageApplied', actor_id: 'mage', target_ids: ['goblin'], payload: { spell_id: 'magic-missile', blocked_by_shield: true, applied_amount: 0, raw_amount: 15, hp_before: 20, hp_after: 20, damage_type: 'force' } }
  const after = applyGameEvent(applyGameEvent(initial, cast), damage)
  assert.equal(after.battleLog.find((entry) => entry.type === 'spell')?.blocked, true)
  const cues = animation.combatAnimationCuesFromBattleLog(after.battleLog)
  assert.deepEqual(cues.find((cue) => cue.kind === 'projectile')?.targetOutcomes, { goblin: 'blocked' })
  assert.equal(cues.some((cue) => cue.kind === 'impact'), false)
})

test('observer spell attack outcomes не превращаются в physical strike, weapon cantrip остаётся ударом', () => {
  const cues = animation.combatAnimationCuesFromBattleLog([
    { id: 'observer-bolt', type: 'spell', actorId: 'mage', targetId: 'goblin', spellId: 'fire-bolt', commandId: 'observer-bolt-command', from: { x: 1, y: 2 }, to: { x: 5, y: 2 }, damageType: 'fire' },
    { id: 'observer-bolt-attack', type: 'attack', actorId: 'mage', targetId: 'goblin', spellId: 'fire-bolt', commandId: 'observer-bolt-command', roll: { total: 8, hit: true }, damage: 5, damageType: 'fire' },
    { id: 'observer-bolt-damage', type: 'spell-damage', actorId: 'mage', targetId: 'goblin', damage: 5, damageType: 'fire', hpAfter: 15 },
    { id: 'observer-blade', type: 'spell', actorId: 'mage', targetId: 'goblin', spellId: 'booming-blade', commandId: 'observer-blade-command', from: { x: 1, y: 2 }, to: { x: 2, y: 2 }, damageType: 'thunder' },
    { id: 'observer-blade-attack', type: 'attack', actorId: 'mage', targetId: 'goblin', spellId: 'booming-blade', commandId: 'observer-blade-command', attackKind: 'melee', attackVisual: { version: 1, equipment: 'sword' }, roll: { total: 18, hit: true }, damage: 6, damageType: 'slashing' },
  ])
  assert.equal(cues.filter((cue) => cue.kind === 'strike').length, 1)
  assert.deepEqual(cues.find((cue) => cue.kind === 'projectile')?.targetOutcomes, { goblin: 'hit' })
})

test('observer battle log сохраняет фактическую форму и радиус области', () => {
  const [cue] = animation.combatAnimationCuesFromBattleLog([{
    id: 'area-observer', type: 'spell', actorId: 'mage', spellId: 'burning-hands', spellName: 'Огненные ладони',
    from: { x: 1, y: 2 }, to: { x: 4, y: 2 }, area: { x: 4, y: 2, radiusFeet: 15, shape: 'cube', area_origin: 'point' },
  }])
  assert.equal(cue.kind, 'burst')
  assert.deepEqual(cue.center, { x: 4, y: 2 })
  assert.equal(cue.shape, 'cube')
  assert.equal(cue.sizeFeet, 15)
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
  const renderer = effects.createSpellEffectRenderer({ cue, progress: .75, actors: [actor('mage', 0, 0)], reducedMotion: false })
  render.drawBoardEffects(context, boardScene, [renderer])
  assert.equal(context.ops.filter((operation) => operation.op === 'fillRect').length, 0)
  assert.equal(context.ops.filter((operation) => operation.op === 'strokeRect').length, 0)
  assert.ok(context.ops.some((operation) => operation.op === 'fill'))
  assert.ok(context.ops.some((operation) => operation.op === 'lineTo'))
  assert.equal(context.ops.filter((operation) => operation.op === 'save').length, context.ops.filter((operation) => operation.op === 'restore').length)
})

test('spellBurstCells переиспользует union области крупного заклинателя и умеет вернуть fog footprint', () => {
  const board = scene(10, 8)
  setCell(board.map, 3, 1, { revealed: false })
  const cue = {
    id: 'large-line', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'lightning-bolt', school: 'evocation',
    origin: { x: 1, y: 1 }, center: { x: 6, y: 1 }, shape: 'line', originMode: 'self', sizeFeet: 10, durationMs: 480,
  }
  const actors = [{ id: 'mage', x: 1, y: 1, footprint: { version: 1, size: 2 } }]
  const all = effects.spellBurstCells(board.map, cue, actors, { includeHidden: true })
  const visible = effects.spellBurstCells(board.map, cue, actors)
  assert.ok(all.some((cell) => cell.x === 4 && cell.y === 1), 'вторая клетка footprint должна продлить линию')
  assert.ok(all.length > visible.length, 'fog footprint должен быть доступен 3D-проверке, но не 2D рисунку')
  assert.equal(visible.some((cell) => cell.x === 3 && cell.y === 1), false)
})

test('огненный шар летит к подтверждённой точке и только затем раскрывает площадь', () => {
  const [cue] = animation.combatAnimationCuesFromEvents([{
    event_id: 'cast-fireball-flight', command_id: 'fireball-flight', event_type: 'SpellCast', actor_id: 'mage', target_ids: ['goblin'],
    payload: { spell_id: 'fireball', kind: 'area-save', damage_type: 'fire' },
  }])
  const actors = [actor('mage', 1, 1), actor('goblin', 5, 1)]
  const flight = recordingContext()
  render.drawBoardEffects(flight, scene(), [effects.createSpellEffectRenderer({ cue, progress: .25, actors, reducedMotion: false })])
  assert.ok(flight.ops.some((operation) => operation.op === 'lineTo'), 'снаряд должен иметь видимую траекторию')
  assert.equal(flight.ops.some((operation) => operation.op === 'fillRect'), false, 'площадь не должна появляться до взрыва')

  const explosion = recordingContext()
  render.drawBoardEffects(explosion, scene(), [effects.createSpellEffectRenderer({ cue, progress: .9, actors, reducedMotion: false })])
  assert.ok(explosion.ops.some((operation) => operation.op === 'fill'), 'после полёта должна быть видна площадь взрыва')
})

test('огненный burst рисует движущиеся клубы, а не одинаковые стрелки по клеткам', () => {
  const cue = {
    id: 'fireball-clouds', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation',
    origin: { x: 1, y: 1 }, center: { x: 4, y: 3 }, shape: 'sphere', sizeFeet: 20, durationMs: 850,
  }
  const actors = [actor('mage', 1, 1)]
  const context = recordingContext()
  effects.drawSpellEffect(context, scene(), { cue, actors, progress: 1, detail: 'full', reducedMotion: false })
  const clouds = context.ops.filter((operation) => operation.op === 'arc')
  assert.ok(clouds.length >= 16, 'у огненной волны должно быть несколько клубов и ядер')
  assert.ok(new Set(clouds.map((operation) => `${operation.x}:${operation.y}`)).size >= 8, 'клубы должны иметь разные движущиеся центры')
  assert.ok(Math.max(...clouds.map((operation) => operation.y)) - Math.min(...clouds.map((operation) => operation.y)) > 4 * 24,
    'клубы охватывают область, а не собираются в первых двух рядах клеток')
  assert.ok(context.ops.some((operation) => operation.op === 'set' && operation.property === 'fillStyle' && operation.value === '#e85b2f'))
  assert.ok(context.ops.some((operation) => operation.op === 'set' && operation.property === 'fillStyle' && operation.value === '#ffd27a'))
  assert.equal(context.ops.some((operation) => operation.op === 'strokeRect'), false)
})

test('явные miss и blocked не получают 2D вспышку попадания', () => {
  const actors = [actor('mage', 1, 1), actor('target', 5, 1), actor('other', 5, 3)]
  const projectile = {
    id: 'miss-projectile', kind: 'projectile', actorId: 'mage', targetIds: ['target'], from: { x: 1, y: 1 }, to: { x: 5, y: 1 },
    projectileCount: 1, spellId: 'fire-bolt', school: 'evocation', durationMs: 520, targetOutcomes: { target: 'miss' },
  }
  const projectileContext = recordingContext()
  effects.drawSpellEffect(projectileContext, scene(), { cue: projectile, actors, progress: 1, detail: 'full', reducedMotion: false })
  assert.equal(projectileContext.ops.some((operation) => operation.op === 'arc'), false)

  const beam = {
    id: 'blocked-beam', kind: 'beam', actorId: 'mage', targetIds: ['other'], from: { x: 1, y: 1 }, points: [{ x: 5, y: 3 }],
    spellId: 'chain-lightning', school: 'evocation', durationMs: 560, chain: true, targetOutcomes: { other: 'blocked' },
  }
  const beamContext = recordingContext()
  effects.drawSpellEffect(beamContext, scene(), { cue: beam, actors, progress: 1, detail: 'full', reducedMotion: false })
  assert.equal(beamContext.ops.some((operation) => operation.op === 'arc'), false)
})

test('линия молнии, лёд и паутина получают собственный рисунок по реальным клеткам', () => {
  const actors = [actor('mage', 1, 4), actor('goblin', 6, 4)]
  const lightningContext = recordingContext()
  render.drawBoardEffects(lightningContext, scene(), [effects.createSpellEffectRenderer({
    cue: {
      id: 'bolt', kind: 'burst', actorId: 'mage', targetIds: ['goblin'], spellId: 'lightning-bolt', school: 'evocation',
      shape: 'line', originMode: 'self', sizeFeet: 100, durationMs: 480,
    }, progress: .8, actors, reducedMotion: false,
  })])
  assert.ok(lightningContext.ops.some((operation) => operation.op === 'lineTo'))
  assert.equal(lightningContext.ops.some((operation) => operation.op === 'fillRect'), false)

  const wallContext = recordingContext()
  render.drawBoardEffects(wallContext, scene(), [effects.createSpellEffectRenderer({
    cue: {
      id: 'wall', kind: 'burst', actorId: 'mage', targetIds: ['goblin'], spellId: 'wall-of-fire', school: 'evocation',
      shape: 'line', sizeFeet: 10, damageType: 'fire', durationMs: 480,
    }, progress: .8, actors, reducedMotion: false,
  })])
  assert.ok(wallContext.ops.some((operation) => operation.op === 'fill'), 'стена остаётся клеточной line-областью')
  assert.ok(wallContext.ops.some((operation) => operation.op === 'arc'), 'огненная line-область получает bounded flame clouds')

  const coldContext = recordingContext()
  render.drawBoardEffects(coldContext, scene(), [effects.createSpellEffectRenderer({
    cue: {
      id: 'ice', kind: 'burst', actorId: 'mage', targetIds: ['goblin'], spellId: 'ice-storm', school: 'evocation',
      shape: 'sphere', sizeFeet: 10, durationMs: 480,
    }, progress: .7, actors, reducedMotion: false,
  })])
  assert.ok(coldContext.ops.some((operation) => operation.op === 'closePath'), 'лёд должен читаться кристаллической формой')

  const webContext = recordingContext()
  render.drawBoardEffects(webContext, scene(), [effects.createSpellEffectRenderer({
    cue: {
      id: 'web', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'web', school: 'conjuration', cells: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 }],
      center: { x: 2, y: 2 }, shape: 'cube', sizeFeet: 10, durationMs: 480,
    }, progress: .7, actors, reducedMotion: false,
  })])
  assert.ok(webContext.ops.filter((operation) => operation.op === 'lineTo').length >= 6, 'паутина должна иметь нити, а не только заливку')
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

test('лечение поднимается мягкими потоками вверх', () => {
  const context = recordingContext()
  render.drawBoardEffects(context, scene(), [effects.createSpellEffectRenderer({
    cue: { id: 'heal-rise', kind: 'channel', actorId: 'cleric', targetId: 'cleric', channelType: 'healing', amount: 6, spellId: 'healing-word', school: 'evocation', durationMs: 480 },
    progress: .65, actors: [actor('cleric', 3, 3)], reducedMotion: false,
  })])
  assert.ok(context.ops.some((operation) => operation.op === 'lineTo'))
})

test('teleport channel рисует departure и arrival portals без физического луча', () => {
  const cue = {
    id: 'teleport', kind: 'channel', actorId: 'mage', targetId: undefined, from: { x: 1, y: 1 }, position: { x: 4, y: 1 },
    channelType: 'teleport', spellId: 'misty-step', school: 'conjuration', durationMs: 480,
  }
  const actors = [actor('mage', 1, 1)]
  const departure = recordingContext()
  effects.drawSpellEffect(departure, scene(), { cue, actors, progress: .2, detail: 'full', reducedMotion: false })
  assert.ok(departure.ops.some((operation) => operation.op === 'arc' && operation.x === 36), 'портал должен начинаться у from')
  assert.equal(departure.ops.some((operation) => operation.op === 'lineTo' && operation.x > 60), false, 'телепорт не должен рисовать луч через стены')

  const arrival = recordingContext()
  effects.drawSpellEffect(arrival, scene(), { cue, actors, progress: .8, detail: 'full', reducedMotion: false })
  assert.ok(arrival.ops.some((operation) => operation.op === 'arc' && operation.x === 108), 'портал должен появляться у position')
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

test('молния, направленная влево, начинает раскрываться у заклинателя', () => {
  const context = recordingContext()
  effects.drawSpellEffect(context, scene(), {
    cue: { id: 'left-bolt', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'lightning-bolt', school: 'evocation',
      origin: { x: 6, y: 3 }, center: { x: 5, y: 3 }, shape: 'line', originMode: 'self', sizeFeet: 25, durationMs: 480 },
    actors: [actor('mage', 6, 3)], progress: .3, reducedMotion: false, detail: 'reduced',
  })
  const start = context.ops.find((operation) => operation.op === 'moveTo')
  assert.equal(start.x, 5.5 * 24)
  assert.equal(start.y, 3.5 * 24)
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

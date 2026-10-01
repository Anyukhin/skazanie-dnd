import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(repositoryRoot, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(repositoryRoot, 'tmp', 'combat-audio-'))
mkdirSync(join(buildDir, 'server'), { recursive: true })
copyFileSync(join(repositoryRoot, 'server', 'circular-area-geometry.mjs'), join(buildDir, 'server', 'circular-area-geometry.mjs'))
copyFileSync(join(repositoryRoot, 'server', 'equipment-visuals.mjs'), join(buildDir, 'server', 'equipment-visuals.mjs'))
copyFileSync(join(repositoryRoot, 'server', 'actor-footprint.mjs'), join(buildDir, 'server', 'actor-footprint.mjs'))
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))
const compiled = spawnSync(process.execPath, [
  join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext',
  '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--resolveJsonModule',
  '--esModuleInterop', '--rootDir', repositoryRoot, '--outDir', buildDir, join(repositoryRoot, 'src/combat-audio.ts'),
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
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => /\.(json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`)
  writeFileSync(path, rewritten)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const {
  combatAudioProfile, createCombatAudio, resolveCombatAudioPlan, COMBAT_AUDIO_ATTACK_STYLES, COMBAT_AUDIO_VOICE_LIMIT,
  COMBAT_AUDIO_CLIP_VOICE_LIMIT, COMBAT_AUDIO_FAMILIES, COMBAT_AUDIO_SCHOOL_FAMILIES, COMBAT_AUDIO_RATE_SPREAD, COMBAT_AUDIO_GAIN_SPREAD_DB,
  COMBAT_AUDIO_MAX_PAN, combatAudioVariation, combatAudioClipOrder, combatAudioStereoPan, combatAudioSpatialFromScreen,
  combatAudioPhaseSpatial, combatAudioPhaseGain, combatAudioFadeMs, combatAudioDuckDepth, combatAudioDuplicatePhase,
} = await import(pathToFileURL(join(buildDir, 'src/combat-audio.mjs')).href)
const { spellVisualAudit } = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)

class FakeParam {
  constructor(value = 0) { this.value = value; this.events = [] }
  cancelScheduledValues(at) { this.events.push(['cancel', at]) }
  setValueAtTime(value, at) { this.value = value; this.events.push(['set', value, at]) }
  linearRampToValueAtTime(value, at) { this.value = value; this.events.push(['ramp', value, at]) }
}

class FakeGain {
  constructor() { this.gain = new FakeParam() }
  connect(destination) { this.destination = destination; return destination }
  disconnect() { this.disconnected = true }
}

class FakeSource {
  constructor() { this.listeners = new Map(); this.starts = []; this.stops = [] }
  connect(destination) { this.destination = destination; return destination }
  disconnect() { this.disconnected = true }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  start(when) { this.starts.push(when) }
  stop(when) { this.stops.push(when); if (when <= 10) this.listeners.get('ended')?.() }
}

class FakeCompressor extends FakeGain {
  constructor() {
    super()
    this.threshold = new FakeParam()
    this.knee = new FakeParam()
    this.ratio = new FakeParam()
    this.attack = new FakeParam()
    this.release = new FakeParam()
  }
}

class FakeContext {
  constructor() { this.state = 'suspended'; this.currentTime = 10; this.destination = {} ; this.sources = []; this.gains = [] }
  createGain() { const gain = new FakeGain(); this.gains.push(gain); return gain }
  createDynamicsCompressor() { return new FakeCompressor() }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
}

function timers() {
  const queue = []
  return {
    queue,
    setTimeout(handler, delay) { const timer = { handler, delay, cancelled: false }; queue.push(timer); return timer },
    clearTimeout(timer) { timer.cancelled = true },
    flush: async () => {
      for (const timer of [...queue].sort((left, right) => left.delay - right.delay)) {
        if (!timer.cancelled) timer.handler()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      }
    },
  }
}

const strike = {
  id: 'attack-1', kind: 'strike', actorId: 'hero', targetId: 'goblin', hit: true, amount: 8,
  attackKind: 'ranged', equipment: 'bow', durationMs: 500,
}
const fireball = {
  id: 'spell-1', kind: 'burst', actorId: 'hero', targetIds: ['goblin'], spellId: 'fireball', school: 'evocation',
  shape: 'sphere', sizeFeet: 20, durationMs: 480,
}

test('повтор HTTP/SSE Скорохода и переподключение не повторяют звук одного накладывания на несколько целей', async () => {
  const context = new FakeContext()
  const clock = timers()
  const audio = createCombatAudio({ muted: false, audioContextFactory: () => context,
    manifest: { version: 1, clips: { cast: { url: '/sfx/longstrider.ogg' } }, profiles: { 'spell:mobility': { cast: ['cast'] } } },
    loader: async () => ({ duration: .12 }), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  await audio.unlock()
  const cue = { id: 'committed-longstrider:channel', kind: 'channel', actorId: 'caster', targetId: 'caster', targetIds: ['caster', 'ally'], spellId: 'longstrider', school: 'transmutation', channelType: 'cast', durationMs: 400 }
  assert.ok(audio.schedule(cue))
  await clock.flush()
  await new Promise((resolve) => setImmediate(resolve))
  const firstCount = context.sources.length
  assert.ok(firstCount > 0)
  assert.equal(audio.schedule({ ...cue }), null)
  audio.setVisible(false)
  audio.setVisible(true)
  assert.equal(audio.schedule({ ...cue }), null)
  await clock.flush()
  assert.equal(context.sources.length, firstCount)
  await audio.dispose()
})

test('профиль боя делит запись по семейству, форме cue и фазе', () => {
  const manifest = {
    version: 1,
    clips: {
      'bow-hit': { url: '/recorded/bow-hit.ogg', durationMs: 140, sourceId: 'qa-bow' },
      'fire-burst': { url: '/recorded/fire-burst.ogg', durationMs: 240, sourceId: 'qa-fire' },
    },
    profiles: {
      'attack:bow': { impact: ['bow-hit'] },
      'spell:flame': { impact: ['fire-burst'] },
    },
  }
  const attack = combatAudioProfile(strike, 'contact', manifest)
  assert.equal(attack.key, 'attack:bow')
  assert.equal(attack.url, '/recorded/bow-hit.ogg')
  const spell = combatAudioProfile(fireball, 'contact', manifest)
  assert.equal(spell.key, 'spell:flame')
  assert.equal(spell.url, '/recorded/fire-burst.ogg')
})

test('actor-aware attack profile совпадает с визуальным natural/unarmed стилем', () => {
  const manifest = {
    version: 1,
    clips: {
      natural: { url: '/recorded/natural.ogg' },
      unarmed: { url: '/recorded/unarmed.ogg' },
    },
    profiles: {
      'attack:natural': { impact: ['natural'] },
      'attack:unarmed': { impact: ['unarmed'] },
    },
  }
  const unarmed = { ...strike, id: 'unarmed-hero', attackKind: 'melee', equipment: 'unarmed' }
  assert.equal(combatAudioProfile(unarmed, 'contact', manifest, { actor: { kind: 'humanoid', archetype: 'human' } }).key, 'attack:unarmed')
  assert.equal(combatAudioProfile(unarmed, 'contact', manifest, { actor: { kind: 'beast', archetype: 'wolf', appearance: { profile: 'beast' } } }).key, 'attack:natural')
  assert.equal(resolveCombatAudioPlan(unarmed, manifest, { actor: { archetype: 'wolf' } })[0].profileKey, 'attack:natural')
})

test('thunder-step departure uses thunder sound while teleport channel keeps portal sounds', () => {
  const manifest = {
    version: 1,
    clips: {
      'thunder-cast': { url: '/recorded/thunder-cast.ogg' },
      'thunder-impact': { url: '/recorded/thunder-impact.ogg' },
      'teleport-out': { url: '/recorded/teleport-out.ogg' },
      'teleport-in': { url: '/recorded/teleport-in.ogg' },
    },
    profiles: {
      'spell:thunder': { cast: ['thunder-cast'], impact: ['thunder-impact'] },
      'spell:teleport': { cast: ['teleport-out'], impact: ['teleport-in'] },
    },
  }
  const departure = {
    id: 'thunder-step:departure', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'thunder-step',
    school: 'conjuration', shape: 'sphere', originMode: 'point', sizeFeet: 10, durationMs: 420,
    center: { x: 1, y: 2 }, from: { x: 1, y: 2 }, presentationPhase: 'departure', visualFamily: 'thunder',
  }
  const channel = {
    id: 'thunder-step:channel', kind: 'channel', actorId: 'mage', targetId: 'mage', spellId: 'thunder-step',
    school: 'conjuration', channelType: 'teleport', from: { x: 1, y: 2 }, position: { x: 8, y: 2 }, durationMs: 480,
  }
  assert.equal(resolveCombatAudioPlan(departure, manifest)[0].profileKey, 'spell:thunder')
  assert.deepEqual(resolveCombatAudioPlan(channel, manifest).map((entry) => entry.profileKey), ['spell:teleport', 'spell:teleport'])
})

test('подтверждённый spell miss выбирает miss clip, неизвестный исход не подменяется', () => {
  const manifest = {
    version: 1,
    clips: {
      hit: { url: '/recorded/hit.ogg' }, miss: { url: '/recorded/miss.ogg' },
    },
    profiles: {
      'spell:flame': { impact: ['hit'], miss: ['miss'] },
    },
  }
  const hit = combatAudioProfile({ ...fireball, id: 'spell-hit', targetOutcomes: { goblin: 'hit' } }, 'contact', manifest)
  const miss = combatAudioProfile({ ...fireball, id: 'spell-miss', targetOutcomes: { goblin: 'miss' } }, 'contact', manifest)
  const blocked = combatAudioProfile({ ...fireball, id: 'spell-blocked', targetOutcomes: { goblin: 'blocked' } }, 'contact', manifest)
  const unknown = combatAudioProfile({ ...fireball, id: 'spell-unknown' }, 'contact', manifest)
  assert.deepEqual(hit.clipIds, ['hit'])
  assert.deepEqual(miss.clipIds, ['miss'])
  assert.deepEqual(blocked.clipIds, ['miss'])
  assert.deepEqual(unknown.clipIds, ['hit'])
})

test('план сохраняет реальные моменты launch/contact и выявляет отсутствующий clip', () => {
  const manifest = {
    version: 1,
    clips: { cast: { url: 'audio/combat/cast.ogg' }, impact: { url: '/assets/audio/combat/impact.ogg' } },
    profiles: { 'spell:flame': { cast: ['cast'], impact: ['impact'] } },
  }
  const plan = resolveCombatAudioPlan(fireball, manifest)
  assert.deepEqual(plan.map((entry) => [entry.phase, entry.atMs]), [['start', 0], ['contact', 268.8]])
  assert.deepEqual(plan.map((entry) => entry.windowMs), [268.8, 1400])
  assert.deepEqual(plan[0].urls, ['/assets/audio/combat/cast.ogg'])
  const missing = resolveCombatAudioPlan({ ...fireball, id: 'missing' }, { version: 1, clips: {}, profiles: { 'spell:flame': { cast: ['unknown'] } } })
  assert.deepEqual(missing[0].urls, [])
  const bowPlan = resolveCombatAudioPlan({ ...strike, durationMs: 480 }, manifest)
  assert.equal(bowPlan[0].windowMs, 96, 'bow cast window ends at launch: 96ms')
})

test('recorded manifest покрывает soundFamily каталога и все физические стили', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'public/assets/audio/combat/manifest.json'), 'utf8'))
  const referenced = new Set()
  for (const entry of spellVisualAudit()) {
    const profile = manifest.profiles[`spell:${entry.soundFamily}`]
    assert.ok(profile, `нет audio profile для ${entry.soundFamily} (${entry.id})`)
    for (const [phase, clipIds] of Object.entries(profile)) {
      if (!['cast', 'launch', 'impact', 'miss', 'critical', 'blocked'].includes(phase)) continue
      for (const clipId of Array.isArray(clipIds) ? clipIds : [clipIds]) referenced.add(clipId)
    }
  }
  for (const style of COMBAT_AUDIO_ATTACK_STYLES) {
    const profile = manifest.profiles[`attack:${style}`]
    assert.ok(profile, `нет audio profile для attack:${style}`)
    for (const [phase, clipIds] of Object.entries(profile)) {
      if (!['cast', 'launch', 'impact', 'miss', 'critical', 'blocked'].includes(phase)) continue
      for (const clipId of Array.isArray(clipIds) ? clipIds : [clipIds]) referenced.add(clipId)
    }
  }
  for (const clipId of referenced) assert.ok(manifest.clips[clipId]?.url, `profile ссылается на отсутствующий clip ${clipId}`)
})

test('schedule запускает start/launch/contact в фазах cue и не дублирует event/log', async () => {
  const context = new FakeContext()
  const clock = timers()
  const loaded = []
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: {
      version: 1,
      clips: {
        start: { url: '/sfx/start.ogg' }, launch: { url: '/sfx/launch.ogg' }, contact: { url: '/sfx/contact.ogg' },
      },
      profiles: {
        'attack:bow': { cast: ['start'], launch: ['launch'], impact: ['contact'] },
      },
    },
    loader: async (url) => { loaded.push(url); return { duration: .12 } },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  assert.equal(await audio.unlock(), true)
  assert.ok(await audio.playCue(strike))
  assert.equal(clock.queue.length, 3)
  assert.equal(await audio.playCue(strike), false)
  await clock.flush()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(loaded, ['/sfx/start.ogg', '/sfx/launch.ogg', '/sfx/contact.ogg'])
  assert.equal(context.sources.length, 3, `${JSON.stringify(loaded)} / ${context.sources.length}`)
  await audio.dispose()
})

test('envelope держит голос до fade window и затихает только перед stop', async () => {
  const context = new FakeContext()
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: { version: 1, clips: { cast: { url: '/sfx/cast.ogg' } }, profiles: { 'attack:bow': { cast: ['cast'] } } },
    loader: async () => ({ duration: .48 }),
  })
  await audio.unlock()
  assert.equal(await audio.playCue(strike, 'start'), true)
  const voiceGain = context.gains.at(-1)
  assert.ok(voiceGain)
  // Пик голоса — уровень фазы cast с разбросом повтора, а не единица.
  const peak = voiceGain.gain.events.find((event) => event[0] === 'set')?.[1]
  assert.ok(peak > 0 && peak < 1, `cast должен звучать тише попадания, пик ${peak}`)
  const hold = voiceGain.gain.events.filter((event) => event[0] === 'set' && event[1] === peak)
  const ramp = voiceGain.gain.events.find((event) => event[0] === 'ramp')
  const stop = context.sources.at(-1)?.stops.at(-1)
  assert.ok(hold.some((event) => event[2] > 10), 'gain должен держать пик до конца окна')
  assert.ok(ramp && ramp[1] === 0 && ramp[2] === stop, 'затухание должно прийтись на последние миллисекунды')
  await audio.dispose()
})

test('пустой cast физической атаки означает тишину до launch/contact', async () => {
  const manifest = {
    version: 1,
    clips: {
      launch: { url: '/sfx/launch.ogg' }, impact: { url: '/sfx/impact.ogg' },
    },
    profiles: {
      'attack:firearm': { cast: [], launch: ['launch'], impact: ['impact'] },
      'attack:bludgeon': { cast: [], impact: ['impact'] },
    },
  }
  const firearmContext = new FakeContext()
  const firearmClock = timers()
  const firearmAudio = createCombatAudio({
    muted: false,
    audioContextFactory: () => firearmContext,
    manifest,
    loader: async () => ({ duration: .2 }),
    setTimeout: firearmClock.setTimeout,
    clearTimeout: firearmClock.clearTimeout,
  })
  await firearmAudio.unlock()
  const firearm = { ...strike, id: 'silent-firearm-cast', attackKind: 'ranged', equipment: 'unknown', loadout: { main_hand: { model_key: 'musket' } }, durationMs: 480 }
  firearmAudio.schedule(firearm)
  firearmClock.queue.find((timer) => timer.delay === 0)?.handler()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(firearmContext.sources.length, 0, 'пустой firearm cast не должен звучать на старте')
  firearmClock.queue.find((timer) => timer.delay === 96)?.handler()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(firearmContext.sources.length, 1, 'firearm launch должен звучать на фазе выпуска')
  await firearmAudio.dispose()

  const bludgeonContext = new FakeContext()
  const bludgeonClock = timers()
  const bludgeonAudio = createCombatAudio({
    muted: false,
    audioContextFactory: () => bludgeonContext,
    manifest,
    loader: async () => ({ duration: .2 }),
    setTimeout: bludgeonClock.setTimeout,
    clearTimeout: bludgeonClock.clearTimeout,
  })
  await bludgeonAudio.unlock()
  const bludgeon = { ...strike, id: 'silent-bludgeon-cast', attackKind: 'melee', equipment: 'staff', durationMs: 480 }
  bludgeonAudio.schedule(bludgeon)
  bludgeonClock.queue.find((timer) => timer.delay === 0)?.handler()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(bludgeonContext.sources.length, 0, 'пустой bludgeon cast не должен давать ранний impact')
  bludgeonClock.queue.find((timer) => timer.delay === 144)?.handler()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bludgeonContext.sources.length, 1, 'bludgeon impact должен звучать только на контакте')
  await bludgeonAudio.dispose()
})

test('mute, visibility и cancel не оставляют отложенное звучание', async () => {
  const context = new FakeContext()
  const clock = timers()
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    loader: async () => ({ duration: .12 }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  await audio.unlock()
  audio.setMuted(true)
  assert.equal(await audio.playCue(fireball), false)
  audio.setMuted(false)
  const scheduled = audio.schedule(fireball)
  assert.ok(scheduled)
  audio.setVisible(false)
  await clock.flush()
  assert.equal(context.sources.length, 0)
  audio.setVisible(true)
  const next = audio.schedule({ ...fireball, id: 'spell-2' })
  assert.ok(next)
  next.cancel()
  await clock.flush()
  assert.equal(context.sources.length, 0)
  await audio.dispose()
})

test('до explicit unlock движок не создаёт источник и не грузит запись', async () => {
  const context = new FakeContext()
  let loads = 0
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: { version: 1, clips: { cast: { url: '/sfx/cast.ogg' } }, profiles: { 'spell:flame': { cast: ['cast'] } } },
    loader: async () => { loads += 1; return { duration: .12 } },
  })
  assert.equal(await audio.playCue(fireball), false)
  assert.equal(loads, 0)
  assert.equal(context.sources.length, 0)
  await audio.dispose()
})

test('dispose останавливает проигрываемые источники и закрывает context', async () => {
  const context = new FakeContext()
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: { version: 1, clips: { start: { url: '/sfx/start.ogg' } }, profiles: { 'attack:bow': { cast: ['start'] } } },
    loader: async () => ({ duration: .12 }),
  })
  await audio.unlock()
  assert.equal(await audio.playCue(strike, 'start'), true)
  const source = context.sources[0]
  await audio.dispose()
  assert.equal(context.state, 'closed')
  assert.equal(source.stops.at(-1), 10)
})

// Перехваченный лимитом голос гаснет за 15 мс, а не обрывается в ту же секунду.
const stolen = (source) => source.stops.some((when) => when < 10.05)

test('voice cap ограничивает одновременно звучащие длинные clips', async () => {
  const context = new FakeContext()
  // Десять семейств — десять разных записей: проверяется общий лимит, а не
  // лимит одной записи.
  const spells = ['fire-bolt', 'ray-of-frost', 'shocking-grasp', 'thunderwave', 'acid-splash', 'poison-spray', 'chill-touch', 'sacred-flame', 'magic-missile', 'mind-sliver']
  const families = ['flame', 'frost', 'electric', 'thunder', 'acid', 'poison', 'necrotic', 'radiant', 'force', 'psychic']
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: {
      version: 1,
      clips: Object.fromEntries(families.map((family) => [family, { url: `/sfx/${family}.ogg` }])),
      profiles: Object.fromEntries(families.map((family) => [`spell:${family}`, { cast: [family] }])),
    },
    loader: async () => ({ duration: 8 }),
  })
  await audio.unlock()
  await Promise.all(spells.map((spellId, index) => audio.playCue({
    id: `voice-${index}`, kind: 'channel', actorId: 'mage', spellId, school: 'evocation', channelType: 'cast', durationMs: 400,
  }, 'start')))
  assert.equal(context.sources.length, spells.length)
  assert.equal(context.sources.filter((source) => !stolen(source)).length, COMBAT_AUDIO_VOICE_LIMIT)
  await audio.dispose()
})

test('одна запись звучит не больше чем COMBAT_AUDIO_CLIP_VOICE_LIMIT голосами', async () => {
  const context = new FakeContext()
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: { version: 1, clips: { cast: { url: '/sfx/cast.ogg' } }, profiles: { 'attack:bow': { cast: ['cast'] } } },
    loader: async () => ({ duration: 8 }),
  })
  await audio.unlock()
  for (let index = 0; index < 5; index += 1) await audio.playCue({ ...strike, id: `same-clip-${index}` }, 'start')
  assert.equal(context.sources.length, 5)
  assert.equal(context.sources.filter((source) => !stolen(source)).length, COMBAT_AUDIO_CLIP_VOICE_LIMIT)
  // Снимаются самые старые голоса, а свежий удар звучит.
  assert.ok(!stolen(context.sources.at(-1)))
  assert.ok(stolen(context.sources[0]))
  await audio.dispose()
})

test('поздний decode после cancel или mute не создаёт источник', async () => {
  const context = new FakeContext()
  const clock = timers()
  const resolvers = []
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: { version: 1, clips: { cast: { url: '/sfx/cast.ogg' } }, profiles: { 'attack:bow': { cast: ['cast'] } } },
    loader: async () => new Promise((resolve) => { resolvers.push(resolve) }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  await audio.unlock()
  const first = audio.schedule({ ...strike, id: 'late-cancel' })
  assert.ok(first)
  clock.queue[0].handler()
  await Promise.resolve()
  await Promise.resolve()
  first.cancel()
  resolvers.shift()?.({ duration: 2 })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(context.sources.length, 0)
  const second = audio.schedule({ ...strike, id: 'late-mute' })
  assert.ok(second)
  const nextTimer = clock.queue.find((timer) => !timer.cancelled && timer !== clock.queue[0])
  nextTimer?.handler()
  await Promise.resolve()
  await Promise.resolve()
  audio.setMuted(true)
  resolvers.shift()?.({ duration: 2 })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(context.sources.length, 0)
  await audio.dispose()
})

test('явные фазы одного cue не блокируют contact, но повтор фазы дедуплицируется', async () => {
  const context = new FakeContext()
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: {
      version: 1,
      clips: { cast: { url: '/sfx/cast.ogg' }, impact: { url: '/sfx/impact.ogg' } },
      profiles: { 'attack:bow': { cast: ['cast'], impact: ['impact'] } },
    },
    loader: async () => ({ duration: .2 }),
  })
  const cue = { ...strike, id: 'direct-phase-1' }
  await audio.unlock()
  assert.equal(await audio.playCue(cue, 'start'), true)
  assert.equal(await audio.playCue(cue, 'contact'), true)
  assert.equal(await audio.playCue(cue, 'contact'), false)
  assert.equal(context.sources.length, 2)
  await audio.dispose()
})

test('cancel, скрытие и schedule не разрешают поздний direct contact', async () => {
  const context = new FakeContext()
  const clock = timers()
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: {
      version: 1,
      clips: { cast: { url: '/sfx/cast.ogg' }, impact: { url: '/sfx/impact.ogg' } },
      profiles: { 'attack:bow': { cast: ['cast'], impact: ['impact'] } },
    },
    loader: async () => ({ duration: .2 }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  await audio.unlock()

  const cancelled = { ...strike, id: 'direct-cancel' }
  assert.equal(await audio.playCue(cancelled, 'start'), true)
  audio.cancel()
  assert.equal(await audio.playCue(cancelled, 'contact'), false)

  const hidden = { ...strike, id: 'direct-hidden' }
  assert.equal(await audio.playCue(hidden, 'start'), true)
  audio.setVisible(false)
  audio.setVisible(true)
  assert.equal(await audio.playCue(hidden, 'contact'), false)

  const scheduled = { ...strike, id: 'scheduled-direct' }
  assert.ok(audio.schedule(scheduled))
  assert.equal(await audio.playCue(scheduled, 'contact'), false)
  await audio.dispose()
})

test('Отмена помнит завершённый звук и разрешает новый предпросмотр', async () => {
  const context = new FakeContext()
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: {
      version: 1,
      clips: { cast: { url: '/sfx/cast.ogg' }, impact: { url: '/sfx/impact.ogg' } },
      profiles: { 'attack:bow': { cast: ['cast'], impact: ['impact'] } },
    },
    loader: async () => ({ duration: .2 }),
  })
  await audio.unlock()
  const cue = { ...strike, id: 'direct-ended-cancel' }
  assert.equal(await audio.playCue(cue, 'start'), true)
  context.sources[0].listeners.get('ended')?.()
  audio.cancel(cue.id)
  assert.equal(await audio.playCue(cue, 'contact'), false)
  assert.equal(await audio.playCue(cue, 'contact', { preview: true }), true)
  await audio.dispose()
})

test('Отмена подавляет звук, пока декодирование ещё ожидается', async () => {
  const context = new FakeContext()
  const resolvers = []
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: {
      version: 1,
      clips: { cast: { url: '/sfx/cast.ogg' } },
      profiles: { 'attack:bow': { cast: ['cast'] } },
    },
    loader: async () => new Promise((resolve) => resolvers.push(resolve)),
  })
  await audio.unlock()

  const explicit = { ...strike, id: 'direct-pending-explicit' }
  const first = audio.playCue(explicit, 'start')
  await Promise.resolve(); await Promise.resolve()
  audio.cancel(explicit.id)
  resolvers.shift()?.({ duration: .2 })
  assert.equal(await first, false)
  assert.equal(context.sources.length, 0)

  const all = { ...strike, id: 'direct-pending-all' }
  const second = audio.playCue(all, 'start')
  await Promise.resolve(); await Promise.resolve()
  audio.cancel()
  resolvers.shift()?.({ duration: .2 })
  assert.equal(await second, false)
  assert.equal(context.sources.length, 0)
  await audio.dispose()
})

// --- Вариации, уровни, панорама и покрытие записями (2026-10-01) ---

class PannerContext extends FakeContext {
  constructor() { super(); this.panners = [] }
  createStereoPanner() { const panner = new FakeGain(); panner.pan = new FakeParam(); this.panners.push(panner); return panner }
}

class RateSource extends FakeSource {
  constructor() { super(); this.playbackRate = new FakeParam(1) }
}

class RateContext extends PannerContext {
  createBufferSource() { const source = new RateSource(); this.sources.push(source); return source }
}

const voicePeak = (gain) => gain.gain.events.find((event) => event[0] === 'set')?.[1]

test('разброс повтора: скорость ±5 %, громкость ±1.5 дБ, повтор той же реплики стабилен', () => {
  const rates = new Set()
  for (let index = 0; index < 40; index += 1) {
    const variation = combatAudioVariation(`attack-${index}:contact:attack-sword-impact`)
    assert.ok(Math.abs(variation.playbackRate - 1) <= COMBAT_AUDIO_RATE_SPREAD + 1e-9, `rate ${variation.playbackRate}`)
    assert.ok(Math.abs(variation.gainDb) <= COMBAT_AUDIO_GAIN_SPREAD_DB + 1e-9, `gain ${variation.gainDb}`)
    assert.ok(Math.abs(variation.gain - 10 ** (variation.gainDb / 20)) < 1e-9)
    rates.add(variation.playbackRate)
  }
  assert.ok(rates.size >= 30, `серия ударов не должна повторять одну скорость: ${rates.size}`)
  assert.deepEqual(combatAudioVariation('same:contact:x'), combatAudioVariation('same:contact:x'))
  // Крит тяжелее того же удара, но не уходит в «замедленную плёнку».
  const hit = combatAudioVariation('crit-seed', 'impact')
  const crit = combatAudioVariation('crit-seed', 'critical')
  assert.ok(crit.playbackRate < hit.playbackRate)
  assert.ok(crit.playbackRate >= .9)
})

test('выбор варианта не повторяет только что звучавший и сохраняет запасные', () => {
  assert.deepEqual(combatAudioClipOrder(['only'], 'seed', 'only'), ['only'])
  assert.deepEqual(combatAudioClipOrder([], 'seed'), [])
  for (let index = 0; index < 20; index += 1) {
    const order = combatAudioClipOrder(['a', 'b', 'c'], `seed-${index}`, 'b')
    assert.notEqual(order[0], 'b')
    assert.deepEqual([...order].sort(), ['a', 'b', 'c'])
  }
  const starts = new Set(Array.from({ length: 30 }, (_, index) => combatAudioClipOrder(['a', 'b', 'c'], `pick-${index}`)[0]))
  assert.equal(starts.size, 3, 'разные реплики должны начинать с разных вариантов')
})

test('панорама и ослабление по положению события на экране', () => {
  assert.equal(combatAudioStereoPan(0, 1000), -COMBAT_AUDIO_MAX_PAN)
  assert.equal(combatAudioStereoPan(1000, 1000), COMBAT_AUDIO_MAX_PAN)
  assert.equal(combatAudioStereoPan(500, 1000), 0)
  assert.equal(combatAudioStereoPan(-200, 1000), -COMBAT_AUDIO_MAX_PAN, 'за краем панорама не превышает предел')
  assert.equal(combatAudioStereoPan(Number.NaN, 1000), 0)
  assert.equal(combatAudioStereoPan(10, 0), 0)
  assert.deepEqual(combatAudioSpatialFromScreen({ x: 500, y: 400, width: 1000, height: 800 }), { pan: 0, gain: 1 })
  const corner = combatAudioSpatialFromScreen({ x: 0, y: 0, width: 1000, height: 800 })
  assert.equal(corner.pan, -COMBAT_AUDIO_MAX_PAN)
  assert.ok(corner.gain < 1 && corner.gain >= .79, `угол кадра тише центра: ${corner.gain}`)
  assert.equal(combatAudioSpatialFromScreen({ x: 1200, y: 100, width: 1000, height: 800 }).gain, .5)
  assert.equal(combatAudioSpatialFromScreen({ x: 500, y: 400, width: 1000, height: 800, visible: false }).gain, .5)
  const spatial = { source: { pan: -.5, gain: .9 }, target: { pan: .6, gain: .7 } }
  assert.deepEqual(combatAudioPhaseSpatial('start', spatial), { pan: -.5, gain: .9 })
  assert.deepEqual(combatAudioPhaseSpatial('launch', spatial), { pan: -.5, gain: .9 })
  assert.deepEqual(combatAudioPhaseSpatial('contact', spatial), { pan: .6, gain: .7 })
  assert.deepEqual(combatAudioPhaseSpatial('contact', { source: { pan: .3 } }), { pan: .3, gain: 1 })
  assert.deepEqual(combatAudioPhaseSpatial('start', undefined), { pan: 0, gain: 1 })
  assert.deepEqual(combatAudioPhaseSpatial('start', { source: { pan: 9, gain: .01 } }), { pan: 1, gain: .5 })
})

test('уровни фаз: подготовка тише удара, крит громче, промах тише', () => {
  assert.ok(combatAudioPhaseGain('cast') < combatAudioPhaseGain('launch'))
  assert.ok(combatAudioPhaseGain('launch') < combatAudioPhaseGain('impact'))
  assert.ok(combatAudioPhaseGain('impact') < combatAudioPhaseGain('critical'))
  assert.ok(combatAudioPhaseGain('miss') < combatAudioPhaseGain('impact'))
  assert.ok(combatAudioPhaseGain('blocked') < combatAudioPhaseGain('impact'))
  assert.equal(combatAudioPhaseGain('impact'), 1)
  assert.ok(combatAudioFadeMs(1400, true) > combatAudioFadeMs(1400, false), 'обрезанный длинный клип уходит мягче')
  assert.ok(combatAudioFadeMs(1400, false) <= 40)
  assert.equal(combatAudioDuckDepth('cast'), 0)
  assert.ok(combatAudioDuckDepth('critical') > combatAudioDuckDepth('impact'))
  assert.ok(combatAudioDuckDepth('impact') > 0)
})

test('cast снаряда с тем же клипом, что и launch в ту же миллисекунду, не звучит дважды', async () => {
  const manifest = {
    version: 1,
    clips: { cast: { url: '/sfx/cast.ogg' }, launch: { url: '/sfx/launch.ogg' }, hit: { url: '/sfx/hit.ogg' } },
    profiles: {
      'spell:thunder': { cast: ['cast'], launch: ['cast'], impact: ['hit'] },
      'spell:flame': { cast: ['cast'], launch: ['launch'], impact: ['hit'] },
    },
  }
  const thunder = { id: 'thunder-bolt', kind: 'projectile', actorId: 'mage', targetIds: ['goblin'], spellId: 'thunderwave', school: 'evocation', projectileCount: 1, durationMs: 600 }
  const flame = { ...thunder, id: 'fire-bolt', spellId: 'fire-bolt' }
  assert.deepEqual(resolveCombatAudioPlan(thunder, manifest).map((entry) => entry.duplicateOf ?? null), ['launch', null, null])
  assert.deepEqual(resolveCombatAudioPlan(flame, manifest).map((entry) => entry.duplicateOf ?? null), [null, null, null])
  assert.equal(combatAudioDuplicatePhase(thunder, 'start', manifest), 'launch')
  // Ничего не пропало из плана: аудит покрытия видит все три фазы с клипами.
  assert.ok(resolveCombatAudioPlan(thunder, manifest).every((entry) => entry.clipIds.length))

  const context = new FakeContext()
  const clock = timers()
  const audio = createCombatAudio({ muted: false, audioContextFactory: () => context, manifest, loader: async () => ({ duration: .3 }), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  await audio.unlock()
  assert.ok(audio.schedule(thunder))
  await clock.flush()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(context.sources.length, 2, 'thunder: launch и contact, без второго cast')
  clock.queue.length = 0
  assert.ok(audio.schedule(flame))
  await clock.flush()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(context.sources.length, 5, 'flame: разные cast и launch звучат оба')
  await audio.dispose()
})

test('крит звучит громче попадания и с подложкой criticalLayer', async () => {
  const manifest = {
    version: 1,
    clips: { hit: { url: '/sfx/hit.ogg' }, body: { url: '/sfx/body.ogg' } },
    profiles: { 'attack:slash': { impact: ['hit'], critical: ['hit'], criticalLayer: ['body'] } },
  }
  const melee = { id: 'melee-hit', kind: 'strike', actorId: 'hero', targetId: 'orc', hit: true, amount: 5, attackKind: 'melee', equipment: 'sword', durationMs: 480 }
  const critical = { ...melee, id: 'melee-crit', critical: true }
  const profile = combatAudioProfile(critical, 'contact', manifest)
  assert.equal(profile.intent, 'critical')
  assert.deepEqual(profile.layerClipIds, ['body'])
  assert.deepEqual(combatAudioProfile(melee, 'contact', manifest).layerClipIds, [], 'обычное попадание без подложки')

  const context = new FakeContext()
  const audio = createCombatAudio({ muted: false, audioContextFactory: () => context, manifest, loader: async () => ({ duration: .3 }) })
  await audio.unlock()
  assert.equal(await audio.playCue(melee, 'contact'), true)
  assert.equal(context.sources.length, 1)
  const hitPeak = voicePeak(context.gains.at(-1))
  assert.equal(await audio.playCue(critical, 'contact'), true)
  assert.equal(context.sources.length, 3, 'крит — основная запись и подложка')
  const critPeak = voicePeak(context.gains.at(-2))
  const layerPeak = voicePeak(context.gains.at(-1))
  const unvaried = (peak, seed, intent) => peak / combatAudioVariation(seed, intent).gain
  assert.ok(Math.abs(unvaried(hitPeak, 'melee-hit:contact:hit', 'impact') - combatAudioPhaseGain('impact')) < 1e-9)
  assert.ok(Math.abs(unvaried(critPeak, 'melee-crit:contact:hit', 'critical') - combatAudioPhaseGain('critical')) < 1e-9)
  assert.ok(layerPeak < critPeak, 'подложка тише основной записи')
  await audio.dispose()
})

test('скорость, панорама и ослабление применяются к голосу записи', async () => {
  const context = new RateContext()
  const manifest = {
    version: 1,
    clips: { cast: { url: '/sfx/cast.ogg' }, hit: { url: '/sfx/hit.ogg' } },
    profiles: { 'attack:bow': { cast: ['cast'], impact: ['hit'] } },
  }
  const audio = createCombatAudio({ muted: false, audioContextFactory: () => context, manifest, loader: async () => ({ duration: .3 }) })
  await audio.unlock()
  const spatial = { source: { pan: -.6, gain: 1 }, target: { pan: .4, gain: .5 } }
  assert.equal(await audio.playCue({ ...strike, id: 'spatial-bow' }, 'start', { spatial }), true)
  assert.equal(await audio.playCue({ ...strike, id: 'spatial-bow' }, 'contact', { spatial }), true)
  assert.deepEqual(context.panners.map((panner) => panner.pan.value), [-.6, .4])
  const [castSource, hitSource] = context.sources
  assert.equal(castSource.playbackRate.value, combatAudioVariation('spatial-bow:start:cast', 'cast').playbackRate)
  assert.equal(hitSource.playbackRate.value, combatAudioVariation('spatial-bow:contact:hit', 'impact').playbackRate)
  const hitPeak = voicePeak(context.gains.at(-1))
  assert.ok(Math.abs(hitPeak - .5 * combatAudioVariation('spatial-bow:contact:hit', 'impact').gain) < 1e-9, 'далёкая цель тише')
  // Длительность голоса учитывает скорость воспроизведения.
  const expectedStop = 10 + .3 / hitSource.playbackRate.value
  assert.ok(Math.abs(hitSource.stops.at(-1) - expectedStop) < 1e-9)
  // Без положения звук по центру и без лишнего узла.
  assert.equal(await audio.playCue({ ...strike, id: 'center-bow' }, 'start'), true)
  assert.equal(context.panners.length, 2)
  await audio.dispose()
})

test('onDuck зовётся только для громких фаз реально зазвучавшего голоса', async () => {
  const requests = []
  const manifest = {
    version: 1,
    clips: { cast: { url: '/sfx/cast.ogg' }, hit: { url: '/sfx/hit.ogg' } },
    profiles: { 'attack:bow': { cast: ['cast'], impact: ['hit'], critical: ['hit'] } },
  }
  const context = new FakeContext()
  const audio = createCombatAudio({ muted: false, audioContextFactory: () => context, manifest, loader: async () => ({ duration: .3 }), onDuck: (request) => requests.push(request) })
  await audio.unlock()
  await audio.playCue({ ...strike, id: 'duck-1' }, 'start')
  assert.equal(requests.length, 0, 'натяжение тетивы не приглушает атмосферу')
  await audio.playCue({ ...strike, id: 'duck-1' }, 'contact')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].depth, combatAudioDuckDepth('impact'))
  assert.ok(requests[0].holdMs > 0 && requests[0].holdMs <= 300 / .9)
  await audio.playCue({ ...strike, id: 'duck-2', critical: true }, 'contact')
  assert.equal(requests[1].depth, combatAudioDuckDepth('critical'))
  audio.setMuted(true)
  await audio.playCue({ ...strike, id: 'duck-3' }, 'contact')
  assert.equal(requests.length, 2, 'в mute фон не трогается')
  await audio.dispose()
})

test('заклинание без смысловой семьи звучит материалом своей школы', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'public/assets/audio/combat/manifest.json'), 'utf8'))
  const unknown = { id: 'homebrew', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'homebrew-spell-xyz', school: 'necromancy', shape: 'sphere', sizeFeet: 10, durationMs: 480 }
  assert.equal(combatAudioProfile(unknown, 'contact', manifest).key, 'spell:necrotic')
  assert.equal(combatAudioProfile({ ...unknown, school: 'evocation' }, 'contact', manifest).key, 'spell:force')
  for (const [school, family] of Object.entries(COMBAT_AUDIO_SCHOOL_FAMILIES)) {
    assert.ok(manifest.profiles[`spell:${family}`], `школа ${school} → отсутствующий профиль spell:${family}`)
  }
  // Известная семья не проваливается в соседний профиль: silence молчит.
  const silence = { ...unknown, id: 'silence', spellId: 'silence', school: 'illusion' }
  assert.deepEqual(combatAudioProfile(silence, 'contact', manifest).clipIds, [])
})

test('каждая семья и стиль атаки звучат реально существующими файлами', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'public/assets/audio/combat/manifest.json'), 'utf8'))
  const fileFor = (clipId) => {
    const url = manifest.clips[clipId]?.url
    assert.ok(url, `нет клипа ${clipId}`)
    const path = join(repositoryRoot, 'public', url.replace(/^\//u, ''))
    assert.ok(statSync(path).size > 0, `пустой файл ${path}`)
    return path
  }
  const phases = ['cast', 'launch', 'impact', 'miss', 'critical', 'blocked', 'criticalLayer']
  for (const profile of Object.values(manifest.profiles)) {
    for (const phase of phases) for (const clipId of [profile[phase] ?? []].flat()) fileFor(clipId)
  }
  for (const family of COMBAT_AUDIO_FAMILIES) {
    const profile = manifest.profiles[`spell:${family}`]
    assert.ok(profile, `нет профиля spell:${family}`)
    if (family === 'silence') {
      assert.deepEqual(profile.silentPhases, ['cast', 'launch', 'impact'])
      continue
    }
    for (const phase of ['cast', 'impact', 'miss']) assert.ok([profile[phase] ?? []].flat().length, `spell:${family} молчит в ${phase}`)
  }
  for (const style of COMBAT_AUDIO_ATTACK_STYLES) {
    const profile = manifest.profiles[`attack:${style}`]
    for (const phase of ['impact', 'miss', 'critical']) assert.ok([profile[phase] ?? []].flat().length, `attack:${style} молчит в ${phase}`)
    for (const clipId of [profile.criticalLayer ?? []].flat()) {
      assert.ok(![profile.critical].flat().includes(clipId), `attack:${style}: подложка крита не должна дублировать основную запись`)
    }
  }
  // Ни один клип manifest не висит без профиля.
  const used = new Set(Object.values(manifest.profiles).flatMap((profile) => phases.flatMap((phase) => [profile[phase] ?? []].flat())))
  assert.deepEqual(Object.keys(manifest.clips).filter((clipId) => !used.has(clipId)), [])
})

test('план реального manifest для каждого заклинания каталога разрешается в файлы', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'public/assets/audio/combat/manifest.json'), 'utf8'))
  for (const entry of spellVisualAudit()) {
    const cue = { id: `audit:${entry.id}`, kind: 'burst', actorId: 'mage', targetIds: ['t'], spellId: entry.id, school: entry.school, shape: 'sphere', sizeFeet: 10, durationMs: 600 }
    for (const step of resolveCombatAudioPlan(cue, manifest)) {
      if (entry.soundFamily === 'silence') { assert.deepEqual(step.urls, []); continue }
      assert.ok(step.urls.length, `${entry.id}/${step.phase} без записи`)
      for (const url of step.urls) assert.ok(statSync(join(repositoryRoot, 'public', url.replace(/^\//u, ''))).size > 0)
    }
  }
})

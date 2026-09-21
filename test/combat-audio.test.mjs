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
const { combatAudioProfile, createCombatAudio, resolveCombatAudioPlan, COMBAT_AUDIO_ATTACK_STYLES, COMBAT_AUDIO_VOICE_LIMIT } = await import(pathToFileURL(join(buildDir, 'src/combat-audio.mjs')).href)
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
  const hold = voiceGain.gain.events.filter((event) => event[0] === 'set' && event[1] === 1)
  const ramp = voiceGain.gain.events.find((event) => event[0] === 'ramp')
  const stop = context.sources.at(-1)?.stops.at(-1)
  assert.ok(hold.some((event) => event[2] > 10), 'gain должен оставаться 1 до конца окна')
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

test('voice cap ограничивает одновременно звучащие длинные clips', async () => {
  const context = new FakeContext()
  const audio = createCombatAudio({
    muted: false,
    audioContextFactory: () => context,
    manifest: { version: 1, clips: { cast: { url: '/sfx/cast.ogg' } }, profiles: { 'attack:bow': { cast: ['cast'] } } },
    loader: async () => ({ duration: 8 }),
  })
  await audio.unlock()
  await Promise.all(Array.from({ length: COMBAT_AUDIO_VOICE_LIMIT + 2 }, (_, index) => audio.playCue({ ...strike, id: `voice-${index}` }, 'start')))
  assert.equal(context.sources.filter((source) => !source.stops.some((when) => when <= 10)).length, COMBAT_AUDIO_VOICE_LIMIT)
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

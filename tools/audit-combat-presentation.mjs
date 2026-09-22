#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { WEAPON_MODELS } from './equipment-weapon-models.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SPELL_COUNT = 439
const WEAPON_COUNT = 39
const ATTACK_MODEL_COUNT = 40
const PROFILE_KEY = /^(?:spell|attack):[a-z0-9-]+$/u
const LOCAL_ASSET = /^\/assets\//u

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function productionMainHandKeys(root) {
  const source = readFileSync(join(root, 'server', 'equipment-visuals.mjs'), 'utf8')
  const arrayKeys = (name) => {
    const match = source.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`, 'u'))
    return match ? [...match[1].matchAll(/['"]([^'"]+)['"]/gu)].map((entry) => entry[1]) : []
  }
  const weaponKeys = arrayKeys('WEAPON_MODEL_KEYS')
  // Визуальный слот main_hand включает фокусы и инструменты, но они
  // не становятся от этого моделями физических атак.
  const nonAttackKeys = new Set([...arrayKeys('FOCUS_MODEL_KEYS'), ...arrayKeys('INSTRUMENT_MODEL_KEYS')])
  const mainHandMatch = source.match(/main_hand:\s*new Set\(\[([\s\S]*?)\]\)/u)
  if (!mainHandMatch) return []
  const keys = new Set()
  if (/\.\.\.WEAPON_MODEL_KEYS/u.test(mainHandMatch[1])) weaponKeys.forEach((key) => keys.add(key))
  for (const entry of mainHandMatch[1].matchAll(/['"]([^'"]+)['"]/gu)) {
    const key = entry[1]
    if (key === 'wand' || !nonAttackKeys.has(key)) keys.add(key)
  }
  return [...keys]
}

function walkFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walkFiles(path) : [path]
  })
}

function issue(code, message, details = {}) {
  return { code, message, ...details }
}

function safeAssetPath(root, url) {
  if (typeof url !== 'string') return null
  const clean = url.trim().split(/[?#]/u, 1)[0]
  if (!LOCAL_ASSET.test(clean)) return null
  const publicRoot = resolve(root, 'public')
  const candidate = resolve(publicRoot, `.${clean}`)
  const prefix = `${publicRoot}${sep}`
  return candidate === publicRoot || candidate.startsWith(prefix) ? candidate : null
}

function inspectLocalAsset(root, url) {
  const path = safeAssetPath(root, url)
  if (!path) return { url, path: null, exists: false, bytes: 0 }
  try {
    const info = statSync(path)
    return { url, path, exists: info.isFile(), bytes: info.isFile() ? info.size : 0 }
  } catch {
    return { url, path, exists: false, bytes: 0 }
  }
}

function rewriteCompiledImports(path) {
  const rewritten = readFileSync(path, 'utf8')
    .replace(/(from\s+["'])(\.\.?\/[^"']+\.json)(["'])/gu, '$1$2$3 with { type: "json" }')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => (
      /\.(?:json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`
    ))
  writeFileSync(path, rewritten)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}

/**
 * Компилирует ровно тот клиентский runtime, который строит Vite. Это не
 * дублирует классификатор: audit вызывает spellVisualProfile, cue builder и
 * resolveCombatAudioPlan из исходных модулей.
 */
export function loadPresentationRuntime(root = REPOSITORY_ROOT) {
  mkdirSync(join(resolve(root, 'tmp')), { recursive: true })
  const tempRoot = mkdtempSync(join(resolve(root, 'tmp'), 'combat-presentation-runtime-'))
  const copyServerModule = (name) => {
    mkdirSync(join(tempRoot, 'server'), { recursive: true })
    copyFileSync(join(root, 'server', name), join(tempRoot, 'server', name))
  }
  copyServerModule('actor-footprint.mjs')
  copyServerModule('equipment-visuals.mjs')

  const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const sources = [
    'src/combat-audio.ts',
    'src/combat-animation.ts',
    'src/spell-effects.ts',
    'src/area-geometry.ts',
    'src/tactical-map-client.ts',
    'src/board-render.ts',
  ].map((path) => join(root, path))
  const compiled = spawnSync(process.execPath, [
    compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext',
    '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM', '--strict',
    '--skipLibCheck', '--resolveJsonModule', '--esModuleInterop',
    '--rootDir', root, '--outDir', tempRoot, ...sources,
  ], { encoding: 'utf8' })
  if (compiled.status !== 0) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw new Error(compiled.stderr || compiled.stdout || 'Не удалось скомпилировать клиентский runtime аудита')
  }
  for (const path of walkFiles(tempRoot).filter((candidate) => candidate.endsWith('.js'))) rewriteCompiledImports(path)

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    rmSync(tempRoot, { recursive: true, force: true })
  }
  return {
    spell: import(pathToFileURL(join(tempRoot, 'src', 'spell-effects.mjs')).href),
    animation: import(pathToFileURL(join(tempRoot, 'src', 'combat-animation.mjs')).href),
    audio: import(pathToFileURL(join(tempRoot, 'src', 'combat-audio.mjs')).href),
    cleanup,
  }
}

function soundProfileKey(soundFamily) {
  return typeof soundFamily === 'string' && soundFamily ? `spell:${soundFamily}` : null
}

function auditClip(manifest, clipId, root, issues, seen = new Set()) {
  const key = String(clipId ?? '')
  if (!key) {
    issues.push(issue('audio.clip-id-empty', 'В audio profile есть пустой clip id'))
    return null
  }
  if (seen.has(key)) return manifest.clips?.[key] ?? null
  seen.add(key)
  const clip = manifest.clips?.[key]
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)) {
    issues.push(issue('audio.clip-missing', `Клип ${key} отсутствует в clips`, { clipId: key }))
    return null
  }
  const url = typeof clip.url === 'string' ? clip.url.trim() : ''
  const asset = inspectLocalAsset(root, url)
  if (!asset.path) issues.push(issue('audio.url-invalid', `Клип ${key} не указывает на локальный combat asset`, { clipId: key, url: clip.url }))
  else if (!asset.exists || asset.bytes <= 0) issues.push(issue('audio.file-missing', `Файл клипа ${key} отсутствует или пуст`, { clipId: key, url, path: asset.path }))
  const durationMs = Number(clip.durationMs)
  if (!Number.isFinite(durationMs) || durationMs <= 0) issues.push(issue('audio.duration-invalid', `У клипа ${key} должна быть положительная durationMs`, { clipId: key, durationMs: clip.durationMs }))
  if (typeof clip.sourceId !== 'string' || !clip.sourceId.trim()) issues.push(issue('audio.source-missing', `У клипа ${key} нет sourceId`, { clipId: key }))
  for (const field of ['peakDb', 'peakDbfs', 'peak']) {
    if (clip[field] !== undefined && !Number.isFinite(Number(clip[field]))) issues.push(issue('audio.peak-invalid', `Поле ${field} клипа ${key} не является числом`, { clipId: key, field, value: clip[field] }))
  }
  return {
    id: key,
    url,
    sourceId: clip.sourceId,
    durationMs,
    ...(clip.peakDb !== undefined ? { peakDb: Number(clip.peakDb) } : {}),
    ...(clip.peakDbfs !== undefined ? { peakDbfs: Number(clip.peakDbfs) } : {}),
    ...(clip.peak !== undefined ? { peak: Number(clip.peak) } : {}),
    bytes: asset.bytes,
    exists: asset.exists && asset.bytes > 0,
  }
}

function profileClipIds(profile, phase) {
  const value = profile?.[phase]
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return value ? [String(value)] : []
}

function manifestPhaseForPlan(plan) {
  if (plan.phase === 'start') return 'cast'
  if (plan.phase === 'launch') return 'launch'
  if (plan.phase === 'contact') return 'impact'
  return plan.phase
}

function explicitSilentPhase(manifest, plan) {
  const profile = manifest?.profiles?.[plan.profileKey]
  const phase = manifestPhaseForPlan(plan)
  return Array.isArray(profile?.silentPhases)
    && profile.silentPhases.includes(phase)
    && typeof profile.silenceReason === 'string'
    && profile.silenceReason.trim().length > 0
}

function validateAudioManifest(manifest, root, planEntries, issues) {
  const clips = new Map()
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    issues.push(issue('audio.manifest-invalid', 'Combat audio manifest отсутствует или имеет неверную форму'))
    return { clips, profiles: {} }
  }
  if (manifest.version !== 1) issues.push(issue('audio.manifest-version', 'Поддерживается только combat audio manifest version 1', { version: manifest.version }))
  if (!manifest.clips || typeof manifest.clips !== 'object' || Array.isArray(manifest.clips)) {
    issues.push(issue('audio.clips-invalid', 'Поле clips отсутствует'))
  }
  if (!manifest.profiles || typeof manifest.profiles !== 'object' || Array.isArray(manifest.profiles)) {
    issues.push(issue('audio.profiles-invalid', 'Поле profiles отсутствует'))
  }
  for (const [key, profile] of Object.entries(manifest.profiles ?? {})) {
    if (!PROFILE_KEY.test(key)) issues.push(issue('audio.profile-key-invalid', `Недопустимый profile key ${key}`, { profileKey: key }))
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      issues.push(issue('audio.profile-invalid', `Профиль ${key} имеет неверную форму`, { profileKey: key }))
      continue
    }
    const silentPhases = profile.silentPhases
    if (silentPhases !== undefined && (!Array.isArray(silentPhases) || silentPhases.some((phase) => !['cast', 'launch', 'impact', 'miss', 'critical', 'blocked', 'complete'].includes(String(phase))))) {
      issues.push(issue('audio.silent-phases-invalid', `Профиль ${key} имеет неверный список silentPhases`, { profileKey: key }))
    }
    if (Array.isArray(silentPhases) && silentPhases.length > 0 && (typeof profile.silenceReason !== 'string' || !profile.silenceReason.trim())) {
      issues.push(issue('audio.silence-reason-missing', `Профиль ${key} объявляет тишину без silenceReason`, { profileKey: key }))
    }
    for (const phase of ['cast', 'launch', 'impact', 'miss', 'critical', 'blocked']) {
      for (const clipId of profileClipIds(profile, phase)) {
        if (!clips.has(clipId)) clips.set(clipId, auditClip(manifest, clipId, root, issues))
      }
      if (Object.prototype.hasOwnProperty.call(profile, phase)
        && profileClipIds(profile, phase).length === 0
        && !(Array.isArray(silentPhases) && silentPhases.includes(phase) && typeof profile.silenceReason === 'string' && profile.silenceReason.trim())) {
        issues.push(issue('audio.profile-empty-phase', `Профиль ${key}/${phase} пуст без explicit silence`, { profileKey: key, phase }))
      }
    }
  }
  for (const plan of planEntries) {
    const directClipIds = profileClipIds(manifest.profiles?.[plan.profileKey], manifestPhaseForPlan(plan))
    const explicitlySilent = explicitSilentPhase(manifest, plan)
    // Runtime не должен превращать пустой cast в launch/impact: у выстрела
    // это сдвигает gunshot раньше фактического выпуска и ломает семантику cue.
    if (!directClipIds.length && !explicitlySilent) {
      issues.push(issue('audio.plan-direct-phase-missing', `Resolver не должен подменять пустую ${manifestPhaseForPlan(plan)} профиля ${plan.profileKey}`, {
        cueId: plan.cueId,
        phase: plan.phase,
        profileKey: plan.profileKey,
      }))
    }
    if (plan.cueId.startsWith('audit:weapon:') && plan.phase === 'contact' && !plan.clipIds.length) {
      issues.push(issue('audio.attack-impact-missing', `Удар ${plan.cueId} не имеет impact sound`, { cueId: plan.cueId, profileKey: plan.profileKey }))
    }
    if (!plan.clipIds.length) {
      if (explicitlySilent) continue
      issues.push(issue('audio.plan-unresolved', `Для ${plan.profileKey}/${plan.phase} нет sound clip`, {
        cueId: plan.cueId,
        phase: plan.phase,
        profileKey: plan.profileKey,
      }))
      continue
    }
    for (const clipId of plan.clipIds) {
      if (!clips.has(clipId)) clips.set(clipId, auditClip(manifest, clipId, root, issues))
    }
    if (!plan.urls.length) issues.push(issue('audio.plan-url-empty', `Для ${plan.profileKey}/${plan.phase} resolver не получил URL`, { cueId: plan.cueId, phase: plan.phase }))
  }
  for (const clipId of Object.keys(manifest.clips ?? {})) {
    if (!clips.has(clipId)) clips.set(clipId, auditClip(manifest, clipId, root, issues))
  }
  return { clips, profiles: manifest.profiles }
}

function attackKindFor(spec) {
  if (spec.key === 'wand') return 'ranged'
  if (['bow', 'crossbow', 'sling', 'dart', 'blowgun', 'firearm'].includes(spec.kind)) return 'ranged'
  if (['polearm'].includes(spec.kind) && ['javelin', 'spear', 'trident'].includes(spec.key)) return 'thrown'
  if (['handaxe', 'dart', 'net'].includes(spec.key)) return 'thrown'
  return 'melee'
}

function cueForWeapon(spec) {
  return {
    id: `audit:weapon:${spec.key}`,
    kind: 'strike',
    actorId: 'audit-attacker',
    targetId: 'audit-target',
    hit: true,
    amount: 1,
    attackKind: attackKindFor(spec),
    loadout: { main_hand: { model_key: spec.key } },
    durationMs: 480,
  }
}

function auditIntegration(root) {
  const combatAudio = readFileSync(join(root, 'src', 'combat-audio.ts'), 'utf8')
  const combatAnimation = readFileSync(join(root, 'src', 'combat-animation.ts'), 'utf8')
  const tacticalBoard = readFileSync(join(root, 'src', 'TacticalBoard.tsx'), 'utf8')
  const tacticalBoard3d = readFileSync(join(root, 'src', 'TacticalBoard3D.tsx'), 'utf8')
  const dungeonMap = readFileSync(join(root, 'src', 'DungeonMap.tsx'), 'utf8')
  const issueSpellBlock = dungeonMap.match(/const issueSpell[\s\S]*?(?=\n\s*const castAtTarget)/u)?.[0] ?? ''
  const checks = [
    {
      id: 'audio-once-queue',
      ok: /seenCueIds\.has\(cue\.id\)[\s\S]{0,240}(?:remember\(seenCueIds,\s*cue\.id\)|seenCueIds\.add\(cue\.id\))/u.test(combatAudio),
      evidence: 'seenCueIds guards a confirmed cue before schedule creation',
    },
    {
      id: 'duplicate-sse-replay',
      ok: /const eventId[\s\S]*event\.event_id/u.test(combatAnimation) && /seenCueIds/u.test(combatAudio),
      evidence: 'event id feeds cue id and the audio queue deduplicates cue id',
    },
    {
      id: 'mute-cancels',
      ok: /setMuted\(muted\)[\s\S]*if \(settings\.muted\) cancel\(\)/u.test(combatAudio),
      evidence: 'muting cancels pending and active combat audio',
    },
    {
      id: 'visibility-cancels',
      ok: /setVisibleState[\s\S]*if \(!visible\) cancel\(\)/u.test(combatAudio),
      evidence: 'leaving the visible scene cancels pending audio',
    },
    {
      id: 'skip-cancels',
      ok: /cancel:\s*\(\)\s*=>\s*cancel\(id\)/u.test(combatAudio),
      evidence: 'the schedule returned for a skipped effect exposes cancellation',
    },
    {
      id: 'ui-inflight-guard',
      ok: /spellCommandInFlight[\s\S]*if \(!selected[\s\S]*spellCommandInFlight\.current\)/u.test(dungeonMap),
      evidence: 'direct spell issue path has a client-side duplicate-submit lock',
    },
    {
      id: 'ui-server-authority',
      ok: /const issueSpell[\s\S]*await onCastSpell\(/u.test(dungeonMap),
      evidence: 'direct aim delegates the command to the server callback',
    },
    {
      id: 'ui-no-stale-charge',
      ok: /await onCastSpell\(/u.test(issueSpellBlock)
        && !/(set[A-Z][A-Za-z]*(?:Resource|Slot|Charge)|resources\s*=)/u.test(issueSpellBlock),
      evidence: 'the direct aim handler does not mutate resource state before server success',
    },
    {
      id: '2d-audio-without-motion',
      ok: /const stopVisualAnimation[\s\S]*setActiveAnimation\(null\)[\s\S]*clearEffectsCanvas/u.test(tacticalBoard)
        && /animationsEnabled !== false\) return[\s\S]*stopVisualAnimation\(\)/u.test(tacticalBoard),
      evidence: 'disabling visual animation clears only the visual state and leaves the audio queue alive',
    },
    {
      id: '2d-hidden-cue-guard',
      ok: /activeAnimation\.kind === 'move'[\s\S]*revealedAt\(scene\.map[\s\S]*activeAnimation\.kind === 'impact'[\s\S]*revealedAt\(scene\.map/u.test(tacticalBoard),
      evidence: 'generic 2D movement and result cues require revealed cells before drawing',
    },
    {
      id: '3d-hidden-cue-guard',
      ok: /revealedAt\(current\.map, resultActor\.x, resultActor\.y\)/u.test(tacticalBoard3d)
        && /revealedAt\(map, actor\.x, actor\.y\)/u.test(tacticalBoard3d),
      evidence: '3D actor/result layers are restricted to revealed positions',
    },
    {
      id: '2d-actor-aware-audio',
      ok: /const audioActor[\s\S]*combatAudio\?\.schedule\([\s\S]*actor: audioActor/u.test(tacticalBoard),
      evidence: '2D physical audio uses the same public actor snapshot as the visual style resolver',
    },
    {
      id: '3d-actor-aware-audio',
      ok: /const audioActor[\s\S]*current\.combatAudio\?\.schedule\([\s\S]*actor: audioActor/u.test(tacticalBoard3d),
      evidence: '3D physical audio uses the same public actor snapshot as the visual style resolver',
    },
    {
      id: '2d-net-hit-cue',
      ok: /const netAttack[\s\S]*outcome === 'hit'[\s\S]*const spread = cellSize/u.test(tacticalBoard),
      evidence: 'the 2D net is a transient confirmed-hit contour, not a preview or persistent condition',
    },
  ]
  return checks
}

function audioTimers() {
  const queue = []
  return {
    setTimeout(handler, delay) {
      const timer = { handler, delay, cancelled: false }
      queue.push(timer)
      return timer
    },
    clearTimeout(timer) {
      timer.cancelled = true
    },
    async flush() {
      for (const timer of [...queue].sort((left, right) => left.delay - right.delay)) {
        if (!timer.cancelled) timer.handler()
        await Promise.resolve()
        await Promise.resolve()
      }
    },
  }
}

class AuditAudioParam {
  constructor() { this.value = 0 }
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value }
}

class AuditAudioGain {
  constructor() { this.gain = new AuditAudioParam() }
  connect(destination) { this.destination = destination; return destination }
  disconnect() { this.disconnected = true }
}

class AuditAudioSource {
  constructor() { this.listeners = new Map(); this.stops = [] }
  connect(destination) { this.destination = destination; return destination }
  disconnect() { this.disconnected = true }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  start() {}
  stop(when) { this.stops.push(when); this.listeners.get('ended')?.() }
}

class AuditAudioContext {
  constructor() { this.state = 'suspended'; this.currentTime = 10; this.destination = {}; this.sources = [] }
  createGain() { return new AuditAudioGain() }
  createBufferSource() { const source = new AuditAudioSource(); this.sources.push(source); return source }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
}

async function auditAudioRuntime(audioModule, manifest) {
  const context = new AuditAudioContext()
  const timers = audioTimers()
  const audio = audioModule.createCombatAudio({
    muted: false,
    manifest: manifest ?? { version: 1, clips: {}, profiles: {} },
    audioContextFactory: () => context,
    loader: async () => ({ duration: .1 }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })
  const checks = []
  try {
    checks.push({
      id: 'runtime-audio-unlock',
      ok: await audio.unlock(),
      evidence: 'fake AudioContext reached running state',
    })
    const cue = {
      id: 'audit-runtime-cue', kind: 'burst', actorId: 'audit-caster', targetIds: ['audit-target'],
      spellId: 'fireball', school: 'evocation', shape: 'sphere', sizeFeet: 20, durationMs: 480,
    }
    const first = audio.schedule(cue)
    const duplicate = audio.schedule(cue)
    checks.push({ id: 'runtime-audio-once', ok: Boolean(first) && duplicate === null, evidence: 'same cue id yielded one schedule' })
    first?.cancel()
    await timers.flush()
    const muted = audio.schedule({ ...cue, id: 'audit-muted-cue' })
    audio.setMuted(true)
    await timers.flush()
    checks.push({ id: 'runtime-mute-cancel', ok: Boolean(muted) && context.sources.length === 0, evidence: 'mute cancelled pending schedule before a source started' })
    audio.setMuted(false)
    const skipped = audio.schedule({ ...cue, id: 'audit-skipped-cue' })
    skipped?.cancel()
    await timers.flush()
    checks.push({ id: 'runtime-skip-cancel', ok: Boolean(skipped) && context.sources.length === 0, evidence: 'schedule cancellation left no source' })
    const hidden = audio.schedule({ ...cue, id: 'audit-hidden-cue' })
    audio.setVisible(false)
    await timers.flush()
    checks.push({ id: 'runtime-visibility-cancel', ok: Boolean(hidden) && context.sources.length === 0, evidence: 'visibility cancellation left no source' })
  } finally {
    await audio.dispose()
  }
  return checks
}

async function auditCombatPresentation(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const issues = []
  const runtimeBundle = options.runtime
    ? { spell: Promise.resolve(options.runtime.spell), animation: Promise.resolve(options.runtime.animation), audio: Promise.resolve(options.runtime.audio), cleanup: () => {} }
    : loadPresentationRuntime(root)
  try {
    const [spell, animation, audio] = await Promise.all([runtimeBundle.spell, runtimeBundle.animation, runtimeBundle.audio])
    const catalogPayload = readJson(join(root, 'data', 'dndsu-spells-0-6.json'))
    const mechanicsPayload = readJson(join(root, 'data', 'dndsu-spell-mechanics-overrides.json'))
    const mechanicsOverrides = mechanicsPayload?.spells && typeof mechanicsPayload.spells === 'object' ? mechanicsPayload.spells : {}
    const spells = Array.isArray(catalogPayload.spells) ? catalogPayload.spells : []
    if (catalogPayload.count !== SPELL_COUNT || spells.length !== SPELL_COUNT) issues.push(issue('spells.count', `Ожидалось ${SPELL_COUNT} заклинаний 0–6 уровня`, { declared: catalogPayload.count, actual: spells.length }))
    const spellIds = new Set()
    const visualAudit = spell.spellVisualAudit()
    const visualById = new Map(visualAudit.map((entry) => [entry.id, entry]))
    if (visualAudit.length !== spells.length) issues.push(issue('spells.visual-count', 'Visual audit и каталог имеют разные размеры', { catalog: spells.length, visual: visualAudit.length }))
    const audioManifestPath = join(root, 'public', 'assets', 'audio', 'combat', 'manifest.json')
    let manifest = null
    if (Object.prototype.hasOwnProperty.call(options, 'manifest')) manifest = options.manifest
    else if (existsSync(audioManifestPath)) manifest = readJson(audioManifestPath)
    else issues.push(issue('audio.manifest-missing', 'Отсутствует public/assets/audio/combat/manifest.json', { path: audioManifestPath }))

    const planEntries = []
    const spellRows = spells.map((catalogSpell) => {
      const id = String(catalogSpell.id ?? '').trim()
      if (!id || spellIds.has(id)) issues.push(issue('spells.id-duplicate', `Повторный или пустой spell id ${id || '<empty>'}`, { spellId: id }))
      spellIds.add(id)
      if (!Number.isInteger(catalogSpell.level) || catalogSpell.level < 0 || catalogSpell.level > 6) issues.push(issue('spells.level-invalid', `Неверный уровень у ${id}`, { spellId: id, level: catalogSpell.level }))
      const profile = spell.spellVisualProfile(id)
      const visual = visualById.get(id)
      if (!visual || visual.family !== profile.family || visual.kind !== profile.kind) issues.push(issue('spells.visual-mismatch', `Visual profile не совпал с audit для ${id}`, { spellId: id }))
      if (!profile.family || !profile.familyNote || !profile.soundFamily || !profile.kind) issues.push(issue('spells.profile-empty', `У ${id} неполный visual profile`, { spellId: id, family: profile.family, kind: profile.kind, soundFamily: profile.soundFamily }))
      // Runtime получает authoritative override (например, Hunger of Hadar
      // меняет основной damage type на acid). В аудит нельзя подставлять
      // сырое поле каталога и тем самым создавать ложный sound-family.
      const effectiveSpell = { ...catalogSpell, ...(mechanicsOverrides[id] ?? {}) }
      const event = {
        event_id: `audit:spell:${id}`,
        command_id: `audit:spell:${id}`,
        event_type: 'SpellCast',
        actor_id: 'audit-caster',
        target_ids: ['audit-target'],
        payload: {
          spell_id: id,
          school: effectiveSpell.school,
          kind: effectiveSpell.kind,
          damage_type: effectiveSpell.damageType ?? effectiveSpell.damageTypes?.[0],
          area_shape: effectiveSpell.areaShape,
          radius_feet: effectiveSpell.radius,
        },
      }
      const cues = animation.combatAnimationCuesFromEvents([event])
      const cue = cues.find((entry) => entry.spellId === id)
      if (!cue) issues.push(issue('spells.cue-missing', `Для ${id} не построен combat cue`, { spellId: id }))
      const plan = cue ? audio.resolveCombatAudioPlan(cue, manifest ?? { version: 1, clips: {}, profiles: {} }) : []
      const intentionalSilence = manifest ? plan.every((entry) => explicitSilentPhase(manifest, entry)) : false
      for (const entry of plan) planEntries.push({ ...entry, intentionalSilence: explicitSilentPhase(manifest, entry) })
      const expectedProfileKey = soundProfileKey(profile.soundFamily)
      if (expectedProfileKey && cue && plan.some((entry) => entry.profileKey !== expectedProfileKey)) issues.push(issue('audio.sound-family-mismatch', `Resolver использует не soundFamily профиля для ${id}`, { spellId: id, expectedProfileKey, actual: [...new Set(plan.map((entry) => entry.profileKey))] }))
      return {
        id,
        level: catalogSpell.level,
        mechanicsSupport: visual?.mechanicsSupport,
        visualProfile: { family: profile.family, familyNote: profile.familyNote, soundFamily: profile.soundFamily, visualVariant: profile.visualVariant, kind: profile.kind, areaShape: profile.areaShape, areaOrigin: profile.areaOrigin, areaSideFeet: profile.areaSideFeet, sizeFeet: profile.sizeFeet, radiusFeet: profile.radiusFeet, projectileCount: profile.projectileCount, chain: profile.chain, requiresWeaponAttack: profile.requiresWeaponAttack, spreadsAroundCorners: profile.spreadsAroundCorners },
        cue: cue ? { kind: cue.kind, durationMs: cue.durationMs, renderFamily: profile.family } : null,
        sound: { profileKey: expectedProfileKey, intentionalSilence, phases: plan.map((entry) => ({ phase: entry.phase, atMs: entry.atMs, clipIds: entry.clipIds, urls: entry.urls })) },
      }
    })

    const equipmentManifestPath = join(root, 'public', 'assets', 'models', 'equipment', 'manifest.json')
    const equipmentManifest = existsSync(equipmentManifestPath) ? readJson(equipmentManifestPath) : null
    if (!equipmentManifest) issues.push(issue('weapons.manifest-missing', 'Отсутствует manifest моделей оружия', { path: equipmentManifestPath }))
    const equipmentModels = Array.isArray(equipmentManifest?.models) ? equipmentManifest.models : []
    const weaponRows = []
    if (WEAPON_MODELS.length !== WEAPON_COUNT) issues.push(issue('weapons.count', `Ожидалось ${WEAPON_COUNT} canonical weapon models`, { actual: WEAPON_MODELS.length }))
    const canonicalWeaponKeys = new Set(WEAPON_MODELS.map((spec) => spec.key))
    const expectedAttackKeys = new Set([...canonicalWeaponKeys, 'wand'])
    const productionMainHand = new Set(productionMainHandKeys(root))
    for (const key of expectedAttackKeys) if (!productionMainHand.has(key)) issues.push(issue('weapons.production-missing', `Production main_hand whitelist не содержит ${key}`, { weapon: key }))
    for (const key of productionMainHand) if (!expectedAttackKeys.has(key)) issues.push(issue('weapons.production-extra', `Production main_hand whitelist содержит лишний ${key}`, { weapon: key }))
    const attackSpecs = [
      ...WEAPON_MODELS,
      { key: 'wand', label: 'Жезл', kind: 'wand', handedness: 'one-handed', catalogIds: [], source: 'production' },
    ]
    if (attackSpecs.length !== ATTACK_MODEL_COUNT) issues.push(issue('weapons.attack-model-count', `Ожидалось ${ATTACK_MODEL_COUNT} attack models включая wand`, { actual: attackSpecs.length }))
    for (const spec of attackSpecs) {
      // Палочка участвует в предпросмотре магической атаки. Её зачарованный
      // вариант — отдельный аксессуар; оба варианта проверяются ниже.
      const entries = equipmentModels.filter((entry) => entry?.key === spec.key
        && (spec.key === 'wand'
          ? entry?.category === 'accessory' && (entry?.variant ?? 'default') === 'default'
          : entry?.category === 'weapon'))
      if (entries.length !== 1) issues.push(issue('weapons.model-missing', `Для ${spec.key} нужен один weapon model entry`, { weapon: spec.key, matches: entries.length }))
      if (entries.length > 1) issues.push(issue('weapons.model-duplicate', `Для ${spec.key} найдено несколько weapon model entries`, { weapon: spec.key, matches: entries.length }))
      const model = entries[0]
      const cue = cueForWeapon(spec)
      const style = audio ? animation.attackVisualStyle(cue) : spec.kind
      const plan = audio.resolveCombatAudioPlan(cue, manifest ?? { version: 1, clips: {}, profiles: {} })
      for (const entry of plan) planEntries.push(entry)
      if (model && model.url) {
        const asset = inspectLocalAsset(root, model.url)
        if (!asset.exists || asset.bytes <= 0) issues.push(issue('weapons.file-missing', `Файл модели ${spec.key} отсутствует или пуст`, { weapon: spec.key, url: model.url, path: asset.path }))
      } else issues.push(issue('weapons.url-missing', `Модель оружия ${spec.key} не имеет URL`, { weapon: spec.key }))
      weaponRows.push({ key: spec.key, label: spec.label, kind: spec.kind, canonical: canonicalWeaponKeys.has(spec.key), renderFamily: style, attackKind: cue.attackKind, modelUrl: model?.url ?? null, modelExists: Boolean(model?.url && inspectLocalAsset(root, model.url).exists), sound: { profileKey: `attack:${style}`, phases: plan.map((entry) => ({ phase: entry.phase, atMs: entry.atMs, clipIds: entry.clipIds, urls: entry.urls })) } })
    }
    const attackDefaultIdentities = new Set(attackSpecs.map((spec) => `${spec.key}:main_hand:default`))
    const equipmentRows = []
    const equipmentIdentities = new Set()
    for (const model of equipmentModels) {
      const key = String(model?.key ?? '').trim()
      const slot = String(model?.slot ?? '').trim()
      const variant = String(model?.variant ?? 'default').trim() || 'default'
      const identity = `${key}:${slot}:${variant}`
      if (!key || !slot) {
        issues.push(issue('equipment.identity-missing', 'У модели экипировки нет key или slot', { key: model?.key, slot: model?.slot }))
      } else if (equipmentIdentities.has(identity)) {
        issues.push(issue('equipment.identity-duplicate', `Модель экипировки ${identity} дублируется`, { key, slot, variant }))
      }
      equipmentIdentities.add(identity)
      const asset = inspectLocalAsset(root, model?.url)
      const modelExists = Boolean(asset.exists && asset.bytes > 0)
      // Файлы базового оружия уже проверены выше. Остальная экипировка,
      // включая фокусы, инструменты и зачарованную палочку, проверяется здесь.
      if (!attackDefaultIdentities.has(identity)) {
        if (!model?.url) issues.push(issue('equipment.url-missing', `Модель экипировки ${identity} не имеет URL`, { key, slot, variant }))
        else if (!modelExists) issues.push(issue('equipment.file-missing', `Файл модели экипировки ${identity} отсутствует или пуст`, { key, slot, variant, url: model.url, path: asset.path }))
      }
      equipmentRows.push({
        key,
        label: model?.label ?? null,
        category: model?.category ?? null,
        slot,
        variant,
        modelUrl: model?.url ?? null,
        modelExists,
      })
    }
    const actorManifestPath = join(root, 'public', 'assets', 'models', 'manifest.json')
    const actorManifest = existsSync(actorManifestPath) ? readJson(actorManifestPath) : null
    if (!actorManifest) issues.push(issue('actors.manifest-missing', 'Отсутствует manifest actor models', { path: actorManifestPath }))
    const actorRows = []
    for (const model of Array.isArray(actorManifest?.models) ? actorManifest.models : []) {
      const assetChecks = {}
      for (const field of ['url', 'equipmentUrl']) {
        if (model[field] === null || model[field] === undefined) continue
        const asset = inspectLocalAsset(root, model[field])
        assetChecks[field] = { url: model[field], exists: asset.exists && asset.bytes > 0, bytes: asset.bytes }
        if (!asset.exists || asset.bytes <= 0) issues.push(issue('actors.file-missing', `Файл actor model ${model.key}/${field} отсутствует или пуст`, { key: model.key, field, url: model[field], path: asset.path }))
      }
      const procedural = model.url == null
      if (procedural && !(model.rights?.license === 'original' && /процедур/iu.test(String(model.rights?.source ?? '')))) issues.push(issue('actors.procedural-unlabelled', `Процедурная модель ${model.key} не имеет явного rights.note`, { key: model.key }))
      actorRows.push({ key: model.key, profile: model.profile, renderFamily: procedural ? 'procedural' : model.profile, procedural, assets: assetChecks, rights: model.rights ?? null })
    }

    const audioResult = manifest ? validateAudioManifest(manifest, root, planEntries, issues) : { clips: new Map(), profiles: {} }
    const integration = [...auditIntegration(root), ...await auditAudioRuntime(audio, manifest)]
    for (const check of integration) if (!check.ok) issues.push(issue(`integration.${check.id}`, `Интеграционная проверка ${check.id} не подтверждена`, { evidence: check.evidence }))
    const supportCounts = Object.fromEntries([...new Set(spellRows.map((row) => row.mechanicsSupport).filter(Boolean))].map((status) => [status, spellRows.filter((row) => row.mechanicsSupport === status).length]))
    // Совпадение профилей выявляет кандидатов на визуальные дубли, но ни
    // различие метаданных, ни наличие renderer-а не доказывает качество кадра.
    const visualGroups = new Map()
    for (const row of spellRows) {
      const { familyNote, soundFamily, ...visual } = row.visualProfile
      const palette = spell.spellEffectPalette(row.id)
      const signature = JSON.stringify({ ...visual, primary: palette.primary, secondary: palette.secondary, fill: palette.fill, behavior: palette.behavior, cue: row.cue })
      if (!visualGroups.has(signature)) visualGroups.set(signature, [])
      visualGroups.get(signature).push(row.id)
    }
    const sharedVisualProfiles = [...visualGroups.values()].filter((ids) => ids.length > 1)
      .sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]))
    const report = {
      version: 1,
      ok: issues.length === 0,
      counts: { spells: spellRows.length, weapons: weaponRows.filter((row) => row.canonical).length, attackModels: weaponRows.length, equipmentModels: equipmentRows.length, actorModels: actorRows.length, audioClips: audioResult.clips.size, unsupportedSpellMechanics: (supportCounts.heuristic ?? 0) + (supportCounts['ruling-only'] ?? 0) },
      mechanicsSupport: supportCounts,
      presentationReview: {
        status: 'pending',
        basis: 'Сравнение настроенных профилей; просмотр 2D/3D, выбор целей и прослушивание этим аудитом не выполняются.',
        configuredVisualProfiles: visualGroups.size,
        sharedVisualProfiles,
      },
      spells: spellRows,
      weapons: weaponRows,
      equipmentModels: equipmentRows,
      actorModels: actorRows,
      audio: { manifest: manifest ? { version: manifest.version, path: audioManifestPath } : null, clips: [...audioResult.clips.values()], profiles: Object.keys(audioResult.profiles) },
      integration,
      issues,
    }
    return report
  } finally {
    runtimeBundle.cleanup()
  }
}

export { auditCombatPresentation }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await auditCombatPresentation()
    const output = process.argv.includes('--json') ? JSON.stringify(report, null, 2) : [
      `Combat presentation audit: ${report.ok ? 'PASS' : 'FAIL'}`,
      `spells=${report.counts.spells}, weapons=${report.counts.weapons}, actorModels=${report.counts.actorModels}, audioClips=${report.counts.audioClips}`,
      `Проверка структуры: ${report.ok ? 'пройдена' : 'ошибки'}; визуальная и звуковая приёмка: pending. Профилей: ${report.presentationReview.configuredVisualProfiles}; групп с общим профилем: ${report.presentationReview.sharedVisualProfiles.length}.`,
      ...report.issues.map((entry) => `- ${entry.code}: ${entry.message}`),
    ].join('\n')
    process.stdout.write(`${output}\n`)
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  REPUTATION_PRICE_BPS,
  REPUTATION_SOCIAL_DC_SHIFT,
} from '../server/reputation-policy.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

// Интерфейс разделён по задаче 0: часть экранов вынесена из App.tsx.
// Сторож читает весь корпус интерфейса, иначе проверка молча перестала бы
// что-либо охранять после переезда компонента.
const appSource = ['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-player-experience-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const helperPath = fileURLToPath(new URL('../src/player-experience.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2023,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, helperPath,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
renameSync(join(buildDir, 'player-experience.js'), join(buildDir, 'player-experience.mjs'))
const experience = await import(pathToFileURL(join(buildDir, 'player-experience.mjs')).href)

test.after(() => rmSync(buildDir, { recursive: true, force: true }))

test('публичная ступень славы объясняет ту же таблицу цен и социальных СЛ, что сервер', () => {
  for (const tier of ['reviled', 'distrusted', 'unknown', 'respected', 'honoured']) {
    const impact = experience.reputationImpactForTier(tier)
    assert.equal(impact.pricePercent, REPUTATION_PRICE_BPS[tier] / 100)
    assert.equal(impact.socialDcShift, REPUTATION_SOCIAL_DC_SHIFT[tier])
  }
  assert.match(appSource, /Слава меняет цены до ±10% и СЛ разговоров до ±3/u)
  assert.match(appSource, /скрытый счёт репутации остаётся у сервера/u)
  assert.doesNotMatch(appSource, /autonomy\?\.reputations/u)
})

test('HUD читает только отфильтрованные promises и threads из viewer state', () => {
  const state = normalizeCampaignState({
    sessionCode: 'HUD-SAFE',
    partyMemberIds: ['hero-a', 'hero-b'],
    activePlayerId: 'hero-a',
    scene: { title: 'Площадь', location: 'Площадь', cells: [] },
    players: [
      { id: 'hero-a', character: 'Ада', hp: 10, maxHp: 10, inventory: [] },
      { id: 'hero-b', character: 'Бор', hp: 10, maxHp: 10, inventory: [] },
    ],
    worldMemory: {
      entities: [], facts: [], relationships: [], epistemic_claims: [], knowledge_ledger: [],
      quests: [],
      threads: [
        { id: 'thread:open', title: 'Открытая нить', status: 'active', visibility: 'party', entity_ids: [], quest_ids: [] },
        { id: 'thread:hidden', title: 'Секрет ведущего', status: 'active', visibility: 'gm_only', entity_ids: [], quest_ids: [] },
      ],
      summaries: [],
    },
    social: {
      npcs: [{ id: 'npc', name: 'Марта', role: 'трактирщица', visibility: 'party' }],
      relationships: {},
      conversations: [],
      promises: [
        { id: 'promise:party', npc_id: 'npc', hero_id: 'hero-a', direction: 'npc_to_party', text: 'Обещание всему отряду', status: 'open', visibility: 'party' },
        { id: 'promise:a', npc_id: 'npc', hero_id: 'hero-a', direction: 'npc_to_party', text: 'Личное обещание Аде', status: 'open', visibility: 'specific_player' },
        { id: 'promise:b', npc_id: 'npc', hero_id: 'hero-b', direction: 'npc_to_party', text: 'Личное обещание Бору', status: 'open', visibility: 'specific_player' },
      ],
    },
  })

  const projected = campaignStateForViewer(state, { role: 'player', id: 'user-a' }, 'hero-a')
  assert.deepEqual(projected.worldMemory.threads.map((entry) => entry.title), ['Открытая нить'])
  assert.deepEqual(projected.social.promises.map((entry) => entry.text), [
    'Обещание всему отряду',
    'Личное обещание Аде',
  ])
  assert.match(appSource, /state\.social\?\.promises/u)
  assert.match(appSource, /state\.worldMemory\?\.threads/u)
  assert.doesNotMatch(appSource, /social\?\.relationships\b/u)
})

test('пауза видна всем, а resume остаётся owner-only и идёт через lifecycle endpoint', () => {
  assert.match(appSource, /lifecycleStatus === 'paused' && <CampaignPausedNotice/u)
  assert.match(appSource, /Продолжить игру может владелец кампании/u)
  assert.match(appSource, /canManage && <button[^>]+onClick=\{onResume\}/u)
  assert.match(appSource, /\/api\/campaigns\/\$\{encodeURIComponent\(state\.sessionCode\)\}\/lifecycle/u)
  assert.match(appSource, /canManageLifecycle && lifecycleStatus === 'paused'/u)
})

test('шпаргалка содержит четыре примера, сохраняет dismiss и всегда открывается повторно', () => {
  assert.equal((appSource.match(/<li>«/gu) ?? []).length, 4)
  assert.match(appSource, /Кликайте по клеткам, фишкам и предметам/u)
  assert.match(appSource, /NEWBIE_GUIDE_DISMISSED_KEY/u)
  assert.match(appSource, /window\.localStorage\.setItem\(NEWBIE_GUIDE_DISMISSED_KEY, 'true'\)/u)
  assert.match(appSource, /setNewbieGuideOpen\(true\)/u)
})

test('экран уровня появляется только после подтверждённого event/state transition и один раз на уровень', () => {
  const hero = { id: 'hero', character: 'Ада', level: 2 }
  assert.deepEqual(experience.confirmedLevelUps({}, [hero], []), [], 'начальная загрузка не празднуется')
  assert.deepEqual(experience.confirmedLevelUps({ hero: 1 }, [hero], []), [
    { playerId: 'hero', character: 'Ада', level: 2 },
  ])
  assert.deepEqual(experience.confirmedLevelUps({ hero: 2 }, [hero], [{
    event_type: 'CharacterLeveledUp', actor_id: 'hero', visibility: 'party', payload: { level_after: 2 },
  }]), [
    { playerId: 'hero', character: 'Ада', level: 2 },
  ])
  assert.deepEqual(experience.confirmedLevelUps({ hero: 2 }, [hero], [{
    event_type: 'CharacterLeveledUp', actor_id: 'hero', visibility: 'party', payload: { level_after: 3 },
  }]), [], 'событие без совпавшего server state недостаточно')
  assert.equal(experience.levelUpSeenKey('ROOM A', 'hero/1', 2), 'skazanie-level-up-seen-v1:ROOM%20A:hero%2F1:2')
  assert.match(appSource, /localStorage\.setItem\(levelUpSeenKey/u)
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.level-up-backdrop, \.level-up-screen, \.level-up-rays \{ animation: none; \}/u)
})

test('neutral-фишка строится только из viewer-safe scene_npcs PR18 и неизвестную стойку трактует нейтрально', () => {
  const fixture = [
    {
      id: 'npc:merchant', name: 'Марта', role: 'трактирщица', location_id: 'inn',
      x: 3, y: 4, anchor_prop_id: 'counter', stance: 'friendly', alive: true, health_status: 'unharmed',
    },
    {
      id: 'npc:future', name: 'Странник', role: 'путник', location_id: 'inn',
      x: 5, y: 4, anchor_prop_id: null, stance: 'mysterious', alive: true, health_status: 'hurt',
    },
    {
      id: 'npc:remote', name: 'Дальний', role: 'страж', location_id: 'gate',
      x: 1, y: 1, anchor_prop_id: null, stance: 'wary', alive: true, health_status: 'unharmed',
    },
  ]
  const shown = experience.sceneNpcsAt(fixture, 'inn', { columns: 8, rows: 8 }, new Set(['npc:future']))
  assert.deepEqual(shown.map((npc) => npc.id), ['npc:merchant'])
  assert.equal(experience.visibleNpcStance('friendly'), 'friendly')
  assert.equal(experience.visibleNpcStance('mysterious'), 'neutral')
  assert.ok(fixture.every((npc) => !('hp' in npc) && !('max_hp' in npc) && !('goals' in npc) && !('beliefs' in npc)))

  const sceneNpcType = typesSource.match(/export type SceneNpcProjection = \{[\s\S]*?\n\}/u)?.[0] ?? ''
  assert.match(sceneNpcType, /location_id: string[\s\S]*x: number[\s\S]*y: number/u)
  assert.doesNotMatch(sceneNpcType, /\bhp\b|max_hp|goals|beliefs/u)
  assert.match(appSource, /state\.scene_npcs \?\? \[\]/u)
  assert.match(appSource, /data-token-role="neutral"/u)
  assert.match(appSource, /<span className="neutral-nameplate">\{sceneNpc\.name\}<\/span>/u)
  assert.doesNotMatch(appSource, /sceneNpc\.(?:hp|max_hp|goals|beliefs)/u)
  assert.match(stylesSource, /\.neutral-token \{[\s\S]*0 0 0 2px var\(--neutral-ring\)/u)
})

test('merchant token открывает существующий MerchantScreen по точному общему id и не создаёт торговую механику', () => {
  assert.match(appSource, /state\.merchants\?\.find\(\(merchant\) => merchant\.id === sceneNpc\.id\)/u)
  assert.match(appSource, /onClick=\{\(\) => onOpenMerchant\(sceneNpc\.id\)\}/u)
  assert.match(appSource, /merchantScreenMerchants/u)
  assert.match(appSource, /<MerchantScreen merchants=\{merchantScreenMerchants\}/u)
  assert.match(appSource, /Торговля недоступна во время боя/u)
  assert.match(appSource, /onClick=\{\(\) => openNpcDossier\(sceneNpc\.id, 'transfer'\)\}/u)
})

test('сводка NPC берётся из синхронизируемого battleLog и прекращается после действия героя', () => {
  const enemyMove = { id: 'e1', type: 'move', actorKind: 'enemy', actorId: 'goblin', targetId: 'hero' }
  const enemyAttack = { id: 'e2', type: 'attack', actorKind: 'enemy', actorId: 'goblin', targetId: 'hero', damage: 3 }
  const heroAttack = { id: 'p1', type: 'attack', actorKind: 'player', actorId: 'hero', targetId: 'goblin', damage: 5 }
  assert.deepEqual(experience.latestNpcTurnEvents([heroAttack, enemyMove, enemyAttack]).map((event) => event.id), ['e1', 'e2'])
  assert.deepEqual(experience.latestNpcTurnEvents([enemyMove, enemyAttack, heroAttack]), [])
  assert.match(appSource, /latestNpcTurnEvents\(state\.battleLog \?\? \[\]\)/u)
  assert.match(appSource, /ПОКА ВЫ ЖДАЛИ/u)
})

test('прогноз последствий показывает server-owned шанс, ожидаемый урон и причины преимущества', () => {
  assert.match(appSource, /inspectedForecast\.hit_chance/u)
  assert.match(appSource, /inspectedForecast\.average_damage/u)
  assert.match(appSource, /inspectedForecast\.advantage_sources\.map/u)
  assert.match(appSource, /inspectedForecast\.disadvantage_sources\.map/u)
  assert.match(appSource, /Прогноз[^]*?Все числа уже пришли с сервера/u)
})

test('боевая хроника и фишки связываются только по участникам committed-события', () => {
  const participants = experience.battleEventParticipantIds({
    id: 'battle:1', type: 'attack', actorId: 'hero', targetId: 'goblin',
    participantIds: ['hero', 'witness'],
  })
  assert.deepEqual(participants, ['hero', 'goblin', 'witness'])
  assert.match(appSource, /battleEventParticipantIds\(event\)/u)
  assert.match(appSource, /setLinkedParticipantIds\(participantIds\)/u)
  assert.match(appSource, /linkedParticipantIds\.includes\(enemy\.id\)/u)
  assert.match(stylesSource, /\.journal-linked/u)
})

test('история урона использует только записанный battleLog и не восстанавливает скрытые ОЗ', () => {
  const history = experience.recentDamageForTarget([
    { id: 'one', type: 'attack', actorId: 'hero', targetId: 'goblin', damage: 4, damageType: 'slashing', round: 1 },
    { id: 'miss', type: 'attack', actorId: 'hero', targetId: 'goblin', damage: 0, round: 1 },
    { id: 'other', type: 'attack', actorId: 'goblin', targetId: 'hero', damage: 2, round: 1 },
    { id: 'two', type: 'spell-damage', actorId: 'mage', targetId: 'goblin', damage: 7, round: 2 },
  ], 'goblin')
  assert.deepEqual(history.map((entry) => [entry.id, entry.amount]), [['two', 7], ['one', 4]])
  assert.match(appSource, /recentDamageForTarget\(state\.battleLog \?\? \[\], inspectedTarget\.id\)/u)
  assert.match(appSource, /ИСТОРИЯ УРОНА/u)
})

test('новый committed-текст показывается целиком поверх сцены и остаётся в журнале', () => {
  assert.match(appSource, /setCinematicNarration\(latestNarratorMessage\)/u)
  assert.match(appSource, /<p>\{cinematicNarrationText \|\| 'Сцена складывается…'\}<\/p>/u)
  assert.match(appSource, /Сохранено в журнале кампании/u)
  assert.match(appSource, /state\.messages\.map/u)
  assert.match(stylesSource, /\.cinematic-narration/u)
})

test('stream preview заменяет текст целым snapshot и не показывает replay/aborted/replaced', () => {
  assert.match(appSource, /import type \{ NarrationPreview \} from '\.\/ai-client'/u)
  assert.match(appSource, /merchantNarration, narrationPreview, clearTacticalError/u)
  assert.doesNotMatch(appSource, /as typeof gameSession/u)
  assert.match(appSource, /visibleNarrationPreview\?\.text \?\? cinematicNarration\?\.text/u)
  assert.match(appSource, /narrationPreview\.replayed !== true/u)
  assert.match(appSource, /narrationPreview\.phase !== 'aborted'/u)
  assert.match(appSource, /narrationPreview\.phase !== 'replaced'/u)
  assert.doesNotMatch(appSource, /cinematicNarrationText\s*\+=|narrationPreview\.text\.slice/u)
})

test('ожидание генерации меняет свет и аудиошину без десятого профиля', () => {
  assert.match(appSource, /atmosphereAudioRef\.current\?\.setWaiting\(state\.isNarrating\)/u)
  assert.match(appSource, /state\.isNarrating \? 'is-narrating' : ''/u)
  assert.match(stylesSource, /\.game-area\.is-narrating \.map-atmosphere-one/u)
})

test('NPC-досье читает viewer-safe разговоры, отношение и обещания и передаёт npc_id отдельно', () => {
  assert.match(typesSource, /conversations\?: Array<\{/u)
  assert.match(appSource, /state\.social\?\.relationship_tiers\?\.\[dossierSceneNpc\.id\]\?\.\[typingActorId\]/u)
  assert.match(appSource, /state\.social\?\.conversations \?\? \[\]/u)
  assert.match(appSource, /conversation\.npc_id === dossierSceneNpc\.id/u)
  assert.match(appSource, /promise\.npc_id === dossierSceneNpc\.id && promise\.status === 'open'/u)
  assert.match(appSource, /Обращаюсь к \$\{dossierSceneNpc\.name\}/u)
  assert.match(appSource, /onNpcAction\(addressed, dossierSceneNpc\.id\)/u)
  assert.match(appSource, /onNpcAction=\{\(text, npcId\) => submitAction\(text, activePlayer\.id, npcId\)\}/u)
  assert.doesNotMatch(appSource, /submitActionWithNpc/u)
  assert.match(appSource, /Адресат закрепляется отдельно как <code>npc_id<\/code>/u)
  assert.doesNotMatch(appSource, /submitAction\([^)]*npc_id/u)
})

test('подарок NPC выбирается из свободного инвентаря героя и подтверждается сервером', () => {
  assert.match(appSource, /onTransferItem: \(itemId: string, npcId: string, quantity: number\) => Promise<CommandOutcome>/u)
  assert.match(appSource, /Number\(item\.quantity \?\? 0\) > 0[\s\S]*&& !item\.equipped[\s\S]*&& !item\.attuned_to/u)
  assert.match(appSource, /const dossierCanReceiveGift = Boolean\([\s\S]*dossierSceneNpc\?\.alive[\s\S]*dossierSocialNpc\?\.available !== false[\s\S]*!combatActive[\s\S]*!narrating[\s\S]*!tacticalBusy/u)
  assert.match(appSource, /min=\{1\}[\s\S]*max=\{selectedGiftAvailable\}/u)
  assert.match(appSource, /onTransferItem\(selectedGiftItem\.id, dossierSceneNpc\.id, giftQuantity\)/u)
  assert.match(appSource, /if \(outcome\.ok\) \{\s*setNpcDossier\(null\)/u)
  assert.match(appSource, /onTransferItem=\{\(itemId, npcId, quantity\) => transferItem\(activePlayer\.id, itemId, npcId, quantity\)\}/u)
  assert.match(appSource, /\{tacticalError && <p className="npc-gift-error">\{tacticalError\}<\/p>\}/u)
  assert.doesNotMatch(appSource, /\bprompt\(/u)
  assert.doesNotMatch(appSource, /npc_world/u)
})

test('NPC-досье загружает authenticated same-origin портрет и имеет нейтральный fallback', () => {
  const portraitComponent = appSource.match(/function NpcPortrait\([\s\S]*?\n\}/u)?.[0] ?? ''
  assert.match(portraitComponent, /\/api\/campaigns\/\$\{encodeURIComponent\(campaignId\)\}\/npcs\/\$\{encodeURIComponent\(npcId\)\}\/portrait/u)
  assert.match(portraitComponent, /<img src=\{portraitUrl\} alt=\{`Портрет: \$\{name\}`\}/u)
  assert.match(portraitComponent, /onError=\{\(\) => setFailed\(true\)\}/u)
  assert.match(portraitComponent, /Нейтральный портрет-заглушка/u)
  assert.doesNotMatch(portraitComponent, /base64|localStorage/u)
  assert.match(appSource, /<NpcPortrait campaignId=\{state\.sessionCode\} npcId=\{dossierSceneNpc\.id\}/u)
})

import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import {
  BrainCircuit, ChevronDown, ChevronRight, Dices, Globe2, HelpCircle, History,
  MessageSquare, Plus, RefreshCw, ScrollText, Send, ShieldCheck, Sparkles,
  Swords, Target, Users, Volume2, VolumeX, X, Check, RotateCcw, SlidersHorizontal, Store, Wifi, WifiOff, Lock, Shield, Bell, BellOff,
} from 'lucide-react'

import { fetchWithTimeout } from './ai-client'
import {
  ABILITY_LABELS, DIFFICULTY_LABELS, PageHeader, SKILL_LABELS, UI_SCALE_MAX, UI_SCALE_MIN,
  UI_SCALE_PRESETS, battleEventText, clampUiScale, locationsMatch,
} from './app-shared'
import { chronicleMatchesFilter, isChronicleNearBottom, type ChronicleFilter } from './chat-chronicle.mjs'
import type { NarrationVoiceMode } from './narration-tts.mjs'
import { localizedQuestClockLabel } from './desktop-ui.mjs'
import type { AtmosphereSettings } from './atmosphere-audio'
import type {
  Account, AgentInteraction, AiHealth, AssetPreparationReport, CampaignAiSettings, CampaignAiSettingsResponse,
  CampaignSummary, EncounterProposal, GameState, Merchant, Message, Player,
} from './types'
import { useGameSession, type EncounterAssemblyOptions, type ShopAssemblyOptions } from './useGameSession'

/**
 * Разделы, которые открываются поверх комнаты и ничего не знают о тактической
 * доске: журнал, чат, настройки, администрирование, список кампаний.
 *
 * Вынесены из `App.tsx` по задаче 0 бэклога. Правок поведения в этом файле нет —
 * только адрес кода: раньше `App.tsx` был единственным файлом на весь интерфейс
 * и оставался главным источником конфликтов между потоками работ.
 */

// Список режимов импровизации приходит с сервера вместе с настройками; здесь —
// только запасной вариант на время загрузки, чтобы селектор не оставался пустым.
const IMPROV_MODE_FALLBACK: CampaignAiSettingsResponse['improvModes'] = [
  { id: 'story', label: 'Сюжет', description: 'свобода в сценах, но главная линия в приоритете' },
  { id: 'chaos', label: 'Хаос', description: 'можно всё, мир подстраивается под выбор отряда' },
]

export function CampaignModal({ state, onSwitch, onAccountRefresh, onCreateHero, onWizardChange, onClose }: { state: GameState; onSwitch: (code: string, room?: { version?: number; state?: GameState | null }) => Promise<void>; onAccountRefresh: () => Promise<Account | null>; onCreateHero: (heroId: string) => void; onWizardChange?: (open: boolean) => void; onClose: () => void }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [wizard, setWizard] = useState(false)
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [partyName, setPartyName] = useState('')
  const [code, setCode] = useState('')
  const [world, setWorld] = useState({ preset: '', era: '', genre: '', tone: '', premise: '', themes: '', boundaries: '', magicLevel: '', technologyLevel: '', startingLocation: '', openingSituation: '' })
  // Соло-кампания — полноценный режим. Мест ровно столько, сколько игроков
  // сядет за стол; лишние места иначе висят пустыми и блокируют ход.
  const [slotCount, setSlotCount] = useState(1)
  // Режим импровизации выбирается при старте, но записывается тем же
  // settings-эндпоинтом, что и потом: второго пути записи настроек нет.
  const [improvMode, setImprovMode] = useState<CampaignAiSettings['improvMode']>('story')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setCampaignsLoading(true)
    setError('')
    try {
      const campaignsResponse = await fetchWithTimeout(
        '/api/campaigns',
        {},
        15_000,
        'Список кампаний не загрузился вовремя. Сохранённые кампании не удалены.',
      )
      const campaignsBody = await campaignsResponse.json() as { campaigns?: CampaignSummary[]; error?: string }
      if (!campaignsResponse.ok) throw new Error(campaignsBody.error || 'Не удалось загрузить кампании')
      setCampaigns(campaignsBody.campaigns ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ошибка загрузки кампаний')
    } finally {
      setCampaignsLoading(false)
    }
  }
  useEffect(() => { void load() }, [])
  // Мастер создания мира — отдельный экран для звука. Окно кампаний о звуке
  // ничего не знает и знать не должно: оно только сообщает, открыт ли мастер.
  useEffect(() => {
    onWizardChange?.(wizard)
    return () => onWizardChange?.(false)
  }, [wizard, onWizardChange])

  const validateStep = () => {
    setError('')
    if (step === 1 && code && !/^[A-Z0-9-]{3,24}$/.test(code)) { setError('Код комнаты должен содержать 3–24 латинских буквы, цифры или дефисы — либо оставьте его пустым для автогенерации.'); return false }
    return true
  }

  const create = async () => {
    if (!validateStep()) return
    setBusy(true)
    setError('')
    try {
      const resolvedCode = code || `WORLD-${(globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)).replace(/-/g, '').slice(0, 8).toUpperCase()}`
      const response = await fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: resolvedCode, name: name.trim(), bootstrap: { partyName: partyName.trim(), world, slotCount } }) })
      const body = await response.json() as { version?: number; state?: GameState | null; error?: string }
      if (!response.ok) throw new Error(body.error || 'Не удалось создать кампанию')
      // «Сюжет» — серверный дефолт, поэтому лишний PATCH не отправляем: он
      // сменой не является и записал бы в летопись ложное «режим изменён».
      if (improvMode !== 'story') {
        // Кампания уже создана и играбельна. Если настройка не записалась,
        // мир не теряем: владелец переключит режим на экране настроек.
        await fetch(`/api/campaigns/${encodeURIComponent(resolvedCode)}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ improvMode }),
        }).catch(() => null)
      }
      await onAccountRefresh()
      await onSwitch(resolvedCode, body)
      onClose()
      const ownerSlotId = body.state?.players.find((hero) => hero.characterSetupRequired)?.id
      if (ownerSlotId) onCreateHero(ownerSlotId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось создать кампанию') }
    finally { setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={'modal campaign-modal ' + (wizard ? 'campaign-wizard' : '')} role="dialog" aria-modal="true" aria-labelledby="campaign-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть выбор кампании" title="Закрыть"><X size={19} /></button>
        <div className="modal-icon"><ScrollText size={23} /></div>
        <span className="eyebrow">КАМПАНИИ И ГРУППЫ</span>
        <h2 id="campaign-modal-title">{wizard ? 'Создание нового мира' : 'Выберите приключение'}</h2>
        {!wizard ? <>
          <div className="campaign-list">
            {campaignsLoading && <p className="campaign-empty campaign-loading" role="status"><RefreshCw className="spinning" size={14} />Загружаем кампании…</p>}
            {campaigns.map((campaign) => <button key={campaign.code} className={campaign.code === state.sessionCode ? 'active' : ''} onClick={async () => { setBusy(true); setError(''); try { await onSwitch(campaign.code); onClose() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ошибка переключения') } finally { setBusy(false) } }} disabled={busy}>
              <span><b>{campaign.name}</b><small>{campaign.partyName} · {campaign.memberCount} участников{campaign.setting ? ' · ' + campaign.setting : ''}</small></span><em>{campaign.code}</em>
            </button>)}
            {!campaignsLoading && !campaigns.length && !error && <p className="campaign-empty">Доступных кампаний пока нет.</p>}
            {!campaignsLoading && !!error && <button type="button" className="campaign-retry" onClick={() => void load()} disabled={busy}><RefreshCw size={14} />Повторить загрузку кампаний</button>}
          </div>
          <button className="campaign-start-wizard" onClick={() => setWizard(true)}><Plus size={15} />Создать полностью новую кампанию</button>
        </> : <>
          <div className="campaign-steps"><span className={step >= 1 ? 'active' : ''}>1 · Мир</span><i /><span className={step >= 2 ? 'active' : ''}>2 · Герои</span><i /><span className={step >= 3 ? 'active' : ''}>3 · Пролог</span></div>
          {step === 1 && <div className="world-creator">
            <div className="world-auto-note"><Sparkles size={15} /><span><b>Все поля необязательны.</b> Оставьте их пустыми, и рассказчик сам случайно придумает мир, его историю и первую сцену.</span></div>
            <div className="field-grid three"><label><span>Название кампании · необязательно</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Придумает рассказчик" /></label><label><span>Название группы · необязательно</span><input value={partyName} onChange={(event) => setPartyName(event.target.value)} placeholder="Новый отряд" /></label><label><span>Код комнаты · необязательно</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} placeholder="Создастся автоматически" maxLength={24} /></label></div>
            <label><span>Пресет или своё описание · необязательно</span><input list="world-preset-options" value={world.preset} onChange={(event) => setWorld({ ...world, preset: event.target.value })} placeholder="Например: фэнтези, далёкое будущее — или любое своё описание" /><datalist id="world-preset-options"><option value="Классическое фэнтези" /><option value="Тёмное фэнтези" /><option value="Далёкое будущее" /><option value="Космическая опера" /><option value="Современная мистика" /><option value="Постапокалипсис" /></datalist></label>
            <div className="field-grid"><label><span>Эпоха · необязательно</span><input value={world.era} onChange={(event) => setWorld({ ...world, era: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Жанр · необязательно</span><input value={world.genre} onChange={(event) => setWorld({ ...world, genre: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Тон истории · необязательно</span><input value={world.tone} onChange={(event) => setWorld({ ...world, tone: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Уровень магии · необязательно</span><input value={world.magicLevel} onChange={(event) => setWorld({ ...world, magicLevel: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Уровень технологий · необязательно</span><input value={world.technologyLevel} onChange={(event) => setWorld({ ...world, technologyLevel: event.target.value })} placeholder="На усмотрение рассказчика" /></label><label><span>Стартовая локация · необязательно</span><input value={world.startingLocation} onChange={(event) => setWorld({ ...world, startingLocation: event.target.value })} placeholder="На усмотрение рассказчика" /></label></div>
            <label><span>Основа мира и желаемая история</span><textarea value={world.premise} onChange={(event) => setWorld({ ...world, premise: event.target.value })} placeholder="Что существует в мире, о чём должна быть кампания, какие конфликты интересны?" /></label>
            <label><span>С чего начинается первая сцена</span><textarea value={world.openingSituation} onChange={(event) => setWorld({ ...world, openingSituation: event.target.value })} placeholder="Например: герои прибывают на станцию в момент исчезновения дипломатического корабля" /></label>
            <div className="field-grid"><label><span>Темы и мотивы</span><input value={world.themes} onChange={(event) => setWorld({ ...world, themes: event.target.value })} placeholder="Исследование, политика, выживание…" /></label><label><span>Границы контента</span><input value={world.boundaries} onChange={(event) => setWorld({ ...world, boundaries: event.target.value })} placeholder="Что не должно появляться в истории" /></label></div>
            <label><span>Режим импровизации</span>
              <select value={improvMode} onChange={(event) => setImprovMode(event.currentTarget.value as CampaignAiSettings['improvMode'])} aria-label="Режим импровизации кампании">
                {IMPROV_MODE_FALLBACK.map((improv) => <option key={improv.id} value={improv.id}>{improv.label} — {improv.description}</option>)}
              </select>
              <small>Режим можно поменять и позже, на экране настроек кампании.</small>
            </label>
          </div>}
          {step === 2 && <div className="hero-creator slot-creator">
            <div className="world-auto-note"><Users size={17} /><span><b>Сколько игроков сядет за стол?</b> Первое место всегда ваше, остальные заполнят приглашённые друзья при входе по ссылке. Пустых мест не останется.</span></div>
            <div className="slot-count-picker" role="group" aria-label="Число мест героев">
              {[1, 2, 3, 4, 5].map((count) => <button key={count} type="button" className={count === slotCount ? 'selected' : ''} aria-pressed={count === slotCount} onClick={() => setSlotCount(count)}>
                <strong>{count}</strong><small>{count === 1 ? 'соло-кампания' : `${count} ${count >= 5 ? 'игроков' : 'игрока'}`}</small>
              </button>)}
            </div>
            <div className="hero-library">{Array.from({ length: slotCount }, (_, index) => index + 1).map((slot) => <div className="hero-slot-preview" key={slot}><span>{slot}</span><div><b>{slot === 1 ? 'Ваш герой' : `Герой друга ${slot - 1}`}</b><small>Класс, вид, характеристики и история ещё не выбраны</small></div><ShieldCheck size={16} /></div>)}</div>
          </div>}
          {step === 3 && <div className="campaign-review"><span><Sparkles size={22} /></span><h3>Рассказчик готов создать мир</h3><p>Сначала появятся мир, первая сцена и места героев. Затем каждый игрок создаст собственного героя через серверно проверяемый мастер.</p><dl><div><dt>Кампания</dt><dd>{name.trim() || 'Название придумает рассказчик'}{partyName.trim() ? ` · отряд «${partyName.trim()}»` : ''}</dd></div><div><dt>Мир</dt><dd>{[world.preset, world.era, world.genre].filter(Boolean).join(' · ') || 'Полная автоматическая генерация'}</dd></div>{world.premise.trim() && <div><dt>Основа</dt><dd>{world.premise.trim()}</dd></div>}<div><dt>Начало</dt><dd>{world.openingSituation || 'Придумает рассказчик'}</dd></div><div><dt>Герои</dt><dd>{slotCount === 1 ? 'одно место · соло-кампания' : `${slotCount} места · первый герой ваш`}</dd></div><div><dt>Импровизация</dt><dd>{IMPROV_MODE_FALLBACK.find((improv) => improv.id === improvMode)?.label ?? 'Сюжет'}</dd></div></dl><small>Ни один игрок не сможет сделать первый ход, пока не завершит создание закреплённого за ним героя.</small></div>}
          <div className="campaign-wizard-actions"><button onClick={() => step === 1 ? setWizard(false) : setStep((current) => current - 1)}>{step === 1 ? 'К списку кампаний' : 'Назад'}</button>{step < 3 ? <button className="primary" onClick={() => { if (validateStep()) setStep((current) => current + 1) }}>Продолжить<ChevronRight size={14} /></button> : <button className="primary" onClick={() => { void create() }} disabled={busy}><Sparkles size={14} />{busy ? 'Рассказчик создаёт мир…' : 'Создать мир и написать пролог'}</button>}</div>
        </>}
        {error && <div className="admin-error">{error}</div>}
      </div>
    </div>
  )
}
export function AgentInteractionCard({ interaction, players, playerId, canContinue, onVote, onAbstain, onRoll, onContinue }: {
  interaction: AgentInteraction
  players: Player[]
  playerId: string
  canContinue: boolean
  onVote: (optionId: string) => void
  onAbstain: () => void
  onRoll: () => void
  onContinue: () => void
}) {
  const voterId = interaction.voterByActorId?.[playerId]
  const selected = Object.entries(interaction.votes).find(([actorId]) => (interaction.voterByActorId?.[actorId] ?? actorId) === (voterId ?? playerId))?.[1]
  const resolved = interaction.status === 'resolved'
  const winner = interaction.options.find((option) => option.id === interaction.resolvedOptionId)
  const quorum = interaction.requiredVotes ?? interaction.eligibleVoterIds?.length ?? interaction.eligibleActorIds?.length ?? players.filter((player) => player.online).length
  const activeVoters = interaction.activeVoterIds?.length ?? interaction.eligibleVoterIds?.length ?? interaction.eligibleActorIds?.length ?? players.filter((player) => player.online).length
  const ttlSeconds = Math.max(1, Math.round((interaction.policy?.decisionTtlMs ?? 120_000) / 1_000))
  const eligibleActors = interaction.eligibleActorIds?.length ? interaction.eligibleActorIds : players.map((player) => player.id)
  const participantByVoter = new Map<string, Player>()
  for (const actorId of eligibleActors) {
    const player = players.find((candidate) => candidate.id === actorId)
    if (player) participantByVoter.set(interaction.voterByActorId?.[actorId] ?? actorId, player)
  }
  const votedVoters = new Set(Object.keys(interaction.votes).map((actorId) => interaction.voterByActorId?.[actorId] ?? actorId))
  const abstainedVoters = new Set(interaction.abstainedVoterIds ?? [])
  return (
    <section className={['agent-interaction', 'agent-interaction--' + interaction.type, resolved ? 'resolved' : ''].join(' ')} aria-label="Групповое решение">
      <div className="agent-interaction__head">
        <span><BrainCircuit size={15} />Решение отряда</span>
        <strong>{interaction.title}</strong>
        <p>{interaction.description}</p>
        <small className="agent-interaction__policy">Один голос на аккаунт · активны {activeVoters} · отключение = воздержание · автоисход через {ttlSeconds} с</small>
      </div>
      {interaction.type === 'roll' ? (
        <button className="agent-roll" onClick={onRoll} disabled={resolved}>
          <Dices size={22} /><span><b>{resolved ? 'Выпало ' + (interaction.roll?.value ?? '?') : 'Бросить кубик судьбы'}</b><small>Сложность {interaction.difficulty ?? 12} · один бросок на отряд</small></span>
        </button>
      ) : (
        <div className="agent-options">
          {interaction.options.map((option) => {
            const votes = Object.values(interaction.votes).filter((vote) => vote === option.id).length
            const voters = Object.entries(interaction.votes)
              .filter(([, vote]) => vote === option.id)
              .map(([actorId]) => players.find((player) => player.id === actorId)?.character ?? actorId)
            return <button key={option.id} className={[selected === option.id ? 'selected' : '', winner?.id === option.id ? 'winner' : ''].join(' ')} onClick={() => onVote(option.id)} disabled={resolved}>
              <span>{option.label}</span><small>{votes} / {quorum} голосов{voters.length ? ` · ${voters.join(', ')}` : ''}</small>
            </button>
          })}
        </div>
      )}
      {interaction.type !== 'roll' && <div className="agent-voter-status" aria-label="Состояние участников голосования">
        {[...participantByVoter.entries()].map(([voterId, player]) => {
          const status = votedVoters.has(voterId) ? 'voted' : abstainedVoters.has(voterId) ? 'abstained' : player.online ? 'waiting' : 'offline'
          const label = status === 'voted' ? 'голос учтён' : status === 'abstained' ? 'воздержался' : status === 'offline' ? 'не в сети' : 'ждём голос'
          return <span key={voterId} className={status}><i />{player.character}<small>{label}</small></span>
        })}
      </div>}
      {!resolved && interaction.type !== 'roll' && <button className="agent-abstain" onClick={onAbstain}>Воздержаться</button>}
      {resolved && <button className="agent-continue" onClick={onContinue} disabled={!canContinue} title={canContinue ? 'Передать подтверждённое решение Рассказчику' : 'Продолжить может владелец выбранного героя'}><Sparkles size={14} />Продолжить историю: {winner?.label}</button>}
    </section>
  )
}

export function stakesTitle(stakes: NonNullable<Message['stakes']>) {
  const skill = stakes.skill ? SKILL_LABELS[stakes.skill] ?? stakes.skill : ''
  const ability = stakes.ability ? ABILITY_LABELS[stakes.ability] ?? stakes.ability : ''
  const name = skill || ability || 'Проверка'
  const both = skill && ability ? `${skill} (${ability})` : name
  const category = stakes.difficulty_category ? DIFFICULTY_LABELS[stakes.difficulty_category] ?? '' : ''
  return `${both} · СЛ ${stakes.difficulty}${category ? ` · ${category}` : ''}`
}

export function ChatPanel({ messages, isNarrating, interaction, players, typingActorIds, currentPlayerId, canAct, combatActive, suggestedActions, sceneKey, onVote, onAbstain, onRollInteraction, onContinueInteraction, onWhy, onSpeak, open, onToggle }: {
  messages: ReturnType<typeof useGameSession>['state']['messages']; isNarrating: boolean; interaction?: AgentInteraction | null; players: Player[]; typingActorIds: string[]; currentPlayerId: string; canAct: boolean; combatActive: boolean; suggestedActions: Array<{ id: string; text: string }>; sceneKey: string; onVote: (optionId: string) => void; onAbstain: () => void; onRollInteraction: () => void; onContinueInteraction: () => void; onWhy: () => void; onSpeak?: ((text: string) => void) | null; open: boolean; onToggle: () => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  // Закрытие держится до смены сцены: ключ и есть «та же сцена». Иначе панель
  // возвращалась бы на каждый ответ рассказчика и раздражала бы ровно тех, кто
  // её только что закрыл.
  const [hintsDismissedFor, setHintsDismissedFor] = useState('')
  const hintsKey = `${sceneKey}`
  const visibleHints = hintsDismissedFor === hintsKey ? [] : suggestedActions
  const [filter, setFilter] = useState<ChronicleFilter>('all')
  const [followLatest, setFollowLatest] = useState(true)
  const [unreadCount, setUnreadCount] = useState(0)
  const visibleMessages = useMemo(
    () => messages.filter((message) => chronicleMatchesFilter(message.speaker, filter)),
    [filter, messages],
  )
  const visibleCountRef = useRef(visibleMessages.length)

  // Эффект ведёт себя как реакция на приход сообщений, поэтому `followLatest`
  // читается, но в зависимости не входит намеренно: сам по себе возврат к низу
  // ленты уже обработан в `handleScroll`, и повторный прыжок там не нужен.
  // Значение при этом свежее — замыкание пересобирается на каждый рендер.
  useEffect(() => {
    const newMessageCount = Math.max(0, visibleMessages.length - visibleCountRef.current)
    visibleCountRef.current = visibleMessages.length
    if (followLatest) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
      setUnreadCount(0)
    } else if (newMessageCount > 0) {
      setUnreadCount((count) => count + newMessageCount)
    }
  }, [isNarrating, visibleMessages.length])

  function chooseFilter(nextFilter: ChronicleFilter) {
    setFilter(nextFilter)
    setFollowLatest(true)
  }

  function handleScroll() {
    const viewport = messagesRef.current
    if (!viewport) return
    const nearBottom = isChronicleNearBottom(viewport)
    setFollowLatest(nearBottom)
    if (nearBottom) setUnreadCount(0)
  }

  function scrollToLatest() {
    setFollowLatest(true)
    setUnreadCount(0)
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  if (!open) {
    return <button className="chat-closed" onClick={onToggle}><MessageSquare size={19} /><span>История</span><b>{messages.length}</b></button>
  }

  return (
    <section className="chat-panel" aria-label="Что происходит в сцене">
      <div className="chat-head">
        <div>
          <span className="chat-head-eyebrow">ЧТО ПРОИСХОДИТ</span>
          <nav className="chronicle-filters" aria-label="Фильтр хроники">
            <button className={filter === 'all' ? 'active' : ''} type="button" onClick={() => chooseFilter('all')} aria-pressed={filter === 'all'}>Всё</button>
            <button className={filter === 'story' ? 'active' : ''} type="button" onClick={() => chooseFilter('story')} aria-pressed={filter === 'story'}>Рассказ</button>
            <button className={filter === 'combat' ? 'active' : ''} type="button" onClick={() => chooseFilter('combat')} aria-pressed={filter === 'combat'}>Бой</button>
          </nav>
        </div>
        <button className="icon-button" onClick={onToggle} aria-label="Свернуть историю"><ChevronDown size={20} /></button>
      </div>
      {/* Групповое решение остаётся рядом с хроникой. Проверка вынесена на карту:
          она относится к текущему действию и не должна раздувать колонку истории. */}
      <div className="chat-interaction-slot">
        {interaction ? <AgentInteractionCard interaction={interaction} players={players} playerId={currentPlayerId} canContinue={canAct} onVote={onVote} onAbstain={onAbstain} onRoll={onRollInteraction} onContinue={onContinueInteraction} /> : null}
      </div>
      {/* Подсказки новичку. Закрываются на месте и не возвращаются до смены
          сцены; выключенные настройкой не приходят сюда вовсе. */}
      {visibleHints.length > 0 && (
        <aside className="action-hints" aria-label="Что можно сделать">
          <div className="action-hints-head">
            <span><Sparkles size={14} />Что можно сделать</span>
            <button className="icon-button" type="button" onClick={() => setHintsDismissedFor(hintsKey)} aria-label="Скрыть подсказки"><X size={16} /></button>
          </div>
          <ul>{visibleHints.map((hint) => <li key={hint.id}>{hint.text}</li>)}</ul>
        </aside>
      )}
      <div className="messages" ref={messagesRef} onScroll={handleScroll}>
        {visibleMessages.map((message) => (
          <article key={message.id} className={`message ${message.speaker}`}>
            <div className="message-body">
              <div className="message-meta"><strong>{message.author}</strong><time>{message.timestamp}</time></div>
              <p>{message.text}</p>
              {/* Ставки: что проверялось, против какой СЛ и чем грозил провал.
                  Сервер считал их и раньше, но игрок их не видел. */}
              {message.stakes?.difficulty != null && (
                <div className="turn-stakes">
                  <Target size={13} />
                  <span>
                    <b>{stakesTitle(message.stakes)}</b>
                    {message.stakes.on_failure && <small>при провале: {message.stakes.on_failure}</small>}
                  </span>
                </div>
              )}
              {message.roll && (
                <div className={`roll-result ${message.roll.success ? 'success' : 'failure'}`}>
                  <Dices size={18} /><span><small>{message.roll.label}</small><b>d20: {message.roll.value} <i>+ {message.roll.modifier}</i></b></span><strong>{message.roll.total}</strong>
                  <em>{message.roll.success ? 'УСПЕХ' : 'ОСЛОЖНЕНИЕ'}</em>
                </div>
              )}
              {/* Вне боя очереди нет и «передавать» ход некому. */}
              {message.speaker === 'narrator' && message.turnConsumed != null && <small className={`turn-resolution ${message.turnConsumed ? 'spent' : 'kept'}`}>{message.turnConsumed ? (combatActive ? 'Ход передан следующему герою' : 'Действие засчитано') : 'Можно продолжить ход'}</small>}
              {/* Провенанс правила нажимается. Сырой rule_id в игровом интерфейсе не
                  показываем — сервер отвечает разбором по запросу. */}
              {message.roll && <button className="why-link" onClick={onWhy} disabled={isNarrating}><HelpCircle size={15} />Почему так?</button>}
              {/* Озвучка ручным нажатием. Кнопки нет вовсе, если игрок выключил
                  озвучку или в системе нет русского голоса. */}
              {message.speaker === 'narrator' && onSpeak && (
                <button className="why-link" type="button" onClick={() => onSpeak(message.text)} aria-label="Озвучить рассказ"><Volume2 size={15} />Озвучить</button>
              )}
            </div>
          </article>
        ))}
        {typingActorIds.length > 0 && <div className="typing player-typing"><span /><span /><span /> {typingActorIds.map((actorId) => players.find((player) => player.id === actorId)?.character ?? actorId).join(', ')} формулирует намерение…</div>}
        {isNarrating && <div className="typing"><span /><span /><span /> Рассказчик меняет мир…</div>}
        <div ref={endRef} />
      </div>
      {!followLatest && <button className="chronicle-to-latest" type="button" onClick={scrollToLatest} aria-label="К последним сообщениям"><ChevronDown size={16} />{unreadCount > 0 && <b>{unreadCount}</b>}</button>}
    </section>
  )
}

export function JournalView({ state }: { state: GameState }) {
  const narratorCount = state.messages.filter((message) => message.speaker === 'narrator').length
  const battleLog = state.battleLog ?? []
  const completedChapters = state.adventure?.history ?? []
  const currentChapter = state.adventure?.chapter ?? completedChapters.length + 1
  // Память мира сервер уже отфильтровал по видимости и личному знанию героя,
  // но игрок её нигде не видел: квесты, нити и резюме прошлых сцен доезжали
  // до клиента и молча пропадали.
  const quests = (state.worldMemory?.quests ?? []).filter((quest) => quest.status === 'active')
  const threads = (state.worldMemory?.threads ?? []).filter((thread) => thread.status === 'active')
  const summaries = (state.worldMemory?.summaries ?? []).slice(-4).reverse()
  return (
    <section className="section-page">
      <PageHeader eyebrow="ЛЕТОПИСЬ ПРИКЛЮЧЕНИЯ" title="Журнал кампании" description="Общая память отряда: реплики, решения, броски и последствия." />
      <div className="journal-stats">
        <div><ScrollText size={18} /><span><b>{state.messages.length + battleLog.length}</b><small>событий</small></span></div>
        <div><Sparkles size={18} /><span><b>{narratorCount}</b><small>сцен рассказчика</small></span></div>
        <div><History size={18} /><span><b>{state.scene.turn}</b><small>текущий ход</small></span></div>
      </div>
      {(quests.length > 0 || threads.length > 0 || summaries.length > 0) && <section className="quest-board" aria-label="Задачи и нити">
        {quests.length > 0 && <div className="quest-column">
          <header><ScrollText size={15} /><strong>Задачи отряда</strong><span>{quests.length}</span></header>
          {quests.map((quest) => <article className="quest-card" key={quest.id}>
            <b>{quest.title}</b>
            {quest.summary && <p>{quest.summary}</p>}
            {quest.objectives && quest.objectives.length > 0 && <ul>{quest.objectives.slice(0, 4).map((objective) => <li key={objective}>{objective}</li>)}</ul>}
            {/* Часы квеста — server-owned счётчик давления, а не украшение:
                когда он заполнится, ситуация изменится сама. */}
            {quest.clock && quest.clock.max > 0 && <div className="quest-clock" title={localizedQuestClockLabel(quest.clock.label)}>
              <span>{localizedQuestClockLabel(quest.clock.label)}</span>
              <i>{Array.from({ length: Math.min(12, quest.clock.max) }, (_, index) => <u key={index} className={index < quest.clock!.current ? 'filled' : ''} />)}</i>
              <b>{quest.clock.current}/{quest.clock.max}</b>
            </div>}
          </article>)}
        </div>}
        {(threads.length > 0 || summaries.length > 0) && <div className="quest-column">
          {threads.length > 0 && <>
            <header><History size={15} /><strong>Незакрытые нити</strong><span>{threads.length}</span></header>
            {threads.map((thread) => <article className="quest-card thread" key={thread.id}>
              <b>{thread.title}</b>{thread.summary && <p>{thread.summary}</p>}
            </article>)}
          </>}
          {summaries.length > 0 && <>
            <header><Sparkles size={15} /><strong>Что было раньше</strong><span>{summaries.length}</span></header>
            {summaries.map((summary) => <article className="quest-card summary" key={summary.id}>
              <b>{summary.title}</b><p>{summary.summary}</p>
            </article>)}
          </>}
        </div>}
      </section>}
      <div className="journal-layout">
        <aside className="chapter-list"><span>ГЛАВЫ</span>
          {completedChapters.map((chapter) => <button key={`${chapter.chapter}-${chapter.location}`}><i>{String(chapter.chapter).padStart(2, '0')}</i><b>{chapter.title}</b><small>{chapter.outcome || chapter.location}</small></button>)}
          <button className="active"><i>{String(currentChapter).padStart(2, '0')}</i><b>{state.scene.title}</b><small>{state.scene.location}</small></button>
        </aside>
        <div className="journal-feed">
          {state.messages.map((message, index) => (
            <article className={`journal-entry ${message.speaker}`} key={message.id}>
              <div className="journal-marker">{message.speaker === 'narrator' ? <Sparkles size={15} /> : index + 1}</div>
              <div><div className="message-meta"><strong>{message.author}</strong><time>{message.timestamp}</time></div><p>{message.text}</p>
              {message.roll && <span className={`compact-roll ${message.roll.success ? 'success' : ''}`}><Dices size={14} />{message.roll.label}: <b>{message.roll.total}</b></span>}</div>
            </article>
          ))}
          {battleLog.length > 0 && <section className="combat-journal" aria-label="Боевая хроника">
            <header><Swords size={15} /><strong>Боевая хроника</strong><span>{battleLog.length}</span></header>
            {battleLog.map((event) => <article className="combat-journal-entry" key={event.id}>
              <i>{event.round ?? event.sceneTurn ?? '·'}</i>
              <div><small>{event.type === 'attack' ? 'АТАКА' : event.type === 'move' ? 'ПЕРЕМЕЩЕНИЕ' : event.type === 'turn-end' ? 'ХОД' : event.type.startsWith('death-save') || event.type === 'hero-stabilized' ? 'СУДЬБА ГЕРОЯ' : event.type.startsWith('concentration-') ? 'КОНЦЕНТРАЦИЯ' : 'БОЙ'}</small><p>{battleEventText(state, event)}</p></div>
            </article>)}
          </section>}
        </div>
      </div>
    </section>
  )
}

export function AdminView({ account, state, onUpdateWorld, onAssembleEncounter, onAssembleMerchant, onMoveMerchant, onSetMerchantAvailability, onReset }: { account: Account; state: GameState; onUpdateWorld: (patch: { campaign?: string; partyName?: string; partyMemberIds?: string[]; scene?: Partial<GameState['scene']> }) => void; onAssembleEncounter: (options: EncounterAssemblyOptions) => Promise<EncounterProposal>; onAssembleMerchant: (options: ShopAssemblyOptions) => Promise<Merchant>; onMoveMerchant: (merchantId: string, location: string, locationId?: string) => Promise<void>; onSetMerchantAvailability: (merchantId: string, available: boolean) => Promise<void>; onReset: () => void }) {
  const [users, setUsers] = useState<Account[]>([])
  const [error, setError] = useState('')
  const [shopBusy, setShopBusy] = useState(false)
  const [shopError, setShopError] = useState('')
  const [shopMessage, setShopMessage] = useState('')
  const [shopSettlement, setShopSettlement] = useState<ShopAssemblyOptions['settlementType']>('town')
  const [shopTheme, setShopTheme] = useState<ShopAssemblyOptions['theme']>('general')
  const [shopBudgetGold, setShopBudgetGold] = useState(200)
  const [encounterDifficulty, setEncounterDifficulty] = useState<EncounterAssemblyOptions['difficulty']>('medium')
  const [encounterTheme, setEncounterTheme] = useState<EncounterAssemblyOptions['theme']>('generic')
  const [encounterBusy, setEncounterBusy] = useState(false)
  const [encounterError, setEncounterError] = useState('')
  const [encounterProposal, setEncounterProposal] = useState<EncounterProposal | null>(null)
  const [campaign, setCampaign] = useState(state.campaign)
  const [partyName, setPartyName] = useState(state.partyName ?? 'Отряд героев')
  const [partyMemberIds, setPartyMemberIds] = useState(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
  const [scene, setScene] = useState({ title: state.scene.title, location: state.scene.location, mood: state.scene.mood, objective: state.scene.objective })
  // Подготовка ассетов: список пробелов и запуск генерации заранее. Во время
  // игры картинки не генерируются — это решение владельца, а не ограничение UI.
  const [assets, setAssets] = useState<AssetPreparationReport | null>(null)
  const [assetSelection, setAssetSelection] = useState<string[]>([])
  const [locationSelection, setLocationSelection] = useState<string[]>([])
  const [assetBusy, setAssetBusy] = useState(false)
  const [assetError, setAssetError] = useState('')
  const [assetMessage, setAssetMessage] = useState('')

  const loadAssets = async () => {
    setAssetError('')
    const response = await fetch(`/api/campaigns/${state.sessionCode}/asset-preparation`)
    const body = await response.json() as AssetPreparationReport & { error?: string }
    if (!response.ok) throw new Error(body.error || 'Не удалось получить список ассетов')
    setAssets(body)
    setAssetSelection([])
    setLocationSelection([])
  }

  const prepareAssets = async (npcIds: string[], locationIds: string[], regenerate: boolean) => {
    if (!npcIds.length && !locationIds.length) { setAssetError('Не выбрано ни одной позиции'); return }
    setAssetBusy(true)
    setAssetError('')
    setAssetMessage('')
    try {
      const response = await fetch(`/api/campaigns/${state.sessionCode}/asset-preparation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ npc_ids: npcIds, location_ids: locationIds, regenerate }),
      })
      const body = await response.json() as { prepared?: Array<{ id: string; status: string; error?: string }>; error?: string }
      if (!response.ok) throw new Error(body.error || 'Не удалось подготовить ассеты')
      const ready = (body.prepared ?? []).filter((entry) => entry.status === 'ready').length
      const failed = (body.prepared ?? []).filter((entry) => entry.status !== 'ready')
      setAssetMessage(`Готово: ${ready}${failed.length ? `; не удалось: ${failed.map((entry) => entry.id).join(', ')}` : ''}`)
      await loadAssets()
    } catch (cause) {
      setAssetError(cause instanceof Error ? cause.message : 'Не удалось подготовить ассеты')
    } finally {
      setAssetBusy(false)
    }
  }

  const loadUsers = async () => {
    const response = await fetch('/api/admin/users')
    const body = await response.json() as { users?: Account[]; error?: string }
    if (!response.ok) throw new Error(body.error || 'Не удалось загрузить игроков')
    setUsers(body.users ?? [])
  }

  useEffect(() => { loadUsers().catch((reason) => setError(reason instanceof Error ? reason.message : 'Ошибка')) }, [])
  useEffect(() => {
    setCampaign(state.campaign)
    setPartyName(state.partyName ?? 'Отряд героев')
    setPartyMemberIds(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
    setScene({ title: state.scene.title, location: state.scene.location, mood: state.scene.mood, objective: state.scene.objective })
    setEncounterProposal(null)
    setEncounterError('')
  }, [state.sessionCode])

  const updateAccess = async (user: Account, patch: Partial<Pick<Account, 'heroIds' | 'role'>>) => {
    setError('')
    const response = await fetch(`/api/admin/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    const body = await response.json() as { user?: Account; error?: string }
    if (!response.ok || !body.user) { setError(body.error || 'Не удалось изменить доступ'); return }
    setUsers((current) => current.map((item) => item.id === body.user!.id ? body.user! : item))
  }

  const saveWorld = () => {
    if (!partyMemberIds.length) { setError('В группе должен остаться хотя бы один герой.'); return }
    setError('')
    onUpdateWorld({ campaign, partyName, partyMemberIds, scene })
  }

  const runShopAction = async (action: () => Promise<void>, success: string) => {
    setShopBusy(true)
    setShopError('')
    setShopMessage('')
    try {
      await action()
      setShopMessage(success)
    } catch (reason) {
      setShopError(reason instanceof Error ? reason.message : 'Не удалось изменить торговца')
    } finally {
      setShopBusy(false)
    }
  }

  const assembleCurrentShop = async () => {
    setShopBusy(true)
    setShopError('')
    setShopMessage('')
    try {
      const merchant = await onAssembleMerchant({
        settlementType: shopSettlement,
        theme: shopTheme,
        budgetCp: Math.max(1, Math.min(10_000, Math.floor(shopBudgetGold || 1))) * 100,
      })
      setShopMessage(`ShopAssembler создал лавку «${merchant.name}» в текущей сцене.`)
    } catch (reason) {
      setShopError(reason instanceof Error ? reason.message : 'ShopAssembler не смог создать лавку')
    } finally {
      setShopBusy(false)
    }
  }

  const assembleCurrentEncounter = async () => {
    setEncounterBusy(true)
    setEncounterError('')
    setEncounterProposal(null)
    try {
      setEncounterProposal(await onAssembleEncounter({ difficulty: encounterDifficulty, theme: encounterTheme }))
    } catch (reason) {
      setEncounterError(reason instanceof Error ? reason.message : 'EncounterAssembler не смог собрать столкновение')
    } finally {
      setEncounterBusy(false)
    }
  }

  const combatActive = Boolean(state.mechanics?.combat?.active)

  return (
    <section className="section-page admin-page">
      <PageHeader eyebrow="ПОЛНЫЙ ДОСТУП" title="Управление кампанией" description="Управляйте доступом, составом текущей группы и состоянием мира." />
      {error && <div className="admin-error">{error}</div>}
      <div className="admin-layout">
        <div className="admin-card admin-users"><div className="admin-card-head"><span><Users size={18} /><b>Игроки и герои</b></span><button onClick={() => loadUsers().catch(() => undefined)}><RefreshCw size={14} />Обновить</button></div>
          <div className="admin-user-list">{users.map((user) => <article key={user.id} className="admin-user"><div><strong>{user.name}</strong><small>{user.email}</small><em>{user.role === 'admin' ? 'АДМИНИСТРАТОР' : 'ИГРОК'}</em></div><div className="admin-hero-access">{state.players.map((hero) => <label key={hero.id}><input type="checkbox" checked={user.role === 'admin' || user.heroIds.includes(hero.id)} disabled={user.role === 'admin'} onChange={() => updateAccess(user, { heroIds: user.heroIds.includes(hero.id) ? user.heroIds.filter((id) => id !== hero.id) : [...user.heroIds, hero.id] })} /><span>{hero.character}</span></label>)}</div>{user.id !== account.id && <button className="role-button" onClick={() => updateAccess(user, { role: user.role === 'admin' ? 'player' : 'admin' })}>{user.role === 'admin' ? 'Сделать игроком' : 'Сделать администратором'}</button>}</article>)}</div>
        </div>
        <div className="admin-card admin-world"><div className="admin-card-head"><span><Sparkles size={18} /><b>Состояние мира</b></span></div>
          <div className="engine-mode-field"><span>Игровая механика</span><strong>Единый авторитетный движок</strong><small>Движение, атаки, кубики, урон, магия и обычная тактика врагов рассчитываются сервером без AI. Агент включается только при создании кампании и новой области, а также в переломных моментах боя: смерть, бегство или сдача.</small></div>
          <label><span>Кампания</span><input value={campaign} onChange={(event) => setCampaign(event.target.value)} /></label>
          <label><span>Название группы</span><input value={partyName} onChange={(event) => setPartyName(event.target.value)} /></label>
          <div className="party-editor">
            <span>СОСТАВ ГРУППЫ</span>
            <p>Герои в резерве сохраняют лист и инвентарь, но не появляются на карте и не получают ход.</p>
            {state.players.map((hero) => {
              const included = partyMemberIds.includes(hero.id)
              return <button key={hero.id} className={included ? 'included' : ''} onClick={() => setPartyMemberIds((current) => included ? current.filter((id) => id !== hero.id) : [...current, hero.id])}>
                <span><b>{hero.character}</b><small>{hero.name} · скорость {hero.speed} фт</small></span>
                <em>{included ? 'УЧАСТВУЕТ' : 'РЕЗЕРВ'}</em>
              </button>
            })}
          </div>
          <label><span>Название сцены</span><input value={scene.title} onChange={(event) => setScene({ ...scene, title: event.target.value })} /></label>
          <label><span>Локация</span><input value={scene.location} onChange={(event) => setScene({ ...scene, location: event.target.value })} /></label>
          <label><span>Настроение</span><input value={scene.mood} onChange={(event) => setScene({ ...scene, mood: event.target.value })} /></label>
          <label><span>Текущая цель</span><textarea value={scene.objective} onChange={(event) => setScene({ ...scene, objective: event.target.value })} /></label>
          <button className="admin-save" onClick={saveWorld}><Check size={15} />Сохранить мир</button>
          <button className="admin-reset" onClick={onReset}><RotateCcw size={15} />Сбросить демо-кампанию</button>
          <p>Листы и инвентари всех героев доступны администратору через разделы «Персонажи» и «Инвентарь».</p>
        </div>
        <div className="admin-card admin-encounters">
          <div className="admin-card-head"><span><Swords size={18} /><b>Столкновения и EncounterAssembler</b></span><em>{combatActive ? 'БОЙ ИДЁТ' : 'ГОТОВ К СБОРКЕ'}</em></div>
          <p>Сервер подберёт существ по бюджету опыта, разместит их на карте и запустит инициативу. Состав столкновения нельзя подменить из браузера.</p>
          {combatActive && <div className="encounter-admin-warning"><Swords size={15} />Завершите текущее столкновение, прежде чем собирать новое.</div>}
          {encounterError && <div className="admin-error">{encounterError}</div>}
          {encounterProposal && <div className="encounter-admin-success"><Check size={15} /><span><b>Столкновение собрано</b><small>{encounterProposal.enemies?.length ?? 0} противников{encounterProposal.xp_spent != null ? ` · ${encounterProposal.xp_spent}${encounterProposal.xp_budget != null ? ` / ${encounterProposal.xp_budget}` : ''} XP` : ''}</small></span></div>}
          <div className="encounter-assembler-controls">
            <label><span>Сложность для группы</span><select value={encounterDifficulty} disabled={encounterBusy || combatActive} onChange={(event) => setEncounterDifficulty(event.target.value as EncounterAssemblyOptions['difficulty'])}><option value="easy">Лёгкая</option><option value="medium">Средняя</option><option value="hard">Тяжёлая</option><option value="deadly">Смертельная · превосходящая сила</option></select></label>
            <label><span>Тема противников</span><select value={encounterTheme} disabled={encounterBusy || combatActive} onChange={(event) => setEncounterTheme(event.target.value as EncounterAssemblyOptions['theme'])}><option value="generic">Любые подходящие</option><option value="undead">Нежить</option><option value="beasts">Звери</option><option value="goblinoids">Гоблиноиды</option><option value="raiders">Налётчики</option></select></label>
            <button onClick={() => { void assembleCurrentEncounter() }} disabled={encounterBusy || combatActive}>{encounterBusy ? <RefreshCw className="spinning" size={15} /> : <Swords size={15} />}{encounterBusy ? 'Собираем столкновение…' : 'Собрать столкновение'}</button>
          </div>
          {encounterProposal?.enemies?.length ? <div className="encounter-proposal-list">{encounterProposal.enemies.map((enemy) => <span key={enemy.id}><b>{enemy.name}</b><small>Параметры рассчитываются сервером и скрыты от игроков</small></span>)}</div> : null}
        </div>
        <div className="admin-card admin-assets">
          <div className="admin-card-head">
            <span><Sparkles size={18} /><b>Подготовка ассетов</b></span>
            <em>{assets ? (assets.runtime_image_generation ? 'В ИГРЕ ВКЛЮЧЕНА' : 'В ИГРЕ ВЫКЛЮЧЕНА') : '—'}</em>
            <button onClick={() => { loadAssets().catch((cause) => setAssetError(cause instanceof Error ? cause.message : 'Ошибка')) }}><RefreshCw size={14} />Обновить</button>
          </div>
          <p className="admin-hint">Картинки готовятся заранее: во время игры генерация выключена, чтобы не тратить бюджет вечера посреди хода. Подготовка работает независимо от этого флага.</p>
          {assets && !assets.generator_configured && <p className="admin-error">Генератор изображений не настроен: подготовка недоступна.</p>}
          {assets && (
            <>
              <span className="admin-asset-group">ПОРТРЕТЫ NPC</span>
              <ul className="admin-asset-list">
                {assets.npc_portraits.map((npc) => (
                  <li key={npc.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={assetSelection.includes(npc.id)}
                        onChange={(event) => setAssetSelection((current) => (
                          event.currentTarget.checked ? [...current, npc.id] : current.filter((id) => id !== npc.id)
                        ))}
                      />
                      <span>{npc.name}{npc.role ? ` · ${npc.role}` : ''}</span>
                    </label>
                    {npc.has_portrait
                      ? <>
                        <img src={`/api/campaigns/${state.sessionCode}/npcs/${encodeURIComponent(npc.id)}/portrait`} alt="" width={40} height={40} />
                        <button disabled={assetBusy} onClick={() => { void prepareAssets([npc.id], [], true) }}>Перегенерировать</button>
                      </>
                      : <em>нет портрета</em>}
                  </li>
                ))}
                {!assets.npc_portraits.length && <li><em>Значимых NPC в кампании пока нет.</em></li>}
              </ul>
              <span className="admin-asset-group">ИЛЛЮСТРАЦИИ ЛОКАЦИЙ</span>
              <ul className="admin-asset-list">
                {assets.location_illustrations.map((location) => (
                  <li key={location.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={locationSelection.includes(location.id)}
                        onChange={(event) => setLocationSelection((current) => (
                          event.currentTarget.checked ? [...current, location.id] : current.filter((id) => id !== location.id)
                        ))}
                      />
                      <span>{location.name}{location.kind ? ` · ${location.kind}` : ''}</span>
                    </label>
                    {location.has_illustration
                      ? <>
                        <img src={`/api/campaigns/${state.sessionCode}/locations/${encodeURIComponent(location.id)}/illustration`} alt="" width={64} height={36} />
                        <button disabled={assetBusy} onClick={() => { void prepareAssets([], [location.id], true) }}>Перегенерировать</button>
                      </>
                      : <em>нет иллюстрации</em>}
                  </li>
                ))}
                {!assets.location_illustrations.length && <li><em>Известных локаций в кампании пока нет.</em></li>}
              </ul>
              <div className="admin-actions">
                <button disabled={assetBusy || !(assetSelection.length + locationSelection.length)} onClick={() => { void prepareAssets(assetSelection, locationSelection, false) }}>
                  Сгенерировать выбранные ({assetSelection.length + locationSelection.length})
                </button>
                <small>Не больше {assets.maximum_batch} за один запуск — общим счётом на портреты и локации.</small>
              </div>
              {assets.items_without_illustration.length > 0 && (
                <p className="admin-hint">Предметы без иллюстрации ({assets.items_without_illustration.length}): {assets.items_without_illustration.slice(0, 8).map((item) => item.name).join(', ')}. {assets.items_note}</p>
              )}
            </>
          )}
          {assetMessage && <p className="admin-hint">{assetMessage}</p>}
          {assetError && <p className="admin-error">{assetError}</p>}
        </div>
        <div className="admin-card admin-merchants">
          <div className="admin-card-head"><span><Store size={18} /><b>Торговцы и ShopAssembler</b></span><em>{state.merchants?.length ?? 0} в кампании</em></div>
          <p>Сборщик выбирает только позиции серверного каталога. Цены, лимиты количества и политика магазина проверяются Rules Engine.</p>
          {shopError && <div className="admin-error">{shopError}</div>}
          {shopMessage && <div className="shop-admin-success"><Check size={14} />{shopMessage}</div>}
          <div className="shop-assembler-controls">
            <label><span>Тип поселения</span><select value={shopSettlement} disabled={shopBusy} onChange={(event) => setShopSettlement(event.target.value as ShopAssemblyOptions['settlementType'])}><option value="village">Деревня</option><option value="town">Городок</option><option value="city">Большой город</option><option value="outpost">Застава</option><option value="traveling">Странствующая лавка</option></select></label>
            <label><span>Профиль лавки</span><select value={shopTheme} disabled={shopBusy} onChange={(event) => setShopTheme(event.target.value as ShopAssemblyOptions['theme'])}><option value="general">Общие товары</option><option value="provisions">Припасы</option><option value="arms">Оружие и защита</option><option value="healing">Лечение</option></select></label>
            <label><span>Бюджет склада, зм</span><input type="number" min="1" max="10000" value={shopBudgetGold} disabled={shopBusy} onChange={(event) => setShopBudgetGold(Number(event.target.value) || 1)} /></label>
            <button onClick={() => { void assembleCurrentShop() }} disabled={shopBusy}>{shopBusy ? <RefreshCw className="spinning" size={15} /> : <Sparkles size={15} />}{shopBusy ? 'Собираем лавку…' : 'Собрать лавку для текущей сцены'}</button>
          </div>
          <div className="shop-admin-list">
            {(state.merchants ?? []).map((merchant) => <article key={merchant.id}>
              <div><strong>{merchant.name}</strong><span>{merchant.title || 'Торговец'} · {merchant.stock.length} позиций</span><small>{merchant.location || 'Локация не задана'}</small></div>
              <em className={merchant.available ? 'available' : ''}>{merchant.available ? 'ОТКРЫТ' : 'ЗАКРЫТ'}</em>
              <div className="shop-admin-actions">
                <button disabled={shopBusy || locationsMatch(merchant, state.scene)} onClick={() => { void runShopAction(() => onMoveMerchant(merchant.id, state.scene.location, state.scene.location_id), `${merchant.name} перемещён в «${state.scene.location}».`) }}>Переместить сюда</button>
                <button disabled={shopBusy} onClick={() => { void runShopAction(() => onSetMerchantAvailability(merchant.id, !merchant.available), merchant.available ? `${merchant.name} закрывает торговлю.` : `${merchant.name} снова доступен.`) }}>{merchant.available ? 'Закрыть' : 'Открыть'}</button>
              </div>
            </article>)}
            {!state.merchants?.length && <div className="shop-admin-empty">В кампании ещё нет торговцев. ShopAssembler создаст первого для «{state.scene.location}».</div>}
          </div>
        </div>
      </div>
    </section>
  )
}

export function ToggleRow({ icon, title, description, value, onChange }: { icon: React.ReactNode; title: string; description: string; value: boolean; onChange: () => void }) {
  return <button className="setting-row" onClick={onChange}><span className="setting-icon">{icon}</span><span><b>{title}</b><small>{description}</small></span><i className={value ? 'on' : ''}><u /></i></button>
}

export function AtmosphereRange({ label, description, value, onChange }: { label: string; description: string; value: number; onChange: (value: number) => void }) {
  const percent = Math.round(value * 100)
  return <label className="atmosphere-range">
    <span><b>{label}</b><small>{description}</small></span>
    <output>{percent}%</output>
    <input type="range" min="0" max="100" step="1" value={percent} onInput={(event) => onChange(Number(event.currentTarget.value) / 100)} aria-label={`${label}, громкость`} />
  </label>
}

export function SettingsView({ health, campaignAi, campaignAiBusy, campaignAiError, uiScale, autoAttackRoll, scenicBackdrop, combatAnimations, atmosphereSettings, notificationPermission, voiceMode, voiceSupported, actionHintsEnabled, onCampaignAiChange, onUiScaleChange, onAutoAttackRollChange, onScenicBackdropChange, onCombatAnimationsChange, onAmbientVolumeChange, onEffectsVolumeChange, onAtmosphereMutedChange, onRequestNotifications, onVoiceModeChange, onActionHintsEnabledChange }: {
  health: AiHealth | null
  campaignAi: CampaignAiSettingsResponse | null
  campaignAiBusy: boolean
  campaignAiError: string
  uiScale: number
  autoAttackRoll: boolean
  scenicBackdrop: boolean
  combatAnimations: boolean
  atmosphereSettings: AtmosphereSettings
  notificationPermission: NotificationPermission | 'unsupported'
  voiceMode: NarrationVoiceMode
  voiceSupported: boolean
  actionHintsEnabled: boolean
  onCampaignAiChange: (patch: Partial<CampaignAiSettings>) => void
  onUiScaleChange: (value: number) => void
  onAutoAttackRollChange: (value: boolean) => void
  onScenicBackdropChange: (value: boolean) => void
  onCombatAnimationsChange: (value: boolean) => void
  onAmbientVolumeChange: (value: number) => void
  onEffectsVolumeChange: (value: number) => void
  onAtmosphereMutedChange: (value: boolean) => void
  onRequestNotifications: () => void
  onVoiceModeChange: (value: NarrationVoiceMode) => void
  onActionHintsEnabledChange: (value: boolean) => void
}) {
  const [scaleInput, setScaleInput] = useState(String(uiScale))

  useEffect(() => setScaleInput(String(uiScale)), [uiScale])

  const commitScaleInput = () => {
    const parsed = Number(scaleInput.replace('%', '').trim())
    if (Number.isFinite(parsed)) onUiScaleChange(clampUiScale(parsed))
    else setScaleInput(String(uiScale))
  }

  const hasPreset = UI_SCALE_PRESETS.includes(uiScale)


  return (
    <section className="section-page settings-page">
      <PageHeader eyebrow="ПАРАМЕТРЫ КАМПАНИИ" title="Настройки" description="Рассказчик, отображение сцены и локальные предпочтения." />
      <div className="settings-grid">
        <div className="settings-card ai-card">
          <div className="settings-card-title"><BrainCircuit size={20} /><span><b>ИИ-рассказчик</b><small>Серверное подключение</small></span><em className={health?.configured ? 'connected' : ''}>{health?.configured ? <Wifi size={14} /> : <WifiOff size={14} />}{health?.configured ? 'ПОДКЛЮЧЁН' : 'НЕДОСТУПЕН'}</em></div>
          <label className="ui-scale-setting">
            <span><b>Модель для группы</b><small>Сервер разрешает только модели из настроенного основного и резервного списка</small></span>
            <select
              value={campaignAi?.settings.model ?? health?.model ?? ''}
              disabled={!campaignAi?.canManage || campaignAiBusy}
              onChange={(event) => onCampaignAiChange({ model: event.currentTarget.value })}
              aria-label="Модель ИИ для группы"
            >
              {(campaignAi?.availableModels ?? [health?.model].filter((value): value is string => Boolean(value))).map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
            </select>
          </label>
          <label className="ui-scale-setting">
            <span><b>Стиль рассказчика</b><small>Интонация применяется ко всем новым художественным ответам этой кампании</small></span>
            <select
              value={campaignAi?.settings.narratorStyle ?? 'neutral'}
              disabled={!campaignAi?.canManage || campaignAiBusy}
              onChange={(event) => onCampaignAiChange({ narratorStyle: event.currentTarget.value as CampaignAiSettings['narratorStyle'] })}
              aria-label="Стиль рассказчика"
            >
              {(campaignAi?.narratorStyles ?? [{ id: 'neutral' as const, label: 'Нейтральный' }]).map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
            </select>
          </label>
          <label className="ui-scale-setting">
            <span><b>Режим импровизации</b><small>Насколько сильно Режиссёр перестраивает историю под незапланированные действия отряда</small></span>
            <select
              value={campaignAi?.settings.improvMode ?? 'story'}
              disabled={!campaignAi?.canManage || campaignAiBusy}
              onChange={(event) => onCampaignAiChange({ improvMode: event.currentTarget.value as CampaignAiSettings['improvMode'] })}
              aria-label="Режим импровизации кампании"
            >
              {(campaignAi?.improvModes ?? IMPROV_MODE_FALLBACK).map((improv) => <option key={improv.id} value={improv.id}>{improv.label} — {improv.description}</option>)}
            </select>
            {campaignAi && (
              <small className="architect-usage-note">
                Локаций сегодня: {campaignAi.architectGenerationsToday}
                {campaignAi.architectGenerationsToday >= campaignAi.architectAlertThreshold
                  ? ' — расход токенов выше обычного. Ограничения нет.'
                  : ''}
              </small>
            )}
          </label>
          {!campaignAi?.canManage && campaignAi && <p className="secure-note"><Lock size={14} />Изменять общие настройки ИИ может владелец кампании или администратор.</p>}
          {campaignAiError && <p className="admin-error">{campaignAiError}</p>}
          <div className="provider-info"><span>ПРОВАЙДЕР<strong>{health?.provider ?? 'RouterAI'}</strong></span><span>МОДЕЛЬ<strong>{health?.model ?? 'Проверка подключения…'}</strong></span><span>МЕХАНИКА<strong>Единый серверный движок</strong></span><span>RULESET<strong>{health?.rulesetId ?? 'не выбран'}</strong></span></div>
          <div className="tools-list"><small>ДОСТУПНЫЕ ИНСТРУМЕНТЫ</small><div>{(health?.tools ?? ['roll_check', 'reveal_area', 'update_objective', 'spawn_entity', 'grant_item']).map((tool) => <span key={tool}><Check size={11} />{tool}</span>)}</div></div>
          <p className="secure-note"><Shield size={14} />Ключ RouterAI хранится только в серверном `.env` и не передаётся в браузер.</p>
        </div>
        <div className="settings-card"><div className="settings-card-title"><SlidersHorizontal size={20} /><span><b>Интерфейс игры</b><small>Настройки этого устройства</small></span></div>
          <label className="ui-scale-setting">
            <span><b>Масштаб интерфейса</b><small>Текст, иконки и основные панели адаптируются вместе</small></span>
            <div className="ui-scale-value">
              <input value={scaleInput} inputMode="numeric" aria-label="Масштаб интерфейса в процентах" onChange={(event) => setScaleInput(event.currentTarget.value)} onBlur={commitScaleInput} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
              <span>%</span>
            </div>
            <input className="ui-scale-range" type="range" min={UI_SCALE_MIN} max={UI_SCALE_MAX} step="5" value={uiScale} onInput={(event) => onUiScaleChange(Number(event.currentTarget.value))} aria-label="Размер текста и иконок" />
            <select value={uiScale} onChange={(event) => onUiScaleChange(Number(event.currentTarget.value))} aria-label="Готовый масштаб интерфейса">
              {!hasPreset && <option value={uiScale}>{uiScale}%</option>}
              {UI_SCALE_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}%{preset === 100 ? ' · компактный' : preset === 115 ? ' · стандартный' : preset === 125 ? ' · крупный' : preset === 150 ? ' · максимальный' : ''}</option>)}
            </select>
            <span className="ui-scale-marks"><i>{UI_SCALE_MIN}%</i><i>100%</i><i>125%</i><i>{UI_SCALE_MAX}%</i></span>
          </label>
          <ToggleRow icon={<Sparkles size={17} />} title="Подсказки «что можно сделать»" description="Короткий список доступного в текущей сцене над лентой истории; в бою подсказок нет" value={actionHintsEnabled} onChange={() => onActionHintsEnabledChange(!actionHintsEnabled)} />
          <ToggleRow icon={<Globe2 size={17} />} title="Атмосферный фон локации" description="Включено — иллюстрация и окружение соответствуют месту; выключено — спокойный однотонный фон" value={scenicBackdrop} onChange={() => onScenicBackdropChange(!scenicBackdrop)} />
          {/* Озвучка спрашивается только там, где её есть чем исполнить: без
              русского голоса в системе выбор был бы обещанием без механики. */}
          {voiceSupported && (
            <label className="ui-scale-setting">
              <span><b>Озвучка рассказчика</b><small>Голос браузера читает нарратив на этом устройстве; выбор не влияет на других игроков</small></span>
              <select value={voiceMode} onChange={(event) => onVoiceModeChange(event.currentTarget.value as NarrationVoiceMode)} aria-label="Озвучка рассказчика">
                <option value="off">Выключена</option>
                <option value="button">Кнопкой у сообщения</option>
                <option value="auto">Автоматически</option>
              </select>
            </label>
          )}
          <div className="atmosphere-settings" role="group" aria-label="Звук и музыка">
            <div className="atmosphere-settings-title"><Volume2 size={17} /><span><b>Звук и музыка</b><small>Процедурный фон и сигналы подтверждённых событий</small></span></div>
            <AtmosphereRange label="Фоновая атмосфера" description="Музыка, ветер и гул текущего места" value={atmosphereSettings.ambientVolume} onChange={onAmbientVolumeChange} />
            <AtmosphereRange label="Эффекты событий" description="Кости, удары, двери и важные исходы" value={atmosphereSettings.effectsVolume} onChange={onEffectsVolumeChange} />
            <ToggleRow icon={atmosphereSettings.muted ? <VolumeX size={17} /> : <Volume2 size={17} />} title="Выключить весь звук" description="Настройки громкости сохранятся на этом устройстве" value={atmosphereSettings.muted} onChange={() => onAtmosphereMutedChange(!atmosphereSettings.muted)} />
            <button
              className={`notification-permission ${notificationPermission}`}
              disabled={notificationPermission === 'unsupported' || notificationPermission === 'denied'}
              onClick={onRequestNotifications}
            >
              {notificationPermission === 'granted' ? <Bell size={17} /> : <BellOff size={17} />}
              <span>
                <b>Системный сигнал своего хода</b>
                <small>{notificationPermission === 'granted'
                  ? 'Разрешён; при свёрнутой вкладке появится уведомление'
                  : notificationPermission === 'denied'
                    ? 'Запрещён в браузере; заголовок и звук продолжат работать'
                    : notificationPermission === 'unsupported'
                      ? 'Браузер не поддерживает Notification API; заголовок и звук продолжат работать'
                      : 'Нажмите, чтобы запросить разрешение браузера'}</small>
              </span>
            </button>
          </div>
          <ToggleRow icon={<Dices size={17} />} title="Автобросок кубика" description="Выключено — игра предлагает бросок: проверки ждут вашего d20, атака по клику требует подтверждения. Включено — сервер бросает сразу" value={autoAttackRoll} onChange={() => onAutoAttackRollChange(!autoAttackRoll)} />
          <ToggleRow icon={<Swords size={17} />} title="Боевые анимации" description="Движение, удары и состояния проигрываются поверх доски; клик пропускает текущую очередь" value={combatAnimations} onChange={() => onCombatAnimationsChange(!combatAnimations)} />
        </div>
      </div>
    </section>
  )
}


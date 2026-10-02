import { useState } from 'react'
import { Coins, Crown, HeartCrack, Link2, LockKeyhole, Moon, Target, UserPlus } from 'lucide-react'
import type { GameState, Player } from './types'
import type { CommandOutcome } from './useGameSession'
import { ABILITY_SHORT_LABELS, HeroFaceInitials, hasHeroPortrait, heroFaceMode, heroFaceStyle } from './app-shared'
import { heroResourceLabel, heroResourceRank, heroResourceTitle, heroResourcesFor, heroStatusSummary, type HeroStatus } from './dungeon-map-parts'
import { localizedQuestClockLabel } from './desktop-ui.mjs'
import { playerRoleLabel } from './player-experience'

/**
 * Раздел «Отряд» по макету «Сказание — редизайн интерфейса»: карточка на
 * каждого героя, приглашение и три сводки внизу — кошельки, отдых, задачи.
 *
 * Здесь нет ни одного своего правила. Числа приходят из проекции комнаты
 * (`server/viewer-projection.mjs`): ОЗ, КД, скорость и характеристики — из
 * записи героя, запасы — `mechanics.resources`, кости хитов —
 * `mechanics.hit_point_dice` (сервер отдаёт их только своему герою, поэтому у
 * соратника строки нет вовсе), отдых — `mechanics.resting`, задачи —
 * `worldMemory.quests`. Кнопки зовут те же серверные команды, что и комната:
 * приглашение — `POST /api/campaigns/:id/invites` через общее окно, отдых —
 * `StartRest`. Чего проекция не отдаёт, того на странице и нет: модификатора
 * инициативы, «был в сети N часов назад», общего кошелька отряда.
 */

const ABILITY_ORDER = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const

/** Модификатор характеристики — та же формула, что в листе героя (`InventoryViews`). */
function abilityModifier(score: number) {
  const value = Math.floor((score - 10) / 2)
  return value >= 0 ? `+${value}` : `−${Math.abs(value)}`
}

const CURRENCY_LABELS: Array<[keyof Player['currency'], string]> = [
  ['platinum', 'пм'], ['gold', 'зм'], ['silver', 'см'], ['copper', 'мм'],
]

function purseText(player: Player) {
  const parts = CURRENCY_LABELS
    .map(([key, label]) => [Math.max(0, Math.floor(Number(player.currency?.[key] ?? 0) || 0)), label] as const)
    .filter(([amount]) => amount > 0)
    .map(([amount, label]) => `${amount} ${label}`)
  return parts.length ? parts.join(' · ') : 'пусто'
}

function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/**
 * Запасы героя одной строкой на запас. Двойники под разными ключами (рукописный
 * и каталожный) схлопываются так же, как в ресурсном кластере панели хода
 * (`DungeonMap.tsx`, `heroResourceRows`): только при совпадении подписи и счёта.
 */
function resourceRows(state: GameState, player: Player) {
  return Object.entries(heroResourcesFor(state, player.id, player))
    .map(([key, pool]) => ({ key, current: Math.max(0, Number(pool?.current ?? 0)), max: Math.max(0, Number(pool?.max ?? 0)) }))
    .filter((entry) => entry.max > 0)
    .sort((left, right) => heroResourceRank(left.key) - heroResourceRank(right.key) || left.key.localeCompare(right.key, 'ru'))
    .reduce<Array<{ keys: string[]; current: number; max: number }>>((rows, entry) => {
      const twin = rows.find((row) => row.current === entry.current && row.max === entry.max
        && heroResourceLabel(row.keys[0]) === heroResourceLabel(entry.key))
      if (twin) twin.keys.push(entry.key)
      else rows.push({ keys: [entry.key], current: entry.current, max: entry.max })
      return rows
    }, [])
}

function Pips({ current, max, kind }: { current: number; max: number; kind: string }) {
  if (max > 6) return null
  return <span className="party-pips" aria-hidden="true">
    {Array.from({ length: max }, (_, index) => <i key={index} className={`${kind} ${index < current ? '' : 'spent'}`} />)}
  </span>
}

type HeroCardProps = {
  state: GameState
  player: Player
  selected: boolean
  turn: boolean
  accessible: boolean
  owned: boolean
  status?: HeroStatus
  onSelect: () => void
  onEdit: () => void
  onOpenInventory: () => void
}

function HeroCard({ state, player, selected, turn, accessible, owned, status, onSelect, onEdit, onOpenInventory }: HeroCardProps) {
  const hpPercent = Math.max(0, Math.min(100, Math.max(0, player.hp) / Math.max(1, player.maxHp) * 100))
  const tempPercent = status && status.temporaryHp > 0 ? Math.min(100 - hpPercent, status.temporaryHp / Math.max(1, player.maxHp) * 100) : 0
  const deathSaves = state.mechanics?.death?.saving_throws?.[player.id]
  const dead = status?.conditions.some((condition) => condition.id === 'dead') ?? false
  const hitDice = state.mechanics?.hit_point_dice?.[player.id]
  const resources = resourceRows(state, player)
  const passivePerception = player.characterSheet?.passive_perception
  const statusLine = status ? heroStatusSummary(status) : ''
  return <article
    className={`party-hero-card ${selected ? 'selected' : ''} ${accessible ? '' : 'locked'} ${player.hp <= 0 ? 'downed' : ''}`}
    aria-label={`${player.character}, ${playerRoleLabel(player)}`}
  >
    <header className="party-hero-head">
      <span className="party-hero-face" data-face={heroFaceMode(player)} style={heroFaceStyle(player)}>{!hasHeroPortrait(player) && <HeroFaceInitials hero={player} />}</span>
      <div>
        <h2>{player.character}{turn && <Crown size={16} aria-label="Сейчас ходит" />}</h2>
        <p>{[player.species, playerRoleLabel(player)].filter(Boolean).join(' · ')}</p>
        <span className={`party-presence ${player.online ? 'online' : ''}`}><i aria-hidden="true" />{player.name}{owned ? ' · вы' : ''} · {player.online ? 'в сети' : 'не в сети'}</span>
      </div>
    </header>

    <div className="party-hp">
      <div><span>Здоровье</span><b>{player.hp} / {player.maxHp}{status && status.temporaryHp > 0 && <em> +{status.temporaryHp}</em>}</b></div>
      <div className="party-hp-track" role="meter" aria-label="Здоровье" aria-valuemin={0} aria-valuemax={player.maxHp} aria-valuenow={Math.max(0, player.hp)}>
        <i style={{ width: `${hpPercent}%` }} />
        {tempPercent > 0 && <i className="temp" style={{ left: `${hpPercent}%`, width: `${tempPercent}%` }} />}
      </div>
      {player.hp <= 0 && <p className="party-downed"><HeartCrack size={14} />{dead ? 'Погиб' : deathSaves?.stable ? 'Стабилизирован' : 'Без сознания'}
        {deathSaves && !deathSaves.stable && !dead && <em>{deathSaves.successes}✓ · {deathSaves.failures}✕</em>}</p>}
    </div>

    <dl className="party-stats">
      <div><dt>КД</dt><dd>{player.armor}</dd></div>
      <div><dt>Скорость</dt><dd>{player.speed} фт</dd></div>
      <div><dt>Мастерство</dt><dd>+{player.proficiency}</dd></div>
      {typeof passivePerception === 'number' && <div title="Пассивная внимательность"><dt>Внимат.</dt><dd>{passivePerception}</dd></div>}
    </dl>

    <dl className="party-abilities" aria-label="Характеристики">
      {ABILITY_ORDER.map((key) => {
        const score = Number(player.abilities?.[key] ?? 10)
        return <div key={key}><dt>{ABILITY_SHORT_LABELS[key]}</dt><dd>{abilityModifier(score)}</dd><small>{score}</small></div>
      })}
    </dl>

    <ul className="party-resources" aria-label="Запасы">
      {resources.map((row) => <li key={row.keys.join('|')} title={heroResourceTitle(row.keys, row.current, row.max)}>
        <span>{heroResourceLabel(row.keys[0])}</span>
        <Pips current={row.current} max={row.max} kind={/^spell_slots_/u.test(row.keys[0]) || row.keys[0] === 'pact_slots' ? 'slot' : 'feature'} />
        <b>{row.current}/{row.max}</b>
      </li>)}
      {hitDice && hitDice.maximum > 0 && <li title="Кости хитов тратятся на коротком отдыхе">
        <span>Кости хитов (d{hitDice.die_size})</span>
        <Pips current={Math.max(0, hitDice.maximum - hitDice.spent)} max={hitDice.maximum} kind="die" />
        <b>{Math.max(0, hitDice.maximum - hitDice.spent)}/{hitDice.maximum}</b>
      </li>}
      <li><span>Состояния</span>{statusLine ? <b className="party-conditions" title={statusLine}>{statusLine}</b> : <em>нет</em>}</li>
    </ul>

    <footer className="party-hero-actions">
      {accessible
        ? <>
            <button type="button" className={selected ? 'primary' : ''} onClick={() => { onSelect(); onEdit() }}>{player.characterSetupRequired ? 'Создать героя' : 'Лист героя'}</button>
            <button type="button" onClick={() => { onSelect(); onOpenInventory() }}>Вещи</button>
            {!selected && <button type="button" className="quiet" onClick={onSelect} title="Действовать от имени этого героя">Выбрать</button>}
          </>
        : <span className="party-locked"><LockKeyhole size={14} />Героя ведёт другой игрок</span>}
    </footer>
  </article>
}

export type PartyPageProps = {
  state: GameState
  players: Player[]
  selectedId: string
  turnId: string
  combatActive: boolean
  accessibleHeroIds: string[]
  ownedHeroIds: string[]
  statusByHero: Record<string, HeroStatus>
  /** Владелец кампании или администратор при активной кампании — как кнопка в шапке комнаты. */
  canInvite: boolean
  /** Те же условия, что у кнопок отдыха в комнате (`canAct` стола). */
  canAct: boolean
  onInvite: () => void
  onSelect: (id: string) => void
  onEdit: (id: string) => void
  onOpenInventory: () => void
  onOpenJournal: () => void
  onOpenRoom: () => void
  onStartRest: (kind: 'short' | 'long') => Promise<CommandOutcome>
}

export function PartyPage({ state, players, selectedId, turnId, combatActive, accessibleHeroIds, ownedHeroIds, statusByHero, canInvite, canAct, onInvite, onSelect, onEdit, onOpenInventory, onOpenJournal, onOpenRoom, onStartRest }: PartyPageProps) {
  const [restError, setRestError] = useState('')
  const [restBusy, setRestBusy] = useState(false)
  const selected = players.find((player) => player.id === selectedId) ?? players[0]
  const online = players.filter((player) => player.online).length
  const activeRest = selected ? state.mechanics?.resting?.[selected.id] : undefined
  const quests = (state.worldMemory?.quests ?? []).filter((quest) => quest.status === 'active')
  const offers = (state.worldMemory?.quests ?? []).filter((quest) => quest.status === 'offered')
  const leadQuest = quests[0]
  const restBlocked = !canAct || combatActive || state.isNarrating || Boolean(state.pendingCheck) || restBusy
    || !selected || !accessibleHeroIds.includes(selected.id)
  const startRest = async (kind: 'short' | 'long') => {
    setRestBusy(true)
    setRestError('')
    try {
      const outcome = await onStartRest(kind)
      if (!outcome.ok) setRestError(outcome.error)
    } finally {
      setRestBusy(false)
    }
  }

  return <section className="section-page party-page" aria-labelledby="party-page-title">
    <header className="party-page-header">
      <div>
        <span className="party-eyebrow">Ваш отряд{state.partyName ? ` · ${state.partyName}` : ''}</span>
        <h1 id="party-page-title">Отряд</h1>
        <p>{players.length} {plural(players.length, 'герой', 'героя', 'героев')} · {online} в сети · сцена «{state.scene.title || state.scene.location}»</p>
      </div>
      {canInvite && <button type="button" className="party-button" onClick={onInvite}><Link2 size={17} />Ссылка-приглашение</button>}
    </header>

    <div className="party-grid">
      {players.map((player) => <HeroCard
        key={player.id}
        state={state}
        player={player}
        selected={player.id === selected?.id}
        turn={combatActive && turnId === player.id}
        accessible={accessibleHeroIds.includes(player.id)}
        owned={ownedHeroIds.includes(player.id)}
        status={statusByHero[player.id]}
        onSelect={() => { if (accessibleHeroIds.includes(player.id)) onSelect(player.id) }}
        onEdit={() => onEdit(player.id)}
        onOpenInventory={onOpenInventory}
      />)}
      {/* Свободных мест клиент не знает: кто из героев ещё ни за кем не
          закреплён, решает сервер в момент выпуска ссылки. Поэтому карточка
          зовёт пригласить, а не обещает пустое кресло. */}
      {canInvite && <article className="party-invite-card">
        <span className="party-invite-face" aria-hidden="true"><UserPlus size={28} strokeWidth={1.5} /></span>
        <div>
          <h2>Позвать игрока</h2>
          <p>Одноразовая ссылка закрепит за новым игроком свободного героя отряда и действует семь дней. Если свободных героев нет, сервер так и ответит.</p>
        </div>
        <button type="button" className="party-button primary" onClick={onInvite}>Создать ссылку</button>
      </article>}
    </div>

    <div className="party-summary">
      <section className="party-summary-card" aria-label="Кошельки героев">
        <Coins size={24} aria-hidden="true" />
        <div>
          <strong>Кошельки</strong>
          <ul>{players.map((player) => <li key={player.id}><span>{player.character}</span><b>{purseText(player)}</b></li>)}</ul>
        </div>
      </section>
      <section className="party-summary-card" aria-label="Отдых">
        <Moon size={24} aria-hidden="true" />
        <div>
          <strong>{activeRest
            ? activeRest.reason === 'knockout' ? `${selected?.character ?? 'Герой'} приходит в себя` : `${selected?.character ?? 'Герой'}: ${activeRest.kind === 'short' ? 'короткий' : 'долгий'} отдых`
            : combatActive ? 'Во время боя не отдыхают' : `Отдых · ${selected?.character ?? 'герой'}`}</strong>
          {activeRest
            ? <p>Длительность и завершение считает сервер.{activeRest.kind === 'short' && activeRest.reason !== 'knockout' ? ' Кости хитов тратятся в комнате.' : ''} <button type="button" className="party-link" onClick={onOpenRoom}>В комнату</button></p>
            : <div className="party-rest-actions">
                <button type="button" disabled={restBlocked} onClick={() => { void startRest('short') }}>Короткий · 1 час</button>
                <button type="button" disabled={restBlocked} onClick={() => { void startRest('long') }}>Долгий · 8 часов</button>
              </div>}
          {restError && <p className="error-text" role="alert">{restError}</p>}
        </div>
      </section>
      <section className="party-summary-card" aria-label="Задачи">
        <Target size={24} aria-hidden="true" />
        <div>
          <strong>{quests.length ? `${quests.length} ${plural(quests.length, 'задача', 'задачи', 'задач')}` : 'Задач нет'}{offers.length ? ` · ${offers.length} ${plural(offers.length, 'предложение', 'предложения', 'предложений')}` : ''}</strong>
          {leadQuest
            ? <p>{leadQuest.title}{leadQuest.clock && leadQuest.clock.max > 0 ? ` · ${localizedQuestClockLabel(leadQuest.clock.label).toLocaleLowerCase('ru')}: ${leadQuest.clock.current} из ${leadQuest.clock.max}` : ''}</p>
            : <p>Отряд ещё не взял ни одной задачи.</p>}
          <button type="button" className="party-link" onClick={onOpenJournal}>Открыть журнал</button>
        </div>
      </section>
    </div>
  </section>
}

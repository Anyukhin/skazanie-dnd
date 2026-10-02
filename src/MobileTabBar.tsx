import { useEffect, useState } from 'react'
import { Backpack, Globe2, Map as MapIcon, ScrollText, Users } from 'lucide-react'

/**
 * Нижняя панель вкладок телефона — по макетам «Телефон · сцена» и «Телефон ·
 * хроника». На широком экране её нет совсем (`mockup-pages.css`, ≤ 760px):
 * там те же разделы держит левая рельса.
 *
 * Своих разделов у панели нет: «Сцена» и «Хроника» — две половины той же
 * игровой комнаты (карта с панелью хода и лента с вводом), остальные вкладки —
 * те же `View`, что открывает рельса. Журнал, настройки и инструменты мастера
 * остаются в меню (кнопка с тремя полосками открывает рельсу шторкой).
 */

export type MobilePane = 'scene' | 'chronicle'
type MobileView = 'room' | 'world-map' | 'characters' | 'inventory'

export function MobileTabBar({ view, pane, messageCount, onScene, onChronicle, onNavigate }: {
  view: string
  pane: MobilePane
  /** Длина ленты комнаты: счётчик на «Хронике» — сколько строк пришло, пока игрок смотрел карту. */
  messageCount: number
  onScene: () => void
  onChronicle: () => void
  onNavigate: (view: Exclude<MobileView, 'room'>) => void
}) {
  const chronicleOpen = view === 'room' && pane === 'chronicle'
  const [seen, setSeen] = useState(messageCount)
  useEffect(() => {
    // Открытая хроника читается целиком: всё пришедшее считается прочитанным.
    // Лента после смены кампании короче прежней — счёт начинается заново.
    if ((chronicleOpen || messageCount < seen) && seen !== messageCount) setSeen(messageCount)
  }, [chronicleOpen, messageCount, seen])
  const unread = chronicleOpen ? 0 : Math.max(0, messageCount - seen)
  const tab = (active: boolean, label: string, icon: React.ReactNode, onClick: () => void, badge = 0) => <button
    type="button"
    className={`mobile-tab ${active ? 'active' : ''}`}
    aria-current={active ? 'page' : undefined}
    onClick={onClick}
  >{icon}<span>{label}</span>{badge > 0 && <b aria-label={`Новых строк: ${badge}`}>{badge > 99 ? '99+' : badge}</b>}</button>
  return <nav className="mobile-tabbar" aria-label="Разделы">
    {tab(view === 'room' && pane === 'scene', 'Сцена', <MapIcon size={22} strokeWidth={1.7} />, onScene)}
    {tab(chronicleOpen, 'Хроника', <ScrollText size={22} strokeWidth={1.7} />, onChronicle, unread)}
    {tab(view === 'inventory', 'Герой', <Backpack size={22} strokeWidth={1.7} />, () => onNavigate('inventory'))}
    {tab(view === 'characters', 'Отряд', <Users size={22} strokeWidth={1.7} />, () => onNavigate('characters'))}
    {tab(view === 'world-map', 'Мир', <Globe2 size={22} strokeWidth={1.7} />, () => onNavigate('world-map'))}
  </nav>
}

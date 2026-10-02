/* Палитры интерфейса по макету «Игровой стол»: палитра задаёт только основные
   цвета (`hud-palette.css`), остальные оттенки выводятся из них через
   color-mix и относительные цвета. Выбор — настройка этого браузера, а не
   кампании: он хранится в localStorage и ставится атрибутом `data-pal` на
   корень документа до первой отрисовки. */

export type PaletteId = 'tavern' | 'espresso' | 'moss' | 'graphite' | 'ink' | 'wine' | 'ash' | 'parchment'

export type PaletteDescriptor = {
  id: PaletteId
  name: string
  description: string
  /** Образец для карточки выбора: фон, поднятая поверхность, акцент, текст, здоровье. */
  preview: [string, string, string, string, string]
}

export const PALETTES: PaletteDescriptor[] = [
  { id: 'tavern', name: 'Таверна', description: 'Дерево и тёплое золото', preview: ['#0e0c0a', '#1f1a15', '#c9974f', '#ece3d5', '#b8483d'] },
  { id: 'espresso', name: 'Эспрессо и латунь', description: 'Глубже и спокойнее', preview: ['#120e0b', '#251d17', '#a8854c', '#e9dfcf', '#a24c3e'] },
  { id: 'moss', name: 'Мох и бронза', description: 'Лесная тьма, приглушённая зелень', preview: ['#0e110d', '#1b2019', '#b08a52', '#e4e2d4', '#a5493b'] },
  { id: 'graphite', name: 'Графит и медь', description: 'Нейтральный тёмный, медный акцент', preview: ['#121212', '#1f1e1d', '#b8714a', '#e8e4df', '#b04a3e'] },
  { id: 'ink', name: 'Чернила и золото', description: 'Ночная синь и старое золото', preview: ['#0d1017', '#181d28', '#b8954f', '#e6e1d6', '#a84a44'] },
  { id: 'wine', name: 'Старое вино', description: 'Бордо и античное золото', preview: ['#140c0d', '#251618', '#b08d58', '#eadcd2', '#b24a42'] },
  { id: 'ash', name: 'Пепел и серебро', description: 'Холодный металл без цвета', preview: ['#111214', '#1d1f22', '#9da4ad', '#e6e7e9', '#a34a46'] },
  { id: 'parchment', name: 'Тёплый пергамент', description: 'Светлая, сепия без красного', preview: ['#e9e1d0', '#f7f2e7', '#7a5a2e', '#2b241b', '#a5473a'] },
]

export const DEFAULT_PALETTE: PaletteId = 'tavern'
export const PALETTE_STORAGE_KEY = 'skazanie.ui.palette'

const isPaletteId = (value: unknown): value is PaletteId => PALETTES.some((palette) => palette.id === value)

/** Сохранённая палитра; при запрете хранилища или чужом значении — палитра по умолчанию. */
export function loadPalette(): PaletteId {
  try {
    const saved = window.localStorage.getItem(PALETTE_STORAGE_KEY)
    return isPaletteId(saved) ? saved : DEFAULT_PALETTE
  } catch {
    return DEFAULT_PALETTE
  }
}

/** Ставит палитру на корень документа и запоминает выбор, если хранилище доступно. */
export function applyPalette(id: PaletteId, { persist = true }: { persist?: boolean } = {}): PaletteId {
  const next = isPaletteId(id) ? id : DEFAULT_PALETTE
  document.documentElement.dataset.pal = next
  if (persist) {
    try {
      if (next === DEFAULT_PALETTE) window.localStorage.removeItem(PALETTE_STORAGE_KEY)
      else window.localStorage.setItem(PALETTE_STORAGE_KEY, next)
    } catch {
      /* хранилище запрещено: палитра действует до перезагрузки */
    }
  }
  return next
}

// Палитра ставится при загрузке модуля, до первой отрисовки React: иначе
// сохранённая светлая палитра мигала бы тёмной.
if (typeof document !== 'undefined') applyPalette(loadPalette(), { persist: false })

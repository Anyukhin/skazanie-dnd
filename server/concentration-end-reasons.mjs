// @ts-check

/**
 * Почему кончилась концентрация — по-русски, для хроники и боевого журнала.
 *
 * `ConcentrationEnded.payload.reason` — машинный ключ. До 2026-10-04 подпись
 * была только у одного из тридцати ключей, и игрок читал «Концентрация Миры
 * прекращена · failed-saving-throw». Модуль — лист: его импортируют и
 * рассказчик (`server/combat-narration.mjs`), и браузер (`src/app-shared.tsx`),
 * поэтому один словарь на обе стороны.
 *
 * Незнакомый ключ подписью не становится: лучше нейтральное «эффект
 * завершён», чем сырой идентификатор посреди русского текста.
 */
export const CONCENTRATION_END_REASON_LABELS = Object.freeze({
  'replaced': 'начато другое заклинание',
  'voluntary': 'по своей воле',
  'failed-saving-throw': 'спасбросок концентрации провален',
  'incapacitated': 'заклинатель выведен из строя',
  'duration-expired': 'время действия истекло',
  'duration_expired': 'время действия истекло',
  'effect-finished': 'эффект исчерпан',
  'long-rest': 'долгий отдых',
  'long-cast-started': 'начато долгое заклинание',
  'dispelled': 'заклинание рассеяно',
  'readied-released': 'заготовленное заклинание выпущено',
  'readied-expired': 'заготовка не дождалась повода',
  'resistance-used': 'бонус спасброска использован',
  'repeat-save': 'цель прошла повторный спасбросок',
  'turn-start-save': 'цель прошла спасбросок в начале хода',
  'damage-save': 'цель прошла спасбросок после урона',
  'save-success': 'цель прошла спасбросок',
  'action-save': 'цель вырвалась, потратив действие',
  'action-other': 'эффект снят действием',
  'break-free': 'цель вырвалась',
  'steady-nerves': 'цель совладала со страхом',
  'extinguished': 'пламя потушено',
  'sleet-storm': 'буря сбила сосредоточенность',
  'form-destroyed': 'принятый облик разрушен',
  'target-defeated': 'цель повержена',
  'next-weapon-hit-saved': 'цель увернулась от эффекта удара',
  'next-weapon-hit-resolved': 'эффект удара исполнен',
  'duel-violated': 'дуэль нарушена',
  'duelist-too-far': 'дуэлянт слишком далеко',
  'ally-damaged-duel-target': 'союзник ранил соперника по дуэли',
})

/**
 * @param {unknown} reason
 * @returns {string}
 */
export function concentrationEndReasonLabel(reason) {
  const key = String(reason ?? '')
  return Object.hasOwn(CONCENTRATION_END_REASON_LABELS, key)
    ? CONCENTRATION_END_REASON_LABELS[/** @type {keyof typeof CONCENTRATION_END_REASON_LABELS} */ (key)]
    : 'эффект завершён'
}

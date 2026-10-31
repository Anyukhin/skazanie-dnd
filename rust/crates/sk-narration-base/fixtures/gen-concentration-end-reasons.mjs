// Эталон для `concentration_end_reasons.rs`: словарь целиком и подписи по ключам.
//
//   node rust/crates/sk-narration-base/fixtures/gen-concentration-end-reasons.mjs
import { writeFileSync } from 'node:fs'

import { CONCENTRATION_END_REASON_LABELS, concentrationEndReasonLabel } from '../../../../server/concentration-end-reasons.mjs'

const reasons = [...Object.keys(CONCENTRATION_END_REASON_LABELS), 'some-future-reason', '', null, 'constructor', 'toString', '__proto__', 'REPLACED', ' replaced', 7, true, ['replaced'], { reason: 'replaced' }]
const labels = reasons.map((reason) => ({ reason, label: concentrationEndReasonLabel(reason) }))
writeFileSync(new URL('./concentration-end-reasons.json', import.meta.url), `${JSON.stringify({ table: Object.entries(CONCENTRATION_END_REASON_LABELS), labels }, null, 1)}\n`)
console.log(`ключей ${Object.keys(CONCENTRATION_END_REASON_LABELS).length}, проверок ${labels.length}`)

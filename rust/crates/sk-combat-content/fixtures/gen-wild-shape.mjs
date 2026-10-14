import '../../../fixtures-env.mjs'
// Эталон server/wild-shape.mjs для Rust:
//
//   node rust/crates/sk-combat-content/fixtures/gen-wild-shape.mjs
//
// Набор зверей, предел показателя опасности и выбор облика для друидов
// Круга луны и прочих кругов на уровнях 1–20 и с мусором в полях.
import * as m from '../../../../server/wild-shape.mjs'
import { encode, writeFixture } from './common.mjs'

const subclasses = [undefined, 'Круг луны', 'круг ЛУНЫ', 'Circle of the Moon', 'moonlight', 'Круг земли', '', null, 5]
const levels = [...Array.from({ length: 20 }, (_, index) => index + 1), 0, -1, 2.9, '6', 'x', null, undefined, 7.5]
const actors = [null, undefined, {}, 'druid']
for (const subclass of subclasses) for (const level of levels) actors.push({ characterClass: 'druid', subclass, level })
actors.push({ subClass: 'Moon', level: 9 }, { subclass: null, subClass: 'луны', level: 12 }, { subclass: 'земли', subClass: 'луны', level: 12 })
const FORM_IDS = [undefined, 'wolf', 'giant-boar', 'brown-bear', 'dire-wolf', 'nope', null, 5]

const cases = actors.map((actor) => ({
  actor: encode(actor),
  moon: m.isMoonDruid(actor),
  limit: m.wildShapeChallengeLimit(actor),
  forms: m.wildShapeFormsFor(actor).map((form) => form.id),
  chosen: FORM_IDS.map((formId) => m.wildShapeFormFor(actor, formId)?.id ?? null),
}))

writeFixture(new URL('wild-shape.json', import.meta.url), { forms: m.WILD_SHAPE_FORMS, cases })

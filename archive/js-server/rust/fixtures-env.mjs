// Среда для генераторов эталонов JS → Rust: импортировать ПЕРВЫМ в каждом
// `rust/crates/*/fixtures/gen-*.mjs`.
//
// `localeCompare()` и `Intl.Collator()` без локали берут локаль процесса. На
// Windows владельца это ru-RU (кириллица раньше латиницы), в Docker-образе
// сервера — корневая локаль ICU, и Rust (`sk_core::text::locale_compare`)
// сортирует так же, как боевой сервер. Чтобы эталон не зависел от машины, где
// его сняли, локаль по умолчанию здесь — `en-US`, как у Node в Docker без LANG
// (порядок письменностей — корневой ICU: латиница, затем кириллица).
const NativeCollator = Intl.Collator
const ROOT = 'en-US'

function RootCollator(locales, options) {
  return new NativeCollator(locales ?? ROOT, options)
}
RootCollator.prototype = NativeCollator.prototype
RootCollator.supportedLocalesOf = NativeCollator.supportedLocalesOf
Intl.Collator = RootCollator

const nativeLocaleCompare = String.prototype.localeCompare
String.prototype.localeCompare = function localeCompare(that, locales, options) {
  return nativeLocaleCompare.call(this, that, locales ?? ROOT, options)
}

export const FIXTURE_LOCALE = ROOT

// `localeCompare` без локали в Node берёт локаль системы: на Windows с
// русской локалью кириллица встаёт раньше латиницы, в Docker и CI (en) — после.
// Rust (`sk_core::text::locale_compare`) сравнивает корневой сортировкой ICU,
// как Node с локалью en; эталоны снимаются с тем же порядком на любой машине.
const collator = new Intl.Collator('en')
const original = String.prototype.localeCompare
// eslint-disable-next-line no-extend-native
String.prototype.localeCompare = function localeCompare(other, locales, options) {
  if (locales === undefined && options === undefined) return collator.compare(String(this), String(other))
  return original.call(this, other, locales, options)
}

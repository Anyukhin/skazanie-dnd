//! Общие помощники модулей крейта: ключи прототипа `Object` и длина строки в
//! единицах UTF-16, как её считает JS.

/// Свойства `Object.prototype`: `obj[key]` в JS находит их у любого объекта.
pub(crate) const PROTOTYPE_KEYS: [&str; 12] = [
    "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__",
    "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString",
];

/// `text.length` в JS.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, limit)` по единицам UTF-16. Разрезанную суррогатную пару
/// Rust не представит; её половина отбрасывается.
pub(crate) fn head_utf16(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > limit {
            break;
        }
        out.push(ch);
    }
    out
}

//! `Array.prototype.sort(comparefn)` как в V8 — общий `sk_core::v8sort`.
//! Здесь — побитная сверка с Node на несогласованном сравнителе клеток
//! четверти (`furnishEmptyQuarters`), эталон `sorts`.

pub(crate) use sk_core::v8sort::sort_by;

#[cfg(test)]
mod tests {
    use super::sort_by;
    use sk_core::js;

    /// Сравнитель эталона `sorts` (`noisyCompare` в генераторе): знак от хеша
    /// пары, ответ бывает дробным и нулём — несогласован нарочно.
    fn noisy_compare(salt: i64) -> impl FnMut(&i64, &i64) -> f64 {
        move |left, right| {
            let mixed = js::imul(f64::from(js::to_int32((left * 7919 + right * 104_729 + salt) as f64)), 2_654_435_761.0) as u32;
            match mixed % 5 {
                0 => 0.0,
                1 => -f64::from((mixed >> 8) % 1000) / 997.0,
                2 => f64::from((mixed >> 8) % 1000) / 991.0,
                _ => (left - right) as f64 + f64::from((mixed >> 4) % 3) - 1.0,
            }
        }
    }

    /// Несогласованный сравнитель: порядок — как у `Array.prototype.sort` Node.
    #[test]
    fn inconsistent_comparator_matches_v8() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/building-generator.json")).expect("эталон");
        let sorts = fixture["sorts"].as_array().expect("сортировки");
        assert!(sorts.len() >= 150);
        let mut longest = 0;
        for (index, case) in sorts.iter().enumerate() {
            let numbers = |key: &str| case[key].as_array().expect("числа").iter().map(|item| item.as_i64().expect("целое")).collect::<Vec<_>>();
            let mut items = numbers("items");
            longest = longest.max(items.len());
            sort_by(&mut items, noisy_compare(case["salt"].as_i64().expect("соль")));
            assert_eq!(items, numbers("sorted"), "сортировка №{index}, длина {}", items.len());
        }
        assert!(longest > 1_000, "слияния с галопом не проверены: длина до {longest}");
    }
}

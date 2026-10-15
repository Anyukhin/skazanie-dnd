//! `Array.prototype.sort(comparefn)` шаг в шаг как в V8 — TimSort из
//! `third_party/v8/builtins/array-sort.tq`: поиск серий, добивка серии
//! двоичными вставками до `minrun`, стек серий с инвариантом, слияние с
//! «галопом» (`kMinGallopWins = 7`).
//!
//! Зачем свой перенос, а не `slice::sort_by`: при согласованном сравнителе
//! любая устойчивая сортировка даёт тот же порядок, но сравнитель JS бывает
//! несогласован. В `furnishEmptyQuarters` клетки четверти сортируются по
//! разности расстояний в дробях (`|x − cx| + |y − cy| − …`): при равных
//! расстояниях ошибка округления даёт ±ε вместо нуля, и тогда исход зависит от
//! того, какие пары и в каком порядке сравнивал алгоритм. Здесь пары те же,
//! что у V8, поэтому и исход тот же. Сверка — эталон `sorts`
//! (`fixtures/gen-building-generator.mjs`), где сравнитель несогласован
//! нарочно.
//!
//! Ответ сравнителя — число JS: `NaN` считается нулём (`SortCompareUserFn`).

const MIN_GALLOP_WINS: usize = 7;

/// `array.sort(compare)` с ответом сравнителя числом JS.
pub(crate) fn sort_by<T: Copy>(items: &mut [T], compare: impl FnMut(&T, &T) -> f64) {
    let length = items.len();
    if length < 2 {
        return;
    }
    let mut state = SortState { work: items, compare, min_gallop: MIN_GALLOP_WINS, runs: Vec::new() };
    state.sort(length);
}

struct SortState<'a, T, F> {
    work: &'a mut [T],
    compare: F,
    min_gallop: usize,
    /// Стек серий: (начало, длина).
    runs: Vec<(usize, usize)>,
}

/// `ComputeMinRunLength(n)`.
fn min_run_length(mut n: usize) -> usize {
    let mut r = 0;
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

impl<T: Copy, F: FnMut(&T, &T) -> f64> SortState<'_, T, F> {
    fn cmp(&mut self, left: T, right: T) -> f64 {
        let order = (self.compare)(&left, &right);
        if order.is_nan() {
            0.0
        } else {
            order
        }
    }

    fn sort(&mut self, length: usize) {
        let mut remaining = length;
        let mut low = 0;
        let min_run = min_run_length(length);
        while remaining != 0 {
            let mut current = self.count_and_make_run(low, low + remaining);
            if current < min_run {
                let forced = min_run.min(remaining);
                self.binary_insertion_sort(low, low + current, low + forced);
                current = forced;
            }
            self.runs.push((low, current));
            self.merge_collapse();
            low += current;
            remaining -= current;
        }
        self.merge_force_collapse();
    }

    /// `CountAndMakeRun(low, high)`: длина серии с `low`; убывающая
    /// (строго) разворачивается.
    fn count_and_make_run(&mut self, low_arg: usize, high: usize) -> usize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run_length = 2;
        let element_low = self.work[low];
        let element_low_pre = self.work[low - 1];
        let order = self.cmp(element_low, element_low_pre);
        let descending = order < 0.0;
        let mut previous = element_low;
        for index in low + 1..high {
            let current = self.work[index];
            let order = self.cmp(current, previous);
            if descending {
                if order >= 0.0 {
                    break;
                }
            } else if order < 0.0 {
                break;
            }
            previous = current;
            run_length += 1;
        }
        if descending {
            self.work[low_arg..low_arg + run_length].reverse();
        }
        run_length
    }

    /// `BinaryInsertionSort(low, start, high)`: `[low, start)` уже упорядочен.
    fn binary_insertion_sort(&mut self, low: usize, start_arg: usize, high: usize) {
        let mut start = if low == start_arg { start_arg + 1 } else { start_arg };
        while start < high {
            let mut left = low;
            let mut right = start;
            let pivot = self.work[start];
            while left < right {
                let mid = left + ((right - left) >> 1);
                let order = self.cmp(pivot, self.work[mid]);
                if order < 0.0 {
                    right = mid;
                } else {
                    left = mid + 1;
                }
            }
            self.work.copy_within(left..start, left + 1);
            self.work[left] = pivot;
            start += 1;
        }
    }

    fn run_length(&self, index: usize) -> usize {
        self.runs[index].1
    }

    /// `RunInvariantEstablished(n)`: `len(n−2) > len(n−1) + len(n)`.
    fn invariant(&self, n: usize) -> bool {
        if n < 2 {
            return true;
        }
        self.run_length(n - 2) > self.run_length(n - 1) + self.run_length(n)
    }

    fn merge_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.invariant(n + 1) || !self.invariant(n) {
                if self.run_length(n - 1) < self.run_length(n + 1) {
                    n -= 1;
                }
                self.merge_at(n);
            } else if self.run_length(n) <= self.run_length(n + 1) {
                self.merge_at(n);
            } else {
                break;
            }
        }
    }

    fn merge_force_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if n > 0 && self.run_length(n - 1) < self.run_length(n + 1) {
                n -= 1;
            }
            self.merge_at(n);
        }
    }

    fn merge_at(&mut self, index: usize) {
        let (base_a, length_a) = self.runs[index];
        let (base_b, length_b) = self.runs[index + 1];
        self.runs[index].1 = length_a + length_b;
        self.runs.remove(index + 1);
        let key_right = self.work[base_b];
        let k = self.gallop_right(Side::Work, key_right, base_a, length_a, 0);
        let base_a = base_a + k;
        let length_a = length_a - k;
        if length_a == 0 {
            return;
        }
        let key_left = self.work[base_a + length_a - 1];
        let length_b = self.gallop_left(Side::Work, key_left, base_b, length_b, length_b - 1);
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(base_a, length_a, base_b, length_b);
        }
    }

    fn load(&self, side: &Side<T>, index: usize) -> T {
        match side {
            Side::Work => self.work[index],
            Side::Temp(temp) => temp[index],
        }
    }

    /// `GallopLeft(array, key, base, length, hint)`.
    fn gallop_left(&mut self, side: Side<T>, key: T, base: usize, length: usize, hint: usize) -> usize {
        let (length, hint) = (length as isize, hint as isize);
        let mut last_ofs: isize = 0;
        let mut offset: isize = 1;
        let base_hint = self.load(&side, base + hint as usize);
        let order = self.cmp(base_hint, key);
        if order < 0.0 {
            let max_ofs = length - hint;
            while offset < max_ofs {
                let element = self.load(&side, (base as isize + hint + offset) as usize);
                if self.cmp(element, key) >= 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
                if offset <= 0 {
                    offset = max_ofs;
                }
            }
            if offset > max_ofs {
                offset = max_ofs;
            }
            last_ofs += hint;
            offset += hint;
        } else {
            let max_ofs = hint + 1;
            while offset < max_ofs {
                let element = self.load(&side, (base as isize + hint - offset) as usize);
                if self.cmp(element, key) < 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
                if offset <= 0 {
                    offset = max_ofs;
                }
            }
            if offset > max_ofs {
                offset = max_ofs;
            }
            let tmp = last_ofs;
            last_ofs = hint - offset;
            offset = hint - tmp;
        }
        last_ofs += 1;
        while last_ofs < offset {
            let m = last_ofs + ((offset - last_ofs) >> 1);
            let element = self.load(&side, (base as isize + m) as usize);
            if self.cmp(element, key) < 0.0 {
                last_ofs = m + 1;
            } else {
                offset = m;
            }
        }
        offset as usize
    }

    /// `GallopRight(array, key, base, length, hint)`.
    fn gallop_right(&mut self, side: Side<T>, key: T, base: usize, length: usize, hint: usize) -> usize {
        let (length, hint) = (length as isize, hint as isize);
        let mut last_ofs: isize = 0;
        let mut offset: isize = 1;
        let base_hint = self.load(&side, base + hint as usize);
        let order = self.cmp(key, base_hint);
        if order < 0.0 {
            let max_ofs = hint + 1;
            while offset < max_ofs {
                let element = self.load(&side, (base as isize + hint - offset) as usize);
                if self.cmp(key, element) >= 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
                if offset <= 0 {
                    offset = max_ofs;
                }
            }
            if offset > max_ofs {
                offset = max_ofs;
            }
            let tmp = last_ofs;
            last_ofs = hint - offset;
            offset = hint - tmp;
        } else {
            let max_ofs = length - hint;
            while offset < max_ofs {
                let element = self.load(&side, (base as isize + hint + offset) as usize);
                if self.cmp(key, element) < 0.0 {
                    break;
                }
                last_ofs = offset;
                offset = (offset << 1) + 1;
                if offset <= 0 {
                    offset = max_ofs;
                }
            }
            if offset > max_ofs {
                offset = max_ofs;
            }
            last_ofs += hint;
            offset += hint;
        }
        last_ofs += 1;
        while last_ofs < offset {
            let m = last_ofs + ((offset - last_ofs) >> 1);
            let element = self.load(&side, (base as isize + m) as usize);
            if self.cmp(key, element) < 0.0 {
                offset = m;
            } else {
                last_ofs = m + 1;
            }
        }
        offset as usize
    }

    /// `MergeLow`: слияние слева направо, во временный массив — серия A.
    fn merge_low(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) {
        let mut length_a = length_a;
        let mut length_b = length_b;
        let temp: Vec<T> = self.work[base_a..base_a + length_a].to_vec();
        let mut dest = base_a;
        let mut cursor_temp = 0;
        let mut cursor_b = base_b;
        self.work[dest] = self.work[cursor_b];
        dest += 1;
        cursor_b += 1;
        // Исход слияния: `Succeed` или `CopyB`.
        let copy_b = 'merge: {
            length_b -= 1;
            if length_b == 0 {
                break 'merge false;
            }
            if length_a == 1 {
                break 'merge true;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a = 0;
                let mut wins_b = 0;
                loop {
                    let order = self.cmp(self.work[cursor_b], temp[cursor_temp]);
                    if order < 0.0 {
                        self.work[dest] = self.work[cursor_b];
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'merge false;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[dest] = temp[cursor_temp];
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'merge true;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = self.work[cursor_b];
                    wins_a = self.gallop_right(Side::Temp(&temp), key, cursor_temp, length_a, 0);
                    if wins_a > 0 {
                        self.work[dest..dest + wins_a].copy_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'merge true;
                        }
                        if length_a == 0 {
                            break 'merge false;
                        }
                    }
                    self.work[dest] = self.work[cursor_b];
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'merge false;
                    }
                    let key = temp[cursor_temp];
                    wins_b = self.gallop_left(Side::Work, key, cursor_b, length_b, 0);
                    if wins_b > 0 {
                        self.work.copy_within(cursor_b..cursor_b + wins_b, dest);
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'merge false;
                        }
                    }
                    self.work[dest] = temp[cursor_temp];
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'merge true;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        if copy_b {
            self.work.copy_within(cursor_b..cursor_b + length_b, dest);
            self.work[dest + length_b] = temp[cursor_temp];
        } else if length_a > 0 {
            self.work[dest..dest + length_a].copy_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
        }
    }

    /// `MergeHigh`: слияние справа налево, во временный массив — серия B.
    fn merge_high(&mut self, base_a: usize, length_a: usize, base_b: usize, length_b: usize) {
        let mut length_a = length_a as isize;
        let mut length_b = length_b as isize;
        let temp: Vec<T> = self.work[base_b..base_b + length_b as usize].to_vec();
        let base_a = base_a as isize;
        let mut dest = base_b as isize + length_b - 1;
        let mut cursor_temp = length_b - 1;
        let mut cursor_a = base_a + length_a - 1;
        let at = |index: isize| index as usize;
        self.work[at(dest)] = self.work[at(cursor_a)];
        dest -= 1;
        cursor_a -= 1;
        // Исход слияния: `Succeed` или `CopyA`.
        let copy_a = 'merge: {
            length_a -= 1;
            if length_a == 0 {
                break 'merge false;
            }
            if length_b == 1 {
                break 'merge true;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a: usize = 0;
                let mut wins_b: usize = 0;
                loop {
                    let order = self.cmp(temp[at(cursor_temp)], self.work[at(cursor_a)]);
                    if order < 0.0 {
                        self.work[at(dest)] = self.work[at(cursor_a)];
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'merge false;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[at(dest)] = temp[at(cursor_temp)];
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'merge true;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = temp[at(cursor_temp)];
                    let k = self.gallop_right(Side::Work, key, at(base_a), at(length_a), at(length_a - 1)) as isize;
                    wins_a = (length_a - k) as usize;
                    if wins_a > 0 {
                        let count = wins_a as isize;
                        dest -= count;
                        cursor_a -= count;
                        self.work.copy_within(at(cursor_a + 1)..at(cursor_a + 1 + count), at(dest + 1));
                        length_a -= count;
                        if length_a == 0 {
                            break 'merge false;
                        }
                    }
                    self.work[at(dest)] = temp[at(cursor_temp)];
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'merge true;
                    }
                    let key = self.work[at(cursor_a)];
                    let k = self.gallop_left(Side::Temp(&temp), key, 0, at(length_b), at(length_b - 1)) as isize;
                    wins_b = (length_b - k) as usize;
                    if wins_b > 0 {
                        let count = wins_b as isize;
                        dest -= count;
                        cursor_temp -= count;
                        self.work[at(dest + 1)..at(dest + 1 + count)].copy_from_slice(&temp[at(cursor_temp + 1)..at(cursor_temp + 1 + count)]);
                        length_b -= count;
                        if length_b == 1 {
                            break 'merge true;
                        }
                        if length_b == 0 {
                            break 'merge false;
                        }
                    }
                    self.work[at(dest)] = self.work[at(cursor_a)];
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'merge false;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        if copy_a {
            dest -= length_a;
            cursor_a -= length_a;
            self.work.copy_within(at(cursor_a + 1)..at(cursor_a + 1 + length_a), at(dest + 1));
            self.work[at(dest)] = temp[at(cursor_temp)];
        } else if length_b > 0 {
            let start = dest - (length_b - 1);
            self.work[at(start)..at(start + length_b)].copy_from_slice(&temp[..at(length_b)]);
        }
    }
}

/// Откуда читает галоп: рабочий массив или временная копия серии.
enum Side<'t, T> {
    Work,
    Temp(&'t [T]),
}

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

    /// Согласованный сравнитель: исход — как у любой устойчивой сортировки.
    #[test]
    fn consistent_comparator_matches_stable_sort() {
        let mut state: u32 = 12345;
        let mut next = || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            state >> 8
        };
        for round in 0..300 {
            let length = if round < 100 { (next() % 70) as usize } else { (next() % 3000) as usize };
            let spread = 1 + next() % (length as u32 + 1);
            let mut items: Vec<(u32, usize)> = (0..length).map(|index| (next() % spread, index)).collect();
            if round % 7 == 0 {
                items.sort_by_key(|item| std::cmp::Reverse(item.0));
            }
            let mut expected = items.clone();
            expected.sort_by_key(|item| item.0);
            sort_by(&mut items, |left, right| f64::from(left.0) - f64::from(right.0));
            assert_eq!(items, expected, "длина {length}");
        }
    }
}

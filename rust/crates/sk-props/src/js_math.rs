//! Математика JS, от которой зависит клетка или выбор предмета: системная
//! библиотека Rust (mingw) расходится с Node в последнем бите, а здесь он
//! решает исход сравнения или выпавший предмет.
//!
//! **`x ** y`** (веса добора `(1 + count) ** 1.6`). V8 не считает `Math.pow`
//! сам: `base::ieee754::pow` разбирает особые значения ECMAScript и зовёт
//! `std::pow` платформы (UCRT на Windows, glibc в боевом Docker). На машине
//! владельца Node совпадает с верно округлённым значением для всех оснований
//! 1…2724 и почти всех до 20000 (эталон `fixtures/prop-placement.json`,
//! разделы `pow` и `powTail`). `f64::powf` (mingw) ошибается уже на `6 ** 1.6`,
//! порт fdlibm `e_pow.c` — на `26 ** 1.6`. Поэтому для положительного
//! конечного основания степень считается в двойной-двойной точности
//! (`exp(y · ln x)` по алгоритмам библиотеки QD, около 100 бит) и округляется
//! до `f64`: верно округлённый результат, не зависящий от платформы. Вне этой
//! области (ноль, отрицательное основание, переполнение) — `f64::powf` с
//! поправками ECMAScript: расстановке такие значения не встречаются.
//!
//! **`Math.sin`, `Math.atan2`** (неровный край пятна трудной местности). Здесь
//! V8 считает сам — порт fdlibm (`base::ieee754::sin`, `atan2`): Node не
//! совпадает ни с верно округлённым синусом (187 из 5929 значений области),
//! ни с UCRT. Перенесены `__kernel_sin`, `__kernel_cos`, средняя ветвь
//! `__ieee754_rem_pio2` (|x| до 2¹⁹·π/2), `atan` и `__ieee754_atan2`;
//! константы — их битовые образы из fdlibm. Аргумент больше 2¹⁹·π/2 обстановке
//! не встречается и считается `f64::sin`.

/// Число двойной-двойной точности: `hi + lo`, `|lo| ≤ ulp(hi) / 2`.
#[derive(Clone, Copy, Debug)]
struct Dd {
    hi: f64,
    lo: f64,
}

fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let sum = a + b;
    let bb = sum - a;
    (sum, (a - (sum - bb)) + (b - bb))
}

fn quick_two_sum(a: f64, b: f64) -> (f64, f64) {
    let sum = a + b;
    (sum, b - (sum - a))
}

/// Разбиение Деккера: без `fma`, только базовые операции IEEE.
fn split(a: f64) -> (f64, f64) {
    let t = 134_217_729.0 * a;
    let hi = t - (t - a);
    (hi, a - hi)
}

fn two_prod(a: f64, b: f64) -> (f64, f64) {
    let product = a * b;
    let (ah, al) = split(a);
    let (bh, bl) = split(b);
    (product, ((ah * bh - product) + ah * bl + al * bh) + al * bl)
}

impl Dd {
    const fn new(hi: f64, lo: f64) -> Self {
        Self { hi, lo }
    }

    fn from_pair((hi, lo): (f64, f64)) -> Self {
        Self { hi, lo }
    }

    fn add(self, other: Dd) -> Dd {
        let (s1, s2) = two_sum(self.hi, other.hi);
        let (t1, t2) = two_sum(self.lo, other.lo);
        let (s1, s2) = quick_two_sum(s1, s2 + t1);
        Dd::from_pair(quick_two_sum(s1, s2 + t2))
    }

    fn add_f(self, other: f64) -> Dd {
        let (s1, s2) = two_sum(self.hi, other);
        Dd::from_pair(quick_two_sum(s1, s2 + self.lo))
    }

    fn neg(self) -> Dd {
        Dd::new(-self.hi, -self.lo)
    }

    fn mul(self, other: Dd) -> Dd {
        let (p1, p2) = two_prod(self.hi, other.hi);
        Dd::from_pair(quick_two_sum(p1, p2 + (self.hi * other.lo + self.lo * other.hi)))
    }

    fn mul_f(self, other: f64) -> Dd {
        let (p1, p2) = two_prod(self.hi, other);
        Dd::from_pair(quick_two_sum(p1, p2 + self.lo * other))
    }

    /// Умножение на степень двойки — точное.
    fn scale(self, power: f64) -> Dd {
        Dd::new(self.hi * power, self.lo * power)
    }

    fn div_f(self, other: f64) -> Dd {
        let q1 = self.hi / other;
        let (p1, p2) = two_prod(q1, other);
        let (s, e) = two_sum(self.hi, -p1);
        let e = e + self.lo - p2;
        let q2 = (s + e) / other;
        Dd::from_pair(quick_two_sum(q1, q2))
    }
}

/// ln 2 в двойной-двойной точности (QD `_log2`).
const LOG2: Dd = Dd::new(6.931_471_805_599_452_862e-01, 2.319_046_813_846_299_558e-17);
/// 2⁻¹⁰⁴ — точность двойной-двойной арифметики (QD `_eps`).
const EPS: f64 = 4.930_380_657_631_32e-32;
/// Приведение аргумента экспоненты делением на 2⁹ (QD `k = 512`).
const INV_K: f64 = 1.0 / 512.0;

/// `2 ** exponent` для показателя нормального диапазона.
fn power_of_two(exponent: i64) -> f64 {
    f64::from_bits(((exponent + 1023) as u64) << 52)
}

/// `exp(a)` (QD `dd_real::exp`): приведение по ln 2 и делению на 512, ряд
/// Тейлора, девять возведений в квадрат. `None` — вне нормального диапазона.
fn dd_exp(a: Dd) -> Option<Dd> {
    if !(a.hi > -700.0 && a.hi < 700.0) {
        return None;
    }
    if a.hi == 0.0 && a.lo == 0.0 {
        return Some(Dd::new(1.0, 0.0));
    }
    let m = (a.hi / LOG2.hi + 0.5).floor();
    let r = a.add(LOG2.mul_f(m).neg()).scale(INV_K);
    // 1/3!, 1/4!, … в двойной-двойной точности: факториалы до 18! точны в f64.
    let mut factorial = 2.0;
    let mut next_inverse_factorial = |index: usize| {
        factorial *= (index + 3) as f64;
        Dd::new(1.0, 0.0).div_f(factorial)
    };
    let mut p = r.mul(r);
    let mut s = r.add(p.scale(0.5));
    p = p.mul(r);
    let mut t = p.mul(next_inverse_factorial(0));
    let mut index = 0;
    loop {
        s = s.add(t);
        p = p.mul(r);
        index += 1;
        t = p.mul(next_inverse_factorial(index));
        if !(t.hi.abs() > INV_K * EPS && index < 5) {
            break;
        }
    }
    s = s.add(t);
    for _ in 0..9 {
        s = s.scale(2.0).add(s.mul(s));
    }
    s = s.add_f(1.0);
    Some(s.scale(power_of_two(m as i64)))
}

/// `ln(x)` для положительного конечного `x` (QD `dd_real::log`): одно
/// приближение Ньютона от `f64::ln` удваивает точность, и итог не зависит от
/// последнего бита начального приближения.
fn dd_log(x: f64) -> Option<Dd> {
    if x == 1.0 {
        return Some(Dd::new(0.0, 0.0));
    }
    let guess = Dd::new(x.ln(), 0.0);
    let correction = dd_exp(guess.neg())?.mul_f(x);
    Some(guess.add(correction).add_f(-1.0))
}

/// Верно округлённое `x ** y` для положительного конечного `x`; `None` —
/// вне области (переполнение, исчезновение порядка).
fn correctly_rounded_pow(x: f64, y: f64) -> Option<f64> {
    let logarithm = dd_log(x)?;
    let power = dd_exp(logarithm.mul_f(y))?;
    power.hi.is_normal().then_some(power.hi)
}

/// `Math.pow(x, y)` / `x ** y`.
pub(crate) fn js_pow(x: f64, y: f64) -> f64 {
    // Особые значения ECMAScript поверх C: NaN в степени и (±1) ** ±∞ — NaN.
    if y.is_nan() {
        return f64::NAN;
    }
    if y.is_infinite() && (x == 1.0 || x == -1.0) {
        return f64::NAN;
    }
    if y == 0.0 {
        return 1.0;
    }
    if x > 0.0 && x.is_finite() && y.is_finite() {
        if let Some(power) = correctly_rounded_pow(x, y) {
            return power;
        }
    }
    x.powf(y)
}

// --- fdlibm: синус и арктангенс ------------------------------------------------------

fn high_word(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}

fn low_word(x: f64) -> u32 {
    x.to_bits() as u32
}

fn from_words(high: i32, low: u32) -> f64 {
    f64::from_bits((u64::from(high as u32) << 32) | u64::from(low))
}

/// `__kernel_sin(x, y, iy)` на [−π/4, π/4]; `y` — хвост аргумента.
fn kernel_sin(x: f64, y: f64, iy: bool) -> f64 {
    const S1: f64 = -1.666_666_666_666_663_243_48e-01; // 0xBFC55555 0x55555549
    const S2: f64 = 8.333_333_333_322_489_461_24e-03; // 0x3F811111 0x1110F8A6
    const S3: f64 = -1.984_126_982_985_794_931_34e-04; // 0xBF2A01A0 0x19C161D5
    const S4: f64 = 2.755_731_370_707_006_767_89e-06; // 0x3EC71DE3 0x57B1FE7D
    const S5: f64 = -2.505_076_025_340_686_341_95e-08; // 0xBE5AE5E6 0x8A2B9CEB
    const S6: f64 = 1.589_690_995_211_550_102_21e-10; // 0x3DE5D93A 0x5ACFD57C
    let ix = high_word(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if iy {
        x - ((z * (0.5 * y - v * r) - y) - v * S1)
    } else {
        x + v * (S1 + z * r)
    }
}

/// `__kernel_cos(x, y)` на [−π/4, π/4] (fdlibm 5.3, как у V8).
fn kernel_cos(x: f64, y: f64) -> f64 {
    const C1: f64 = 4.166_666_666_666_660_190_37e-02; // 0x3FA55555 0x5555554C
    const C2: f64 = -1.388_888_888_887_410_957_49e-03; // 0xBF56C16C 0x16C15177
    const C3: f64 = 2.480_158_728_947_672_941_78e-05; // 0x3EFA01A0 0x19CB1590
    const C4: f64 = -2.755_731_435_139_066_330_35e-07; // 0xBE927E4F 0x809C52AD
    const C5: f64 = 2.087_572_321_298_174_827_90e-09; // 0x3E21EE9E 0xBDB4B1C4
    const C6: f64 = -1.135_964_755_778_819_482_65e-11; // 0xBDA8FAE9 0xBE8838D4
    let ix = high_word(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && x as i32 == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3fd3_3333 {
        return 1.0 - (0.5 * z - (z * r - x * y));
    }
    let qx = if ix > 0x3fe9_0000 { 0.28125 } else { from_words(ix - 0x0020_0000, 0) };
    let hz = 0.5 * z - qx;
    let a = 1.0 - qx;
    a - (hz - (z * r - x * y))
}

/// Старшие слова n·π/2 для n = 1…32 (`npio2_hw`).
#[rustfmt::skip]
const NPIO2_HW: [i32; 32] = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C,
    0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C,
    0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A,
    0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB,
    0x404858EB, 0x404921FB,
];

/// `__ieee754_rem_pio2(x)` для |x| ≤ 2¹⁹·π/2: (n, y0, y1), x = n·π/2 + y0 + y1.
/// `None` — больший аргумент (ветвь `__kernel_rem_pio2` не перенесена).
fn rem_pio2(x: f64) -> Option<(i32, f64, f64)> {
    const INVPIO2: f64 = 6.366_197_723_675_813_824_33e-01; // 0x3FE45F30 0x6DC9C883
    const PIO2_1: f64 = 1.570_796_326_734_125_614_17e+00; // 0x3FF921FB 0x54400000
    const PIO2_1T: f64 = 6.077_100_506_506_192_249_32e-11; // 0x3DD0B461 0x1A626331
    const PIO2_2: f64 = 6.077_100_506_303_965_976_60e-11; // 0x3DD0B461 0x1A600000
    const PIO2_2T: f64 = 2.022_266_248_795_950_631_54e-21; // 0x3BA3198A 0x2E037073
    const PIO2_3: f64 = 2.022_266_248_711_166_455_80e-21; // 0x3BA3198A 0x2E000000
    const PIO2_3T: f64 = 8.478_427_660_368_899_569_97e-32; // 0x397B839A 0x252049C1
    let hx = high_word(x);
    let ix = hx & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return Some((0, x, 0.0));
    }
    if ix < 0x4002_d97c {
        // |x| < 3π/4: n = ±1.
        return Some(if hx > 0 {
            let mut z = x - PIO2_1;
            if ix != 0x3ff9_21fb {
                let y0 = z - PIO2_1T;
                (1, y0, (z - y0) - PIO2_1T)
            } else {
                z -= PIO2_2;
                let y0 = z - PIO2_2T;
                (1, y0, (z - y0) - PIO2_2T)
            }
        } else {
            let mut z = x + PIO2_1;
            if ix != 0x3ff9_21fb {
                let y0 = z + PIO2_1T;
                (-1, y0, (z - y0) + PIO2_1T)
            } else {
                z += PIO2_2;
                let y0 = z + PIO2_2T;
                (-1, y0, (z - y0) + PIO2_2T)
            }
        });
    }
    if ix > 0x4139_21fb {
        return None;
    }
    // Средний аргумент.
    let t = x.abs();
    let n = (t * INVPIO2 + 0.5) as i32;
    let fn_ = f64::from(n);
    let mut r = t - fn_ * PIO2_1;
    let mut w = fn_ * PIO2_1T;
    let mut y0;
    if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
        y0 = r - w;
    } else {
        let j = ix >> 20;
        y0 = r - w;
        let mut i = j - ((high_word(y0) >> 20) & 0x7ff);
        if i > 16 {
            // Второй проход, 118 бит.
            let t = r;
            w = fn_ * PIO2_2;
            r = t - w;
            w = fn_ * PIO2_2T - ((t - r) - w);
            y0 = r - w;
            i = j - ((high_word(y0) >> 20) & 0x7ff);
            if i > 49 {
                // Третий проход, 151 бит.
                let t = r;
                w = fn_ * PIO2_3;
                r = t - w;
                w = fn_ * PIO2_3T - ((t - r) - w);
                y0 = r - w;
            }
        }
    }
    let y1 = (r - y0) - w;
    Some(if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) })
}

/// `Math.sin(x)` как в V8 (fdlibm).
pub(crate) fn js_sin(x: f64) -> f64 {
    let ix = high_word(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_sin(x, 0.0, false);
    }
    if ix >= 0x7ff0_0000 {
        return x - x;
    }
    let Some((n, y0, y1)) = rem_pio2(x) else { return x.sin() };
    match n & 3 {
        0 => kernel_sin(y0, y1, true),
        1 => kernel_cos(y0, y1),
        2 => -kernel_sin(y0, y1, true),
        _ => -kernel_cos(y0, y1),
    }
}

/// `atan(x)` (fdlibm `s_atan.c`, как у V8).
fn atan(x: f64) -> f64 {
    const ATANHI: [f64; 4] = [
        4.636_476_090_008_060_935_15e-01, // atan(0.5)hi 0x3FDDAC67 0x0561BB4F
        7.853_981_633_974_482_789_99e-01, // atan(1.0)hi 0x3FE921FB 0x54442D18
        9.827_937_232_473_290_540_82e-01, // atan(1.5)hi 0x3FEF730B 0xD281F69B
        1.570_796_326_794_896_558_00e+00, // atan(inf)hi 0x3FF921FB 0x54442D18
    ];
    const ATANLO: [f64; 4] = [
        2.269_877_745_296_168_709_24e-17, // 0x3C7A2B7F 0x222F65E2
        3.061_616_997_868_383_017_93e-17, // 0x3C81A626 0x33145C07
        1.390_331_103_123_099_845_16e-17, // 0x3C700788 0x7AF0CBBD
        6.123_233_995_736_766_035_87e-17, // 0x3C91A626 0x33145C07
    ];
    #[rustfmt::skip]
    const AT: [f64; 11] = [
        3.333_333_333_333_293_180_27e-01,  // 0x3FD55555 0x5555550D
        -1.999_999_999_987_648_324_76e-01, // 0xBFC99999 0x9998EBC4
        1.428_571_427_250_346_637_11e-01,  // 0x3FC24924 0x920083FF
        -1.111_111_040_546_235_578_80e-01, // 0xBFBC71C6 0xFE231671
        9.090_887_133_436_506_561_96e-02,  // 0x3FB745CD 0xC54C206E
        -7.691_876_205_044_829_994_95e-02, // 0xBFB3B0F2 0xAF749A6D
        6.661_073_137_387_531_206_69e-02,  // 0x3FB10D66 0xA0D03D51
        -5.833_570_133_790_573_486_45e-02, // 0xBFADDE2D 0x52DEFD9A
        4.976_877_994_615_932_360_17e-02,  // 0x3FA97B4B 0x24760DEB
        -3.653_157_274_421_691_552_70e-02, // 0xBFA2B444 0x2C6A6C2F
        1.628_582_011_536_578_236_23e-02,  // 0x3F90AD3A 0xE322DA11
    ];
    let hx = high_word(x);
    let ix = hx & 0x7fff_ffff;
    let mut x = x;
    let id: i32;
    if ix >= 0x4410_0000 {
        // |x| ≥ 2⁶⁶.
        if ix > 0x7ff0_0000 || (ix == 0x7ff0_0000 && low_word(x) != 0) {
            return x + x;
        }
        return if hx > 0 { ATANHI[3] + ATANLO[3] } else { -ATANHI[3] - ATANLO[3] };
    }
    if ix < 0x3fdc_0000 {
        // |x| < 0.4375.
        if ix < 0x3e40_0000 && 1.0e300 + x > 1.0 {
            return x;
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3ff3_0000 {
            if ix < 0x3fe6_0000 {
                id = 0;
                x = (2.0 * x - 1.0) / (2.0 + x);
            } else {
                id = 1;
                x = (x - 1.0) / (x + 1.0);
            }
        } else if ix < 0x4003_8000 {
            id = 2;
            x = (x - 1.5) / (1.0 + 1.5 * x);
        } else {
            id = 3;
            x = -1.0 / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if id < 0 {
        return x - x * (s1 + s2);
    }
    let id = id as usize;
    let z = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
    if hx < 0 {
        -z
    } else {
        z
    }
}

/// `Math.atan2(y, x)` как в V8 (fdlibm `e_atan2.c`).
pub(crate) fn js_atan2(y: f64, x: f64) -> f64 {
    const TINY: f64 = 1.0e-300;
    const PI_O_4: f64 = 7.853_981_633_974_482_790_0e-01; // 0x3FE921FB 0x54442D18
    const PI_O_2: f64 = 1.570_796_326_794_896_558_0e+00; // 0x3FF921FB 0x54442D18
    const PI: f64 = 3.141_592_653_589_793_116_0e+00; // 0x400921FB 0x54442D18
    const PI_LO: f64 = 1.224_646_799_147_353_177_2e-16; // 0x3CA1A626 0x33145C07
    if x.is_nan() || y.is_nan() {
        return x + y;
    }
    let hx = high_word(x);
    let ix = hx & 0x7fff_ffff;
    let lx = low_word(x);
    let hy = high_word(y);
    let iy = hy & 0x7fff_ffff;
    let ly = low_word(y);
    if (hx.wrapping_sub(0x3ff0_0000) as u32 | lx) == 0 {
        return atan(y);
    }
    let mut m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
    if (iy as u32 | ly) == 0 {
        return match m {
            0 | 1 => y,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if (ix as u32 | lx) == 0 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }
    if ix == 0x7ff0_0000 {
        return if iy == 0x7ff0_0000 {
            match m {
                0 => PI_O_4 + TINY,
                1 => -PI_O_4 - TINY,
                2 => 3.0 * PI_O_4 + TINY,
                _ => -3.0 * PI_O_4 - TINY,
            }
        } else {
            match m {
                0 => 0.0,
                1 => -0.0,
                2 => PI + TINY,
                _ => -PI - TINY,
            }
        };
    }
    if iy == 0x7ff0_0000 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }
    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        m &= 1;
        PI_O_2 + 0.5 * PI_LO
    } else if hx < 0 && k < -60 {
        0.0
    } else {
        atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trig_follows_fdlibm_special_cases() {
        assert_eq!(js_sin(0.0), 0.0);
        assert!(js_sin(-0.0).is_sign_negative());
        assert!(js_sin(f64::INFINITY).is_nan());
        assert!(js_sin(f64::NAN).is_nan());
        assert!(js_sin(1e7).abs() <= 1.0);
        assert_eq!(js_sin(std::f64::consts::FRAC_PI_2), 1.0);
        assert_eq!(js_atan2(0.0, -3.0), std::f64::consts::PI);
        assert_eq!(js_atan2(-0.0, -3.0), -std::f64::consts::PI);
        assert_eq!(js_atan2(3.0, 0.0), std::f64::consts::FRAC_PI_2);
        assert_eq!(js_atan2(0.0, 0.0), 0.0);
        assert_eq!(js_atan2(1.0, 1.0), std::f64::consts::FRAC_PI_4);
        assert!(js_atan2(f64::NAN, 1.0).is_nan());
    }

    #[test]
    fn special_values_follow_ecmascript() {
        assert_eq!(js_pow(2.0, 10.0), 1024.0);
        assert_eq!(js_pow(9.0, 0.5), 3.0);
        assert_eq!(js_pow(1.0, 1.6), 1.0);
        assert_eq!(js_pow(5.0, 0.0), 1.0);
        assert_eq!(js_pow(f64::NAN, 0.0), 1.0);
        assert!(js_pow(1.0, f64::INFINITY).is_nan());
        assert!(js_pow(-1.0, f64::NEG_INFINITY).is_nan());
        assert!(js_pow(2.0, f64::NAN).is_nan());
        assert!(js_pow(-8.0, 1.6).is_nan());
        assert_eq!(js_pow(-2.0, 3.0), -8.0);
        assert_eq!(js_pow(0.0, -1.0), f64::INFINITY);
        assert_eq!(js_pow(10.0, 400.0), f64::INFINITY);
        assert_eq!(js_pow(4.0, 2.5), 32.0);
    }

    #[test]
    fn constants_are_qd_bit_patterns() {
        assert_eq!(LOG2.hi.to_bits(), 0x3FE6_2E42_FEFA_39EF);
        assert_eq!(LOG2.lo.to_bits(), 0x3C7A_BC9E_3B39_803F);
    }
}

#[cfg(test)]
mod fixture_tests {
    use super::js_pow;
    use serde_json::Value;

    /// Веса добора `1 / (1 + count) ** 1.6`: побитно как у Node (эталон
    /// `fixtures/prop-placement.json`, разделы `pow` и `powTail`).
    #[test]
    fn pow_matches_node_bit_for_bit() {
        let fixture: Value = serde_json::from_str(include_str!("../fixtures/prop-placement.json")).expect("эталон");
        let bits = |value: f64| format!("{:x}", value.to_bits());
        let mut checked = 0;
        for row in fixture["pow"].as_array().expect("pow") {
            let n = row[0].as_f64().expect("основание");
            let power = js_pow(n, 1.6);
            assert_eq!(bits(power), row[1].as_str().unwrap_or_default(), "{n} ** 1.6");
            assert_eq!(bits(1.0 / power), row[2].as_str().unwrap_or_default(), "1 / {n} ** 1.6");
            checked += 1;
        }
        assert_eq!(checked, 2000);
        // Хвост 2001…20000: Node берёт `pow` платформы (UCRT), и тот на девяти
        // основаниях ошибается чуть больше чем на полбита (0.5005…0.5025 ulp,
        // проверено десятичной арифметикой на 80 знаков). Rust здесь верно
        // округляет; в расстановке такие основания недостижимы — столько
        // экземпляров одного вида в зоне не бывает.
        const UCRT_MISROUNDED: [u64; 9] = [2725, 3476, 8400, 12145, 12161, 12311, 12563, 14632, 14779];
        let tail = &fixture["powTail"];
        let from = tail["from"].as_u64().expect("начало");
        let packed = tail["bits"].as_str().expect("биты хвоста");
        let mut misrounded = Vec::new();
        for (offset, chunk) in packed.as_bytes().chunks(16).enumerate() {
            let n = from + offset as u64;
            let expected = u64::from_str_radix(std::str::from_utf8(chunk).expect("hex"), 16).expect("hex");
            let actual = js_pow(n as f64, 1.6).to_bits();
            if actual != expected {
                assert_eq!(actual.abs_diff(expected), 1, "{n} ** 1.6 расходится больше чем на ulp");
                misrounded.push(n);
            }
        }
        assert_eq!(misrounded, UCRT_MISROUNDED);
    }
}

#[cfg(test)]
mod trig_fixture_tests {
    use super::{js_atan2, js_sin};
    use serde_json::Value;

    fn value(text: &Value) -> f64 {
        f64::from_bits(u64::from_str_radix(text.as_str().unwrap_or_default(), 16).expect("биты"))
    }

    /// Неровный край пятна: `Math.atan2` и `Math.sin(Math.atan2(dy, dx) * 3 + x)`
    /// на всей области `roughenGround` и на случайных аргументах — побитно как
    /// у V8 (эталон `fixtures/scene-dressing.json`).
    #[test]
    fn trig_matches_v8_bit_for_bit() {
        let fixture: Value = serde_json::from_str(include_str!("../fixtures/scene-dressing.json")).expect("эталон");
        for row in fixture["atan2"].as_array().expect("atan2") {
            let (dx, dy) = (row[0].as_f64().expect("dx"), row[1].as_f64().expect("dy"));
            assert_eq!(js_atan2(dy, dx).to_bits(), value(&row[2]).to_bits(), "atan2({dy}, {dx})");
        }
        let packed = fixture["sin"]["bits"].as_str().expect("биты");
        let mut chunks = packed.as_bytes().chunks(16);
        for dy in -3_i64..=3 {
            for dx in -3_i64..=3 {
                for x in 0..=120 {
                    let expected = u64::from_str_radix(std::str::from_utf8(chunks.next().expect("значение")).expect("hex"), 16).expect("hex");
                    let actual = js_sin(js_atan2(dy as f64, dx as f64) * 3.0 + x as f64);
                    assert_eq!(actual.to_bits(), expected, "sin(atan2({dy}, {dx}) * 3 + {x})");
                }
            }
        }
        assert!(chunks.next().is_none());
        for row in fixture["sinRandom"].as_array().expect("sinRandom") {
            let x = value(&row[0]);
            assert_eq!(js_sin(x).to_bits(), value(&row[1]).to_bits(), "sin({x})");
        }
        for row in fixture["atan2Random"].as_array().expect("atan2Random") {
            let (y, x) = (value(&row[0]), value(&row[1]));
            assert_eq!(js_atan2(y, x).to_bits(), value(&row[2]).to_bits(), "atan2({y}, {x})");
        }
    }
}

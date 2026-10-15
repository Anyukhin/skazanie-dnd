//! `Math.asin` как в V8 — общий `sk_core::v8math::asin` (порт fdlibm
//! `__ieee754_asin`): площадь сегмента круга — разность двух первообразных с
//! `asin`, эталон JS сверяется побитно.

pub(crate) use sk_core::v8math::asin;

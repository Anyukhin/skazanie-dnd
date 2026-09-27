# Приёмка иллюстраций заклинаний — 2026-09-26

Это визуальная проверка соответствия текущих runtime PNG смыслу заклинаний.
Она не проверяет механику Rules Engine, карточки правил, HTTP-сценарии или
браузерный игровой flow.

## Итог

- В таблице ровно **439 уникальных spell ID**; источник ID и описаний —
  `data/spell-descriptions-ru.json`.
- Runtime-источник рисунка каждой строки —
  `public/assets/ui/action-icons/<id>.png`.
- Финальные verdicts: **418 matched**, **21 symbolic**,
  **0 ambiguous**, **0 wrong-subject**.
- Кадры `icons-01.png` … `icons-18.png` — evidence текущего runtime-грида;
  в per-ID таблице указан конкретный кадр или явный
  `root-current-image-review`.
- Старые `artifact-review-*.png` и staging-копии остаются только
  историческим материалом и не являются основанием финального verdict.
- Все девять замен с provenance `root-current-image-review` root просмотрел
  по текущим PNG.

## Девять замен, просмотренных как текущие PNG

| ID | Источник verdict | Verdict | Provenance и хеши |
| --- | --- | --- | --- |
| `commune` | root-current-image-review | matched | source SHA `2D2749EBD12ED5F298FABED5BFD891C7C993634FAA2B11F3AEB74CC06B495547`; runtime SHA `940cc0309d30b0e3bc2d87b9b4b9a7ef35eabf69f9e79beb76ab0835b8ab1430`, 60256 bytes |
| `contact-other-plane` | root-current-image-review | matched | source SHA `D9D502BABEDD0B6D7170615781BFC2FB33B8CE2A623DBB7CC004256E4BBEE0C7`; runtime SHA `d19db977ee968a604088201c47443aaba862377b0ee8d73eab6b7a6691cfc904`, 65849 bytes |
| `creation` | root-current-image-review | matched | source SHA `58EAFC7928509666104E90D150145B1C2521807A9EE0809E82AC8AA693FF7489`; runtime SHA `b9c6982e3b425bc09e881f50be1738ea4cbf2b6c5efa52331b15336e59b04dd6`, 59873 bytes |
| `gentle-repose` | root-current-image-review | matched | source SHA `148D1681670BC5E8FF0F198844F787A7EA310E623BC03CA1D26DD39ACE7422EE`; runtime SHA `6b9899c10df43c486f725f20fb74d24c3ae34257ebfde5cd06dc2bf52702acf8`, 77879 bytes |
| `mislead` | root-current-image-review | matched | source SHA `e62635d28f71540cbf92f9f6049e463e407fabb919b7e26d81c0c9aedf48cc1d`; runtime SHA `8a3fcf2830365aecea4142d0203d06b473351d40293fdb82121859435c82e81c`, 95401 bytes |
| `phantasmal-force` | root-current-image-review | matched | source SHA `d870b14f646feb2e27f48f4da5bd5f00c83e9ac1ef74f4bafbb1fce0122a8e61`; runtime SHA `e485213eb8a4c7cc6349395b4371de9d33c69715d4fbd8149fffe5f93d560c29`, 150468 bytes |
| `programmed-illusion` | root-current-image-review | matched | source SHA `4f3a522373f3f74eecf97254589b0a3548ecd5951df09f284a6c512c72d97f64`; runtime SHA `3089af72233eb655bc6c6b935d2265b58889c0378b0b695a34e894abff3e502a`, 69416 bytes |
| `ray-of-enfeeblement` | root-current-image-review | matched | source SHA `bf91a48d935289095d33c7aef65e62cec10388226f8e0070ec23a393d9ca068a`; runtime SHA `7f2d83c3acf0d162c11a1313532a3d1edab67824eb4f48048dabf4598188b3e7`, 42654 bytes |
| `skywrite` | root-current-image-review | matched | source SHA `2ab85b34c8b88a3005d42b82983f6f9e7d4d4befe9361cb7a18be5218d0a88e6`; runtime SHA `124f2de851625617901d1b8bbe77e51fd1b0095a8db4ab449efb1a01db421f10`, 50071 bytes |

Для этих девяти файлов runtime SHA и размеры взяты после регистрации прав.
Raw source SHA относится к сохранённому ImageGen output; он не подменяет
runtime hash.

## Полный per-ID журнал

| ID | Runtime asset | Current evidence | Verdict | Visual note |
| --- | --- | --- | --- | --- |
| `acid-splash` | `ui/action-icons/acid-splash.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `control-flames` | `ui/action-icons/control-flames.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `mage-hand` | `ui/action-icons/mage-hand.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `magic-stone` | `ui/action-icons/magic-stone.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `sword-burst` | `ui/action-icons/sword-burst.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `booming-blade` | `ui/action-icons/booming-blade.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `friends` | `ui/action-icons/friends.png` | icons-01 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `shillelagh` | `ui/action-icons/shillelagh.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `blade-ward` | `ui/action-icons/blade-ward.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `vicious-mockery` | `ui/action-icons/vicious-mockery.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `druidcraft` | `ui/action-icons/druidcraft.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `green-flame-blade` | `ui/action-icons/green-flame-blade.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `lightning-lure` | `ui/action-icons/lightning-lure.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `chill-touch` | `ui/action-icons/chill-touch.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `mold-earth` | `ui/action-icons/mold-earth.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `ray-of-frost` | `ui/action-icons/ray-of-frost.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `minor-illusion` | `ui/action-icons/minor-illusion.png` | icons-01 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `true-strike` | `ui/action-icons/true-strike.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `eldritch-blast` | `ui/action-icons/eldritch-blast.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `infestation` | `ui/action-icons/infestation.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `frostbite` | `ui/action-icons/frostbite.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `fire-bolt` | `ui/action-icons/fire-bolt.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `primal-savagery` | `ui/action-icons/primal-savagery.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `dancing-lights` | `ui/action-icons/dancing-lights.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `toll-the-dead` | `ui/action-icons/toll-the-dead.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `mending` | `ui/action-icons/mending.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `thunderclap` | `ui/action-icons/thunderclap.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `mind-sliver` | `ui/action-icons/mind-sliver.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `light` | `ui/action-icons/light.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `sacred-flame` | `ui/action-icons/sacred-flame.png` | icons-01 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `word-of-radiance` | `ui/action-icons/word-of-radiance.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `message` | `ui/action-icons/message.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `resistance` | `ui/action-icons/resistance.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `create-bonfire` | `ui/action-icons/create-bonfire.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `produce-flame` | `ui/action-icons/produce-flame.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `thorn-whip` | `ui/action-icons/thorn-whip.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `guidance` | `ui/action-icons/guidance.png` | icons-02 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `spare-the-dying` | `ui/action-icons/spare-the-dying.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `prestidigitation` | `ui/action-icons/prestidigitation.png` | icons-02 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `shape-water` | `ui/action-icons/shape-water.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `thaumaturgy` | `ui/action-icons/thaumaturgy.png` | icons-02 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `gust` | `ui/action-icons/gust.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `shocking-grasp` | `ui/action-icons/shocking-grasp.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `poison-spray` | `ui/action-icons/poison-spray.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `hellish-rebuke` | `ui/action-icons/hellish-rebuke.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `silent-image` | `ui/action-icons/silent-image.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `bless` | `ui/action-icons/bless.png` | icons-02 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `divine-favor` | `ui/action-icons/divine-favor.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `witch-bolt` | `ui/action-icons/witch-bolt.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `thunderwave` | `ui/action-icons/thunderwave.png` | icons-02 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `magic-missile` | `ui/action-icons/magic-missile.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `jims-magic-missile` | `ui/action-icons/jims-magic-missile.png` | icons-03 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `compelled-duel` | `ui/action-icons/compelled-duel.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `cause-fear` | `ui/action-icons/cause-fear.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `heroism` | `ui/action-icons/heroism.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `wrathful-smite` | `ui/action-icons/wrathful-smite.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `hail-of-thorns` | `ui/action-icons/hail-of-thorns.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `thunderous-smite` | `ui/action-icons/thunderous-smite.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `dissonant-whispers` | `ui/action-icons/dissonant-whispers.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `armor-of-agathys` | `ui/action-icons/armor-of-agathys.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `mage-armor` | `ui/action-icons/mage-armor.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `earth-tremor` | `ui/action-icons/earth-tremor.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `animal-friendship` | `ui/action-icons/animal-friendship.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `tasha-s-caustic-brew` | `ui/action-icons/tasha-s-caustic-brew.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `tasha-s-hideous-laughter` | `ui/action-icons/tasha-s-hideous-laughter.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `protection-from-evil-and-good` | `ui/action-icons/protection-from-evil-and-good.png` | icons-03 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `beast-bond` | `ui/action-icons/beast-bond.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `distort-value` | `ui/action-icons/distort-value.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `silvery-barbs` | `ui/action-icons/silvery-barbs.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `catapult` | `ui/action-icons/catapult.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `ice-knife` | `ui/action-icons/ice-knife.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `frost-fingers` | `ui/action-icons/frost-fingers.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `healing-word` | `ui/action-icons/healing-word.png` | icons-03 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `cure-wounds` | `ui/action-icons/cure-wounds.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `ray-of-sickness` | `ui/action-icons/ray-of-sickness.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `disguise-self` | `ui/action-icons/disguise-self.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `hunter-s-mark` | `ui/action-icons/hunter-s-mark.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `inflict-wounds` | `ui/action-icons/inflict-wounds.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `guiding-bolt` | `ui/action-icons/guiding-bolt.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `illusory-script` | `ui/action-icons/illusory-script.png` | icons-03 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `unseen-servant` | `ui/action-icons/unseen-servant.png` | icons-04 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `detect-poison-and-disease` | `ui/action-icons/detect-poison-and-disease.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `detect-evil-and-good` | `ui/action-icons/detect-evil-and-good.png` | icons-04 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `detect-magic` | `ui/action-icons/detect-magic.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `burning-hands` | `ui/action-icons/burning-hands.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `faerie-fire` | `ui/action-icons/faerie-fire.png` | icons-04 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `identify` | `ui/action-icons/identify.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `entangle` | `ui/action-icons/entangle.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `ensnaring-strike` | `ui/action-icons/ensnaring-strike.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `charm-person` | `ui/action-icons/charm-person.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `purify-food-and-drink` | `ui/action-icons/purify-food-and-drink.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `feather-fall` | `ui/action-icons/feather-fall.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `searing-smite` | `ui/action-icons/searing-smite.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `absorb-elements` | `ui/action-icons/absorb-elements.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `find-familiar` | `ui/action-icons/find-familiar.png` | icons-04 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `comprehend-languages` | `ui/action-icons/comprehend-languages.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `bane` | `ui/action-icons/bane.png` | icons-04 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `expeditious-retreat` | `ui/action-icons/expeditious-retreat.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `command` | `ui/action-icons/command.png` | icons-04 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `jump` | `ui/action-icons/jump.png` | icons-04 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `false-life` | `ui/action-icons/false-life.png` | icons-05 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `speak-with-animals` | `ui/action-icons/speak-with-animals.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `arms-of-hadar` | `ui/action-icons/arms-of-hadar.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `color-spray` | `ui/action-icons/color-spray.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `hex` | `ui/action-icons/hex.png` | icons-05 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `alarm` | `ui/action-icons/alarm.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `snare` | `ui/action-icons/snare.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `grease` | `ui/action-icons/grease.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `longstrider` | `ui/action-icons/longstrider.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `chaos-bolt` | `ui/action-icons/chaos-bolt.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `create-or-destroy-water` | `ui/action-icons/create-or-destroy-water.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `tenser-s-floating-disk` | `ui/action-icons/tenser-s-floating-disk.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `fog-cloud` | `ui/action-icons/fog-cloud.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `sanctuary` | `ui/action-icons/sanctuary.png` | icons-05 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `zephyr-strike` | `ui/action-icons/zephyr-strike.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `sleep` | `ui/action-icons/sleep.png` | icons-05 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `chromatic-orb` | `ui/action-icons/chromatic-orb.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `ceremony` | `ui/action-icons/ceremony.png` | icons-05 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `goodberry` | `ui/action-icons/goodberry.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `shield` | `ui/action-icons/shield.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `shield-of-faith` | `ui/action-icons/shield-of-faith.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `pass-without-trace` | `ui/action-icons/pass-without-trace.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `spiritual-weapon` | `ui/action-icons/spiritual-weapon.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `continual-flame` | `ui/action-icons/continual-flame.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `see-invisibility` | `ui/action-icons/see-invisibility.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `vortex-warp` | `ui/action-icons/vortex-warp.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `suggestion` | `ui/action-icons/suggestion.png` | icons-05 (current-runtime-frame-review) | symbolic | Символическая подача; эффект узнаваем, постороннего предмета нет. |
| `air-bubble` | `ui/action-icons/air-bubble.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `magic-mouth` | `ui/action-icons/magic-mouth.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `arcane-lock` | `ui/action-icons/arcane-lock.png` | icons-05 (current-runtime-frame-review) | matched | Основной предмет/эффект читается и соответствует описанию; wrong-subject не найден. |
| `phantasmal-force` | `ui/action-icons/phantasmal-force.png` | root-current-image-review | matched | Root reviewed current replacement PNG; translucent purple-blue illusory threat/head replaces the generic void. Runtime SHA-256 e485213eb8a4c7cc6349395b4371de9d33c69715d4fbd8149fffe5f93d560c29, 150468 bytes; source SHA-256 d870b14f646feb2e27f48f4da5bd5f00c83e9ac1ef74f4bafbb1fce0122a8e61. |
| `augury` | `ui/action-icons/augury.png` | icons-06 (current-runtime-frame-review) | matched | Двухцветный символ гадания и предзнаменования. |
| `blindness-deafness` | `ui/action-icons/blindness-deafness.png` | icons-06 (current-runtime-frame-review) | matched | Око и ухо под повязкой прямо передают слепоту и глухоту. |
| `flame-blade` | `ui/action-icons/flame-blade.png` | icons-06 (current-runtime-frame-review) | matched | Изображён огненный клинок. |
| `shatter` | `ui/action-icons/shatter.png` | icons-06 (current-runtime-frame-review) | matched | Треснувший металлический предмет с ударной вспышкой передаёт разрушительный звук. |
| `barkskin` | `ui/action-icons/barkskin.png` | icons-06 (current-runtime-frame-review) | matched | Кора и листва соответствуют защитной коже из коры. |
| `dragon-s-breath` | `ui/action-icons/dragon-s-breath.png` | icons-06 (current-runtime-frame-review) | matched | Голова дракона выдыхает огонь. |
| `beast-sense` | `ui/action-icons/beast-sense.png` | icons-06 (current-runtime-frame-review) | matched | Звериный глаз в амулете передаёт зрение и слух зверя. |
| `cordon-of-arrows` | `ui/action-icons/cordon-of-arrows.png` | icons-06 (current-runtime-frame-review) | matched | Четыре стрелы выставлены вокруг точки срабатывания. |
| `borrowed-knowledge` | `ui/action-icons/borrowed-knowledge.png` | icons-06 (current-runtime-frame-review) | matched | Закрытая магическая книга соответствует заимствованному знанию. |
| `protection-from-poison` | `ui/action-icons/protection-from-poison.png` | icons-06 (current-runtime-frame-review) | matched | Флакон с запрещённым черепом читается как защита от яда. |
| `warding-wind` | `ui/action-icons/warding-wind.png` | icons-06 (current-runtime-frame-review) | matched | Вихрь обвивает защищённый металлический центр. |
| `maximilian-s-earthen-grasp` | `ui/action-icons/maximilian-s-earthen-grasp.png` | icons-06 (current-runtime-frame-review) | matched | Каменная рука поднимается из земли. |
| `healing-spirit` | `ui/action-icons/healing-spirit.png` | icons-06 (current-runtime-frame-review) | matched | Светящийся дух исцеления показан над природным сосудом. |
| `branding-smite` | `ui/action-icons/branding-smite.png` | icons-06 (current-runtime-frame-review) | matched | Огненный клинок передаёт клеймящий удар оружием. |
| `crown-of-madness` | `ui/action-icons/crown-of-madness.png` | icons-06 (current-runtime-frame-review) | matched | Корона с глазом и рваными лентами передаёт безумие. |
| `levitate` | `ui/action-icons/levitate.png` | icons-06 (current-runtime-frame-review) | matched | Предмет явно зависает над восходящей магической спиралью. |
| `moonbeam` | `ui/action-icons/moonbeam.png` | icons-06 (current-runtime-frame-review) | matched | Лунный серп стоит над вертикальным серебристо-синим лучом. |
| `ray-of-enfeeblement` | `ui/action-icons/ray-of-enfeeblement.png` | root-current-image-review | matched | Root reviewed current replacement PNG; violet ray terminates at one empty weakened hand. Runtime SHA-256 7f2d83c3acf0d162c11a1313532a3d1edab67824eb4f48048dabf4598188b3e7, 42654 bytes; source SHA-256 bf91a48d935289095d33c7aef65e62cec10388226f8e0070ec23a393d9ca068a. |
| `magic-weapon` | `ui/action-icons/magic-weapon.png` | icons-06 (current-runtime-frame-review) | matched | Показан зачарованный светящийся меч. |
| `lesser-restoration` | `ui/action-icons/lesser-restoration.png` | icons-07 (current-runtime-frame-review) | matched | Светящийся флакон читается как восстановительное заклинание. |
| `melf-s-acid-arrow` | `ui/action-icons/melf-s-acid-arrow.png` | icons-07 (current-runtime-frame-review) | matched | Изображена ярко-зелёная капающая кислотная стрела. |
| `prayer-of-healing` | `ui/action-icons/prayer-of-healing.png` | icons-07 (current-runtime-frame-review) | matched | Сердце и молитвенные бусы передают групповое исцеление. |
| `nathair-s-mischief` | `ui/action-icons/nathair-s-mischief.png` | icons-07 (current-runtime-frame-review) | matched | Шутовской колпак в волшебном облаке соответствует озорству фей. |
| `skywrite` | `ui/action-icons/skywrite.png` | root-current-image-review | matched | Root reviewed current replacement PNG; cloud ribbon has deliberate glyph-like writing strokes and no horn. Runtime SHA-256 124f2de851625617901d1b8bbe77e51fd1b0095a8db4ab449efb1a01db421f10, 50071 bytes; source SHA-256 2ab85b34c8b88a3005d42b82983f6f9e7d4d4befe9361cb7a18be5218d0a88e6. |
| `invisibility` | `ui/action-icons/invisibility.png` | icons-07 (current-runtime-frame-review) | matched | Пустой капюшон передаёт невидимую фигуру. |
| `gentle-repose` | `ui/action-icons/gentle-repose.png` | root-current-image-review | matched | Root reviewed current replacement PNG; shrouded preserved body and ward coins read as gentle repose. Runtime SHA-256 6b9899c10df43c486f725f20fb74d24c3ae34257ebfde5cd06dc2bf52702acf8, 77879 bytes; source SHA-256 148D1681670BC5E8FF0F198844F787A7EA310E623BC03CA1D26DD39ACE7422EE. |
| `nystul-s-magic-aura` | `ui/action-icons/nystul-s-magic-aura.png` | icons-07 (current-runtime-frame-review) | matched | Предмет окружён разноцветной магической аурой. |
| `cloud-of-daggers` | `ui/action-icons/cloud-of-daggers.png` | icons-07 (current-runtime-frame-review) | matched | В тёмном облаке видны многочисленные кинжалы. |
| `zone-of-truth` | `ui/action-icons/zone-of-truth.png` | icons-07 (current-runtime-frame-review) | matched | Око в золотой печати передаёт область истины. |
| `detect-thoughts` | `ui/action-icons/detect-thoughts.png` | icons-07 (current-runtime-frame-review) | matched | Профиль головы окружён фиолетовым ментальным полем. |
| `knock` | `ui/action-icons/knock.png` | icons-07 (current-runtime-frame-review) | matched | Открытый замок и ударная вспышка соответствуют открыванию. |
| `mirror-image` | `ui/action-icons/mirror-image.png` | icons-07 (current-runtime-frame-review) | matched | Три призрачных двойника показаны в зеркале. |
| `warding-bond` | `ui/action-icons/warding-bond.png` | icons-07 (current-runtime-frame-review) | matched | Переплетённые кольца и золотая связь соответствуют охраняющей связи. |
| `scorching-ray` | `ui/action-icons/scorching-ray.png` | icons-07 (current-runtime-frame-review) | matched | Из одного жезла выходят три огненных луча. |
| `spider-climb` | `ui/action-icons/spider-climb.png` | icons-07 (current-runtime-frame-review) | matched | Ботинок цепляется за шипастую вертикальную стену. |
| `web` | `ui/action-icons/web.png` | icons-07 (current-runtime-frame-review) | matched | Предмет полностью опутан паутиной. |
| `aganazzar-s-scorcher` | `ui/action-icons/aganazzar-s-scorcher.png` | icons-07 (current-runtime-frame-review) | matched | Драконья голова выпускает прямую полосу огня. |
| `pyrotechnics` | `ui/action-icons/pyrotechnics.png` | icons-07 (current-runtime-frame-review) | matched | Пусковая трубка и яркая вспышка обозначают фейерверк. |
| `gift-of-gab` | `ui/action-icons/gift-of-gab.png` | icons-07 (current-runtime-frame-review) | matched | Губы и рот прямо обозначают дар речи. |
| `aid` | `ui/action-icons/aid.png` | icons-07 (current-runtime-frame-review) | matched | Свиток со щитом и ладонью передаёт поддержку и защиту. |
| `locate-animals-or-plants` | `ui/action-icons/locate-animals-or-plants.png` | icons-07 (current-runtime-frame-review) | matched | След зверя и лист обозначают поиск животных или растений. |
| `find-traps` | `ui/action-icons/find-traps.png` | icons-07 (current-runtime-frame-review) | matched | Открытый медвежий капкан прямо показывает ловушку. |
| `locate-object` | `ui/action-icons/locate-object.png` | icons-07 (current-runtime-frame-review) | matched | Ключ представлен как искомый предмет. |
| `find-steed` | `ui/action-icons/find-steed.png` | icons-07 (current-runtime-frame-review) | matched | Голова лошади соответствует поиску ездового животного. |
| `gust-of-wind` | `ui/action-icons/gust-of-wind.png` | icons-07 (current-runtime-frame-review) | matched | Поток ветра выходит из духового инструмента. |
| `animal-messenger` | `ui/action-icons/animal-messenger.png` | icons-07 (current-runtime-frame-review) | matched | Птица-курьер несёт послание. |
| `summon-beast` | `ui/action-icons/summon-beast.png` | icons-07 (current-runtime-frame-review) | matched | Большой звериный след обозначает призыв зверя. |
| `mind-spike` | `ui/action-icons/mind-spike.png` | icons-07 (current-runtime-frame-review) | matched | Психический шип в профиле головы передаёт ментальную атаку. |
| `tasha-s-mind-whip` | `ui/action-icons/tasha-s-mind-whip.png` | icons-07 (current-runtime-frame-review) | matched | Кнут соединён с мозгом и прямо передаёт ментальный хлыст. |
| `flaming-sphere` | `ui/action-icons/flaming-sphere.png` | icons-08 (current-runtime-frame-review) | matched | Огненная сфера находится в магической чаше. |
| `dust-devil` | `ui/action-icons/dust-devil.png` | icons-08 (current-runtime-frame-review) | matched | Пыльный вихрь с камнями соответствует вихрю земли. |
| `spray-of-cards` | `ui/action-icons/spray-of-cards.png` | icons-08 (current-runtime-frame-review) | matched | Из чехла вылетают карты. |
| `blur` | `ui/action-icons/blur.png` | icons-08 (current-runtime-frame-review) | matched | Силуэт скрыт за закрученной полупрозрачной полосой. |
| `heat-metal` | `ui/action-icons/heat-metal.png` | icons-08 (current-runtime-frame-review) | matched | Металлическая перчатка раскалена по швам. |
| `enthrall` | `ui/action-icons/enthrall.png` | icons-08 (current-runtime-frame-review) | matched | Арфа с фиолетовыми струнами передаёт завлечение. |
| `jims-glowing-coin` | `ui/action-icons/jims-glowing-coin.png` | icons-08 (current-runtime-frame-review) | matched | Монета светится над постаментом. |
| `rime-s-binding-ice` | `ui/action-icons/rime-s-binding-ice.png` | icons-08 (current-runtime-frame-review) | matched | Лёд с цепью в центре прямо передаёт связывающий мороз. |
| `alter-self` | `ui/action-icons/alter-self.png` | icons-08 (current-runtime-frame-review) | matched | Меняющаяся рука со звериной чешуёй передаёт смену облика. |
| `snilloc-s-snowball-swarm` | `ui/action-icons/snilloc-s-snowball-swarm.png` | icons-08 (current-runtime-frame-review) | matched | Мешок наполнен снежными шарами и окружён холодным вихрем. |
| `flock-of-familiars` | `ui/action-icons/flock-of-familiars.png` | icons-08 (current-runtime-frame-review) | matched | Несколько птиц вылетают из магического флакона. |
| `darkvision` | `ui/action-icons/darkvision.png` | icons-08 (current-runtime-frame-review) | matched | Большой светящийся глаз прямо обозначает ночное зрение. |
| `shadow-blade` | `ui/action-icons/shadow-blade.png` | icons-08 (current-runtime-frame-review) | matched | Показан фиолетовый клинок из тени. |
| `silence` | `ui/action-icons/silence.png` | icons-08 (current-runtime-frame-review) | matched | Колокол запечатан в синей беззвучной сфере. |
| `rope-trick` | `ui/action-icons/rope-trick.png` | icons-08 (current-runtime-frame-review) | matched | Верёвка ведёт в маленький тёмный проход. |
| `misty-step` | `ui/action-icons/misty-step.png` | icons-08 (current-runtime-frame-review) | matched | Ботинок окружён фиолетовым туманом перемещения. |
| `darkness` | `ui/action-icons/darkness.png` | icons-08 (current-runtime-frame-review) | matched | Фонарь наполнен тёмным фиолетовым пламенем. |
| `enlarge-reduce` | `ui/action-icons/enlarge-reduce.png` | icons-08 (current-runtime-frame-review) | matched | Большой и маленький предмет соединены стрелками изменения размера. |
| `kinetic-jaunt` | `ui/action-icons/kinetic-jaunt.png` | icons-08 (current-runtime-frame-review) | matched | Ботинок оставляет фиолетовые кольца движения. |
| `wither-and-bloom` | `ui/action-icons/wither-and-bloom.png` | icons-08 (current-runtime-frame-review) | matched | Одна ветвь увядает, другая цветёт голубым светом. |
| `hold-person` | `ui/action-icons/hold-person.png` | icons-09 (current-runtime-frame-review) | matched | Связанная человеческая рука передаёт удержание существа. |
| `earthbind` | `ui/action-icons/earthbind.png` | icons-09 (current-runtime-frame-review) | matched | Крыло приковано к камню цепями. |
| `enhance-ability` | `ui/action-icons/enhance-ability.png` | icons-09 (current-runtime-frame-review) | matched | Рука держит сияющий усиленный кристалл. |
| `calm-emotions` | `ui/action-icons/calm-emotions.png` | icons-09 (current-runtime-frame-review) | matched | Курильница выпускает ровный спокойный дым. |
| `warp-sense` | `ui/action-icons/warp-sense.png` | icons-09 (current-runtime-frame-review) | matched | Профиль головы искажён завихрением чувств. |
| `spike-growth` | `ui/action-icons/spike-growth.png` | icons-09 (current-runtime-frame-review) | matched | Из земли растут колючие шипастые стебли. |
| `aura-of-vitality` | `ui/action-icons/aura-of-vitality.png` | icons-09 (current-runtime-frame-review) | matched | Сердце окружено яркой золотой аурой жизни. |
| `ashardalon-s-stride` | `ui/action-icons/ashardalon-s-stride.png` | icons-09 (current-runtime-frame-review) | matched | Огненный сапог передаёт пылающий шаг. |
| `fast-friends` | `ui/action-icons/fast-friends.png` | icons-09 (current-runtime-frame-review) | matched | Два кольца связаны красной лентой дружбы. |
| `wall-of-water` | `ui/action-icons/wall-of-water.png` | icons-09 (current-runtime-frame-review) | matched | В каменной арке видна сплошная водяная стена. |
| `revivify` | `ui/action-icons/revivify.png` | icons-09 (current-runtime-frame-review) | matched | Огненное перо с драгоценным центром передаёт возвращение жизни. |
| `animate-dead` | `ui/action-icons/animate-dead.png` | icons-09 (current-runtime-frame-review) | matched | Пылающий череп и кости обозначают оживление мёртвых. |
| `antagonize` | `ui/action-icons/antagonize.png` | icons-09 (current-runtime-frame-review) | matched | Бронированный кулак пронзён красной стрелой враждебности. |
| `gaseous-form` | `ui/action-icons/gaseous-form.png` | icons-09 (current-runtime-frame-review) | matched | Дым поднимается из сосуда и заменяет твёрдое тело. |
| `galder-s-tower` | `ui/action-icons/galder-s-tower.png` | icons-09 (current-runtime-frame-review) | matched | Каменная башня показана целиком. |
| `hypnotic-pattern` | `ui/action-icons/hypnotic-pattern.png` | icons-09 (current-runtime-frame-review) | matched | Мерцающий фиолетовый узор передаёт гипноз. |
| `hunger-of-hadar` | `ui/action-icons/hunger-of-hadar.png` | icons-09 (current-runtime-frame-review) | matched | Чёрная чаша заполнена межзвёздным фиолетовым вихрем. |
| `thunder-step` | `ui/action-icons/thunder-step.png` | icons-09 (current-runtime-frame-review) | matched | Сапог делает шаг через расколотую громом землю. |
| `daylight` | `ui/action-icons/daylight.png` | icons-09 (current-runtime-frame-review) | matched | Яркое солнечное светило передаёт дневной свет. |
| `catnap` | `ui/action-icons/catnap.png` | icons-09 (current-runtime-frame-review) | matched | Спящая кошка на подушке прямо обозначает короткий сон. |
| `spirit-guardians` | `ui/action-icons/spirit-guardians.png` | icons-09 (current-runtime-frame-review) | matched | В фонаре видны несколько светящихся духов. |
| `slow` | `ui/action-icons/slow.png` | icons-09 (current-runtime-frame-review) | matched | Песочные часы скованы тяжёлыми цепями. |
| `protection-from-energy` | `ui/action-icons/protection-from-energy.png` | icons-09 (current-runtime-frame-review) | matched | Щит отмечен несколькими разноцветными стихиями. |
| `stinking-cloud` | `ui/action-icons/stinking-cloud.png` | icons-09 (current-runtime-frame-review) | matched | Из сосуда выходит густое зеленоватое облако газа. |
| `erupting-earth` | `ui/action-icons/erupting-earth.png` | icons-09 (current-runtime-frame-review) | matched | Земной шар расколот горячей трещиной и камнями. |
| `enemies-abound` | `ui/action-icons/enemies-abound.png` | icons-09 (current-runtime-frame-review) | matched | Рог окружён стрелками, направленными друг против друга. |
| `counterspell` | `ui/action-icons/counterspell.png` | icons-09 (current-runtime-frame-review) | matched | Сломанная синяя магическая сфера передаёт остановленное заклинание. |
| `intellect-fortress` | `ui/action-icons/intellect-fortress.png` | icons-09 (current-runtime-frame-review) | matched | Крепостная башня с кристаллом обозначает защиту разума. |
| `tiny-servant` | `ui/action-icons/tiny-servant.png` | icons-09 (current-runtime-frame-review) | matched | Маленький предмет превращён в живой чайник-слугу. |
| `leomund-s-tiny-hut` | `ui/action-icons/leomund-s-tiny-hut.png` | icons-09 (current-runtime-frame-review) | matched | Небольшая хижина защищена прозрачным куполом. |
| `magic-circle` | `ui/action-icons/magic-circle.png` | icons-10 (current-runtime-frame-review) | matched | Замкнутый светящийся круг прямо обозначает магический круг. |
| `crusader-s-mantle` | `ui/action-icons/crusader-s-mantle.png` | icons-10 (current-runtime-frame-review) | matched | Красная мантия с солнечным знаком передаёт ауру крестоносца. |
| `beacon-of-hope` | `ui/action-icons/beacon-of-hope.png` | icons-10 (current-runtime-frame-review) | matched | Фонарь с устойчивым светом читается как маяк надежды. |
| `melf-s-minute-meteors` | `ui/action-icons/melf-s-minute-meteors.png` | icons-10 (current-runtime-frame-review) | matched | Пять раскалённых метеоров образуют кольцо вокруг точки. |
| `blink` | `ui/action-icons/blink.png` | icons-10 (current-runtime-frame-review) | matched | Сапог проходит через фиолетовый портал. |
| `sleet-storm` | `ui/action-icons/sleet-storm.png` | icons-10 (current-runtime-frame-review) | matched | В сосуде видна снежная буря. |
| `mass-healing-word` | `ui/action-icons/mass-healing-word.png` | icons-10 (current-runtime-frame-review) | matched | Три сердца соединены одной линией исцеления. |
| `lightning-arrow` | `ui/action-icons/lightning-arrow.png` | icons-10 (current-runtime-frame-review) | matched | Стрела окружена электрическими разрядами. |
| `lightning-bolt` | `ui/action-icons/lightning-bolt.png` | icons-10 (current-runtime-frame-review) | matched | Молния показана на отдельном знаке. |
| `motivational-speech` | `ui/action-icons/motivational-speech.png` | icons-10 (current-runtime-frame-review) | matched | Мегафон с красным знаменем обозначает обращённую речь. |
| `nondetection` | `ui/action-icons/nondetection.png` | icons-10 (current-runtime-frame-review) | matched | Тёмный камень скрыт от взгляда фиолетовой оболочкой. |
| `major-image` | `ui/action-icons/major-image.png` | icons-10 (current-runtime-frame-review) | matched | Призрачный светящийся шлем передаёт крупный иллюзорный образ. |
| `fireball` | `ui/action-icons/fireball.png` | icons-10 (current-runtime-frame-review) | matched | Большой огненный шар показан напрямую. |
| `blinding-smite` | `ui/action-icons/blinding-smite.png` | icons-10 (current-runtime-frame-review) | matched | Булава окружена яркой ослепляющей вспышкой. |
| `glyph-of-warding` | `ui/action-icons/glyph-of-warding.png` | icons-10 (current-runtime-frame-review) | matched | Запертая руна с магическим глазом соответствует охранному глифу. |
| `life-transference` | `ui/action-icons/life-transference.png` | icons-10 (current-runtime-frame-review) | matched | Энергия вытягивается из сердца наружу к другой цели. |
| `wall-of-sand` | `ui/action-icons/wall-of-sand.png` | icons-10 (current-runtime-frame-review) | matched | Арка заполнена плотной стеной песка. |
| `water-breathing` | `ui/action-icons/water-breathing.png` | icons-10 (current-runtime-frame-review) | matched | Водяная капля помещена между символами воздуха/дыхания. |
| `clairvoyance` | `ui/action-icons/clairvoyance.png` | icons-10 (current-runtime-frame-review) | matched | Магический сенсорный шар окружён завитками видения. |
| `spirit-shroud` | `ui/action-icons/spirit-shroud.png` | icons-10 (current-runtime-frame-review) | matched | Тёмная фигура окружена летающими духами. |
| `fly` | `ui/action-icons/fly.png` | icons-11 (current-runtime-frame-review) | matched | Крылатый сапог прямо передаёт полёт. |
| `sending` | `ui/action-icons/sending.png` | icons-11 (current-runtime-frame-review) | matched | Рог и ухо, соединённые магической лентой, читаются как передача сообщения. |
| `phantom-steed` | `ui/action-icons/phantom-steed.png` | icons-11 (current-runtime-frame-review) | matched | Изображена спектральная лошадь. |
| `summon-undead` | `ui/action-icons/summon-undead.png` | icons-11 (current-runtime-frame-review) | matched | Скелетоподобный дух заключён в тёмный призывающий сосуд. |
| `summon-shadowspawn` | `ui/action-icons/summon-shadowspawn.png` | icons-11 (current-runtime-frame-review) | matched | Чёрный сосуд наполнен фиолетовыми тенями. |
| `summon-fey` | `ui/action-icons/summon-fey.png` | icons-11 (current-runtime-frame-review) | matched | Светлый фейский дух и растительный мотив внутри фонаря. |
| `conjure-animals` | `ui/action-icons/conjure-animals.png` | icons-11 (current-runtime-frame-review) | matched | В одном знаке собраны несколько звериных форм. |
| `conjure-barrage` | `ui/action-icons/conjure-barrage.png` | icons-11 (current-runtime-frame-review) | matched | Веер брошенных копий передаёт шквал снарядов. |
| `call-lightning` | `ui/action-icons/call-lightning.png` | icons-11 (current-runtime-frame-review) | matched | Молния бьёт из грозового облака в жезл. |
| `summon-lesser-demons` | `ui/action-icons/summon-lesser-demons.png` | icons-11 (current-runtime-frame-review) | matched | Из жаровни поднимаются несколько демонических силуэтов. |
| `vampiric-touch` | `ui/action-icons/vampiric-touch.png` | icons-11 (current-runtime-frame-review) | matched | Рука удерживает кровавую сферу, передавая вампирическое прикосновение. |
| `tidal-wave` | `ui/action-icons/tidal-wave.png` | icons-11 (current-runtime-frame-review) | matched | Большая водяная волна с трезубцем. |
| `feign-death` | `ui/action-icons/feign-death.png` | icons-11 (current-runtime-frame-review) | matched | Закрытая маска на подушке читается как каталептическая смерть. |
| `bestow-curse` | `ui/action-icons/bestow-curse.png` | icons-11 (current-runtime-frame-review) | matched | Пронзённая корона окружена фиолетовой энергией проклятия. |
| `flame-arrows` | `ui/action-icons/flame-arrows.png` | icons-11 (current-runtime-frame-review) | matched | Показаны пылающие стрелы. |
| `speak-with-dead` | `ui/action-icons/speak-with-dead.png` | icons-11 (current-runtime-frame-review) | matched | Череп выпускает голубой дух/голос. |
| `speak-with-plants` | `ui/action-icons/speak-with-plants.png` | icons-11 (current-runtime-frame-review) | matched | Растение совмещено с рогом, то есть разговором. |
| `dispel-magic` | `ui/action-icons/dispel-magic.png` | icons-11 (current-runtime-frame-review) | matched | Рука рассеивает магический вихрь. |
| `plant-growth` | `ui/action-icons/plant-growth.png` | icons-11 (current-runtime-frame-review) | matched | Молодое растение показано вместе с корнями. |
| `meld-into-stone` | `ui/action-icons/meld-into-stone.png` | icons-11 (current-runtime-frame-review) | matched | Ладонь встроена в каменную плиту. |
| `remove-curse` | `ui/action-icons/remove-curse.png` | icons-11 (current-runtime-frame-review) | matched | Разомкнутый ошейник с энергией снятия эффекта. |
| `create-food-and-water` | `ui/action-icons/create-food-and-water.png` | icons-11 (current-runtime-frame-review) | matched | Видны сосуд с водой и еда. |
| `incite-greed` | `ui/action-icons/incite-greed.png` | icons-11 (current-runtime-frame-review) | matched | Корона, самоцвет и золотые кольца передают жадность к золоту. |
| `wind-wall` | `ui/action-icons/wind-wall.png` | icons-11 (current-runtime-frame-review) | matched | Каменная панель окружена заметным завихрением ветра. |
| `elemental-weapon` | `ui/action-icons/elemental-weapon.png` | icons-11 (current-runtime-frame-review) | matched | Меч имеет разноцветное стихийное лезвие. |
| `fear` | `ui/action-icons/fear.png` | icons-11 (current-runtime-frame-review) | matched | Рогатая демоническая маска передаёт ужас. |
| `haste` | `ui/action-icons/haste.png` | icons-11 (current-runtime-frame-review) | matched | Крылатый сапог передаёт ускорение. |
| `water-walk` | `ui/action-icons/water-walk.png` | icons-11 (current-runtime-frame-review) | matched | Сапог стоит на поверхности воды. |
| `tongues` | `ui/action-icons/tongues.png` | icons-11 (current-runtime-frame-review) | matched | Магический медальон со звуковой спиралью символизирует универсальную речь. |
| `aura-of-life` | `ui/action-icons/aura-of-life.png` | icons-11 (current-runtime-frame-review) | matched | Светящийся зелёный кристалл в защитном фонаре передаёт ауру жизни. |
| `aura-of-purity` | `ui/action-icons/aura-of-purity.png` | icons-12 (current-runtime-frame-review) | matched | Голубой кристалл в светящемся защитном фонаре передаёт очищающую ауру. |
| `sickening-radiance` | `ui/action-icons/sickening-radiance.png` | icons-12 (current-runtime-frame-review) | matched | Ядовито-зелёное сияние показано внутри светильника. |
| `galder-s-speedy-courier` | `ui/action-icons/galder-s-speedy-courier.png` | icons-12 (current-runtime-frame-review) | matched | Летающая сумка с голубым следом передаёт быструю доставку. |
| `mordenkainen-s-faithful-hound` | `ui/action-icons/mordenkainen-s-faithful-hound.png` | icons-12 (current-runtime-frame-review) | matched | Изображена верная призрачная собака. |
| `control-water` | `ui/action-icons/control-water.png` | icons-12 (current-runtime-frame-review) | matched | Водяное кольцо с трезубцем читается как управление водой. |
| `watery-sphere` | `ui/action-icons/watery-sphere.png` | icons-12 (current-runtime-frame-review) | matched | Показана самостоятельная водяная сфера. |
| `phantasmal-killer` | `ui/action-icons/phantasmal-killer.png` | icons-12 (current-runtime-frame-review) | matched | Череп в фиолетовой дымке передаёт кошмарный образ. |
| `greater-invisibility` | `ui/action-icons/greater-invisibility.png` | icons-12 (current-runtime-frame-review) | matched | Полупрозрачная скрытая фигура передаёт невидимость. |
| `giant-insect` | `ui/action-icons/giant-insect.png` | icons-12 (current-runtime-frame-review) | matched | Показано крупное насекомое. |
| `ice-storm` | `ui/action-icons/ice-storm.png` | icons-12 (current-runtime-frame-review) | matched | Облако роняет ледяные градины. |
| `spirit-of-death` | `ui/action-icons/spirit-of-death.png` | icons-12 (current-runtime-frame-review) | matched | Изображён дух смерти с косой. |
| `vitriolic-sphere` | `ui/action-icons/vitriolic-sphere.png` | icons-12 (current-runtime-frame-review) | matched | Кислотно-зелёная жидкость показана в округлом сосуде. |
| `gate-seal` | `ui/action-icons/gate-seal.png` | icons-12 (current-runtime-frame-review) | matched | Закрытые ворота с печатью передают запечатывание прохода. |
| `death-ward` | `ui/action-icons/death-ward.png` | icons-12 (current-runtime-frame-review) | matched | Щит прямо обозначает защиту от смерти. |
| `banishment` | `ui/action-icons/banishment.png` | icons-12 (current-runtime-frame-review) | matched | Фиолетовый портал передаёт изгнание. |
| `fabricate` | `ui/action-icons/fabricate.png` | icons-12 (current-runtime-frame-review) | matched | Молот и шестерня передают изготовление предмета. |
| `stone-shape` | `ui/action-icons/stone-shape.png` | icons-12 (current-runtime-frame-review) | matched | Рука сформирована внутри камня. |
| `mordenkainen-s-private-sanctum` | `ui/action-icons/mordenkainen-s-private-sanctum.png` | icons-12 (current-runtime-frame-review) | matched | Защищённая башня под куполом передаёт частное святилище. |
| `stoneskin` | `ui/action-icons/stoneskin.png` | icons-12 (current-runtime-frame-review) | matched | Щит с каменной поверхностью передаёт каменную кожу. |
| `leomund-s-secret-chest` | `ui/action-icons/leomund-s-secret-chest.png` | icons-12 (current-runtime-frame-review) | matched | Сундук скрыт внутри фиолетовой магической сферы. |
| `arcane-eye` | `ui/action-icons/arcane-eye.png` | icons-13 (current-runtime-frame-review) | matched | Магический глаз изображён на амулете. |
| `hallucinatory-terrain` | `ui/action-icons/hallucinatory-terrain.png` | icons-13 (current-runtime-frame-review) | matched | Пейзаж заключён в фиолетовую иллюзорную сферу. |
| `shadow-of-moil` | `ui/action-icons/shadow-of-moil.png` | icons-13 (current-runtime-frame-review) | matched | Череп окружён плотной тенью. |
| `staggering-smite` | `ui/action-icons/staggering-smite.png` | icons-13 (current-runtime-frame-review) | matched | Молот окружён фиолетовой ударной энергией. |
| `wall-of-fire` | `ui/action-icons/wall-of-fire.png` | icons-13 (current-runtime-frame-review) | matched | Непрерывная линия пламени читается как стена. |
| `fire-shield` | `ui/action-icons/fire-shield.png` | icons-13 (current-runtime-frame-review) | matched | Щит окружён огнём. |
| `otiluke-s-resilient-sphere` | `ui/action-icons/otiluke-s-resilient-sphere.png` | icons-13 (current-runtime-frame-review) | matched | Существо явно заключено в непроницаемую сферу. |
| `charm-monster` | `ui/action-icons/charm-monster.png` | icons-13 (current-runtime-frame-review) | matched | Сердце и лента-ошейник передают очарование. |
| `dimension-door` | `ui/action-icons/dimension-door.png` | icons-13 (current-runtime-frame-review) | matched | Приоткрытая дверь ведёт в магический портал. |
| `dominate-beast` | `ui/action-icons/dominate-beast.png` | icons-13 (current-runtime-frame-review) | matched | Рогатый знак с центральным самоцветом передаёт подчинение зверя. |
| `find-greater-steed` | `ui/action-icons/find-greater-steed.png` | icons-13 (current-runtime-frame-review) | matched | Изображён могущественный спектральный скакун. |
| `locate-creature` | `ui/action-icons/locate-creature.png` | icons-13 (current-runtime-frame-review) | matched | Силуэт существа помещён в поисковый медальон. |
| `polymorph` | `ui/action-icons/polymorph.png` | icons-13 (current-runtime-frame-review) | matched | Половины человеческого и звериного лица передают превращение. |
| `divination` | `ui/action-icons/divination.png` | icons-13 (current-runtime-frame-review) | matched | Хрустальный шар/камень передаёт гадание. |
| `summon-greater-demon` | `ui/action-icons/summon-greater-demon.png` | icons-13 (current-runtime-frame-review) | matched | Изображён крупный вооружённый демон на призывающем круге. |
| `summon-aberration` | `ui/action-icons/summon-aberration.png` | icons-13 (current-runtime-frame-review) | matched | Бесформенная синяя сущность заключена в призывающий сосуд. |
| `summon-construct` | `ui/action-icons/summon-construct.png` | icons-13 (current-runtime-frame-review) | matched | Показан управляемый каменный/металлический голем. |
| `summon-elemental` | `ui/action-icons/summon-elemental.png` | icons-13 (current-runtime-frame-review) | matched | В чаше собраны огонь, вода и воздух как стихийный дух. |
| `conjure-woodland-beings` | `ui/action-icons/conjure-woodland-beings.png` | icons-13 (current-runtime-frame-review) | matched | Дерево в горшке передаёт призыв лесных обитателей. |
| `conjure-minor-elementals` | `ui/action-icons/conjure-minor-elementals.png` | icons-13 (current-runtime-frame-review) | matched | Несколько разноцветных стихийных пламен передают малых элементалей. |
| `compulsion` | `ui/action-icons/compulsion.png` | icons-13 (current-runtime-frame-review) | matched | Связанный кольцами клинок читается как принуждение. |
| `elemental-bane` | `ui/action-icons/elemental-bane.png` | icons-13 (current-runtime-frame-review) | matched | Три стихийных кристалла передают проклятие, связанное с типом урона. |
| `raulothim-s-psychic-lance` | `ui/action-icons/raulothim-s-psychic-lance.png` | icons-13 (current-runtime-frame-review) | matched | Показано яркое фиолетовое психическое копьё. |
| `freedom-of-movement` | `ui/action-icons/freedom-of-movement.png` | icons-13 (current-runtime-frame-review) | matched | Сапог разрывает цепи. |
| `confusion` | `ui/action-icons/confusion.png` | icons-13 (current-runtime-frame-review) | matched | Компас с разошедшимися стрелками передаёт потерю ориентации. |
| `guardian-of-faith` | `ui/action-icons/guardian-of-faith.png` | icons-13 (current-runtime-frame-review) | matched | Светящийся щит с нимбом передаёт стража веры. |
| `guardian-of-nature` | `ui/action-icons/guardian-of-nature.png` | icons-13 (current-runtime-frame-review) | matched | Антлерный листовой облик передаёт природного стража. |
| `storm-sphere` | `ui/action-icons/storm-sphere.png` | icons-13 (current-runtime-frame-review) | matched | Гроза заключена в сферу. |
| `blight` | `ui/action-icons/blight.png` | icons-13 (current-runtime-frame-review) | matched | Показано увядающее больное растение. |
| `grasping-vine` | `ui/action-icons/grasping-vine.png` | icons-13 (current-runtime-frame-review) | matched | Вьющееся растение передаёт цепкую лозу. |
| `evard-s-black-tentacles` | `ui/action-icons/evard-s-black-tentacles.png` | icons-14 (current-runtime-frame-review) | matched | Показаны чёрные щупальца. |
| `swift-quiver` | `ui/action-icons/swift-quiver.png` | icons-14 (current-runtime-frame-review) | matched | Зачарованный колчан наполнен стрелами и окружён магическим кольцом. |
| `dream` | `ui/action-icons/dream.png` | icons-14 (current-runtime-frame-review) | matched | Закрытый глаз в синей дымке передаёт сон. |
| `control-winds` | `ui/action-icons/control-winds.png` | icons-14 (current-runtime-frame-review) | matched | Стрела и завихрения ветра передают управление направлением. |
| `maelstrom` | `ui/action-icons/maelstrom.png` | icons-14 (current-runtime-frame-review) | matched | Показан большой водоворот. |
| `greater-restoration` | `ui/action-icons/greater-restoration.png` | icons-14 (current-runtime-frame-review) | matched | Золотой сосуд с руками и сиянием передаёт восстановление. |
| `wrath-of-nature` | `ui/action-icons/wrath-of-nature.png` | icons-14 (current-runtime-frame-review) | matched | Корни и листья окружают огненное сердце природы. |
| `far-step` | `ui/action-icons/far-step.png` | icons-14 (current-runtime-frame-review) | matched | Сапог оставляет фиолетовый магический след. |
| `bigby-s-hand` | `ui/action-icons/bigby-s-hand.png` | icons-14 (current-runtime-frame-review) | matched | Изображена крупная призрачная рука. |
| `tree-stride` | `ui/action-icons/tree-stride.png` | icons-14 (current-runtime-frame-review) | matched | Сапог выходит из живого дерева. |
| `contagion` | `ui/action-icons/contagion.png` | icons-14 (current-runtime-frame-review) | matched | Тёмный сосуд с зелёной болезненной взвесью передаёт заражение. |
| `legend-lore` | `ui/action-icons/legend-lore.png` | icons-14 (current-runtime-frame-review) | matched | Магическая книга прямо передаёт знание легенд. |
| `banishing-smite` | `ui/action-icons/banishing-smite.png` | icons-14 (current-runtime-frame-review) | matched | Молот/оружие окружён энергией изгнания. |
| `modify-memory` | `ui/action-icons/modify-memory.png` | icons-14 (current-runtime-frame-review) | matched | Мозг внутри фиолетового магического сосуда передаёт изменение памяти. |
| `infernal-calling` | `ui/action-icons/infernal-calling.png` | icons-14 (current-runtime-frame-review) | matched | Книга с рогами, цепями и адским пламенем передаёт призыв исчадия. |
| `immolation` | `ui/action-icons/immolation.png` | icons-14 (current-runtime-frame-review) | matched | Фигура полностью охвачена пламенем. |
| `wall-of-stone` | `ui/action-icons/wall-of-stone.png` | icons-14 (current-runtime-frame-review) | matched | Кирпичная каменная стена показана напрямую. |
| `cone-of-cold` | `ui/action-icons/cone-of-cold.png` | icons-14 (current-runtime-frame-review) | matched | Ледяной поток выходит конусом из драконьей головы. |
| `circle-of-power` | `ui/action-icons/circle-of-power.png` | icons-14 (current-runtime-frame-review) | matched | Светящийся круг-руна передаёт ауру силы. |
| `teleportation-circle` | `ui/action-icons/teleportation-circle.png` | icons-14 (current-runtime-frame-review) | matched | Показан активный круг с вихревым порталом. |
| `rary-s-telepathic-bond` | `ui/action-icons/rary-s-telepathic-bond.png` | icons-15 (current-runtime-frame-review) | matched | Два светящихся профиля соединены одной телепатической дугой. |
| `mass-cure-wounds` | `ui/action-icons/mass-cure-wounds.png` | icons-15 (current-runtime-frame-review) | matched | Кольцо сердец ясно обозначает массовое исцеление. |
| `scrying` | `ui/action-icons/scrying.png` | icons-15 (current-runtime-frame-review) | matched | Синий сенсорный шар в вихре — наблюдение. |
| `insect-plague` | `ui/action-icons/insect-plague.png` | icons-15 (current-runtime-frame-review) | matched | Рой насекомых на зелёной сфере. |
| `flame-strike` | `ui/action-icons/flame-strike.png` | icons-15 (current-runtime-frame-review) | matched | Вертикальный столб огня. |
| `enervation` | `ui/action-icons/enervation.png` | icons-15 (current-runtime-frame-review) | matched | Череп тянет фиолетовый луч энергии. |
| `geas` | `ui/action-icons/geas.png` | icons-15 (current-runtime-frame-review) | matched | Скованный ошейник передаёт приказ и подчинение. |
| `cloudkill` | `ui/action-icons/cloudkill.png` | icons-15 (current-runtime-frame-review) | matched | Ядовитое облако с черепным лицом в колбе. |
| `commune` | `ui/action-icons/commune.png` | root-current-image-review | matched | Root reviewed current replacement PNG; solar holy symbol is an active divine contact. Runtime SHA-256 940cc0309d30b0e3bc2d87b9b4b9a7ef35eabf69f9e79beb76ab0835b8ab1430, 60256 bytes; source SHA-256 2D2749EBD12ED5F298FABED5BFD891C7C993634FAA2B11F3AEB74CC06B495547. |
| `commune-with-nature` | `ui/action-icons/commune-with-nature.png` | icons-15 (current-runtime-frame-review) | matched | Лист и капля воды обозначают природный ландшафт. |
| `raise-dead` | `ui/action-icons/raise-dead.png` | icons-15 (current-runtime-frame-review) | matched | Скелетная рука поднимается из земли. |
| `animate-objects` | `ui/action-icons/animate-objects.png` | icons-15 (current-runtime-frame-review) | matched | Связанные ожившие книга, ложка и ключ. |
| `planar-binding` | `ui/action-icons/planar-binding.png` | icons-15 (current-runtime-frame-review) | matched | Фиолетовая сущность заключена в цепи. |
| `danse-macabre` | `ui/action-icons/danse-macabre.png` | icons-15 (current-runtime-frame-review) | matched | Череп на механическом постаменте и фиолетовая петля. |
| `dominate-person` | `ui/action-icons/dominate-person.png` | icons-15 (current-runtime-frame-review) | matched | Лицо и руки под контролем фиолетовых щупалец. |
| `negative-energy-flood` | `ui/action-icons/negative-energy-flood.png` | icons-15 (current-runtime-frame-review) | matched | Фиолетовый поток отрицательной энергии из чаши. |
| `antilife-shell` | `ui/action-icons/antilife-shell.png` | icons-15 (current-runtime-frame-review) | matched | Колючая защитная оболочка со светящимся ядром. |
| `transmute-rock` | `ui/action-icons/transmute-rock.png` | icons-15 (current-runtime-frame-review) | matched | Разделённый камень переходит в другой материал. |
| `summon-draconic-spirit` | `ui/action-icons/summon-draconic-spirit.png` | icons-15 (current-runtime-frame-review) | matched | Силуэт драконьего духа из стихийного дыма. |
| `summon-celestial` | `ui/action-icons/summon-celestial.png` | icons-15 (current-runtime-frame-review) | matched | Крылатый золотой небожитель. |
| `conjure-volley` | `ui/action-icons/conjure-volley.png` | icons-15 (current-runtime-frame-review) | matched | Пучок стрел и снарядов накрывает область. |
| `conjure-elemental` | `ui/action-icons/conjure-elemental.png` | icons-15 (current-runtime-frame-review) | matched | Четыре стихии собраны в одном элементале. |
| `seeming` | `ui/action-icons/seeming.png` | icons-15 (current-runtime-frame-review) | matched | Разделённая театральная маска обозначает смену облика. |
| `awaken` | `ui/action-icons/awaken.png` | icons-15 (current-runtime-frame-review) | matched | Деревянная маска с листьями передаёт пробуждение природы. |
| `destructive-wave` | `ui/action-icons/destructive-wave.png` | icons-15 (current-runtime-frame-review) | matched | Сферическая ударная волна с электрическими разломами. |
| `dawn` | `ui/action-icons/dawn.png` | icons-15 (current-runtime-frame-review) | matched | Солнечный диск с лучом. |
| `dispel-evil-and-good` | `ui/action-icons/dispel-evil-and-good.png` | icons-15 (current-runtime-frame-review) | matched | Половины демона и ангела разгоняются светом щита. |
| `reincarnate` | `ui/action-icons/reincarnate.png` | icons-15 (current-runtime-frame-review) | matched | Закутанное семя/дерево в коконе — образ перерождения. |
| `contact-other-plane` | `ui/action-icons/contact-other-plane.png` | root-current-image-review | matched | Root reviewed current replacement PNG; head/ear, telepathic bridge and astral portal read as other-plane contact. Runtime SHA-256 d19db977ee968a604088201c47443aaba862377b0ee8d73eab6b7a6691cfc904, 65849 bytes; source SHA-256 D9D502BABEDD0B6D7170615781BFC2FB33B8CE2A623DBB7CC004256E4BBEE0C7. |
| `hallow` | `ui/action-icons/hallow.png` | icons-15 (current-runtime-frame-review) | matched | Освящённая кадильница/сосуд с церемониальными лентами. |
| `holy-weapon` | `ui/action-icons/holy-weapon.png` | icons-16 (current-runtime-frame-review) | matched | Сияющий меч. |
| `wall-of-force` | `ui/action-icons/wall-of-force.png` | icons-16 (current-runtime-frame-review) | matched | Прозрачная силовая панель между опорами. |
| `synaptic-static` | `ui/action-icons/synaptic-static.png` | icons-16 (current-runtime-frame-review) | matched | Мозг с фиолетовыми электрическими разрядами. |
| `passwall` | `ui/action-icons/passwall.png` | icons-16 (current-runtime-frame-review) | matched | Каменная арка с проходом. |
| `creation` | `ui/action-icons/creation.png` | root-current-image-review | matched | Root reviewed current replacement PNG; an ordinary object visibly forms from violet creation magic. Runtime SHA-256 b9c6982e3b425bc09e881f50be1738ea4cbf2b6c5efa52331b15336e59b04dd6, 59873 bytes; source SHA-256 58EAFC7928509666104E90D150145B1C2521807A9EE0809E82AC8AA693FF7489. |
| `creating-spelljamming-helm` | `ui/action-icons/creating-spelljamming-helm.png` | icons-16 (current-runtime-frame-review) | matched | Штурвал с орбитальным ядром. |
| `wall-of-light` | `ui/action-icons/wall-of-light.png` | icons-16 (current-runtime-frame-review) | matched | Прямоугольная стена яркого света. |
| `telekinesis` | `ui/action-icons/telekinesis.png` | icons-16 (current-runtime-frame-review) | matched | Камень поднят фиолетовой телекинетической спиралью. |
| `steel-wind-strike` | `ui/action-icons/steel-wind-strike.png` | icons-16 (current-runtime-frame-review) | matched | Вихрь стальных наконечников. |
| `hold-monster` | `ui/action-icons/hold-monster.png` | icons-16 (current-runtime-frame-review) | matched | Ладонь заперта в клетке. |
| `skill-empowerment` | `ui/action-icons/skill-empowerment.png` | icons-16 (current-runtime-frame-review) | matched | Компас с набором навыковых символов. |
| `mislead` | `ui/action-icons/mislead.png` | root-current-image-review | matched | Root reviewed current replacement PNG; two separate real/illusory silhouettes read as mislead. Runtime SHA-256 8a3fcf2830365aecea4142d0203d06b473351d40293fdb82121859435c82e81c, 95401 bytes; source SHA-256 e62635d28f71540cbf92f9f6049e463e407fabb919b7e26d81c0c9aedf48cc1d. |
| `magic-jar` | `ui/action-icons/magic-jar.png` | icons-16 (current-runtime-frame-review) | matched | Лицо и душа внутри сосуда. |
| `move-earth` | `ui/action-icons/move-earth.png` | icons-16 (current-runtime-frame-review) | matched | Камень вырывается из земли. |
| `drawmij-s-instant-summons` | `ui/action-icons/drawmij-s-instant-summons.png` | icons-16 (current-runtime-frame-review) | matched | Зачарованный мешок с золотыми рунами. |
| `programmed-illusion` | `ui/action-icons/programmed-illusion.png` | root-current-image-review | matched | Root reviewed current replacement PNG; projector, projected scene and trigger cue read as programmed illusion. Runtime SHA-256 3089af72233eb655bc6c6b935d2265b58889c0378b0b695a34e894abff3e502a, 69416 bytes; source SHA-256 4f3a522373f3f74eecf97254589b0a3548ecd5951df09f284a6c512c72d97f64. |
| `forbiddance` | `ui/action-icons/forbiddance.png` | icons-16 (current-runtime-frame-review) | matched | Запертая и заколоченная дверь передаёт запрет. |
| `true-seeing` | `ui/action-icons/true-seeing.png` | icons-16 (current-runtime-frame-review) | matched | Глаз с кристаллическим зрачком. |
| `soul-cage` | `ui/action-icons/soul-cage.png` | icons-16 (current-runtime-frame-review) | matched | Синее пламя души заключено в клетке. |
| `bones-of-the-earth` | `ui/action-icons/bones-of-the-earth.png` | icons-16 (current-runtime-frame-review) | matched | Каменный шар с костными выступами. |
| `circle-of-death` | `ui/action-icons/circle-of-death.png` | icons-17 (current-runtime-frame-review) | matched | Череп в кольце смерти. |
| `wall-of-ice` | `ui/action-icons/wall-of-ice.png` | icons-17 (current-runtime-frame-review) | matched | Высокая стена из льда. |
| `arcane-gate` | `ui/action-icons/arcane-gate.png` | icons-17 (current-runtime-frame-review) | matched | Открытые врата с порталом. |
| `mental-prison` | `ui/action-icons/mental-prison.png` | icons-17 (current-runtime-frame-review) | matched | Голубая сфера в металлической клетке. |
| `mass-suggestion` | `ui/action-icons/mass-suggestion.png` | icons-17 (current-runtime-frame-review) | matched | Группа голов под единым вихрем мысли. |
| `otto-s-irresistible-dance` | `ui/action-icons/otto-s-irresistible-dance.png` | icons-17 (current-runtime-frame-review) | matched | Фигура танцует на механическом постаменте. |
| `investiture-of-wind` | `ui/action-icons/investiture-of-wind.png` | icons-17 (current-runtime-frame-review) | matched | Доспех или силуэт окружён ветром. |
| `investiture-of-stone` | `ui/action-icons/investiture-of-stone.png` | icons-17 (current-runtime-frame-review) | matched | Каменная броня и щит с осколками. |
| `investiture-of-ice` | `ui/action-icons/investiture-of-ice.png` | icons-17 (current-runtime-frame-review) | matched | Ледяная броня. |
| `investiture-of-flame` | `ui/action-icons/investiture-of-flame.png` | icons-17 (current-runtime-frame-review) | matched | Пламенный плащ и облачение. |
| `flesh-to-stone` | `ui/action-icons/flesh-to-stone.png` | icons-17/18 (current-runtime-frame-review) | matched | Каменное тело в процессе магического превращения. |
| `otiluke-s-freezing-sphere` | `ui/action-icons/otiluke-s-freezing-sphere.png` | icons-17/18 (current-runtime-frame-review) | matched | Сфера льда. |
| `primordial-ward` | `ui/action-icons/primordial-ward.png` | icons-17/18 (current-runtime-frame-review) | matched | Стихийный синий щит. |
| `heroes-feast` | `ui/action-icons/heroes-feast.png` | icons-17/18 (current-runtime-frame-review) | matched | Полный праздничный пир. |
| `planar-ally` | `ui/action-icons/planar-ally.png` | icons-17/18 (current-runtime-frame-review) | matched | Рука союзника выходит из межпланарного портала. |
| `fizban-s-platinum-shield` | `ui/action-icons/fizban-s-platinum-shield.png` | icons-17/18 (current-runtime-frame-review) | matched | Серебряный щит с драконом. |
| `chain-lightning` | `ui/action-icons/chain-lightning.png` | icons-17/18 (current-runtime-frame-review) | matched | Молния в цепном кольце. |
| `find-the-path` | `ui/action-icons/find-the-path.png` | icons-17/18 (current-runtime-frame-review) | matched | Звезда над извилистым путём. |
| `heal` | `ui/action-icons/heal.png` | icons-17/18 (current-runtime-frame-review) | matched | Золотой лечебный сосуд. |
| `harm` | `ui/action-icons/harm.png` | icons-17/18 (current-runtime-frame-review) | matched | Поражающая ладонь с фиолетовым некрозом. |
| `tasha-s-otherworldly-guise` | `ui/action-icons/tasha-s-otherworldly-guise.png` | icons-17/18 (current-runtime-frame-review) | matched | Потусторонний тёмный облик в плаще. |
| `contingency` | `ui/action-icons/contingency.png` | icons-17/18 (current-runtime-frame-review) | matched | Песочные часы с магическим условием. |
| `summon-fiend` | `ui/action-icons/summon-fiend.png` | icons-17/18 (current-runtime-frame-review) | matched | Пылающий рогатый исчадийный силуэт. |
| `conjure-fey` | `ui/action-icons/conjure-fey.png` | icons-17/18 (current-runtime-frame-review) | matched | Фея внутри зачарованного сосуда. |
| `transport-via-plants` | `ui/action-icons/transport-via-plants.png` | icons-17/18 (current-runtime-frame-review) | matched | Светящийся проход в переплетении живых растений. |
| `eyebite` | `ui/action-icons/eyebite.png` | icons-17/18 (current-runtime-frame-review) | matched | Гигантский глаз. |
| `scatter` | `ui/action-icons/scatter.png` | icons-17/18 (current-runtime-frame-review) | matched | Снаряды разлетаются в разные стороны. |
| `disintegrate` | `ui/action-icons/disintegrate.png` | icons-17/18 (current-runtime-frame-review) | matched | Куб распадается на частицы; эффект распада читается явно. |
| `druid-grove` | `ui/action-icons/druid-grove.png` | icons-17/18 (current-runtime-frame-review) | matched | Защищённая роща с деревьями и камнем. |
| `word-of-recall` | `ui/action-icons/word-of-recall.png` | icons-17/18 (current-runtime-frame-review) | matched | Светящийся портал возврата с крылатой рамой. |
| `sunbeam` | `ui/action-icons/sunbeam.png` | icons-18 (current-runtime-frame-review) | matched | Солнечный диск выпускает луч. |
| `create-homunculus` | `ui/action-icons/create-homunculus.png` | icons-18 (current-runtime-frame-review) | matched | Маленький искусственный гуманоид/гомункул. |
| `create-undead` | `ui/action-icons/create-undead.png` | icons-18 (current-runtime-frame-review) | matched | Скелет поднимается из земли. |
| `blade-barrier` | `ui/action-icons/blade-barrier.png` | icons-18 (current-runtime-frame-review) | matched | Кольцо вращающихся клинков. |
| `guards-and-wards` | `ui/action-icons/guards-and-wards.png` | icons-18 (current-runtime-frame-review) | matched | Крепость под защитным куполом и щитом. |
| `globe-of-invulnerability` | `ui/action-icons/globe-of-invulnerability.png` | icons-18 (current-runtime-frame-review) | matched | Сфера со щитом, блокирующая магию. |
| `wall-of-thorns` | `ui/action-icons/wall-of-thorns.png` | icons-18 (current-runtime-frame-review) | matched | Переплетённая стена шипов. |
| `tenser-s-transformation` | `ui/action-icons/tenser-s-transformation.png` | icons-18 (current-runtime-frame-review) | matched | Боевая доспешная трансформация с фиолетовой силой. |
| `wind-walk` | `ui/action-icons/wind-walk.png` | icons-18 (current-runtime-frame-review) | matched | Светящийся вихрь облачной формы. |

## Ограничения

Это acceptance визуального субъекта/эффекта. Статус `symbolic` означает, что
подача метафорическая, но не противоречит описанию. Он не означает
механическую полноту заклинания и не заменяет серверные тесты правил.

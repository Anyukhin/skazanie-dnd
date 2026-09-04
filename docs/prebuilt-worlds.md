# Предзаготовленные миры

Версия набора: campaign-worlds-v1
Дата генерации карт: **2026-08-31 — 2026-09-02**
Модель изображений: **built-in imagegen**
Внешние ссылки на изображения при генерации не использовались.

В наборе четыре независимых региона. Данные для загрузки лежат в
data/campaign-worlds-v1.json. Фоновые иллюстрации служат атмосферной
проекцией: игровая геометрия, подписи, видимость и маршруты берутся из JSON, а
не из пикселей изображения. У каждой стартовой локации visited: true;
остальные известные точки имеют visited: false, чтобы первые открытия
сохраняли смысл.

## Лига Девяти Отливов

**Короткая формула:** северная приливная бухта, купеческая конфедерация и город,
который возвращается на дне моря. Рекомендуемые уровни: **1–12**.

Вельдбург и Солёные Ворота живут за счёт соли, конвоев и расписаний прилива.
Между цепью барьерных островов и материковыми дамбами лежит Мелководье
Грунвика. Обычно там видны только песок, камыш и обломки кораблей, однако
необычный отлив открывает мощёные улицы затонувшей столицы. Девять колоколов
звонят в правильной последовательности, вода в дельте темнеет, а древние
затворы под городом начинают работать.

### История

Сначала острова населяли рыбаки, лодочники и сборщики соли, передававшие
штормовые сигналы цепью костров. Около девяти веков назад дальние купцы
объединились в конвои и создали Лигу: общий флаг защищал грузы от пиратов, а
купеческие советы постепенно получили право судить все споры между гаванями.

Четыреста тридцать лет назад Великий Нырок продолжался три дня. Дамбы
разошлись, поля превратились в проливы, а Грунвик исчез вместе с шестнадцатью
приходами. Выжившие укрепили Вельдбург у нового устья. Совет Когов объявил
точные карты прилива собственностью Лиги, хотя Смотрители Дамб утверждают, что
под городом работала намеренно открытая сеть водосбросов.

Теперь море отступает всё дальше. В иле находят колокольчики и печати
Грунвика, призраки требуют вернуть имена погибших, а новый шторм может накрыть
не руины, а весь живой берег.

### Фракции

- **Совет Когов** — купеческие дома; хочет скрыть вину предков и превратить
  возвращение Грунвика в монополию на реликвии и новые торговые пути.
- **Смотрители Дамб** — инженеры и общинные старосты; хотят открыть архивы,
  восстановить затворы и спасти поселения, даже разрушив богатые гавани.
- **Колоколари Прилива** — духи Грунвика и хранители островных башен; хотят
  вернуть девять колоколов и право города говорить с живыми.
- **Чёрные Паруса** — пираты и беженцы; хотят сломать торговую монополию и
  получить независимую гавань на Кладбище Когов.
- **Дом Матери Глубины** — культ моря-должника; хочет завершить древний обряд
  великой волной, чтобы мёртвые больше не были забыты.

### Кампанийные арки

1. **«Город под мутной водой» (1–4).** Экспедиция к Грунвику, спасение
   просевшей дамбы и карта, на которой улицы совпадают с подземными каналами.
2. **«Хартия соли» (5–8).** Борьба за архивы, переговоры купцов с пиратами и
   решение, кому принадлежит проход через восстановленный пролив.
3. **«Девятый отлив» (9–12).** Спуск к девяти затворам и выбор: закрыть море,
   вернуть Грунвик, направить волну на владения купцов или завершить обряд
   Матери Глубины.

### Фон карты и промпт

Файл: /assets/maps/world/skazanie/nine-tides-v2.webp

~~~text
Use case: stylized-concept
Asset type: production game asset, background for an interactive D&D world map
Primary request: an original top-down fantasy regional map for "The League of Nine Tides", a northern tidal merchant realm
Scene/backdrop: open slate ocean along the west edge; a crescent chain of barrier islands across the west and northwest; a broad central tidal basin with braided channels, mudflats and salt meadows; low reclaimed mainland and fortified dikes in the east; a river delta in the south; faint rectilinear foundations of a drowned city visible beneath shallow water in the center-left; one storm-battered lighthouse island off the southwest coast
Style/medium: hand-painted fantasy cartography on aged parchment, refined medieval nautical atlas, realistic landforms and water depth, painterly but clean enough for a game UI
Composition/framing: strict top-down orthographic map, wide landscape about 25:16, full bleed, geography fills the canvas, clear separated zones for later interactive overlays
Lighting/mood: cold overcast northern light, haunted maritime grandeur
Color palette: muted slate blue, sea green, salt white, reed olive, peat brown, weathered parchment
Materials/textures: subtle paper grain, ink wash coastlines, watercolor terrain
Constraints: terrain background only; no words, no letters, no numbers, no city labels, no banners, no shields, no city-marker icons, no route lines, no legend, no border frame, no compass rose, no watermark, no logos; preserve open readable areas for UI labels
~~~

## Пояс Непогашенной Звезды

**Короткая формула:** караванный путь через пустыню, степь и оазисы, где
разрушенная обсерватория хранит карту подземной воды. Рекомендуемые уровни:
**1–13**.

Нур-Кеш стоит в долине Семи Рукавов. На западе лежат красные пустоши и
Караван-сарай Сорока Колодцев, на юге — Озеро Зеркальных Кочевий, на востоке —
Снежные Ворота. Путь соединяет города, кочевые станы и старые русла. Синяя
звезда, которой не было в прежних каталогах, появилась семь лет назад; после
этого колодцы темнеют, а караваны приходят без людей.

### История

Первые поселения строили каналы у сезонной реки и сверяли календарь с её
разливом и возвращением птиц. Позднее дорога связала горные рудники, оазисы и
западные солончаки. Вместе с товарами двигались языки, способы считать время,
лекарства и технологии строительства колодцев.

Шесть веков назад правитель-астроном Арслан-бек вырубил в горном разломе
огромную измерительную дугу. Его школа составила каталог звёзд и отметила
подземные водные жилы по теням гор. После дворцового переворота учёных разогнали,
таблицы разделили между архивами, а обсерваторию засыпали. Затем река изменила
русло, и старые города превратились в курганы.

Синяя звезда повторяет положение из первой строки утраченного каталога. Под
Озером Зеркальных Кочевий поднимается солёный пар, а Дом Затмения готов назвать
воду собственностью того, кто первым восстановит меридиан.

### Фракции

- **Дом Затмения** — придворные астрологи; хочет собрать каталог и подчинить
  все колодцы государственному календарю.
- **Союз Красных Кочевий** — степная конфедерация; защищает свободные переходы и
  общее право на воду.
- **Братство Четырёх Колодцев** — караванщики и проводники; хочет открыть
  независимую сеть безопасных дорог.
- **Последние Меридианцы** — тайная школа астрономов; хочет восстановить
  научное наследие и доказать, что карта служит равновесию, а не власти.
- **Солончаковые Кинжалы** — наёмники засухи; хотят поддерживать кризис и
  продавать проходы, воду и охрану всем сторонам.

### Кампанийные арки

1. **«Караван без тени» (1–4).** Расследование исчезновения каравана,
   переход через степь и первая часть каталога в колокольце вьючного животного.
2. **«Разлом Меридиана» (5–8).** Восстановление обсерватории, мир между
   городом и кочевниками, раскрытие подменённых измерений.
3. **«Звезда под землёй» (9–13).** Спуск под озеро и решение, является ли
   резервуар водохранилищем, тюрьмой или воротами в иной слой мира.

### Фон карты и промпт

Файл: /assets/maps/world/skazanie/unfading-star-v2.webp

~~~text
Use case: stylized-concept
Asset type: production game asset, background for an interactive D&D world map
Primary request: an original top-down fantasy regional map for "The Belt of the Unfading Star", a vast caravan realm of oasis cities, steppe clans and a lost observatory
Scene/backdrop: a long east-to-west land; tall snow-fed mountains and narrow passes along the east edge; a river flowing westward through a chain of green oases and irrigated fields; broad golden steppe in the center with one pale mirror-like salt lake; wind-cut desert and red dunes across the west; a clearly visible dry abandoned riverbed curling beside buried ruins; a monumental circular observatory ruin and giant stone meridian arc in a north-central ravine; sparse caravan wells and rocky mesas as natural terrain only
Style/medium: hand-painted fantasy cartography on aged parchment, refined Silk Road atlas sensibility, watercolor and ink, realistic landforms, painterly but clean enough for a game UI
Composition/framing: strict top-down orthographic map, wide landscape about 25:16, full bleed, geography fills the canvas, strong readable east-west progression and open zones for later interactive overlays
Lighting/mood: sun-baked clarity under an uncanny cool-blue celestial haze, adventurous and ancient
Color palette: lapis blue, turquoise river, ochre steppe, red earth, pale salt, parchment gold
Materials/textures: subtle paper grain, ink-wash ridges, watercolor desert and vegetation
Constraints: terrain background only; no words, no letters, no numbers, no city labels, no banners, no shields, no city-marker icons, no route lines, no legend, no border frame, no compass rose, no watermark, no logos; preserve open readable areas for UI labels
~~~

## Чаша Пепельного Сада

**Короткая формула:** остров-кальдера, погребённый город бронзового века и
аграрный обряд, который удерживает границу между живыми и мёртвыми.
Рекомендуемые уровни: **1–14**.

Лимнара занимает восточную гавань кальдеры, Элефра принимает паломников на
северных террасах, а белые руины Таласс-Акры лежат на южном пепельном склоне.
В центре дымится Чёрный Конус. Три островка, горячие источники и тоннели
соединяют берег с Подземной Цистерной. На каждом зерне в амбарах Лимнары
появляется знак закрытого глаза, а из руин доносится детский хор.

### История

Около четырёх с половиной тысяч лет назад на вулканическом мысе возникло
рыбацко-земледельческое поселение. Безопасная гавань связала его с соседними
островами и дальними берегами. Таласс-Акр вырос вверх: многоэтажные дома,
водоотводы, склады, площади и росписи сделали его центром морской торговли.

Землетрясения предупредили жителей о первом великом извержении. Большинство
ушло, но город был погребён под пемзой и пеплом, сохранив дома и вещи. Выжившие
основали Лимнару и Элефру, а позже создали обряд Трёх Возвращений: спуск,
поиск имени потерянного и возвращение с семенем. Имперские наместники оставили
дневную часть праздника, но запечатали ночное святилище.

Тридцать лет назад добытчики обсидиана пробили боковой тоннель. Теперь пепел
ложится на террасы, вода кальдеры теплеет, двери Таласс-Акры открываются, а
Круг Трёх Возвращений спорит с Орденом Закрытой Двери о том, что именно должно
вернуться.

### Фракции

- **Круг Трёх Возвращений** — жрецы и хранители террас; хочет восстановить
  мягкую форму обряда и вернуть плодородие без выпуска опасной силы.
- **Орден Закрытой Двери** — бывшие служители святилища; хочет навсегда
  запечатать храм, даже ценой городов у кальдеры.
- **Консорциум Пемзы** — торговцы и шахтовладельцы; хочет добраться до
  вулканического сердца и превратить его жар в богатство.
- **Совет Лимнары** — городские власти; хочет провести эвакуацию и скрыть
  масштаб угрозы, сохранив гавань.
- **Садовники Первого Зерна** — крестьянские семьи и хранители семян; хотят
  спасти живые сорта и передать решение жителям острова.

### Кампанийные арки

1. **«Пепел на урожае» (1–4).** Исчезнувшие паломники, пепельный дождь и
   первый вход в погребённый квартал.
2. **«Три спуска» (5–9).** Подземное святилище, разорванная песня и причина,
   по которой старое извержение сохранило голоса мёртвых.
3. **«Последнее извержение» (10–14).** Обвал шахт и выбор: запечатать вулкан,
   перенаправить лаву, принять новый цикл или дать острову погибнуть.

### Фон карты и промпт

Файл: /assets/maps/world/skazanie/ashen-garden-v2.webp

~~~text
Use case: stylized-concept
Asset type: production game asset, background for an interactive D&D world map
Primary request: an original top-down fantasy regional map for "The Bowl of the Ashen Garden", a Mediterranean volcanic island realm of harvest mysteries and buried cities
Scene/backdrop: a large broken-ring volcanic island around a deep central sea caldera; a black active cone rising from a small central island; a crescent harbor on the northeast rim; terraced vineyards, olive groves and golden grain fields across the outer slopes; a pale pumice-covered buried ancient city visible as faint foundations in the south; sea caves and a dark ravine leading inland on the west; several small hot-spring islands and black-sand beaches; a nearby mainland coast along the far east with one broad trading bay
Style/medium: hand-painted fantasy cartography on aged parchment, refined ancient Mediterranean atlas, watercolor and ink, realistic volcanic landforms, painterly but clean enough for a game UI
Composition/framing: strict top-down orthographic map, wide landscape about 25:16, full bleed, caldera as the visual center, clear island districts and open zones for later interactive overlays
Lighting/mood: warm late-summer sun crossed by a thin ominous veil of ash, sacred and uneasy
Color palette: deep Aegean blue, obsidian black, pumice ivory, terracotta, olive green, grain gold, faded parchment
Materials/textures: subtle paper grain, ink-wash cliffs, watercolor sea and cultivated terraces
Constraints: terrain background only; no words, no letters, no numbers, no city labels, no banners, no shields, no city-marker icons, no route lines, no legend, no border frame, no compass rose, no watermark, no logos; preserve open readable areas for UI labels
~~~

## Асстоханские равнины

**Короткая формула:** прославленная компания охотится на молодого красного
дракона и раскрывает нарушенную клятву самого короля-драконоборца.
Рекомендуемые уровни: **7–10**.

Штормберг стоит у холодного моря, Миттлайд держит речное снабжение, а
Редстоуновка лежит между башней Ломара и круглым Диким лесом. На западе
поднимаются Клыки Вулканиса, на юге начинается Проклятый лес, а у восточного
озера пустует Замок Забытых Скал. Молодой дракон Саргат разоряет равнины,
собирает сведения через запуганных жителей и ищет реликвии своего рода.

### История

Шесть веков назад волшебник Элдрин получил бессмертие, связав сознание с Диким
лесом, но потерял тело и свободу. Двести лет назад Каэлан Вердант предал короля
Элдрика при поддержке драконьего культа; казнь драконьим клинком превратила его
в Дуннахана Забытых Скал.

Тридцать лет назад Арес и его спутники убили Вулканиса. Король обещал пощадить
кладку в обмен на уход дракона, однако один из соратников разбил яйца после
боя. Арес скрыл случившееся и принял славу безупречного победителя. Один
детёныш выжил. Теперь Саргат хочет не только мести: ему нужны останки Вулканиса,
реликвия Каэлана и публичное признание старой лжи.

### Фракции

- **Корона Валедора** хочет остановить Саргата, не потеряв фронт и доверие к
  Аресу.
- **Пограничное войско Тарна** использует каждый налёт, чтобы вынудить короля
  открыть северную оборону.
- **Пепельная сеть** объединяет запуганных и подкупленных осведомителей дракона.
- **Хранители Дикого леса** защищают Элдрина и не позволяют превратить память
  корней в оружие.
- **Башня Ломара** ищет способ отделить бессмертие от проклятия и требует
  сердечную ветвь Великого Древа.

### Кампанийные арки

1. **«Королевская охота» (7).** Осмотр Пепельной заставы, раскрытие сети
   осведомителей и выбор между скрытой разведкой, защитой поселений и прямым
   походом к горам.
2. **«Три ответа на бессмертие» (8–9).** Ломар, Элдрин и Каэлан дают разные
   преимущества и назначают разную цену за подготовку к схватке.
3. **«Последний наследник Вулканиса» (9–10).** Правда об Аресе становится
   оружием, а герои выбирают место встречи и исход: смерть, изгнание, договор
   или новый порядок в королевстве.

Полный редакционный эталон и честный список ещё не реализованной
высокоуровневой механики находятся в
[`world-reference-dragon-scar.md`](world-reference-dragon-scar.md).

Вместе с миром загружаются восемь стабильных персонажей: Арес, Ивара, Орен и
Мира находятся в стартовом Штормберге; Ломар, Элдрин, Каэлан и Саргат ждут в
своих узлах карты. У каждого заданы отдельные социальные СЛ, речевая манера,
инвентарь и закрытый механический профиль. Точные листы игроку не передаются.

### Фон карты и точный prompt

Файл: /assets/maps/world/skazanie/dragon-scar-v1.webp

Image 1 — пользовательская схема расположения мест; она не включена в
репозиторий. Финальный растр перерисован с нуля, а не собран из её элементов.

~~~text
Use case: stylized-concept
Asset type: final production game asset, richly illustrated background for an interactive D&D world map
Input images: Image 1 is a loose spatial diagram only. Preserve the relative arrangement of its major places, but redraw the entire world from scratch with far more beauty, detail, natural geography and visual storytelling. Do not preserve the simple collage rendering.
Primary request: create a premium hand-painted fantasy atlas of the Astohan Plains, as polished and richly detailed as a collector's tabletop RPG campaign map
Required relative layout: a dramatic jagged mountain realm dominates the northwest; a solitary magical tower stands west of the great central forest, with a small dark spring and one dead tree nearby; a cave lies farther southwest; Redstone village lies southwest of the great forest; the great Wild Forest forms the central heart of the map with an immense ancient tree subtly visible at its center; the Cursed Forest spreads across the southwest and southern frontier; Stormberg is a substantial fortified coastal capital in the northeast with an old burned ruin just northwest of it; a large irregular lake lies southeast of Stormberg and feeds a winding river toward the south; Forgotten Cliffs Castle stands east of the lake; Mittlayd lies south of the lake beside the river and an old windmill; a small distant roadside camp lies farther southeast
Natural geography: make every biome transition believable; mountain foothills descend into ridges and valleys; add minor tributaries feeding the lake and main river; shape a rugged coast with beaches, coves and shallow water; add cultivated fields, hedgerows, orchards, scattered copses, low hills, rocky outcrops and marshy riverbanks; roads follow terrain and connect the existing places naturally; add atmospheric minor ruins and watch posts only as small environmental details, never as new major locations
Visual storytelling: the center and settled east feel green and inhabited; the Wild Forest feels ancient, deep and alive; the Cursed Forest is visibly blighted and twisted without becoming a black empty strip; the northwest mountains feel old, dangerous and dragon-haunted with faint scorched stone and a distant warm glow near a hidden high cave; Stormberg feels proud and storm-beaten; the old eastern castle feels lonely and haunted
Style/medium: high-detail hand-painted fantasy cartography, refined medieval illuminated atlas, ink outlines and layered watercolor/gouache, realistic landforms, dense environmental texture, coherent custom architecture, no cutout or clip-art look, no modern satellite realism
Composition/framing: strict top-down orthographic world map, wide landscape about 25:16, geography fills the canvas, elegant restrained carved-gold border within the outer edge, one small tasteful unlabeled compass rose in open sea, enough quiet space around important locations for later UI labels
Lighting/mood: luminous late-afternoon light over the plains, cool sea haze in the northeast, deep green filtered light in the Wild Forest, bruised dusk and faint ember glow near cursed and dragon-haunted regions; adventurous, ancient and ominous
Color palette: aged parchment gold, meadow green, deep moss and pine, river sapphire, storm-sea teal, slate and snow gray, muted rust and ember red
Text and overlay constraints: remove all source labels and banners; no words, no letters, no numbers, no city names, no title cartouche, no map pins, no route-marker icons, no legend, no grid, no watermark, no logos
Do not: move the required major locations to different sides of each other; omit any required major place; add a visible dragon; turn the map into an isometric scene; leave large flat empty plains; reproduce source clip-art
~~~

## Финальная атласная стилизация v2

Ниже — точные production-prompts финального style-transfer. В каждом вызове
Image 1 — соответствующий оригинальный `v1`, Image 2 — пользовательский
стилевой пример.

### Лига Девяти Отливов v2

~~~text
Use case: style-transfer
Asset type: production game asset, background for an interactive D&D global map
Input images: Image 1 is the edit target, our original map of the League of Nine Tides; Image 2 is a style reference only
Primary request: restyle Image 1 as a richly illustrated classic fantasy atlas in the broad visual language of Image 2 while keeping Image 1's original world and geography
Preserve from Image 1: the exact 25:16 landscape framing; dark open sea on the west; the crescent chain of barrier islands; the central tidal basin and every major tidal channel; the faint drowned-city street grid at center-left; eastern dikes and geometric salt fields; southern river delta; southwest lighthouse island; relative positions and silhouettes of all key land and water features
Style/medium: detailed hand-painted fantasy atlas, ink-and-watercolor terrain, miniature illustrated mountains, forests, marshes, cliffs and waves, luminous deep-blue ocean, warm parchment land, crisp readable coastlines, polished tabletop-RPG world-map finish
Composition/framing: keep all usable geography inside the same coordinates; add an original restrained carved-gold and aged-parchment ornamental frame only within the outer 3 percent of the image; add a small original compass rose in an otherwise empty northwest-ocean corner; leave the map interior open for interactive labels
Lighting/mood: northern maritime grandeur, storm-washed but colorful and legible
Constraints: change the rendering style, not the geography; no words, no letters, no numbers, no region labels, no city names, no title cartouche, no banners, no shields, no settlement icons, no roads or route lines, no legend, no watermark, no logos
Avoid: do not copy Image 2's continent shapes, names, exact border ornament, title plaque, compass design, fonts, color placement, watermark, or any identifiable decorative motif; create an original atlas design
~~~

### Пояс Непогашенной Звезды v2

~~~text
Use case: style-transfer
Asset type: production game asset, background for an interactive D&D global map
Input images: Image 1 is the edit target, our original map of the Belt of the Unfading Star; Image 2 is a style reference only
Primary request: restyle Image 1 as a richly illustrated classic fantasy atlas in the broad visual language of Image 2 while keeping Image 1's original world and geography
Preserve from Image 1: the exact 25:16 landscape framing; red desert and dry riverbed in the west; golden steppe across the center; pale mirror salt lake in the lower center; green river-fed oasis valley; huge broken astronomical meridian arc in the north-central ravine; continuous snow mountains and river sources along the east; relative positions and silhouettes of every major terrain feature
Style/medium: detailed hand-painted fantasy atlas, ink-and-watercolor terrain, miniature illustrated mountain chains, dunes, steppe grass, oases, riverbanks and ruins, rich deep-blue accents, warm parchment land, crisp readable geography, polished tabletop-RPG world-map finish
Composition/framing: keep all usable geography inside the same coordinates; add an original restrained carved-bronze and geometric parchment ornamental frame only within the outer 3 percent; add a small original celestial compass rose in an empty southwest corner; leave the map interior open for interactive labels
Lighting/mood: sunlit caravan epic with a cool mysterious celestial note
Constraints: change the rendering style, not the geography; no words, no letters, no numbers, no region labels, no city names, no title cartouche, no banners, no shields, no settlement icons, no roads or route lines, no legend, no watermark, no logos
Avoid: do not copy Image 2's continent shapes, names, exact border ornament, title plaque, compass design, fonts, color placement, watermark, or any identifiable decorative motif; create an original atlas design
~~~

### Чаша Пепельного Сада v2

~~~text
Use case: style-transfer
Asset type: production game asset, background for an interactive D&D global map
Input images: Image 1 is the edit target, our original map of the Bowl of the Ashen Garden; Image 2 is a style reference only
Primary request: restyle Image 1 as a richly illustrated classic fantasy atlas in the broad visual language of Image 2 while keeping Image 1's original world and geography
Preserve from Image 1: the exact 25:16 landscape framing; the broken-ring volcanic island around the central sea caldera; the black active cone on the center island; crescent harbor on the northeast rim; terraced vineyards and fields around the outer slopes; pale ash-buried street grid in the south; western caves and hot-spring islets; mainland coast and bay along the east; relative positions and silhouettes of all key terrain
Style/medium: detailed hand-painted fantasy atlas, ink-and-watercolor terrain, miniature illustrated cliffs, vineyards, olive groves, black beaches, volcano, ruins and waves, luminous deep Aegean-blue sea, warm parchment and terracotta land, polished tabletop-RPG world-map finish
Composition/framing: keep all usable geography inside the same coordinates; add an original restrained carved-copper and laurel parchment ornamental frame only within the outer 3 percent; add a small original volcanic compass rose in an empty southeast-sea corner; leave the map interior open for interactive labels
Lighting/mood: radiant Mediterranean beauty with an ominous veil of ash
Constraints: change the rendering style, not the geography; no words, no letters, no numbers, no region labels, no city names, no title cartouche, no banners, no shields, no settlement icons, no roads or route lines, no legend, no watermark, no logos
Avoid: do not copy Image 2's continent shapes, names, exact border ornament, title plaque, compass design, fonts, color placement, watermark, or any identifiable decorative motif; create an original atlas design
~~~

## Источники вдохновения

Источники ниже использованы для географии, исторического контекста и
мифологических мотивов. Имена, персонажи, конфликты, магические объяснения и
тексты шаблонов написаны заново.

### Лига Девяти Отливов

- [Wadden Sea — UNESCO](https://whc.unesco.org/en/list/1314/) — система
  приливных отмелей, каналов, солончаков и барьерных островов.
- [Grote Mandränke 1362 — Schleswig-Holstein](https://www.schleswig-holstein.de/DE/fachinhalte/L/landeskundegeschichte/Chronologie_Augenblicke_Landesgeschichte/1362_GroteMandraenke) —
  историческая буря, изменившая берег и уничтожившая поселения.
- [Rungholt 1362 — Dutch Cultural Heritage](https://mass.cultureelerfgoed.nl/rungholt-1362) —
  затонувшее поселение, разделение острова и археология приливной зоны.
- [Hanseatic City of Lübeck — UNESCO](https://whc.unesco.org/en/list/272/) —
  островной торговый город, соляные склады и купеческая городская структура.
- [The medieval Hanseatic League — Die Hanse](https://www.hanse.org/en/the-medieval-hanseatic-league) —
  конвои, фактории, торговое право и конфедерация городов.

### Пояс Непогашенной Звезды

- [Zarafshan–Karakum Corridor — UNESCO](https://whc.unesco.org/en/list/1675/) —
  маршрут через горы, речные долины, степь и пустыню к оазису Мерва.
- [Samarkand — UNESCO](https://whc.unesco.org/en/list/603) — оазисная столица
  с многотысячелетней историей и обсерваторией.
- [Ancient Merv — UNESCO](https://whc.unesco.org/en/list/886/) —
  последовательность городов, сменявших друг друга вслед за руслом Мургаба.
- [Ulugh Beg Observatory — Uzbekistan Travel](https://uzbekistan.travel/en/o/ulugbek-observatory/) —
  большой каменный инструмент и каталог звёзд.
- [Saryarka — UNESCO](https://whc.unesco.org/en/list/1102) — степные озёра,
  сезонные водные циклы и маршруты перелётных птиц.

### Чаша Пепельного Сада

- [Akrotiri of Thera — Hellenic Ministry of Culture](https://odysseus.culture.gr/h/3/eh351.jsp?obj_id=2410) —
  погребённый вулканом город бронзового века, морские связи и городская
  инфраструктура.
- [Santorini — Smithsonian Global Volcanism Program](https://volcano.si.edu/volcano.cfm?vn=212040) —
  кальдера и память о крупном древнем извержении.
- [Pompeii, Herculaneum and Torre Annunziata — UNESCO](https://whc.unesco.org/en/list/829/) —
  города, сохранённые под пеплом Везувия.
- [Homeric Hymn to Demeter — Perseus Digital Library](https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.01.0138:hymn=2) —
  общая схема потери, поиска, спуска и возвращения, связанная с урожаем и
  подземным миром.

### Асстоханские равнины

Исходная география, названия мест, король Арес, охота на молодого красного
дракона, Ломар, Элдрин и Замок Забытых Скал предоставлены владельцем проекта.
Внешние источники для текста и карты не использовались.

## Авторское и лицензионное примечание

Исторические факты и древние сюжеты использованы как общественный культурный
материал и как исследовательская опора. Из источников не копировались
современные фэнтезийные сеттинги, персонажи, карты или художественные
формулировки. Названия регионов и локаций, фракции, таймлайны, NPC, завязки и
развязки являются оригинальным материалом набора.

Первые три базовых фона `v1` созданы встроенным `imagegen` 2026-08-31 по промптам выше,
без внешних изображений. Финальные атласные `v2` — отдельный style-transfer:
Image 1 был соответствующим оригинальным `v1`, Image 2 — пользовательским
примером классической фэнтезийной карты. Референс использовался только для
общих признаков — иллюстрированный рельеф, глубокое море, орнаментальная рамка,
компас; prompt запрещал копировать географию, названия, картуш, шрифты, гербы,
точный орнамент и водяной знак. Сам референс в репозиторий не включён.

Фон Асстоханских равнин создан встроенным `imagegen` 2026-09-02. В качестве
Image 1 использована карта владельца проекта только как схема относительного
расположения; prompt требовал полной художественной перерисовки и запрещал
перенос текста, баннеров и исходных коллажных элементов. Исходная схема в
репозиторий не включена.

Финальные PNG после визуальной проверки механически приведены к WebP через
Pillow 12.3.0, quality 90, без crop, чтобы сохранить раму целиком. Фоновые карты не заменяют проверку прав на отдельные ассеты
проекта: при публикации следует соблюдать общую политику атрибуции и проверки
ассетов репозитория.

/**
 * "Which filament for what" — the /materials page's purpose matrix: seven
 * common FDM filaments rated 1–5 for the jobs customers ask about. General
 * material knowledge, not any shop's data: shown on every shop whether or not
 * it sells them. Ratings are relative to each other, from manufacturers'
 * datasheets and published comparisons (FILAMENT_MATRIX_SOURCES); grades and
 * brands differ, so the notes give the figure each rating rests on.
 */

export type FilamentPurpose = "looks" | "stiff" | "tough" | "heat" | "outdoor" | "chemical" | "easy";

export const FILAMENT_PURPOSES: { key: FilamentPurpose; label: string; hint: string }[] = [
  { key: "looks", label: "Display & prototypes", hint: "Surface finish and fine detail" },
  { key: "stiff", label: "Stiff, load-bearing", hint: "Brackets, mounts, parts that must not flex" },
  { key: "tough", label: "Impact & drops", hint: "Bends or absorbs a knock instead of snapping" },
  { key: "heat", label: "Heat", hint: "Cars, engine bays, near motors and electronics" },
  { key: "outdoor", label: "Outdoor & UV", hint: "Sun and weather over months and years" },
  { key: "chemical", label: "Oils & chemicals", hint: "Fuels, oils, coolants, cleaners" },
  { key: "easy", label: "Low cost & quick", hint: "Cheapest to print, fewest special needs" },
];

export type FilamentRating = 1 | 2 | 3 | 4 | 5;

export interface FilamentMatrixEntry {
  name: string;
  /** What it is, under the name. */
  family: string;
  /** Heat deflection temperature as datasheets state it. */
  heatDeflection: string;
  ratings: Record<FilamentPurpose, FilamentRating>;
  /** The reason behind each rating, shown on hover/focus. */
  notes: Record<FilamentPurpose, string>;
  bestFor: string;
}

export const RATING_WORDS: Record<FilamentRating, string> = {
  1: "Poor",
  2: "Fair",
  3: "Good",
  4: "Very good",
  5: "Excellent",
};

export const FILAMENT_MATRIX: FilamentMatrixEntry[] = [
  {
    name: "PLA",
    family: "Polylactic acid",
    heatDeflection: "≈ 55 °C",
    ratings: { looks: 5, stiff: 3, tough: 1, heat: 1, outdoor: 1, chemical: 2, easy: 5 },
    notes: {
      looks: "The sharpest detail and cleanest surface of any of these.",
      stiff: "Stiff, but slowly creeps under a constant load.",
      tough: "Brittle: it snaps rather than bends.",
      heat: "Softens around 55 °C — a parked car in summer is too hot.",
      outdoor: "Fades and weakens in sun and heat.",
      chemical: "Fine with water; poor against solvents.",
      easy: "The cheapest and easiest to print.",
    },
    bestFor: "Prototypes, figurines, models and indoor decorative parts.",
  },
  {
    name: "PETG",
    family: "Polyethylene terephthalate glycol",
    heatDeflection: "≈ 70 °C",
    ratings: { looks: 4, stiff: 3, tough: 4, heat: 2, outdoor: 3, chemical: 4, easy: 4 },
    notes: {
      looks: "Glossy finish; slightly softer detail than PLA.",
      stiff: "Moderately stiff; flexes a little under load.",
      tough: "Tough: bends before it breaks.",
      heat: "Around 65–80 °C depending on grade.",
      outdoor: "Holds up better than PLA outside.",
      chemical: "Resists water, oils and most household cleaners.",
      easy: "Cheap and prints on almost any printer.",
    },
    bestFor: "Functional everyday parts, enclosures, clips and containers.",
  },
  {
    name: "ABS",
    family: "Acrylonitrile butadiene styrene",
    heatDeflection: "≈ 90–100 °C",
    ratings: { looks: 3, stiff: 3, tough: 4, heat: 3, outdoor: 2, chemical: 3, easy: 3 },
    notes: {
      looks: "Matte finish; large flat parts can warp.",
      stiff: "Moderately stiff.",
      tough: "Absorbs shocks well.",
      heat: "Around 90–100 °C.",
      outdoor: "Yellows and turns brittle in strong sun — ASA is the outdoor version.",
      chemical: "Fine with oils; acetone dissolves it.",
      easy: "Needs an enclosure and gives off fumes.",
    },
    bestFor: "Tough indoor parts, housings and parts that get warm.",
  },
  {
    name: "ASA-CF",
    family: "Carbon-fibre-filled ASA",
    heatDeflection: "≈ 110 °C",
    ratings: { looks: 3, stiff: 5, tough: 2, heat: 3, outdoor: 5, chemical: 3, easy: 2 },
    notes: {
      looks: "Even matte finish that hides layer lines.",
      stiff: "About twice as stiff as plain ASA (≈ 3.7 GPa bending modulus).",
      tough: "The fibre makes it more brittle than plain ASA.",
      heat: "About 110 °C.",
      outdoor: "The ASA base is UV-stable: made for outdoor use.",
      chemical: "Fair; not for solvents.",
      easy: "Needs an enclosure and a hardened nozzle.",
    },
    bestFor: "Stiff outdoor parts: mounts, brackets, car and drone exteriors.",
  },
  {
    name: "ASA-GF",
    family: "Glass-fibre-filled ASA",
    heatDeflection: "≈ 95–100 °C",
    ratings: { looks: 2, stiff: 4, tough: 3, heat: 3, outdoor: 5, chemical: 3, easy: 2 },
    notes: {
      looks: "Slightly rough, glass-filled surface.",
      stiff: "Stiffer than plain ASA (≈ 3.8 GPa flexural modulus), a little less than ASA-CF.",
      tough: "Tougher than carbon-fibre grades.",
      heat: "Around 95–100 °C.",
      outdoor: "UV-stable and keeps its colour outdoors.",
      chemical: "Fair; not for solvents.",
      easy: "Needs an enclosure and a hardened nozzle.",
    },
    bestFor: "Outdoor parts that take knocks: housings, covers, garden and vehicle parts.",
  },
  {
    name: "PC-PBT-GF",
    family: "Glass-fibre polycarbonate / PBT blend",
    heatDeflection: "≈ 150 °C",
    ratings: { looks: 2, stiff: 4, tough: 4, heat: 4, outdoor: 3, chemical: 5, easy: 1 },
    notes: {
      looks: "Functional finish, not a showpiece.",
      stiff: "Very stiff for a tough material (≈ 6 GPa modulus).",
      tough: "Polycarbonate toughness, even in the cold.",
      heat: "About 150 °C (0.45 MPa), without annealing.",
      outdoor: "Decent; polycarbonate can yellow over time.",
      chemical: "PBT resists fuels, oils and many solvents.",
      easy: "Hot nozzle, enclosure, dry filament and a hardened nozzle.",
    },
    bestFor: "Automotive and industrial parts near fuel or oil that must stay tough.",
  },
  {
    name: "PPA-CF",
    family: "Carbon-fibre polyphthalamide (high-temp nylon)",
    heatDeflection: "≈ 190–230 °C",
    ratings: { looks: 3, stiff: 5, tough: 3, heat: 5, outdoor: 3, chemical: 5, easy: 1 },
    notes: {
      looks: "Clean matte black finish.",
      stiff: "The stiffest and strongest here (≈ 120–170 MPa tensile).",
      tough: "Good, though stiffness comes first.",
      heat: "About 190–230 °C (0.45 MPa) — engine-bay territory.",
      outdoor: "Good; check the grade for long sun exposure.",
      chemical: "Resists oils, fuels and coolants.",
      easy: "Must be dried; enclosure and hardened nozzle; the priciest.",
    },
    bestFor: "High-heat, high-load engineering parts: automotive, tooling and fixtures.",
  },
];

export const FILAMENT_MATRIX_SOURCES: { label: string; url: string }[] = [
  { label: "Bambu Lab PPA-CF", url: "https://us.store.bambulab.com/products/ppa-cf" },
  { label: "Raise3D Industrial PPA CF datasheet", url: "https://cdn.shopify.com/s/files/1/2104/4351/files/Raise3D-Industrial-PPA-CF_TDS.pdf" },
  { label: "Siraya Tech PPA-CF manual", url: "https://siraya.tech/pages/siraya-tech-fibreheart-ppa-cf-core-filament-user-manual" },
  { label: "Bambu Lab ASA-CF", url: "https://us.store.bambulab.com/collections/bambu-lab-3d-printer-filament/products/asa-cf" },
  { label: "Filoalfa N-ASA GF datasheet", url: "https://www.filoalfa3d.com/img/cms/MSDS%20&%20TDS/N-ASA%20GF%20tds.pdf" },
  { label: "Spectrum ASA-X GF10 datasheet", url: "https://spectrumfilaments.com/wp-content/uploads/2023/11/en_tds_spectrum_asax_x_gf10.pdf" },
  { label: "Siraya Tech: carbon vs glass fibre", url: "https://siraya.tech/blogs/news/carbon-fiber-vs-glass-fiber-filament" },
  { label: "Treed PC PBT GF", url: "https://filament2print.com/fr/avances/2759-treed-pc-pbt-gf.html" },
  { label: "DREMC PC PBT GF", url: "https://store.dremc.com.au/products/dremc-pc-pbt-gf-glass-fibre-filament-1-75mm-1kg" },
  { label: "Polymaker PC-PBT datasheet", url: "https://polymaker.com/wp-content/uploads/lana-downloads/Polymaker-PC_PBT_TDS_EN_V5.4.pdf" },
  { label: "UltiMaker: PETG vs PLA vs ABS", url: "https://ultimaker.com/?p=53705" },
  { label: "Hubs: PETG vs ABS", url: "https://www.hubs.com/knowledge-base/petg-vs-abs/" },
  { label: "Wevolver: PETG vs PLA", url: "https://www.wevolver.com/article/petg-vs-pla-how-do-they-compare" },
];

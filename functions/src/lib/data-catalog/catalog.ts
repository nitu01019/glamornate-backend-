/**
 * Glamornate Service Catalog — Single Source of Truth
 *
 * Every price, service name, and category comes from CATALOG.md.
 * All other modules import from here; never hard-code prices elsewhere.
 */

import type { HomeService, ServiceCategory } from './types';
import { facialItemImages } from './facial-images';
import { maniPediItemImages } from './manicure-pedicure-images';
import { getWaxingItemImage } from './waxing-images';
import { cleanupItemImages } from './cleanup-images';
import { bleachItemImages } from './bleach-images';
import { threadingItemImages } from './threading-images';
import { bodyPolishingMassageItemImages } from './body-polishing-massage-images';
import { detanItemImages } from './detan-images';

// ---------------------------------------------------------------------------
// Catalog types
// ---------------------------------------------------------------------------
export interface CatalogItem {
  name: string;
  slug: string;
  price: number;
  duration: number; // minutes
}

export interface CatalogSubcategory {
  name: string;
  slug: string;
  items: CatalogItem[];
}

export interface CatalogCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  ordering: number;
  subcategories: CatalogSubcategory[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function item(name: string, price: number, duration: number): CatalogItem {
  return { name, slug: toSlug(name), price, duration };
}

function sub(name: string, items: CatalogItem[]): CatalogSubcategory {
  return { name, slug: toSlug(name), items };
}

// ---------------------------------------------------------------------------
// Duration constants (minutes)
// ---------------------------------------------------------------------------
const DUR_FACIAL = 45;
const DUR_CLEANUP = 30;
const DUR_WAX_SINGLE = 15;
const DUR_WAX_COMBO = 45;
const DUR_WAX_FULL_BODY = 120;
const DUR_MANICURE = 30;
const DUR_PEDICURE = 45;
const DUR_MANI_PEDI = 75;
const DUR_BLEACH_SINGLE = 30;
const DUR_BLEACH_FULL = 60;
const DUR_DE_TAN = 30;
const DUR_THREADING = 10;
const DUR_BODY_POLISHING = 90;
const DUR_HAIR_ROOT_TOUCHUP = 60;
const DUR_GLOBAL_COLORING = 150;
const DUR_HAIR_SPA = 60;
const DUR_HAIR_TRANSFORMATION = 180;
const DUR_HAIR_TREATMENT = 120;

// Wax duration helper: single area, combo, or full body
function waxDuration(areaName: string): number {
  const lower = areaName.toLowerCase();
  if (lower.includes('full body')) return DUR_WAX_FULL_BODY;
  if (
    lower.includes('half legs, full arms') ||
    lower.includes('full legs, full arms') ||
    lower.includes('half legs & half arms') ||
    lower.includes('half legs, full arms & underarms') ||
    lower.includes('full legs, full arms & underarms')
  ) {
    return DUR_WAX_COMBO;
  }
  if (lower.includes('full arms & underarms')) return DUR_WAX_COMBO;
  return DUR_WAX_SINGLE;
}

// ---------------------------------------------------------------------------
// 1. Facials (40 items)
// ---------------------------------------------------------------------------
const facials: CatalogCategory = {
  id: 'cat-01',
  name: 'Facials',
  slug: 'facials',
  description:
    'Professional facials from basic glow treatments to premium Korean and hydra facials',
  ordering: 1,
  subcategories: [
    sub('Basic', [
      item('VLCC Insta Glow Facial', 580, DUR_FACIAL),
      item('VLCC Skin Tightening Facial', 580, DUR_FACIAL),
      item('VLCC Papaya Fruit Facial', 580, DUR_FACIAL),
      item('VLCC Anti Tan Facial', 580, DUR_FACIAL),
      item('OxyLife Professional Facial', 750, DUR_FACIAL),
      item('Aroma Magic Fruit Facial', 900, DUR_FACIAL),
      item('Astaberry Wine Facial', 900, DUR_FACIAL),
      item('Raaga Professional Express Facial', 1000, DUR_FACIAL),
    ]),
    sub('Standard', [
      item('Ozone Skin Whitening Facial', 1000, DUR_FACIAL),
      item('Sara Green Apple Facial', 1150, DUR_FACIAL),
      item('Aroma Magic Skin Glow Facial', 1200, DUR_FACIAL),
      item('OxyGlow Professional Fruit Facial', 1200, DUR_FACIAL),
      item('OxyGlow Professional Bridal Facial', 1200, DUR_FACIAL),
      item('Vedic Line Cool Mint Facial', 1200, DUR_FACIAL),
      item('Lotus Professional Hydravitals Facial', 1300, DUR_FACIAL),
      item('Lotus Professional Puravitals Facial', 1300, DUR_FACIAL),
      item('Aroma Magic Bridal Facial', 1500, DUR_FACIAL),
      item('Vedic Line Alpha Whitening Skin Care Facial', 1500, DUR_FACIAL),
      item('Velvetree Korean Facial', 1600, DUR_FACIAL),
      item('FYC D-Tan Facial', 1800, DUR_FACIAL),
      item('FYC Wine Facial', 1800, DUR_FACIAL),
      item('Ozone D-Tan Facial', 1800, DUR_FACIAL),
    ]),
    sub('Premium', [
      item('Vedic Line Kumkumadi Tailam Bridal Facial', 1800, DUR_FACIAL),
      item('O3+ Professional Whitening Facial', 1800, DUR_FACIAL),
      item('Organic Harvest Brightening & Lightening Facial', 2000, DUR_FACIAL),
      item('O3+ Professional Shine & Glow Facial', 2100, DUR_FACIAL),
      item('Richelon IRIS Collagen Boosting Facial', 2200, DUR_FACIAL),
      item('FYC Vitamin C Facial', 2200, DUR_FACIAL),
      item('Paragon Melafade Facial', 2200, DUR_FACIAL),
      item('O3+ Professional D-Tan Facial', 2300, DUR_FACIAL),
      item('O3+ Professional Anti-Ageing Facial', 2300, DUR_FACIAL),
      item('O3+ Professional Gold Infusion Facial', 2300, DUR_FACIAL),
      item('O3+ Professional Whitening Facial (Tan Pigmented Skin)', 2300, DUR_FACIAL),
      item('O3+ Professional Bridal Radiance Facial', 2500, DUR_FACIAL),
      item('Organic Harvest Hydra Facial', 2800, DUR_FACIAL),
      item('Jeannot Ceuticals Hydra Boost Facial', 3000, DUR_FACIAL),
      item('Kanpeki Un-Tan Facial', 3000, DUR_FACIAL),
      item('FYC Hydra Boost Facial', 3500, DUR_FACIAL),
      item('FYC Korean Rice Water Facial', 3500, DUR_FACIAL),
      item('Kanpeki Blanch Facial', 4000, DUR_FACIAL),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 2. Clean Ups (17 items)
// ---------------------------------------------------------------------------
const cleanUps: CatalogCategory = {
  id: 'cat-02',
  name: 'Clean Ups',
  slug: 'clean-ups',
  description: 'Quick skin clean-up treatments for a fresh, clear complexion',
  ordering: 2,
  subcategories: [
    sub('Basic', [
      item('VLCC Insta Glow Clean Up', 500, DUR_CLEANUP),
      item('VLCC Skin Tightening Clean Up', 500, DUR_CLEANUP),
      item('VLCC Papaya Clean Up', 500, DUR_CLEANUP),
      item('VLCC Anti Tan Clean Up', 500, DUR_CLEANUP),
      item('OxyLife Professional Clean Up', 650, DUR_CLEANUP),
      item('Ozone CTM Clean Up', 650, DUR_CLEANUP),
    ]),
    sub('Standard', [
      item('Astaberry Wine Clean Up', 650, DUR_CLEANUP),
      item('Lotus Professional Hydravitals Clean Up', 700, DUR_CLEANUP),
      item('Lotus Professional Puravitals Clean Up', 700, DUR_CLEANUP),
      item('Vedic Line Cool Mint Clean Up', 900, DUR_CLEANUP),
      item('OxyGlow Professional Fruit Clean Up', 900, DUR_CLEANUP),
      item('Sara Green Apple Clean Up', 900, DUR_CLEANUP),
    ]),
    sub('Premium', [
      item('Professional Korean Clean Up', 900, DUR_CLEANUP),
      item('Vedicline Alpha Whitening Skin Care Clean Up', 950, DUR_CLEANUP),
      item('Vedic Line Kumkumadi Tailam Bridal Clean Up', 1000, DUR_CLEANUP),
      item('O3+ Professional Skin Whitening Clean Up', 1000, DUR_CLEANUP),
      item("Cheryl's Instant Radiance Clean Up", 1200, DUR_CLEANUP),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 3. Waxing (70 items: 5 types x 14 areas)
// ---------------------------------------------------------------------------
function waxingSub(typeName: string, areas: Array<[string, number]>): CatalogSubcategory {
  return sub(
    typeName,
    areas.map(([areaName, price]) =>
      item(`${typeName} - ${areaName}`, price, waxDuration(areaName)),
    ),
  );
}

const waxAreas = {
  honey: [
    ['Underarms', 80],
    ['Half Back', 180],
    ['Full Arms', 200],
    ['Half Legs', 200],
    ['Buttocks', 250],
    ['Full Arms & Underarms', 250],
    ['Stomach', 260],
    ['Full Back', 320],
    ['Full Legs', 350],
    ['Half Legs & Half Arms', 400],
    ['Half Legs, Full Arms & Underarms', 450],
    ['Full Legs, Full Arms & Underarms', 580],
    ['Bikini', 600],
    ['Full Body Excluding Bikini', 1200],
  ] as Array<[string, number]>,
  neuron: [
    ['Underarms', 100],
    ['Half Back', 210],
    ['Full Arms', 240],
    ['Half Legs', 270],
    ['Buttocks', 270],
    ['Stomach', 300],
    ['Full Arms & Underarms', 330],
    ['Full Back', 390],
    ['Full Legs', 400],
    ['Half Legs & Half Arms', 500],
    ['Half Legs, Full Arms & Underarms', 580],
    ['Bikini', 650],
    ['Full Legs, Full Arms & Underarms', 700],
    ['Full Body Excluding Bikini', 1400],
  ] as Array<[string, number]>,
  raagaBridal: [
    ['Underarms', 100],
    ['Half Back', 210],
    ['Full Arms', 240],
    ['Half Legs', 270],
    ['Buttocks', 270],
    ['Stomach', 300],
    ['Full Arms & Underarms', 330],
    ['Full Back', 390],
    ['Full Legs', 400],
    ['Half Legs & Half Arms', 500],
    ['Half Legs, Full Arms & Underarms', 580],
    ['Bikini', 650],
    ['Full Legs, Full Arms & Underarms', 700],
    ['Full Body Excluding Bikini', 1400],
  ] as Array<[string, number]>,
  roseGel: [
    ['Underarms', 120],
    ['Half Back', 230],
    ['Full Arms', 260],
    ['Half Legs', 280],
    ['Buttocks', 300],
    ['Full Arms & Underarms', 350],
    ['Stomach', 350],
    ['Full Back', 420],
    ['Full Legs', 420],
    ['Half Legs & Half Arms', 550],
    ['Half Legs, Full Arms & Underarms', 600],
    ['Bikini', 650],
    ['Full Legs, Full Arms & Underarms', 750],
    ['Full Body Excluding Bikini', 1500],
  ] as Array<[string, number]>,
  rica: [
    ['Underarms', 130],
    ['Half Back', 290],
    ['Full Arms', 290],
    ['Half Legs', 330],
    ['Buttocks', 300],
    ['Full Arms & Underarms', 410],
    ['Stomach', 420],
    ['Full Back', 490],
    ['Full Legs', 490],
    ['Half Legs & Half Arms', 600],
    ['Half Legs, Full Arms & Underarms', 680],
    ['Bikini', 680],
    ['Full Legs, Full Arms & Underarms', 800],
    ['Full Body Excluding Bikini', 1600],
  ] as Array<[string, number]>,
};

const waxing: CatalogCategory = {
  id: 'cat-03',
  name: 'Waxing',
  slug: 'waxing',
  description: 'Professional waxing services from honey to premium Rica wax',
  ordering: 3,
  subcategories: [
    waxingSub('Honey Wax', waxAreas.honey),
    waxingSub('Neuron Wax', waxAreas.neuron),
    waxingSub('Raaga Bridal Wax', waxAreas.raagaBridal),
    waxingSub('Rose Gel Wax', waxAreas.roseGel),
    waxingSub('Rica Wax', waxAreas.rica),
  ],
};

// ---------------------------------------------------------------------------
// 4. Manicure & Pedicure (15 items)
// ---------------------------------------------------------------------------
const manicurePedicure: CatalogCategory = {
  id: 'cat-04',
  name: 'Manicure & Pedicure',
  slug: 'manicure-pedicure',
  description: 'Professional hand and foot care with premium products',
  ordering: 4,
  subcategories: [
    sub('Manicure', [
      item('Aroma Magic Manicure', 600, DUR_MANICURE),
      item('Richelon Seashell Manicure', 600, DUR_MANICURE),
      item('FYC Bubble Gum Manicure', 600, DUR_MANICURE),
      item('FYC Sugar Candy Manicure', 600, DUR_MANICURE),
      item('O3+ Professional Manicure', 800, DUR_MANICURE),
    ]),
    sub('Pedicure', [
      item('FYC Sugar Candy Pedicure', 650, DUR_PEDICURE),
      item('FYC Bubble Gum Pedicure', 650, DUR_PEDICURE),
      item('Aroma Magic Pedicure', 750, DUR_PEDICURE),
      item('Richelon Seashell Pedicure', 750, DUR_PEDICURE),
      item('O3+ Professional Pedicure', 950, DUR_PEDICURE),
    ]),
    sub('Mani-Pedi Combo', [
      item('FYC Sugar Candy Mani-Pedi', 900, DUR_MANI_PEDI),
      item('FYC Bubble Gum Mani-Pedi', 900, DUR_MANI_PEDI),
      item('Aroma Magic Mani-Pedi', 1000, DUR_MANI_PEDI),
      item('Richelon Seashell Mani-Pedi', 1000, DUR_MANI_PEDI),
      item('OxyLife Aqua Mani-Pedi', 1100, DUR_MANI_PEDI),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 5. Bleach (13 items)
// ---------------------------------------------------------------------------

const bleach: CatalogCategory = {
  id: 'cat-05',
  name: 'Bleach',
  slug: 'bleach',
  description: 'Skin brightening bleach treatments for face and body',
  ordering: 5,
  subcategories: [
    sub('Oxy Bleach', [
      item('Oxy Bleach - Underarms', 140, DUR_BLEACH_SINGLE),
      item('Oxy Bleach - Half Back', 210, DUR_BLEACH_SINGLE),
      item('Oxy Bleach - Face & Neck', 320, DUR_BLEACH_SINGLE),
      item('Oxy Bleach - Stomach', 360, DUR_BLEACH_SINGLE),
      item('Oxy Bleach - Full Arms', 400, DUR_BLEACH_SINGLE),
      item('Oxy Bleach - Full Back', 410, DUR_BLEACH_SINGLE),
      item('Oxy Bleach - Full Legs', 600, DUR_BLEACH_SINGLE),
      item('Oxy Bleach - Full Body Excluding Bikini', 1800, DUR_BLEACH_FULL),
    ]),
    sub('FYC Korean Bleach', [
      item('FYC Korean Bleach - Face & Neck', 400, DUR_BLEACH_SINGLE),
      item('FYC Korean Bleach - Full Body Excluding Bikini', 2800, DUR_BLEACH_FULL),
    ]),
    sub('O3+ Meladerm Vitamin C Gel Bleach', [
      item('O3+ Meladerm Vitamin C Gel Bleach - Face & Neck', 500, DUR_BLEACH_SINGLE),
      item('O3+ Meladerm Vitamin C Gel Bleach - Full Arms', 900, DUR_BLEACH_SINGLE),
      item('O3+ Meladerm Vitamin C Gel Bleach - Full Body Excluding Bikini', 3000, DUR_BLEACH_FULL),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 6. De-Tan Pack (8 items)
// ---------------------------------------------------------------------------
const deTan: CatalogCategory = {
  id: 'cat-06',
  name: 'De-Tan Pack',
  slug: 'de-tan-pack',
  description: 'Professional de-tan treatments to remove sun damage and restore skin tone',
  ordering: 6,
  subcategories: [
    sub('Ozone D-Tan Cleanser', [
      item('Ozone D-Tan Cleanser - Face & Neck', 400, DUR_DE_TAN),
      item('Ozone D-Tan Cleanser - Hands & Feet', 450, DUR_DE_TAN),
      item('Ozone D-Tan Cleanser - Full Arms', 500, DUR_DE_TAN),
    ]),
    sub('Sara Oxy D-Tan Mask', [
      item('Sara Oxy D-Tan Mask - Face & Neck', 450, DUR_DE_TAN),
      item('Sara Oxy D-Tan Mask - Hands & Feet', 500, DUR_DE_TAN),
      item('Sara Oxy D-Tan Mask - Full Arms', 500, DUR_DE_TAN),
    ]),
    sub('O3+ Professional D-Tan Pack', [
      item('O3+ Professional D-Tan Pack - Face', 500, DUR_DE_TAN),
      item('O3+ Professional D-Tan Pack - Full Arms', 900, DUR_DE_TAN),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 7. Threading (5 items)
// ---------------------------------------------------------------------------
const threading: CatalogCategory = {
  id: 'cat-07',
  name: 'Threading',
  slug: 'threading',
  description: 'Precise hair removal threading for face and brows',
  ordering: 7,
  subcategories: [
    sub('Threading', [
      item('Eyebrows Threading', 50, DUR_THREADING),
      item('Upper Lips Threading', 50, DUR_THREADING),
      item('Forehead Threading', 50, DUR_THREADING),
      item('Chin Threading', 50, DUR_THREADING),
      item('Sidelocks Threading', 150, DUR_THREADING),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 8. Body Polishing & Massage (8 items)
// ---------------------------------------------------------------------------
const bodyPolishingMassage: CatalogCategory = {
  id: 'cat-08',
  name: 'Body Polishing & Massage',
  slug: 'body-polishing-massage',
  description: 'Full body polishing and relaxing massage treatments',
  ordering: 8,
  subcategories: [
    sub('Body Polishing', [
      item('Vedicline Kamayani Body Polishing', 2000, DUR_BODY_POLISHING),
      item('Ozone Intenso Hydrate Cocoa Body Polishing', 2400, DUR_BODY_POLISHING),
    ]),
    sub('Body Massage', [
      item('Specific Body Part Massage (10 Minutes)', 200, 10),
      item('Specific Body Part Massage (20 Minutes)', 400, 20),
      item('Face & Neck Massage (25 Minutes)', 500, 25),
      item('Specific Body Part Massage (30 Minutes)', 600, 30),
      item('Full Body Massage (45 Minutes)', 1000, 45),
      item('Full Body Massage (60 Minutes)', 1200, 60),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 9. Hair Root Touch-Up (6 items)
// ---------------------------------------------------------------------------
const hairRootTouchUp: CatalogCategory = {
  id: 'cat-09',
  name: 'Hair Root Touch-Up',
  slug: 'hair-root-touch-up',
  description: "Professional hair root touch-up with L'Oreal products",
  ordering: 9,
  subcategories: [
    sub("L'Oreal Professionnel (Majirel)", [
      item("L'Oreal Majirel - Front Part", 600, DUR_HAIR_ROOT_TOUCHUP),
      item("L'Oreal Majirel - Crown Area", 900, DUR_HAIR_ROOT_TOUCHUP),
      item("L'Oreal Majirel - Complete Touch-Up", 1200, DUR_HAIR_ROOT_TOUCHUP),
    ]),
    sub("L'Oreal Professionnel (iNOA)", [
      item("L'Oreal iNOA - Front Part", 700, DUR_HAIR_ROOT_TOUCHUP),
      item("L'Oreal iNOA - Crown Area", 1050, DUR_HAIR_ROOT_TOUCHUP),
      item("L'Oreal iNOA - Complete Touch-Up", 1500, DUR_HAIR_ROOT_TOUCHUP),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 10. Global Hair Coloring (6 items)
// ---------------------------------------------------------------------------
const globalHairColoring: CatalogCategory = {
  id: 'cat-10',
  name: 'Global Hair Coloring',
  slug: 'global-hair-coloring',
  description: "Full head hair coloring with premium L'Oreal products",
  ordering: 10,
  subcategories: [
    sub("L'Oreal Professionnel (Majirel)", [
      item("L'Oreal Majirel Coloring - Up To Shoulders", 3000, DUR_GLOBAL_COLORING),
      item("L'Oreal Majirel Coloring - Below Shoulders", 3500, DUR_GLOBAL_COLORING),
      item("L'Oreal Majirel Coloring - Up To Waist", 4000, DUR_GLOBAL_COLORING),
    ]),
    sub("L'Oreal Professionnel (iNOA)", [
      item("L'Oreal iNOA Coloring - Up To Shoulders", 3500, DUR_GLOBAL_COLORING),
      item("L'Oreal iNOA Coloring - Below Shoulders", 4000, DUR_GLOBAL_COLORING),
      item("L'Oreal iNOA Coloring - Up To Waist", 5000, DUR_GLOBAL_COLORING),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 11. Hair Spa (9 items)
// ---------------------------------------------------------------------------
const hairSpa: CatalogCategory = {
  id: 'cat-11',
  name: 'Hair Spa',
  slug: 'hair-spa',
  description: 'Deep conditioning hair spa treatments for healthy, shiny hair',
  ordering: 11,
  subcategories: [
    sub('Schwarzkopf Professional Hair Spa', [
      item('Schwarzkopf Hair Spa - Up To Shoulders', 700, DUR_HAIR_SPA),
      item('Schwarzkopf Hair Spa - Below Shoulders', 900, DUR_HAIR_SPA),
      item('Schwarzkopf Hair Spa - Up To Waist', 1200, DUR_HAIR_SPA),
    ]),
    sub("L'Oreal Professionnel Hair Spa", [
      item("L'Oreal Hair Spa - Up To Shoulders", 850, DUR_HAIR_SPA),
      item("L'Oreal Hair Spa - Below Shoulders", 1050, DUR_HAIR_SPA),
      item("L'Oreal Hair Spa - Up To Waist", 1350, DUR_HAIR_SPA),
    ]),
    sub('Keratin Hair Spa', [
      item('Keratin Hair Spa - Up To Shoulders', 850, DUR_HAIR_SPA),
      item('Keratin Hair Spa - Below Shoulders', 1050, DUR_HAIR_SPA),
      item('Keratin Hair Spa - Up To Waist', 1350, DUR_HAIR_SPA),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 12. Hair Transformation (6 items)
// ---------------------------------------------------------------------------
const hairTransformation: CatalogCategory = {
  id: 'cat-12',
  name: 'Hair Transformation',
  slug: 'hair-transformation',
  description: 'Professional hair smoothening and kerasmooth treatments',
  ordering: 12,
  subcategories: [
    sub('Hair Smoothening', [
      item('Hair Smoothening - Up To Shoulders', 4000, DUR_HAIR_TRANSFORMATION),
      item('Hair Smoothening - Below Shoulders', 4500, DUR_HAIR_TRANSFORMATION),
      item('Hair Smoothening - Up To Waist', 5500, DUR_HAIR_TRANSFORMATION),
    ]),
    sub('Kerasmooth', [
      item('Kerasmooth - Up To Shoulders', 5000, DUR_HAIR_TRANSFORMATION),
      item('Kerasmooth - Below Shoulders', 6000, DUR_HAIR_TRANSFORMATION),
      item('Kerasmooth - Up To Waist', 7000, DUR_HAIR_TRANSFORMATION),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// 13. Hair Treatments (6 items)
// ---------------------------------------------------------------------------
const hairTreatments: CatalogCategory = {
  id: 'cat-13',
  name: 'Hair Treatments',
  slug: 'hair-treatments',
  description: 'Advanced hair repair treatments including keratin and keraspa',
  ordering: 13,
  subcategories: [
    sub('Keratin Treatment', [
      item('Keratin Treatment - Up To Shoulders', 3000, DUR_HAIR_TREATMENT),
      item('Keratin Treatment - Below Shoulders', 3500, DUR_HAIR_TREATMENT),
      item('Keratin Treatment - Up To Waist', 4500, DUR_HAIR_TREATMENT),
    ]),
    sub('Keraspa Treatment', [
      item('Keraspa Treatment - Up To Shoulders', 1500, DUR_HAIR_TREATMENT),
      item('Keraspa Treatment - Below Shoulders', 3000, DUR_HAIR_TREATMENT),
      item('Keraspa Treatment - Up To Waist', 4500, DUR_HAIR_TREATMENT),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// Full catalog array
// ---------------------------------------------------------------------------
export const catalogData: CatalogCategory[] = [
  facials,
  cleanUps,
  waxing,
  manicurePedicure,
  bleach,
  deTan,
  threading,
  bodyPolishingMassage,
  hairRootTouchUp,
  globalHairColoring,
  hairSpa,
  hairTransformation,
  hairTreatments,
];

// ---------------------------------------------------------------------------
// ServiceCategory[] for mock-data compatibility
// ---------------------------------------------------------------------------
// Category images — stored locally in public/images/categories/
const CATEGORY_IMAGES: Record<string, string> = {
  facials: '/images/categories/facials.webp',
  'clean-ups': '/images/categories/clean-ups.webp',
  waxing: '/images/categories/waxing.webp',
  'manicure-pedicure': '/images/categories/manicure-pedicure.webp',
  bleach: '/images/categories/bleach.webp',
  'de-tan-pack': '/images/categories/de-tan-pack.webp',
  threading: '/images/categories/threading.webp',
  'body-polishing-massage': '/images/categories/body-polishing-massage.webp',
  'hair-root-touch-up': '/images/categories/hair-root-touch-up.webp',
  'global-hair-coloring': '/images/categories/global-hair-coloring.webp',
  'hair-spa': '/images/categories/hair-spa.webp',
  'hair-transformation': '/images/categories/hair-transformation.webp',
  'hair-treatments': '/images/categories/hair-treatments.webp',
};

export const catalogCategories: ServiceCategory[] = catalogData.map((cat) => {
  const totalItems = cat.subcategories.reduce((sum, sc) => sum + sc.items.length, 0);
  return {
    id: cat.id,
    name: cat.name,
    slug: cat.slug,
    image: CATEGORY_IMAGES[cat.slug] ?? `/images/categories/${cat.slug}.webp`,
    serviceCount: totalItems,
    ordering: cat.ordering,
  };
});

// ---------------------------------------------------------------------------
// Duration display helper
// ---------------------------------------------------------------------------
function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hrs}hr${hrs > 1 ? 's' : ''}`;
  return `${hrs}hr ${mins}min`;
}

// ---------------------------------------------------------------------------
// Deterministic rating by tier
// ---------------------------------------------------------------------------
function ratingForTier(tierIndex: number, totalTiers: number): number {
  if (totalTiers <= 1) return 4.5;
  if (totalTiers === 2) return tierIndex === 0 ? 4.5 : 4.7;
  // 3+ tiers
  if (tierIndex === 0) return 4.5;
  if (tierIndex === totalTiers - 1) return 4.7;
  return 4.6;
}

// ---------------------------------------------------------------------------
// Category → service image mapping (local files in public/images/services/)
// Kept as fallback when a subcategory-specific image is not available.
// ---------------------------------------------------------------------------
const categoryImages: Record<string, string> = {
  facials: '/images/services/facials.webp',
  'clean-ups': '/images/services/clean-ups.webp',
  waxing: '/images/services/waxing.webp',
  'manicure-pedicure': '/images/services/manicure-pedicure.webp',
  bleach: '/images/services/bleach.webp',
  'de-tan-pack': '/images/services/de-tan-pack.webp',
  threading: '/images/services/threading.webp',
  'body-polishing-massage': '/images/services/body-polishing-massage.webp',
  'hair-root-touch-up': '/images/services/hair-root-touch-up.webp',
  'global-hair-coloring': '/images/services/global-hair-coloring.webp',
  'hair-spa': '/images/services/hair-spa.webp',
  'hair-transformation': '/images/services/hair-transformation.webp',
  'hair-treatments': '/images/services/hair-treatments.webp',
};

// ---------------------------------------------------------------------------
// Subcategory → service image mapping (keyed by "categorySlug/subcategorySlug")
// Takes priority over categoryImages for per-subcategory visual distinction.
// ---------------------------------------------------------------------------
const subcategoryImages: Record<string, string> = {
  // Facials
  'facials/basic': '/images/services/facials-basic.webp',
  'facials/standard': '/images/services/facials-standard.webp',
  'facials/premium': '/images/services/facials-premium.webp',

  // Clean Ups
  'clean-ups/basic': '/images/services/cleanups-basic.webp',
  'clean-ups/standard': '/images/services/cleanups-standard.webp',
  'clean-ups/premium': '/images/services/cleanups-premium.webp',

  // Waxing
  'waxing/honey-wax': '/images/services/waxing-honey.webp',
  'waxing/neuron-wax': '/images/services/waxing-neuron.webp',
  'waxing/raaga-bridal-wax': '/images/services/waxing-bridal.webp',
  'waxing/rose-gel-wax': '/images/services/waxing-rose-gel.webp',
  'waxing/rica-wax': '/images/services/waxing-rica.webp',

  // Manicure & Pedicure
  'manicure-pedicure/manicure': '/images/services/manicure.webp',
  'manicure-pedicure/pedicure': '/images/services/pedicure.webp',
  'manicure-pedicure/mani-pedi-combo': '/images/services/mani-pedi-combo.webp',

  // Bleach
  'bleach/oxy-bleach': '/images/services/bleach-oxy.webp',
  'bleach/fyc-korean-bleach': '/images/services/bleach-korean.webp',
  'bleach/o3-meladerm-vitamin-c-gel-bleach': '/images/services/bleach-vitamin-c.webp',

  // De-Tan Pack
  'de-tan-pack/ozone-d-tan-cleanser': '/images/services/detan-ozone.webp',
  'de-tan-pack/sara-oxy-d-tan-mask': '/images/services/detan-sara.webp',
  'de-tan-pack/o3-professional-d-tan-pack': '/images/services/detan-o3.webp',

  // Threading
  'threading/threading': '/images/services/threading.webp',

  // Body Polishing & Massage
  'body-polishing-massage/body-polishing': '/images/services/body-polishing.webp',
  'body-polishing-massage/body-massage': '/images/services/body-massage.webp',

  // Hair Root Touch-Up
  'hair-root-touch-up/l-oreal-professionnel-majirel': '/images/services/hair-touchup-majirel.webp',
  'hair-root-touch-up/l-oreal-professionnel-inoa': '/images/services/hair-touchup-inoa.webp',

  // Global Hair Coloring
  'global-hair-coloring/l-oreal-professionnel-majirel':
    '/images/services/hair-coloring-majirel.webp',
  'global-hair-coloring/l-oreal-professionnel-inoa': '/images/services/hair-coloring-inoa.webp',

  // Hair Spa
  'hair-spa/schwarzkopf-professional-hair-spa': '/images/services/hair-spa-schwarzkopf.webp',
  'hair-spa/l-oreal-professionnel-hair-spa': '/images/services/hair-spa-loreal.webp',
  'hair-spa/keratin-hair-spa': '/images/services/hair-spa-keratin.webp',

  // Hair Transformation
  'hair-transformation/hair-smoothening': '/images/services/hair-smoothening.webp',
  'hair-transformation/kerasmooth': '/images/services/hair-kerasmooth.webp',

  // Hair Treatments
  'hair-treatments/keratin-treatment': '/images/services/keratin-treatment.webp',
  'hair-treatments/keraspa-treatment': '/images/services/keraspa-treatment.webp',
};

const defaultImage = '/images/services/default.webp';

// ---------------------------------------------------------------------------
// Per-item image resolver — picks the right image based on item name keywords
// ---------------------------------------------------------------------------
function resolveItemImage(itemName: string, categorySlug: string, subcategorySlug: string): string {
  const name = itemName.toLowerCase();

  // --- Waxing: per-item slug lookup first, then keyword fallback ----------
  if (categorySlug === 'waxing') {
    const slug = toSlug(itemName);
    const waxImg = getWaxingItemImage(slug);
    if (waxImg) return waxImg;
    if (name.includes('full body')) return '/images/services/waxing/full-body.webp';
    if (/full legs.*full arms/.test(name) || name.includes('full legs, full arms'))
      return '/images/services/waxing/combo-full.webp';
    if (/half legs.*full arms/.test(name) || name.includes('half legs, full arms'))
      return '/images/services/waxing/combo-large.webp';
    if (/half legs.*half arms/.test(name) || name.includes('half legs & half arms'))
      return '/images/services/waxing/half-legs-half-arms.webp';
    if (/full arms.*underarms/.test(name) || name.includes('full arms & underarms'))
      return '/images/services/waxing/full-arms-underarms.webp';
    if (name.includes('full arms')) return '/images/services/waxing/full-arms.webp';
    if (name.includes('half arms')) return '/images/services/waxing/full-arms.webp';
    if (name.includes('full legs')) return '/images/services/waxing/full-legs.webp';
    if (name.includes('half legs')) return '/images/services/waxing/half-legs.webp';
    if (name.includes('full back')) return '/images/services/waxing/full-back.webp';
    if (name.includes('half back')) return '/images/services/waxing/half-back.webp';
    if (name.includes('underarms')) return '/images/services/waxing/underarms.webp';
    if (name.includes('stomach')) return '/images/services/waxing/stomach.webp';
    if (name.includes('buttocks')) return '/images/services/waxing/buttocks.webp';
    if (name.includes('bikini')) return '/images/services/waxing/bikini.webp';
  }

  // Per-item facial images (slug-based lookup)
  if (categorySlug === 'facials') {
    const slug = toSlug(itemName);
    const meta = facialItemImages[slug];
    if (meta) return meta.src;
  }

  // Per-item manicure & pedicure images (slug-based lookup)
  if (categorySlug === 'manicure-pedicure') {
    const slug = toSlug(itemName);
    const img = maniPediItemImages[slug];
    if (img) return img;
  }

  // --- Clean Ups: per-item slug lookup first ------------------------------
  if (categorySlug === 'clean-ups') {
    const slug = toSlug(itemName);
    const img = cleanupItemImages[slug];
    if (img) return img;
  }

  // --- Facials & Clean Ups: match treatment-type keywords -----------------
  if (categorySlug === 'facials' || categorySlug === 'clean-ups') {
    if (/bridal|kumkumadi/.test(name)) return '/images/services/facials/bridal.webp';
    if (/korean|rice water/.test(name)) return '/images/services/facials/korean.webp';
    if (/hydra/.test(name)) return '/images/services/facials/hydra.webp';
    if (/vitamin c|collagen/.test(name)) return '/images/services/facials/vitamin-c.webp';
    if (/gold/.test(name)) return '/images/services/facials/gold.webp';
    if (/anti[- ]ageing/.test(name)) return '/images/services/facials/anti-ageing.webp';
    if (/whitening|blanch|melafade|alpha/.test(name))
      return '/images/services/facials/whitening.webp';
    if (/anti[- ]tan|d[- ]tan|un[- ]tan|de[- ]tan/.test(name))
      return '/images/services/facials/anti-tan.webp';
    if (/wine/.test(name)) return '/images/services/facials/wine.webp';
    if (/fruit|papaya|green apple/.test(name)) return '/images/services/facials/fruit.webp';
    if (/oxy|express|professional/.test(name)) return '/images/services/facials/oxy.webp';
    if (/mint|cool|hydravitals|puravitals|herbal/.test(name))
      return '/images/services/facials/herbal.webp';
    if (/glow|insta glow|skin glow|shine|brightening|radiance|tightening/.test(name))
      return '/images/services/facials/glow.webp';
    // Default for facials/clean-ups
    return '/images/services/facials/glow.webp';
  }

  // --- Bleach: per-item slug lookup first, then keyword fallback ----------
  if (categorySlug === 'bleach') {
    const slug = toSlug(itemName);
    const img = bleachItemImages[slug];
    if (img) return img;
  }

  // --- Bleach: match body-part keywords -----------------------------------
  if (categorySlug === 'bleach') {
    if (name.includes('full body')) return '/images/services/bleach/full-body.webp';
    if (name.includes('face') || name.includes('neck'))
      return '/images/services/bleach/face-neck.webp';
    if (name.includes('full arms')) return '/images/services/bleach/full-arms.webp';
    if (name.includes('back')) return '/images/services/bleach/back.webp';
    if (name.includes('stomach')) return '/images/services/bleach/stomach.webp';
    if (name.includes('full legs')) return '/images/services/bleach/full-legs.webp';
    if (name.includes('underarms')) return '/images/services/bleach/underarms.webp';
  }

  // --- De-Tan Pack: per-item slug lookup first, then subcategory fallback --
  if (categorySlug === 'de-tan-pack') {
    const slug = toSlug(itemName);
    const img = detanItemImages[slug];
    if (img) return img;
    const subcatKey = `${categorySlug}/${subcategorySlug}`;
    return subcategoryImages[subcatKey] ?? categoryImages[categorySlug] ?? defaultImage;
  }

  // --- Threading: per-item slug lookup first, then keyword fallback -------
  if (categorySlug === 'threading') {
    const slug = toSlug(itemName);
    const img = threadingItemImages[slug];
    if (img) return img;
  }

  // --- Threading: match face-area keywords --------------------------------
  if (categorySlug === 'threading') {
    if (name.includes('eyebrow')) return '/images/services/threading/eyebrows.webp';
    if (name.includes('upper lip')) return '/images/services/threading/upper-lips.webp';
    if (name.includes('forehead')) return '/images/services/threading/forehead.webp';
    if (name.includes('chin')) return '/images/services/threading/chin.webp';
    if (name.includes('sidelock')) return '/images/services/threading/sidelocks.webp';
  }

  // --- Body Polishing & Massage -------------------------------------------
  if (categorySlug === 'body-polishing-massage') {
    const slug = toSlug(itemName);
    const img = bodyPolishingMassageItemImages[slug];
    if (img) return img;
    if (name.includes('polishing')) return '/images/services/body-polishing.webp';
    if (name.includes('full body')) return '/images/services/body-massage.webp';
    if (name.includes('face') || name.includes('neck')) return '/images/services/facials/glow.webp';
    if (name.includes('specific')) return '/images/services/body-massage.webp';
  }

  // --- Manicure & Pedicure: keep existing subcategory images --------------
  if (categorySlug === 'manicure-pedicure') {
    const subcatKey = `${categorySlug}/${subcategorySlug}`;
    return subcategoryImages[subcatKey] ?? categoryImages[categorySlug] ?? defaultImage;
  }

  // --- All Hair categories: match hair length keywords --------------------
  const hairCategories = [
    'hair-root-touch-up',
    'global-hair-coloring',
    'hair-spa',
    'hair-transformation',
    'hair-treatments',
  ];
  if (hairCategories.includes(categorySlug)) {
    if (name.includes('front part')) return '/images/services/hair/front-part.webp';
    if (name.includes('crown')) return '/images/services/hair/crown.webp';
    if (name.includes('complete')) return '/images/services/hair/complete.webp';
    if (name.includes('below shoulders')) return '/images/services/hair/below-shoulders.webp';
    if (name.includes('up to shoulders') || (name.includes('shoulders') && !name.includes('below')))
      return '/images/services/hair/shoulders.webp';
    if (name.includes('waist')) return '/images/services/hair/waist.webp';
  }

  // --- Fallback chain: subcategory image → category image → default -------
  const subcatKey = `${categorySlug}/${subcategorySlug}`;
  return subcategoryImages[subcatKey] ?? categoryImages[categorySlug] ?? defaultImage;
}

// ---------------------------------------------------------------------------
// Flatten catalog into HomeService[]
// ---------------------------------------------------------------------------
function generateHomeServices(): HomeService[] {
  const result: HomeService[] = [];
  let counter = 0;

  for (const category of catalogData) {
    const totalTiers = category.subcategories.length;

    for (let tierIndex = 0; tierIndex < totalTiers; tierIndex++) {
      const subcategory = category.subcategories[tierIndex];
      const tierRating = ratingForTier(tierIndex, totalTiers);

      for (const catalogItem of subcategory.items) {
        // Per-item image based on keyword matching, with subcategory/category fallbacks
        const image = resolveItemImage(catalogItem.name, category.slug, subcategory.slug);
        counter++;
        const id = `svc-${String(counter).padStart(3, '0')}`;
        const durationDisplay = formatDuration(catalogItem.duration);

        result.push({
          id,
          name: catalogItem.name,
          slug: catalogItem.slug,
          category: category.name,
          categorySlug: category.slug,
          subcategory: subcategory.name,
          description: `${catalogItem.name} - professional ${category.name.toLowerCase()} service by Glamornate`,
          benefits: [
            'Professional service',
            'Premium products',
            'Trained beauticians',
            'Hygienic tools',
          ],
          basePrice: catalogItem.price,
          currency: 'INR',
          duration: durationDisplay,
          durationMinutes: catalogItem.duration,
          image,
          images: [image],
          isLandscapeImage:
            category.slug === 'facials'
              ? (facialItemImages[toSlug(catalogItem.name)]?.isLandscape ?? false)
              : false,
          rating: tierRating,
          reviewCount: catalogItem.price * 2,
          tags: [category.slug, subcategory.slug],
          bookingCount: catalogItem.price * 5,
          cities: ['Jammu'],
          recommendedFor: 'women',
          isActive: true,
          createdAt: '2025-06-01T00:00:00Z',
        });
      }
    }
  }

  return result;
}

export const catalogServices: HomeService[] = generateHomeServices();

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------
export function getCategoryBySlug(slug: string): CatalogCategory | undefined {
  return catalogData.find((c) => c.slug === slug);
}

export function getServicesByCategory(categorySlug: string): HomeService[] {
  return catalogServices.filter((s) => s.categorySlug === categorySlug);
}

export function getServiceById(id: string): HomeService | undefined {
  return catalogServices.find((s) => s.id === id);
}

export function getSubcategoriesByCategory(categorySlug: string): CatalogSubcategory[] {
  const cat = getCategoryBySlug(categorySlug);
  return cat ? cat.subcategories : [];
}

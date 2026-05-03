export interface FacialImageMeta {
  src: string
  isLandscape: boolean
}

export const facialItemImages: Record<string, FacialImageMeta> = {
  // === Basic (8) ===
  'vlcc-insta-glow-facial': { src: '/images/services/facials/items/basic/vlcc-insta-glow-facial.webp', isLandscape: false },
  'vlcc-skin-tightening-facial': { src: '/images/services/facials/items/basic/vlcc-skin-tightening-facial.webp', isLandscape: false },
  'vlcc-papaya-fruit-facial': { src: '/images/services/facials/items/basic/vlcc-papaya-fruit-facial.webp', isLandscape: false },
  'vlcc-anti-tan-facial': { src: '/images/services/facials/items/basic/vlcc-anti-tan-facial.webp', isLandscape: false },
  'oxylife-professional-facial': { src: '/images/services/facials/items/basic/oxylife-professional-facial.webp', isLandscape: false },
  'aroma-magic-fruit-facial': { src: '/images/services/facials/items/basic/aroma-magic-fruit-facial.webp', isLandscape: false },
  'astaberry-wine-facial': { src: '/images/services/facials/items/basic/astaberry-wine-facial.webp', isLandscape: false },
  'raaga-professional-express-facial': { src: '/images/services/facials/items/basic/raaga-professional-express-facial.webp', isLandscape: false },

  // === Standard (14) ===
  'ozone-skin-whitening-facial': { src: '/images/services/facials/items/standard/ozone-skin-whitening-facial.webp', isLandscape: false },
  'sara-green-apple-facial': { src: '/images/services/facials/items/standard/sara-green-apple-facial.webp', isLandscape: false },
  'aroma-magic-skin-glow-facial': { src: '/images/services/facials/items/standard/aroma-magic-skin-glow-facial.webp', isLandscape: false },
  'oxyglow-professional-fruit-facial': { src: '/images/services/facials/items/standard/oxyglow-professional-fruit-facial.webp', isLandscape: true },
  'oxyglow-professional-bridal-facial': { src: '/images/services/facials/items/standard/oxyglow-professional-bridal-facial.webp', isLandscape: true },
  'vedic-line-cool-mint-facial': { src: '/images/services/facials/items/standard/vedic-line-cool-mint-facial.webp', isLandscape: false },
  'lotus-professional-hydravitals-facial': { src: '/images/services/facials/items/standard/lotus-professional-hydravitals-facial.webp', isLandscape: false },
  'lotus-professional-puravitals-facial': { src: '/images/services/facials/items/standard/lotus-professional-puravitals-facial.webp', isLandscape: false },
  'aroma-magic-bridal-facial': { src: '/images/services/facials/items/standard/aroma-magic-bridal-facial.webp', isLandscape: false },
  'vedic-line-alpha-whitening-skin-care-facial': { src: '/images/services/facials/items/standard/vedic-line-alpha-whitening-skin-care-facial.webp', isLandscape: false },
  'velvetree-korean-facial': { src: '/images/services/facials/items/standard/velvetree-korean-facial.webp', isLandscape: false },
  'fyc-d-tan-facial': { src: '/images/services/facials/items/standard/fyc-d-tan-facial.webp', isLandscape: false },
  'fyc-wine-facial': { src: '/images/services/facials/items/standard/fyc-wine-facial.webp', isLandscape: false },
  'ozone-d-tan-facial': { src: '/images/services/facials/items/standard/ozone-d-tan-facial.webp', isLandscape: true },

  // === Premium (18) ===
  'vedic-line-kumkumadi-tailam-bridal-facial': { src: '/images/services/facials/items/premium/vedic-line-kumkumadi-tailam-bridal-facial.webp', isLandscape: false },
  'o3-professional-whitening-facial': { src: '/images/services/facials/items/premium/o3-professional-whitening-facial.webp', isLandscape: false },
  'organic-harvest-brightening-lightening-facial': { src: '/images/services/facials/items/premium/organic-harvest-brightening-lightening-facial.webp', isLandscape: false },
  'o3-professional-shine-glow-facial': { src: '/images/services/facials/items/premium/o3-professional-shine-glow-facial.webp', isLandscape: false },
  'richelon-iris-collagen-boosting-facial': { src: '/images/services/facials/items/premium/richelon-iris-collagen-boosting-facial.webp', isLandscape: false },
  'fyc-vitamin-c-facial': { src: '/images/services/facials/items/premium/fyc-vitamin-c-facial.webp', isLandscape: false },
  'paragon-melafade-facial': { src: '/images/services/facials/items/premium/paragon-melafade-facial.webp', isLandscape: false },
  'o3-professional-d-tan-facial': { src: '/images/services/facials/items/premium/o3-professional-d-tan-facial.webp', isLandscape: false },
  'o3-professional-anti-ageing-facial': { src: '/images/services/facials/items/premium/o3-professional-anti-ageing-facial.webp', isLandscape: false },
  'o3-professional-gold-infusion-facial': { src: '/images/services/facials/items/premium/o3-professional-gold-infusion-facial.webp', isLandscape: false },
  'o3-professional-whitening-facial-tan-pigmented-skin': { src: '/images/services/facials/items/premium/o3-professional-whitening-facial-tan-pigmented-skin.webp', isLandscape: false },
  'o3-professional-bridal-radiance-facial': { src: '/images/services/facials/items/premium/o3-professional-bridal-radiance-facial.webp', isLandscape: false },
  'organic-harvest-hydra-facial': { src: '/images/services/facials/items/premium/organic-harvest-hydra-facial.webp', isLandscape: false },
  'jeannot-ceuticals-hydra-boost-facial': { src: '/images/services/facials/items/premium/jeannot-ceuticals-hydra-boost-facial.webp', isLandscape: false },
  'kanpeki-un-tan-facial': { src: '/images/services/facials/items/premium/kanpeki-un-tan-facial.webp', isLandscape: false },
  'fyc-hydra-boost-facial': { src: '/images/services/facials/items/premium/fyc-hydra-boost-facial.webp', isLandscape: false },
  'fyc-korean-rice-water-facial': { src: '/images/services/facials/items/premium/fyc-korean-rice-water-facial.webp', isLandscape: false },
  'kanpeki-blanch-facial': { src: '/images/services/facials/items/premium/kanpeki-blanch-facial.webp', isLandscape: false },
}

# Okiru Coffee — Product Page Design Spec

## Overview
Product page template for Okiru Coffee Roasters' 3 coffees (Tora, Sensei, Kujaku). Dark premium aesthetic, conversion-first, mobile-first responsive design.

## Design Direction
- **Theme**: Dark & Premium (Okiru scheme-8)
- **Layout**: Full-bleed scroll hero → side-by-side content sections
- **Philosophy**: Information-led (not image-led). Flavor data, origin story, and brew guides take centre stage. Packaging image present but secondary.

## Color Palette (from Okiru Shopify theme)
| Token | Value | Usage |
|-------|-------|-------|
| Background | `#2d2926` | Primary bg |
| Background dark | `#252220` / `#1a1714` | Hero gradient, stats bar |
| Foreground | `#f5f2ef` | Primary text |
| Accent | `#fd803c` | CTA, labels, interactive |
| Accent hover | `#e5733a` | Button hover |
| Border | `#4a4542` | Dividers, cards |
| Surface | `#3d3835` | Cards, info cells |

## Typography
- **Headings**: Alegreya Sans (700/800)
- **Body**: Lato (300/400/700)
- **Hero name**: 120px desktop / 64px mobile, 800 weight, letter-spacing: 16px/6px
- **Section titles**: 24px, Alegreya Sans 700
- **Labels**: 9px uppercase, letter-spacing: 3-4px, `#fd803c`
- **Body text**: 12-13px, Lato, opacity 0.7 for secondary

## Spacing
- **Desktop page max-width**: 1200px (1400px on large screens)
- **Section padding**: 48px vertical, 40px horizontal
- **Mobile padding**: 32px vertical, 20px horizontal
- **Border radius**: 0px everywhere (square aesthetic)

## Page Sections (top to bottom)

### 1. Navigation
- Fixed top, blurred bg (`rgba(45,41,38,0.95)`)
- Desktop: logo + text links (Shop, Our Story, Brew Guide, Cart)
- Mobile: logo + hamburger/heart/cart icons

### 2. Hero (full-bleed)
- `min-height: 85vh` desktop, `70vh` mobile
- Gradient bg: `#1a1714` → `#2d2926`
- Subtle radial orange glow
- Content: origin label → giant name → process/variety → divider → flavor quote (italic Georgia) → star rating + review count
- No product image in hero

### 3. Stats Bar
- Full-width, `#252220` bg
- 4 items: Roast, Body, Acidity, Sweetness
- Orange labels, white values
- Grid on mobile (4-col)

### 4. Product Image + Buy Box (side by side)
- **Desktop**: 2-column grid (image left, buy right)
- **Mobile**: stacked — buy box FIRST, image second (conversion priority)
- **Image**: packaging photo in dark bg with subtle shadow
- **Buy box contains**:
  - Subscribe & Save toggle (pre-selected, 15% off)
  - One-time purchase option
  - Frequency selector (2wk / 4wk / 6wk)
  - Size variants (250g / 500g / 1kg)
  - Add to Cart button (full-width, `#fd803c`)
  - Express checkout (Apple Pay + Shop Pay)
  - Trust line: "Roasted to order · Ships in 48hrs · Free over ₹999"

### 5. Flavor Profile + Origin Grid (side by side)
- **Left**: Stumptown-style flavor sliders (Body 9/10, Sweetness 5/10, Acidity 2/10, Bitterness 5/10, Intensity 8/10) + tasting note tags
- **Right**: 2x3 info grid (Origin, Variety, Process, Roast Level, Altitude, Packaging)
- Mobile: stacked

### 6. Brew Methods + Details (side by side)
- **Left**: 2x2 brew method cards with icons + "Recommended" / "Great" labels
- **Right**: Accordion details (About this coffee, Shipping & Freshness, Certifications)
- Mobile: stacked

### 7. Reviews (full-width)
- 4-column grid desktop, 1-column mobile
- Rating header: 4.8 + stars + count
- Review cards: stars, italic quote, author + "Verified" badge
- "See all X reviews →" link

### 8. Sticky Mobile Buy Bar
- Fixed bottom, appears on scroll past main CTA
- Shows: product name + variant, subscription price, Add to Cart button
- Desktop: hidden

## Conversion Features (from D2C research)
- Subscribe & Save pre-selected (biggest conversion lever)
- Express checkout (Apple Pay, Shop Pay) on product page
- Star rating above the fold (2x conversion impact vs buried)
- Sticky mobile buy bar (no coffee D2C does this — competitive advantage)
- Trust signals near CTA
- Ethical urgency: "Roasted to order", "Ships in 48hrs" (real, not fake)
- Progressive disclosure via accordions

## Products to Support
| Name | Process | Roast | Flavors | Body | Acidity | Best For |
|------|---------|-------|---------|------|---------|----------|
| Tora | Monsoon Malabar | Med-Dark | Chocolate, roasted nuts, spice, malt | High | Low | Espresso, moka pot, french press |
| Sensei | Honey sun-dried | Light-Medium | Grape, orange marmalade, hazelnut | Light | High | Filter, french press, aeropress, pour-over |
| Kujaku | Washed | Medium | Caramel, cherry, white chocolate | Medium | Medium | All methods |

All: SLN795 Arabica, Chikmagalur, roasted on demand, 250g/500g/1kg, FSSAI 12125801000304.

## Reference Files
- Live mockup: `.superpowers/brainstorm/27667-1773133360/responsive-v2.html`
- Okiru theme tokens: `/Users/rohanmalik/Okiru/theme-2/config/settings_data.json`
- D2C research: `/Users/rohanmalik/Projects/FIGSOR/d2c-coffee-product-page-research.md`

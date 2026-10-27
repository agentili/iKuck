---
version: alpha
name: A tavola
description: "Un sistema locale-first per decidere cosa cucinare con ciò che è già in casa."
colors:
  porcelain: "#F7F7EC"
  ink: "#364037"
  basil: "#556C4D"
  basilDark: "#556C4D"
  berry: "#76643F"
  berryDark: "#5C4E2E"
  sage: "#E5ECDD"
  mist: "#EEE7D5"
  tomato: "#824D42"
  tomatoDark: "#5D3D34"
  ocean: "#496B73"
  oceanSoft: "#E2EBEA"
  purple: "#6C4A92"
  purpleSoft: "#E5E8CD"
  yolk: "#E6CC83"
  inkMuted: "#5E685E"
  darkPage: "#22241D"
  darkSurface: "#2C2E25"
  darkInk: "#F3F4E6"
  darkInkMuted: "#C3C7B4"
  darkBasil: "#DBC78D"
  darkBasilDark: "#C4DDB1"
  darkBerry: "#DBC78D"
  darkBerryDark: "#ECDFB1"
  darkBerrySoft: "#4A412B"
  darkSage: "#333F2D"
  darkMist: "#38362B"
  darkTomato: "#DC967F"
  darkTomatoDark: "#EFB6A2"
  darkTomatoSoft: "#4A302B"
  onYolk: "#22241D"
typography:
  display:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "clamp(2rem, 4vw, 2.75rem)"
    fontWeight: 400
    letterSpacing: "-0.04em"
  body-md:
    fontFamily: "Bricolage Grotesque Variable, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 450
    lineHeight: 1.55
rounded:
  control: "12px"
  panel: "20px"
  feature: "28px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
---

# Overview

A tavola is a local-first kitchen tool. Its default visual identity pairs soft pistachio cream with olive, lemon and muted tomato accents. The profile lets users choose among four palettes: Pistacchio e limone, Pesca e corallo, Lavanda e mirtillo, and Mare e terracotta.

# Colors and themes

Pistacchio e limone is the default light palette: page #F7F7EC, ink #364037, olive #76643F, pistachio #E5ECDD, and lemon #E6CC83. The other palettes reuse the same semantic roles with peach/coral, lavender/blueberry, and sea/terracotta tones. Recipe categories retain their coordinated pastel surfaces.

The dark theme has a coordinated set of low-glare page, surface, text and accent colors for each palette. Warning foregrounds and focus rings keep dedicated high-contrast tokens.

frontend/src/theme/palettes.css stores all four palette definitions. frontend/src/domain/colorPalette.ts owns their stable identifiers and the device-only preference API; profile settings save the choice and startup applies it before rendering. frontend/src/index.css maps the selected palette to --ik-* semantic tokens and Tailwind utility colors. frontend/src/theme-editorial.css owns layout and component presentation. Both themes retain color contrast when utility classes such as bg-white, text-gray-950, bg-emerald-700 and bg-amber-400 are used.

# Typography and shapes

Use Bricolage Grotesque Variable for interface copy. Use Georgia for the A tavola wordmark and editorial Home and page headings. Headlines are left-aligned and compact. Controls use 12px radii, panels use 20px, and major feature surfaces use 28px.

# Layout

Desktop uses a single horizontal header with the brand, Cucina, Ricette, Dispensa, Spesa and Diario. Account controls stay at the right of the header. Mobile uses a fixed five-item bottom navigation with safe-area clearance. The Home plate illustration and shortcuts are hidden on phones; the current recipe idea begins near the top of the page.

Account and recovery routes use centered, readable widths without forcing the viewport to full height. Shared sections, forms and dialogs use the same surface, border, control and focus tokens across routes.

# Component interface

- .ik-page is the shared page wrapper; .account-page narrows profile and house pages.
- .auth-page centers authentication and recovery content without adding viewport-height space.
- .editorial-panel gives a shared section or form panel its surface, border and radius.
- .editorial-form lays out labels and controls consistently; .ik-input is the reusable single-control style.
- .ik-button-primary is the filled progress action.
- .ik-quick-add-dialog is the shared dialog surface.
- .ik-surface--quiet is for secondary content, .ik-action-panel is for the recipe decision, and .ik-ai-panel retains the same palette for private account features.

# Accessibility

Keep visible keyboard focus, 44px minimum touch targets, safe-area clearance, reduced-motion support, semantic status, and readable contrast in both themes. Avoid stacked shadows, glass effects and decorative gradients.

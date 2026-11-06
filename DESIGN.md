---
version: alpha
name: iKuck cucina domestica
description: "Un sistema locale-first per decidere cosa cucinare con ciò che è già in casa."
colors:
  primary: "#183028" # Compatibility alias for ink.
  ink: "#183028"
  porcelain: "#FAFBF7"
  basil: "#247A4A"
  basilDark: "#165C35"
  sage: "#E1ECE4"
  mist: "#F1F3ED"
  tomato: "#B9382A"
  yolk: "#F2BE3E"
  inkMuted: "#52665B"
  darkPage: "#101613"
  darkSurface: "#171E1A"
  darkInk: "#E8EFE9"
  darkInkMuted: "#9FB0A7"
  darkBasil: "#45B877"
  darkBasilDark: "#3AA16A"
  darkSage: "#1C2823"
  darkMist: "#1A211D"
  darkYolkSoft: "#3A2F0E"
  tomatoSoft: "#FDE9E5"
  darkTomato: "#FF8A7A"
  darkTomatoSoft: "#3A1512"
  onYolk: "#183028"
  recipeCategory: "#FCD34D"
  darkRecipeCategory: "#725000"
  darkWarnInk: "#F2CA7A"
typography:
  h1:
    fontFamily: "Bricolage Grotesque Variable, system-ui, sans-serif"
    fontSize: "3.75rem"
    fontWeight: 800
    lineHeight: 1.04
    letterSpacing: "-0.03em"
  h2:
    fontFamily: "Bricolage Grotesque Variable, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  body-md:
    fontFamily: "Bricolage Grotesque Variable, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 450
    lineHeight: 1.55
  # SOUS-CHEF chat typography
  chat-title:
    fontFamily: "Bricolage Grotesque Variable, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
  chat-body:
    fontFamily: "Bricolage Grotesque Variable, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 450
    lineHeight: 1.55
  chat-bubble:
    fontFamily: "Bricolage Grotesque Variable, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  chat-quick-reply:
    fontFamily: "Bricolage Grotesque Variable, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  control: "12px"
  panel: "20px"
  feature: "28px"
  bubble: "20px"
  pill: "100px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.basil}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.basilDark}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "48px"
  action-panel:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.feature}"
    padding: "16px"
  recipe-hero-category:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.recipeCategory}"
  recipe-hero-category-dark:
    backgroundColor: "{colors.darkInk}"
    textColor: "{colors.darkRecipeCategory}"
  ready-recipe:
    backgroundColor: "{colors.sage}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "16px"
  one-purchase-recipe:
    backgroundColor: "{colors.yolk}"
    textColor: "{colors.onYolk}"
    rounded: "{rounded.panel}"
    padding: "16px"
  error-action:
    backgroundColor: "{colors.tomato}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  quiet-surface:
    backgroundColor: "{colors.mist}"
    textColor: "{colors.inkMuted}"
    rounded: "{rounded.panel}"
    padding: "16px"
  outlined-surface:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "16px"
  button-primary-dark:
    backgroundColor: "{colors.darkBasil}"
    textColor: "{colors.darkPage}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "48px"
  button-primary-dark-hover:
    backgroundColor: "{colors.darkBasilDark}"
    textColor: "{colors.darkPage}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "48px"
  action-panel-dark:
    backgroundColor: "{colors.darkInk}"
    textColor: "{colors.darkPage}"
    rounded: "{rounded.feature}"
    padding: "16px"
  ready-recipe-dark:
    backgroundColor: "{colors.darkSage}"
    textColor: "{colors.darkInk}"
    rounded: "{rounded.panel}"
    padding: "16px"
  one-purchase-recipe-dark:
    backgroundColor: "{colors.darkYolkSoft}"
    textColor: "{colors.darkWarnInk}"
    rounded: "{rounded.panel}"
    padding: "16px"
  error-action-dark:
    backgroundColor: "{colors.darkTomato}"
    textColor: "{colors.darkPage}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  error-surface-dark:
    backgroundColor: "{colors.darkTomatoSoft}"
    textColor: "{colors.darkTomato}"
    rounded: "{rounded.panel}"
    padding: "16px"
  quiet-surface-dark:
    backgroundColor: "{colors.darkMist}"
    textColor: "{colors.darkInkMuted}"
    rounded: "{rounded.panel}"
    padding: "16px"
  outlined-surface-dark:
    backgroundColor: "{colors.darkSurface}"
    textColor: "{colors.darkInk}"
    rounded: "{rounded.panel}"
    padding: "16px"
  # SOUS-CHEF chat components
  chat-bubble-assistant:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.ink}"
    rounded: "{rounded.bubble}"
    padding: "14px 18px"
  chat-bubble-user:
    backgroundColor: "{colors.basilDark}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.bubble}"
    padding: "14px 18px"
  chat-bubble-recipe:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.ink}"
    rounded: "{rounded.feature}"
    padding: "0"
  chat-bubble-error:
    backgroundColor: "{colors.tomatoSoft}"
    textColor: "{colors.tomato}"
    rounded: "{rounded.panel}"
    padding: "12px 16px"
  chat-quick-reply:
    typography: "{typography.chat-quick-reply}"
    backgroundColor: "{colors.sage}"
    textColor: "{colors.basilDark}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  chat-input-bar:
    backgroundColor: "{colors.porcelain}"
    rounded: "16px"
    padding: "2px"
  chat-day-indicator:
    backgroundColor: "{colors.sage}"
    textColor: "{colors.basilDark}"
    rounded: "{rounded.pill}"
    padding: "10px 18px"
  chat-badge:
    backgroundColor: "{colors.basilDark}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  chat-day-dot:
    rounded: "{rounded.pill}"
    width: "10px"
    height: "10px"
    backgroundColor: "{colors.basilDark}"
  chat-day-dot-dim:
    backgroundColor: "{colors.inkMuted}"
---

# Overview

iKuck is a local-first domestic kitchen tool. Chef is the recipe-first landing surface; the separate Dispensa page provides ingredient entry and inventory. Recipe results are **Compare** surfaces, while Profile and private AI recipes are **Configure** surfaces.

The visual language is practical and warm rather than restaurant-luxury or generic SaaS: deep green ink, paper-like porcelain, basil for actions, sage for ready-to-cook state, yolk for a single missing purchase, and tomato only for destructive or blocking states.

# Colors

- **Ink:** structural text, high-emphasis surfaces, and the recipe detail hero. `primary` is a compatibility alias for this ink token.
- **Porcelain:** page background and readable surface text against dark ink.
- **Basil:** the one high-emphasis action color; use for actions that create progress.
- **Sage:** availability and completed/ready state; never use it as a warning.
- **Yolk:** attention without alarm, specifically the one-purchase recipe path. The keyboard focus ring uses the accessible Yolk-derived `#A87900` in light mode (`--ik-focus`) and `#F5C451` in dark mode.
- **Tomato:** destructive, failed, or irreversible action only.
- **Dark theme:** `html[data-theme='dark']` maps page/ink/surface to `{colors.darkPage}`, `{colors.darkInk}`, and `{colors.darkSurface}`; basil remains the progress action, while sage, mist, yolk, and tomato retain their existing meanings with dark-mode values.
- Runtime `--ik-*` properties implement these semantic tokens. Legacy Tailwind color names are compatibility aliases to the same palette in both themes, not a second source of color values.
- **Recipe hero category:** use `{colors.recipeCategory}` on the light ink hero and `{colors.darkRecipeCategory}` on the inverted light hero surface to preserve readable contrast.
- **Yolk contrast:** foreground on yolk stays `{colors.onYolk}` in both themes; warning copy uses `#8A5700` in light mode and `{colors.darkWarnInk}` in dark mode, with accent borders kept distinct from focus indicators.
- **Mist and border:** quiet separation; do not stack shadows, glass, or gradients to fake depth.

Use the current semantic light and dark values above for surfaces and signals. Dark borders are `#2B3630` / `#3F4D45`, the dark keyboard ring is `#F5C451`, warning text is `#F2CA7A`, and accent borders are `#8A6A1E`; use restrained black shadows.

# Typography

Use Bricolage Grotesque Variable throughout. Headlines are compact, weighty, and left-aligned on product surfaces; body copy explains the next action in one or two sentences. Do not introduce a default system sans, a second display family, or decorative all-caps blocks beyond small scanning labels.

# Layout

Use a fluid single-column mobile flow with 16px side gutters and 44px minimum hit targets. Keep primary actions above the fixed five-item navigation: Dispensa, Spesa, Chef, Piano and Ricette. Chef is central; Diario is accessed from Ricette, and Profilo and Casa from the account control. Use the same bottom navigation on desktop, not a sidebar. Respect device safe areas. Optional pantry ideas, filters, lots, and staples use closed disclosures. Result groups separate ready recipes from recipes needing one purchase rather than mixing equal cards in an undifferentiated grid.

# Elevation & Depth

Use one restrained shadow for floating surfaces. Prefer border, spacing, and tonal background changes for hierarchy. No glassmorphism, gradient panels, or decorative icon tiles.

# Shapes

Controls use 12px radii, regular panels use 20px radii, and major action or feature surfaces use 28px radii. Pills are reserved for compact state counts and metadata, not whole sections.

# Components

- `button-primary` is the only standard filled action. It must have a visible focus ring and a 48px minimum height.
- `action-panel` contains the recipe-search decision and uses ink with a yolk action.
- `ready-recipe` identifies recipes that can be started now.
- `one-purchase-recipe` identifies a recipe with one direct path to the shopping list.
- `quiet-surface` holds secondary account or configuration content.
- `outlined-surface` separates content without turning each block into a dashboard card.
- Chat bubbles, input and floating surfaces use the semantic surface, ink, basil, sage and tomato tokens; borders use `--ik-border` and the shared shadow. User and assistant bubbles retain their directional corner treatment. Focus uses `--ik-focus` in both themes.

# Do's and Don'ts

Do:
- Put the action before optional controls.
- State availability in plain language: “Hai tutto” or “Ti manca solo…”.
- Use semantic status and route users directly to the next task.
- Preserve keyboard focus, live-region feedback, safe-area clearance, and reduced-motion support.

Don't:
- Use violet/indigo to imply “AI”. Private AI is an account surface, not a new product brand.
- Use a hero-plus-three-cards marketing composition on Home.
- Center every section or add decorative statistics.
- Make the primary action depend on scrolling past explanatory copy.

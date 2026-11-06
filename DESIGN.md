---
version: alpha
name: iKuck cucina domestica
description: "Un sistema locale-first per decidere cosa cucinare con ciò che è già in casa."
colors:
  primary: "#A86F4A"
  porcelain: "#FFF8F0"
  surface: "#FFFFFF"
  apricot: "#E8A87C"
  apricotDark: "#C88B5E"
  peach: "#FFE8D6"
  cream: "#FFF0E0"
  yolk: "#FFD6A5"
  inkMuted: "#8B7355"
  darkPage: "#2D1F16"
  darkSurface: "#3D2B1F"
  darkInk: "#FFE8D6"
  darkInkMuted: "#C8A88A"
  darkApricot: "#FFB88A"
  darkApricotDark: "#E8A87C"
  darkPeach: "#5D3A2E"
  darkCream: "#4A3728"
  darkYolkSoft: "#5D4528"
  darkTomato: "#FFB3B3"
  darkTomatoSoft: "#4A201A"
  overlay: "rgba(168, 111, 74, 0.55)"
  onYolk: "#3D2B1F"
  recipeCategory: "#FFD6A5"
  darkRecipeCategory: "#8B5A1A"
  darkWarnInk: "#FFD6A5"

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
    backgroundColor: "{colors.apricot}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.apricotDark}"
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
    backgroundColor: "{colors.primary}"
    textColor: "{colors.recipeCategory}"
  recipe-hero-category-dark:
    backgroundColor: "{colors.darkInk}"
    textColor: "{colors.darkRecipeCategory}"
  ready-recipe:
    backgroundColor: "{colors.peach}"
    textColor: "{colors.primary}"
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
    backgroundColor: "{colors.cream}"
    textColor: "{colors.inkMuted}"
    rounded: "{rounded.panel}"
    padding: "16px"
  outlined-surface:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.primary}"
    rounded: "{rounded.panel}"
    padding: "16px"
  button-primary-dark:
    backgroundColor: "{colors.darkApricot}"
    textColor: "{colors.darkPage}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    height: "48px"
  button-primary-dark-hover:
    backgroundColor: "{colors.darkApricotDark}"
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
    backgroundColor: "{colors.darkPeach}"
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
    backgroundColor: "{colors.darkCream}"
    textColor: "{colors.darkInkMuted}"
    rounded: "{rounded.panel}"
    padding: "16px"
  outlined-surface-dark:
    backgroundColor: "{colors.darkSurface}"
    textColor: "{colors.darkInk}"
    rounded: "{rounded.panel}"
    padding: "16px"
  # Chat components share the core iKuck palette
  chat-bubble-assistant:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.chat-bubble}"
    rounded: "{rounded.bubble}"
    padding: "14px 18px"
  chat-bubble-user:
    backgroundColor: "{colors.apricot}"
    textColor: "{colors.porcelain}"
    typography: "{typography.chat-bubble}"
    rounded: "{rounded.bubble}"
    padding: "14px 18px"
  chat-bubble-recipe:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.feature}"
    padding: "0"
  chat-bubble-error:
    backgroundColor: "{colors.tomatoSoft}"
    textColor: "{colors.tomato}"
    rounded: "{rounded.panel}"
    padding: "12px 16px"
  chat-quick-reply:
    backgroundColor: "{colors.peach}"
    textColor: "{colors.primary}"
    typography: "{typography.chat-quick-reply}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  chat-input-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.control}"
    padding: "2px"
  chat-day-indicator:
    backgroundColor: "{colors.peach}"
    textColor: "{colors.primary}"
    rounded: "{rounded.pill}"
    padding: "10px 18px"
  chat-badge:
    backgroundColor: "{colors.apricot}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  chat-bubble-assistant-dark:
    backgroundColor: "{colors.darkSurface}"
    textColor: "{colors.darkInk}"
    typography: "{typography.chat-bubble}"
    rounded: "{rounded.bubble}"
    padding: "14px 18px"
  chat-bubble-user-dark:
    backgroundColor: "{colors.darkApricot}"
    textColor: "{colors.darkPage}"
    typography: "{typography.chat-bubble}"
    rounded: "{rounded.bubble}"
    padding: "14px 18px"
  chat-bubble-recipe-dark:
    backgroundColor: "{colors.darkSurface}"
    textColor: "{colors.darkInk}"
    rounded: "{rounded.feature}"
    padding: "0"
  chat-bubble-error-dark:
    backgroundColor: "{colors.darkTomatoSoft}"
    textColor: "{colors.darkTomato}"
    rounded: "{rounded.panel}"
    padding: "12px 16px"
  chat-quick-reply-dark:
    backgroundColor: "{colors.darkPeach}"
    textColor: "{colors.darkInk}"
    typography: "{typography.chat-quick-reply}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  chat-input-bar-dark:
    backgroundColor: "{colors.darkSurface}"
    textColor: "{colors.darkInk}"
    rounded: "{rounded.control}"
    padding: "2px"
  chat-day-indicator-dark:
    backgroundColor: "{colors.darkPeach}"
    textColor: "{colors.darkInk}"
    rounded: "{rounded.pill}"
    padding: "10px 18px"
  chat-badge-dark:
    backgroundColor: "{colors.darkApricot}"
    textColor: "{colors.darkPage}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  profile-modal-backdrop:
    backgroundColor: "{colors.overlay}"
  chat-day-dot:
    width: "10px"
    height: "10px"
    borderRadius: "50%"
    backgroundColor: "{colors.tomato}"
  chat-day-dot-dim:
    backgroundColor: "{colors.chatInkFaint}"
---

# Overview

iKuck is a local-first domestic kitchen tool. Its primary Home surface is **Operate**: someone should add ingredients and start a recipe search before exploring optional settings. Recipe results are **Compare** surfaces, while Profile and private AI recipes are **Configure** surfaces.

The visual language is practical and warm: warm brown ink, cream background, apricot for actions, peach for ready-to-cook state, yolk for a single missing purchase, and coral only for destructive or blocking states.

# Colors

- **Ink / primary:** structural text, high-emphasis surfaces, and the recipe detail hero.
- **Porcelain:** page background and readable surface text against dark ink.
- **Apricot:** the one high-emphasis action color; use for actions that create progress.
- **Peach:** availability and completed/ready state; never use it as a warning.
- **Yolk:** attention without alarm, specifically the one-purchase recipe path and keyboard focus ring.
- **Tomato/Coral:** destructive, failed, or irreversible action only.
- **Dark theme:** `html[data-theme='dark']` maps page/ink/surface to `{colors.darkPage}`, `{colors.darkInk}`, and `{colors.darkSurface}`; apricot remains the progress action, while peach, cream, yolk, and tomato retain their existing meanings with dark-mode values.
- **Recipe hero category:** use `{colors.recipeCategory}` on the light ink hero and `{colors.darkRecipeCategory}` on the inverted light hero surface to preserve readable contrast.
- **Yolk contrast:** foreground on yolk stays `{colors.onYolk}` in both themes; warning copy and accent borders use the dedicated dark tokens rather than inheriting the inverted ink color.
- **Cream and border:** quiet separation; do not stack shadows, glass, or gradients to fake depth.

The light palette uses warm tones. Dark amber steps `#8B5A1A` / `#A86F4A` and coral `#FFB3B3` are tuned for contrast on inverted surfaces; use borders `#4A3728` / `#5D3A2E`, the `#FFD6A5` keyboard ring, `#FFD6A5` warning text, and `#8A6A1E` accent borders with restrained black shadows.

Legacy Tailwind color utilities are compatibility aliases, not separate palettes: gray maps to ink, porcelain, cream, and border tokens; orange/amber map to peach, apricot, and yolk; red/rose map to tomato tokens. Keep their light and dark values in sync with this specification.

# Typography

Use Bricolage Grotesque Variable throughout. Headlines are compact, weighty, and left-aligned on product surfaces; body copy explains the next action in one or two sentences. Do not introduce a default system sans, a second display family, or decorative all-caps blocks beyond small scanning labels.

# Layout

Use a fluid single-column mobile flow with 16px side gutters and 44px minimum hit targets. The primary recipe action must remain above the fixed four-item mobile navigation at 390×844. At desktop widths use a fixed left sidebar with Cucina, Dispensa, Spesa and Diario; account/Profile/Casa stay in the sidebar footer. Optional pantry ideas, filters, lots, and staples use closed disclosures. Result groups separate ready recipes from recipes needing one purchase rather than mixing equal cards in an undifferentiated grid.

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

# Do's and Don'ts

Do:
- Put the action before optional controls.
- State availability in plain language: "Hai tutto" or "Ti manca solo…".
- Use semantic status and route users directly to the next task.
- Preserve keyboard focus, live-region feedback, safe-area clearance, and reduced-motion support.

Don't:
- Use violet/indigo to imply "AI". Private AI is an account surface, not a new product brand.
- Use a hero-plus-three-cards marketing composition on Home.
- Center every section or add decorative statistics.
- Make the primary action depend on scrolling past explanatory copy.
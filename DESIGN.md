---
version: alpha
name: iKuck cucina domestica
description: "Un sistema locale-first per decidere cosa cucinare con ciò che è già in casa."
colors:
  primary: "#183028"
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
  darkTomato: "#FF8A7A"
  darkTomatoSoft: "#3A1512"
  onYolk: "#183028"
  recipeCategory: "#FCD34D"
  darkRecipeCategory: "#725000"
  darkWarnInk: "#F2CA7A"
  # SOUS-CHEF extensions (warm/soft palette for chat UI)
  cream: "#FEFEF8"
  peach: "#FFE4D0"
  peachSoft: "#FFF0E8"
  apricot: "#F8C8A0"
  apricotSoft: "#FDEFE0"
  terracotta: "#E8A078"
  terracottaStrong: "#D48C64"
  coral: "#F0A080"
  coralSoft: "#FDE8E0"
  honey: "#F0D080"
  honeySoft: "#FDF8E0"
  chatInk: "#3D3530"
  chatInkSoft: "#6B635B"
  chatInkFaint: "#A8A098"
  darkCream: "#2D2824"
  darkPeach: "#5C4A3D"
  darkPeachSoft: "#4A3D33"
  darkApricot: "#C88A5C"
  darkApricotSoft: "#5C4333"
  darkTerracotta: "#E8A078"
  darkTerracottaStrong: "#D48C64"
  darkCoral: "#E89474"
  darkSageSoft: "#2D4A33"
  darkHoney: "#D4B85C"
  darkHoneySoft: "#4A4333"
  darkChatInk: "#F5F0E8"
  darkChatInkSoft: "#C8C0B8"
  darkChatInkFaint: "#8A827A"
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
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
  chat-body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 450
    lineHeight: 1.55
  chat-bubble:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  chat-quick-reply:
    fontFamily: "DM Sans, system-ui, sans-serif"
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
    backgroundColor: "{colors.primary}"
    textColor: "{colors.recipeCategory}"
  recipe-hero-category-dark:
    backgroundColor: "{colors.darkInk}"
    textColor: "{colors.darkRecipeCategory}"
  ready-recipe:
    backgroundColor: "{colors.sage}"
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
    backgroundColor: "{colors.mist}"
    textColor: "{colors.inkMuted}"
    rounded: "{rounded.panel}"
    padding: "16px"
  outlined-surface:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.primary}"
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
    backgroundColor: "{colors.cream}"
    textColor: "{colors.chatInk}"
    rounded: "{rounded.bubble}"
    padding: "14px 18px"
    border: "1px solid {colors.peachSoft}"
    borderBottomLeftRadius: "6px"
    boxShadow: "0 2px 16px rgba(61,53,48,0.05)"
  chat-bubble-user:
    backgroundColor: "{colors.terracotta}"
    textColor: "{colors.cream}"
    rounded: "{rounded.bubble}"
    padding: "14px 18px"
    borderBottomRightRadius: "6px"
  chat-bubble-recipe:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.chatInk}"
    rounded: "{rounded.feature}"
    padding: "0"
    border: "1px solid {colors.peachSoft}"
    boxShadow: "0 8px 32px rgba(61,53,48,0.07)"
  chat-bubble-error:
    backgroundColor: "{colors.coralSoft}"
    textColor: "{colors.terracotta}"
    rounded: "{rounded.panel}"
    padding: "12px 16px"
  chat-quick-reply:
    backgroundColor: "{colors.peachSoft}"
    textColor: "{colors.terracotta}"
    border: "1px solid {colors.apricotSoft}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
    fontSize: "13px"
    fontWeight: 500
  chat-input-bar:
    backgroundColor: "{colors.cream}"
    border: "1px solid {colors.peachSoft}"
    rounded: "16px"
    padding: "2px"
  chat-day-indicator:
    backgroundColor: "{colors.peachSoft}"
    textColor: "{colors.terracotta}"
    rounded: "{rounded.pill}"
    padding: "10px 18px"
  chat-badge:
    backgroundColor: "{colors.terracotta}"
    textColor: "{colors.cream}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
    fontSize: "11px"
    fontWeight: 700
  chat-day-dot:
    width: "10px"
    height: "10px"
    borderRadius: "50%"
    backgroundColor: "{colors.terracotta}"
  chat-day-dot-dim:
    backgroundColor: "{colors.chatInkFaint}"
---

# Overview

iKuck is a local-first domestic kitchen tool. Its primary Home surface is **Operate**: someone should add ingredients and start a recipe search before exploring optional settings. Recipe results are **Compare** surfaces, while Profile and private AI recipes are **Configure** surfaces.

The visual language is practical and warm rather than restaurant-luxury or generic SaaS: deep green ink, paper-like porcelain, basil for actions, sage for ready-to-cook state, yolk for a single missing purchase, and tomato only for destructive or blocking states.

# Colors

- **Ink / primary:** structural text, high-emphasis surfaces, and the recipe detail hero.
- **Porcelain:** page background and readable surface text against dark ink.
- **Basil:** the one high-emphasis action color; use for actions that create progress.
- **Sage:** availability and completed/ready state; never use it as a warning.
- **Yolk:** attention without alarm, specifically the one-purchase recipe path and keyboard focus ring.
- **Tomato:** destructive, failed, or irreversible action only.
- **Dark theme:** `html[data-theme='dark']` maps page/ink/surface to `{colors.darkPage}`, `{colors.darkInk}`, and `{colors.darkSurface}`; basil remains the progress action, while sage, mist, yolk, and tomato retain their existing meanings with dark-mode values.
- **Recipe hero category:** use `{colors.recipeCategory}` on the light ink hero and `{colors.darkRecipeCategory}` on the inverted light hero surface to preserve readable contrast.
- **Yolk contrast:** foreground on yolk stays `{colors.onYolk}` in both themes; warning copy and accent borders use the dedicated dark tokens rather than inheriting the inverted ink color.
- **Mist and border:** quiet separation; do not stack shadows, glass, or gradients to fake depth.

The light palette is unchanged. Dark amber steps `#725000` / `#8A5700` and red-700 `#E35C5C` are tuned for contrast on inverted surfaces; use borders `#2B3630` / `#3F4D45`, the `#F5C451` keyboard ring, `#F2CA7A` warning text, and `#8A6A1E` accent borders with restrained black shadows.

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
- State availability in plain language: “Hai tutto” or “Ti manca solo…”.
- Use semantic status and route users directly to the next task.
- Preserve keyboard focus, live-region feedback, safe-area clearance, and reduced-motion support.

Don't:
- Use violet/indigo to imply “AI”. Private AI is an account surface, not a new product brand.
- Use a hero-plus-three-cards marketing composition on Home.
- Center every section or add decorative statistics.
- Make the primary action depend on scrolling past explanatory copy.

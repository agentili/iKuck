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
  ready-recipe:
    backgroundColor: "{colors.sage}"
    textColor: "{colors.primary}"
    rounded: "{rounded.panel}"
    padding: "16px"
  one-purchase-recipe:
    backgroundColor: "{colors.yolk}"
    textColor: "{colors.primary}"
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
- **Mist and border:** quiet separation; do not stack shadows, glass, or gradients to fake depth.

# Typography

Use Bricolage Grotesque Variable throughout. Headlines are compact, weighty, and left-aligned on product surfaces; body copy explains the next action in one or two sentences. Do not introduce a default system sans, a second display family, or decorative all-caps blocks beyond small scanning labels.

# Layout

Use a fluid single-column mobile flow with 16px side gutters and 44px minimum hit targets. The primary recipe action must remain above fixed mobile navigation at 390×844. Optional pantry ideas, filters, lots, and staples use closed disclosures. Result groups separate ready recipes from recipes needing one purchase rather than mixing equal cards in an undifferentiated grid.

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

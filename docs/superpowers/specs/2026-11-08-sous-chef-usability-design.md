# iKuck Sous Chef usability redesign

**Status:** Draft for user review
**Date:** 2026-11-08

## Intent

Make the Sous Chef PWA easier to understand and use for everyday cooking, while letting the user inspect and try each small improvement before the next one begins. The work should improve the current product through evidence-led iterations rather than assume that replacing the whole frontend is the right answer.

## Current-state evidence

- The repository is at `v1.16.0` (`86902ec`), which already integrates the Sous Chef interface. The older iKuck interface remains behind the build-time `VITE_SOUS_CHEF` flag.
- Sous Chef currently opens `/` on the chef chat. Its five main destinations are Dispensa, Spesa, Chef, Piano, and Ricette.
- `/cucina` still renders the earlier ingredient-and-recipe suggestion home. `/discover`, `/saved`, `/activity`, and `/dinner-diary` also remain separate routes; some are grouped under Ricette in bottom-navigation state.
- The current repository contains dedicated Sous Chef Playwright coverage for shell navigation, planning, pantry, shopping, accessibility, and integrated flows. These tests document expected behavior; they have not been run as part of this initial inspection.
- The September home/navigation UX plan is marked completed. Its earlier direction put recipe search first and collapsed secondary controls. That direction predates the Sous Chef chat-first landing and is not treated as an instruction to undo the current product without evaluating it.
- `docs/frontend-rewrite-prompt.md` describes an older full-rewrite proposal. This redesign does not treat it as an approved product specification.

## Goals

- Make the main navigation and the next useful action understandable on a phone without prior explanation.
- Reduce unnecessary steps in the user's highest-friction cooking flow, chosen from observed evidence and the user's feedback.
- Preserve local-first, guest/offline use, explicit account import, existing data, and current API contracts.
- Keep user-facing text in Italian and implementation identifiers/comments in English.
- Deliver each accepted improvement as a small, reviewable step with a working preview the user can try before work proceeds to the next step.
- Preserve keyboard access, screen-reader labels, responsive behavior, reduced-motion support, and PWA update/offline behavior.

## Non-goals and constraints

- Do not replace React/Vite, IndexedDB, the backend, or shared contracts as a starting assumption.
- Do not remove product features merely because they add complexity; first establish whether they obstruct the primary flow.
- Do not change authentication, synchronization, or guest-data import semantics as a side effect of visual work.
- Do not merge, push, or release to production automatically.
- Do not claim browser, Docker, provider, or device validation unless it was actually run.

## Proposed working method

1. Finish a focused audit of the current Sous Chef user journeys, responsive layouts, accessibility coverage, and existing tests. Record confirmed issues separately from usability hypotheses.
2. Use the user's response about the most frustrating moment to choose one initial journey. If no preference is supplied, start with the core daily path: open Chef, decide what to cook, plan it, and reach the needed ingredients.
3. For that journey, prepare a small before/after preview or a first isolated implementation. Agree the visible behavior before broadening the work.
4. Implement one bounded change at a time in an isolated worktree. Run focused checks, build the PWA, start a dedicated local preview, and provide a LAN URL when Docker and network access permit. Keep that preview available while the user tries the step.
5. Record each step's status, changed areas, verification evidence, preview URL, and unresolved issues in a repository progress log. Continue only after the user has had a chance to review the preview or explicitly asks to proceed without review.
6. At each accepted step, update the design/plan based on feedback, then select the next highest-impact journey. Keep the existing application runnable throughout.

## Preliminary design direction

Treat Chef, Piano, Ricette, Dispensa, and Spesa as parts of one guided cooking journey. Evaluate whether the current chat landing clearly teaches its available actions and how it connects to the meal plan and recipe library. Favor progressive disclosure and plain Italian labels, but retain direct access to existing routes and data. Any proposed navigation changes must be evaluated on narrow mobile and desktop layouts before implementation.

## User's first priority

The user identified **finding what to cook** as the moment that causes the most confusion or wasted time. The first audit and prototype should focus on the route from app opening to a suitable recipe, including how the Chef chat, pantry-aware suggestions, recipe library, and meal plan fit together. Do not assume in advance which of those screens should become the landing page.

## Approval boundary

This document captures the proposed intent, constraints, staged preview workflow, and the user's first journey priority. It is a draft, not approval for a specific navigation or screen redesign. After review and any user correction, create a small executable plan with exact files, acceptance criteria, commands, and per-step preview criteria before changing product code.

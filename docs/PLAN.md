> Design plan copied verbatim from the original planning session (approved by the repo owner on 2026-10-27) so every build session can read it inside the repo. `docs/SPEC.md` references it as "the plan"; where the two differ, `SPEC.md` wins.

# Flag-learning PWA

## Context

The user wants a simple, visually sleek app for learning country flags, used mostly on their iPhone. The repo (`flags`) is currently empty — this is a greenfield build. Decisions gathered from the user:

- **Platform**: Progressive Web App (installable to iPhone home screen), not native.
- **Quiz modes**: both multiple-choice and type-the-answer, toggleable.
- **Scope**: UN member states + dependencies/territories (~250 flags), filterable by continent.
- **Learning algorithm**: a real spaced-repetition system — surfaces flags the user struggles with more often, while still periodically reviewing ones they know, so nothing is forgotten.
- **Stack**: plain HTML/CSS/JS, no framework, no build step.
- **Flags**: crisp SVG flag images (vendored from the `flag-icons` library), not emoji.
- **Aesthetic**: minimal light theme, monochrome with a single muted accent color.
- **Hosting**: deployed free (GitHub Pages) so it's reachable as a real URL on the phone, added to home screen as a PWA.

Everything runs client-side — no backend, no account. Progress is stored in the browser (`localStorage`) on the phone.

A UX design review (via `/grill-me`) resolved the following, which this plan incorporates:

1. **Home screen first** (not a cold-open quiz) — shows a continent filter, mode toggle, a "due" count scoped to that filter, a Start button, and a separate Test entry point. No other stats (no streak, no accuracy block) — kept deliberately minimal.
2. **Continent filter always resets to "All"** on open; it is never remembered between sessions, so staleness in neglected regions can't hide indefinitely.
3. **Practice sessions are fixed 10-question rounds**, with "Keep going" / "Done" offered at the end of each round rather than a hard stop or infinite stream.
4. **Test mode is a separate, SRS-untouched feature**: pick "All" or a continent, answer blind (no feedback per question), untimed, and get a results screen at the end with score + the specific list of missed flags. It never writes to `srs.js` state.
5. **Answer feedback is hybrid**: correct answers auto-advance almost immediately; incorrect answers pause and wait for a manual "Next" tap so the correct name actually registers.
6. **New (never-seen) flags are thrown in blind**, not pre-taught — including in typing mode, where a first miss is just a normal lapse (not a dedicated teaching step).
7. **Typing mode is autosuggest/select, not a spelling test**: as you type, a fuzzy/typo-tolerant filtered list of country names (matching `name` + `aliases`) appears; you answer by tapping a row. There is no raw-text submit path — this sidesteps spelling/typo grading entirely and makes the new-flag problem in point 6 harmless.
8. **Correct/incorrect visuals are monochrome-first**: one muted accent color pulses on correct answers; incorrect answers get a grey/black icon + outline treatment, no red/green pairing (keeps the app's existing black/white/grey visual discipline, and avoids a colorblind-unfriendly red/green pair).
9. **Multiple-choice distractors never pair a territory with its own parent country or sibling territories** — only unrelated same-region countries are used as wrong options, so difficulty comes from actually knowing the country, not from flag-design trivia.

## Architecture

Single static site, no dependencies to install, no bundler:

```
flags/
├── index.html            # app shell: home screen, practice session, test mode, results — shown/hidden as views
├── manifest.webmanifest  # PWA manifest (name, icons, standalone display, theme color)
├── sw.js                 # service worker: caches app shell + flag SVGs for offline use
├── css/
│   └── style.css         # minimal light theme, mobile-first layout
├── js/
│   ├── app.js            # view routing: home / practice / test / results, mode toggle, continent filter
│   ├── srs.js            # spaced-repetition engine (pure functions, unit-testable)
│   └── quiz.js           # question generation (MC distractor picking w/ parent-territory exclusion, typing-mode autosuggest filter)
├── data/
│   └── countries.json    # [{ code, name, aliases: [...], region, sovereign: bool, parentCode? }, ...] (~250 entries)
├── flags/
│   └── <code>.svg        # vendored SVG flags from flag-icons (4x3), one per country/territory code
└── icons/
    └── icon-192.png, icon-512.png, apple-touch-icon.png   # home-screen icons
```

### Data

- `data/countries.json` compiled once from ISO 3166-1 codes (sovereign states + inhabited dependencies/territories), with a `name`, a short list of accepted `aliases` for typing-mode search matching (e.g. "USA", "United States", "US"), `region` (continent, used by the filter), a `sovereign` flag, and a `parentCode` for territories (e.g. Puerto Rico → `US`), used to exclude parent/sibling pairs from multiple-choice distractors.
- Flag SVGs vendored locally from `flag-icons` (MIT licensed) under `flags/<iso-code>.svg`, so the service worker can cache them for offline use and we're not dependent on a CDN.

### Spaced-repetition engine (`js/srs.js`)

Per-flag state persisted in `localStorage` (keyed by country code):

```js
{ code, repetitions, easeFactor, intervalDays, dueDate, lapses }
```

SM-2-style update, simplified:
- **Correct**: `repetitions += 1`; interval grows (`interval = 1` → `6` → `interval * easeFactor` for successive correct answers); `easeFactor` nudges up slightly (capped).
- **Incorrect**: `repetitions = 0`; `interval = 1`; `easeFactor` nudges down (floored so struggling flags don't get a huge interval even after one lucky guess); `lapses += 1`; the flag is also re-queued to reappear again *within the same session* a few questions later (short-term reinforcement), not just on its next calendar due date.
- **Scheduling / picking the next question**: candidates = all flags (within the active continent filter) with `dueDate <= today`, plus a trickle of never-seen flags. Weight the random pick toward (a) overdue items and (b) low ease-factor / high-lapse items, so struggling flags surface more often while mastered ones still reappear eventually instead of disappearing forever.
- **Test mode never calls into this engine** — it's a read-only pass over the chosen scope (all / one continent) and writes nothing to SRS state.

This logic lives in pure, dependency-free functions so it's easy to reason about and (optionally) unit test later.

### Quiz modes (`js/quiz.js`)

- **Multiple choice**: show the flag, 4 options (1 correct + 3 distractors). Distractors are drawn from the same region where possible, **excluding the flag's own `parentCode` and any sibling territories sharing it** (no Puerto Rico ↔ United States pairings), falling back to random same-region or any-region countries if the pool is too small.
- **Type the answer**: show the flag plus a text input; as the user types, show a live-filtered, fuzzy/typo-tolerant (small edit-distance, diacritic/case-insensitive) list of matching countries by `name` + `aliases` (so "holland" surfaces Netherlands, "grmny" still surfaces Germany). The user answers by **tapping a row in the list** — there is no raw-text submit path, so spelling/typos are never graded directly, only used to narrow the list.
- **Toggle**: a simple segmented control in the header to switch modes; the SRS state is shared across modes (one proficiency model per flag, regardless of which mode you were tested in).
- **Answer feedback timing**: on a correct answer, auto-advance to the next question almost immediately; on an incorrect answer, pause on the result (showing the correct name) until the user taps "Next". This is practice-mode-only behavior — test mode has no per-question feedback at all (see Screens & flows).

### Screens & flows

- **Home screen**: continent filter (defaults to "All" every time the app is opened — never remembered), a mode toggle (multiple choice / typing), a due-count scoped to the current filter selection, a **Start** button (practice), and a separate **Test** button. No other stats shown (no streak, no accuracy) — kept to a single glance.
- **Practice session**: fixed rounds of 10 questions, drawn via the SRS scheduler above (scoped to the chosen continent filter). At the end of a round, show a short summary (e.g. "9/10 correct") with "Keep going" (starts another round) or "Done" (back to home).
- **Test mode**: user picks "All" or a continent, then answers every flag in that scope once, blind (no per-question right/wrong feedback, no indication of progress beyond a simple counter like "42/195"), untimed. At the end, show a results screen: score (e.g. "182/195, 93%") and the specific list of missed flags. Entirely separate from SRS state — purely a self-assessment snapshot.
- **New (never-seen) flags**: appear like any other question, in whichever mode is active — no dedicated "teaching" step. A miss on a brand-new flag is just a normal SRS lapse, which naturally brings it back around soon.

### UI (`index.html` / `css/style.css`)

- Minimal light theme: white background, dark text, monochrome-first feedback — one muted accent color pulses on correct answers, incorrect answers get a grey/black icon + outline treatment (deliberately no red/green pairing), generous whitespace, flag as the dominant visual element.
- Mobile-first layout (this is used almost exclusively on iPhone): large tap targets, flag fills most of the viewport width, safe-area padding for notch/home-indicator.

### PWA / offline

- `manifest.webmanifest`: name, short_name, `display: standalone`, theme/background colors (white), icons.
- `sw.js`: cache-first for the app shell and all flag SVGs/data JSON, so it works with poor/no connectivity once installed.
- `<link rel="apple-touch-icon">` and appropriate meta tags in `index.html` for a proper iOS home-screen icon and status-bar styling.

### Deployment

- Push to the existing `flags` GitHub repo, enable **GitHub Pages** serving from the `main` branch root — no build step needed since it's static files.
- User adds the resulting URL to their iPhone home screen via Safari's "Add to Home Screen" to get the installed-app experience.

## Verification

- Serve the site locally (e.g. `python -m http.server`) and open it in the browser preview tool.
- Emulate a mobile viewport (375×812) to check layout, tap targets, and flag sizing.
- Walk the full flow: home screen (continent filter resets to "All" on reload) → Start → a 10-question practice round → round summary → "Keep going"/"Done".
- Exercise both quiz modes end-to-end: confirm correct answers auto-advance, incorrect answers pause for a manual "Next" and show the right name; confirm `localStorage` SRS state updates sensibly (interval grows on success, resets on failure, struggling flags reappear sooner, scoped correctly by continent filter).
- Confirm typing mode's autosuggest list is typo/fuzzy-tolerant, matches aliases, and answering is selection-only (no raw-text submit).
- Confirm MC distractors never pair a territory with its own parent/sibling.
- Run Test mode end-to-end (all + one continent): no per-question feedback, untimed, correct results + missed-flags list at the end, and confirm it does not alter SRS state (compare `localStorage` before/after).
- Confirm the manifest is valid and the service worker registers without console errors (check via browser console tool).
- Note explicitly to the user: actual "Add to Home Screen" / offline-after-install behavior can't be fully verified from this environment and should be spot-checked by the user on their own iPhone after deployment.

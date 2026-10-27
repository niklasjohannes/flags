# Flag-learning PWA — build spec

This breaks the design plan (see `/Users/niklas.johannes/.claude/plans/i-want-a-simple-twinkling-kahn.md` for the full UX rationale) into a sequence of GitHub issues, each sized to be handed to its own session with no other context. Read this file in full before picking up any issue below — it is the shared source of truth every issue references instead of repeating itself.

## Principal-engineer review findings (incorporated below)

1. **Data provenance**: `data/countries.json` must be built *from* the vendored `flag-icons` SVG set (not invented independently), so codes never drift out of sync with available flag images.
2. **Region taxonomy** must be fixed and documented (a closed list of continents) before anything depends on it — it drives the continent filter, MC distractor pools, and test-mode scoping.
3. **Sovereignty/parentCode edge cases** (contested states, territories with ambiguous parents) need an explicit, neutral, documented policy in the data file itself — not ad hoc per-record judgment calls.
4. **Service worker cache invalidation** needs a versioned cache name + `activate`/`skipWaiting` cache-busting from day one, or every future deploy will silently fail to reach already-installed phones.
5. **GitHub Pages serves this from a subpath** (`/flags/`, not root) — all asset paths, the manifest's `start_url`/`scope`, and the service worker's registration scope must account for that.
6. **iOS Safari storage durability**: `localStorage` in an installed home-screen PWA is exempt from the 7-day ITP eviction that applies to a plain Safari tab — real risk if the user ever opens it as a bookmark instead of the installed icon. Worth a cheap export/import-progress-as-JSON safety valve.
7. **`srs.js` and `quiz.js` are exactly the "reusable module" case** that should get real tests (per the user's own stated testing philosophy) — plan a dependency-free `node --test` suite, runnable in CI with zero installs.
8. **Small-region distractor pools** (e.g. Oceania) can run out of valid same-region, non-parent/sibling distractors — needs an explicit, tested fallback, not a silent edge case.
9. **Flag `alt` text is a spoiler risk**: must not contain the country name pre-reveal (screen readers / long-press tooltips would leak the answer).
10. **Public-repo security posture**: zero backend, zero npm deps, no secrets possible — the main residual risks are (a) safe DOM rendering (no `innerHTML` + string concatenation anywhere, all rendered text ultimately comes from trusted local JSON so risk is low but the rule should be explicit), (b) a `Content-Security-Policy` meta tag restricting to `default-src 'self'` (cheap, since there are zero external resource loads planned), (c) pinning the vendored `flag-icons` version/commit and recording its license in `THIRD_PARTY_NOTICES.md`.
11. **GitHub Pages on a free personal account only serves from a *public* repo** (private-repo Pages needs a paid plan) — confirm this repo's intended visibility before relying on Pages.

## Workflow (how to use this spec)

- One GitHub issue per section below. Each issue = one branch = one PR referencing that issue. Merge only after its own acceptance criteria are met **and** a lightweight code-review pass on that PR's diff specifically (see Orchestration → Continuous review) — not deferred to the end-of-build review issues.
- Each implementation session should run in **its own git worktree** on a branch named `issue-<n>-<slug>`, so it can only ever touch files inside that worktree of this repo — never another repo, never the user's other work.
- Each session's permission mode should be set to auto-accept file edits and shell commands (no per-action prompting) — safe to do *because* the worktree already constrains its blast radius to this repo, and the sandboxed Bash tool (never `dangerouslyDisableSandbox`) still applies on top of that.
- Cross-cutting review issues (#10 design, #11 code, #12 security) are read-mostly: they read the full diff/repo and file follow-up issues or inline PR comments rather than pushing large rewrites themselves.
- Dependency graph: `#0 → #1 → {#2, #3} → #4 → {#5, #6} → #7 → #8 → {#9, #10, #11, #12}`. #10/#11/#12 can run in parallel once #8 is merged; #9 (deploy) should wait until #11 and #12 are clean.

## Orchestration (autonomous mode)

The whole sequence above is run by a single long-lived **orchestrator session** (model: Opus) rather than the user manually starting each issue's session by hand.

**Charter**: the orchestrator reads this spec once at startup, then owns the full build end-to-end — creating GitHub issues (#0–#12, with bodies copied from this file), creating one branch per issue, starting one implementation/review session per issue as its dependencies clear, watching each to completion, reviewing its PR, merging when the issue's acceptance criteria are met, and moving on to the next ready issue(s) in the dependency graph. It operates autonomously and only surfaces to the user when something goes wrong or is a judgment call too big to make alone.

**Hard scope limit**: every action the orchestrator (and every sub-session it starts) takes is confined to the single repository `https://github.com/niklasjohannes/flags` (remote `origin`, already configured locally). This is a mechanical precondition, not a one-time check: before **every** `gh` invocation and before **every** push, it confirms the target repo/remote is exactly this one (`gh ... --repo niklasjohannes/flags` explicitly on every call, never relying on cwd inference). It never adds, changes, or pushes to any other remote; never operates on a directory outside this repo's worktrees. If a task would require touching anything else, that is itself an escalation (see below), not a judgment call to make alone.

**Startup checks**: before creating any issue, the orchestrator confirms and reports the repo's current visibility (public/private) — it does not assume. "Auto-accept" permission mode means no per-action prompting *within* this app's permission model — it never implies disabling the sandboxed Bash tool, which stays on for every session at every level, always.

**Credential hygiene**: the orchestrator never prints, logs, commits, or includes in any issue/PR/commit text anything resembling a `gh` auth token, `.netrc` content, or other credential material. `gh` already keeps the token out of its reach (OS keychain); it should never need to and never try to read it directly.

**Continuous review, not just an end-of-build gate**: #10/#11/#12 as a one-time pass after #8 catches problems too late — up to nine issues of autonomous, unreviewed code would otherwise land on `main` first. Instead, run a lightweight code-review pass (same rigor as #11, just scoped to that PR's diff) **before merging each implementation issue's PR**, not only once at the end. The full #10/#11/#12 passes still run after #8 as a final, whole-system check before #9 deploys.

**Anti-drift anchor**: before every merge decision (not just at startup), the orchestrator re-reads this Orchestration section — a long-running autonomous session drifting into treating an escalation-worthy situation as routine is a real risk, and a cheap re-read of the literal rules is a better defense than relying on memory of them from first read.

**Mechanics** (uses the same session-management tools the user's own Claude Code sessions use — no separate orchestration framework needed):
- Each implementation issue → one sub-session, `context: "fresh"`, its own **git worktree** on branch `issue-<n>-<slug>`, permission mode set to auto-accept (file edits + shell commands, no per-action prompting) — safe because the worktree already confines its blast radius to this repo, and the sandboxed Bash tool stays on (never disabled).
- The orchestrator itself works directly against this repo (not a disposable worktree), since it needs to create branches, open/merge PRs, and create issues against the real remote.
- Review issues (#10/#11/#12) → read-mostly sub-sessions (no worktree needed) that file findings as PR comments or follow-up issues rather than pushing code themselves.
- GitHub issue/PR state is the single source of truth for progress — no separate tracking file to keep in sync. The orchestrator checks issue/PR status (`gh issue list`, `gh pr list`/`gh pr checks`) rather than maintaining its own ledger.
- The orchestrator is woken automatically when a sub-session it started finishes a turn — it does not need to poll.

**Escalate to the user instead of deciding alone, whenever:**
- An action would reach outside this repo (another repo, another machine, credentials, anything not inside this worktree/checkout).
- Changing the repo's public/private visibility, or enabling GitHub Pages for the first time (the moment this project actually becomes publicly reachable).
- Merging #9 (deploy) while #11 (code review) or #12 (security review) have open/unresolved findings.
- Any destructive git operation beyond a normal merge/branch-cleanup (force-push, hard reset, branch deletion of anything not its own throwaway branch).
- The same issue fails twice in a row — stop retrying blindly and report what's going wrong.
- A spec gap that changes actual behavior/UX (not an implementation detail) — i.e. a new design decision this document doesn't already answer.
- Anything it would otherwise classify as a "big problem" by its own judgment — the bar is "the user would want to know before this becomes hard to undo," not "the user would want to approve every step."

Everything else — filing issues, branching, implementing, reviewing, merging clean PRs, moving to the next issue — proceeds without asking.

---

## Issue #0 — Repo scaffold & CI

**Branch**: `issue-0-scaffold`

Set up the empty directory skeleton from the plan's Architecture section (`index.html`, `css/`, `js/`, `data/`, `flags/`, `icons/` — placeholders are fine), a `README.md` stub, `LICENSE` (MIT, matching the user's own code), `.gitignore`, and a GitHub Actions workflow (`.github/workflows/ci.yml`) that runs `node --test` across the repo on every push/PR. No app logic yet — this just makes every later issue have somewhere to land and a CI gate from the start.

**Acceptance criteria**: directory skeleton exists; CI workflow runs (even with zero tests, it should pass green) on a trivial PR.

---

## Issue #1 — Country & flag data pipeline

**Branch**: `issue-1-country-data`

Depends on: #0.

Vendor `flag-icons` SVGs (pin to a specific tagged release or commit SHA — record it) into `flags/<code>.svg`. Build `data/countries.json` by **starting from flag-icons' own code list** (don't invent codes), layering in per-entry: `name`, `aliases` (array), `region` (continent — define and document a fixed, closed taxonomy, e.g. `africa / asia / europe / north-america / south-america / oceania`; document how transcontinental/contested cases are assigned, neutrally, in a header comment), `sovereign` (bool), `parentCode` (nullable, for territories). Add `THIRD_PARTY_NOTICES.md` recording the flag-icons version and MIT license text.

**Acceptance criteria**: every code in `countries.json` has a matching SVG and vice versa (add a `node --test` check that asserts this 1:1 mapping); region taxonomy is documented; a handful of known edge cases (e.g. a transcontinental country, a territory with a parent) are spot-checked by hand.

---

## Issue #2 — Spaced-repetition engine (`js/srs.js`)

**Branch**: `issue-2-srs-engine`

Depends on: #0.

Implement the SM-2-style engine described in the plan: per-flag state (`repetitions, easeFactor, intervalDays, dueDate, lapses`), correct/incorrect update rules, ease-factor floor/cap, within-session re-queue on lapse, and the due/weighted-pick scheduling function (scoped by an optional continent filter). Pure functions, no DOM, no `localStorage` reads/writes inside the module itself (pass state in/out) so it's trivially testable.

**Acceptance criteria**: `node --test` suite covering — interval growth across repeated correct answers, reset-to-1 on incorrect, ease-factor capping/flooring, lapse re-queue-within-session, and that scheduling weights overdue + low-ease/high-lapse items without ever fully starving mastered items.

---

## Issue #3 — Quiz engine (`js/quiz.js`)

**Branch**: `issue-3-quiz-engine`

Depends on: #0, #1 (needs the real data shape, including `parentCode`/`region`).

Implement MC distractor selection (same-region preferred, **excluding the flag's own `parentCode` and siblings sharing it**, with a documented fallback when the region pool is too small) and the typing-mode autosuggest filter (fuzzy/typo-tolerant, matches `name` + `aliases`, case/diacritic-insensitive).

**Acceptance criteria**: tests for — a small-region distractor pool (e.g. Oceania) still returns 4 valid, non-parent/sibling options; a territory never gets its parent (or a sibling) as a distractor and vice versa; typing-filter matches on partial/typo'd input and on aliases (e.g. "holland" → Netherlands).

---

## Issue #4 — App shell & home screen

**Branch**: `issue-4-home-screen`

Depends on: #1, #2, #3.

Build `index.html` + base `css/style.css` + `js/app.js` view-routing skeleton. Home screen: continent filter (always defaults to "All" on load — never persisted), mode toggle (MC/typing), due-count scoped to the current filter (wired to `srs.js`), Start button, Test button. No other stats on this screen.

**Acceptance criteria**: manually verified in the browser preview (desktop + 375×812 mobile viewport) that reloading always resets the filter to "All" and the due-count updates when the filter changes.

---

## Issue #5 — Practice session flow

**Branch**: `issue-5-practice-flow`

Depends on: #4.

Fixed 10-question rounds drawn from `srs.js`'s scheduler (scoped to the active continent filter). Hybrid feedback: correct auto-advances almost immediately, incorrect pauses showing the right name until a manual "Next" tap. Round-end summary with "Keep going" / "Done". New (never-seen) flags appear blind, same as any question — a miss is just a normal lapse.

**Acceptance criteria**: a full round can be played start-to-finish in both quiz modes; `localStorage` SRS state updates correctly afterward (checked before/after); incorrect answers visibly wait for manual advance, correct ones don't.

---

## Issue #6 — Test mode flow

**Branch**: `issue-6-test-mode`

Depends on: #4.

Scope picker (All / per-continent), blind pass (no per-question feedback, just a position counter), untimed, results screen at the end with score + the specific missed-flags list. Must never call into `srs.js`'s write path.

**Acceptance criteria**: run a full test pass; confirm zero per-question feedback is shown; confirm `localStorage` SRS state is byte-for-byte unchanged before vs. after a test run.

---

## Issue #7 — Visual design pass

**Branch**: `issue-7-visual-design`

Depends on: #5, #6.

Apply the monochrome-first theme: one muted accent color pulses on correct answers, incorrect answers get a grey/black icon + outline (no red/green pairing). Mobile-first polish: safe-area padding, large tap targets, flag as the dominant element. Flag `<img>` `alt` text is generic (e.g. `"Flag to identify"`) until revealed, then updated to the real name — never spoils the answer for assistive tech pre-reveal.

**Acceptance criteria**: a fresh session (or the design-review issue below) walks through every screen against the plan's "Screens & flows" / UX-decision list and confirms each of the 12 grilled decisions is actually implemented as specified.

---

## Issue #8 — PWA & offline

**Branch**: `issue-8-pwa-offline`

Depends on: #7.

`manifest.webmanifest` with correct `start_url`/`scope` for the GitHub Pages subpath (`/flags/`), app icons, iOS meta tags (`apple-touch-icon`, status-bar style). `sw.js`: cache-first for shell + flag SVGs + data JSON, with a **versioned cache name**, `activate` handler that deletes old caches, and `skipWaiting()`/`clients.claim()` so deploys actually reach the installed app. Add a `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">` tag (there should be zero external origins loaded anywhere in this app).

**Acceptance criteria**: service worker registers with no console errors; a simulated second deploy (bump the cache version, reload) actually replaces cached assets rather than sticking on the old version; manifest validates; confirm no network requests to any non-`self` origin anywhere in the app.

---

## Issue #9 — Deployment

**Branch**: `issue-9-deploy`

Depends on: #8, and should wait until #11 and #12 are clean.

Enable GitHub Pages (confirm whether the repo needs to be public for Pages to work on the account's current plan — flag this to the user rather than assuming). Smoke-test the live URL end-to-end, including from an iPhone, including "Add to Home Screen."

**Acceptance criteria**: live URL loads, installs to home screen, works offline after first load.

---

## Issue #10 — Design review (cross-cutting)

**Branch**: none — read-only review, files follow-up issues or PR comments rather than pushing code itself.

Runs after #7. A fresh session walks every screen against this spec's "Screens & flows" and the 12 grilled UX decisions (home screen contents, continent-filter reset behavior, round length, test-mode isolation from SRS, feedback timing, new-flag handling, typing-mode autosuggest-only interaction, monochrome feedback, distractor exclusion) and reports any mismatch. Does not fix its own findings — keeps the reviewer honest/independent.

---

## Issue #11 — Code review (cross-cutting)

**Branch**: none — read-only review.

Runs after #8 (feature-complete). Use the `/code-review` skill at high effort across the full repo diff. Pay particular attention to: `srs.js`/`quiz.js` test coverage, service worker cache-versioning correctness, and that no `innerHTML`-with-concatenated-strings pattern crept into any DOM-rendering code.

---

## Issue #12 — Security review (cross-cutting)

**Branch**: none — read-only review.

Runs after #8, alongside #11. Use the `/security-review` skill. Specific to this app's public-GH-Pages exposure: confirm the CSP meta tag is present and correct; confirm zero secrets/tokens anywhere in the repo history; confirm the vendored `flag-icons` version is pinned and its license recorded; confirm all DOM rendering is injection-safe; confirm the data file's neutral-naming policy was actually followed for contested/sensitive entries; confirm the service worker never caches cross-origin/opaque responses (it shouldn't have any to cache).

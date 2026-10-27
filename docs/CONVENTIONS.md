# Conventions

Shared rules for every issue in [`SPEC.md`](SPEC.md). If something here conflicts with the spec, the spec wins.

## Modules and dependencies

- Plain ES modules (`import`/`export`), loaded in the browser via `<script type="module">` and in Node via `package.json`'s `"type": "module"`.
- Import specifiers are always relative with an explicit `.js` extension (`import { pickDue } from './srs.js'`). Never extensionless, never bare (`'srs'`), since both browsers and Node ESM reject those.
- **Exception: `sw.js` is a classic script** (no `import`/`export`), registered as `navigator.serviceWorker.register('./sw.js')` from the app root so its scope is `/flags/`. Module service workers have patchier support.
- **Zero npm dependencies**, including dev dependencies. `package.json` exists only for `"type": "module"` and a `test` script alias.
- No build step. What's in the repo is what GitHub Pages serves.
- All asset paths are **relative** (`./js/app.js`, `flags/fr.svg`), never root-absolute (`/js/app.js`), because Pages serves the app from `/flags/`.

## Tests

- Node's built-in runner: `node --test` (CI runs the same on Node 24).
- Test files live in `test/` and are named `<module>.test.js` (e.g. `test/srs.test.js`).
- Node's default discovery runs **every** `.js` file under `test/` as a test. Fixtures go in as `.json`, and shared helpers live outside `test/` (e.g. `test-support/`).
- Use `node:test` (`describe`/`it` or `test`) and `node:assert/strict`.
- Pure modules (`js/srs.js`, `js/quiz.js`) take state and data as arguments: no DOM, no `localStorage`, no `fetch`, and no hidden `Date.now()` or `Math.random()`. Inject `today` and an `rng` function (`() => number` in `[0, 1)`) so tests are deterministic.

## Dates

- SRS scheduling is day-granular. `dueDate` and every injected `today` is an ISO local calendar date string, `YYYY-MM-DD`, computed by the caller (the app) from the device's local time. Pure modules never read the clock or the timezone.

## JavaScript style

- 2-space indentation, semicolons, `const` by default, single quotes.
- `camelCase` for functions and variables (matching the spec's data fields: `easeFactor`, `parentCode`), `SCREAMING_SNAKE_CASE` for module-level constants, `PascalCase` for classes.
- Verb-noun function names (`pickDistractors`, `updateCardState`, `filterSuggestions`).
- JSDoc on every exported function (`@param` with types, `@returns`).
- Defensive validation in every exported function: throw `TypeError`/`RangeError` with a specific message that wraps parameter names in backticks, e.g. `` throw new TypeError('`easeFactor` must be a finite number.') ``.

## DOM safety

- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` with interpolated or concatenated strings. Build nodes with `document.createElement` and set `textContent` and attributes.
- Flag SVGs are only ever rendered via `<img src="flags/<code>.svg">`. Never inline them (no `fetch` + insert, no `<object>`/`<embed>`/`<iframe>`, no `<use href="flags/…">`). Inlining would expose script-capable SVG to the DOM and leak answers through text some flags carry in `aria-label` (e.g. `gu.svg`, `sm.svg`). See [`DATA.md`](DATA.md#svg-safety).
- Before the answer is revealed, flag `<img>` `alt` text is generic (`"Flag to identify"`). It must never contain the country name.
- CSP-ready from day one (#8 adds `default-src 'self'`): no inline `<script>` blocks, no `style="..."` attributes, no inline event handlers (`onclick=`). Use external files, CSS classes and `addEventListener`.

## Git

- One implementation issue = one branch `issue-<n>-<slug>`, where `<n>` is the **spec** number (e.g. `issue-1-country-data`) = one PR whose body says `Closes #<GitHub number>`. GitHub numbers are spec number + 1. The review issues (#10–#12) have no branch.
- Pass `--repo niklasjohannes/flags` to every `gh` call.

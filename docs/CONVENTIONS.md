# Conventions

Shared rules for every issue in [`SPEC.md`](SPEC.md). If something here conflicts with the spec, the spec wins.

## Modules and dependencies

- Plain ES modules (`import`/`export`), loaded in the browser via `<script type="module">` and in Node via `package.json`'s `"type": "module"`.
- **Zero npm dependencies**, including dev dependencies. `package.json` exists only for `"type": "module"`.
- No build step. What's in the repo is what GitHub Pages serves.
- All asset paths are **relative** (`./js/app.js`, `flags/fr.svg`), never root-absolute (`/js/app.js`), because Pages serves the app from `/flags/`.

## Tests

- Node's built-in runner: `node --test` (CI runs the same on Node 24).
- Test files live in `test/` and are named `<module>.test.js` (e.g. `test/srs.test.js`).
- Use `node:test` (`describe`/`it` or `test`) and `node:assert/strict`.
- Pure modules (`js/srs.js`, `js/quiz.js`) take state and data as arguments: no DOM, no `localStorage`, no `fetch`, and no hidden `Date.now()` or `Math.random()`. Inject `now`/`today` and an `rng` function so tests are deterministic.

## JavaScript style

- 2-space indentation, semicolons, `const` by default, single quotes.
- `camelCase` for functions and variables (matching the spec's data fields: `easeFactor`, `parentCode`), `SCREAMING_SNAKE_CASE` for module-level constants, `PascalCase` for classes.
- Verb-noun function names (`pickDistractors`, `updateCardState`, `filterSuggestions`).
- JSDoc on every exported function (`@param` with types, `@returns`).
- Defensive validation in every exported function: throw `TypeError`/`RangeError` with a specific message that wraps parameter names in backticks, e.g. `` throw new TypeError('`easeFactor` must be a finite number.') ``.

## DOM safety

- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` with interpolated or concatenated strings. Build nodes with `document.createElement` and set `textContent` and attributes.
- Before the answer is revealed, flag `<img>` `alt` text is generic (`"Flag to identify"`). It must never contain the country name.

## Git

- One issue = one branch `issue-<n>-<slug>` = one PR whose body says `Closes #<GitHub number>`. GitHub numbers are spec number + 1.
- Pass `--repo niklasjohannes/flags` to every `gh` call.

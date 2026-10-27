# Flags

A zero-dependency progressive web app for learning the flags of the world with spaced repetition. Plain HTML, CSS and JavaScript — no build step, no npm packages.

> Work in progress. See [`docs/SPEC.md`](docs/SPEC.md) for the build plan.

## Layout

| Path | Contents |
| --- | --- |
| `index.html` | App entry point |
| `css/` | Stylesheets |
| `js/` | App modules (SRS engine, quiz engine, views) |
| `data/` | Country metadata (`countries.json`, generated; see [`docs/DATA.md`](docs/DATA.md)) |
| `flags/` | Vendored flag SVGs |
| `icons/` | PWA / home-screen icons |
| `scripts/` | Dev-only data generator (`build-countries.js`) and its hand-maintained overrides |
| `vendor/` | Unmodified upstream inputs (flag-icons code list and license) |
| `test/` | `node --test` suites |

## Running the tests

Tests use Node's built-in test runner — nothing to install:

```bash
node --test
```

CI runs the same command on every push and pull request.

## License

[MIT](LICENSE)

# Flags

A zero-dependency progressive web app for learning the flags of the world with spaced repetition. Plain HTML, CSS and JavaScript — no build step, no npm packages.

> Work in progress. See [`docs/SPEC.md`](docs/SPEC.md) for the build plan.

## Layout

| Path | Contents |
| --- | --- |
| `index.html` | App entry point |
| `css/` | Stylesheets |
| `js/` | App modules (SRS engine, quiz engine, views) |
| `data/` | Country metadata (`countries.json`) |
| `flags/` | Vendored flag SVGs |
| `icons/` | PWA / home-screen icons |

## Running the tests

Tests use Node's built-in test runner — nothing to install:

```bash
node --test
```

CI runs the same command on every push and pull request.

## License

[MIT](LICENSE)

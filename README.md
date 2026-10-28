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

## Running locally

Serve the repo root with the bundled dev server (Python standard library only, binds `127.0.0.1`, sends `Cache-Control: no-store`):

```bash
/usr/bin/python3 scripts/dev_server.py 8004
```

then open <http://127.0.0.1:8004/>. Any static server works too. Opening `index.html` as a file does not, because `fetch` of `data/countries.json` needs HTTP.

### Local preview (Claude Code desktop)

`.claude/launch.json` defines `flags-static`, which runs the same command for the in-app browser preview. The server finds the repo root from its own path and never reads the working directory. That matters because the preview launcher may be unable to read it.

If the launcher reports `can't open file 'scripts/dev_server.py': [Errno 1] Operation not permitted`, it has no permission to read the checkout. This happens for checkouts under `~/Documents` when macOS has not granted the app access to that folder. A committed config can't fix that. Either grant the Claude app access to the folder (System Settings → Privacy & Security → Files and Folders, or Full Disk Access), or keep the checkout outside the protected folders. In the meantime, run the command above from a terminal or shell session and preview <http://127.0.0.1:8004/> in a browser. Keep any scratch files in the gitignored `.tmp/` inside the checkout.

## Running the tests

Tests use Node's built-in test runner — nothing to install:

```bash
node --test
```

CI runs the same command on every push and pull request.

## License

[MIT](LICENSE)

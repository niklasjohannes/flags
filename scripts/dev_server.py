"""Local static server for previewing the app. Development only.

Serves the repo root, found from this file's location rather than the current
directory. It never calls ``os.getcwd()``, so it also starts when the launcher
cannot read the working directory (as happens with the desktop preview
launcher and worktrees under ``~/Documents``). It binds ``127.0.0.1`` only and
sends ``Cache-Control: no-store``, so every reload picks up edited files.

Usage::

    /usr/bin/python3 /absolute/path/to/scripts/dev_server.py [PORT] [--base /flags/] [--gzip]

``PORT`` defaults to 8004. ``--base`` serves the repo under that path prefix
instead of ``/``, exactly as GitHub Pages serves this project site
(``/flags/``), so the manifest's ``start_url``/``scope`` and the service
worker's scope can be checked as they will be live. Then ``/flags`` redirects
to ``/flags/`` (as Pages does) and anything outside the prefix is a 404.
``--gzip`` gzips file responses for clients that accept it, with
``Content-Encoding: gzip`` and the compressed ``Content-Length``, as Pages'
CDN does, so code that re-wraps fetched bodies can be checked against it.
Python standard library only, 3.9+.
"""

from __future__ import annotations

import argparse
import functools
import gzip
import os
import re
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOST = '127.0.0.1'
DEFAULT_PORT = 8_004
DEFAULT_BASE = '/'

# One or more plain path segments, e.g. `/flags/` or `/a/b/`.
BASE_PATTERN = re.compile(r'^/(?:[A-Za-z0-9._-]+/)*$')

# Pure string work on `__file__`, never `getcwd`/`abspath`/`realpath`. A
# relative `__file__` (`scripts/dev_server.py`) gives a relative root, which
# the OS resolves against the working directory without needing to read its
# parents.
ROOT = os.path.dirname(os.path.dirname(__file__)) or os.curdir


class NoStoreHandler(SimpleHTTPRequestHandler):
    """Static file handler that tells the browser not to cache anything.

    Serves the directory under ``base`` (``/`` or a prefix like ``/flags/``).
    """

    # GitHub Pages' types for the files the app serves.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.webmanifest': 'application/manifest+json',
    }

    def __init__(self, *args, base: str = DEFAULT_BASE, use_gzip: bool = False, **kwargs) -> None:
        self.base = base
        self.use_gzip = use_gzip
        super().__init__(*args, **kwargs)

    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self) -> None:
        if self.route() and not self.send_gzipped():
            super().do_GET()

    def send_gzipped(self) -> bool:
        """Send the file gzipped if enabled and accepted; ``True`` if sent."""
        if not self.use_gzip or 'gzip' not in self.headers.get('Accept-Encoding', ''):
            return False
        path = self.translate_path(urlsplit(self.path).path)
        if os.path.isdir(path):
            if not urlsplit(self.path).path.endswith('/'):
                return False
            path = os.path.join(path, 'index.html')
        if not os.path.isfile(path):
            return False
        with open(path, 'rb') as file:
            body = gzip.compress(file.read(), mtime=0)
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    def do_HEAD(self) -> None:
        if self.route():
            super().do_HEAD()

    def route(self) -> bool:
        """Handle requests outside ``base``; ``True`` if inside it."""
        path = urlsplit(self.path).path
        if path.startswith(self.base):
            return True
        if path == self.base.rstrip('/'):
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header('Location', self.base)
            self.send_header('Content-Length', '0')
            self.end_headers()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)
        return False

    def translate_path(self, path: str) -> str:
        # `route` has checked the prefix; map `<base>x` to `<ROOT>/x`.
        if path.startswith(self.base):
            path = '/' + path[len(self.base):]
        return super().translate_path(path)


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Read the port and base path from the command-line arguments.

    Parameters
    ----------
    argv
        Arguments after the script name.

    Returns
    -------
    argparse.Namespace
        ``port`` (``DEFAULT_PORT`` if none is given), ``base`` (starts and
        ends with ``/``; ``DEFAULT_BASE`` if none is given) and ``gzip``.
    """
    parser = argparse.ArgumentParser(prog='dev_server.py', description='Serve the app locally.')
    parser.add_argument('port', nargs='?', default=DEFAULT_PORT, help=f'TCP port (default {DEFAULT_PORT}).')
    parser.add_argument('--base', default=DEFAULT_BASE, help='Path prefix to serve under, e.g. /flags/ (default /).')
    parser.add_argument('--gzip', action='store_true', help='Gzip file responses, as the GitHub Pages CDN does.')
    args = parser.parse_args(argv)
    try:
        args.port = int(args.port)
    except ValueError:
        raise SystemExit('`PORT` must be an integer.') from None
    if not 1 <= args.port <= 65_535:
        raise SystemExit('`PORT` must be between 1 and 65535.')
    base = args.base if args.base.endswith('/') else f'{args.base}/'
    if not BASE_PATTERN.match(base) or '/../' in base or '/./' in base:
        raise SystemExit('`--base` must be a path like /flags/ (letters, digits, `._-` segments).')
    args.base = base
    return args


def serve(port: int, base: str = DEFAULT_BASE, use_gzip: bool = False) -> None:
    """Serve ``ROOT`` on ``HOST:port`` under ``base`` until interrupted.

    Parameters
    ----------
    port
        TCP port to listen on.
    base
        Path prefix, starting and ending with ``/``.
    use_gzip
        Gzip file responses for clients that accept it.

    Returns
    -------
    None
    """
    handler = functools.partial(NoStoreHandler, directory=ROOT, base=base, use_gzip=use_gzip)
    with ThreadingHTTPServer((HOST, port), handler) as server:
        print(f'Serving {ROOT} at http://{HOST}:{port}{base}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    arguments = parse_args(sys.argv[1:])
    serve(arguments.port, arguments.base, arguments.gzip)

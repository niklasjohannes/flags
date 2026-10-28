"""Local static server for previewing the app. Development only.

Serves the repo root, found from this file's location rather than the current
directory. It never calls ``os.getcwd()``, so it also starts when the launcher
cannot read the working directory (as happens with the desktop preview
launcher and worktrees under ``~/Documents``). It binds ``127.0.0.1`` only and
sends ``Cache-Control: no-store``, so every reload picks up edited files.

Usage::

    /usr/bin/python3 /absolute/path/to/scripts/dev_server.py [PORT]

``PORT`` defaults to 8004. Python standard library only, 3.9+.
"""

from __future__ import annotations

import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST = '127.0.0.1'
DEFAULT_PORT = 8_004

# Pure string work on `__file__`, never `getcwd`/`abspath`/`realpath`. A
# relative `__file__` (`scripts/dev_server.py`) gives a relative root, which
# the OS resolves against the working directory without needing to read its
# parents.
ROOT = os.path.dirname(os.path.dirname(__file__)) or os.curdir


class NoStoreHandler(SimpleHTTPRequestHandler):
    """Static file handler that tells the browser not to cache anything."""

    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def parse_port(argv: list[str]) -> int:
    """Read the port from the command-line arguments.

    Parameters
    ----------
    argv
        Arguments after the script name; empty, or a single port number.

    Returns
    -------
    int
        The port, ``DEFAULT_PORT`` if none is given.
    """
    if len(argv) == 0:
        return DEFAULT_PORT
    if len(argv) > 1:
        raise SystemExit('Usage: dev_server.py [PORT]')
    try:
        port = int(argv[0])
    except ValueError:
        raise SystemExit('`PORT` must be an integer.') from None
    if not 1 <= port <= 65_535:
        raise SystemExit('`PORT` must be between 1 and 65535.')
    return port


def serve(port: int) -> None:
    """Serve ``ROOT`` on ``HOST:port`` until interrupted.

    Parameters
    ----------
    port
        TCP port to listen on.

    Returns
    -------
    None
    """
    handler = functools.partial(NoStoreHandler, directory=ROOT)
    with ThreadingHTTPServer((HOST, port), handler) as server:
        print(f'Serving {ROOT} at http://{HOST}:{port}/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    serve(parse_port(sys.argv[1:]))

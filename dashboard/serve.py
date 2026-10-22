"""Static file server for the dashboard that never lets the browser cache files, so edits show
up on a normal refresh. Usage: python serve.py [port]"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


# Serve every file with Cache-Control: no-store so edits to the dashboard show up on a normal refresh.
class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    handler = partial(NoCacheHandler, directory=".")
    # bind to loopback only: this is a local development server
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()

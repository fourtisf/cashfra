"""Local dev server that mirrors the production headers.

    python3 dev-server.py [port] [root]      # defaults: 8000 .

`python3 -m http.server` sends no cache headers, and the browser will then
happily hold on to a stale `sw.js` — which silently blocks every update. Use
this instead so local behaviour matches what .htaccess / deploy/nginx.conf do
on the real host.
"""
import sys, functools, http.server, socketserver

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        p = self.path.split('?')[0]
        if p.endswith(('.png', '.ico')):
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        else:                                   # html, json, sw.js
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        if p.endswith('sw.js'):
            self.send_header('Service-Worker-Allowed', '/')
        self.send_header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()
    def log_message(self, fmt, *a):
        sys.stderr.write('%s  %s\n' % (self.log_date_time_string(), fmt % a))

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
root = sys.argv[2] if len(sys.argv) > 2 else '.'
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', port),
                            functools.partial(H, directory=root)) as s:
    print('cashfra dev server: http://127.0.0.1:%d/  (root: %s)' % (port, root))
    s.serve_forever()

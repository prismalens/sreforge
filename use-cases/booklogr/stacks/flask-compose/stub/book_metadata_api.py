#!/usr/bin/env python3
"""Book-metadata API for booklogr's BookProvider.

Implements the endpoints BookProvider hits when DATA_PROVIDER is a custom URL
(the "booklogr-api" provider shape): /v1/search/<q>, /v1/edition/<isbn>,
/v1/work/<id>. Self-contained (stdlib only) so the deployment serves book
metadata locally instead of depending on the public internet API.
"""
import hashlib
import json
import os
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

import threading

from prometheus_client import Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST

PORT = int(os.environ.get("PORT", "8080"))

# Service metrics. Single-process ThreadingHTTPServer, so
# the default (non-multiprocess) registry is fine and thread-safe. /metrics and
# /health are deliberately NOT counted as metadata requests.
REQUESTS = Counter(
    "book_metadata_requests_total", "Metadata requests served, by endpoint.", ["endpoint"]
)
PROVIDER_ERRORS = Counter(
    "book_metadata_provider_errors_total", "Provider errors returned by endpoint.", ["endpoint"]
)
INFLIGHT = Gauge(
    "book_metadata_inflight_requests", "Metadata requests currently being served."
)
DURATION = Histogram(
    "book_metadata_request_duration_seconds", "Wall-clock duration of a metadata request handler."
)

_search_counter = 0
_search_counter_lock = threading.Lock()

# A small local catalogue. Real-looking titles/authors/page-counts so responses
# read like a genuine metadata provider's rather than placeholders.
CATALOGUE = [
    ("Dune", ["Frank Herbert"], 412),
    ("The Hobbit", ["J. R. R. Tolkien"], 310),
    ("1984", ["George Orwell"], 328),
    ("Sapiens: A Brief History of Humankind", ["Yuval Noah Harari"], 443),
    ("Dracula", ["Bram Stoker"], 418),
    ("Mistborn: The Final Empire", ["Brandon Sanderson"], 541),
    ("Hyperion", ["Dan Simmons"], 482),
    ("Neuromancer", ["William Gibson"], 271),
    ("The Name of the Wind", ["Patrick Rothfuss"], 662),
    ("Project Hail Mary", ["Andy Weir"], 476),
    ("The Left Hand of Darkness", ["Ursula K. Le Guin"], 304),
    ("Foundation", ["Isaac Asimov"], 244),
    ("The Fifth Season", ["N. K. Jemisin"], 468),
    ("Snow Crash", ["Neal Stephenson"], 470),
    ("A Wizard of Earthsea", ["Ursula K. Le Guin"], 183),
    ("The Road", ["Cormac McCarthy"], 287),
]

DESCRIPTIONS = [
    "A landmark of the genre, widely praised for its richly imagined world and lasting influence.",
    "A character-driven story that balances intimate stakes against a sweeping backdrop.",
    "Acclaimed on release and a fixture of best-of lists in the years since.",
    "A tightly plotted novel that rewards re-reading for its layered structure.",
    "Translated into dozens of languages and adapted for screen and stage.",
]


def _seed(key):
    return int(hashlib.sha256(key.encode()).hexdigest(), 16)


def _isbn13(idx, key):
    # Valid ISBN-13 (978 prefix + check digit). The catalogue index is encoded
    # in two digits so an /v1/edition lookup of this ISBN resolves to the same
    # book the search result advertised (search<->edition stay consistent).
    body = "978" + "{:02d}".format(idx % 100) + "{:07d}".format(_seed(key) % 10**7)
    total = sum((1 if i % 2 == 0 else 3) * int(d) for i, d in enumerate(body))
    return body + str((10 - total % 10) % 10)


def _idx_from_isbn(isbn):
    digits = "".join(ch for ch in isbn if ch.isdigit())
    if len(digits) >= 5 and digits.startswith("978"):
        return int(digits[3:5]) % len(CATALOGUE)
    return _seed(isbn) % len(CATALOGUE)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_response(self, code, message=None):
        # Standard status line + Date, without a Server banner.
        self.log_request(code)
        self.send_response_only(code, message)
        self.send_header("Date", self.date_time_string())

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _metrics(self):
        body = generate_latest()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPE_LATEST)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        # Scrape + liveness paths: not metadata traffic, so not counted or slowed.
        if path == "/metrics":
            return self._metrics()
        if path == "/health":
            return self._json(200, {"ok": True})

        parts = [p for p in path.split("/") if p]
        endpoint = parts[1] if len(parts) >= 2 and parts[0] == "v1" else "other"
        REQUESTS.labels(endpoint=endpoint).inc()
        INFLIGHT.inc()
        _started = time.perf_counter()
        try:
            rate = float(os.environ.get("SEARCH_ERROR_RATE", "0"))
            if rate > 0 and len(parts) >= 3 and parts[:2] == ["v1", "search"]:
                with _search_counter_lock:
                    global _search_counter
                    _search_counter += 1
                    req_idx = _search_counter
                if (req_idx % 25) < int(round(rate * 25)):
                    PROVIDER_ERRORS.labels(endpoint="search").inc()
                    return self._json(503, {"message": "Service Temporarily Unavailable"})

            time.sleep(random.uniform(1.1, 1.3))

            if len(parts) >= 3 and parts[:2] == ["v1", "edition"]:
                isbn = unquote(parts[2])
                title, authors, pages = CATALOGUE[_idx_from_isbn(isbn)]
                s = _seed(isbn)
                return self._json(200, {
                    "title": title,
                    "author_names": authors,
                    "work_ids": ["/works/OL{}W".format(s % 9000000 + 1000000)],
                    "number_of_pages": pages,
                })
            if len(parts) >= 3 and parts[:2] == ["v1", "work"]:
                wid = unquote(parts[2])
                return self._json(200, {"description": DESCRIPTIONS[_seed(wid) % len(DESCRIPTIONS)]})
            if len(parts) >= 3 and parts[:2] == ["v1", "search"]:
                q = unquote(parts[2]).strip().lower()
                matched = [(i, b) for i, b in enumerate(CATALOGUE) if q and q in b[0].lower()]
                if not matched:
                    s = _seed(q)
                    matched = [((s + i) % len(CATALOGUE), CATALOGUE[(s + i) % len(CATALOGUE)]) for i in range(5)]
                out = []
                for idx, (title, authors, _pages) in matched:
                    out.append({
                        "isbn_13": [_isbn13(idx, title)],
                        "isbn_10": [],
                        "title": title,
                        "author_names": authors,
                    })
                return self._json(200, out)
            return self._json(404, {"message": "Not found"})
        finally:
            INFLIGHT.dec()
            DURATION.observe(time.perf_counter() - _started)

    def log_message(self, *args):
        pass  # quiet


if __name__ == "__main__":
    print("book-metadata-api listening on :{}".format(PORT), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

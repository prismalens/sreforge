#!/usr/bin/env bash
set -euo pipefail
sed -i 's/    CACHE_TYPE = "SimpleCache"/    CACHE_TYPE = "NullCache"/' api/config.py
grep -q 'CACHE_TYPE = "NullCache"' api/config.py
touch -r api/models.py api/config.py

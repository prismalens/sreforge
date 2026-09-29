#!/usr/bin/env bash
set -euo pipefail
line='print("booklogr-api boot: cache backend=" + str(app.config.get("CACHE_TYPE")))'
awk -v line="$line" '{ print } /^app\.config\.from_object\(Config\)$/ && !done { print line; done=1 }' api/app.py > api/app.py.tmp
mv api/app.py.tmp api/app.py
grep -q 'booklogr-api boot: cache backend=' api/app.py
touch -r api/models.py api/app.py

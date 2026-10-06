#!/bin/sh
# Start a crawl through the local API, wait for it, then download both exports.
# Usage: sh examples/api_crawl.sh https://example.com
set -eu
BASE="${CHROMASPIDER_URL:-http://127.0.0.1:8788}"
URL="${1:-https://example.com}"

ID=$(curl -s -X POST "$BASE/api/crawl" \
  -H 'Content-Type: application/json' \
  -d "{\"url\": \"$URL\", \"depth\": 1, \"max_pages\": 10, \"same_domain\": true}" |
  python3 -c 'import sys, json; d = json.load(sys.stdin); print(d.get("id") or sys.exit(d))')
echo "crawl id: $ID"

while [ "$(curl -s "$BASE/api/crawls/$ID/graph" | python3 -c 'import sys, json; print(json.load(sys.stdin)["status"])')" = running ]; do
  sleep 1
done

curl -s "$BASE/api/crawls/$ID/export?format=json" -o "crawl-$ID.json"
curl -s "$BASE/api/crawls/$ID/export?format=markdown" -o "crawl-$ID.md"
echo "wrote crawl-$ID.json and crawl-$ID.md"

#!/bin/bash
# Usage: ADMIN_EMAIL=you@example.org ADMIN_PASSWORD='...' ./test-api.sh
# Optional: BASE_URL (default http://localhost:5000/api)

BASE_URL="${BASE_URL:-http://localhost:5000/api}"

if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "Set ADMIN_EMAIL and ADMIN_PASSWORD first." >&2
  exit 1
fi

echo "🧪 ISKCON Seva Pass API Test Suite"
echo "====================================="

# Test 1: Login with valid credentials (expected: 200 OK with token)
LOGIN_BODY=$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
RESPONSE=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "$LOGIN_BODY")
echo "$RESPONSE"

TOKEN=$(echo "$RESPONSE" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

# Test 2: Get profile (expected: 200 OK with user data)
curl -s -X GET "$BASE_URL/auth/profile" \
  -H "Authorization: Bearer $TOKEN"
echo

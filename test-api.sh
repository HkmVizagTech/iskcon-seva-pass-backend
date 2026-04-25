#!/bin/bash

BASE_URL="http://localhost:5000/api"
TOKEN=""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🧪 ISKCON Seva Pass API Test Suite"
echo "====================================="

# Test 1: Login with valid credentials
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@iskconvizag.org",
    "password": "Admin@123"
  }'

# Expected: 200 OK with token



# Test 3: Get profile
curl -X GET http://localhost:5000/api/auth/profile \
  -H "Authorization: Bearer $TOKEN"

# Expected: 200 OK with user data

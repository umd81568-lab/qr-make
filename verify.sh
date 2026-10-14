#!/bin/bash
# QR-Doc Publisher - End-to-End Verification
# Tests: Backend health, Auth, DB, API, File serving, Public redirect

set -e
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

API="http://localhost:3001"
ADMIN_USER="admin"
ADMIN_PASS="${ADMIN_PASS:-admin123}"

pass=0
fail=0

check() {
  if [ $1 -eq 0 ]; then
    echo -e "${GREEN}✓${NC} $2"
    ((pass++))
  else
    echo -e "${RED}✗${NC} $2"
    ((fail++))
  fi
}

echo "═══════════════════════════════════════"
echo "  QR-Doc Publisher v2.0 — Verification"
echo "═══════════════════════════════════════"
echo ""

# 1. PM2 running
echo -e "${YELLOW}[1] Process Check${NC}"
pm2 list 2>/dev/null | grep -q "qrdoc.*online" && check 0 "PM2: qrdoc process online" || check 1 "PM2: qrdoc NOT running"
[ -d /www/wwwroot/qrdoc ] && check 0 "App directory exists" || check 1 "App directory missing"
[ -f /www/wwwroot/qrdoc/.env ] && check 0 ".env file exists" || check 1 ".env missing"

# 2. Database
echo ""
echo -e "${YELLOW}[2] Database Check${NC}"
DB_USER=$(grep DB_USER /www/wwwroot/qrdoc/.env | cut -d= -f2)
DB_PASS=$(grep DB_PASSWORD /www/wwwroot/qrdoc/.env | cut -d= -f2)
DB_NAME=$(grep DB_NAME /www/wwwroot/qrdoc/.env | cut -d= -f2)
mysql -u ${DB_USER} -p"${DB_PASS}" -e "USE ${DB_NAME}; SHOW TABLES;" > /tmp/dbt.log 2>&1
[ $? -eq 0 ] && check 0 "MySQL connection OK" || check 1 "MySQL connection failed"
grep -q "qr_links" /tmp/dbt.log && check 0 "Table: qr_links" || check 1 "Table: qr_links missing"
grep -q "users" /tmp/dbt.log && check 0 "Table: users" || check 1 "Table: users missing"
grep -q "scan_logs" /tmp/dbt.log && check 0 "Table: scan_logs" || check 1 "Table: scan_logs missing"

# 3. API
echo ""
echo -e "${YELLOW}[3] API Endpoints${NC}"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" ${API}/api/auth/me)
[ "$HTTP" = "401" ] && check 0 "GET /api/auth/me (401 expected)" || check 1 "GET /api/auth/me (got $HTTP)"

# Login
LOGIN_RES=$(curl -s -X POST ${API}/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")
TOKEN=$(echo "$LOGIN_RES" | grep -oP '"token":"\K[^"]+' | head -1)
[ -n "$TOKEN" ] && check 0 "POST /api/auth/login (token received)" || check 1 "Login failed"

# Authenticated endpoints
[ -n "$TOKEN" ] && {
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" ${API}/api/links)
  [ "$HTTP" = "200" ] && check 0 "GET /api/links (auth)" || check 1 "GET /api/links (got $HTTP)"

  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" ${API}/api/analytics/overview)
  [ "$HTTP" = "200" ] && check 0 "GET /api/analytics/overview" || check 1 "Analytics failed"

  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" ${API}/api/domains)
  [ "$HTTP" = "200" ] && check 0 "GET /api/domains" || check 1 "Domains failed"
}

# 4. Public endpoint
echo ""
echo -e "${YELLOW}[4] Public Endpoint${NC}"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" ${API}/d/nonexistent-test-slug-xyz)
[ "$HTTP" = "404" ] && check 0 "GET /d/:slug (404 for invalid)" || check 1 "Got $HTTP"

# 5. Frontend
echo ""
echo -e "${YELLOW}[5] Frontend Files${NC}"
[ -f /www/wwwroot/qrdoc/client/dist/index.html ] && check 0 "index.html exists" || check 1 "index.html missing"
[ -d /www/wwwroot/qrdoc/client/dist/assets ] && check 0 "assets/ folder exists" || check 1 "assets/ missing"
ASSETS=$(ls /www/wwwroot/qrdoc/client/dist/assets/ 2>/dev/null | wc -l)
[ "$ASSETS" -ge 2 ] && check 0 "assets/ has $ASSETS files" || check 1 "assets/ empty"

# 6. Nginx
echo ""
echo -e "${YELLOW}[6] Nginx${NC}"
systemctl is-active nginx > /dev/null && check 0 "Nginx running" || check 1 "Nginx not running"
nginx -t 2>/dev/null && check 0 "Nginx config valid" || check 1 "Nginx config invalid"

# Summary
echo ""
echo "═══════════════════════════════════════"
echo -e "  ${GREEN}Passed: $pass${NC} | ${RED}Failed: $fail${NC}"
echo "═══════════════════════════════════════"
[ $fail -eq 0 ] && {
  echo -e "${GREEN}✅ ALL CHECKS PASSED${NC}"
  echo ""
  echo "🚀 Your QR-Doc Publisher is ready!"
  echo "  Admin:  http://YOUR_DOMAIN/admin"
  echo "  Public: http://YOUR_DOMAIN/d/TEST_SLUG"
  exit 0
} || {
  echo -e "${RED}❌ Some checks failed. See above.${NC}"
  exit 1
}

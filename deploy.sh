#!/bin/bash
# QR-Doc Publisher - Automated Deployment Script
# Ubuntu 24.04 / 22.04 / 20.04 compatible
# Run as: sudo bash deploy.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

APP_DIR="/www/wwwroot/qrdoc"
APP_USER="www-data"
DOMAIN="${DOMAIN:-yourdomain.com}"
DB_NAME="qrdoc"
DB_USER="qrdoc"
DB_PASS="${DB_PASS:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)}"

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   QR-Doc Publisher v2.0 Deployment       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# Check root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}❌ Please run as root: sudo bash deploy.sh${NC}"
  exit 1
fi

# Step 1: System update
echo -e "${YELLOW}[1/9]${NC} Updating system..."
apt update -qq && apt upgrade -y -qq

# Step 2: Install prerequisites
echo -e "${YELLOW}[2/9]${NC} Installing prerequisites..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null
  apt install -y -qq nodejs
fi
if ! command -v nginx &> /dev/null; then
  apt install -y -qq nginx
fi
if ! command -v mysql &> /dev/null; then
  DEBIAN_FRONTEND=noninteractive apt install -y -qq mysql-server
fi
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2 -s
fi
apt install -y -qq git ufw openssl curl
echo -e "${GREEN}  ✓ Prereqs installed (Node $(node -v), Nginx $(nginx -v 2>&1 | awk '{print $3}'))${NC}"

# Step 3: MySQL setup
echo -e "${YELLOW}[3/9]${NC} Setting up MySQL..."
systemctl start mysql
systemctl enable mysql

# Create DB and user (idempotent)
mysql -u root <<EOF
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
EOF
echo -e "${GREEN}  ✓ Database '${DB_NAME}' ready${NC}"

# Step 4: Copy application files
echo -e "${YELLOW}[4/9]${NC} Copying application files..."
mkdir -p ${APP_DIR}
# Get script directory (assumes running from extracted folder)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r ${SCRIPT_DIR}/server ${APP_DIR}/
cp -r ${SCRIPT_DIR}/client/dist ${APP_DIR}/client/
cp ${SCRIPT_DIR}/package.json ${APP_DIR}/
cp ${SCRIPT_DIR}/package-lock.json ${APP_DIR}/ 2>/dev/null || true
mkdir -p ${APP_DIR}/uploads ${APP_DIR}/qrcodes
chown -R ${APP_USER}:${APP_USER} ${APP_DIR}
chmod -R 755 ${APP_DIR}
echo -e "${GREEN}  ✓ Files copied to ${APP_DIR}${NC}"

# Step 5: Generate .env
echo -e "${YELLOW}[5/9]${NC} Generating .env file..."
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
ADMIN_PASS="${ADMIN_PASSWORD:-admin123}"

cat > ${APP_DIR}/.env <<EOF
PORT=3001
DB_HOST=localhost
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_NAME=${DB_NAME}
JWT_SECRET=${JWT_SECRET}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASS}
ALLOWED_ORIGINS=
EOF
chmod 600 ${APP_DIR}/.env
chown ${APP_USER}:${APP_USER} ${APP_DIR}/.env
echo -e "${GREEN}  ✓ .env generated (DB password: ${DB_PASS})${NC}"

# Step 6: Install dependencies
echo -e "${YELLOW}[6/9]${NC} Installing npm dependencies..."
cd ${APP_DIR}
sudo -u ${APP_USER} npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

# Step 7: Nginx configuration
echo -e "${YELLOW}[7/9]${NC} Configuring Nginx..."
cat > /etc/nginx/conf.d/qrdoc.conf <<EOF
# QR-Doc Publisher - Nginx config
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN} *.*;

    root ${APP_DIR}/client/dist;
    index index.html;

    client_max_body_size 50M;

    # Static files
    location /uploads/ {
        alias ${APP_DIR}/uploads/;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
    }

    location /qrcodes/ {
        alias ${APP_DIR}/qrcodes/;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000";
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # Public link redirect (qr-doc handles this directly)
    location /d/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    # Admin SPA
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}

# Universal vhost fallback
server {
    listen 80 default_server;
    server_name _;
    return 444;
}
EOF
nginx -t
systemctl reload nginx
echo -e "${GREEN}  ✓ Nginx configured${NC}"

# Step 8: PM2 startup
echo -e "${YELLOW}[8/9]${NC} Starting application with PM2..."
cd ${APP_DIR}
sudo -u ${APP_USER} pm2 delete qrdoc 2>/dev/null || true
sudo -u ${APP_USER} pm2 start server/index.js --name qrdoc
sudo -u ${APP_USER} pm2 startup | grep -v "PM2" | tail -1 | bash
sudo -u ${APP_USER} pm2 save > /dev/null
echo -e "${GREEN}  ✓ PM2 started${NC}"

# Step 9: Firewall
echo -e "${YELLOW}[9/9]${NC} Configuring firewall..."
ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw allow ssh > /dev/null
ufw allow http > /dev/null
ufw allow https > /dev/null
ufw --force enable > /dev/null
echo -e "${GREEN}  ✓ Firewall configured${NC}"

# Run DB migrations
echo -e "${YELLOW}[*]${NC} Running database migrations..."
sleep 3
sudo -u ${APP_USER} node server/migrate.js 2>&1 | tail -5

# Done
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ DEPLOYMENT SUCCESSFUL                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📋 Important Info:${NC}"
echo -e "  • Domain:        http://${DOMAIN}"
echo -e "  • Admin URL:     http://${DOMAIN}/admin"
echo -e "  • DB Password:   ${DB_PASS}"
echo -e "  • Admin Pass:    ${ADMIN_PASS}"
echo -e "  • App Directory: ${APP_DIR}"
echo -e "  • Logs:          pm2 logs qrdoc"
echo ""
echo -e "${YELLOW}⚠️  Save the DB password above!${NC}"
echo -e "${YELLOW}⚠️  Change admin password on first login!${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo -e "  1. Point DNS A record: ${DOMAIN} → $(curl -s ifconfig.me)"
echo -e "  2. Install SSL: ${GREEN}sudo certbot --nginx -d ${DOMAIN}${NC}"
echo -e "  3. Open: ${GREEN}http://${DOMAIN}/admin${NC}"
echo -e "  4. Login: admin / ${ADMIN_PASS}"
echo ""

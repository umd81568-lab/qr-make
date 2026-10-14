# QR-Doc Publisher v2.0 — Deployment Guide

## 📦 প্যাকেজে যা আছে

```
qrdoc-deploy/
├── server/
│   ├── index.js         মূল ব্যাকএন্ড (Express)
│   ├── db.js            MySQL কানেকশন
│   └── migrate.js       DB মাইগ্রেশন
├── client/dist/         বিল্ড করা ফ্রন্টএন্ড
│   ├── index.html
│   └── assets/
├── .env.example         Environment template
├── package.json
├── package-lock.json
├── qrdoc-vhost.conff    Nginx vhost কনফিগার
├── deploy.sh            🚀 স্বয়ংক্রিয় ডিপ্লয়মেন্ট স্ক্রিপ্ট
├── verify.sh            ✅ এন্ড-টু-এন্ড যাচাই স্ক্রিপ্ট
└── README.md            (এই ফাইল)
```

---

## 🎯 যা যা লাগবে (প্রি-রেকুইজিট)

| সফটওয়্যার | সর্বনিম্ন ভার্সন | ইনস্টল কমান্ড (Ubuntu) |
|------------|----------------|-------------------------|
| Node.js | 18+ (20+ recommended) | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt install -y nodejs` |
| MySQL | 8.0+ | `sudo apt install -y mysql-server` |
| Nginx | 1.18+ | `sudo apt install -y nginx` |
| PM2 | latest | `sudo npm install -g pm2` |
| Git | any | `sudo apt install -y git` |

---

## 🚀 দ্রুত ডিপ্লয়মেন্ট (সবচেয়ে সহজ)

```bash
# 1. ফাইল আপলোড (এই পুরো qrdoc-deploy/ ফোল্ডার)
#    scp বা FileZilla দিয়ে /tmp/qrdoc-deploy/ এ কপি

# 2. SSH লগইন
ssh root@YOUR_SERVER_IP

# 3. এক কমান্ডে সব সেটআপ
cd /tmp/qrdoc-deploy
sudo bash deploy.sh
```

**deploy.sh স্বয়ংক্রিয়ভাবে করবে:**
- Node.js, MySQL, Nginx, PM2 ইনস্টল (যদি না থাকে)
- MySQL database + user তৈরি
- ফাইলগুলো `/www/wwwroot/qrdoc/` এ কপি
- npm install (backend + frontend build)
- `.env` ফাইল তৈরি (random JWT secret সহ)
- Nginx vhost কনফিগার
- PM2 দিয়ে backend চালু
- Firewall rules সেটআপ (ufw)
- DB মাইগ্রেশন রান
- Health check

---

## 📋 ম্যানুয়াল ডিপ্লয়মেন্ট (ধাপে ধাপে)

যদি deploy.sh কাজ না করে বা আরো control চান:

### Step 1: প্রি-রেকুইজিট ইনস্টল
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git nginx mysql-server

# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2
sudo npm install -g pm2
```

### Step 2: MySQL সেটআপ
```bash
sudo mysql_secure_installation

sudo mysql -u root <<'EOF'
CREATE DATABASE qrdoc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'qrdoc'@'localhost' IDENTIFIED BY 'YOUR_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON qrdoc.* TO 'qrdoc'@'localhost';
FLUSH PRIVILEGES;
EOF
```

### Step 3: ফাইল কপি
```bash
sudo mkdir -p /www/wwwroot/qrdoc
sudo chown -R $USER:$USER /www/wwwroot/qrdoc
cd /www/wwwroot/qrdoc

# qrdoc-deploy.zip থেকে extract
unzip /tmp/qrdoc-deploy.zip
```

### Step 4: Environment সেটআপ
```bash
cd /www/wwwroot/qrdoc
cp .env.example .env
nano .env
```

**আবশ্যক পরিবর্তন:**
```env
DB_PASSWORD=YOUR_STRONG_PASSWORD         ← MySQL পাসওয়ার্ড
JWT_SECRET=<64 char random>              ← নিচের কমান্ড দিয়ে generate করুন
ADMIN_PASSWORD=<strong password>         ← admin login password
```

JWT Secret generate:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Step 5: Dependencies ও Build
```bash
# Backend dependencies
npm install --production

# Frontend ইতিমধ্যে বিল্ড করা আছে (dist/ ফোল্ডারে)
# যদি rebuild দরকার:
cd client
npm install
npm run build
cd ..
```

### Step 6: Nginx সেটআপ
```bash
sudo cp qrdoc-vhost.conff /etc/nginx/conf.d/qrdoc.conf
sudo nano /etc/nginx/conf.d/qrdoc.conf
# ডোমেইন নাম পরিবর্তন করুন (server_name)

sudo nginx -t
sudo systemctl reload nginx
```

### Step 7: PM2 দিয়ে চালু
```bash
cd /www/wwwroot/qrdoc
pm2 start server/index.js --name qrdoc
pm2 startup
pm2 save
```

### Step 8: Firewall
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

### Step 9: SSL (Let's Encrypt)
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

---

## ✅ এন্ড-টু-এন্ড যাচাই

```bash
# সার্ভারে (deploy.sh চালানোর পর)
cd /www/wwwroot/qrdoc
bash verify.sh
```

অথবা **ম্যানুয়ালি:**

```bash
# 1. Health check
curl http://localhost:3001/api/auth/me
# Expected: 401 (no token) — server চলছে

# 2. Login test
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}'
# Expected: {"success":true, "token":"..."}

# 3. Browser test
# http://yourdomain.com/admin → login form
# http://yourdomain.com/d/TEST_SLUG → 404 (no link yet)
```

---

## 🎯 ডিফল্ট লগইন

```
URL:      https://yourdomain.com/admin
Username: admin
Password: .env-এ যা দিয়েছেন (default: admin123)
```

**⚠️ প্রথম লগইনের পর সাথে সাথে:**
- Settings → Change Password
- Users → অন্য admin তৈরি করুন
- Audit Log চেক করুন

---

## 🔧 কমান্ড রেফারেন্স

```bash
# PM2 commands
pm2 status                    # Status দেখুন
pm2 logs qrdoc                # Logs দেখুন
pm2 restart qrdoc             # Restart
pm2 stop qrdoc                # Stop
pm2 delete qrdoc              # Remove

# Logs
tail -f /var/log/nginx/error.log
tail -f /www/wwwroot/qrdoc/.pm2/logs/*

# Database
mysql -u qrdoc -p qrdoc
> SELECT * FROM qr_links;
> SELECT * FROM users;
> SELECT COUNT(*) FROM scan_logs;
```

---

## 🐛 সাধারণ সমস্যা ও সমাধান

| সমস্যা | সমাধান |
|--------|--------|
| 502 Bad Gateway | `pm2 restart qrdoc` — backend চলছে কিনা দেখুন |
| MySQL connection error | `sudo systemctl status mysql` + DB_PASSWORD চেক |
| QR কোড তৈরি হচ্ছে না | `qrcodes/` folder permission: `chmod 755 qrcodes uploads` |
| File upload fails | `uploads/` folder size, disk space, PHP/nginx limit |
| Frontend দেখাচ্ছে না | `ls /www/wwwroot/qrdoc/client/dist/` — build আছে কিনা |
| SSL কাজ করছে না | `sudo certbot renew --dry-run` |
| 403 Forbidden | Nginx user www-data, folder owner www-data: `sudo chown -R www-data:www-data /www/wwwroot/qrdoc/` |

বিস্তারিত: `troubleshoot.md` দেখুন।

---

## 📁 ফাইল কাঠামো (সার্ভারে)

```
/www/wwwroot/qrdoc/
├── server/                    ব্যাকএন্ড
├── client/dist/              বিল্ড ফ্রন্টএন্ড
├── uploads/                   আপলোড করা ফাইল (auto-create)
├── qrcodes/                   QR PNG (auto-create)
├── .env                       সিক্রেট config
├── .pm2/                      PM2 logs
├── node_modules/              Dependencies
└── package.json
```

---

## 🔐 নিরাপত্তা চেকলিস্ট

- [ ] `JWT_SECRET` random 64+ chars
- [ ] `ADMIN_PASSWORD` strong (12+ chars, mixed)
- [ ] MySQL root password সেট
- [ ] Firewall: শুধু 22, 80, 443 allow
- [ ] SSL certificate install
- [ ] `.env` file permission 600: `chmod 600 .env`
- [ ] PM2 startup configured
- [ ] Backups: `mysqldump` schedule

---

**Deployment সফল হলে: Admin panel → প্রথম লিংক তৈরি → QR স্ক্যান → ফুল স্ক্রিনে PDF দেখা!**

🚀

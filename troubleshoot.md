# QR-Doc Publisher — সমস্যা ও সমাধান (Troubleshooting)

## 🔥 ১. SSH সংযোগ সমস্যা (সবচেয়ে সাধারণ)

### "Connection timed out"
- **VPS Firewall** সব পোর্ট ব্লক করছে
- সমাধান: Vultr/Hosting Panel → Networking → Firewall → Add Rule: TCP 22 from 0.0.0.0/0
- বিকল্প: Browser-based Console (Vultr: VPS → ⋯ → View Console)

### "Permission denied (publickey)"
- Password auth বন্ধ
- সমাধান: `/etc/ssh/sshd_config` → `PasswordAuthentication yes` → `systemctl restart sshd`

### "Host key verification failed"
- সার্ভার reinstall হয়েছে
- সমাধান: `ssh-keygen -R SERVER_IP`

---

## 🗄️ ২. MySQL সমস্যা

### "ECONNREFUSED 127.0.0.1:3306"
```bash
sudo systemctl status mysql
sudo systemctl start mysql
sudo systemctl enable mysql
```

### "Access denied for user 'qrdoc'@'localhost'"
```bash
# পাসওয়ার্ড রিসেট
sudo mysql
> ALTER USER 'qrdoc'@'localhost' IDENTIFIED BY 'NEW_PASSWORD';
> FLUSH PRIVILEGES;
# .env ফাইলে নতুন পাসওয়ার্ড দিন
```

### "Unknown database 'qrdoc'"
```bash
sudo mysql -u root
> CREATE DATABASE qrdoc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### ডাটাবেস ডেটা রিসেট (সব লিংক মুছবে!)
```bash
sudo mysql -u qrdoc -p qrdoc < backup.sql   # restore আগে
# অথবা
sudo mysql -u root
> DROP DATABASE qrdoc;
> CREATE DATABASE qrdoc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
> GRANT ALL ON qrdoc.* TO 'qrdoc'@'localhost';
cd /www/wwwroot/qrdoc && node server/migrate.js
```

---

## 🚀 ৩. PM2 / Backend সমস্যা

### "qrdoc process not found"
```bash
cd /www/wwwroot/qrdoc
pm2 start server/index.js --name qrdoc
pm2 logs qrdoc    # error দেখুন
```

### "Error: listen EADDRINUSE :::3001"
```bash
# অন্য process 3001 ব্যবহার করছে
sudo lsof -i :3001
sudo kill -9 <PID>
pm2 restart qrdoc
```

### Backend log দেখা
```bash
pm2 logs qrdoc --lines 100
pm2 logs qrdoc --err
```

### পুরোপুরি restart
```bash
pm2 kill
cd /www/wwwroot/qrdoc
pm2 start server/index.js --name qrdoc
pm2 save
```

---

## 🌐 ৪. Nginx সমস্যা

### "502 Bad Gateway"
- Backend (port 3001) চলছে না
```bash
pm2 status
pm2 restart qrdoc
```

### "404 Not Found" (admin panel)
- Frontend build নেই
```bash
ls /www/wwwroot/qrdoc/client/dist/
# না থাকলে:
cd /www/wwwroot/qrdoc/client
npm install && npm run build
systemctl reload nginx
```

### "Permission denied" on static files
```bash
sudo chown -R www-data:www-data /www/wwwroot/qrdoc/
sudo chmod -R 755 /www/wwwroot/qrdoc/
sudo chmod 600 /www/wwwroot/qrdoc/.env
```

### Nginx config test
```bash
sudo nginx -t
sudo tail -f /var/log/nginx/error.log
```

---

## 🔐 ৫. SSL / HTTPS সমস্যা

### "Certbot failed"
```bash
# DNS A record আছে কিনা দেখুন
nslookup yourdomain.com
# DNS propagate হতে ২৪ ঘণ্টা লাগতে পারে

# Staging server দিয়ে try
sudo certbot --nginx --staging -d yourdomain.com
```

### SSL renew
```bash
sudo certbot renew --dry-run
sudo certbot renew
```

---

## 📤 ৬. ফাইল আপলোড সমস্যা

### "File too large"
- nginx এবং express দুটোতেই limit আছে
```bash
# /etc/nginx/conf.d/qrdoc.conf
client_max_body_size 100M;    # 50MB বাড়ান
sudo nginx -s reload
```

### "EACCES: permission denied" (uploads)
```bash
sudo chown -R www-data:www-data /www/wwwroot/qrdoc/uploads /www/wwwroot/qrdoc/qrcodes
sudo chmod -R 777 /www/wwwroot/qrdoc/uploads /www/wwwroot/qrdoc/qrcodes
```

---

## 🔑 ৭. Login সমস্যা

### "ভুল username বা password"
```bash
# ডিফল্ট admin/admin123 কাজ করছে না
cd /www/wwwroot/qrdoc
node -e "
import('bcryptjs').then(async b => {
  const hash = await b.default.hash('NEW_PASSWORD', 10);
  console.log(hash);
});
" 2>&1
# Hash পেয়ে:
sudo mysql -u root
> USE qrdoc;
> UPDATE users SET password_hash = 'HASH_FROM_ABOVE' WHERE username = 'admin';
```

### JWT token invalid
```bash
# .env এর JWT_SECRET পরিবর্তন হয়েছে — সব user আবার login করতে হবে
# সমাধান: secret পরিবর্তন করবেন না
```

---

## 💾 ৮. ব্যাকআপ ও রিস্টোর

### ব্যাকআপ
```bash
# Database
mysqldump -u qrdoc -p qrdoc > qrdoc_backup_$(date +%Y%m%d).sql

# Files
tar -czf qrdoc_files_$(date +%Y%m%d).tar.gz /www/wwwroot/qrdoc/uploads /www/wwwroot/qrdoc/qrcodes
```

### Cron Job (প্রতিদিন ব্যাকআপ)
```bash
crontab -e
0 2 * * * mysqldump -u qrdoc -p'PASSWORD' qrdoc > /backup/qrdoc_$(date +\%Y\%m\%d).sql
```

### রিস্টোর
```bash
mysql -u qrdoc -p qrdoc < qrdoc_backup_20260119.sql
tar -xzf qrdoc_files_20260119.tar.gz -C /
```

---

## 📊 ৯. ডিস্ক ফুল

```bash
df -h
du -sh /www/wwwroot/qrdoc/uploads/*
du -sh /var/log/*

# পুরনো লগ মুছুন
pm2 flush
sudo journalctl --vacuum-time=7d
```

---

## 🔄 ১০. আপডেট / কোড পরিবর্তন

```bash
# নতুন কোড আপলোডের পর:
cd /www/wwwroot/qrdoc
pm2 stop qrdoc
# ফাইল replace
pm2 start qrdoc
pm2 logs qrdoc --lines 50
```

---

## 🆘 জরুরী রিসেট (সব ডেটা মুছে পুনরায় শুরু)

```bash
cd /www/wwwroot/qrdoc
pm2 stop qrdoc
sudo rm -rf uploads/* qrcodes/*
sudo mysql -u root -e "DROP DATABASE qrdoc; CREATE DATABASE qrdoc CHARACTER SET utf8mb4;"
node server/migrate.js
pm2 start qrdoc
```

---

**সমস্যা থাকলে `pm2 logs qrdoc --lines 100` আউটপুট আমাকে দেখান।** 🛠️

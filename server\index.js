import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { query, queryOne, getPool } from './db.js';
import { runMigrations } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ─── Config (env-based) ───
const CONFIG = {
  PORT: parseInt(process.env.PORT || '3001'),
  JWT_SECRET: process.env.JWT_SECRET || 'change-me-in-production-' + Math.random().toString(36),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  RATE_LIMIT_WINDOW: 15 * 60 * 1000,
  RATE_LIMIT_MAX: 300,
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  MAX_PARAMS: 50
};

// Load .env file if exists
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [k, ...rest] = trimmed.split('=');
      if (k && rest.length) {
        const key = k.trim();
        const val = rest.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}
loadEnv();

const app = express();

// ─── Security Middleware ───
app.use(helmet({
  contentSecurityPolicy: false, // Admin panel uses inline styles
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: CONFIG.ALLOWED_ORIGINS.length > 0 ? CONFIG.ALLOWED_ORIGINS : true,
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW,
  max: CONFIG.RATE_LIMIT_MAX,
  message: { success: false, error: 'অনেক বেশি অনুরোধ। কিছুক্ষণ পর আবার চেষ্টা করুন।' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'অনেকবার চেষ্টা করেছেন। ১৫ মিনিট পর আবার চেষ্টা করুন।' }
});
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'অনেক বেশি অনুরোধ।'
});

// Static folders
app.use('/uploads', express.static(path.join(ROOT, 'uploads'), { maxAge: '7d' }));
app.use('/qrcodes', express.static(path.join(ROOT, 'qrcodes'), { maxAge: '30d' }));

// Ensure dirs exist
['uploads', 'qrcodes', 'client/dist'].forEach(d => {
  const p = path.join(ROOT, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ─── File Upload Config ───
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(ROOT, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4().slice(0, 8)}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.pdf', '.html', '.htm', '.png', '.jpg', '.jpeg'].includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('শুধুমাত্র PDF, HTML এবং ছবি (PNG/JPG) অনুমোদিত'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: CONFIG.MAX_FILE_SIZE }
});

// ─── Validation Helpers ───
function isValidSlug(s) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(s);
}

function validateParams(params) {
  if (!params || !Array.isArray(params)) return [];
  if (params.length > CONFIG.MAX_PARAMS) throw new Error(`সর্বোচ্চ ${CONFIG.MAX_PARAMS}টি প্যারামিটার অনুমোদিত`);
  for (const p of params) {
    if (!p.key || !p.value) continue;
    if (p.key.length > 100 || p.value.length > 500) {
      throw new Error('প্যারামিটার key সর্বোচ্চ ১০০ অক্ষর, value সর্বোচ্চ ৫০০ অক্ষর');
    }
  }
  return params.filter(p => p.key && p.value);
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Auth Middleware ───
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'অনুমতি নেই' });
  }
  const token = auth.slice(7);
  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'অবৈধ টোকেন' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'অপর্যাপ্ত অনুমতি' });
    }
    next();
  };
}

// ─── Audit Log Helper ───
async function auditLog(userId, action, details = {}) {
  try {
    await query(
      'INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)',
      [userId, action, JSON.stringify(details), details.ip || '']
    );
  } catch (e) {
    console.error('[AUDIT]', e.message);
  }
}

// ═══════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username ও password দিন' });
    }

    const user = await queryOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ success: false, error: 'ভুল username বা password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'ভুল username বা password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      CONFIG.JWT_SECRET,
      { expiresIn: '7d' }
    );

    await auditLog(user.id, 'login', { ip: req.ip });

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name }
    });
  } catch (err) {
    console.error('[AUTH] login error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne(
      'SELECT id, username, role, full_name, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  await auditLog(req.user.id, 'logout', { ip: req.ip });
  res.json({ success: true });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'নতুন password কমপক্ষে ৬ অক্ষরের হতে হবে' });
    }
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!await bcrypt.compare(oldPassword, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'পুরনো password ভুল' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    await auditLog(req.user.id, 'change_password', { ip: req.ip });
    res.json({ success: true, message: 'Password পরিবর্তন হয়েছে' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════
//  ADMIN API ROUTES
// ═══════════════════════════════════════════

// ─── GET /api/domains — List panel domains ───
app.get('/api/domains', authMiddleware, async (req, res) => {
  try {
    const panelData = path.join('/', 'www', 'server', 'panel', 'data');
    const sitesPath = path.join(panelData, 'sites.json');
    let domains = [];

    if (fs.existsSync(sitesPath)) {
      const raw = JSON.parse(fs.readFileSync(sitesPath, 'utf-8'));
      for (const [key, site] of Object.entries(raw)) {
        if (site && site.domain) domains.push({ domain: site.domain, path: site.path, id: key });
      }
    }

    const vhostDir = '/www/server/panel/vhost/nginx';
    if (fs.existsSync(vhostDir)) {
      const files = fs.readdirSync(vhostDir);
      for (const f of files) {
        if (f.endsWith('.conf')) {
          const dom = f.replace(/\.conf$/, '');
          if (!domains.find(d => d.domain === dom)) {
            domains.push({ domain: dom, path: '', id: 'vhost' });
          }
        }
      }
    }

    res.json({ success: true, domains });
  } catch (err) {
    res.json({ success: true, domains: [] });
  }
});

// ─── GET /api/links — List all links ───
app.get('/api/links', authMiddleware, async (req, res) => {
  try {
    const { search, tag, type, status, page = 1, limit = 50 } = req.query;
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(slug LIKE ? OR domain LIKE ? OR title LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (type) { conditions.push('file_type = ?'); params.push(type); }
    if (status === 'active') { conditions.push('is_active = 1'); }
    if (status === 'inactive') { conditions.push('is_active = 0'); }
    if (tag) {
      conditions.push('id IN (SELECT link_id FROM link_tags WHERE tag = ?)');
      params.push(tag);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const rows = await query(
      `SELECT id, slug, domain, title, params, file_type, file_path, original_filename,
              qr_path, scan_count, is_active, expires_at, max_scans, has_password,
              created_at, updated_at
       FROM qr_links ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const totalRow = await queryOne(`SELECT COUNT(*) as c FROM qr_links ${where}`, params);
    res.json({ success: true, links: rows, total: totalRow.c, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[API] list links error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/links/:id — Single link ───
app.get('/api/links/:id', authMiddleware, async (req, res) => {
  try {
    const link = await queryOne('SELECT * FROM qr_links WHERE id = ?', [req.params.id]);
    if (!link) return res.status(404).json({ success: false, error: 'লিংক পাওয়া যায়নি' });
    res.json({ success: true, link });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/links — Create new link ───
app.post('/api/links', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { slug, domain, title, params, expires_at, max_scans, password, qr_options } = req.body;

    if (!slug || !isValidSlug(slug)) {
      return res.status(400).json({ success: false, error: 'অবৈধ slug (a-z, 0-9, -, _ সর্বোচ্চ ৬৪ অক্ষর)' });
    }
    const existing = await queryOne('SELECT id FROM qr_links WHERE slug = ?', [slug]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'এই slug ইতিমধ্যে ব্যবহৃত' });
    }
    if (!domain) return res.status(400).json({ success: false, error: 'ডোমেইন আবশ্যক' });
    if (!req.file) return res.status(400).json({ success: false, error: 'PDF বা HTML ফাইল আপলোড করুন' });

    const fileExt = path.extname(req.file.originalname).toLowerCase();
    const fileType = fileExt === '.pdf' ? 'pdf' : (['.png','.jpg','.jpeg'].includes(fileExt) ? 'image' : 'html');

    let parsedParams = [];
    if (params) {
      try { parsedParams = typeof params === 'string' ? JSON.parse(params) : params; }
      catch { return res.status(400).json({ success: false, error: 'অবৈধ params format' }); }
    }
    parsedParams = validateParams(parsedParams);

    let passwordHash = null;
    if (password && password.length >= 4) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    // QR options (color, size, logo)
    let qrOpts = { width: 400, margin: 2, color: { dark: '#000000', light: '#ffffff' } };
    if (qr_options) {
      try {
        const o = typeof qr_options === 'string' ? JSON.parse(qr_options) : qr_options;
        if (o.colorDark) qrOpts.color.dark = o.colorDark;
        if (o.colorLight) qrOpts.color.light = o.colorLight;
        if (o.size) qrOpts.width = parseInt(o.size);
      } catch {}
    }

    const publicUrl = `https://${domain}/d/${slug}`;
    const qrFileName = `${slug}.png`;
    const qrPath = path.join(ROOT, 'qrcodes', qrFileName);
    await QRCode.toFile(qrPath, publicUrl, qrOpts);

    const result = await query(
      `INSERT INTO qr_links (slug, domain, title, params, file_type, file_path, original_filename,
                             qr_path, expires_at, max_scans, password_hash, has_password, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug, domain, title || '', JSON.stringify(parsedParams), fileType,
        req.file.filename, req.file.originalname, qrFileName,
        expires_at || null, max_scans ? parseInt(max_scans) : null,
        passwordHash, passwordHash ? 1 : 0, req.user.id
      ]
    );

    // Save tags if any
    if (req.body.tags) {
      const tags = (typeof req.body.tags === 'string' ? JSON.parse(req.body.tags) : req.body.tags) || [];
      for (const tag of tags) {
        if (typeof tag === 'string' && tag.trim()) {
          await query('INSERT INTO link_tags (link_id, tag) VALUES (?, ?)', [result.insertId, tag.trim()]);
        }
      }
    }

    const newLink = await queryOne('SELECT * FROM qr_links WHERE id = ?', [result.insertId]);
    await auditLog(req.user.id, 'create_link', { link_id: result.insertId, slug, ip: req.ip });

    res.status(201).json({ success: true, link: newLink, qrUrl: `/qrcodes/${qrFileName}`, publicUrl });
  } catch (err) {
    console.error('[API] create link error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /api/links/:id — Update link ───
app.put('/api/links/:id', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const link = await queryOne('SELECT * FROM qr_links WHERE id = ?', [req.params.id]);
    if (!link) return res.status(404).json({ success: false, error: 'লিংক পাওয়া যায়নি' });

    const { title, params, is_active, expires_at, max_scans, password, qr_options } = req.body;

    let parsedParams = link.params;
    if (params !== undefined) {
      try {
        parsedParams = typeof params === 'string' ? JSON.parse(params) : params;
        parsedParams = validateParams(parsedParams);
      } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
      }
    }

    let filePath = link.file_path;
    let fileType = link.file_type;
    let origName = link.original_filename;
    if (req.file) {
      const oldFilePath = path.join(ROOT, 'uploads', link.file_path);
      if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
      const ext = path.extname(req.file.originalname).toLowerCase();
      filePath = req.file.filename;
      fileType = ext === '.pdf' ? 'pdf' : (['.png','.jpg','.jpeg'].includes(ext) ? 'image' : 'html');
      origName = req.file.originalname;
    }

    let passwordHash = link.password_hash;
    let hasPassword = link.has_password;
    if (password === '') {
      passwordHash = null; hasPassword = 0;
    } else if (password && password.length >= 4) {
      passwordHash = await bcrypt.hash(password, 10);
      hasPassword = 1;
    }

    await query(
      `UPDATE qr_links SET title = ?, params = ?, file_path = ?, file_type = ?, original_filename = ?,
                          is_active = ?, expires_at = ?, max_scans = ?, password_hash = ?, has_password = ?,
                          updated_at = NOW()
       WHERE id = ?`,
      [
        title !== undefined ? title : link.title,
        JSON.stringify(parsedParams),
        filePath, fileType, origName,
        is_active !== undefined ? (is_active ? 1 : 0) : link.is_active,
        expires_at !== undefined ? (expires_at || null) : link.expires_at,
        max_scans !== undefined ? (max_scans ? parseInt(max_scans) : null) : link.max_scans,
        passwordHash, hasPassword,
        req.params.id
      ]
    );

    // Update tags
    if (req.body.tags !== undefined) {
      await query('DELETE FROM link_tags WHERE link_id = ?', [req.params.id]);
      const tags = (typeof req.body.tags === 'string' ? JSON.parse(req.body.tags) : req.body.tags) || [];
      for (const tag of tags) {
        if (typeof tag === 'string' && tag.trim()) {
          await query('INSERT INTO link_tags (link_id, tag) VALUES (?, ?)', [req.params.id, tag.trim()]);
        }
      }
    }

    // Regenerate QR if QR options changed
    if (qr_options) {
      try {
        const o = typeof qr_options === 'string' ? JSON.parse(qr_options) : qr_options;
        const qrOpts = { width: o.size || 400, margin: 2, color: { dark: o.colorDark || '#000000', light: o.colorLight || '#ffffff' } };
        const publicUrl = `https://${link.domain}/d/${link.slug}`;
        const qrFileName = `${link.slug}.png`;
        await QRCode.toFile(path.join(ROOT, 'qrcodes', qrFileName), publicUrl, qrOpts);
      } catch {}
    }

    const updated = await queryOne('SELECT * FROM qr_links WHERE id = ?', [req.params.id]);
    await auditLog(req.user.id, 'update_link', { link_id: req.params.id, ip: req.ip });
    res.json({ success: true, link: updated });
  } catch (err) {
    console.error('[API] update link error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/links/:id — Delete link ───
app.delete('/api/links/:id', authMiddleware, async (req, res) => {
  try {
    const link = await queryOne('SELECT * FROM qr_links WHERE id = ?', [req.params.id]);
    if (!link) return res.status(404).json({ success: false, error: 'লিংক পাওয়া যায়নি' });

    const filePath = path.join(ROOT, 'uploads', link.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const qrPath = path.join(ROOT, 'qrcodes', link.qr_path);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

    await query('DELETE FROM link_tags WHERE link_id = ?', [req.params.id]);
    await query('DELETE FROM qr_links WHERE id = ?', [req.params.id]);
    await auditLog(req.user.id, 'delete_link', { link_id: req.params.id, slug: link.slug, ip: req.ip });
    res.json({ success: true, message: 'লিংক মুছে ফেলা হয়েছে' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/links/bulk-delete — Bulk delete ───
app.post('/api/links/bulk-delete', authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'কোনো ID দেওয়া হয়নি' });
    }
    let deleted = 0;
    for (const id of ids) {
      const link = await queryOne('SELECT * FROM qr_links WHERE id = ?', [id]);
      if (link) {
        const fp = path.join(ROOT, 'uploads', link.file_path);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        const qp = path.join(ROOT, 'qrcodes', link.qr_path);
        if (fs.existsSync(qp)) fs.unlinkSync(qp);
        await query('DELETE FROM link_tags WHERE link_id = ?', [id]);
        await query('DELETE FROM qr_links WHERE id = ?', [id]);
        deleted++;
      }
    }
    await auditLog(req.user.id, 'bulk_delete', { count: deleted, ids, ip: req.ip });
    res.json({ success: true, deleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/links/bulk-export — CSV Export ───
app.post('/api/links/bulk-export', authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    let rows;
    if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      rows = await query(
        `SELECT id, slug, domain, title, file_type, scan_count, is_active, created_at
         FROM qr_links WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
        ids
      );
    } else {
      rows = await query(
        `SELECT id, slug, domain, title, file_type, scan_count, is_active, created_at
         FROM qr_links ORDER BY created_at DESC`
      );
    }
    const csv = [
      ['ID', 'Slug', 'Domain', 'Title', 'Type', 'Scans', 'Active', 'Created'].join(','),
      ...rows.map(r => [
        r.id, r.slug, r.domain, `"${(r.title || '').replace(/"/g, '""')}"`,
        r.file_type, r.scan_count, r.is_active, new Date(r.created_at).toISOString()
      ].join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="qrdoc-links-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/links/:id/regenerate-qr — Regenerate QR ───
app.post('/api/links/:id/regenerate-qr', authMiddleware, async (req, res) => {
  try {
    const link = await queryOne('SELECT * FROM qr_links WHERE id = ?', [req.params.id]);
    if (!link) return res.status(404).json({ success: false, error: 'লিংক পাওয়া যায়নি' });
    const publicUrl = `https://${link.domain}/d/${link.slug}`;
    const qrFileName = `${link.slug}.png`;
    await QRCode.toFile(path.join(ROOT, 'qrcodes', qrFileName), publicUrl, {
      width: 400, margin: 2, color: { dark: '#000000', light: '#ffffff' }
    });
    res.json({ success: true, qrUrl: `/qrcodes/${qrFileName}`, publicUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/links/:id/scans — Get scan logs ───
app.get('/api/links/:id/scans', authMiddleware, async (req, res) => {
  try {
    const rows = await query(
      'SELECT id, ip, user_agent, referer, scanned_at FROM scan_logs WHERE link_id = ? ORDER BY scanned_at DESC LIMIT 500',
      [req.params.id]
    );
    res.json({ success: true, scans: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/links/check-slug/:slug — Check slug availability ───
app.get('/api/links/check-slug/:slug', authMiddleware, async (req, res) => {
  try {
    const link = await queryOne('SELECT id FROM qr_links WHERE slug = ?', [req.params.slug]);
    res.json({ success: true, available: !link });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/tags — All tags ───
app.get('/api/tags', authMiddleware, async (req, res) => {
  try {
    const rows = await query(
      `SELECT tag, COUNT(*) as count FROM link_tags GROUP BY tag ORDER BY count DESC`
    );
    res.json({ success: true, tags: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════
//  ANALYTICS
// ═══════════════════════════════════════════
app.get('/api/analytics/overview', authMiddleware, async (req, res) => {
  try {
    const totalLinks = await queryOne('SELECT COUNT(*) as c FROM qr_links');
    const activeLinks = await queryOne('SELECT COUNT(*) as c FROM qr_links WHERE is_active = 1');
    const totalScans = await queryOne('SELECT COALESCE(SUM(scan_count), 0) as c FROM qr_links');
    const todayScans = await queryOne(
      `SELECT COUNT(*) as c FROM scan_logs WHERE DATE(scanned_at) = CURDATE()`
    );
    const last7Days = await query(
      `SELECT DATE(scanned_at) as date, COUNT(*) as count
       FROM scan_logs
       WHERE scanned_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY DATE(scanned_at)
       ORDER BY date ASC`
    );
    const topLinks = await query(
      `SELECT id, slug, domain, title, scan_count FROM qr_links
       ORDER BY scan_count DESC LIMIT 10`
    );
    const topDomains = await query(
      `SELECT domain, COUNT(*) as links, COALESCE(SUM(scan_count), 0) as scans
       FROM qr_links GROUP BY domain ORDER BY scans DESC LIMIT 10`
    );
    const recentScans = await query(
      `SELECT s.id, s.ip, s.scanned_at, l.slug, l.title
       FROM scan_logs s LEFT JOIN qr_links l ON s.link_id = l.id
       ORDER BY s.scanned_at DESC LIMIT 20`
    );
    res.json({
      success: true,
      stats: {
        totalLinks: totalLinks.c,
        activeLinks: activeLinks.c,
        totalScans: totalScans.c,
        todayScans: todayScans.c
      },
      last7Days,
      topLinks,
      topDomains,
      recentScans
    });
  } catch (err) {
    console.error('[ANALYTICS] error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════
//  USER MANAGEMENT (admin only)
// ═══════════════════════════════════════════
app.get('/api/users', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const rows = await query(
      'SELECT id, username, role, full_name, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ success: true, users: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { username, password, role, full_name } = req.body;
    if (!username || !password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Username ও ৬+ অক্ষরের password আবশ্যক' });
    }
    const existing = await queryOne('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(400).json({ success: false, error: 'Username ইতিমধ্যে আছে' });
    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)',
      [username, hash, role || 'editor', full_name || '']
    );
    await auditLog(req.user.id, 'create_user', { new_user_id: result.insertId, username, ip: req.ip });
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/users/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { role, full_name, is_active, password } = req.body;
    const updates = [];
    const params = [];
    if (role) { updates.push('role = ?'); params.push(role); }
    if (full_name !== undefined) { updates.push('full_name = ?'); params.push(full_name); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (password && password.length >= 6) {
      updates.push('password_hash = ?');
      params.push(await bcrypt.hash(password, 10));
    }
    if (updates.length === 0) return res.json({ success: true, message: 'No changes' });
    params.push(req.params.id);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    await auditLog(req.user.id, 'update_user', { user_id: req.params.id, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/users/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ success: false, error: 'নিজের account মুছতে পারবেন না' });
    }
    await query('DELETE FROM users WHERE id = ?', [req.params.id]);
    await auditLog(req.user.id, 'delete_user', { user_id: req.params.id, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════
//  AUDIT LOG
// ═══════════════════════════════════════════
app.get('/api/audit', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const rows = await query(
      `SELECT a.id, a.action, a.details, a.ip, a.created_at, u.username
       FROM audit_log a LEFT JOIN users u ON a.user_id = u.id
       ORDER BY a.created_at DESC LIMIT 200`
    );
    res.json({ success: true, logs: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════
//  WEBHOOKS
// ═══════════════════════════════════════════
app.post('/api/webhooks', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { name, url, events } = req.body;
    if (!name || !url) return res.status(400).json({ success: false, error: 'name ও url আবশ্যক' });
    const result = await query(
      'INSERT INTO webhooks (name, url, events, created_by) VALUES (?, ?, ?, ?)',
      [name, url, JSON.stringify(events || ['scan']), req.user.id]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/webhooks', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const rows = await query('SELECT id, name, url, events, is_active, created_at FROM webhooks ORDER BY created_at DESC');
    res.json({ success: true, webhooks: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/webhooks/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM webhooks WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: Trigger webhooks
async function triggerWebhooks(event, data) {
  try {
    const hooks = await query('SELECT url, events FROM webhooks WHERE is_active = 1');
    for (const hook of hooks) {
      try {
        const events = typeof hook.events === 'string' ? JSON.parse(hook.events) : hook.events;
        if (events.includes(event) || events.includes('*')) {
          fetch(hook.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, data, timestamp: new Date().toISOString() })
          }).catch(() => {});
        }
      } catch {}
    }
  } catch {}
}

// ═══════════════════════════════════════════
//  PUBLIC VIEW — /d/:slug (TRANSPARENT, NO CUSTOM PAGE)
// ═══════════════════════════════════════════
app.get('/d/:slug', publicLimiter, async (req, res) => {
  try {
    const { slug } = req.params;
    const link = await queryOne(
      'SELECT * FROM qr_links WHERE slug = ? AND is_active = 1',
      [slug]
    );

    if (!link) {
      return res.status(404).type('html').send(minimalError('লিংক পাওয়া যায়নি', 'এই লিংকটি নিষ্ক্রিয় বা মুছে ফেলা হয়েছে।'));
    }

    // Check expiration
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).type('html').send(minimalError('লিংকের মেয়াদ শেষ', 'এই লিংকের মেয়াদ উত্তীর্ণ হয়ে গেছে।'));
    }

    // Check max scans
    if (link.max_scans && link.scan_count >= link.max_scans) {
      return res.status(410).type('html').send(minimalError('স্ক্যান সীমা শেষ', 'এই লিংকের সর্বোচ্চ স্ক্যান সীমা অতিক্রম করা হয়েছে।'));
    }

    // Check password
    if (link.has_password) {
      const provided = req.query.pwd || req.headers['x-link-password'] || '';
      if (!provided) {
        return res.status(401).type('html').send(passwordForm(slug));
      }
      const valid = await bcrypt.compare(provided, link.password_hash);
      if (!valid) {
        return res.status(401).type('html').send(passwordForm(slug, true));
      }
    }

    // Log the scan
    try {
      await query(
        'INSERT INTO scan_logs (link_id, ip, user_agent, referer) VALUES (?, ?, ?, ?)',
        [link.id, req.ip || req.connection?.remoteAddress || '', req.headers['user-agent'] || '', req.headers['referer'] || '']
      );
      await query('UPDATE qr_links SET scan_count = scan_count + 1 WHERE id = ?', [link.id]);
      triggerWebhooks('scan', { link_id: link.id, slug: link.slug, ip: req.ip });
    } catch (logErr) {
      console.error('[SCAN LOG]', logErr.message);
    }

    // Build query string from params
    let params = [];
    try { params = typeof link.params === 'string' ? JSON.parse(link.params) : (link.params || []); }
    catch { params = []; }

    const paramParts = params
      .filter(p => p.key && p.value)
      .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`);
    // Also keep any query params from the original request (e.g., ?pwd=xxx handled above, others pass through)
    const reqParams = Object.entries(req.query)
      .filter(([k]) => k !== 'pwd')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    const allParams = [...paramParts, ...reqParams];
    const qs = allParams.length > 0 ? '?' + allParams.join('&') : '';

    // Direct redirect to file — NO custom page
    res.redirect(302, `/uploads/${link.file_path}${qs}`);
  } catch (err) {
    console.error('[PUBLIC VIEW] error:', err);
    res.status(500).type('html').send(minimalError('সার্ভার ত্রুটি', 'আবার চেষ্টা করুন।'));
  }
});

// ─── Minimal error / password pages (no branding) ───
function minimalError(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;padding:20px}
.box{background:white;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.06);text-align:center;max-width:400px;width:100%}
h1{font-size:18px;color:#dc2626;margin-bottom:8px}
p{font-size:14px;color:#64748b}
</style></head><body><div class="box"><h1>${escHtml(title)}</h1><p>${escHtml(message)}</p></div></body></html>`;
}

function passwordForm(slug, error = false) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Password প্রয়োজন</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;padding:20px}
.box{background:white;padding:32px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.06);max-width:360px;width:100%}
h1{font-size:18px;color:#1e293b;margin-bottom:16px;text-align:center}
input{width:100%;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;margin-bottom:12px;outline:none}
input:focus{border-color:#059669}
button{width:100%;padding:10px;background:#059669;color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.err{color:#dc2626;font-size:13px;margin-bottom:12px;text-align:center}
</style></head><body><form class="box" method="GET" action="/d/${escHtml(slug)}">
<h1>🔒 Password দিন</h1>
${error ? '<div class="err">ভুল password</div>' : ''}
<input type="password" name="pwd" placeholder="Password" required autofocus>
<button type="submit">যাচাই করুন</button>
</form></body></html>`;
}

// ═══════════════════════════════════════════
//  ADMIN PANEL (React SPA)
// ═══════════════════════════════════════════
const distPath = path.join(ROOT, 'client', 'dist');
const indexHtml = path.join(distPath, 'index.html');

app.use('/admin/assets', express.static(path.join(distPath, 'assets')));
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
  else res.status(200).send(renderSetupNotice());
});

app.get('/', (req, res) => {
  if (fs.existsSync(indexHtml)) res.redirect('/admin');
  else res.send(renderSetupNotice());
});

function renderSetupNotice() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QR-Doc Publisher</title>
<style>*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc}
.card{background:white;padding:40px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:500px;margin:20px}
h1{color:#065f46;margin-bottom:8px;font-size:24px}
p{color:#64748b;line-height:1.6;margin-bottom:16px}
.status{display:inline-block;background:#dcfce7;color:#065f46;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:500}
</style></head><body><div class="card">
<h1>⚙️ QR-Doc Publisher</h1>
<p>অ্যাডমিন প্যানেল বিল্ড হচ্ছে...<br><code>cd client && npm run build</code> রান করুন।</p>
<div class="status">✅ Backend চালু (port ${CONFIG.PORT})</div>
</div></body></html>`;
}

// ─── Error handler ───
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: `ফাইল ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB এর বেশি হতে পারবে না` });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  console.error('[SERVER]', err);
  res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

// ─── Start ───
async function start() {
  try {
    await getPool();
    await runMigrations();
    app.listen(CONFIG.PORT, '0.0.0.0', () => {
      console.log(`\n╔══════════════════════════════════════════╗`);
      console.log(`║   🚀 QR-Doc Publisher v2.0               ║`);
      console.log(`║   Port: ${CONFIG.PORT}                          ║`);
      console.log(`║   Admin: http://localhost:${CONFIG.PORT}/admin  ║`);
      console.log(`╚══════════════════════════════════════════╝\n`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();

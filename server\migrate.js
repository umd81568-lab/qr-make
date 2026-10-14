import { query, queryOne, getPool } from './db.js';

// SQL migrations — run in order
const MIGRATIONS = [
  // Migration 1: Add new columns to qr_links
  {
    name: 'add_link_extras',
    sql: [
      `ALTER TABLE qr_links ADD COLUMN IF NOT EXISTS expires_at DATETIME NULL`,
      `ALTER TABLE qr_links ADD COLUMN IF NOT EXISTS max_scans INT NULL`,
      `ALTER TABLE qr_links ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NULL`,
      `ALTER TABLE qr_links ADD COLUMN IF NOT EXISTS has_password TINYINT(1) DEFAULT 0`,
      `ALTER TABLE qr_links ADD COLUMN IF NOT EXISTS created_by INT NULL`,
      `ALTER TABLE qr_links ADD INDEX IF NOT EXISTS idx_slug (slug)`,
      `ALTER TABLE qr_links ADD INDEX IF NOT EXISTS idx_domain (domain)`,
      `ALTER TABLE qr_links ADD INDEX IF NOT EXISTS idx_active (is_active)`
    ]
  },
  // Migration 2: Users table
  {
    name: 'create_users',
    sql: [
      `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin', 'editor', 'viewer') DEFAULT 'editor',
        full_name VARCHAR(128) DEFAULT '',
        is_active TINYINT(1) DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ]
  },
  // Migration 3: Link tags
  {
    name: 'create_link_tags',
    sql: [
      `CREATE TABLE IF NOT EXISTS link_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        link_id INT NOT NULL,
        tag VARCHAR(64) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_link_tag (link_id, tag),
        INDEX idx_tag (tag),
        INDEX idx_link (link_id),
        FOREIGN KEY (link_id) REFERENCES qr_links(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ]
  },
  // Migration 4: Audit log
  {
    name: 'create_audit_log',
    sql: [
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        action VARCHAR(64) NOT NULL,
        details TEXT,
        ip VARCHAR(64) DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id),
        INDEX idx_action (action),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ]
  },
  // Migration 5: Webhooks
  {
    name: 'create_webhooks',
    sql: [
      `CREATE TABLE IF NOT EXISTS webhooks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        url VARCHAR(512) NOT NULL,
        events TEXT,
        is_active TINYINT(1) DEFAULT 1,
        created_by INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ]
  },
  // Migration 6: Settings (for app config)
  {
    name: 'create_settings',
    sql: [
      `CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(64) PRIMARY KEY,
        setting_value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ]
  }
];

// Track which migrations have been applied
const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(128) UNIQUE NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

export async function runMigrations() {
  try {
    const pool = await getPool();

    // Create migrations tracking table
    await pool.query(MIGRATIONS_TABLE);

    // Get applied migrations
    const [applied] = await pool.query('SELECT name FROM _migrations');
    const appliedNames = new Set(applied.map(r => r.name));

    // Run pending migrations
    for (const migration of MIGRATIONS) {
      if (appliedNames.has(migration.name)) continue;

      console.log(`[MIGRATION] Running: ${migration.name}`);
      for (const sql of migration.sql) {
        try {
          await pool.query(sql);
        } catch (err) {
          // MySQL 8+ supports IF NOT EXISTS, but older versions don't
          // Skip "already exists" errors
          if (err.code === 'ER_DUP_FIELDNAME' ||
              err.code === 'ER_DUP_KEYNAME' ||
              err.code === 'ER_TABLE_EXISTS_ERROR' ||
              err.message.includes('already exists') ||
              err.message.includes('Duplicate column')) {
            console.log(`[MIGRATION]   ↪ skip: ${err.message.split('\n')[0]}`);
            continue;
          }
          throw err;
        }
      }

      await pool.query('INSERT INTO _migrations (name) VALUES (?)', [migration.name]);
      console.log(`[MIGRATION] ✓ ${migration.name} applied`);
    }

    // Seed default admin user if no users exist
    const userCount = await queryOne('SELECT COUNT(*) as c FROM users');
    if (userCount.c === 0) {
      const bcrypt = (await import('bcryptjs')).default;
      const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
      const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';
      const hash = await bcrypt.hash(ADMIN_PASS, 10);
      await query(
        'INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)',
        [ADMIN_USER, hash, 'admin', 'Default Admin']
      );
      console.log(`[MIGRATION] ✓ Default admin user created: ${ADMIN_USER}`);
      console.log(`[MIGRATION] ⚠️  Default password: ${ADMIN_PASS} — CHANGE IMMEDIATELY!`);
    }

    console.log('[MIGRATION] All migrations complete');
  } catch (err) {
    console.error('[MIGRATION] Error:', err);
    throw err;
  }
}

// Run directly if invoked as script
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

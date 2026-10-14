import mysql from 'mysql2/promise';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Load .env file if exists (same loader as index.js)
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs_existsSync(envPath)) {
    const lines = readEnvFile(envPath);
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

function fs_existsSync(p) {
  try { return existsSync(p); } catch { return false; }
}

function readEnvFile(p) {
  try { return readFileSync(p, 'utf-8').split('\n'); } catch { return []; }
}

loadEnv();

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'qrdoc',
  password: process.env.DB_PASSWORD || 'QrDoc@2024#Secure',
  database: process.env.DB_NAME || 'qrdoc',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
};

let pool;

export async function getPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
    // Test connection
    const conn = await pool.getConnection();
    conn.release();
    console.log('[DB] MySQL pool connected');
  }
  return pool;
}

export async function query(sql, params = []) {
  const p = await getPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

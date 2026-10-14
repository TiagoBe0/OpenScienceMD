// Optional admin login. When ADMIN_PASSWORD is set, anyone can read the app, but changing
// data (topics, refresh, sending email) needs a session cookie obtained with the password.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PASSWORD = process.env.ADMIN_PASSWORD || '';
// Without a fixed secret, sessions simply end when the server restarts.
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const COOKIE = 'osd_admin';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const attempts = new Map(); // ip -> { count, resetAt }

export const required = () => Boolean(PASSWORD);

const sha256 = (s) => createHash('sha256').update(String(s)).digest();
const sign = (expires) => createHmac('sha256', SECRET).update(`admin.${expires}`).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v)
  );
}

export function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /https/.test(req.headers['cf-visitor'] ?? '');

export function isAdmin(req) {
  if (!required()) return true;
  const [expires, signature] = (cookies(req)[COOKIE] ?? '').split('.');
  if (!expires || !signature || Number(expires) < Date.now() / 1000) return false;
  return safeEqual(signature, sign(expires));
}

/** Counts a login attempt; false once an IP has tried too many times recently. */
export function allowAttempt(ip) {
  const now = Date.now();
  if (attempts.size > 1000) for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

export function checkPassword(password) {
  // Hash both sides so the comparison is constant-time regardless of length.
  return required() && timingSafeEqual(sha256(password), sha256(PASSWORD));
}

export function sessionCookie(req, cookiePath) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${COOKIE}=${expires}.${sign(expires)}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${isHttps(req) ? '; Secure' : ''}`;
}

export function clearedCookie(req, cookiePath) {
  return `${COOKIE}=; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
}

// session-db.js
const axios = require('axios');

// ==================== CONFIG (NDANI YA CODE) ====================
const DB_URL = process.env.SESSION_DB_URL || 'https://siladb.onrender.com';
const DB_API_KEY = process.env.SESSION_DB_API_KEY || 'sila_secret_key_change_me_1234567890';

const headers = { 'x-api-key': DB_API_KEY };

function isConfigured() {
  return !!(DB_URL && DB_API_KEY);
}

async function saveSession(number, creds, keys) {
  if (!isConfigured()) return { success: false, error: 'DB not configured' };
  try {
    const sanitized = String(number).replace(/\D/g, '');
    console.log(`[DB] 💾 Saving session ${sanitized}...`);
    const res = await axios.post(
      `${DB_URL}/api/session`,
      { number: sanitized, creds, keys },
      { headers, timeout: 30000 }
    );
    console.log(`[DB] ✅ Saved: ${res.data?.message || 'ok'}`);
    return { success: true, data: res.data };
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.error(`[DB] ❌ saveSession failed (${status}): ${msg}`);
    return { success: false, error: `(${status}) ${msg}` };
  }
}

async function getSession(number) {
  if (!isConfigured()) return { success: false, error: 'DB not configured' };
  try {
    const sanitized = String(number).replace(/\D/g, '');
    const res = await axios.get(`${DB_URL}/api/session/${sanitized}`, { headers, timeout: 30000 });
    return { success: true, session: res.data.session };
  } catch (err) {
    if (err.response?.status === 404) return { success: false, error: 'not_found' };
    return { success: false, error: err.message };
  }
}

async function getAllSessions() {
  if (!isConfigured()) return { success: false, error: 'DB not configured' };
  try {
    const res = await axios.get(`${DB_URL}/api/sessions`, { headers, timeout: 30000 });
    return { success: true, sessions: res.data.sessions || [] };
  } catch (err) {
    console.error(`[DB] ❌ getAllSessions: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function deleteSession(number) {
  if (!isConfigured()) return { success: false, error: 'DB not configured' };
  try {
    const sanitized = String(number).replace(/\D/g, '');
    await axios.delete(`${DB_URL}/api/session/${sanitized}`, { headers, timeout: 30000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { isConfigured, saveSession, getSession, getAllSessions, deleteSession };
// session-db.js
// Client ya kuzungumza na SILA Session DB API

const axios = require('axios');

const DB_URL = process.env.SESSION_DB_URL || '';
const DB_API_KEY = process.env.SESSION_DB_API_KEY || '';

function isConfigured() {
  return !!(DB_URL && DB_API_KEY);
}

const headers = { 'x-api-key': DB_API_KEY };

/**
 * Save session kwenye DB API
 */
async function saveSession(number, creds, keys) {
  if (!isConfigured()) return { success: false, error: 'DB not configured' };
  try {
    const sanitized = String(number).replace(/\D/g, '');
    const res = await axios.post(
      `${DB_URL}/api/session`,
      { number: sanitized, creds, keys },
      { headers, timeout: 30000 }
    );
    return { success: true, data: res.data };
  } catch (err) {
    console.error('saveSession error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Pata session moja
 */
async function getSession(number) {
  if (!isConfigured()) return { success: false, error: 'DB not configured' };
  try {
    const sanitized = String(number).replace(/\D/g, '');
    const res = await axios.get(`${DB_URL}/api/session/${sanitized}`, { headers, timeout: 30000 });
    return { success: true, session: res.data.session };
  } catch (err) {
    if (err.response?.status === 404) {
      return { success: false, error: 'not_found' };
    }
    console.error('getSession error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Pata sessions zote
 */
async function getAllSessions() {
  if (!isConfigured()) return { success: false, error: 'DB not configured' };
  try {
    const res = await axios.get(`${DB_URL}/api/sessions`, { headers, timeout: 30000 });
    return { success: true, sessions: res.data.sessions || [] };
  } catch (err) {
    console.error('getAllSessions error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Futa session
 */
async function deleteSession(number) {
  if (!isConfigured()) return { success: false, error: 'DB not configured' };
  try {
    const sanitized = String(number).replace(/\D/g, '');
    await axios.delete(`${DB_URL}/api/session/${sanitized}`, { headers, timeout: 30000 });
    return { success: true };
  } catch (err) {
    console.error('deleteSession error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { isConfigured, saveSession, getSession, getAllSessions, deleteSession };

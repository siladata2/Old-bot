// session-db.js
const axios = require('axios');

// ==================== CONFIG (NDANI YA CODE) ====================
const DB_URL = 'https://siladb.onrender.com';
const DB_API_KEY = 'silatech22';

const headers = { 'x-api-key': DB_API_KEY };

function isConfigured() {
  return true; // Daima configured
}

async function saveSession(number, creds, keys) {
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

async function getSession(number) {
  try {
    const sanitized = String(number).replace(/\D/g, '');
    const res = await axios.get(`${DB_URL}/api/session/${sanitized}`, { headers, timeout: 30000 });
    return { success: true, session: res.data.session };
  } catch (err) {
    if (err.response?.status === 404) return { success: false, error: 'not_found' };
    console.error('getSession error:', err.message);
    return { success: false, error: err.message };
  }
}

async function getAllSessions() {
  try {
    const res = await axios.get(`${DB_URL}/api/sessions`, { headers, timeout: 30000 });
    return { success: true, sessions: res.data.sessions || [] };
  } catch (err) {
    console.error('getAllSessions error:', err.message);
    return { success: false, error: err.message };
  }
}

async function deleteSession(number) {
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
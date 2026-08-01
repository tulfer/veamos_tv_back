const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const REFRESH_ALL_URL = 'https://veamostv.site/live/channels/refresh-all';
const AUTO_REFRESH_DOC = 'autoRefresh/config';

exports.refreshAllChannels = onSchedule(
  {
    schedule: '*/5 * * * *',
    timeZone: 'America/Bogota',
    region: 'us-central1',
    maxInstances: 1,
    timeoutSeconds: 60,
  },
  async () => {
    try {
      initializeApp();
    } catch (err) {
      // ya inicializada
    }

    try {
      const db = getFirestore();
      const snap = await db.doc(AUTO_REFRESH_DOC).get();
      const enabled = !snap.exists || snap.data().enabled !== false;
      if (!enabled) {
        console.log('refresh-all skipped (autoRefresh disabled)');
        return null;
      }
    } catch (err) {
      console.error('refresh-all failed to read autoRefresh config:', err);
      return null;
    }

    try {
      const res = await fetch(REFRESH_ALL_URL, {
        method: 'POST',
        headers: { 'User-Agent': 'veamos-tv-scheduler/1.0' },
      });
      const text = await res.text();
      console.log(`refresh-all HTTP ${res.status}: ${text}`);
    } catch (err) {
      console.error('refresh-all request failed:', err);
    }

    return null;
  }
);

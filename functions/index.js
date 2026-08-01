const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const REFRESH_ALL_URL = 'https://veamostv.site/live/channels/refresh-all';
const AUTO_REFRESH_DOC = 'autoRefresh/config';
const DEFAULT_INTERVAL_MINUTES = 5;

exports.refreshAllChannels = onSchedule(
  {
    schedule: '* * * * *',
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

    let db;
    try {
      db = getFirestore();
      const snap = await db.doc(AUTO_REFRESH_DOC).get();
      const data = snap.exists ? snap.data() : {};
      const enabled = data.enabled !== false;
      if (!enabled) {
        console.log('refresh-all skipped (autoRefresh disabled)');
        return null;
      }

      const intervalMinutes = Number(data.intervalMinutes) || DEFAULT_INTERVAL_MINUTES;
      const lastRunAt = Number(data.lastRunAt) || 0;
      const dueInMs = intervalMinutes * 60 * 1000;
      if (Date.now() - lastRunAt < dueInMs) {
        console.log(`refresh-all not due yet (every ${intervalMinutes} min)`);
        return null;
      }

      await db.doc(AUTO_REFRESH_DOC).set({ lastRunAt: Date.now() }, { merge: true });
    } catch (err) {
      console.error('refresh-all failed to read/update autoRefresh config:', err);
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

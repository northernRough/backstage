// Scheduled function: runs daily at midday UTC
// Gathers all shared subscriptions across users, deduplicates by email address,
// picks the first user with credentials for each, and scans once per unique subscription.

export default async () => {
  const firebaseUrl = Netlify.env.get('FIREBASE_DB_URL');
  const siteUrl = Netlify.env.get('URL') || 'https://mallorn-backstage.netlify.app';

  // Get all users and credentials
  const [usersRes, credsRes] = await Promise.all([
    fetch(`${firebaseUrl}/users.json`),
    fetch(`${firebaseUrl}/credentials.json`)
  ]);
  const users = await usersRes.json() || {};
  const allCreds = await credsRes.json() || {};

  // Build a map of unique subscription emails → { userId, isTicketSender }
  // First user with valid credentials wins for each subscription
  const subscriptionOwners = new Map(); // email → { userId, isTicketSender }

  for (const [userId, userData] of Object.entries(users)) {
    // Check if user has IMAP credentials
    let hasPassword = Netlify.env.get('IMAP_PASS_' + userId.toUpperCase()) || userData?.imapPassword;
    if (!hasPassword) {
      hasPassword = allCreds[userId]?.imapPassword;
    }
    if (!userData?.imapEmail || !hasPassword) continue;

    // Collect this user's shared subscriptions
    const addSubs = (senders, isTicketSender) => {
      for (const val of Object.values(senders || {})) {
        const entry = typeof val === 'string' ? { email: val, enabled: true, shared: true } : val;
        if (entry.enabled === false || entry.shared === false) continue;
        const email = (entry.email || val).toLowerCase();
        if (!subscriptionOwners.has(email)) {
          subscriptionOwners.set(email, { userId, isTicketSender });
        }
      }
    };
    addSubs(userData.watchSenders, false);
    addSubs(userData.ticketSenders, true);
  }

  // Group subscriptions by owner userId so we scan each inbox at most once
  const scansByUser = new Map(); // userId → [{ email, isTicketSender }]
  for (const [email, { userId, isTicketSender }] of subscriptionOwners) {
    if (!scansByUser.has(userId)) scansByUser.set(userId, []);
    scansByUser.get(userId).push({ email, isTicketSender });
  }

  // Trigger one background scan per user who owns at least one subscription
  const results = [];
  for (const [userId, subs] of scansByUser) {
    try {
      const res = await fetch(`${siteUrl}/.netlify/functions/scan-emails-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, scheduledSubs: subs })
      });
      results.push({ userId, subscriptions: subs.length, status: res.status });
    } catch (err) {
      results.push({ userId, error: err.message });
    }
  }

  console.log('Scheduled scan complete:', JSON.stringify(results));
};

export const config = {
  schedule: "0 12 * * *"
};

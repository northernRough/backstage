// Scheduled function: runs daily at midday UTC
// Triggers scan-emails for all users who have IMAP credentials configured

export default async () => {
  const firebaseUrl = Netlify.env.get('FIREBASE_DB_URL');
  const siteUrl = Netlify.env.get('URL') || 'https://mallorn-backstage.netlify.app';

  // Get all users
  const usersRes = await fetch(`${firebaseUrl}/users.json`);
  const users = await usersRes.json() || {};

  const results = [];
  for (const [userId, userData] of Object.entries(users)) {
    let hasPassword = Netlify.env.get('IMAP_PASS_' + userId.toUpperCase()) || userData?.imapPassword;
    if (!hasPassword) {
      const credRes = await fetch(`${firebaseUrl}/credentials/${userId}.json`);
      const credData = await credRes.json();
      hasPassword = credData?.imapPassword;
    }
    if (!userData?.imapEmail || !hasPassword || (!userData?.watchSenders && !userData?.ticketSenders)) continue;

    try {
      const res = await fetch(`${siteUrl}/.netlify/functions/scan-emails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      const data = await res.json();
      results.push({ userId, ...data });
    } catch (err) {
      results.push({ userId, error: err.message });
    }
  }

  console.log('Scheduled scan complete:', JSON.stringify(results));
};

export const config = {
  schedule: "0 12 * * *"
};

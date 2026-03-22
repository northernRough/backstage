export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { userId, password } = await req.json();
    if (!userId || !password) {
      return new Response(JSON.stringify({ error: 'Missing userId or password' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const firebaseUrl = Netlify.env.get('FIREBASE_DB_URL');

    // Store password in Firebase at a path that client rules will block reading
    await fetch(`${firebaseUrl}/credentials/${userId}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imapPassword: password, updatedAt: Date.now() })
    });

    // Set flag on user record so UI knows password exists (without exposing it)
    await fetch(`${firebaseUrl}/users/${userId}/hasImapPassword.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'true'
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { artist, venue, date, bookingUrl, eventId } = await req.json();
    if (!artist) {
      return new Response(JSON.stringify({ error: 'Missing artist' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const anthropicKey = Netlify.env.get('ANTHROPIC_API_KEY');
    const firebaseUrl = Netlify.env.get('FIREBASE_DB_URL');
    const today = new Date().toISOString().split('T')[0];

    // If date has passed, mark as not bookable and cache
    if (date && date < today) {
      const key = artist.replace(/[.#$/[\]]/g, '_');
      await fetch(`${firebaseUrl}/artists/${key}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookable: false, bookableChecked: Date.now() })
      });
      return new Response(JSON.stringify({ bookable: false, reason: 'Event date has passed' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Try to fetch the booking page
    let pageContent = '';
    if (bookingUrl) {
      try {
        const pageRes = await fetch(bookingUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Backstage/1.0)' },
          redirect: 'follow',
          signal: AbortSignal.timeout(8000)
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          // Strip HTML tags, keep text, truncate
          pageContent = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 3000);
        }
      } catch (e) {
        // Couldn't fetch page — proceed without it
      }
    }

    const prompt = `Determine if this event/show is still available to book tickets for.

Artist/Show: ${artist}
Venue: ${venue || 'Unknown'}
Date: ${date || 'Unknown'}
Today's date: ${today}
Booking URL: ${bookingUrl || 'None'}

${pageContent ? `Content from the booking page:\n${pageContent}` : 'No booking page content available.'}

Based on the information above, is this event likely still bookable? Consider:
- Has the date passed?
- Does the page content mention "sold out", "unavailable", "no longer available"?
- Does it show ticket purchase options?

Return ONLY a JSON object: {"bookable": true/false, "reason": "brief explanation"}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      return new Response(JSON.stringify({ error: 'AI check failed' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '{}';
    let result = { bookable: null, reason: '' };
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
    } catch (e) {
      result = { bookable: null, reason: 'Could not parse response' };
    }

    // Cache result on artist record
    const key = artist.replace(/[.#$/[\]]/g, '_');
    await fetch(`${firebaseUrl}/artists/${key}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookable: result.bookable,
        bookableReason: result.reason,
        bookableChecked: Date.now()
      })
    });

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: `Check failed: ${err.message}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { notes, type, name } = await req.json();

  let prompt;
  if (!notes || !notes.length) {
    if (!name) {
      return new Response(JSON.stringify({ summary: '' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // Generate from name alone when no notes exist
    prompt = type === 'venue'
      ? `You are writing a brief venue overview for a cultural events diary app. Write a concise 1-3 sentence summary about "${name}" — what kind of venue it is, what it's known for, and any practical tips. Be conversational and useful.`
      : `You are writing a brief artist/show overview for a cultural events diary app. Write a concise 1-3 sentence summary about "${name}" — what genre/style they perform, and what they're known for. Be conversational and useful.`;
  } else {
    prompt = type === 'venue'
      ? `You are summarising venue commentary for a cultural events diary app. Given these notes from different visits to "${name || 'this venue'}", write a concise 1-3 sentence summary capturing the key impressions (atmosphere, sound, seating, tips). Be conversational and useful. Only use information from the notes — don't invent details.\n\nNotes:\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
      : `You are summarising artist/show commentary for a cultural events diary app. Given these notes from different events by "${name || 'this artist'}", write a concise 1-3 sentence summary capturing the key impressions. Be conversational and useful. Only use information from the notes — don't invent details.\n\nNotes:\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return new Response(JSON.stringify({ error: err }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await response.json();
    const summary = data.content?.[0]?.text || '';

    return new Response(JSON.stringify({ summary }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

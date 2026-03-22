export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { venue, address } = await req.json();
    if (!venue) {
      return new Response(JSON.stringify({ error: 'Missing venue' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const apiKey = Netlify.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No API key configured' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 1: Find the place
    const query = address ? `${venue}, ${address}` : `${venue}, London`;
    const searchUrl = `https://places.googleapis.com/v1/places:searchText`;
    const searchRes = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.photos'
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 })
    });

    if (!searchRes.ok) {
      return new Response(JSON.stringify({ error: 'Places search failed' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    const searchData = await searchRes.json();
    const place = searchData.places?.[0];
    if (!place?.photos?.length) {
      return new Response(JSON.stringify({ photos: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 2: Get photo URLs (max 5)
    const photos = place.photos.slice(0, 5).map(photo => {
      const name = photo.name;
      return {
        url: `https://places.googleapis.com/v1/${name}/media?maxWidthPx=400&key=${apiKey}`,
        attribution: photo.authorAttributions?.[0]?.displayName || ''
      };
    });

    return new Response(JSON.stringify({ photos }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: `Photo fetch failed: ${err.message}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

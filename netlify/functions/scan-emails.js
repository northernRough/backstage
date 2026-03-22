import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export default async (req) => {
  try {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { userId, manual } = await req.json();
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Missing userId' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const anthropicKey = Netlify.env.get('ANTHROPIC_API_KEY');
  const firebaseUrl = Netlify.env.get('FIREBASE_DB_URL');

  // Get user's IMAP credentials and sender list from Firebase
  const userRes = await fetch(`${firebaseUrl}/users/${userId}.json`);
  const userData = await userRes.json();

  const imapEmail = userData?.imapEmail;
  // Read IMAP password: env var > /credentials path > legacy /users path
  let imapPassword = Netlify.env.get('IMAP_PASS_' + userId.toUpperCase());
  if (!imapPassword) {
    const credRes = await fetch(`${firebaseUrl}/credentials/${userId}.json`);
    const credData = await credRes.json();
    imapPassword = credData?.imapPassword || userData?.imapPassword;
  }
  const provider = userData?.emailProvider || 'icloud';
  const senders = userData?.watchSenders;
  const ticketSenders = userData?.ticketSenders;
  const interests = userData?.interests || '';

  // Build taste profile from user's past ratings and comments
  const allEventsRes = await fetch(`${firebaseUrl}/events.json`);
  const allEventsData = await allEventsRes.json() || {};
  const tasteEntries = Object.values(allEventsData)
    .filter(e => e.status === 'Past' && e.ratings?.[userId])
    .map(e => ({
      artist: e.artist,
      type: e.type,
      rating: e.ratings[userId],
      notes: e.notes || ''
    }))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 30);
  const tasteProfile = tasteEntries.length
    ? `\n\nThe user's taste profile (from their past ratings and comments):\n${tasteEntries.map(t => `- ${t.artist} (${t.type}): rated ${t.rating}/10${t.notes ? ` — "${t.notes}"` : ''}`).join('\n')}`
    : '';

  if (!imapEmail || !imapPassword) {
    return new Response(JSON.stringify({ error: 'Email not connected. Add your email credentials in Settings.' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const imapHosts = {
    icloud: { host: 'imap.mail.me.com', port: 993 },
    gmail: { host: 'imap.gmail.com', port: 993 }
  };
  const imapConfig = imapHosts[provider] || imapHosts.icloud;

  const senderList = senders ? Object.values(senders) : [];
  const ticketSenderList = ticketSenders ? Object.values(ticketSenders) : [];

  if (!senderList.length && !ticketSenderList.length) {
    return new Response(JSON.stringify({ error: 'No senders to watch. Add venue email addresses in Settings.' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Connect to iCloud IMAP
  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: true,
    auth: { user: imapEmail, pass: imapPassword },
    logger: false
  });

  let emailBodies = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Manual scans look back 90 days; scheduled scans 3 days (slight overlap)
      const lookbackDays = manual ? 90 : 3;
      const maxPerSender = manual ? 15 : 5;
      const since = new Date();
      since.setDate(since.getDate() - lookbackDays);

      // Search newsletter senders for event listings
      for (const sender of senderList) {
        const messages = await client.search({ from: sender, since });
        for (const uid of messages.slice(0, maxPerSender)) {
          const msg = await client.fetchOne(uid, { source: true });
          if (!msg?.source) continue;
          const parsed = await simpleParser(msg.source);
          const html = parsed.html || '';
          const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map(m => m[1]);
          const linkBlock = links.length ? '\n\nLinks found: ' + [...new Set(links)].slice(0, 20).join(' ') : '';
          const body = ((parsed.text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) + linkBlock).slice(0, 4000);
          emailBodies.push({ subject: parsed.subject || '', from: sender, date: parsed.date?.toISOString() || '', body, isTicketSender: false });
        }
      }

      // Search ticket confirmation senders
      for (const sender of ticketSenderList) {
        const messages = await client.search({ from: sender, since });
        for (const uid of messages.slice(0, maxPerSender)) {
          const msg = await client.fetchOne(uid, { source: true });
          if (!msg?.source) continue;
          const parsed = await simpleParser(msg.source);
          const html = parsed.html || '';
          const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map(m => m[1]);
          const linkBlock = links.length ? '\n\nLinks found: ' + [...new Set(links)].slice(0, 20).join(' ') : '';
          const body = ((parsed.text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) + linkBlock).slice(0, 4000);
          emailBodies.push({ subject: parsed.subject || '', from: sender, date: parsed.date?.toISOString() || '', body, isTicketSender: true });
        }
      }

    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    return new Response(JSON.stringify({ error: `IMAP connection failed: ${err.message}. Check your email and app-specific password.` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!emailBodies.length) {
    return new Response(JSON.stringify({ events: 0, added: 0, message: 'No recent emails found from watched senders.' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Send to Claude to extract events
  const prompt = `You are extracting upcoming cultural events from venue newsletter emails for a diary app called Backstage.

${interests ? `The user's interests: ${interests}\n` : ''}${tasteProfile}
From the following emails, extract any upcoming events (concerts, shows, exhibitions, etc). Also detect booking confirmation emails — if an email is a ticket purchase confirmation or e-ticket, mark it as a confirmed booking.

For each event return a JSON object with:
- "artist": the full event/show name as listed (e.g. "Emma Smith Sings the Cole Porter Songbook")
- "mainArtist": just the core artist/performer name for music service searches (e.g. "Emma Smith"). For theatre/musicals use the show name. For exhibitions use the exhibition name.
- "venue": the venue name
- "date": in YYYY-MM-DD format (if mentioned, otherwise "")
- "type": one of Music, Theatre, Musical, Dance, Comedy, Film, Exhibition, Festival, Classical, Other
- "bookingUrl": the URL to book/buy tickets for this specific event (if found in the email, otherwise "")
- "artistNotes": a brief 1-sentence description of why this might be interesting (based on the email content, user interests, and their taste profile)
- "isBookingConfirmation": true if this email is a ticket purchase/booking confirmation, false otherwise
- "doorsOpen": doors open time if mentioned (e.g. "7:00 PM"), otherwise ""
- "startTime": event/show start time if mentioned (e.g. "8:00 PM"), otherwise ""
- "ticketInfo": if a booking confirmation, include any useful details (seat numbers, booking reference) as a short string, otherwise ""

Return ONLY a JSON array of events. If no events found, return [].
Do not include events that have already passed. Today's date is ${new Date().toISOString().split('T')[0]}.

Emails:
${emailBodies.map((e, i) => `--- Email ${i + 1} ---\nFrom: ${e.from}${e.isTicketSender ? ' [TICKET/BOOKING SENDER]' : ''}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}`).join('\n\n')}`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.text();
    return new Response(JSON.stringify({ error: `Claude API error: ${err}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const claudeData = await claudeRes.json();
  const text = claudeData.content?.[0]?.text || '[]';

  let events = [];
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) events = JSON.parse(match[0]);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Failed to parse events from AI response', raw: text }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Check existing events for deduplication
  const existingRes = await fetch(`${firebaseUrl}/events.json`);
  const existing = await existingRes.json() || {};

  let added = 0;
  let updated = 0;
  for (const event of events) {
    if (!event.artist) continue;

    // Find existing match
    const existingEntry = Object.entries(existing).find(([_, e]) =>
      e.artist === event.artist && e.venue === event.venue && e.date === event.date
    );

    if (existingEntry) {
      // Backfill missing fields only — never overwrite existing values
      const [existingId, existingData] = existingEntry;
      const backfill = {};
      if (!existingData.mainArtist && event.mainArtist) backfill.mainArtist = event.mainArtist;
      if (!existingData.bookingUrl && event.bookingUrl) backfill.bookingUrl = event.bookingUrl;
      if (!existingData.artistNotes && event.artistNotes) backfill.artistNotes = event.artistNotes;
      if (!existingData.date && event.date) backfill.date = event.date;
      if (!existingData.ticketInfo && event.ticketInfo) backfill.ticketInfo = event.ticketInfo;
      if (!existingData.doorsOpen && event.doorsOpen) backfill.doorsOpen = event.doorsOpen;
      if (!existingData.startTime && event.startTime) backfill.startTime = event.startTime;
      // Upgrade to Booked if we found a booking confirmation
      if (event.isBookingConfirmation && existingData.status === 'Suggested') {
        backfill.status = 'Booked';
        backfill.attendees = { [userId]: true };
      }

      if (Object.keys(backfill).length > 0) {
        await fetch(`${firebaseUrl}/events/${existingId}.json`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backfill)
        });
        updated++;
      }
      continue;
    }

    const isBooked = event.isBookingConfirmation === true;
    const eventData = {
      artist: event.artist,
      mainArtist: event.mainArtist || event.artist,
      venue: event.venue || '',
      date: event.date || '',
      type: event.type || 'Other',
      status: isBooked ? 'Booked' : 'Suggested',
      artistNotes: event.artistNotes || '',
      bookingUrl: event.bookingUrl || '',
      ticketInfo: event.ticketInfo || '',
      doorsOpen: event.doorsOpen || '',
      startTime: event.startTime || '',
      addedBy: 'ai',
      scannedBy: userId,
      createdAt: Date.now(),
      ...(isBooked ? { attendees: { [userId]: true } } : {})
    };

    await fetch(`${firebaseUrl}/events.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData)
    });
    added++;
  }

  // Also backfill venue booking URLs if not already set
  for (const event of events) {
    if (!event.venue || !event.bookingUrl) continue;
    const venueKey = event.venue.replace(/[.#$/[\]]/g, '_');
    const venueRes = await fetch(`${firebaseUrl}/venues/${venueKey}.json`);
    const venueData = await venueRes.json();
    if (!venueData?.bookingUrl) {
      await fetch(`${firebaseUrl}/venues/${venueKey}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: event.venue, bookingUrl: event.bookingUrl })
      });
    }
  }

  // Clean up expired suggestions (past date, still Suggested)
  const today = new Date().toISOString().split('T')[0];
  let expired = 0;
  for (const [eid, edata] of Object.entries(existing)) {
    if (edata.status === 'Suggested' && edata.date && edata.date < today) {
      await fetch(`${firebaseUrl}/events/${eid}.json`, { method: 'DELETE' });
      expired++;
    }
  }

  return new Response(JSON.stringify({
    events: events.length,
    added,
    updated,
    expired,
    scanned: emailBodies.length,
    message: `Scanned ${emailBodies.length} emails, found ${events.length} events, added ${added} new suggestions${updated ? `, updated ${updated} existing` : ''}${expired ? `, removed ${expired} expired` : ''}.`
  }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: `Scan failed: ${err.message}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

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

  // Fetch user data and all events in parallel (single fetch for events)
  const [userRes, credRes, allEventsRes] = await Promise.all([
    fetch(`${firebaseUrl}/users/${userId}.json`),
    fetch(`${firebaseUrl}/credentials/${userId}.json`),
    fetch(`${firebaseUrl}/events.json`)
  ]);
  const [userData, credData, allEventsData] = await Promise.all([
    userRes.json(),
    credRes.json(),
    allEventsRes.json()
  ]);
  const existing = allEventsData || {};

  const imapEmail = userData?.imapEmail;
  let imapPassword = Netlify.env.get('IMAP_PASS_' + userId.toUpperCase());
  if (!imapPassword) {
    imapPassword = credData?.imapPassword || userData?.imapPassword;
  }
  const provider = userData?.emailProvider || 'icloud';
  const senders = userData?.watchSenders;
  const ticketSenders = userData?.ticketSenders;
  const interests = userData?.interests || '';

  // Build taste profile from the already-fetched events
  const tasteEntries = Object.values(existing)
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

  // Connect to IMAP
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
      // Manual scans look back 90 days; scheduled scans 7 days
      const lookbackDays = manual ? 90 : 7;
      const maxPerSender = manual ? 30 : 10;
      const since = new Date();
      since.setDate(since.getDate() - lookbackDays);

      // Collect all sender searches into a flat list with isTicketSender flag
      const allSenders = [
        ...senderList.map(s => ({ sender: s, isTicketSender: false })),
        ...ticketSenderList.map(s => ({ sender: s, isTicketSender: true }))
      ];

      // Search all senders in parallel, then fetch messages
      const searchResults = await Promise.all(
        allSenders.map(async ({ sender, isTicketSender }) => {
          const uids = await client.search({ from: sender, since });
          return uids.slice(0, maxPerSender).map(uid => ({ uid, sender, isTicketSender }));
        })
      );
      const allMessages = searchResults.flat();

      // Build a UID→metadata map so we can batch-fetch from IMAP
      const uidMeta = new Map();
      for (const { uid, sender, isTicketSender } of allMessages) {
        uidMeta.set(uid, { sender, isTicketSender });
      }

      // Batch-fetch all messages at once (IMAP pipelines this internally)
      if (uidMeta.size > 0) {
        const uids = [...uidMeta.keys()];
        for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
          if (!msg?.source) continue;
          const meta = uidMeta.get(msg.uid);
          if (!meta) continue;
          const parsed = await simpleParser(msg.source);
          const html = parsed.html || '';
          const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map(m => m[1]);
          const linkBlock = links.length ? '\n\nLinks found: ' + [...new Set(links)].slice(0, 20).join(' ') : '';
          const body = ((parsed.text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) + linkBlock).slice(0, 4000);
          emailBodies.push({ subject: parsed.subject || '', from: meta.sender, date: parsed.date?.toISOString() || '', body, isTicketSender: meta.isTicketSender });
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

  // Build the shared prompt preamble (taste profile, instructions)
  const promptPreamble = `You are extracting upcoming cultural events from venue newsletter emails for a diary app called Backstage.

${interests ? `The user's interests: ${interests}\n` : ''}${tasteProfile}
From the following emails, extract any upcoming events (concerts, shows, exhibitions, etc). Also detect booking confirmation emails — if an email is a ticket purchase confirmation or e-ticket, mark it as a confirmed booking.

For each event return a JSON object with:
- "artist": the full event/show name as listed (e.g. "Emma Smith Sings the Cole Porter Songbook")
- "mainArtist": just the core artist/performer name for music service searches (e.g. "Emma Smith"). For theatre/musicals use the show name. For exhibitions use the exhibition name.
- "venue": the venue name
- "date": in YYYY-MM-DD format (if mentioned, otherwise "")
- "type": one of Music, Theatre, Musical, Dance, Comedy, Film, Exhibition, Festival, Classical, Other
- "bookingUrl": the URL to book/buy tickets for this specific event (if found in the email, otherwise "")
- "artistNotes": a personalized 1-2 sentence AI summary explaining WHY this event is recommended for this specific user. Reference their taste profile, past ratings, or stated interests where relevant. For example: "You loved [similar artist] — this avant-garde jazz trio has a similar improvisational energy." or "Right up your street based on your interest in contemporary dance." If no taste data is available, describe what makes the event notable.
- "isBookingConfirmation": true if this email is a ticket purchase/booking confirmation, false otherwise
- "doorsOpen": doors open time if mentioned (e.g. "7:00 PM"), otherwise ""
- "startTime": event/show start time if mentioned (e.g. "8:00 PM"), otherwise ""
- "ticketInfo": if a booking confirmation, include any useful details (seat numbers, booking reference) as a short string, otherwise ""

Return ONLY a JSON array of events. If no events found, return [].
Do not include events that have already passed. Today's date is ${new Date().toISOString().split('T')[0]}.`;

  // Split emails into chunks and call Claude in parallel to avoid timeout
  const CHUNK_SIZE = 20;
  const chunks = [];
  for (let i = 0; i < emailBodies.length; i += CHUNK_SIZE) {
    chunks.push(emailBodies.slice(i, i + CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(chunks.map(async (chunk) => {
    const prompt = `${promptPreamble}\n\nEmails:\n${chunk.map((e, i) => `--- Email ${i + 1} ---\nFrom: ${e.from}${e.isTicketSender ? ' [TICKET/BOOKING SENDER]' : ''}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}`).join('\n\n')}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  }));

  let events = chunkResults.flat();

  // Deduplicate within the batch itself (case-insensitive)
  const seen = new Set();
  events = events.filter(e => {
    if (!e.artist) return false;
    const key = `${(e.artist || '').toLowerCase()}|${(e.venue || '').toLowerCase()}|${e.date || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Process events: dedup against existing, write new ones, backfill existing
  let added = 0;
  let updated = 0;

  // Batch all Firebase writes into parallel groups
  const writePromises = [];

  for (const event of events) {

    // Find existing match (case-insensitive to avoid duplicates like "JOHN SMITH" vs "John Smith")
    const existingEntry = Object.entries(existing).find(([_, e]) =>
      (e.artist || '').toLowerCase() === (event.artist || '').toLowerCase() &&
      (e.venue || '').toLowerCase() === (event.venue || '').toLowerCase() &&
      e.date === event.date
    );

    if (existingEntry) {
      const [existingId, existingData] = existingEntry;
      const backfill = {};
      if (!existingData.mainArtist && event.mainArtist) backfill.mainArtist = event.mainArtist;
      if (!existingData.bookingUrl && event.bookingUrl) backfill.bookingUrl = event.bookingUrl;
      if (!existingData.artistNotes && event.artistNotes) backfill.artistNotes = event.artistNotes;
      if (!existingData.tasteReason && event.tasteReason) backfill.tasteReason = event.tasteReason;
      if (!existingData.date && event.date) backfill.date = event.date;
      if (!existingData.ticketInfo && event.ticketInfo) backfill.ticketInfo = event.ticketInfo;
      if (!existingData.doorsOpen && event.doorsOpen) backfill.doorsOpen = event.doorsOpen;
      if (!existingData.startTime && event.startTime) backfill.startTime = event.startTime;
      if (event.isBookingConfirmation && existingData.status === 'Suggested') {
        backfill.status = 'Booked';
        backfill.attendees = { [userId]: true };
      }

      if (Object.keys(backfill).length > 0) {
        writePromises.push(
          fetch(`${firebaseUrl}/events/${existingId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(backfill)
          }).then(() => { updated++; })
        );
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
      tasteReason: event.tasteReason || '',
      bookingUrl: event.bookingUrl || '',
      ticketInfo: event.ticketInfo || '',
      doorsOpen: event.doorsOpen || '',
      startTime: event.startTime || '',
      addedBy: 'ai',
      scannedBy: userId,
      createdAt: Date.now(),
      ...(isBooked ? { attendees: { [userId]: true } } : {})
    };

    writePromises.push(
      fetch(`${firebaseUrl}/events.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData)
      }).then(() => { added++; })
    );
  }

  // Backfill venue booking URLs in parallel
  const venueChecks = [];
  const seenVenues = new Set();
  for (const event of events) {
    if (!event.venue || !event.bookingUrl || seenVenues.has(event.venue)) continue;
    seenVenues.add(event.venue);
    const venueKey = event.venue.replace(/[.#$/[\]]/g, '_');
    venueChecks.push(
      fetch(`${firebaseUrl}/venues/${venueKey}.json`)
        .then(res => res.json())
        .then(venueData => {
          if (!venueData?.bookingUrl) {
            return fetch(`${firebaseUrl}/venues/${venueKey}.json`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: event.venue, bookingUrl: event.bookingUrl })
            });
          }
        })
    );
  }

  // Clean up expired suggestions in parallel
  const today = new Date().toISOString().split('T')[0];
  const expiredDeletes = [];
  for (const [eid, edata] of Object.entries(existing)) {
    if (edata.status === 'Suggested' && edata.date && edata.date < today) {
      expiredDeletes.push(fetch(`${firebaseUrl}/events/${eid}.json`, { method: 'DELETE' }));
    }
  }
  const expired = expiredDeletes.length;

  // Execute all writes, venue checks, and deletes in parallel
  await Promise.all([...writePromises, ...venueChecks, ...expiredDeletes]);

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

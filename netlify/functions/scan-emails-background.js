const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// Helper to update scan status in Firebase
async function updateStatus(firebaseUrl, userId, status) {
  await fetch(`${firebaseUrl}/scanStatus/${userId}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...status, updatedAt: Date.now() })
  });
}

// Append a line to the persistent scan log
async function appendLog(firebaseUrl, userId, scanLog, message) {
  scanLog.push(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  await fetch(`${firebaseUrl}/scanLogs/${userId}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ log: scanLog, updatedAt: Date.now() })
  });
}

exports.handler = async (event) => {
  const { userId, manual, scheduledSubs } = JSON.parse(event.body || '{}');
  if (!userId) return { statusCode: 400 };

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const firebaseUrl = process.env.FIREBASE_DB_URL;

  const scanLog = [];

  try {
    await updateStatus(firebaseUrl, userId, { state: 'starting', progress: 'Loading data…' });
    await appendLog(firebaseUrl, userId, scanLog, `Scan started. manual=${manual}`);

    // Fetch user data and all events in parallel
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
    let imapPassword = process.env['IMAP_PASS_' + userId.toUpperCase()];
    if (!imapPassword) {
      imapPassword = credData?.imapPassword || userData?.imapPassword;
    }
    const provider = userData?.emailProvider || 'icloud';
    const senders = userData?.watchSenders;
    const ticketSenders = userData?.ticketSenders;
    const interests = userData?.interests || '';

    // Build taste profile
    const tasteEntries = Object.values(existing)
      .filter(e => e.status === 'Past' && e.ratings?.[userId])
      .map(e => ({ artist: e.artist, type: e.type, rating: e.ratings[userId], notes: e.notes || '' }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 30);
    const tasteProfile = tasteEntries.length
      ? `\n\nThe user's taste profile (from their past ratings and comments):\n${tasteEntries.map(t => `- ${t.artist} (${t.type}): rated ${t.rating}/10${t.notes ? ` — "${t.notes}"` : ''}`).join('\n')}`
      : '';

    if (!imapEmail || !imapPassword) {
      await updateStatus(firebaseUrl, userId, { state: 'error', progress: 'Email not connected. Add your email credentials in Settings.' });
      return { statusCode: 200 };
    }

    await appendLog(firebaseUrl, userId, scanLog, `Provider: ${provider}, email: ${imapEmail}`);
    await appendLog(firebaseUrl, userId, scanLog, `watchSenders keys: ${Object.keys(senders || {}).length}, ticketSenders keys: ${Object.keys(ticketSenders || {}).length}`);

    let senderList, ticketSenderList;

    if (scheduledSubs) {
      senderList = scheduledSubs.filter(s => !s.isTicketSender).map(s => s.email);
      ticketSenderList = scheduledSubs.filter(s => s.isTicketSender).map(s => s.email);
    } else {
      const extractEmails = (obj) => Object.values(obj || {})
        .map(v => typeof v === 'string' ? v : (v.enabled !== false ? v.email : null))
        .filter(Boolean);
      senderList = extractEmails(senders);
      ticketSenderList = extractEmails(ticketSenders);
    }

    await appendLog(firebaseUrl, userId, scanLog, `Senders: newsletters=${JSON.stringify(senderList)}, tickets=${JSON.stringify(ticketSenderList)}`);

    if (!senderList.length && !ticketSenderList.length) {
      await updateStatus(firebaseUrl, userId, { state: 'error', progress: 'No senders to watch. Add venue email addresses in Settings.' });
      return { statusCode: 200 };
    }

    // Connect to IMAP
    const imapHosts = {
      icloud: { host: 'imap.mail.me.com', port: 993 },
      gmail: { host: 'imap.gmail.com', port: 993 }
    };
    const imapConfig = imapHosts[provider] || imapHosts.icloud;

    const client = new ImapFlow({
      host: imapConfig.host,
      port: imapConfig.port,
      secure: true,
      auth: { user: imapEmail, pass: imapPassword },
      logger: false
    });

    let emailBodies = [];

    await updateStatus(firebaseUrl, userId, { state: 'fetching', progress: 'Connecting to email…' });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const lookbackDays = manual ? 90 : 2;
        const maxPerSender = manual ? 20 : 15;
        const since = new Date();
        since.setDate(since.getDate() - lookbackDays);

        const allSenders = [
          ...senderList.map(s => ({ sender: s, isTicketSender: false })),
          ...ticketSenderList.map(s => ({ sender: s, isTicketSender: true }))
        ];

        await updateStatus(firebaseUrl, userId, { state: 'fetching', progress: `Searching ${allSenders.length} senders…` });

        // Search each sender sequentially (single IMAP connection)
        const allMessages = [];
        for (const { sender, isTicketSender } of allSenders) {
          const uids = await client.search({ from: sender, since });
          await appendLog(firebaseUrl, userId, scanLog, `IMAP search "${sender}": ${uids.length} messages (using ${Math.min(uids.length, maxPerSender)})`);
          for (const uid of uids.slice(0, maxPerSender)) {
            allMessages.push({ uid, sender, isTicketSender });
          }
        }

        await appendLog(firebaseUrl, userId, scanLog, `Total messages to fetch: ${allMessages.length}`);
        await updateStatus(firebaseUrl, userId, { state: 'fetching', progress: `Downloading ${allMessages.length} emails…` });

        // Build UID→metadata map for batch fetch
        const uidMeta = new Map();
        for (const { uid, sender, isTicketSender } of allMessages) {
          uidMeta.set(uid, { sender, isTicketSender });
        }

        await appendLog(firebaseUrl, userId, scanLog, `UIDs to fetch: ${allMessages.length} messages, ${uidMeta.size} unique UIDs (${allMessages.length - uidMeta.size} duplicates removed)`);

        if (uidMeta.size > 0) {
          const uids = [...uidMeta.keys()];
          let fetchCount = 0;
          let noSourceCount = 0;
          let noMetaCount = 0;
          for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
            fetchCount++;
            if (!msg?.source) { noSourceCount++; continue; }
            const meta = uidMeta.get(msg.uid);
            if (!meta) { noMetaCount++; continue; }
            const parsed = await simpleParser(msg.source);
            const html = parsed.html || '';
            const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map(m => m[1]);
            const linkBlock = links.length ? '\n\nLinks found: ' + [...new Set(links)].slice(0, 20).join(' ') : '';
            const body = ((parsed.text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) + linkBlock).slice(0, 4000);
            emailBodies.push({ subject: parsed.subject || '', from: meta.sender, date: parsed.date?.toISOString() || '', body, isTicketSender: meta.isTicketSender });
          }
          await appendLog(firebaseUrl, userId, scanLog, `Fetch results: ${fetchCount} returned by IMAP, ${noSourceCount} had no source, ${noMetaCount} had no meta match, ${emailBodies.length} parsed successfully`);
        }

      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      await updateStatus(firebaseUrl, userId, { state: 'error', progress: `IMAP connection failed: ${err.message}. Check your email and app-specific password.` });
      return { statusCode: 200 };
    }

    await appendLog(firebaseUrl, userId, scanLog, `Fetched ${emailBodies.length} emails total`);
    for (const e of emailBodies.slice(0, 5)) {
      await appendLog(firebaseUrl, userId, scanLog, `  Subject: "${e.subject}" | From: ${e.from} | Body: ${e.body.length} chars`);
    }

    if (!emailBodies.length) {
      await updateStatus(firebaseUrl, userId, { state: 'complete', progress: 'No recent emails found from watched senders.', added: 0, events: 0 });
      return { statusCode: 200 };
    }

    // Build prompt preamble
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
Today's date is ${new Date().toISOString().split('T')[0]}. Include ALL events mentioned, even if their date has passed — the app handles past/future categorisation separately.`;

    // Group emails by sender
    const emailsBySender = new Map();
    for (const email of emailBodies) {
      if (!emailsBySender.has(email.from)) emailsBySender.set(email.from, []);
      emailsBySender.get(email.from).push(email);
    }

    // Process each sender through Claude sequentially with rate limit spacing
    let events = [];
    let senderIndex = 0;
    let skippedSenders = 0;
    const senderCount = emailsBySender.size;

    for (const [sender, senderEmails] of emailsBySender) {
      senderIndex++;
      await updateStatus(firebaseUrl, userId, { state: 'analysing', progress: `Analysing sender ${senderIndex} of ${senderCount}…` });

      const prompt = `${promptPreamble}\n\nEmails from ${sender}:\n${senderEmails.map((e, i) => `--- Email ${i + 1} ---\nFrom: ${e.from}${e.isTicketSender ? ' [TICKET/BOOKING SENDER]' : ''}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}`).join('\n\n')}`;

      // Retry once on rate limit after waiting
      let claudeRes;
      for (let attempt = 0; attempt < 2; attempt++) {
        claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
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

        if (claudeRes.ok) break;
        const errText = await claudeRes.text();
        if (errText.includes('rate_limit') && attempt === 0) {
          await updateStatus(firebaseUrl, userId, { state: 'analysing', progress: `Rate limit — waiting 60s before sender ${senderIndex}…` });
          await new Promise(r => setTimeout(r, 60000));
        } else {
          claudeRes = null;
          break;
        }
      }

      if (!claudeRes || !claudeRes.ok) {
        const errBody = claudeRes ? await claudeRes.text().catch(() => '(no body)') : '(null response)';
        await appendLog(firebaseUrl, userId, scanLog, `Sender ${senderIndex} "${sender}": SKIPPED — HTTP ${claudeRes?.status || 'null'}. ${errBody.slice(0, 200)}`);
        skippedSenders++;
        continue;
      }

      const claudeData = await claudeRes.json();
      const text = claudeData.content?.[0]?.text || '[]';
      const stopReason = claudeData.stop_reason || 'unknown';
      const inputTokens = claudeData.usage?.input_tokens || 0;
      const outputTokens = claudeData.usage?.output_tokens || 0;

      try {
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          await appendLog(firebaseUrl, userId, scanLog, `Sender ${senderIndex} "${sender}": ${senderEmails.length} emails → ${parsed.length} events (${inputTokens}in/${outputTokens}out, stop=${stopReason})`);
          if (parsed.length === 0) {
            await appendLog(firebaseUrl, userId, scanLog, `  Claude full response: ${text.slice(0, 500)}`);
            await appendLog(firebaseUrl, userId, scanLog, `  Email subjects: ${senderEmails.map(e => e.subject).join(' | ')}`);
            await appendLog(firebaseUrl, userId, scanLog, `  Sample body (first email, first 500 chars): ${senderEmails[0]?.body?.slice(0, 500)}`);
          }
          events.push(...parsed);
        } else {
          await appendLog(firebaseUrl, userId, scanLog, `Sender ${senderIndex} "${sender}": No JSON array found. Full response: ${text.slice(0, 500)}`);
        }
      } catch (e) {
        await appendLog(firebaseUrl, userId, scanLog, `Sender ${senderIndex} "${sender}": JSON parse error: ${e.message}. Text: ${text.slice(0, 500)}`);
      }

      // Brief pause between senders to stay under rate limits
      if (senderIndex < senderCount) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await updateStatus(firebaseUrl, userId, { state: 'saving', progress: 'Saving events…' });

    // Deduplicate within batch (case-insensitive)
    const seen = new Set();
    events = events.filter(e => {
      if (!e.artist) return false;
      const key = `${(e.artist || '').toLowerCase()}|${(e.venue || '').toLowerCase()}|${e.date || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Write events to Firebase
    let added = 0;
    let updated = 0;
    const writePromises = [];

    for (const event of events) {
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

    // Backfill venue booking URLs
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

    // Clean up expired suggestions
    const today = new Date().toISOString().split('T')[0];
    const expiredDeletes = [];
    for (const [eid, edata] of Object.entries(existing)) {
      if (edata.status === 'Suggested' && edata.date && edata.date < today) {
        expiredDeletes.push(fetch(`${firebaseUrl}/events/${eid}.json`, { method: 'DELETE' }));
      }
    }
    const expired = expiredDeletes.length;

    await Promise.all([...writePromises, ...venueChecks, ...expiredDeletes]);

    await appendLog(firebaseUrl, userId, scanLog, `Done. ${events.length} events after dedup, ${added} added, ${updated} updated, ${expired} expired removed, ${skippedSenders}/${senderCount} senders skipped`);

    const message = `Scanned ${emailBodies.length} emails from ${senderCount} senders, found ${events.length} events, added ${added} new suggestions${updated ? `, updated ${updated} existing` : ''}${expired ? `, removed ${expired} expired` : ''}${skippedSenders ? ` (${skippedSenders}/${senderCount} senders skipped)` : ''}.`;
    await updateStatus(firebaseUrl, userId, { state: 'complete', progress: message, added, updated, expired, events: events.length, scanned: emailBodies.length, senders: senderCount, skipped: skippedSenders });

  } catch (err) {
    await appendLog(firebaseUrl, userId, scanLog, `FATAL ERROR: ${err.message}\n${err.stack}`);
    await updateStatus(firebaseUrl, userId, { state: 'error', progress: `Scan failed: ${err.message}` });
  }

  return { statusCode: 200 };
};

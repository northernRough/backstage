import { db } from './firebase-config.js';
import {
  ref, push, set, get, update, remove, onValue
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";

// ===== STATE =====
let currentUser = null;
let allEvents = {};
let allArtists = {};
let allVenues = {};

// Form state
let selectedType = 'Gig';
let selectedStatus = 'Past';
let selectedAttendees = [];
let ratings = { nick: 0, denise: 0, ben: 0 };

// Filters
let feedPersonFilter = 'all';
let feedTypeFilter = 'all';
let upcomingStatusFilter = 'all';

// ===== USERS =====
const USERS = {
  nick:   { name: 'Nick',   initial: 'N', isAdmin: true },
  denise: { name: 'Denise', initial: 'D' },
  ben:    { name: 'Ben',    initial: 'B' }
};

// ===== HELPERS =====
function starsHtml(n, max = 5) {
  if (!n) return '<span style="color:var(--text-dim)">—</span>';
  return '★'.repeat(Math.round(n)) + '☆'.repeat(max - Math.round(n));
}
function avgRating(ratings) {
  const vals = Object.values(ratings || {}).filter(v => v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function typeEmoji(type) {
  return { Gig:'🎵', Theatre:'🎭', Dance:'💃', Exhibition:'🖼', Comedy:'😂', Opera:'🎼' }[type] || '◈';
}

// ===== LOGIN =====
document.querySelectorAll('.user-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentUser = btn.dataset.user;
    document.getElementById('currentUserBadge').textContent = USERS[currentUser].name;
    document.getElementById('loginScreen').classList.remove('active');
    document.getElementById('appScreen').classList.add('active');
    initListeners();
  });
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  currentUser = null;
  document.getElementById('appScreen').classList.remove('active');
  document.getElementById('loginScreen').classList.add('active');
});

// ===== TAB NAV =====
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ===== FIREBASE LISTENERS =====
function initListeners() {
  onValue(ref(db, 'events'), snap => {
    allEvents = snap.val() || {};
    renderFeed();
    renderUpcoming();
  });
  onValue(ref(db, 'artists'), snap => {
    allArtists = snap.val() || {};
    renderArtists();
  });
  onValue(ref(db, 'venues'), snap => {
    allVenues = snap.val() || {};
    renderVenues();
  });
}

// ===== FEED =====
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    feedPersonFilter = chip.dataset.filter;
    renderFeed();
  });
});
document.querySelectorAll('.type-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.type-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    feedTypeFilter = chip.dataset.type;
    renderFeed();
  });
});

function renderFeed() {
  const list = document.getElementById('feedList');
  const events = Object.entries(allEvents)
    .filter(([_, e]) => e.status === 'Past')
    .filter(([_, e]) => feedTypeFilter === 'all' || e.type === feedTypeFilter)
    .filter(([_, e]) => {
      if (feedPersonFilter === 'all') return true;
      return e.attendees && e.attendees[feedPersonFilter];
    })
    .sort((a, b) => (b[1].date || '').localeCompare(a[1].date || ''));

  if (!events.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">◈</div><div class="empty-state-text">Nothing logged yet.<br>Tap + to add your first event.</div></div>`;
    return;
  }
  list.innerHTML = events.map(([id, e]) => eventCardHtml(id, e)).join('');
  list.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => openEventDetail(card.dataset.id));
  });
}

function eventCardHtml(id, e) {
  const avg = avgRating(e.ratings);
  const ratingPills = Object.entries(e.ratings || {})
    .filter(([_, v]) => v > 0)
    .map(([u, v]) => `<span class="rating-pill"><span class="rp-name">${USERS[u]?.name}</span><span class="rp-stars">${'★'.repeat(v)}</span></span>`)
    .join('');

  return `
    <div class="event-card" data-id="${id}">
      <div class="event-top">
        <div>
          <div class="event-artist">${e.artist || 'Unknown'}</div>
          <div class="event-venue">${e.venue || ''}</div>
        </div>
        <span class="event-type-badge">${typeEmoji(e.type)} ${e.type}</span>
      </div>
      <div class="event-meta">
        <span class="event-date">${formatDate(e.date)}</span>
        <div class="event-ratings">${ratingPills}</div>
      </div>
      ${e.notes ? `<div class="event-notes">${e.notes}</div>` : ''}
    </div>`;
}

// ===== UPCOMING =====
document.querySelectorAll('.status-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.status-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    upcomingStatusFilter = chip.dataset.status;
    renderUpcoming();
  });
});

function renderUpcoming() {
  const list = document.getElementById('upcomingList');
  const events = Object.entries(allEvents)
    .filter(([_, e]) => e.status === 'Booked' || e.status === 'Interested')
    .filter(([_, e]) => upcomingStatusFilter === 'all' || e.status === upcomingStatusFilter)
    .sort((a, b) => (a[1].date || '').localeCompare(b[1].date || ''));

  if (!events.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎟</div><div class="empty-state-text">Nothing upcoming yet.<br>Add something you're interested in.</div></div>`;
    return;
  }
  list.innerHTML = events.map(([id, e]) => upcomingCardHtml(id, e)).join('');
  list.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => openEventDetail(card.dataset.id));
  });
}

function upcomingCardHtml(id, e) {
  return `
    <div class="event-card" data-id="${id}">
      <div class="event-top">
        <div>
          <div class="event-artist">${e.artist || 'Unknown'}</div>
          <div class="event-venue">${e.venue || ''}</div>
        </div>
        <span class="status-badge ${e.status}">${e.status}</span>
      </div>
      <div class="event-meta">
        <span class="event-date">${formatDate(e.date)}</span>
        <span class="event-type-badge">${typeEmoji(e.type)} ${e.type}</span>
      </div>
      ${e.notes ? `<div class="event-notes">${e.notes}</div>` : ''}
    </div>`;
}

// ===== ARTISTS =====
document.getElementById('artistSearch').addEventListener('input', renderArtists);

function renderArtists() {
  const q = document.getElementById('artistSearch').value.toLowerCase();
  const list = document.getElementById('artistList');

  // Build artist stats from events
  const stats = {};
  Object.values(allEvents).forEach(e => {
    if (!e.artist || e.status !== 'Past') return;
    if (!stats[e.artist]) stats[e.artist] = { count: 0, total: 0, ratings: [] };
    stats[e.artist].count++;
    const avg = avgRating(e.ratings);
    if (avg) { stats[e.artist].total += avg; stats[e.artist].ratings.push(avg); }
  });

  let artists = Object.entries(allArtists)
    .filter(([name]) => !q || name.toLowerCase().includes(q))
    .sort((a, b) => a[0].localeCompare(b[0]));

  // Also include artists from events not yet in allArtists
  const allArtistNames = new Set([
    ...Object.keys(allArtists),
    ...Object.values(allEvents).filter(e => e.artist).map(e => e.artist)
  ]);
  const filtered = [...allArtistNames].filter(n => !q || n.toLowerCase().includes(q)).sort();

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎵</div><div class="empty-state-text">No artists yet.</div></div>`;
    return;
  }

  list.innerHTML = filtered.map(name => {
    const s = stats[name] || { count: 0, ratings: [] };
    const avg = s.ratings.length ? (s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length).toFixed(1) : null;
    return `
      <div class="profile-card" data-name="${name}" data-kind="artist">
        <div class="profile-avatar">${name[0].toUpperCase()}</div>
        <div class="profile-info">
          <div class="profile-name">${name}</div>
          <div class="profile-sub">${s.count} event${s.count !== 1 ? 's' : ''}</div>
        </div>
        <div class="profile-score">
          <div class="profile-stars">${avg ? starsHtml(Math.round(avg)) : ''}</div>
          <div class="profile-count">${avg ? avg + ' avg' : ''}</div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', () => openProfile('artist', card.dataset.name));
  });
}

// ===== VENUES =====
document.getElementById('venueSearch').addEventListener('input', renderVenues);

function renderVenues() {
  const q = document.getElementById('venueSearch').value.toLowerCase();
  const list = document.getElementById('venueList');

  const stats = {};
  Object.values(allEvents).forEach(e => {
    if (!e.venue || e.status !== 'Past') return;
    if (!stats[e.venue]) stats[e.venue] = { count: 0, ratings: [] };
    stats[e.venue].count++;
    const avg = avgRating(e.ratings);
    if (avg) stats[e.venue].ratings.push(avg);
  });

  const allVenueNames = new Set([
    ...Object.keys(allVenues),
    ...Object.values(allEvents).filter(e => e.venue).map(e => e.venue)
  ]);
  const filtered = [...allVenueNames].filter(n => !q || n.toLowerCase().includes(q)).sort();

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📍</div><div class="empty-state-text">No venues yet.</div></div>`;
    return;
  }

  list.innerHTML = filtered.map(name => {
    const s = stats[name] || { count: 0, ratings: [] };
    const avg = s.ratings.length ? (s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length).toFixed(1) : null;
    return `
      <div class="profile-card" data-name="${name}" data-kind="venue">
        <div class="profile-avatar" style="border-radius:8px;">📍</div>
        <div class="profile-info">
          <div class="profile-name">${name}</div>
          <div class="profile-sub">${s.count} event${s.count !== 1 ? 's' : ''}</div>
        </div>
        <div class="profile-score">
          <div class="profile-stars">${avg ? starsHtml(Math.round(avg)) : ''}</div>
          <div class="profile-count">${avg ? avg + ' avg' : ''}</div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', () => openProfile('venue', card.dataset.name));
  });
}

// ===== ADD EVENT MODAL =====
const fabBtn = document.getElementById('fabBtn');
const addModal = document.getElementById('addEventModal');
const closeAddModal = document.getElementById('closeAddModal');

fabBtn.addEventListener('click', () => {
  resetForm();
  addModal.classList.add('active');
});
closeAddModal.addEventListener('click', () => addModal.classList.remove('active'));
addModal.addEventListener('click', e => { if (e.target === addModal) addModal.classList.remove('active'); });

// Type selector
document.querySelectorAll('.type-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.type-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedType = btn.dataset.val;
  });
});

// Status selector
document.querySelectorAll('.status-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.status-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedStatus = btn.dataset.val;
    toggleRatingsAttendees();
  });
});

function toggleRatingsAttendees() {
  const isPast = selectedStatus === 'Past';
  document.getElementById('attendeesGroup').style.display = isPast ? 'block' : 'none';
  document.getElementById('ratingsGroup').style.display = isPast ? 'block' : 'none';
}

// Attendees
document.querySelectorAll('.attendee-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    const u = btn.dataset.val;
    if (selectedAttendees.includes(u)) {
      selectedAttendees = selectedAttendees.filter(x => x !== u);
    } else {
      selectedAttendees.push(u);
    }
    renderRatingInputs();
  });
});

function renderRatingInputs() {
  const container = document.getElementById('ratingInputs');
  container.innerHTML = selectedAttendees.map(u => `
    <div class="rating-row">
      <span class="rating-label">${USERS[u].name}</span>
      <div class="stars-input" data-user="${u}">
        ${[1,2,3,4,5].map(n => `<button class="star-btn" data-star="${n}">★</button>`).join('')}
      </div>
    </div>`).join('');

  container.querySelectorAll('.stars-input').forEach(input => {
    const u = input.dataset.user;
    input.querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = parseInt(btn.dataset.star);
        ratings[u] = val;
        input.querySelectorAll('.star-btn').forEach(b => {
          b.classList.toggle('lit', parseInt(b.dataset.star) <= val);
        });
      });
    });
  });
}

// Artist autocomplete
document.getElementById('artistInput').addEventListener('input', function() {
  const q = this.value.toLowerCase();
  const box = document.getElementById('artistSuggestions');
  if (!q) { box.classList.remove('open'); return; }
  const matches = [...new Set(Object.values(allEvents).filter(e => e.artist).map(e => e.artist))]
    .filter(a => a.toLowerCase().includes(q)).slice(0, 5);
  if (!matches.length) { box.classList.remove('open'); return; }
  box.innerHTML = matches.map(m => `<div class="suggestion-item">${m}</div>`).join('');
  box.classList.add('open');
  box.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('click', () => {
      document.getElementById('artistInput').value = item.textContent;
      box.classList.remove('open');
    });
  });
});

// Venue autocomplete
document.getElementById('venueInput').addEventListener('input', function() {
  const q = this.value.toLowerCase();
  const box = document.getElementById('venueSuggestions');
  if (!q) { box.classList.remove('open'); return; }
  const matches = [...new Set(Object.values(allEvents).filter(e => e.venue).map(e => e.venue))]
    .filter(v => v.toLowerCase().includes(q)).slice(0, 5);
  if (!matches.length) { box.classList.remove('open'); return; }
  box.innerHTML = matches.map(m => `<div class="suggestion-item">${m}</div>`).join('');
  box.classList.add('open');
  box.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('click', () => {
      document.getElementById('venueInput').value = item.textContent;
      box.classList.remove('open');
    });
  });
});

// Save event
document.getElementById('saveEventBtn').addEventListener('click', async () => {
  const artist = document.getElementById('artistInput').value.trim();
  const venue = document.getElementById('venueInput').value.trim();
  const date = document.getElementById('dateInput').value;
  const notes = document.getElementById('notesInput').value.trim();

  if (!artist) { alert('Please enter an artist or show name.'); return; }

  const eventData = {
    artist, venue, date, notes,
    type: selectedType,
    status: selectedStatus,
    addedBy: currentUser,
    createdAt: Date.now()
  };

  if (selectedStatus === 'Past') {
    const attendeesObj = {};
    selectedAttendees.forEach(u => { attendeesObj[u] = true; });
    eventData.attendees = attendeesObj;

    const ratingsObj = {};
    selectedAttendees.forEach(u => { if (ratings[u] > 0) ratingsObj[u] = ratings[u]; });
    eventData.ratings = ratingsObj;
  }

  // Ensure artist and venue records exist
  if (artist && !allArtists[artist]) {
    await set(ref(db, 'artists/' + artist.replace(/[.#$/[\]]/g, '_')), { name: artist, notes: '' });
  }
  if (venue && !allVenues[venue]) {
    await set(ref(db, 'venues/' + venue.replace(/[.#$/[\]]/g, '_')), { name: venue, notes: '' });
  }

  await push(ref(db, 'events'), eventData);
  addModal.classList.remove('active');
  resetForm();
});

function resetForm() {
  document.getElementById('artistInput').value = '';
  document.getElementById('venueInput').value = '';
  document.getElementById('dateInput').value = '';
  document.getElementById('notesInput').value = '';
  document.getElementById('artistSuggestions').classList.remove('open');
  document.getElementById('venueSuggestions').classList.remove('open');
  selectedType = 'Gig';
  selectedStatus = 'Past';
  selectedAttendees = [];
  ratings = { nick: 0, denise: 0, ben: 0 };
  document.querySelectorAll('.type-opt').forEach(b => b.classList.toggle('active', b.dataset.val === 'Gig'));
  document.querySelectorAll('.status-opt').forEach(b => b.classList.toggle('active', b.dataset.val === 'Past'));
  document.querySelectorAll('.attendee-opt').forEach(b => b.classList.remove('active'));
  document.getElementById('ratingInputs').innerHTML = '';
  toggleRatingsAttendees();
}

// ===== EVENT DETAIL =====
function openEventDetail(id) {
  const e = allEvents[id];
  if (!e) return;
  document.getElementById('detailTitle').textContent = e.artist || 'Event';
  const body = document.getElementById('detailBody');

  const ratingRows = Object.entries(e.ratings || {})
    .filter(([_, v]) => v > 0)
    .map(([u, v]) => `<div class="detail-rating-row">
      <span class="detail-rating-name">${USERS[u]?.name || u}</span>
      <span class="detail-stars">${starsHtml(v)}</span>
    </div>`).join('');

  const avg = avgRating(e.ratings);

  body.innerHTML = `
    <div class="detail-artist">${e.artist || ''}</div>
    <div class="detail-venue">${e.venue || ''}</div>
    <div class="detail-meta">${formatDate(e.date)} · ${typeEmoji(e.type)} ${e.type}${e.status !== 'Past' ? ' · <span class="status-badge ' + e.status + '">' + e.status + '</span>' : ''}</div>
    ${e.status === 'Past' && ratingRows ? `<div class="detail-ratings">${ratingRows}</div>` : ''}
    ${avg ? `<div style="color:var(--amber); font-size:1.2rem;">${starsHtml(Math.round(avg))} <span style="font-size:0.85rem; color:var(--text-mid)">${avg.toFixed(1)} avg</span></div>` : ''}
    ${e.notes ? `<div class="divider"></div><div class="detail-notes">${e.notes}</div>` : ''}
    <div class="detail-actions">
      <button class="detail-action-btn" id="editFromDetail">Edit</button>
      ${e.status !== 'Past' ? `<button class="detail-action-btn" id="markPastBtn">Mark as Past</button>` : ''}
      ${currentUser === 'nick' ? `<button class="detail-action-btn danger" id="deleteEventBtn">Delete</button>` : ''}
    </div>`;

  document.getElementById('eventDetailModal').classList.add('active');

  document.getElementById('deleteEventBtn')?.addEventListener('click', async () => {
    if (confirm('Delete this event?')) {
      await remove(ref(db, 'events/' + id));
      document.getElementById('eventDetailModal').classList.remove('active');
    }
  });

  document.getElementById('markPastBtn')?.addEventListener('click', async () => {
    await update(ref(db, 'events/' + id), { status: 'Past' });
    document.getElementById('eventDetailModal').classList.remove('active');
  });
}

document.getElementById('closeDetailModal').addEventListener('click', () => {
  document.getElementById('eventDetailModal').classList.remove('active');
});
document.getElementById('eventDetailModal').addEventListener('click', e => {
  if (e.target === document.getElementById('eventDetailModal'))
    document.getElementById('eventDetailModal').classList.remove('active');
});

// ===== PROFILE MODAL =====
function openProfile(kind, name) {
  document.getElementById('profileTitle').textContent = name;
  const body = document.getElementById('profileBody');

  const events = Object.entries(allEvents)
    .filter(([_, e]) => (kind === 'artist' ? e.artist === name : e.venue === name) && e.status === 'Past')
    .sort((a, b) => (b[1].date || '').localeCompare(a[1].date || ''));

  const allRatings = events.flatMap(([_, e]) => Object.values(e.ratings || {}).filter(v => v > 0));
  const avg = allRatings.length ? (allRatings.reduce((a,b)=>a+b,0)/allRatings.length).toFixed(1) : null;

  const existingNotes = kind === 'artist'
    ? (allArtists[name.replace(/[.#$/[\]]/g, '_')]?.notes || '')
    : (allVenues[name.replace(/[.#$/[\]]/g, '_')]?.notes || '');

  body.innerHTML = `
    <div class="profile-header">
      <div class="profile-avg">${avg ? starsHtml(Math.round(avg)) + ' ' + avg : '—'}</div>
      <div class="profile-event-count">${events.length} past event${events.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="profile-notes-section">
      <div class="profile-notes-label">Notes on this ${kind}</div>
      <textarea class="profile-notes-input" id="profileNotesInput" rows="3" placeholder="e.g. Always sit in the balcony…">${existingNotes}</textarea>
      <button class="save-notes-btn" id="saveProfileNotes">Save notes</button>
    </div>
    <div class="divider"></div>
    <div class="profile-events-title">History</div>
    ${events.map(([id, e]) => `
      <div class="event-card" data-id="${id}" style="margin-bottom:0.5rem">
        <div class="event-top">
          <div>
            <div class="event-artist" style="font-size:0.95rem">${kind === 'artist' ? e.venue : e.artist}</div>
          </div>
          <span class="event-type-badge">${typeEmoji(e.type)} ${e.type}</span>
        </div>
        <div class="event-meta">
          <span class="event-date">${formatDate(e.date)}</span>
          <div class="event-ratings">${
            Object.entries(e.ratings || {}).filter(([_,v])=>v>0)
              .map(([u,v]) => `<span class="rating-pill"><span class="rp-name">${USERS[u]?.name}</span><span class="rp-stars">${'★'.repeat(v)}</span></span>`)
              .join('')
          }</div>
        </div>
      </div>`).join('') || '<div style="color:var(--text-dim); font-size:0.85rem;">No past events logged.</div>'}`;

  body.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => openEventDetail(card.dataset.id));
  });

  document.getElementById('saveProfileNotes').addEventListener('click', async () => {
    const notes = document.getElementById('profileNotesInput').value;
    const key = name.replace(/[.#$/[\]]/g, '_');
    await set(ref(db, (kind === 'artist' ? 'artists/' : 'venues/') + key), { name, notes });
    alert('Notes saved.');
  });

  document.getElementById('profileModal').classList.add('active');
}

document.getElementById('closeProfileModal').addEventListener('click', () => {
  document.getElementById('profileModal').classList.remove('active');
});
document.getElementById('profileModal').addEventListener('click', e => {
  if (e.target === document.getElementById('profileModal'))
    document.getElementById('profileModal').classList.remove('active');
});

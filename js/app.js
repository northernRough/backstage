import { db } from './firebase-config.js';
import {
  ref, push, set, get, update, remove, onValue
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";

// ===== STATE =====
let currentUser = null;
let realUser = null; // The actual logged-in user (for admin impersonation)
let allEvents = {};
let allArtists = {};
let allVenues = {};

// Form state
let selectedType = 'Music';
let selectedStatus = 'Past';
let selectedAttendees = [];
let ratings = { nick: 0, denise: 0, ben: 0, indi: 0, liz: 0, martin: 0, laura: 0, rory: 0, noelle: 0, dave: 0, linda: 0 };
let editingEventId = null;

// Filters
let feedPersonFilter = 'all';
let feedTypeFilter = 'all';
let feedSort = 'date';
let upcomingStatusFilter = 'all';
let recentlySuggested = new Set();
let musicPlayer = 'apple';
let mapApp = 'apple';
let suggestedSource = 'everyone';
let shareSuggestions = 'share';
let shareComments = 'named';  // legacy, mapped from commentAttrib
let shareScope = 'group';
let commentAttrib = 'named';
let allUserPrefs = {};

// ===== USERS =====
const USERS = {
  admin:   { name: 'Admin',   initial: 'A', hidden: true },
  nick:    { name: 'Nick',    initial: 'N' },
  denise:  { name: 'Denise',  initial: 'D' },
  ben:     { name: 'Ben',     initial: 'B' },
  indi:    { name: 'Indi',    initial: 'I' },
  liz:     { name: 'Liz',     initial: 'L' },
  martin:  { name: 'Martin',  initial: 'M' },
  laura:   { name: 'Laura',   initial: 'L' },
  rory:    { name: 'Rory',    initial: 'R' },
  noelle:  { name: 'Noelle',  initial: 'N' },
  dave:    { name: 'Dave',    initial: 'D' },
  linda:   { name: 'Linda',   initial: 'L' }
};

// Admin users — stored in Firebase at /admins/{userId}: true
let adminUsers = {};

// ===== GROUPS =====
const DEFAULT_GROUPS = [
  ['rory', 'noelle'],
  ['nick', 'denise', 'ben', 'indi'],
  ['ben', 'laura'],
  ['martin', 'liz'],
  ['dave', 'linda']
];
let GROUPS = [...DEFAULT_GROUPS];
let groupNames = [];

function isAdmin(userId) {
  // When impersonating, admin privileges are suppressed for viewing
  if (realUser && currentUser !== realUser) return false;
  return adminUsers[userId] === true;
}
function isRealAdmin() {
  return adminUsers[realUser] === true;
}

function getGroupName(groupIdx) {
  // Per-user nickname takes priority, then global name, then member names
  const myNicknames = allUserPrefs[currentUser]?.groupNicknames || {};
  if (myNicknames[groupIdx]) return myNicknames[groupIdx];
  if (groupNames[groupIdx]) return groupNames[groupIdx];
  const g = GROUPS[groupIdx];
  if (!g) return 'Group';
  return g.map(u => USERS[u]?.name || u).join(', ');
}

function getMyPeople(viewer) {
  if (isAdmin(viewer)) return Object.keys(USERS).filter(id => !USERS[id].hidden);
  const people = new Set();
  GROUPS.forEach(g => {
    if (g.includes(viewer)) g.forEach(u => people.add(u));
  });
  return [...people];
}

function canSeeEvent(viewer, event) {
  if (isAdmin(viewer)) return true;
  const myPeople = getMyPeople(viewer);
  const attendees = Object.keys(event.attendees || {});
  // Can see if any attendee is in your scope, or event was added by someone in scope
  return attendees.some(a => myPeople.includes(a)) || myPeople.includes(event.addedBy);
}

function canSeeDetailedRating(viewer, rater) {
  if (isAdmin(viewer)) return true;
  return GROUPS.some(g => g.includes(viewer) && g.includes(rater));
}

function canSeeUserData(viewer, owner) {
  if (viewer === owner) return true;
  const scope = allUserPrefs[owner]?.shareScope || 'group';
  if (scope === 'private') return false;
  if (scope === 'everyone') return true;
  // 'group' — check if viewer and owner share a group
  return GROUPS.some(g => g.includes(viewer) && g.includes(owner));
}

function getVisibleRatings(eventRatings, viewer) {
  if (isAdmin(viewer)) {
    const detailed = Object.entries(eventRatings || {})
      .filter(([_, v]) => v != null && v >= 1 && v <= 10)
      .map(([userId, value]) => ({ userId, name: USERS[userId]?.name || userId, value }));
    return { detailed, summary: null };
  }
  const detailed = [];
  const summaryValues = [];
  Object.entries(eventRatings || {}).forEach(([userId, value]) => {
    if (value == null || value < 1 || value > 10) return;
    if (canSeeDetailedRating(viewer, userId) && canSeeUserData(viewer, userId)) {
      detailed.push({ userId, name: USERS[userId]?.name || userId, value });
    } else if (value >= 1 && value <= 10 && canSeeUserData(viewer, userId)) {
      summaryValues.push(value);
    }
  });
  const summary = summaryValues.length > 0
    ? { avg: (summaryValues.reduce((a,b) => a+b, 0) / summaryValues.length).toFixed(1), count: summaryValues.length }
    : null;
  return { detailed, summary };
}

// ===== SAVE BUTTON HELPERS =====
const _watched = new Set();
const _originals = {};

// Highlight when field has any content (for new entry forms)
function watchInputs(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  const check = () => btn.classList.toggle('has-content', input.value.trim().length > 0);
  const key = inputId + ':' + btnId;
  if (!_watched.has(key)) {
    _watched.add(key);
    input.addEventListener('input', check);
  }
  check();
}

// Highlight only when field value differs from original (for edit forms)
function watchChanges(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  _originals[inputId] = input.value;
  const check = () => btn.classList.toggle('has-content', input.value !== _originals[inputId]);
  const key = 'chg:' + inputId + ':' + btnId;
  if (!_watched.has(key) || !input._watchBound) {
    _watched.add(key);
    input._watchBound = true;
    input.addEventListener('input', check);
  }
  btn.classList.remove('has-content');
}

function markSaved(inputId) {
  _originals[inputId] = document.getElementById(inputId)?.value || '';
}

function hasUnsavedChanges(...inputIds) {
  return inputIds.some(id => {
    const el = document.getElementById(id);
    return el && id in _originals && el.value !== _originals[id];
  });
}

// ===== MODAL HELPERS =====
let scrollPos = 0;
function openModal(modal) {
  scrollPos = window.scrollY;
  document.body.classList.add('modal-open');
  document.body.style.top = `-${scrollPos}px`;
  modal.classList.add('active');
}
function closeModal(modal) {
  modal.classList.remove('active');
  if (!document.querySelector('.modal.active')) {
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, scrollPos);
  }
}

// ===== HELPERS =====
function ratingHtml(n) {
  if (n == null || n === 0) return '<span style="color:var(--text-dim)">—</span>';
  return `<span class="rating-num">${n}</span><span class="rating-denom">/10</span>`;
}
function avgRating(ratings) {
  const vals = Object.values(ratings || {}).filter(v => v >= 1 && v <= 10);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function typeEmoji(type) {
  return { Music:'🎵', Theatre:'🎭', Musical:'🎶', Dance:'💃', Comedy:'😂', Film:'🎬', Exhibition:'🖼', Festival:'🎪', Classical:'🎼', Other:'◈' }[type] || '◈';
}
function searchArtist(e) {
  // Prefer LLM-extracted mainArtist, fall back to artist name
  return e.mainArtist || e.artist || '';
}
// Per-user notes helpers — handles old string format and new { user: text } format
function getUserNote(field, userId) {
  if (!field) return '';
  if (typeof field === 'string') return field; // legacy
  return field[userId] || '';
}
function getAllNotes(field) {
  if (!field) return [];
  if (typeof field === 'string') return field ? [{ user: 'unknown', text: field }] : [];
  return Object.entries(field).filter(([_, t]) => t).map(([u, t]) => ({ user: u, text: t }));
}
function displayNotes(field, viewer) {
  const notes = getAllNotes(field);
  if (!notes.length) return '';
  const myPeople = getMyPeople(viewer);
  const visible = notes.filter(n => {
    if (n.user === viewer || n.user === 'unknown') return true;
    if (!myPeople.includes(n.user)) return false;
    return canSeeUserData(viewer, n.user);
  });
  if (!visible.length) return '';
  if (visible.length === 1) return visible[0].text;
  return visible.map(n => `${USERS[n.user]?.name || n.user}: ${n.text}`).join(' · ');
}
function mergeUserNote(existing, userId, newText) {
  const obj = {};
  if (existing && typeof existing === 'object' && typeof existing !== 'string') {
    Object.assign(obj, existing);
  } else if (existing && typeof existing === 'string') {
    // Migrate old string to 'unknown' key
    obj.unknown = existing;
  }
  if (newText) {
    obj[userId] = newText;
  } else {
    delete obj[userId];
  }
  return Object.keys(obj).length ? obj : null;
}

// ===== LOGIN =====

// Build feed person filter chips — scoped to user's group (admin sees all)
function buildFilterChips() {
  const feedFilterRow = document.getElementById('feedFilterRow');
  // Remove existing person chips (keep "All")
  feedFilterRow.querySelectorAll('.filter-chip:not([data-filter="all"])').forEach(c => c.remove());
  // "Mine only" chip
  const mineChip = document.createElement('button');
  mineChip.className = 'filter-chip';
  mineChip.dataset.filter = currentUser;
  mineChip.textContent = 'Mine only';
  feedFilterRow.appendChild(mineChip);
  // Group chips
  const myGroups = GROUPS.map((g, i) => ({ members: g, idx: i }))
    .filter(({ members }) => members.includes(currentUser));
  myGroups.forEach(({ members, idx }) => {
    const chip = document.createElement('button');
    chip.className = 'filter-chip';
    chip.dataset.filter = 'group-' + idx;
    chip.textContent = getGroupName(idx);
    feedFilterRow.appendChild(chip);
  });
}

async function loginUser(userId) {
  currentUser = userId;
  realUser = userId;
  sessionStorage.setItem('backstageUser', userId);
  localStorage.setItem('backstageName', USERS[userId].name);
  // Load admin list
  const adminSnap = await get(ref(db, 'admins'));
  adminUsers = adminSnap.val() || {};
  document.getElementById('currentUserBadge').textContent = USERS[currentUser].name;
  // Show impersonation selector for admins
  const impersonateWrap = document.getElementById('impersonateWrap');
  if (isAdmin(userId)) {
    impersonateWrap.style.display = 'flex';
    const sel = document.getElementById('impersonateSelect');
    sel.innerHTML = '<option value="">Select user…</option>';
    Object.entries(USERS).forEach(([id, u]) => {
      if (u.hidden) return; // skip admin from the list
      sel.innerHTML += `<option value="${id}">${u.name}</option>`;
    });
    // Auto-impersonate first real user (Nick)
    sel.value = 'nick';
    currentUser = 'nick';
    document.getElementById('currentUserBadge').textContent = 'Nick 👁';
  } else {
    impersonateWrap.style.display = 'none';
  }
  document.getElementById('loginScreen').classList.remove('active');
  document.getElementById('appScreen').classList.add('active');
  await loadGroups();
  const userSnap = await get(ref(db, 'users/' + currentUser));
  musicPlayer = userSnap.val()?.musicPlayer || 'apple';
  mapApp = userSnap.val()?.mapApp || 'apple';
  suggestedSource = userSnap.val()?.suggestedSource || 'everyone';
  shareSuggestions = userSnap.val()?.shareSuggestions || 'share';
  shareComments = userSnap.val()?.shareComments || userSnap.val()?.commentAttrib || 'named';
  shareScope = userSnap.val()?.shareScope || 'group';
  commentAttrib = userSnap.val()?.commentAttrib || 'named';
  lastSeenSuggested = userSnap.val()?.lastSeenSuggested || 0;
  buildFilterChips();
  feedPersonFilter = currentUser;
  // Highlight the user's own chip
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === currentUser));
  initListeners();
  // Check if first login — show onboarding if no interests set
  checkOnboarding();
}

// Pre-fill name from last login
const nameInput = document.getElementById('nameInput');
const savedName = localStorage.getItem('backstageName');
if (savedName) nameInput.value = savedName;

function attemptNameLogin() {
  const name = nameInput.value.trim().toLowerCase();
  const errorEl = document.getElementById('loginError');
  if (!name) { errorEl.textContent = 'Please enter your name'; return; }

  // Match against known users
  const match = Object.entries(USERS).find(([_, u]) => u.name.toLowerCase() === name);
  if (match) {
    loginUser(match[0]);
  } else {
    errorEl.textContent = 'Name not recognised';
    nameInput.focus();
  }
}

document.getElementById('nameLoginBtn').addEventListener('click', attemptNameLogin);
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') attemptNameLogin();
});

// Session persistence
const savedUser = sessionStorage.getItem('backstageUser');
if (savedUser && USERS[savedUser]) {
  loginUser(savedUser);
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  currentUser = null;
  realUser = null;
  sessionStorage.removeItem('backstageUser');
  document.getElementById('appScreen').classList.remove('active');
  document.getElementById('loginScreen').classList.add('active');
  document.getElementById('loginError').textContent = '';
});

// Admin impersonation
document.getElementById('impersonateSelect').addEventListener('change', async function() {
  const targetUser = this.value || realUser;
  currentUser = targetUser;
  document.getElementById('currentUserBadge').textContent = USERS[currentUser].name + (targetUser !== realUser ? ' 👁' : '');
  // Reload prefs for impersonated user
  const userSnap = await get(ref(db, 'users/' + currentUser));
  musicPlayer = userSnap.val()?.musicPlayer || 'apple';
  mapApp = userSnap.val()?.mapApp || 'apple';
  suggestedSource = userSnap.val()?.suggestedSource || 'everyone';
  shareSuggestions = userSnap.val()?.shareSuggestions || 'share';
  shareComments = userSnap.val()?.shareComments || userSnap.val()?.commentAttrib || 'named';
  shareScope = userSnap.val()?.shareScope || 'group';
  commentAttrib = userSnap.val()?.commentAttrib || 'named';
  lastSeenSuggested = userSnap.val()?.lastSeenSuggested || 0;
  buildFilterChips();
  feedPersonFilter = currentUser;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === currentUser));
  renderFeed();
  renderUpcoming();
  renderArtists();
  renderVenues();
});

// ===== TAB NAV =====
let activeTab = 'feed';
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    activeTab = btn.dataset.tab;
    if (btn.dataset.tab !== 'suggested') recentlyInterested.clear();
    if (btn.dataset.tab !== 'upcoming') recentlySuggested.clear();
    if (btn.dataset.tab === 'suggested') {
      lastSeenSuggested = Date.now();
      set(ref(db, 'users/' + currentUser + '/lastSeenSuggested'), lastSeenSuggested);
    }
  });
});

// ===== APP VERSION (force refresh) =====
let appVersionLoaded = false;
onValue(ref(db, 'appVersion'), snap => {
  const v = snap.val();
  if (!appVersionLoaded) {
    appVersionLoaded = true; // skip the initial load
    return;
  }
  // Version changed while app is open — reload
  if (v) window.location.reload();
});

// ===== FIREBASE LISTENERS =====
function initListeners() {
  onValue(ref(db, 'events'), snap => {
    allEvents = snap.val() || {};
    renderFeed();
    renderUpcoming();
    renderSuggested();
    renderArtists();
    renderVenues();
    renderCommunity();
  });
  onValue(ref(db, 'artists'), snap => {
    allArtists = snap.val() || {};
    renderArtists();
  });
  onValue(ref(db, 'venues'), snap => {
    allVenues = snap.val() || {};
    renderVenues();
  });
  onValue(ref(db, 'users'), snap => {
    allUserPrefs = snap.val() || {};
    renderSuggested();
    renderCommunity();
    renderCommunitySenders();
  });
  // Notifications listener
  onValue(ref(db, 'notifications/' + currentUser), snap => {
    const notifs = snap.val() || {};
    renderNotifications(notifs);
  });
}

// ===== NOTIFICATIONS =====
function renderNotifications(notifs) {
  const entries = Object.entries(notifs).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  const unread = entries.filter(([_, n]) => !n.read);
  const badge = document.getElementById('notifBadge');
  const panel = document.getElementById('notifPanel');

  // Update badge count
  if (unread.length > 0) {
    badge.textContent = unread.length;
    badge.style.display = 'flex';
    // PWA badge
    if ('setAppBadge' in navigator) navigator.setAppBadge(unread.length).catch(() => {});
  } else {
    badge.style.display = 'none';
    if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
  }

  // Render panel content
  if (!entries.length) {
    panel.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }
  panel.innerHTML = entries.slice(0, 20).map(([id, n]) => {
    const time = n.createdAt ? new Date(n.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    const comment = n.comment ? `<div class="notif-comment">"${n.comment}"</div>` : '';
    return `<div class="notif-item ${n.read ? '' : 'unread'}" data-notif-id="${id}" data-event-id="${n.eventId || ''}" data-venue-key="${n.venueKey || ''}" data-venue="${n.venue || ''}">
      <div class="notif-message">${n.message}</div>
      ${comment}
      <div class="notif-time">${time ? 'sent ' + time : ''}</div>
    </div>`;
  }).join('');

  panel.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', async () => {
      const nid = item.dataset.notifId;
      // Mark as read
      await update(ref(db, 'notifications/' + currentUser + '/' + nid), { read: true });
      closeNotifPanel();
      // Navigate to event if available, otherwise venue
      const eventId = item.dataset.eventId;
      if (eventId && allEvents[eventId]) {
        openEventDetail(eventId);
      } else {
        const venueName = item.dataset.venue;
        if (venueName) openProfile('venue', venueName);
      }
    });
  });
}

function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  panel.classList.toggle('active');
}
function closeNotifPanel() {
  document.getElementById('notifPanel').classList.remove('active');
}

document.getElementById('notifBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNotifPanel();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) {
    closeNotifPanel();
  }
});

// ===== SWIPE HELPERS =====
function closeAllSwipes() {
  document.querySelectorAll('.swipe-container.swiped').forEach(c => {
    c.classList.remove('swiped');
    const card = c.querySelector('.swipe-card');
    if (card) { card.style.transition = 'transform 0.25s ease'; card.style.transform = 'translateX(0)'; }
  });
}

// Close swipes on scroll
window.addEventListener('scroll', closeAllSwipes, { passive: true });

function hintSwipe(list) {
  const firstCard = list.querySelector('.swipe-card');
  if (!firstCard || firstCard.classList.contains('swipe-hint-done')) return;
  firstCard.classList.add('swipe-hint');
  firstCard.addEventListener('animationend', () => {
    firstCard.classList.remove('swipe-hint');
    firstCard.classList.add('swipe-hint-done');
  }, { once: true });
}

function bindSwipe(list) {
  list.querySelectorAll('.swipe-container').forEach(container => {
    const card = container.querySelector('.swipe-card');
    let startX = 0, currentX = 0, swiping = false;
    card.addEventListener('touchstart', e => {
      closeAllSwipes();
      startX = e.touches[0].clientX;
      currentX = 0;
      swiping = true;
      card.style.transition = 'none';
    });
    card.addEventListener('touchmove', e => {
      if (!swiping) return;
      currentX = e.touches[0].clientX - startX;
      if (currentX < 0) card.style.transform = `translateX(${Math.max(currentX, -180)}px)`;
    });
    card.addEventListener('touchend', () => {
      swiping = false;
      card.style.transition = 'transform 0.25s ease';
      if (currentX < -60) {
        card.style.transform = 'translateX(-180px)';
        container.classList.add('swiped');
      } else {
        card.style.transform = 'translateX(0)';
        container.classList.remove('swiped');
      }
    });
    card.addEventListener('click', () => {
      if (!container.classList.contains('swiped')) openEventDetail(container.dataset.id);
    });
  });
}

// ===== FEED =====
document.getElementById('feedFilterRow').addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  feedPersonFilter = chip.dataset.filter;
  renderFeed();
});
document.querySelectorAll('.type-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.type-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    feedTypeFilter = chip.dataset.type;
    renderFeed();
  });
});

document.getElementById('feedSortBtn').addEventListener('click', () => {
  const btn = document.getElementById('feedSortBtn');
  const sorts = ['date', 'best', 'worst'];
  const labels = { date: 'Latest', best: 'Best', worst: 'Worst' };
  const i = (sorts.indexOf(feedSort) + 1) % sorts.length;
  feedSort = sorts[i];
  btn.textContent = labels[feedSort];
  btn.dataset.sort = feedSort;
  renderFeed();
});
document.getElementById('feedSearch').addEventListener('input', renderFeed);
document.getElementById('upcomingSearch').addEventListener('input', renderUpcoming);
document.getElementById('suggestedSearch').addEventListener('input', renderSuggested);

function renderFeed() {
  const list = document.getElementById('feedList');
  const feedQ = (document.getElementById('feedSearch')?.value || '').toLowerCase();
  const events = Object.entries(allEvents)
    .filter(([_, e]) => e.status === 'Past')
    .filter(([_, e]) => feedTypeFilter === 'all' || e.type === feedTypeFilter)
    .filter(([_, e]) => {
      if (feedPersonFilter === 'all') return true;
      if (feedPersonFilter.startsWith('group-')) {
        const gIdx = parseInt(feedPersonFilter.split('-')[1]);
        const members = GROUPS[gIdx] || [];
        return e.attendees && members.some(u => e.attendees[u]);
      }
      return e.attendees && e.attendees[feedPersonFilter];
    })
    .filter(([_, e]) => !feedQ || (e.artist || '').toLowerCase().includes(feedQ) || (e.venue || '').toLowerCase().includes(feedQ))
    .sort((a, b) => {
      if (feedSort === 'best') {
        return (avgRating(b[1].ratings) ?? -1) - (avgRating(a[1].ratings) ?? -1);
      } else if (feedSort === 'worst') {
        return (avgRating(a[1].ratings) ?? 99) - (avgRating(b[1].ratings) ?? 99);
      }
      return (b[1].date || '').localeCompare(a[1].date || '');
    });

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
  const { detailed, summary } = getVisibleRatings(e.ratings, currentUser);
  const ratingPills = detailed
    .map(r => `<span class="rating-pill"><span class="rp-name">${r.name}</span><span class="rp-stars">${r.value >= 1 ? r.value + '/10' : '—'}</span></span>`)
    .join('')
    + (summary ? `<span class="rating-pill rating-pill-summary"><span class="rp-name">${summary.count} other${summary.count > 1 ? 's' : ''}</span><span class="rp-stars">${summary.avg} avg</span></span>` : '');

  return `
    <div class="event-card" data-id="${id}">
      <div class="event-top">
        <div class="event-top-left">
          <div class="event-artist">${e.artist || 'Unknown'}</div>
          <div class="event-venue">${e.venue || ''}</div>
        </div>
        ${avg != null ? `<div class="event-score">${avg.toFixed(1)}</div>` : ''}
      </div>
      <div class="event-meta">
        <span class="event-date">${formatDate(e.date)}</span>
        <span class="event-type-badge">${typeEmoji(e.type)} ${e.type}</span>
      </div>
      <div class="event-meta">
        <div class="event-ratings">${ratingPills}</div>
      </div>
      ${(() => { const dn = displayNotes(e.artistNotes, currentUser) || (typeof e.notes === 'string' ? e.notes : ''); return dn ? `<div class="event-notes">${dn}</div>` : ''; })()}
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
  const upQ = (document.getElementById('upcomingSearch')?.value || '').toLowerCase();
  const events = Object.entries(allEvents)
    .filter(([id, e]) => e.status === 'Booked' || e.status === 'Interested' || (e.status === 'Suggested' && recentlySuggested.has(id)))
    .filter(([_, e]) => upcomingStatusFilter === 'all' || e.status === upcomingStatusFilter)
    .filter(([_, e]) => !upQ || (e.artist || '').toLowerCase().includes(upQ) || (e.venue || '').toLowerCase().includes(upQ))
    .sort((a, b) => {
      // Booked before Interested
      const statusOrder = { Booked: 0, Interested: 1, Suggested: 2 };
      const sa = statusOrder[a[1].status] ?? 9, sb = statusOrder[b[1].status] ?? 9;
      if (sa !== sb) return sa - sb;
      // Events with dates before those without
      const aHas = a[1].date ? 0 : 1, bHas = b[1].date ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return (a[1].date || '').localeCompare(b[1].date || '');
    });

  if (!events.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎟</div><div class="empty-state-text">Nothing upcoming yet.<br>Add something you're interested in.</div></div>`;
    return;
  }
  list.innerHTML = events.map(([id, e]) => upcomingCardHtml(id, e)).join('');

  bindSwipe(list);

  // Action buttons
  list.querySelectorAll('.swipe-booked').forEach(btn => {
    btn.addEventListener('click', async () => {
      await update(ref(db, 'events/' + btn.dataset.id), { status: 'Booked' });
    });
  });
  list.querySelectorAll('.swipe-seen').forEach(btn => {
    btn.addEventListener('click', async () => {
      await update(ref(db, 'events/' + btn.dataset.id), { status: 'Past' });
    });
  });
  list.querySelectorAll('.swipe-full').forEach(btn => {
    btn.addEventListener('click', async () => {
      await remove(ref(db, 'events/' + btn.dataset.id));
    });
  });
  list.querySelectorAll('.upcoming-interest-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const isInterested = btn.classList.contains('Interested');
      if (isInterested) {
        recentlySuggested.add(id);
        btn.textContent = 'Suggested';
        btn.classList.remove('Interested');
        btn.classList.add('Suggested');
        await update(ref(db, 'events/' + id), { status: 'Suggested' });
      } else {
        recentlySuggested.delete(id);
        btn.textContent = 'Interested';
        btn.classList.remove('Suggested');
        btn.classList.add('Interested');
        await update(ref(db, 'events/' + id), { status: 'Interested' });
      }
    });
  });
  hintSwipe(list);
}

function upcomingCardHtml(id, e) {
  return `
    <div class="swipe-container" data-id="${id}">
      <div class="swipe-actions">
        <button class="swipe-btn swipe-booked" data-id="${id}"><span class="swipe-icon">🎟</span>Booked</button>
        <button class="swipe-btn swipe-seen" data-id="${id}"><span class="swipe-icon">✓</span>Seen</button>
        <button class="swipe-btn swipe-full" data-id="${id}"><span class="swipe-icon">✕</span>Full</button>
      </div>
      <div class="event-card swipe-card" data-id="${id}">
        <div class="event-top">
          <div>
            <div class="event-artist">${e.artist || 'Unknown'}</div>
            <div class="event-venue">${e.venue || ''}</div>
          </div>
          ${e.status === 'Interested' || (e.status === 'Suggested' && recentlySuggested.has(id))
            ? `<button class="status-badge ${e.status} upcoming-interest-toggle" data-id="${id}">${e.status}</button>`
            : `<span class="status-badge ${e.status}">${e.status}</span>`}
        </div>
        <div class="event-meta">
          <span class="event-date">${formatDate(e.date)}</span>
          <span class="event-type-badge">${typeEmoji(e.type)} ${e.type}</span>
          ${e.artist ? `<span class="search-links">${e.type === 'Music' || e.type === 'Classical' || e.type === 'Festival'
            ? (musicPlayer === 'spotify'
              ? `<a href="https://open.spotify.com/search/${encodeURIComponent(searchArtist(e))}" target="_blank" class="search-link" onclick="event.stopPropagation();">Play</a>`
              : `<a href="https://music.apple.com/search?term=${encodeURIComponent(searchArtist(e))}" target="_blank" class="search-link" onclick="event.stopPropagation();">Play</a>`)
            : `<a href="https://www.youtube.com/results?search_query=${encodeURIComponent(e.artist)}" target="_blank" class="search-link" onclick="event.stopPropagation();">Watch</a>`
          }${(() => { const bUrl = e.bookingUrl || (e.venue ? (allVenues[e.venue.replace(/[.#$/[\]]/g, '_')]?.bookingUrl || '') : ''); return bUrl ? ` <a href="${bUrl}" target="_blank" class="booking-link" onclick="event.stopPropagation();">Book</a>` : ''; })()}</span>` : ''}
        </div>
        ${e.status === 'Booked' && e.attendees ? `<div class="event-attendees">${Object.keys(e.attendees).map(u => USERS[u]?.name || u).join(', ')}</div>` : ''}
        ${e.suggestedTo?.[currentUser] ? `<div class="event-suggested-by">💡 ${USERS[e.suggestedTo[currentUser].by]?.name || 'Someone'} suggested this</div>` : ''}
        ${(() => { const dn = displayNotes(e.artistNotes, currentUser) || (typeof e.notes === 'string' ? e.notes : ''); return dn ? `<div class="event-notes">${dn}</div>` : ''; })()}
      </div>
    </div>`;
}

// ===== SUGGESTED =====
let suggestedTypeFilter = 'all';
let recentlyInterested = new Set();
let lastSeenSuggested = 0;
document.querySelectorAll('.suggested-type-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.suggested-type-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    suggestedTypeFilter = chip.dataset.stype;
    renderSuggested();
  });
});

function renderSuggested() {
  const list = document.getElementById('suggestedList');
  const sugQ = (document.getElementById('suggestedSearch')?.value || '').toLowerCase();
  const events = Object.entries(allEvents)
    .filter(([id, e]) => e.status === 'Suggested' || (e.status === 'Interested' && recentlyInterested.has(id)))
    .filter(([_, e]) => suggestedSource === 'mine' ? (e.scannedBy === currentUser) : (!e.scannedBy || e.scannedBy === currentUser || allUserPrefs[e.scannedBy]?.shareSuggestions !== 'private'))
    .filter(([_, e]) => suggestedTypeFilter === 'all' || e.type === suggestedTypeFilter)
    .filter(([_, e]) => !sugQ || (e.artist || '').toLowerCase().includes(sugQ) || (e.venue || '').toLowerCase().includes(sugQ))
    .sort((a, b) => {
      const aHas = a[1].date ? 0 : 1, bHas = b[1].date ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return (a[1].date || '').localeCompare(b[1].date || '');
    });

  if (!events.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">✦</div><div class="empty-state-text">No suggestions yet.<br>As we learn your tastes, events will appear here.</div></div>`;
    return;
  }
  list.innerHTML = events.map(([id, e]) => `
    <div class="swipe-container" data-id="${id}">
      <div class="swipe-actions">
        <button class="swipe-btn swipe-interested" data-id="${id}"><span class="swipe-icon">★</span>Want</button>
        <button class="swipe-btn swipe-booked" data-id="${id}"><span class="swipe-icon">🎟</span>Book</button>
        <button class="swipe-btn swipe-dismiss" data-id="${id}"><span class="swipe-icon">✕</span>Skip</button>
      </div>
      <div class="event-card swipe-card" data-id="${id}">
        <div class="event-top">
          <div>
            <div class="event-artist">${e.createdAt > lastSeenSuggested ? '<span class="new-dot"></span>' : ''}${e.artist || 'Unknown'}</div>
            <div class="event-venue">${e.venue || ''}</div>
          </div>
          <button class="status-badge ${e.status} suggested-toggle" data-id="${id}">${e.status}</button>
        </div>
        <div class="event-meta">
          <span class="event-date">${formatDate(e.date)}</span>
          <span class="event-type-badge">${typeEmoji(e.type)} ${e.type}</span>
          ${e.artist ? `<span class="search-links">${e.type === 'Music' || e.type === 'Classical' || e.type === 'Festival'
            ? (musicPlayer === 'spotify'
              ? `<a href="https://open.spotify.com/search/${encodeURIComponent(searchArtist(e))}" target="_blank" class="search-link">Play</a>`
              : `<a href="https://music.apple.com/search?term=${encodeURIComponent(searchArtist(e))}" target="_blank" class="search-link">Play</a>`)
            : `<a href="https://www.youtube.com/results?search_query=${encodeURIComponent(e.artist)}" target="_blank" class="search-link">Watch</a>`
          }${(() => { const bUrl = e.bookingUrl || (e.venue ? (allVenues[e.venue.replace(/[.#$/[\]]/g, '_')]?.bookingUrl || '') : ''); return bUrl ? ` <a href="${bUrl}" target="_blank" class="booking-link" onclick="event.stopPropagation();">Book</a>` : ''; })()}</span>` : ''}
        </div>
        ${(() => { const dn = displayNotes(e.artistNotes, currentUser) || (typeof e.notes === 'string' ? e.notes : ''); return dn ? `<div class="ai-summary"><span class="ai-summary-label">✦ Why this</span>${dn}</div>` : ''; })()}
      </div>
    </div>`).join('');

  bindSwipe(list);

  // Tap badge to flip to Interested
  list.querySelectorAll('.suggested-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      recentlyInterested.add(id);
      const isSuggested = btn.classList.contains('Suggested');
      if (isSuggested) {
        recentlyInterested.add(id);
        btn.textContent = 'Interested';
        btn.classList.remove('Suggested');
        btn.classList.add('Interested');
        await update(ref(db, 'events/' + id), { status: 'Interested' });
      } else {
        recentlyInterested.delete(id);
        btn.textContent = 'Suggested';
        btn.classList.remove('Interested');
        btn.classList.add('Suggested');
        await update(ref(db, 'events/' + id), { status: 'Suggested' });
      }
    });
  });

  list.querySelectorAll('.swipe-interested').forEach(btn => {
    btn.addEventListener('click', async () => { await update(ref(db, 'events/' + btn.dataset.id), { status: 'Interested' }); });
  });
  list.querySelectorAll('.swipe-booked').forEach(btn => {
    btn.addEventListener('click', async () => { await update(ref(db, 'events/' + btn.dataset.id), { status: 'Booked' }); });
  });
  list.querySelectorAll('.swipe-dismiss').forEach(btn => {
    btn.addEventListener('click', async () => { if (confirm('Dismiss this suggestion?')) await remove(ref(db, 'events/' + btn.dataset.id)); });
  });
  hintSwipe(list);
}

// ===== ARTISTS =====
let artistSort = 'alpha';
let showTypeFilter = 'all';
document.getElementById('artistSearch').addEventListener('input', renderArtists);
document.getElementById('artistSortBtn').addEventListener('click', () => {
  const btn = document.getElementById('artistSortBtn');
  const sorts = ['alpha', 'best', 'worst', 'bookable'];
  const labels = { alpha: 'A-Z', best: 'Best', worst: 'Worst', bookable: 'Bookable' };
  const i = (sorts.indexOf(artistSort) + 1) % sorts.length;
  artistSort = sorts[i];
  btn.textContent = labels[artistSort];
  btn.dataset.sort = artistSort;
  renderArtists();
});
document.querySelectorAll('.show-type-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.show-type-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    showTypeFilter = chip.dataset.showtype;
    renderArtists();
  });
});

function renderArtists() {
  const q = document.getElementById('artistSearch').value.toLowerCase();
  const list = document.getElementById('artistList');
  const today = new Date().toISOString().split('T')[0];

  // Stats from past events
  const stats = {};
  Object.values(allEvents).forEach(e => {
    if (!e.artist || e.status !== 'Past') return;
    if (!stats[e.artist]) stats[e.artist] = { count: 0, total: 0, ratings: [], types: {}, seeAgain: false };
    stats[e.artist].count++;
    if (typeof e.seeAgain === 'object' ? e.seeAgain?.[currentUser] : e.seeAgain) stats[e.artist].seeAgain = true;
    if (e.type) stats[e.artist].types[e.type] = (stats[e.artist].types[e.type] || 0) + 1;
    const avg = avgRating(e.ratings);
    if (avg) { stats[e.artist].total += avg; stats[e.artist].ratings.push(avg); }
  });

  // Check which artists have current/upcoming events (now on in London)
  const nowOn = {};
  Object.values(allEvents).forEach(e => {
    if (!e.artist || e.status === 'Past') return;
    // Any non-past event (Booked, Interested, Suggested) means it's on
    if (!nowOn[e.artist]) nowOn[e.artist] = { venue: e.venue, date: e.date };
  });

  const allArtistNames = new Set(Object.keys(stats));
  let filtered = [...allArtistNames].filter(n => !q || n.toLowerCase().includes(q));

  // Type filter
  if (showTypeFilter === 'now') {
    filtered = filtered.filter(name => nowOn[name]);
  } else if (showTypeFilter !== 'all') {
    filtered = filtered.filter(name => {
      const types = stats[name]?.types || {};
      return types[showTypeFilter] > 0;
    });
  }

  // Build bookable info from cached results + heuristic
  const bookable = {};
  const toCheck = [];
  Object.values(allEvents).forEach(e => {
    if (!e.artist || e.status === 'Past') return;
    const key = e.artist.replace(/[.#$/[\]]/g, '_');
    const artistRec = allArtists[key];
    // Use cached result if fresh (within 7 days)
    if (artistRec?.bookableChecked && Date.now() - artistRec.bookableChecked < 7 * 86400000) {
      if (artistRec.bookable) bookable[e.artist] = true;
      return;
    }
    // If cached as not bookable and date has passed, skip
    if (artistRec?.bookable === false && e.date && e.date < today) return;
    const bUrl = e.bookingUrl || (e.venue ? (allVenues[e.venue.replace(/[.#$/[\]]/g, '_')]?.bookingUrl || '') : '');
    if (bUrl && (!e.date || e.date >= today)) {
      bookable[e.artist] = true;
      // Queue for LLM check if not recently checked
      if (!artistRec?.bookableChecked || Date.now() - artistRec.bookableChecked > 7 * 86400000) {
        toCheck.push({ artist: e.artist, venue: e.venue, date: e.date, bookingUrl: bUrl });
      }
    }
  });
  // Trigger background LLM checks when bookable sort is active
  if (artistSort === 'bookable' && toCheck.length) {
    toCheck.slice(0, 5).forEach(ev => {
      fetch('/.netlify/functions/check-bookable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev)
      }).catch(() => {});
    });
  }

  if (artistSort === 'best') {
    filtered.sort((a, b) => {
      const avgA = stats[a]?.ratings.length ? stats[a].ratings.reduce((x,y)=>x+y,0)/stats[a].ratings.length : -1;
      const avgB = stats[b]?.ratings.length ? stats[b].ratings.reduce((x,y)=>x+y,0)/stats[b].ratings.length : -1;
      return avgB - avgA;
    });
  } else if (artistSort === 'worst') {
    filtered.sort((a, b) => {
      const avgA = stats[a]?.ratings.length ? stats[a].ratings.reduce((x,y)=>x+y,0)/stats[a].ratings.length : 99;
      const avgB = stats[b]?.ratings.length ? stats[b].ratings.reduce((x,y)=>x+y,0)/stats[b].ratings.length : 99;
      return avgA - avgB;
    });
  } else if (artistSort === 'bookable') {
    filtered.sort((a, b) => {
      const aBook = bookable[a] ? 0 : 1;
      const bBook = bookable[b] ? 0 : 1;
      if (aBook !== bBook) return aBook - bBook;
      return a.localeCompare(b);
    });
  } else {
    filtered.sort();
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎵</div><div class="empty-state-text">No shows yet.</div></div>`;
    return;
  }

  list.innerHTML = filtered.map(name => {
    const s = stats[name] || { count: 0, ratings: [], types: {} };
    const avg = s.ratings.length ? (s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length).toFixed(1) : null;
    const topType = Object.entries(s.types).sort((a,b) => b[1] - a[1])[0]?.[0] || 'Other';
    const on = nowOn[name];
    return `
      <div class="profile-card" data-name="${name}" data-kind="artist">
        <div class="profile-avatar type-icon">${typeEmoji(topType)}</div>
        <div class="profile-info">
          <div class="profile-name">${name}${on ? '<span class="now-on-dot" title="On now in London"></span>' : ''}</div>
          <div class="profile-sub">${s.count} event${s.count !== 1 ? 's' : ''}${on ? ` · <span class="now-on-venue">${on.venue || 'London'}</span>` : ''}${bookable[name] ? ' · <span class="bookable-badge">Bookable</span>' : ''}</div>
        </div>
        <div class="profile-score">
          ${s.seeAgain ? `<span class="see-again-badge" title="Would see again">↻</span>` : ''}
          ${avg ? `<div class="profile-avg-num">${avg}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', () => openProfile('artist', card.dataset.name));
  });
}

// ===== VENUES =====
let venueSort = 'alpha';
document.getElementById('venueSearch').addEventListener('input', renderVenues);
document.getElementById('venueSortBtn').addEventListener('click', () => {
  const btn = document.getElementById('venueSortBtn');
  const sorts = ['alpha', 'visits'];
  const labels = { alpha: 'A-Z', visits: 'Visits' };
  const i = (sorts.indexOf(venueSort) + 1) % sorts.length;
  venueSort = sorts[i];
  btn.textContent = labels[venueSort];
  btn.dataset.sort = venueSort;
  renderVenues();
});

function renderVenues() {
  const q = document.getElementById('venueSearch').value.toLowerCase();
  const list = document.getElementById('venueList');

  const stats = {};
  Object.values(allEvents).forEach(e => {
    if (!e.venue || e.status !== 'Past') return;
    if (!stats[e.venue]) stats[e.venue] = { count: 0, myCount: 0, notes: [] };
    stats[e.venue].count++;
    if (e.attendees && e.attendees[currentUser]) stats[e.venue].myCount++;
    const note = displayNotes(e.venueNotes, currentUser);
    if (note) stats[e.venue].notes.push(note);
  });

  const allVenueNames = new Set(Object.keys(stats));
  // Include venues from /venues collection (e.g. manually added venues with no events yet)
  Object.values(allVenues).forEach(v => { if (v.name) allVenueNames.add(v.name); });
  let filtered = [...allVenueNames].filter(n => !q || n.toLowerCase().includes(q));
  if (venueSort === 'visits') {
    filtered.sort((a, b) => (stats[b]?.myCount || 0) - (stats[a]?.myCount || 0) || (stats[b]?.count || 0) - (stats[a]?.count || 0));
  } else {
    filtered.sort();
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📍</div><div class="empty-state-text">No venues yet.</div></div>`;
    return;
  }

  list.innerHTML = filtered.map(name => {
    const s = stats[name] || { count: 0, myCount: 0, notes: [] };
    let venueKey = name.replace(/[.#$/[\]]/g, '_');
    // Find venue record by key or by matching name (handles space vs underscore)
    let venueRecord = allVenues[venueKey];
    if (!venueRecord) { const found = Object.entries(allVenues).find(([_, v]) => v.name === name); if (found) { venueKey = found[0]; venueRecord = found[1]; } }
    const aiSummary = venueRecord?.aiSummary || '';
    const snippet = aiSummary || (s.notes.length ? s.notes[0] : '');
    const truncated = snippet.length > 80 ? snippet.slice(0, 80) + '…' : snippet;
    const venueAddr = venueRecord?.address || '';
    const hasQuery = venueRecord?.addressQueried;
    const mapsQuery = venueAddr || (name + ', London');
    const mapsUrl = mapApp === 'google'
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`
      : `https://maps.apple.com/?q=${encodeURIComponent(mapsQuery)}`;
    return `
      <div class="profile-card ${hasQuery ? 'venue-queried' : ''}" data-name="${name}" data-kind="venue">
        <a href="${mapsUrl}" target="_blank" class="profile-avatar venue-map-link" style="border-radius:8px;" title="Get directions" onclick="event.stopPropagation();">📍</a>
        <div class="profile-info">
          <div class="profile-name">${name}${hasQuery ? ' <span class="query-indicator">?</span>' : ''}</div>
          ${truncated ? `<div class="profile-snippet">${truncated}</div>` : ''}
        </div>
        <div class="profile-count-badge">${s.myCount}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', () => openProfile('venue', card.dataset.name));
  });
}

// ===== COMMUNITY TAB =====
function renderCommunity() {
  const list = document.getElementById('communityList');
  if (!list) return;

  // Compute scores for each non-hidden user
  const scores = [];
  for (const [userId, user] of Object.entries(USERS)) {
    if (user.hidden) continue;
    const prefs = allUserPrefs[userId] || {};

    // Count shared subscriptions
    let subscriptions = 0;
    for (const val of Object.values(prefs.watchSenders || {})) {
      const entry = typeof val === 'string' ? {} : val;
      if (entry.enabled !== false && entry.shared !== false) subscriptions++;
    }
    for (const val of Object.values(prefs.ticketSenders || {})) {
      const entry = typeof val === 'string' ? {} : val;
      if (entry.enabled !== false && entry.shared !== false) subscriptions++;
    }

    // Count ratings, comments, and events attended from event data
    let ratings = 0;
    let comments = 0;
    let attended = 0;
    let added = 0;
    for (const e of Object.values(allEvents)) {
      if (e.ratings?.[userId]) ratings++;
      if (e.notes && typeof e.notes === 'object' && e.notes[userId]) comments++;
      else if (e.personalNotes && typeof e.personalNotes === 'object' && e.personalNotes[userId]) comments++;
      if (e.status === 'Past' && e.attendees?.[userId]) attended++;
      if (e.addedBy === userId) added++;
    }

    // Weighted score
    const score = (subscriptions * 5) + (ratings * 2) + (comments * 3) + (attended * 1) + (added * 2);

    // Determine level
    let level, levelClass;
    if (score >= 100) { level = 'Impresario'; levelClass = 'impresario'; }
    else if (score >= 40) { level = 'Patron'; levelClass = 'patron'; }
    else if (score >= 15) { level = 'Critic'; levelClass = 'critic'; }
    else { level = 'Audience'; levelClass = 'audience'; }

    scores.push({ userId, name: user.name, initial: user.initial, score, level, levelClass, subscriptions, ratings, comments, attended, added });
  }

  scores.sort((a, b) => b.score - a.score);

  const avatarColors = ['#c47b2b', '#7c5cbf', '#3b82f6', '#22c55e', '#ef4444', '#ec4899', '#f59e0b', '#06b6d4', '#8b5cf6', '#f97316', '#14b8a6'];

  list.innerHTML = `
    <div class="community-header">
      <h2>Community</h2>
      <p>Ranked by contributions — subscriptions, ratings, comments and events</p>
    </div>
    ${scores.map((s, i) => `
      <div class="community-card">
        <div class="community-rank">${i + 1}</div>
        <div class="community-avatar" style="background:${avatarColors[i % avatarColors.length]}22;color:${avatarColors[i % avatarColors.length]}">
          ${s.initial}
        </div>
        <div class="community-info">
          <div class="community-name">${s.name}</div>
          <div class="community-level ${s.levelClass}">${s.level}</div>
        </div>
        <div class="community-stats">
          <div class="community-stat"><span class="community-stat-val">${s.subscriptions}</span>subs</div>
          <div class="community-stat"><span class="community-stat-val">${s.ratings}</span>rated</div>
          <div class="community-stat"><span class="community-stat-val">${s.comments}</span>notes</div>
          <div class="community-stat"><span class="community-stat-val">${s.attended}</span>seen</div>
        </div>
      </div>
    `).join('')}
  `;
}

// ===== ADD EVENT MODAL =====
const fabBtn = document.getElementById('fabBtn');
const addModal = document.getElementById('addEventModal');
const closeAddModal = document.getElementById('closeAddModal');

fabBtn.addEventListener('click', () => {
  if (activeTab === 'venues') {
    document.getElementById('addVenueName').value = '';
    document.getElementById('addVenueAddress').value = '';
    document.getElementById('addVenueBookingUrl').value = '';
    document.getElementById('addVenueNotesInput').value = '';
    document.getElementById('saveNewVenueBtn').classList.remove('highlighted');
    openModal(document.getElementById('addVenueModal'));
  } else {
    resetForm();
    openModal(addModal);
  }
});
const eventFormFields = ['artistInput', 'venueInput', 'dateInput', 'artistNotesInput', 'personalNotesInput', 'venueNotesInput'];

function confirmCloseEventModal() {
  if (editingEventId && hasUnsavedChanges(...eventFormFields)) {
    if (!confirm('You have unsaved changes. Close without saving?')) return;
  }
  closeModal(addModal);
}
closeAddModal.addEventListener('click', confirmCloseEventModal);
addModal.addEventListener('click', e => { if (e.target === addModal) confirmCloseEventModal(); });

// ===== ADD VENUE MODAL =====
const addVenueModal = document.getElementById('addVenueModal');
document.getElementById('closeAddVenue').addEventListener('click', () => closeModal(addVenueModal));
addVenueModal.addEventListener('click', e => { if (e.target === addVenueModal) closeModal(addVenueModal); });

document.getElementById('addVenueName').addEventListener('input', function() {
  document.getElementById('saveNewVenueBtn').classList.toggle('highlighted', this.value.trim().length > 0);
});

document.getElementById('saveNewVenueBtn').addEventListener('click', async () => {
  const name = document.getElementById('addVenueName').value.trim();
  if (!name) return;
  const key = name.replace(/[.#$/[\]]/g, '_');
  const data = { name };
  const addr = document.getElementById('addVenueAddress').value.trim();
  const url = document.getElementById('addVenueBookingUrl').value.trim();
  const notes = document.getElementById('addVenueNotesInput').value.trim();
  if (addr) data.address = addr;
  if (url) data.bookingUrl = url;
  if (notes) data.notes = { [currentUser]: notes };
  await set(ref(db, 'venues/' + key), data);
  closeModal(addVenueModal);
});

// For new events, highlight save when artist has content
watchInputs('artistInput', 'saveEventBtn');
// For edits, also watch all fields for changes
eventFormFields.forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => {
    if (editingEventId) {
      const changed = hasUnsavedChanges(...eventFormFields);
      document.getElementById('saveEventBtn').classList.toggle('has-content', changed);
    }
  });
});

// Type selector
document.querySelectorAll('.type-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.type-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedType = btn.dataset.val;
  });
});

// Status selector (event form only — scoped to buttons with data-val)
document.querySelectorAll('.status-opt[data-val]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.status-opt[data-val]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedStatus = btn.dataset.val;
    toggleRatingsAttendees();
  });
});

function toggleRatingsAttendees() {
  const isPast = selectedStatus === 'Past';
  const isBooked = selectedStatus === 'Booked';
  document.getElementById('attendeesGroup').style.display = (isPast || isBooked) ? 'block' : 'none';
  document.getElementById('attendeesLabel').textContent = isPast ? 'Who attended' : 'Who\'s going';
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
      <div class="rating-num-input" data-user="${u}">
        <button class="rating-btn" data-rating="0">—</button>${[1,2,3,4,5,6,7,8,9,10].map(n => `<button class="rating-btn" data-rating="${n}">${n}</button>`).join('')}
      </div>
    </div>`).join('');

  container.querySelectorAll('.rating-num-input').forEach(input => {
    const u = input.dataset.user;
    // Restore existing rating selection
    if (ratings[u] != null && ratings[u] > 0) {
      input.querySelectorAll('.rating-btn').forEach(b => {
        b.classList.toggle('selected', parseInt(b.dataset.rating) === ratings[u]);
      });
    }
    input.querySelectorAll('.rating-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = parseInt(btn.dataset.rating);
        ratings[u] = val;
        input.querySelectorAll('.rating-btn').forEach(b => {
          b.classList.toggle('selected', parseInt(b.dataset.rating) === val);
        });
        if (editingEventId) {
          document.getElementById('saveEventBtn').classList.add('has-content');
        }
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
  const artistNotes = document.getElementById('artistNotesInput').value.trim();
  const personalNotes = document.getElementById('personalNotesInput').value.trim();
  const venueNotes = document.getElementById('venueNotesInput').value.trim();

  if (!artist) { alert('Please enter an artist or show name.'); return; }

  const eventData = {
    artist, venue, date,
    type: selectedType,
    status: selectedStatus,
    addedBy: currentUser,
    createdAt: Date.now()
  };

  // All notes stored per-user
  const existingEvent = editingEventId ? allEvents[editingEventId] : null;
  const mergedArtistNotes = mergeUserNote(existingEvent?.artistNotes, currentUser, artistNotes);
  const mergedVenueNotes = mergeUserNote(existingEvent?.venueNotes, currentUser, venueNotes);
  const mergedPersonalNotes = mergeUserNote(existingEvent?.personalNotes, currentUser, personalNotes);
  eventData.artistNotes = mergedArtistNotes;
  eventData.venueNotes = mergedVenueNotes;
  eventData.personalNotes = mergedPersonalNotes;

  if (selectedStatus === 'Past') {
    const attendeesObj = {};
    selectedAttendees.forEach(u => { attendeesObj[u] = true; });
    eventData.attendees = attendeesObj;

    const ratingsObj = {};
    selectedAttendees.forEach(u => { if (ratings[u] != null) ratingsObj[u] = ratings[u]; });
    eventData.ratings = ratingsObj;
  }

  // Ensure artist and venue records exist
  if (artist && !allArtists[artist]) {
    await set(ref(db, 'artists/' + artist.replace(/[.#$/[\]]/g, '_')), { name: artist, notes: '' });
  }
  if (venue && !allVenues[venue]) {
    await set(ref(db, 'venues/' + venue.replace(/[.#$/[\]]/g, '_')), { name: venue, notes: '' });
  }

  if (editingEventId) {
    // Clear old notes field when editing (migrated to per-user format)
    if (allEvents[editingEventId]?.notes) {
      eventData.notes = null;
    }
    await update(ref(db, 'events/' + editingEventId), eventData);
  } else {
    await push(ref(db, 'events'), eventData);
  }
  closeModal(addModal);
  resetForm();
});

function resetForm() {
  editingEventId = null;
  document.querySelector('.modal-title').textContent = 'Log Event';
  document.getElementById('saveEventBtn').textContent = 'Save Event';
  document.getElementById('artistInput').value = '';
  document.getElementById('venueInput').value = '';
  document.getElementById('dateInput').value = '';
  document.getElementById('artistNotesInput').value = '';
  document.getElementById('personalNotesInput').value = '';
  document.getElementById('venueNotesInput').value = '';
  document.getElementById('artistSuggestions').classList.remove('open');
  document.getElementById('venueSuggestions').classList.remove('open');
  selectedType = 'Music';
  selectedStatus = 'Past';
  selectedAttendees = [];
  ratings = { nick: 0, denise: 0, ben: 0, indi: 0, liz: 0, martin: 0, laura: 0, rory: 0, noelle: 0, dave: 0, linda: 0 };
  document.querySelectorAll('.type-opt').forEach(b => b.classList.toggle('active', b.dataset.val === 'Music'));
  document.querySelectorAll('.status-opt[data-val]').forEach(b => b.classList.toggle('active', b.dataset.val === 'Past'));
  document.querySelectorAll('.attendee-opt').forEach(b => b.classList.remove('active'));
  document.getElementById('ratingInputs').innerHTML = '';
  toggleRatingsAttendees();
}

function openEditEvent(id) {
  const e = allEvents[id];
  if (!e) return;
  editingEventId = id;

  // Close detail modal, open add/edit modal
  closeModal(document.getElementById('eventDetailModal'));

  // Set form title
  document.querySelector('#addEventModal .modal-title').textContent = 'Edit Event';
  document.getElementById('saveEventBtn').textContent = 'Update Event';

  // Populate fields
  document.getElementById('artistInput').value = e.artist || '';
  document.getElementById('venueInput').value = e.venue || '';
  document.getElementById('dateInput').value = e.date || '';
  document.getElementById('artistNotesInput').value = getUserNote(e.artistNotes, currentUser) || (typeof e.notes === 'string' ? e.notes : '') || '';
  document.getElementById('personalNotesInput').value = getUserNote(e.personalNotes, currentUser);
  document.getElementById('venueNotesInput').value = getUserNote(e.venueNotes, currentUser);

  // Type
  selectedType = e.type || 'Music';
  document.querySelectorAll('.type-opt').forEach(b => b.classList.toggle('active', b.dataset.val === selectedType));

  // Status
  selectedStatus = e.status || 'Past';
  document.querySelectorAll('.status-opt[data-val]').forEach(b => b.classList.toggle('active', b.dataset.val === selectedStatus));
  toggleRatingsAttendees();

  // Attendees
  selectedAttendees = Object.keys(e.attendees || {});
  document.querySelectorAll('.attendee-opt').forEach(b => {
    b.classList.toggle('active', selectedAttendees.includes(b.dataset.val));
  });

  // Ratings
  ratings = { nick: 0, denise: 0, ben: 0, indi: 0, liz: 0, martin: 0, laura: 0, rory: 0, noelle: 0, dave: 0, linda: 0 };
  Object.entries(e.ratings || {}).forEach(([u, v]) => { ratings[u] = v; });
  renderRatingInputs();

  // Highlight selected ratings
  document.querySelectorAll('.rating-num-input').forEach(input => {
    const u = input.dataset.user;
    if (ratings[u] != null) {
      input.querySelectorAll('.rating-btn').forEach(b => {
        b.classList.toggle('selected', parseInt(b.dataset.rating) === ratings[u]);
      });
    }
  });

  // Track originals for change detection
  eventFormFields.forEach(id => { _originals[id] = document.getElementById(id)?.value || ''; });
  document.getElementById('saveEventBtn').classList.remove('has-content');

  openModal(addModal);
}

// ===== EVENT DETAIL =====
function openEventDetail(id) {
  const e = allEvents[id];
  if (!e) return;
  document.getElementById('detailTitle').textContent = e.artist || 'Event';
  const body = document.getElementById('detailBody');

  const { detailed, summary } = getVisibleRatings(e.ratings, currentUser);
  const ratingRows = detailed
    .map(r => `<div class="detail-rating-row">
      <span class="detail-rating-name">${r.name}</span>
      <span class="detail-stars">${ratingHtml(r.value)}</span>
    </div>`).join('');
  const summaryRow = summary
    ? `<div class="detail-rating-row">
        <span class="detail-rating-name" style="color:var(--text-dim);font-style:italic">${summary.count} other${summary.count > 1 ? 's' : ''}</span>
        <span class="detail-stars" style="opacity:0.6">${ratingHtml(Math.round(parseFloat(summary.avg)))} <span style="font-size:0.75rem;color:var(--text-dim)">${summary.avg} avg</span></span>
      </div>`
    : '';

  const avg = avgRating(e.ratings);

  body.innerHTML = `
    <div class="detail-artist">${e.artist || ''}</div>
    <div class="detail-venue">${e.venue || ''}</div>
    <div class="detail-meta">${formatDate(e.date)} · ${typeEmoji(e.type)} ${e.type}${e.status !== 'Past' ? ' · <span class="status-badge ' + e.status + '">' + e.status + '</span>' : ''}</div>
    ${e.attendees ? `<div class="detail-attendees">${Object.keys(e.attendees).map(u => USERS[u]?.name || u).join(', ')}</div>` : ''}
    ${e.doorsOpen || e.startTime ? `<div class="detail-ticket-info">🕐 ${e.doorsOpen ? 'Doors ' + e.doorsOpen : ''}${e.doorsOpen && e.startTime ? ' · ' : ''}${e.startTime ? 'Start ' + e.startTime : ''}</div>` : ''}
    ${e.ticketInfo ? `<div class="detail-ticket-info">🎫 ${e.ticketInfo}</div>` : ''}
    ${e.status === 'Booked' && e.date ? `<div class="detail-calendar-row"><button class="detail-action-btn" id="addToCalendarBtn">📅 Add to Calendar</button></div>` : ''}
    ${e.status === 'Past' && (ratingRows || summaryRow) ? `<div class="detail-ratings">${ratingRows}${summaryRow}</div>` : ''}
    ${e.status === 'Past' ? (() => { const sa = typeof e.seeAgain === 'object' ? !!e.seeAgain?.[currentUser] : !!e.seeAgain; return `<div class="detail-score-row">${avg != null ? `<span class="detail-avg-score">${avg.toFixed(1)}</span>` : ''}<button class="see-again-btn ${sa ? 'see-again-active' : ''}" id="seeAgainBtn"><span class="see-again-icon">↻</span> ${sa ? 'Would see again' : 'See again?'}</button></div>`; })() : ''}
    ${e.tasteReason ? `<div class="divider"></div><div class="detail-notes-section"><div class="detail-notes-label">Why this suits you</div><div class="taste-reason">✦ ${e.tasteReason}</div></div>` : ''}
    ${(() => { const dn = displayNotes(e.artistNotes, currentUser) || (typeof e.notes === 'string' ? e.notes : ''); return dn ? `<div class="divider"></div><div class="detail-notes-section"><div class="detail-notes-label">About the artist / show</div><div class="detail-notes">${dn}</div></div>` : ''; })()}
    ${(() => {
      // Show personal notes from group members only
      const pn = e.personalNotes || {};
      const visible = Object.entries(pn).filter(([u]) => {
        if (!pn[u]) return false;
        if (u === currentUser) return true;
        if (!canSeeDetailedRating(currentUser, u)) return false;
        const prefs = allUserPrefs[u]?.shareComments || 'named';
        return prefs !== 'private';
      });
      if (!visible.length) return '';
      return '<div class="detail-notes-section"><div class="detail-notes-label">Personal notes</div>' +
        visible.map(([u, note]) => {
          const prefs = allUserPrefs[u]?.shareComments || 'named';
          const author = (u === currentUser || prefs === 'named') ? (USERS[u]?.name || u) : 'Someone';
          return `<div class="detail-personal-note"><span class="detail-note-author">${author}</span> ${note}</div>`;
        }).join('') +
        '</div>';
    })()}
    ${(() => { const dn = displayNotes(e.venueNotes, currentUser); return dn ? `<div class="detail-notes-section"><div class="detail-notes-label">About the venue</div><div class="detail-notes">${dn}</div></div>` : ''; })()}
    ${(e.status === 'Booked' || e.status === 'Interested' || e.status === 'Suggested') ? (() => {
      const suggestScope = allUserPrefs[currentUser]?.suggestScope || 'group';
      const shareSug = allUserPrefs[currentUser]?.shareSuggestions || 'share';
      if (shareSug === 'private') return '';
      const candidates = suggestScope === 'everyone' ? Object.keys(USERS) : getMyPeople(currentUser);
      const others = candidates.filter(u => u !== currentUser && !USERS[u]?.hidden);
      const already = e.suggestedTo || {};
      return `<div class="divider"></div><div class="detail-notes-section"><div class="detail-notes-label">Suggest to others</div>
        <div class="suggest-user-list">${others.map(u => {
          const done = already[u]?.by;
          return `<button class="suggest-user-btn ${done ? 'suggested' : ''}" data-user="${u}">${USERS[u]?.name || u}${done ? ' ✓' : ''}</button>`;
        }).join('')}</div></div>`;
    })() : ''}
    ${e.suggestedTo?.[currentUser] ? `<div class="detail-suggested-by">💡 Suggested by ${USERS[e.suggestedTo[currentUser].by]?.name || 'someone'}</div>` : ''}
    <div class="detail-actions">
      <button class="detail-action-btn" id="editFromDetail">Edit</button>
      ${isRealAdmin() ? `<button class="detail-action-btn danger" id="deleteEventBtn">Delete</button>` : ''}
    </div>`;

  // Track who we suggest to during this session
  const pendingSuggestions = [];

  openModal(document.getElementById('eventDetailModal'));

  document.getElementById('editFromDetail')?.addEventListener('click', () => {
    openEditEvent(id);
  });

  document.querySelectorAll('.suggest-user-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetUser = btn.dataset.user;
      if (btn.classList.contains('suggested')) return;
      pendingSuggestions.push(targetUser);
      await update(ref(db, 'events/' + id + '/suggestedTo/' + targetUser), { by: currentUser, at: Date.now() });
      btn.classList.add('suggested');
      btn.textContent = (USERS[targetUser]?.name || targetUser) + ' ✓';
    });
  });

  // Close detail modal — prompt for suggestion comment if suggestions were made
  const detailModal = document.getElementById('eventDetailModal');
  const closeDetail = async () => {
    if (pendingSuggestions.length > 0) {
      const ev = allEvents[id];
      const names = pendingSuggestions.map(u => USERS[u]?.name || u).join(', ');
      const comment = prompt(`Add a note with your suggestion to ${names}?\n(Leave blank to skip)`);
      const msgBase = `${USERS[currentUser]?.name || currentUser} suggested "${ev?.artist || 'an event'}"`;
      const msgDetail = ev?.venue ? ` at ${ev.venue}` : '';
      const msgComment = comment ? `\n"${comment}"` : '';
      for (const targetUser of pendingSuggestions) {
        await push(ref(db, 'notifications/' + targetUser), {
          type: 'suggestion',
          message: msgBase + msgDetail + msgComment,
          eventId: id,
          from: currentUser,
          comment: comment || '',
          createdAt: Date.now(),
          read: false
        });
      }
      pendingSuggestions.length = 0;
    }
    closeModal(detailModal);
  };
  document.getElementById('closeDetailModal').onclick = closeDetail;
  detailModal.onclick = (ev) => { if (ev.target === detailModal) closeDetail(); };

  document.getElementById('deleteEventBtn')?.addEventListener('click', async () => {
    if (confirm('Delete this event?')) {
      await remove(ref(db, 'events/' + id));
      pendingSuggestions.length = 0; // skip comment prompt
      closeModal(detailModal);
    }
  });

  document.getElementById('seeAgainBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('seeAgainBtn');
    const ev = allEvents[id];
    const saObj = typeof ev?.seeAgain === 'object' ? { ...ev.seeAgain } : {};
    const current = !!saObj[currentUser];
    if (current) { delete saObj[currentUser]; } else { saObj[currentUser] = true; }
    await update(ref(db, 'events/' + id), { seeAgain: Object.keys(saObj).length ? saObj : null });
    btn.innerHTML = `<span class="see-again-icon">↻</span> ${!current ? 'Would see again' : 'See again?'}`;
    btn.classList.toggle('see-again-active', !current);
  });

  document.getElementById('addToCalendarBtn')?.addEventListener('click', () => {
    const ev = allEvents[id];
    const dt = ev.date.replace(/-/g, '');
    const venueKey = ev.venue ? ev.venue.replace(/[.#$/[\]]/g, '_') : '';
    const location = allVenues[venueKey]?.address || ev.venue || '';
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
      `DTSTART;VALUE=DATE:${dt}`,
      `DTEND;VALUE=DATE:${dt}`,
      `SUMMARY:${(ev.artist || '').replace(/[,;]/g, ' ')}`,
      `LOCATION:${location.replace(/[,;]/g, ' ')}`,
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');
    const blob = new Blob([ics], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(ev.artist || 'event').replace(/[^a-zA-Z0-9]/g, '_')}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  });

}

// Detail modal close handlers are set per-open in openEventDetail()

// ===== PROFILE MODAL =====
function openProfile(kind, name) {
  document.getElementById('profileTitle').textContent = name;
  const body = document.getElementById('profileBody');

  const events = Object.entries(allEvents)
    .filter(([_, e]) => (kind === 'artist' ? e.artist === name : e.venue === name) && e.status === 'Past')
    .sort((a, b) => (b[1].date || '').localeCompare(a[1].date || ''));

  const allRatings = events.flatMap(([_, e]) => Object.values(e.ratings || {}).filter(v => v != null));
  const avg = allRatings.length ? (allRatings.reduce((a,b)=>a+b,0)/allRatings.length).toFixed(1) : null;

  // Venue visit counts: personal vs total
  const myVisits = kind === 'venue'
    ? events.filter(([_, e]) => e.attendees && e.attendees[currentUser]).length
    : 0;

  // Aggregate notes from events
  const notesList = events
    .map(([_, e]) => kind === 'artist' ? (displayNotes(e.artistNotes, currentUser) || (typeof e.notes === 'string' ? e.notes : '') || '') : (displayNotes(e.venueNotes, currentUser) || ''))
    .filter(n => n);
  const aggregatedNotes = notesList
    .map(n => `<div class="aggregated-note">${n}</div>`)
    .join('');

  let key = name.replace(/[.#$/[\]]/g, '_');
  // Find actual Firebase key for venues (may use underscores for spaces)
  const existingRecord = kind === 'artist'
    ? allArtists[key]
    : (allVenues[key] || (() => { const found = Object.entries(allVenues).find(([_, v]) => v.name === name); if (found) key = found[0]; return found?.[1]; })());
  const existingNotes = existingRecord?.notes
    ? (typeof existingRecord.notes === 'string' ? existingRecord.notes : (existingRecord.notes[currentUser] || ''))
    : '';
  // Other users' profile notes (visible based on sharing prefs)
  const othersProfileNotes = existingRecord?.notes && typeof existingRecord.notes === 'object'
    ? Object.entries(existingRecord.notes)
        .filter(([u, t]) => u !== currentUser && u !== 'unknown' && t && canSeeUserData(currentUser, u))
        .map(([u, t]) => `<div class="aggregated-note"><span style="color:var(--text-mid)">${USERS[u]?.name || u}:</span> ${t}</div>`)
        .join('')
    : '';
  const cachedSummary = existingRecord?.aiSummary || '';

  const profileHeaderHtml = kind === 'venue'
    ? `<div class="profile-header">
        <div class="profile-header-left">
          <div class="profile-avg">${myVisits}</div>
          <div class="profile-event-count">${myVisits !== 1 ? 'visits' : 'visit'}</div>
        </div>
        <div class="venue-photo-wrap" id="venuePhotoWrap">
          <div class="venue-photo-placeholder" id="venuePhotoMain">📷</div>
        </div>
      </div>`
    : `<div class="profile-header">
        <div class="profile-avg">${avg ? ratingHtml(Math.round(avg)) + ' ' + avg : '—'}</div>
        <div class="profile-event-count">${events.length} past event${events.length !== 1 ? 's' : ''}</div>
      </div>`;

  body.innerHTML = `
    ${profileHeaderHtml}
    ${kind === 'venue' ? `<div class="profile-notes-section">
      <div class="profile-notes-label">Venue name</div>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        <input type="text" class="form-input" id="venueNameEdit" value="${name}" style="margin-bottom:0;">
        <button class="save-notes-btn" id="saveVenueName" style="margin-top:0;white-space:nowrap;">Rename</button>
      </div>
    </div>` : ''}
    ${kind === 'venue' ? `<div class="profile-notes-section"><div class="profile-notes-label">AI Summary</div><div id="aiSummary" class="ai-summary">${cachedSummary ? cachedSummary.replace(/^#\s*Summary\s*/i, '') : '<span class="ai-summary-placeholder">No summary yet</span>'}</div><div style="display:flex;gap:0.5rem;"><button class="summarize-btn" id="generateSummary">✦ ${cachedSummary ? 'Regenerate' : 'Generate summary'}</button>${cachedSummary ? '<button class="summarize-btn" id="editAiSummary" style="background:var(--surface2);">Edit</button><button class="summarize-btn" id="deleteAiSummary" style="background:var(--surface2);color:var(--red);">Delete</button>' : ''}</div></div>` : ''}
    ${aggregatedNotes ? `<div class="profile-notes-section"><div class="profile-notes-label">${kind === 'artist' ? 'Commentary from events' : 'Venue notes from events'}</div>${aggregatedNotes}</div>` : ''}
    ${othersProfileNotes ? `<div class="profile-notes-section"><div class="profile-notes-label">Others' notes</div>${othersProfileNotes}</div>` : ''}
    <div class="profile-notes-section">
      <div class="profile-notes-label">Your notes on this ${kind}</div>
      <textarea class="profile-notes-input" id="profileNotesInput" rows="3" placeholder="e.g. Always sit in the balcony…">${existingNotes}</textarea>
      <button class="save-notes-btn" id="saveProfileNotes">Save notes</button>
    </div>
    ${kind === 'venue' ? (() => {
      const addr = existingRecord?.address || '';
      const addrSetBy = existingRecord?.addressSetBy || '';
      const addrLocked = addr && addrSetBy && addrSetBy !== currentUser && !isRealAdmin();
      return `<div class="profile-notes-section">
      <div class="profile-notes-label">Address${addrSetBy && USERS[addrSetBy] ? ` <span style="color:var(--text-dim);font-size:0.7rem;text-transform:none;">(set by ${USERS[addrSetBy].name})</span>` : ''}</div>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        <input type="text" class="form-input" id="venueAddress" placeholder="e.g. 47 Frith St, London W1D 4HT" value="${addr}" ${addrLocked ? 'readonly style="opacity:0.6;"' : ''}>
        ${addrLocked ? `<button class="query-addr-btn" id="queryAddressBtn" title="Question this address">?</button>` : ''}
      </div>
      ${addrLocked ? '' : '<button class="save-notes-btn" id="saveAddress">Save address</button>'}
    </div>`;
    })() : ''}
    ${kind === 'venue' ? `<div class="profile-notes-section">
      <div class="profile-notes-label">Booking website</div>
      <input type="url" class="form-input" id="venueBookingUrl" placeholder="e.g. https://www.ronniescotts.co.uk" value="${existingRecord?.bookingUrl || ''}">
      <button class="save-notes-btn" id="saveBookingUrl">Save booking URL</button>
    </div>` : ''}
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
          <div class="event-ratings">${(() => {
            const vis = getVisibleRatings(e.ratings, currentUser);
            return vis.detailed.map(r => `<span class="rating-pill"><span class="rp-name">${r.name}</span><span class="rp-stars">${r.value >= 1 ? r.value + '/10' : '—'}</span></span>`).join('')
              + (vis.summary ? `<span class="rating-pill rating-pill-summary"><span class="rp-name">${vis.summary.count} other${vis.summary.count>1?'s':''}</span><span class="rp-stars">${vis.summary.avg} avg</span></span>` : '');
          })()}</div>
        </div>
      </div>`).join('') || '<div style="color:var(--text-dim); font-size:0.85rem;">No past events logged.</div>'}`;

  body.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => {
      closeModal(document.getElementById('profileModal'));
      openEventDetail(card.dataset.id);
    });
  });

  watchChanges('profileNotesInput', 'saveProfileNotes');
  document.getElementById('saveProfileNotes').addEventListener('click', async () => {
    const newText = document.getElementById('profileNotesInput').value;
    const currentName = document.getElementById('venueNameEdit')?.value.trim() || name;
    const path = (kind === 'artist' ? 'artists/' : 'venues/') + key;
    // Migrate old string notes to per-user format
    const merged = mergeUserNote(existingRecord?.notes, currentUser, newText);
    await update(ref(db, path), { name: currentName, notes: merged });
    markSaved('profileNotesInput');
    document.getElementById('saveProfileNotes').classList.remove('has-content');
  });

  // Venue rename
  if (kind === 'venue') {
    watchChanges('venueNameEdit', 'saveVenueName');
    document.getElementById('saveVenueName').addEventListener('click', async () => {
      const newName = document.getElementById('venueNameEdit').value.trim();
      if (!newName) { alert('Venue name cannot be empty.'); return; }
      if (newName === name) return;
      if (!confirm(`Rename "${name}" to "${newName}"? This will update all events referencing this venue.`)) return;

      const btn = document.getElementById('saveVenueName');
      btn.disabled = true;
      btn.textContent = 'Renaming…';

      // Update all events that reference the old venue name
      const eventUpdates = {};
      Object.entries(allEvents).forEach(([id, e]) => {
        if (e.venue === name) eventUpdates['events/' + id + '/venue'] = newName;
      });
      if (Object.keys(eventUpdates).length) {
        await update(ref(db), eventUpdates);
      }

      // Create new venue record with new key, copy data
      const newKey = newName.replace(/[.#$/[\]]/g, '_');
      const venueData = { ...existingRecord, name: newName };
      await set(ref(db, 'venues/' + newKey), venueData);

      // Remove old venue record if key changed
      if (newKey !== key) {
        await remove(ref(db, 'venues/' + key));
      }

      // Update modal title and re-open profile
      closeModal(document.getElementById('profileModal'));
      openProfile('venue', newName);
    });
  }

  document.getElementById('saveAddress')?.addEventListener('click', async () => {
    const addr = document.getElementById('venueAddress').value.trim();
    await update(ref(db, 'venues/' + key), { address: addr, addressSetBy: currentUser });
    markSaved('venueAddress');
    document.getElementById('saveAddress').classList.remove('has-content');
  });
  if (document.getElementById('saveAddress')) watchChanges('venueAddress', 'saveAddress');

  // Query address button — sends notification to original setter + admin
  document.getElementById('queryAddressBtn')?.addEventListener('click', async () => {
    const addrSetBy = existingRecord?.addressSetBy || '';
    const notification = {
      type: 'address_query',
      venue: name,
      venueKey: key,
      queriedBy: currentUser,
      message: `${USERS[currentUser]?.name || currentUser} is questioning the address for ${name}`,
      createdAt: Date.now(),
      read: false
    };
    // Notify original setter
    if (addrSetBy) await push(ref(db, 'notifications/' + addrSetBy), notification);
    // Notify all admins
    Object.keys(adminUsers).forEach(async adminId => {
      if (adminId !== addrSetBy) await push(ref(db, 'notifications/' + adminId), notification);
    });
    // Flag venue as queried
    await update(ref(db, 'venues/' + key), { addressQueried: true });
    alert('Address query sent to ' + (USERS[addrSetBy]?.name || 'the user who set it') + ' and admin.');
  });

  document.getElementById('saveBookingUrl')?.addEventListener('click', async () => {
    const url = document.getElementById('venueBookingUrl').value.trim();
    await update(ref(db, 'venues/' + key), { bookingUrl: url });
    markSaved('venueBookingUrl');
    document.getElementById('saveBookingUrl').classList.remove('has-content');
  });
  watchChanges('venueBookingUrl', 'saveBookingUrl');

  document.getElementById('generateSummary')?.addEventListener('click', async () => {
    const btn = document.getElementById('generateSummary');
    const summaryEl = document.getElementById('aiSummary');
    btn.disabled = true;
    btn.textContent = '✦ Generating…';
    summaryEl.innerHTML = '<span class="ai-summary-placeholder">Thinking…</span>';
    try {
      const res = await fetch('/.netlify/functions/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notesList, type: kind, name })
      });
      const data = await res.json();
      if (data.summary) {
        summaryEl.textContent = data.summary;
        // Cache in Firebase
        await update(ref(db, (kind === 'artist' ? 'artists/' : 'venues/') + key), { aiSummary: data.summary });
      } else {
        summaryEl.innerHTML = '<span class="ai-summary-placeholder">Could not generate summary</span>';
      }
    } catch (err) {
      summaryEl.innerHTML = `<span class="ai-summary-placeholder">Error: ${err.message}</span>`;
    }
    btn.disabled = false;
    btn.textContent = '✦ Regenerate';
  });

  document.getElementById('deleteAiSummary')?.addEventListener('click', async () => {
    if (!confirm('Delete AI summary?')) return;
    await update(ref(db, (kind === 'artist' ? 'artists/' : 'venues/') + key), { aiSummary: null });
    document.getElementById('aiSummary').innerHTML = '<span class="ai-summary-placeholder">No summary yet</span>';
    document.getElementById('deleteAiSummary')?.remove();
    document.getElementById('editAiSummary')?.remove();
    document.getElementById('generateSummary').textContent = '✦ Generate summary';
  });

  document.getElementById('editAiSummary')?.addEventListener('click', () => {
    const summaryEl = document.getElementById('aiSummary');
    const current = summaryEl.textContent;
    summaryEl.innerHTML = `<textarea class="profile-notes-input" id="aiSummaryEdit" rows="4" style="width:100%;">${current}</textarea><button class="save-notes-btn" id="saveAiSummary" style="margin-top:0.4rem;">Save</button>`;
    document.getElementById('saveAiSummary').addEventListener('click', async () => {
      const newText = document.getElementById('aiSummaryEdit').value.trim();
      await update(ref(db, (kind === 'artist' ? 'artists/' : 'venues/') + key), { aiSummary: newText || null });
      summaryEl.textContent = newText || '';
      if (!newText) summaryEl.innerHTML = '<span class="ai-summary-placeholder">No summary yet</span>';
    });
  });

  openModal(document.getElementById('profileModal'));

  // Load venue photos
  if (kind === 'venue') {
    const cachedPhotos = existingRecord?.photos;
    const photoWrap = document.getElementById('venuePhotoWrap');
    const photoMain = document.getElementById('venuePhotoMain');
    if (cachedPhotos?.length) {
      renderVenuePhotos(photoMain, photoWrap, cachedPhotos);
    } else {
      // Fetch from API
      fetch('/.netlify/functions/venue-photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venue: name, address: existingRecord?.address || '' })
      }).then(r => r.json()).then(data => {
        if (data.photos?.length) {
          const urls = data.photos.map(p => p.url);
          renderVenuePhotos(photoMain, photoWrap, urls);
          // Cache photo URLs
          update(ref(db, 'venues/' + key), { photos: urls });
        }
      }).catch(() => {});
    }
  }
}

function renderVenuePhotos(mainEl, wrapEl, photos) {
  if (!photos?.length) return;
  mainEl.innerHTML = `<img src="${photos[0]}" alt="Venue photo" class="venue-photo-img">`;
  if (photos.length > 1) {
    mainEl.innerHTML += `<span class="venue-photo-count">${photos.length}</span>`;
    mainEl.style.cursor = 'pointer';
    mainEl.addEventListener('click', () => {
      showPhotoGallery(photos);
    });
  }
}

function showPhotoGallery(photos) {
  const overlay = document.createElement('div');
  overlay.className = 'photo-gallery-overlay';
  overlay.innerHTML = `
    <div class="photo-gallery-close">✕</div>
    <div class="photo-gallery-strip">
      ${photos.map((url, i) => `<img src="${url}" alt="Photo ${i+1}" class="photo-gallery-img">`).join('')}
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.photo-gallery-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function confirmCloseProfile() {
  if (hasUnsavedChanges('profileNotesInput', 'venueBookingUrl', 'venueAddress')) {
    if (!confirm('You have unsaved changes. Close without saving?')) return;
  }
  closeModal(document.getElementById('profileModal'));
}
document.getElementById('closeProfileModal').addEventListener('click', confirmCloseProfile);
document.getElementById('profileModal').addEventListener('click', e => {
  if (e.target === document.getElementById('profileModal')) confirmCloseProfile();
});

// ===== INFO DOTS =====
// Fade requires both: info read + control used
document.addEventListener('click', e => {
  const dot = e.target.closest('.info-dot');
  document.querySelectorAll('.info-dot.show-tip').forEach(d => { if (d !== dot) d.classList.remove('show-tip'); });
  if (dot) {
    e.preventDefault(); e.stopPropagation();
    dot.classList.toggle('show-tip');
    dot.dataset.read = 'true';
    if (dot.dataset.controlUsed) dot.classList.add('used');
  }
});
// Mark control as used when sibling controls are interacted with
document.getElementById('settingsBody').addEventListener('click', e => {
  const opt = e.target.closest('.status-opt');
  if (opt) {
    const group = opt.closest('.form-group') || opt.closest('.settings-section');
    if (group) group.querySelectorAll('.info-dot').forEach(d => {
      d.dataset.controlUsed = 'true';
      if (d.dataset.read) d.classList.add('used');
    });
  }
});

// ===== SETTINGS =====
const settingsModal = document.getElementById('settingsModal');

document.getElementById('settingsBtn').addEventListener('click', async () => {
  renderSettings();
  // Load user data into settings
  const userSnap = await get(ref(db, 'users/' + currentUser));
  const userData = userSnap.val() || {};
  document.getElementById('interestsInput').value = userData.interests || '';
  // Open interests folder only if empty
  const interestsFolder = document.getElementById('interestsFolder');
  interestsFolder.open = !(userData.interests || '').trim();
  document.getElementById('imapEmailInput').value = userData.imapEmail || '';
  document.getElementById('imapPasswordInput').value = (userData.imapPassword || userData.hasImapPassword) ? '••••••••' : '';
  // Set player toggle
  document.querySelectorAll('[data-player]').forEach(b => b.classList.toggle('active', b.dataset.player === (userData.musicPlayer || 'apple')));
  // Set source toggle
  document.querySelectorAll('[data-source]').forEach(b => b.classList.toggle('active', b.dataset.source === (userData.suggestedSource || 'everyone')));
  // Set sharing toggles
  document.querySelectorAll('[data-mapapp]').forEach(b => b.classList.toggle('active', b.dataset.mapapp === (userData.mapApp || 'apple')));
  document.querySelectorAll('[data-sharescope]').forEach(b => b.classList.toggle('active', b.dataset.sharescope === (userData.shareScope || 'group')));
  document.querySelectorAll('[data-commentattrib]').forEach(b => b.classList.toggle('active', b.dataset.commentattrib === (userData.commentAttrib || 'named')));
  document.querySelectorAll('[data-sharesug]').forEach(b => b.classList.toggle('active', b.dataset.sharesug === (userData.shareSuggestions || 'share')));
  document.querySelectorAll('[data-suggestscope]').forEach(b => b.classList.toggle('active', b.dataset.suggestscope === (userData.suggestScope || 'group')));
  // Dim suggest scope when finds are private
  const suggestGroup = document.getElementById('suggestScopeGroup');
  const isPrivateFinds = (userData.shareSuggestions || 'share') === 'private';
  if (suggestGroup) { suggestGroup.style.opacity = isPrivateFinds ? '0.4' : '1'; suggestGroup.style.pointerEvents = isPrivateFinds ? 'none' : 'auto'; }
  // Set provider toggle
  const provider = userData.emailProvider || 'icloud';
  document.querySelectorAll('[data-provider]').forEach(b => b.classList.toggle('active', b.dataset.provider === provider));
  document.getElementById('imapEmailInput').placeholder = provider === 'gmail' ? 'you@gmail.com' : 'you@icloud.com';
  renderSenders(userData.watchSenders || {}, userData.ticketSenders || {});
  renderCommunitySenders();
  // Show admin folder for real admin only (not impersonated)
  document.getElementById('adminFolder').style.display = isRealAdmin() ? 'block' : 'none';
  if (isRealAdmin()) renderAdminDashboard('month');
  openModal(settingsModal);
  watchChanges('interestsInput', 'saveInterests');
  watchChanges('imapEmailInput', 'saveImapCredentials');
});

// ===== ADMIN =====
let adminPeriod = 'month';
document.querySelectorAll('[data-period]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    adminPeriod = btn.dataset.period;
    renderAdminDashboard(adminPeriod);
  });
});

// Force refresh all users
document.getElementById('forceRefreshBtn').addEventListener('click', async () => {
  if (!confirm('This will reload the app for all users with it open. Continue?')) return;
  await set(ref(db, 'appVersion'), Date.now());
});

document.getElementById('clearSuggestionsBtn').addEventListener('click', async () => {
  const suggested = Object.entries(allEvents).filter(([_, e]) => e.status === 'Suggested');
  if (!suggested.length) { alert('No suggestions to clear.'); return; }
  if (!confirm(`Delete all ${suggested.length} suggested events? This can't be undone.`)) return;
  const btn = document.getElementById('clearSuggestionsBtn');
  btn.disabled = true;
  btn.textContent = 'Clearing…';
  await Promise.all(suggested.map(([id]) => remove(ref(db, 'events/' + id))));
  btn.disabled = false;
  btn.textContent = '✕ Clear All Suggestions';
  alert(`Cleared ${suggested.length} suggestions. Run a new scan to repopulate.`);
});

function renderAdminDashboard(period) {
  const dash = document.getElementById('adminDashboard');
  const now = Date.now();
  const cutoffs = { day: 86400000, week: 604800000, month: 2592000000 };
  const cutoff = now - (cutoffs[period] || cutoffs.month);

  const events = Object.values(allEvents);
  const recentEvents = events.filter(e => (e.createdAt || 0) >= cutoff);

  // Totals
  const totals = {
    interested: recentEvents.filter(e => e.status === 'Interested').length,
    booked: recentEvents.filter(e => e.status === 'Booked').length,
    seen: recentEvents.filter(e => e.status === 'Past').length,
    suggested: recentEvents.filter(e => e.status === 'Suggested').length,
    total: recentEvents.length
  };

  // Count venues added (venues with events created in period)
  const newVenues = new Set(recentEvents.map(e => e.venue).filter(Boolean));

  // Per-user stats
  const userStats = {};
  Object.keys(USERS).forEach(u => { userStats[u] = { added: 0, interested: 0, booked: 0, seen: 0, edits: 0 }; });

  recentEvents.forEach(e => {
    const by = e.addedBy || '';
    if (by && userStats[by]) userStats[by].added++;
    if (e.attendees) {
      Object.keys(e.attendees).forEach(u => {
        if (userStats[u]) {
          if (e.status === 'Past') userStats[u].seen++;
          else if (e.status === 'Booked') userStats[u].booked++;
        }
      });
    }
  });

  // Count interested per user (events where user toggled to interested)
  events.filter(e => e.status === 'Interested' || e.status === 'Booked').forEach(e => {
    if (e.attendees) {
      Object.keys(e.attendees).forEach(u => {
        if (userStats[u] && e.status === 'Interested') userStats[u].interested++;
      });
    }
  });

  // Text edits: count events with notes/personalNotes/venueNotes/artistNotes created in period
  recentEvents.forEach(e => {
    if (e.artistNotes) {
      if (typeof e.artistNotes === 'object') {
        Object.keys(e.artistNotes).forEach(u => { if (userStats[u]) userStats[u].edits++; });
      } else { const by = e.addedBy || ''; if (by && userStats[by]) userStats[by].edits++; }
    }
    if (e.venueNotes) {
      if (typeof e.venueNotes === 'object') {
        Object.keys(e.venueNotes).forEach(u => { if (userStats[u]) userStats[u].edits++; });
      } else { const by = e.addedBy || ''; if (by && userStats[by]) userStats[by].edits++; }
    }
    if (e.personalNotes) {
      if (typeof e.personalNotes === 'object') {
        Object.keys(e.personalNotes).forEach(u => { if (userStats[u]) userStats[u].edits++; });
      } else { const by = e.addedBy || ''; if (by && userStats[by]) userStats[by].edits++; }
    }
  });

  const periodLabel = period === 'day' ? 'Today' : period === 'week' ? 'This Week' : 'This Month';
  const userTotal = u => u.added + u.seen + u.booked + u.interested + u.edits;
  const activeUsers = Object.entries(userStats).filter(([_, s]) => userTotal(s) > 0);
  const grandTotal = activeUsers.reduce((sum, [_, s]) => sum + userTotal(s), 0);

  dash.innerHTML = `
    <div class="admin-card">
      <div class="admin-card-title">Totals — ${periodLabel}</div>
      <div class="admin-stats-grid">
        <div class="admin-stat"><div class="admin-stat-num">${totals.total}</div><div class="admin-stat-label">Events added</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${totals.suggested}</div><div class="admin-stat-label">Suggested</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${totals.interested}</div><div class="admin-stat-label">Interested</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${totals.booked}</div><div class="admin-stat-label">Booked</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${totals.seen}</div><div class="admin-stat-label">Seen</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${newVenues.size}</div><div class="admin-stat-label">Venues</div></div>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-title">By User — ${periodLabel}</div>
      ${activeUsers.length ? activeUsers.sort((a, b) => userTotal(b[1]) - userTotal(a[1])).map(([u, s]) => {
        const pct = grandTotal ? Math.round(userTotal(s) / grandTotal * 100) : 0;
        return `
        <div class="admin-user-row">
          <div class="admin-user-header">
            <span class="admin-user-name">${USERS[u]?.name || u}</span>
            <span class="admin-user-pct">${pct}%</span>
          </div>
          <div class="admin-user-stats">
            <div class="admin-user-stat"><span class="admin-user-num">${s.added}</span>added</div>
            <div class="admin-user-stat"><span class="admin-user-num">${s.booked}</span>booked</div>
            <div class="admin-user-stat"><span class="admin-user-num">${s.seen}</span>seen</div>
            <div class="admin-user-stat"><span class="admin-user-num">${s.edits}</span>edits</div>
          </div>
        </div>`; }).join('') : '<div class="settings-hint">No activity in this period.</div>'}
    </div>
    <div class="admin-card">
      <div class="admin-card-title">All Time</div>
      <div class="admin-stats-grid">
        <div class="admin-stat"><div class="admin-stat-num">${events.length}</div><div class="admin-stat-label">Total events</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${new Set(events.map(e => e.artist).filter(Boolean)).size}</div><div class="admin-stat-label">Artists</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${new Set(events.map(e => e.venue).filter(Boolean)).size}</div><div class="admin-stat-label">Venues</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${Object.keys(USERS).length}</div><div class="admin-stat-label">Users</div></div>
      </div>
    </div>`;
}

// Export CSV
document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const events = Object.entries(allEvents);
  if (!events.length) { alert('No events to export.'); return; }

  const headers = ['id','artist','mainArtist','venue','date','type','status','addedBy','scannedBy','bookingUrl','ticketInfo','artistNotes','venueNotes','seeAgain','attendees','ratings','personalNotes','createdAt'];
  const rows = events.map(([id, e]) => {
    return headers.map(h => {
      if (h === 'id') return id;
      const v = e[h];
      if (v === null || v === undefined) return '';
      if (h === 'attendees') return Object.keys(v).join(';');
      if (h === 'ratings') return Object.entries(v).map(([u,r]) => `${u}:${r}`).join(';');
      if (h === 'personalNotes') return Object.entries(v).map(([u,n]) => `${u}:${n}`).join(';');
      return String(v).replace(/"/g, '""');
    }).map(v => `"${v}"`).join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backstage_export_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// Import CSV
document.getElementById('importCsvInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('importStatus');
  statusEl.textContent = 'Reading file…';

  const text = await file.text();
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) { statusEl.textContent = 'Empty or invalid CSV.'; return; }

  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const idIdx = headers.indexOf('id');
  let imported = 0;

  for (let i = 1; i < lines.length; i++) {
    // Parse CSV row respecting quoted fields
    const row = [];
    let current = '', inQuotes = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { row.push(current); current = ''; }
      else { current += ch; }
    }
    row.push(current);

    const obj = {};
    headers.forEach((h, idx) => {
      if (h === 'id') return;
      const v = (row[idx] || '').trim();
      if (!v) return;
      if (h === 'attendees') {
        obj.attendees = {};
        v.split(';').forEach(u => { if (u.trim()) obj.attendees[u.trim()] = true; });
      } else if (h === 'ratings') {
        obj.ratings = {};
        v.split(';').forEach(pair => { const [u, r] = pair.split(':'); if (u && r) obj.ratings[u.trim()] = parseInt(r); });
      } else if (h === 'personalNotes') {
        obj.personalNotes = {};
        v.split(';').forEach(pair => { const idx = pair.indexOf(':'); if (idx > 0) obj.personalNotes[pair.slice(0, idx).trim()] = pair.slice(idx + 1); });
      } else if (h === 'createdAt') {
        obj.createdAt = parseInt(v) || Date.now();
      } else if (h === 'seeAgain') {
        obj.seeAgain = v === 'true';
      } else {
        obj[h] = v;
      }
    });

    if (!obj.artist) continue;
    const eventId = idIdx >= 0 ? row[idIdx]?.trim() : null;
    if (eventId && allEvents[eventId]) {
      await update(ref(db, 'events/' + eventId), obj);
    } else {
      obj.createdAt = obj.createdAt || Date.now();
      await push(ref(db, 'events'), obj);
    }
    imported++;
  }

  statusEl.textContent = `Imported ${imported} events.`;
  e.target.value = '';
});

// Music player toggle
document.querySelectorAll('[data-player]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-player]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    musicPlayer = btn.dataset.player;
    await set(ref(db, 'users/' + currentUser + '/musicPlayer'), musicPlayer);
  });
});

// Map app toggle
document.querySelectorAll('[data-mapapp]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-mapapp]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mapApp = btn.dataset.mapapp;
    await set(ref(db, 'users/' + currentUser + '/mapApp'), mapApp);
    renderVenues();
  });
});

// Suggested source toggle
document.querySelectorAll('[data-source]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-source]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    suggestedSource = btn.dataset.source;
    await set(ref(db, 'users/' + currentUser + '/suggestedSource'), suggestedSource);
    renderSuggested();
  });
});

// Share scope toggle (Private / My Groups / Everyone)
document.querySelectorAll('[data-sharescope]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-sharescope]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    shareScope = btn.dataset.sharescope;
    await set(ref(db, 'users/' + currentUser + '/shareScope'), shareScope);
  });
});

// Comment attribution toggle (Named / Anonymous)
document.querySelectorAll('[data-commentattrib]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-commentattrib]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    commentAttrib = btn.dataset.commentattrib;
    shareComments = commentAttrib;
    await update(ref(db, 'users/' + currentUser), { commentAttrib, shareComments: commentAttrib });
  });
});

// Share finds toggle
document.querySelectorAll('[data-sharesug]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-sharesug]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    shareSuggestions = btn.dataset.sharesug;
    await set(ref(db, 'users/' + currentUser + '/shareSuggestions'), shareSuggestions);
    // Dim suggest scope when finds are private
    const suggestGroup = document.getElementById('suggestScopeGroup');
    if (suggestGroup) suggestGroup.style.opacity = shareSuggestions === 'private' ? '0.4' : '1';
    if (suggestGroup) suggestGroup.style.pointerEvents = shareSuggestions === 'private' ? 'none' : 'auto';
  });
});

// Suggest scope toggle
document.querySelectorAll('[data-suggestscope]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-suggestscope]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    await set(ref(db, 'users/' + currentUser + '/suggestScope'), btn.dataset.suggestscope);
  });
});

// Provider toggle
document.querySelectorAll('[data-provider]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-provider]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('imapEmailInput').placeholder = btn.dataset.provider === 'gmail' ? 'you@gmail.com' : 'you@icloud.com';
  });
});

document.getElementById('saveInterests').addEventListener('click', async () => {
  const interests = document.getElementById('interestsInput').value.trim();
  await set(ref(db, 'users/' + currentUser + '/interests'), interests);
  markSaved('interestsInput');
  document.getElementById('saveInterests').classList.remove('has-content');
  alert('Interests saved.');
});

document.getElementById('saveImapCredentials').addEventListener('click', async () => {
  const email = document.getElementById('imapEmailInput').value.trim();
  const password = document.getElementById('imapPasswordInput').value.trim();
  const provider = document.querySelector('[data-provider].active')?.dataset.provider || 'icloud';
  if (!email) { alert('Please enter your email address.'); return; }
  // Save email and provider to Firebase (not the password)
  await update(ref(db, 'users/' + currentUser), { imapEmail: email, emailProvider: provider });
  // Save password securely via server-side function
  if (password && password !== '••••••••') {
    const res = await fetch('/.netlify/functions/save-imap-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser, password })
    });
    const data = await res.json();
    if (data.error) { alert('Error saving password: ' + data.error); return; }
  }
  alert('Email credentials saved.');
});

function normaliseSender(val) {
  return typeof val === 'string' ? { email: val, name: '', enabled: true, shared: true } : val;
}

function renderSenders(watchSenders, ticketSenders) {
  const list = document.getElementById('sendersList');
  // Current user's own subscriptions
  const entries = [];
  for (const [key, val] of Object.entries(watchSenders || {})) {
    entries.push({ key, fbPath: 'watchSenders', type: 'newsletter', ...normaliseSender(val) });
  }
  for (const [key, val] of Object.entries(ticketSenders || {})) {
    entries.push({ key, fbPath: 'ticketSenders', type: 'tickets', ...normaliseSender(val) });
  }

  list.innerHTML = entries.map(s => `
    <div class="sender-row sender-editable" data-sender-key="${s.key}" data-fb-path="${s.fbPath}">
      <input type="checkbox" class="sender-check" data-sender-key="${s.key}" data-fb-path="${s.fbPath}" ${s.enabled !== false ? 'checked' : ''}>
      <div class="sender-info">
        <div class="sender-name">${s.name || s.email}</div>
        ${s.name ? `<div class="sender-addr">${s.email}</div>` : ''}
      </div>
      <span class="sender-type ${s.type}">${s.type}</span>
      <button class="sender-shared ${s.shared === false ? 'private' : ''}" data-sender-key="${s.key}" data-fb-path="${s.fbPath}" title="${s.shared === false ? 'Private' : 'Shared'}">${s.shared === false ? '🔒' : '👥'}</button>
      <button class="sender-remove" data-sender-key="${s.key}" data-fb-path="${s.fbPath}">&#x2715;</button>
    </div>
    <div class="sender-edit-panel" id="edit-${s.key}" style="display:none;">
      <input type="text" class="form-input sender-edit-name" value="${s.name || ''}" placeholder="Display name">
      <input type="email" class="form-input sender-edit-email" value="${s.email || ''}" placeholder="Email address">
      <select class="form-input sender-edit-type">
        <option value="newsletter" ${s.type === 'newsletter' ? 'selected' : ''}>Newsletter</option>
        <option value="tickets" ${s.type === 'tickets' ? 'selected' : ''}>Ticket confirmations</option>
      </select>
      <button class="save-notes-btn sender-edit-save" data-sender-key="${s.key}" data-fb-path="${s.fbPath}" data-orig-type="${s.type}">Save</button>
    </div>
  `).join('') || '<div style="color:var(--text-dim);font-size:0.85rem;">No subscriptions added yet.</div>';

  // Tap row to expand/collapse edit panel
  list.querySelectorAll('.sender-editable').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.sender-check, .sender-shared, .sender-remove')) return;
      const panel = document.getElementById('edit-' + row.dataset.senderKey);
      const wasOpen = panel.style.display !== 'none';
      list.querySelectorAll('.sender-edit-panel').forEach(p => p.style.display = 'none');
      if (!wasOpen) panel.style.display = 'flex';
    });
  });

  list.querySelectorAll('.sender-check').forEach(cb => {
    cb.addEventListener('change', async () => {
      await set(ref(db, `users/${currentUser}/${cb.dataset.fbPath}/${cb.dataset.senderKey}/enabled`), cb.checked);
    });
  });

  list.querySelectorAll('.sender-shared').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isPrivate = btn.classList.contains('private');
      await set(ref(db, `users/${currentUser}/${btn.dataset.fbPath}/${btn.dataset.senderKey}/shared`), isPrivate);
      btn.classList.toggle('private', !isPrivate);
      btn.textContent = isPrivate ? '👥' : '🔒';
      btn.title = isPrivate ? 'Shared' : 'Private';
    });
  });

  list.querySelectorAll('.sender-edit-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const panel = btn.closest('.sender-edit-panel');
      const name = panel.querySelector('.sender-edit-name').value.trim();
      const email = panel.querySelector('.sender-edit-email').value.trim();
      const newType = panel.querySelector('.sender-edit-type').value;
      const origType = btn.dataset.origType;
      const origPath = btn.dataset.fbPath;
      const key = btn.dataset.senderKey;
      const newPath = newType === 'tickets' ? 'ticketSenders' : 'watchSenders';

      if (origPath !== newPath) {
        // Type changed — move to the other list
        const snap = await get(ref(db, `users/${currentUser}/${origPath}/${key}`));
        const data = snap.val();
        await remove(ref(db, `users/${currentUser}/${origPath}/${key}`));
        await push(ref(db, `users/${currentUser}/${newPath}`), { ...normaliseSender(data), name, email });
      } else {
        await update(ref(db, `users/${currentUser}/${origPath}/${key}`), { name, email });
      }
      panel.style.display = 'none';
      const [ws, ts] = await Promise.all([
        get(ref(db, 'users/' + currentUser + '/watchSenders')),
        get(ref(db, 'users/' + currentUser + '/ticketSenders'))
      ]);
      renderSenders(ws.val() || {}, ts.val() || {});
      renderCommunitySenders();
    });
  });

  list.querySelectorAll('.sender-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await remove(ref(db, `users/${currentUser}/${btn.dataset.fbPath}/${btn.dataset.senderKey}`));
      const [ws, ts] = await Promise.all([
        get(ref(db, 'users/' + currentUser + '/watchSenders')),
        get(ref(db, 'users/' + currentUser + '/ticketSenders'))
      ]);
      renderSenders(ws.val() || {}, ts.val() || {});
      renderCommunitySenders();
    });
  });
}

// Community subscriptions: shared subs from other users, with opt-in/out
function renderCommunitySenders() {
  const list = document.getElementById('communitySendersList');
  if (!list) return;
  const myOptOuts = allUserPrefs[currentUser]?.optedOutSubs || {};

  // Gather all shared subscriptions from all users (excluding current user's own)
  const communitySubs = [];
  const seen = new Set();
  for (const [userId, prefs] of Object.entries(allUserPrefs)) {
    if (userId === currentUser) continue;
    const userName = USERS[userId]?.name || userId;
    const addSubs = (senders, type) => {
      for (const [key, val] of Object.entries(senders || {})) {
        const entry = normaliseSender(val);
        if (entry.shared === false || entry.enabled === false) continue;
        const emailLower = (entry.email || '').toLowerCase();
        if (seen.has(emailLower)) continue;
        seen.add(emailLower);
        communitySubs.push({ email: entry.email, name: entry.name, type, contributor: userName, subId: `${userId}:${type}:${emailLower}` });
      }
    };
    addSubs(prefs.watchSenders, 'newsletter');
    addSubs(prefs.ticketSenders, 'tickets');
  }

  if (!communitySubs.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem;">No community subscriptions yet.</div>';
    return;
  }

  list.innerHTML = communitySubs.map(s => `
    <div class="sender-row">
      <input type="checkbox" class="community-sub-check" data-sub-id="${s.subId}" ${!myOptOuts[s.subId.replace(/[.#$/[\]]/g, '_')] ? 'checked' : ''}>
      <div class="sender-info">
        <div class="sender-name">${s.name || s.email}</div>
        ${s.name ? `<div class="sender-addr">${s.email}</div>` : ''}
        <div class="sender-addr">from ${s.contributor}</div>
      </div>
      <span class="sender-type ${s.type}">${s.type}</span>
    </div>
  `).join('');

  list.querySelectorAll('.community-sub-check').forEach(cb => {
    cb.addEventListener('change', async () => {
      const safeId = cb.dataset.subId.replace(/[.#$/[\]]/g, '_');
      if (cb.checked) {
        await remove(ref(db, `users/${currentUser}/optedOutSubs/${safeId}`));
      } else {
        await set(ref(db, `users/${currentUser}/optedOutSubs/${safeId}`), true);
      }
    });
  });
}

watchInputs('newSenderInput', 'addSenderBtn');

document.getElementById('addSenderBtn').addEventListener('click', async () => {
  const nameInput = document.getElementById('newSenderName');
  const emailInput = document.getElementById('newSenderInput');
  const typeSelect = document.getElementById('newSenderType');
  const email = emailInput.value.trim();
  if (!email) return;
  const name = nameInput.value.trim();
  if (!name) { alert('Please give this subscription a name.'); return; }
  const fbPath = typeSelect.value === 'tickets' ? 'ticketSenders' : 'watchSenders';
  await push(ref(db, 'users/' + currentUser + '/' + fbPath), { email, name, enabled: true, shared: true });
  nameInput.value = '';
  emailInput.value = '';
  emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  const [ws, ts] = await Promise.all([
    get(ref(db, 'users/' + currentUser + '/watchSenders')),
    get(ref(db, 'users/' + currentUser + '/ticketSenders'))
  ]);
  renderSenders(ws.val() || {}, ts.val() || {});
  renderCommunitySenders();
});

// Shared scan trigger: fires background function and listens for progress via Firebase
function triggerScan(statusEl, btnEl, btnLabel, { userId, manual }) {
  let unsubscribe;
  return new Promise((resolve) => {
    // Listen for status updates from the background function
    unsubscribe = onValue(ref(db, 'scanStatus/' + userId), snap => {
      const status = snap.val();
      if (!status) return;
      statusEl.textContent = status.progress || '';
      if (status.state === 'complete' || status.state === 'error') {
        unsubscribe();
        btnEl.disabled = false;
        btnEl.textContent = btnLabel;
        resolve(status);
      }
    });

    // Fire the background function (returns 202 immediately)
    fetch('/.netlify/functions/scan-emails-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, manual: !!manual })
    }).catch(() => {
      statusEl.textContent = 'Failed to start scan.';
      btnEl.disabled = false;
      btnEl.textContent = btnLabel;
      unsubscribe();
      resolve(null);
    });
  });
}

document.getElementById('scanEmailsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanEmailsBtn');
  const status = document.getElementById('scanStatus');
  btn.disabled = true;
  btn.textContent = '✦ Scanning…';
  status.textContent = 'Starting scan…';
  await triggerScan(status, btn, '✦ Scan emails now', { userId: currentUser, manual: true });
});

document.getElementById('clearRescanBtn').addEventListener('click', async () => {
  if (!confirm('This will delete all current suggestions and rescan your emails. Continue?')) return;
  const btn = document.getElementById('clearRescanBtn');
  const status = document.getElementById('clearRescanStatus');
  btn.disabled = true;
  btn.textContent = '✦ Clearing suggestions…';
  status.textContent = 'Removing existing suggestions…';
  // Delete all Suggested events
  let cleared = 0;
  for (const [id, e] of Object.entries(allEvents)) {
    if (e.status === 'Suggested') {
      await remove(ref(db, 'events/' + id));
      cleared++;
    }
  }
  status.textContent = `Cleared ${cleared} suggestions. Starting scan…`;
  btn.textContent = '✦ Scanning…';
  const result = await triggerScan(status, btn, '✦ Clear suggestions & rescan', { userId: currentUser, manual: true });
  if (result?.state === 'complete') {
    status.textContent = `Cleared ${cleared} old suggestions. ${result.progress}`;
  } else if (result?.state === 'error') {
    status.textContent = `Cleared ${cleared}. ${result.progress}`;
  }
});
function confirmCloseSettings() {
  if (hasUnsavedChanges('interestsInput', 'imapEmailInput')) {
    if (!confirm('You have unsaved changes. Close without saving?')) return;
  }
  closeModal(settingsModal);
}
document.getElementById('closeSettingsModal').addEventListener('click', confirmCloseSettings);
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) confirmCloseSettings(); });

async function loadGroups() {
  try {
    const snap = await get(ref(db, 'groups'));
    const data = snap.val();
    if (data && Array.isArray(data)) {
      GROUPS = data.map(g => Array.isArray(g) ? g : Object.values(g));
    }
    const namesSnap = await get(ref(db, 'groupNames'));
    groupNames = namesSnap.val() || [];
  } catch (e) {
    console.warn('Could not load groups, using defaults', e);
  }
}

async function saveGroups() {
  await set(ref(db, 'groups'), GROUPS);
  await set(ref(db, 'groupNames'), groupNames);
  buildFilterChips();
  renderFeed();
  renderArtists();
  renderVenues();
}

function renderSettings() {
  const list = document.getElementById('groupsList');
  // Show only groups the current user belongs to (admin sees all)
  const myGroups = isAdmin(currentUser)
    ? GROUPS
    : GROUPS.filter(g => g.includes(currentUser));

  list.innerHTML = myGroups.map((group, idx) => {
    const realIdx = GROUPS.indexOf(group);
    return `
      <div class="group-card" data-idx="${realIdx}">
        <div class="group-header">
          <input class="group-name-input" data-idx="${realIdx}" value="${(allUserPrefs[currentUser]?.groupNicknames || {})[realIdx] || groupNames[realIdx] || ''}" placeholder="Group ${idx + 1}">
          <button class="group-delete-btn" data-idx="${realIdx}" title="Delete group">✕</button>
        </div>
        <div class="group-members">
          ${group.map(u => `<span class="group-member">${USERS[u]?.name || u}<button class="member-remove" data-idx="${realIdx}" data-user="${u}">✕</button></span>`).join('')}
        </div>
        <div class="group-add-member">
          <select class="group-member-select" data-idx="${realIdx}">
            <option value="">Add person…</option>
            ${Object.entries(USERS)
              .filter(([id]) => !group.includes(id))
              .map(([id, u]) => `<option value="${id}">${u.name}</option>`)
              .join('')}
          </select>
        </div>
      </div>`;
  }).join('') || '<div style="color:var(--text-dim);font-size:0.9rem;">No groups yet. Add one below.</div>';

  // Delete group
  list.querySelectorAll('.group-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      const group = GROUPS[idx];
      const memberNames = group ? group.map(u => USERS[u]?.name || u).join(', ') : '';
      if (!confirm(`Delete this group (${memberNames})? This will remove it for all members.`)) return;
      GROUPS.splice(idx, 1);
      // Remove per-user names for this group index and shift higher indices down
      const allUsersSnap = await get(ref(db, 'users'));
      const allUsersData = allUsersSnap.val() || {};
      for (const [uid, udata] of Object.entries(allUsersData)) {
        const names = udata?.groupNicknames;
        if (names && typeof names === 'object') {
          const updated = {};
          Object.entries(names).forEach(([k, v]) => {
            const ki = parseInt(k);
            if (ki === idx) return; // removed
            updated[ki > idx ? ki - 1 : ki] = v;
          });
          await set(ref(db, 'users/' + uid + '/groupNicknames'), Object.keys(updated).length ? updated : null);
        }
      }
      groupNames.splice(idx, 1);
      await saveGroups();
      renderSettings();
    });
  });

  // Remove member
  list.querySelectorAll('.member-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      const user = btn.dataset.user;
      GROUPS[idx] = GROUPS[idx].filter(u => u !== user);
      if (GROUPS[idx].length === 0) GROUPS.splice(idx, 1);
      await saveGroups();
      renderSettings();
    });
  });

  // Add member
  list.querySelectorAll('.group-member-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      const idx = parseInt(sel.dataset.idx);
      GROUPS[idx].push(sel.value);
      await saveGroups();
      renderSettings();
    });
  });

  // Group name editing (per-user nicknames)
  list.querySelectorAll('.group-name-input').forEach(input => {
    input.addEventListener('change', async () => {
      const idx = parseInt(input.dataset.idx);
      const nickname = input.value.trim();
      const nicknames = allUserPrefs[currentUser]?.groupNicknames || {};
      if (nickname) {
        nicknames[idx] = nickname;
      } else {
        delete nicknames[idx];
      }
      await set(ref(db, 'users/' + currentUser + '/groupNicknames'), Object.keys(nicknames).length ? nicknames : null);
      // Update local cache
      if (!allUserPrefs[currentUser]) allUserPrefs[currentUser] = {};
      allUserPrefs[currentUser].groupNicknames = nicknames;
      buildFilterChips();
    });
  });
}

// Add group button
document.getElementById('addGroupBtn').addEventListener('click', async () => {
  // New group starts with just the current user
  GROUPS.push([currentUser]);
  await saveGroups();
  renderSettings();
});

// ===== ONBOARDING =====
const onboardingModal = document.getElementById('onboardingModal');

async function checkOnboarding() {
  try {
    const snap = await get(ref(db, 'users/' + currentUser + '/interests'));
    if (!snap.val()) {
      openModal(onboardingModal);
    }
  } catch (e) {
    // Silently skip if we can't check
  }
}

watchInputs('onboardingInterests', 'saveOnboarding');

document.getElementById('saveOnboarding').addEventListener('click', async () => {
  const interests = document.getElementById('onboardingInterests').value.trim();
  if (interests) {
    await set(ref(db, 'users/' + currentUser + '/interests'), interests);
  }
  closeModal(onboardingModal);
});

document.getElementById('skipOnboarding').addEventListener('click', () => {
  closeModal(onboardingModal);
});

document.getElementById('closeOnboarding').addEventListener('click', () => {
  closeModal(onboardingModal);
});

onboardingModal.addEventListener('click', e => {
  if (e.target === onboardingModal) closeModal(onboardingModal);
});

// ===== CLEARABLE INPUTS =====
function makeClearable(input) {
  if (input.closest('.clearable-wrap')) return;
  const wrap = document.createElement('span');
  wrap.className = 'clearable-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clear-field-btn';
  btn.textContent = '✕';
  wrap.appendChild(btn);
  const toggle = () => btn.classList.toggle('visible', document.activeElement === input);
  input.addEventListener('input', toggle);
  input.addEventListener('focus', toggle);
  input.addEventListener('blur', () => setTimeout(toggle, 100));
  toggle();
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
}
document.querySelectorAll('.form-input, .form-textarea, .search-input, .profile-notes-input').forEach(makeClearable);

// For dynamically created inputs (modals), re-apply on modal open
const _origOpenModal = openModal;
openModal = function(modal) {
  _origOpenModal(modal);
  setTimeout(() => modal.querySelectorAll('.form-input, .form-textarea, .search-input, .profile-notes-input').forEach(makeClearable), 0);
};

// ===== PWA INSTALL BANNER =====
(function() {
  const isStandalone = window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || navigator.maxTouchPoints > 1;
  const dismissed = localStorage.getItem('backstage-install-dismissed');

  if (!isMobile || isStandalone || dismissed) return;

  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.userAgent));
  const isSafari = isIOS && /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|OPiOS|EdgiOS/i.test(navigator.userAgent);

  const shareIcon = `<svg width="16" height="16" viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin:0 2px;"><path d="M25 33V3"/><path d="M15 13l10-10 10 10"/><path d="M10 22H6v24h38V22h-4"/></svg>`;

  let instructions, title;
  if (isIOS && !isSafari) {
    title = 'Open in Safari to install';
    instructions = 'This browser can\'t add apps to your home screen. Open this page in <strong>Safari</strong> to install backstage.';
  } else if (isIOS) {
    title = 'Install backstage';
    instructions = `Tap <strong>⋯</strong> then ${shareIcon} <strong>Share</strong> then <strong>Add to Home Screen</strong>`;
  } else {
    title = 'Install backstage';
    instructions = `Tap <strong>⋮</strong> menu then <strong>Add to Home Screen</strong>`;
  }

  const banner = document.createElement('div');
  banner.className = 'install-banner';
  banner.innerHTML = `
    <div class="install-banner-content">
      <div class="install-banner-icon">📲</div>
      <div class="install-banner-text">
        <div class="install-banner-title">${title}</div>
        <div class="install-banner-instructions">${instructions}</div>
      </div>
      <button class="install-banner-close" id="dismissInstall">✕</button>
    </div>`;

  document.body.prepend(banner);

  document.getElementById('dismissInstall').addEventListener('click', () => {
    localStorage.setItem('backstage-install-dismissed', '1');
    banner.remove();
  });
})();

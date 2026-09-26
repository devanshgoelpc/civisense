

const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyC_EHc9irh0u3c_NYmmNSxr7-dKs11r45U",
    authDomain:        "civiceye-b6325.firebaseapp.com",
    projectId:         "civiceye-b6325",
    storageBucket:     "civiceye-b6325.firebasestorage.app",
    messagingSenderId: "453127476882",
    appId:             "1:453127476882:web:e72a6978657441b764784b"
};


/* ============================================================
   SECTION 2 — APP CONSTANTS
   ============================================================ */

// Firestore collection name
const COLLECTION = 'reports';

// Hotspot radius in metres
const HOTSPOT_RADIUS_M = 100;

// Status display labels
const STATUS_LABELS = {
    'NEW':         'New',
    'ASSIGNED':    'Assigned',
    'IN_PROGRESS': 'In Progress',
    'RESOLVED':    'Resolved'
};

// Severity sort order (higher = worse)
const SEV_ORDER = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };


/* ============================================================
   SECTION 3 — APP STATE
   ============================================================ */

const state = {
    // All reports fetched from Firestore
    reports: [],

    // Computed hotspot clusters
    hotspots: [],

    // Currently selected report (for modal)
    selectedReport: null,

    // Which page is visible
    currentPage: 'command-center',

    // Filter/sort state for Incident Reports page
    filters: {
        search:   '',
        severity: '',
        priority: '',
        status:   '',
        sort:     'newest'
    },

    // Leaflet map instances (one per page)
    maps: {
        command: null,
        full:    null,
        hotspot: null
    },

    // Leaflet layer groups for markers
    markerLayers: {
        command: null,
        full:    null,
        hotspot: null
    },

    // Chart.js instances
    charts: {
        issues:   null,
        severity: null,
        status:   null,
        priority: null
    },

    // Accessibility settings
    settings: {
        voiceGuidance:    false,
        largeText:        false,
        highContrast:     false,
        dyslexiaFriendly: false,
        largeButtons:     false
    },

    // Firebase / Firestore handles
    firebase: {
        app:        null,
        db:         null,
        connected:  false,
        unsubscribe: null   // Firestore listener cleanup fn
    }
};


/* ============================================================
   SECTION 4 — FIREBASE INITIALISATION
   ============================================================ */

function initFirebase() {
    try {
        state.firebase.app = firebase.initializeApp(FIREBASE_CONFIG);
        state.firebase.db  = firebase.firestore();

        setConnectionStatus('connecting');
        startReportsListener();

    } catch (err) {
        console.error('[CiviSense] Firebase init error:', err);
        setConnectionStatus('disconnected');
        renderLoadingFallback();
        showToast('Firebase initialisation failed. Please check your config.', 'error');
    }
}

function setConnectionStatus(status) {
    const dot    = document.getElementById('status-dot');
    const text   = document.getElementById('status-text');
    const badge  = document.getElementById('topbar-live-badge');

    if (!dot || !text) return;

    if (status === 'connected') {
        dot.className      = 'status-dot';
        text.innerHTML     = '<strong>Firestore Connected</strong>Live data';
        if (badge) badge.style.display = 'flex';
        state.firebase.connected = true;

    } else if (status === 'connecting') {
        dot.className      = 'status-dot connecting';
        text.innerHTML     = '<strong>Connecting...</strong>Firestore';
        if (badge) badge.style.display = 'none';
        state.firebase.connected = false;

    } else {
        dot.className      = 'status-dot disconnected';
        text.innerHTML     = '<strong>Disconnected</strong>Check Firebase config';
        if (badge) badge.style.display = 'none';
        state.firebase.connected = false;
    }
}


/* ============================================================
   SECTION 5 — FIRESTORE REAL-TIME LISTENER
   ============================================================ */

function startReportsListener() {
    if (!state.firebase.db) return;

    // Unsubscribe from any previous listener
    if (state.firebase.unsubscribe) {
        state.firebase.unsubscribe();
    }

    // Listen for real-time updates on the reports collection.
    // We fetch without server-side ordering to avoid needing a composite
    // index, and sort client-side instead.
    const ref = state.firebase.db.collection(COLLECTION);

    state.firebase.unsubscribe = ref.onSnapshot(
        (snapshot) => {
            setConnectionStatus('connected');

            // Map Firestore documents to plain JS objects
            state.reports = snapshot.docs.map((doc) => ({
                id: doc.id,
                ...doc.data()
            }));

            // Sort newest-first by default (client-side)
            state.reports.sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));

            // Compute hotspot clusters from updated data
            computeHotspots();

            // Refresh whatever page is currently visible
            refreshCurrentPage();

            // Update the "New" count badge in the sidebar nav
            updateNavBadge();
        },
        (err) => {
            console.error('[CiviSense] Firestore listener error:', err);
            setConnectionStatus('disconnected');
            showToast('Real-time data connection interrupted.', 'error');
        }
    );
}


/* ============================================================
   SECTION 6 — HOTSPOT COMPUTATION
   ============================================================
   Groups reports that share a similar issue type and are located
   within HOTSPOT_RADIUS_M metres of each other.
   ============================================================ */

function computeHotspots() {
    // Only reports with valid coordinates
    const geoReports = state.reports.filter(
        (r) => typeof r.latitude === 'number' && typeof r.longitude === 'number'
    );

    const visited  = new Set();
    const clusters = [];

    for (let i = 0; i < geoReports.length; i++) {
        const r = geoReports[i];

        if (visited.has(r.id)) continue;

        const cluster = [r];
        visited.add(r.id);

        for (let j = i + 1; j < geoReports.length; j++) {
            const s = geoReports[j];

            if (visited.has(s.id)) continue;

            const distMetres = haversineDistanceM(
                r.latitude, r.longitude,
                s.latitude, s.longitude
            );

            const similarIssue = isSameIssueType(r.issue, s.issue);

            if (distMetres <= HOTSPOT_RADIUS_M && similarIssue) {
                cluster.push(s);
                visited.add(s.id);
            }
        }

        // Only count as a hotspot if 2+ reports clustered together
        if (cluster.length >= 2) {
            clusters.push(buildHotspot(cluster, i));
        }
    }

    state.hotspots = clusters;
}

function buildHotspot(cluster, idx) {
    // Centroid (geographic average)
    const lat = cluster.reduce((sum, r) => sum + r.latitude,  0) / cluster.length;
    const lng = cluster.reduce((sum, r) => sum + r.longitude, 0) / cluster.length;

    // Dominant issue type (most frequently reported)
    const issueCounts = {};
    cluster.forEach((r) => {
        const k = r.issue || 'Unknown';
        issueCounts[k] = (issueCounts[k] || 0) + 1;
    });
    const dominantIssue = Object.entries(issueCounts)
        .sort((a, b) => b[1] - a[1])[0][0];

    // Worst severity in the cluster
    const maxSeverity = cluster.reduce((worst, r) => {
        const s = (r.severity || 'LOW').toUpperCase();
        return (SEV_ORDER[s] || 0) > (SEV_ORDER[worst] || 0) ? s : worst;
    }, 'LOW');

    return {
        id:        `hotspot-${idx}`,
        lat,
        lng,
        issue:     dominantIssue,
        count:     cluster.length,
        severity:  maxSeverity,
        intensity: Math.min(5, cluster.length),
        reports:   cluster
    };
}

function haversineDistanceM(lat1, lon1, lat2, lon2) {
    const R   = 6371000; // Earth radius in metres
    const φ1  = lat1 * Math.PI / 180;
    const φ2  = lat2 * Math.PI / 180;
    const Δφ  = (lat2 - lat1) * Math.PI / 180;
    const Δλ  = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) ** 2
            + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isSameIssueType(a, b) {
    if (!a || !b) return false;

    // Compare first meaningful word of each issue label
    const stem = (str) =>
        str.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/)[0];

    return stem(a) === stem(b);
}


/* ============================================================
   SECTION 7 — NAVIGATION SYSTEM
   ============================================================ */

function navigateTo(pageId) {
    // Hide all pages, deactivate all nav items
    document.querySelectorAll('.page').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));

    // Activate target page and nav item
    const page    = document.getElementById(`page-${pageId}`);
    const navItem = document.querySelector(`.nav-item[data-page="${pageId}"]`);

    if (page)    page.classList.add('active');
    if (navItem) navItem.classList.add('active');

    state.currentPage = pageId;

    updateTopbarTitle(pageId);
    closeMobileSidebar();
    renderPage(pageId);
}

const PAGE_TITLES = {
    'command-center':   { title: 'Command Center',      sub: 'Live civic intelligence overview' },
    'incident-reports': { title: 'Incident Reports',    sub: 'Manage and prioritise civic issues' },
    'smart-map':        { title: 'Smart Civic Map',     sub: 'Real-time incident map — all locations' },
    'hotspots':         { title: 'Civic Hotspots',      sub: 'Recurring issue cluster analysis' },
    'analytics':        { title: 'Civic Analytics',     sub: 'Data-driven insights from citizen reports' },
    'settings':         { title: 'Settings',            sub: 'Accessibility and system configuration' }
};

function updateTopbarTitle(pageId) {
    const t   = PAGE_TITLES[pageId] || { title: pageId, sub: '' };
    const el  = document.getElementById('topbar-title');
    if (el) {
        el.innerHTML = `<h1>${t.title}</h1><p>${t.sub}</p>`;
    }
}

function renderPage(pageId) {
    switch (pageId) {
        case 'command-center':   renderCommandCenter();   break;
        case 'incident-reports': renderIncidentReports(); break;
        case 'smart-map':        renderSmartMap();        break;
        case 'hotspots':         renderHotspots();        break;
        case 'analytics':        renderAnalytics();       break;
        case 'settings':         renderSettings();        break;
    }
}

function refreshCurrentPage() {
    renderPage(state.currentPage);
}

function updateNavBadge() {
    const newCount = state.reports.filter(
        (r) => (r.status || 'NEW').toUpperCase() === 'NEW'
    ).length;

    const badge = document.getElementById('nav-badge-new');
    if (badge) {
        badge.textContent  = newCount;
        badge.style.display = newCount > 0 ? 'inline' : 'none';
    }
}

function renderLoadingFallback() {
    const list = document.getElementById('recent-incidents-list');
    if (list) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <h3>Not connected</h3>
                <p>Add your Firebase config in app.js to enable live data.</p>
            </div>
        `;
    }
}


/* ============================================================
   SECTION 8 — COMMAND CENTER PAGE
   ============================================================ */

function renderCommandCenter() {
    renderStatCards();
    renderCommandMap();
    renderRecentIncidents();
}

function renderStatCards() {
    const r         = state.reports;
    const total     = r.length;
    const newCount  = r.filter((x) => (x.status || 'NEW').toUpperCase() === 'NEW').length;
    const inProg    = r.filter((x) => (x.status || '').toUpperCase() === 'IN_PROGRESS').length;
    const resolved  = r.filter((x) => (x.status || '').toUpperCase() === 'RESOLVED').length;
    const highPri = r.filter((x) => {
    const p = String(x.priority || '').toUpperCase();
    return ['HIGH', 'CRITICAL'].includes(p) || Number(x.priority) >= 3;
}).length;

    const el = document.getElementById('stat-cards');
    if (!el) return;

    el.innerHTML = [
        buildStatCard('TOTAL REPORTS', total,    '📊', '#3b82f6', 'All citizen reports'),
        buildStatCard('NEW',           newCount,  '🔵', '#3b82f6', 'Awaiting assignment'),
        buildStatCard('IN PROGRESS',   inProg,    '⚙️',  '#f59e0b', 'Actively being resolved'),
        buildStatCard('RESOLVED',      resolved,  '✅', '#10b981', 'Successfully closed'),
        buildStatCard('HIGH PRIORITY', highPri,   '🔴', '#ef4444', 'Needs urgent attention')
    ].join('');
}

function buildStatCard(label, value, icon, colour, sub) {
    return `
        <div class="stat-card">
            <div class="stat-card-header">
                <span class="stat-card-label">${label}</span>
                <div class="stat-card-icon" style="background: ${colour}1a;">${icon}</div>
            </div>
            <div class="stat-card-value" style="color: ${colour};">${value}</div>
            <div class="stat-card-sub">${sub}</div>
        </div>
    `;
}

function renderCommandMap() {
    setTimeout(() => {
        if (!state.maps.command) {
            const el = document.getElementById('command-map');
            if (!el) return;

            state.maps.command = L.map('command-map', { zoomControl: true })
                .setView([20.5937, 78.9629], 5);

            addDarkTileLayer(state.maps.command);
            state.markerLayers.command = L.layerGroup().addTo(state.maps.command);
        }

        state.maps.command.invalidateSize();
        placeReportMarkers('command');

        const countEl = document.getElementById('map-report-count');
        const geoCount = state.reports.filter((r) => {
            const lat = parseFloat(r.latitude);
            const lng = parseFloat(r.longitude);
            return !isNaN(lat) && !isNaN(lng);
        }).length;
        if (countEl) countEl.textContent = `${geoCount} incident${geoCount !== 1 ? 's' : ''}`;
    }, 120);
}

function renderRecentIncidents() {
    const el = document.getElementById('recent-incidents-list');
    if (!el) return;

    const recent = state.reports.slice(0, 12);

    if (recent.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📭</div>
                <h3>No reports yet</h3>
                <p>Citizen reports will appear here as they are submitted.</p>
            </div>
        `;
        return;
    }

    el.innerHTML = recent.map(buildIncidentRowHTML).join('');
}

function buildIncidentRowHTML(report) {
    const sev    = (report.severity || 'LOW').toUpperCase();
    const status = (report.status   || 'NEW').toUpperCase();
    const count  = report.reportCount || report.report_count || 1;
    const conf   = report.confidence  || report.aiConfidence  || 0;
    const ts     = formatTimestamp(report.timestamp);
    const loc    = getLocationLabel(report);

    return `
        <div class="incident-row" onclick="openReportModal('${report.id}')">
            <div class="incident-row-top">
                <div class="min-w-0">
                    <div class="incident-issue truncate">
                        ${issueIcon(report.issue)} ${report.issue || 'Unknown Issue'}
                    </div>
                    <div class="incident-meta">
                        <span class="incident-location">📍 ${loc}</span>
                        <span style="color:var(--text-muted);font-size:10px;">·</span>
                        <span class="incident-time">${ts}</span>
                    </div>
                </div>
                ${count > 1
                    ? `<span class="report-count-badge">
                           <span class="count">${count}</span>&nbsp;reports
                       </span>`
                    : ''}
            </div>
            <div class="incident-badges">
                ${buildSeverityBadge(sev)}
                ${buildStatusBadge(status)}
                <span class="badge badge-confidence">AI ${conf}%</span>
                ${buildPriorityBadge(report.priority)}
            </div>
        </div>
    `;
}


/* ============================================================
   SECTION 9 — INCIDENT REPORTS PAGE
   ============================================================ */

function renderIncidentReports() {
    const page = document.getElementById('page-incident-reports');
    if (!page) return;

    // Full re-render of the page shell + table
    page.innerHTML = `
        <div class="page-inner">
            <div class="card">
                <div class="card-header">
                    <span class="card-title">
                        <span class="card-title-icon">📋</span>
                        All Incident Reports
                    </span>
                    <span class="card-subtitle" id="ir-count-label">
                        ${state.reports.length} total
                    </span>
                </div>

                <!-- Filters -->
                <div class="report-filters">
                    <div class="search-input-wrap">
                        <span class="search-icon">🔍</span>
                        <input type="text" class="search-input" id="ir-search"
                               placeholder="Search by issue, location..."
                               value="${escapeHTML(state.filters.search)}">
                    </div>

                    <select class="filter-select" id="ir-severity">
                        <option value="">All Severities</option>
                        <option value="LOW">Low</option>
                        <option value="MEDIUM">Medium</option>
                        <option value="HIGH">High</option>
                        <option value="CRITICAL">Critical</option>
                    </select>

                    <select class="filter-select" id="ir-priority">
                        <option value="">All Priorities</option>
                        <option value="LOW">Low</option>
                        <option value="MEDIUM">Medium</option>
                        <option value="HIGH">High</option>
                        <option value="CRITICAL">Critical</option>
                    </select>

                    <select class="filter-select" id="ir-status">
                        <option value="">All Statuses</option>
                        <option value="NEW">New</option>
                        <option value="ASSIGNED">Assigned</option>
                        <option value="IN_PROGRESS">In Progress</option>
                        <option value="RESOLVED">Resolved</option>
                    </select>

                    <select class="filter-select" id="ir-sort">
                        <option value="newest">Newest First</option>
                        <option value="priority">Highest Priority</option>
                        <option value="severity">Highest Severity</option>
                        <option value="count">Most Reported</option>
                    </select>
                </div>

                <!-- Table -->
                <div class="reports-table-wrap" id="ir-table-wrap">
                    ${buildReportsTable()}
                </div>

            </div>
        </div>
    `;

    // Restore saved filter values in the dropdowns
    restoreFilterValues();

    // Bind filter events
    bindFilterEvents();
}

function restoreFilterValues() {
    const pairs = [
        ['ir-severity', 'severity'],
        ['ir-priority', 'priority'],
        ['ir-status',   'status'],
        ['ir-sort',     'sort']
    ];
    pairs.forEach(([elId, key]) => {
        const el = document.getElementById(elId);
        if (el && state.filters[key]) el.value = state.filters[key];
    });
}

function bindFilterEvents() {
    const search = document.getElementById('ir-search');
    if (search) {
        search.addEventListener('input', (e) => {
            state.filters.search = e.target.value;
            refreshTable();
        });
    }

    ['ir-severity', 'ir-priority', 'ir-status', 'ir-sort'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', (e) => {
            const key = id.replace('ir-', '');
            state.filters[key] = e.target.value;
            refreshTable();
        });
    });
}

function refreshTable() {
    const wrap = document.getElementById('ir-table-wrap');
    if (wrap) wrap.innerHTML = buildReportsTable();
}

function getFilteredReports() {
    let reports = [...state.reports];

    // Search
    if (state.filters.search) {
        const q = state.filters.search.toLowerCase();
        reports = reports.filter((r) =>
            (r.issue          || '').toLowerCase().includes(q) ||
            (r.surroundings   || '').toLowerCase().includes(q) ||
            (r.recommendation || '').toLowerCase().includes(q) ||
            getLocationLabel(r).toLowerCase().includes(q)
        );
    }

    // Severity
    if (state.filters.severity) {
        reports = reports.filter(
            (r) => (r.severity || '').toUpperCase() === state.filters.severity
        );
    }

    // Priority
    if (state.filters.priority) {
        reports = reports.filter(
            (r) => (r.priority || '').toUpperCase() === state.filters.priority
        );
    }

    // Status
    if (state.filters.status) {
        reports = reports.filter(
            (r) => (r.status || 'NEW').toUpperCase() === state.filters.status
        );
    }

    // Sort
    switch (state.filters.sort) {
        case 'priority':
            reports.sort((a, b) =>
                (SEV_ORDER[(b.priority || '').toUpperCase()] || 0) -
                (SEV_ORDER[(a.priority || '').toUpperCase()] || 0)
            );
            break;
        case 'severity':
            reports.sort((a, b) =>
                (SEV_ORDER[(b.severity || '').toUpperCase()] || 0) -
                (SEV_ORDER[(a.severity || '').toUpperCase()] || 0)
            );
            break;
        case 'count':
            reports.sort((a, b) =>
                (b.reportCount || b.report_count || 1) -
                (a.reportCount || a.report_count || 1)
            );
            break;
        default: // newest
            reports.sort((a, b) => getTimestampMs(b.timestamp) - getTimestampMs(a.timestamp));
            break;
    }

    return reports;
}

function buildReportsTable() {
    const filtered = getFilteredReports();

    if (filtered.length === 0) {
        return `
            <div class="empty-state">
                <div class="empty-icon">🔍</div>
                <h3>No reports match your filters</h3>
                <p>Try adjusting the search or filter criteria above.</p>
            </div>
        `;
    }

    const rows = filtered.map((r) => {
        const sev    = (r.severity || 'LOW').toUpperCase();
        const status = (r.status   || 'NEW').toUpperCase();
        const count  = r.reportCount || r.report_count || 1;
        const conf   = r.confidence  || r.aiConfidence  || 0;

        return `
            <tr onclick="openReportModal('${r.id}')">
                <td class="issue-cell">
                    ${issueIcon(r.issue)} ${escapeHTML(r.issue || 'Unknown')}
                </td>
                <td class="location-cell">📍 ${escapeHTML(getLocationLabel(r))}</td>
                <td>${buildSeverityBadge(sev)}</td>
                <td>
                    <div class="conf-bar-wrap">
                        <div class="conf-bar-label">${conf}%</div>
                        <div class="conf-bar-bg">
                            <div class="conf-bar-fill" style="width: ${conf}%;"></div>
                        </div>
                    </div>
                </td>
                <td>${buildPriorityBadge(r.priority)}</td>
                <td>
                    <span class="report-count-badge">
                        <span class="count">${count}</span> rpts
                    </span>
                </td>
                <td>${buildStatusBadge(status)}</td>
                <td style="color:var(--text-muted);font-size:11px;white-space:nowrap;">
                    ${formatTimestamp(r.timestamp)}
                </td>
            </tr>
        `;
    }).join('');

    return `
        <table class="reports-table">
            <thead>
                <tr>
                    <th>Issue</th>
                    <th>Location</th>
                    <th>Severity</th>
                    <th>AI Confidence</th>
                    <th>Priority</th>
                    <th>Reports</th>
                    <th>Status</th>
                    <th>Time</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}


/* ============================================================
   SECTION 10 — SMART MAP PAGE
   ============================================================ */

function renderSmartMap() {
    // Delay to allow the page to become visible before Leaflet measures the container
    setTimeout(() => {
        if (!state.maps.full) {
            const el = document.getElementById('full-map');
            if (!el) return;

            state.maps.full = L.map('full-map', { zoomControl: true })
                .setView([20.5937, 78.9629], 5);

            addDarkTileLayer(state.maps.full);
            state.markerLayers.full = L.layerGroup().addTo(state.maps.full);
        }

        state.maps.full.invalidateSize();
        placeReportMarkers('full');
    }, 80);
}


/* ============================================================
   SECTION 11 — CIVIC HOTSPOTS PAGE
   ============================================================ */

function renderHotspots() {
    renderHotspotList();

    // Map initialises slightly delayed (same timing trick as smart-map)
    setTimeout(() => {
        if (!state.maps.hotspot) {
            const el = document.getElementById('hotspot-map');
            if (!el) return;

            state.maps.hotspot = L.map('hotspot-map', { zoomControl: true })
                .setView([20.5937, 78.9629], 5);

            addDarkTileLayer(state.maps.hotspot);
            state.markerLayers.hotspot = L.layerGroup().addTo(state.maps.hotspot);
        }

        state.maps.hotspot.invalidateSize();
        placeHotspotMarkers();
    }, 80);
}

function renderHotspotList() {
    const list     = document.getElementById('hotspot-list');
    const countEl  = document.getElementById('hotspot-count-label');

    if (countEl) {
        countEl.textContent = `${state.hotspots.length} detected`;
    }

    if (!list) return;

    if (state.hotspots.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🎯</div>
                <h3>No hotspots detected</h3>
                <p>Hotspots appear when 2+ similar reports cluster within 100m of each other.</p>
            </div>
        `;
        return;
    }

    list.innerHTML = state.hotspots
        .sort((a, b) => b.count - a.count)
        .map(buildHotspotCardHTML)
        .join('');
}

function buildHotspotCardHTML(hs) {
    // Intensity dots
    const dots = Array.from({ length: 5 }, (_, i) =>
        `<div class="intensity-dot ${i < hs.intensity ? 'filled' : ''}"></div>`
    ).join('');

    return `
        <div class="hotspot-card" onclick="focusHotspotOnMap('${hs.id}')">
            <div class="flex items-center gap-3">
                <div class="hotspot-icon">${issueIcon(hs.issue)}</div>
                <div class="min-w-0 flex-1">
                    <div class="font-semibold truncate" style="font-size:13px;color:var(--text-primary);">
                        ${escapeHTML(hs.issue)}
                    </div>
                    <div class="text-xs" style="color:var(--text-muted);margin-top:2px;">
                        ${hs.count} overlapping reports
                    </div>
                </div>
                ${buildSeverityBadge(hs.severity)}
            </div>
            <div class="flex items-center gap-2">
                <span class="text-xs" style="color:var(--text-muted);">Intensity</span>
                <div class="hotspot-intensity">${dots}</div>
                <span class="text-xs ml-auto" style="color:var(--text-muted);font-family:monospace;">
                    ${hs.lat.toFixed(4)}, ${hs.lng.toFixed(4)}
                </span>
            </div>
        </div>
    `;
}

function focusHotspotOnMap(hotspotId) {
    const hs  = state.hotspots.find((h) => h.id === hotspotId);
    const map = state.maps.hotspot;
    if (!hs || !map) return;

    map.flyTo([hs.lat, hs.lng], 16, { duration: 0.8 });
}

function placeHotspotMarkers() {
    const map   = state.maps.hotspot;
    const layer = state.markerLayers.hotspot;
    if (!map || !layer) return;

    layer.clearLayers();

    // Faint individual report dots
    state.reports
        .filter((r) => r.latitude && r.longitude)
        .forEach((r) => {
            const sev   = (r.severity || 'LOW').toUpperCase();
            const color = severityColour(sev);

            const icon = L.divIcon({
                html: `<div style="
                    width:8px; height:8px; border-radius:50%;
                    background:${color}; opacity:0.45;
                    border:1px solid rgba(255,255,255,0.15);
                "></div>`,
                iconSize: [8, 8], iconAnchor: [4, 4], className: ''
            });

            L.marker([r.latitude, r.longitude], { icon }).addTo(layer);
        });

    const bounds = [];

    // Hotspot circles + labelled markers
    state.hotspots.forEach((hs) => {
        // Radius circle
        L.circle([hs.lat, hs.lng], {
            radius:      HOTSPOT_RADIUS_M,
            color:       '#ef4444',
            fillColor:   '#ef4444',
            fillOpacity: 0.07,
            weight:      1,
            opacity:     0.35
        }).addTo(layer);

        // Centre marker showing count
        const icon = L.divIcon({
            html: `
                <div style="
                    width:38px; height:38px; border-radius:50%;
                    background:rgba(239,68,68,0.88);
                    display:flex; align-items:center; justify-content:center;
                    font-weight:800; font-size:13px; color:#fff;
                    font-family:Inter,sans-serif;
                    border:2px solid rgba(255,255,255,0.25);
                    box-shadow:0 0 0 6px rgba(239,68,68,0.18), 0 3px 10px rgba(0,0,0,0.5);
                ">${hs.count}</div>
            `,
            iconSize:    [38, 38],
            iconAnchor:  [19, 19],
            popupAnchor: [0, -22],
            className:   ''
        });

        const marker = L.marker([hs.lat, hs.lng], { icon });

        marker.bindPopup(`
            <div class="map-popup-issue">
                ${issueIcon(hs.issue)} ${escapeHTML(hs.issue)} Hotspot
            </div>
            <div class="map-popup-row">
                <span class="popup-label">Overlapping reports</span>
                <span class="popup-value">${hs.count}</span>
            </div>
            <div class="map-popup-row">
                <span class="popup-label">Max severity</span>
                <span class="popup-value">${hs.severity}</span>
            </div>
            <div class="map-popup-row">
                <span class="popup-label">Cluster radius</span>
                <span class="popup-value">~100 m</span>
            </div>
        `);

        layer.addLayer(marker);
        bounds.push([hs.lat, hs.lng]);
    });

    if (bounds.length > 0) {
        try { map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14 }); } catch (_) {}
    }
}


/* ============================================================
   SECTION 12 — ANALYTICS PAGE
   ============================================================ */

function renderAnalytics() {
    const r   = state.reports;
    const el  = document.getElementById('analytics-report-count');
    if (el) el.textContent = `Based on ${r.length} report${r.length !== 1 ? 's' : ''}`;

    renderKeyMetrics();

    if (r.length === 0) {
        ['chart-issues', 'chart-severity', 'chart-status', 'chart-priority'].forEach((id) => {
            const canvas = document.getElementById(id);
            if (canvas) {
                const parent = canvas.parentElement;
                parent.innerHTML = `
                    <div class="chart-empty-state">
                        <div class="chart-empty-icon">📊</div>
                        <p>No data yet. Reports will populate this chart automatically.</p>
                    </div>
                `;
            }
        });
        return;
    }

    renderIssueChart();
    renderSeverityChart();
    renderStatusChart();
    renderPriorityChart();
}

function renderKeyMetrics() {
    const el = document.getElementById('key-metrics-content');
    if (!el) return;

    const r        = state.reports;
    const total    = r.length;
    const resolved = r.filter((x) => (x.status || '').toUpperCase() === 'RESOLVED').length;
    const rate     = total > 0 ? Math.round((resolved / total) * 100) : 0;
    const maxCount = r.length > 0
        ? Math.max(...r.map((x) => x.reportCount || x.report_count || 1))
        : 0;
    const hotCount = state.hotspots.length;

    el.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">
            <div class="detail-item">
                <div class="detail-item-label">Resolution Rate</div>
                <div class="detail-item-value" style="color:var(--green);font-size:26px;font-weight:800;">
                    ${rate}%
                </div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                    ${resolved} of ${total} reports closed
                </div>
            </div>
            <div class="detail-item">
                <div class="detail-item-label">Max Report Count</div>
                <div class="detail-item-value" style="color:var(--cyan);font-size:26px;font-weight:800;">
                    ${maxCount}
                </div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                    Highest duplicate-report count
                </div>
            </div>
            <div class="detail-item">
                <div class="detail-item-label">Active Hotspots</div>
                <div class="detail-item-value" style="color:var(--red);font-size:26px;font-weight:800;">
                    ${hotCount}
                </div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                    Clustered civic issues
                </div>
            </div>
        </div>
    `;
}

function renderIssueChart() {
    const canvas = document.getElementById('chart-issues');
    if (!canvas) return;

    // Count issues
    const counts = {};
    state.reports.forEach((r) => {
        const k = r.issue || 'Unknown';
        counts[k] = (counts[k] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);

    destroyChart('issues');
    state.charts.issues = new Chart(canvas, {
        type: 'bar',
        data: {
            labels:   sorted.map(([k]) => k),
            datasets: [{
                label:           'Reports',
                data:            sorted.map(([, v]) => v),
                backgroundColor: ['#3b82f6','#00d4ff','#8b5cf6','#10b981','#f59e0b','#ef4444','#f97316','#06b6d4'],
                borderRadius:    6,
                borderSkipped:   false
            }]
        },
        options: barChartOptions()
    });
}

function renderSeverityChart() {
    const canvas = document.getElementById('chart-severity');
    if (!canvas) return;

    const counts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    state.reports.forEach((r) => {
        const k = (r.severity || 'LOW').toUpperCase();
        if (counts[k] !== undefined) counts[k]++;
    });

    destroyChart('severity');
    state.charts.severity = new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels:   ['Low', 'Medium', 'High', 'Critical'],
            datasets: [{
                data:            [counts.LOW, counts.MEDIUM, counts.HIGH, counts.CRITICAL],
                backgroundColor: ['#10b981', '#f59e0b', '#f97316', '#ef4444'],
                borderWidth:     0,
                spacing:         3
            }]
        },
        options: doughnutChartOptions()
    });
}

function renderStatusChart() {
    const canvas = document.getElementById('chart-status');
    if (!canvas) return;

    const counts = { NEW: 0, ASSIGNED: 0, IN_PROGRESS: 0, RESOLVED: 0 };
    state.reports.forEach((r) => {
        const k = (r.status || 'NEW').toUpperCase();
        if (counts[k] !== undefined) counts[k]++;
    });

    destroyChart('status');
    state.charts.status = new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels:   ['New', 'Assigned', 'In Progress', 'Resolved'],
            datasets: [{
                data:            [counts.NEW, counts.ASSIGNED, counts.IN_PROGRESS, counts.RESOLVED],
                backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981'],
                borderWidth:     0,
                spacing:         3
            }]
        },
        options: doughnutChartOptions()
    });
}

function renderPriorityChart() {
    const canvas = document.getElementById('chart-priority');
    if (!canvas) return;

    const counts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    state.reports.forEach((r) => {
        const k = (r.priority || 'LOW').toUpperCase();
        if (counts[k] !== undefined) counts[k]++;
    });

    destroyChart('priority');
    state.charts.priority = new Chart(canvas, {
        type: 'bar',
        data: {
            labels:   ['Low', 'Medium', 'High', 'Critical'],
            datasets: [{
                label:           'Reports',
                data:            [counts.LOW, counts.MEDIUM, counts.HIGH, counts.CRITICAL],
                backgroundColor: ['#10b981', '#f59e0b', '#f97316', '#ef4444'],
                borderRadius:    6,
                borderSkipped:   false
            }]
        },
        options: barChartOptions()
    });
}

function destroyChart(key) {
    if (state.charts[key]) {
        state.charts[key].destroy();
        state.charts[key] = null;
    }
}

function barChartOptions() {
    return {
        responsive:          true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false }
        },
        scales: {
            x: {
                ticks: { color: '#3d5068', font: { family: 'Inter', size: 11 }, maxRotation: 40 },
                grid:  { color: 'rgba(255,255,255,0.03)' }
            },
            y: {
                ticks:       { color: '#3d5068', font: { family: 'Inter', size: 11 } },
                grid:        { color: 'rgba(255,255,255,0.03)' },
                beginAtZero: true
            }
        }
    };
}

function doughnutChartOptions() {
    return {
        responsive:          true,
        maintainAspectRatio: false,
        cutout:              '64%',
        plugins: {
            legend: {
                position: 'right',
                labels: {
                    color:    '#8fa3bf',
                    font:     { family: 'Inter', size: 11 },
                    boxWidth: 10,
                    padding:  12
                }
            }
        }
    };
}


/* ============================================================
   SECTION 13 — SETTINGS PAGE
   ============================================================ */

const SETTINGS_KEYS = [
    'voiceGuidance', 'largeText', 'highContrast', 'dyslexiaFriendly', 'largeButtons'
];

function renderSettings() {
    // Sync toggle checkboxes to current state
    SETTINGS_KEYS.forEach((key) => {
        const el = document.getElementById(`toggle-${key}`);
        if (el) el.checked = state.settings[key];
    });

    updateSystemStatusUI();
}

function applySettings() {
    const body = document.body;
    body.classList.toggle('large-text',        state.settings.largeText);
    body.classList.toggle('high-contrast',     state.settings.highContrast);
    body.classList.toggle('dyslexia-friendly', state.settings.dyslexiaFriendly);
    body.classList.toggle('large-buttons',     state.settings.largeButtons);

    // Persist
    try {
        localStorage.setItem('civisense-settings', JSON.stringify(state.settings));
    } catch (_) {}
}

function loadSettings() {
    try {
        const saved = localStorage.getItem('civisense-settings');
        if (saved) {
            Object.assign(state.settings, JSON.parse(saved));
        }
    } catch (_) {}
    applySettings();
}

function updateSystemStatusUI() {
    const rows = [
        { id: 'sys-firebase',  ok: !!state.firebase.app,       label: '● Connected',    errLabel: '✕ Not connected' },
        { id: 'sys-firestore', ok: state.firebase.connected,    label: '● Live',         errLabel: '○ Offline' },
        { id: 'sys-maps',      ok: typeof L !== 'undefined',    label: '● Loaded',       errLabel: '✕ Failed to load' }
    ];

    rows.forEach(({ id, ok, label, errLabel }) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent  = ok ? label : errLabel;
        el.className    = `sys-status-value ${ok ? 'ok' : 'error'}`;
    });
}


/* ============================================================
   SECTION 14 — REPORT DETAIL MODAL
   ============================================================ */

function openReportModal(reportId) {
    const report = state.reports.find((r) => r.id === reportId);
    if (!report) return;

    state.selectedReport = report;

    const sev    = (report.severity || 'LOW').toUpperCase();
    const status = (report.status   || 'NEW').toUpperCase();
    const conf   = report.confidence || report.aiConfidence || 0;
    const count  = report.reportCount || report.report_count || 1;
    const loc    = getLocationLabel(report);
    const ts     = formatTimestamp(report.timestamp);

  const nearbyPlaces = Array.isArray(report.nearbyPlaces) && report.nearbyPlaces.length > 0
    ? report.nearbyPlaces.map(p => {
        if (typeof p === 'object' && p !== null) {
            const name = p.name || p.place || p.vicinity || 'Landmark';
            const dist = p.distance ? ` (${p.distance})` : '';
            return `${name}${dist}`;
        }
        return String(p);
    }).join(', ')
    : (report.nearbyPlaces || 'N/A');

    // Build status buttons
    const statusBtns = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED'].map((s) => {
        const isActive  = status === s;
        const activeKey = s.toLowerCase().replace('_', '-');
        return `
            <button
                class="status-btn ${isActive ? `active-${activeKey}` : ''}"
                data-status="${s}"
                onclick="updateReportStatus('${report.id}', '${s}')">
                ${STATUS_LABELS[s]}
            </button>
        `;
    }).join('');

    document.getElementById('modal-content').innerHTML = `
        <div class="modal-header">
            <div class="min-w-0">
                <div class="modal-title truncate">
                    ${issueIcon(report.issue)} ${escapeHTML(report.issue || 'Unknown Issue')}
                </div>
                <div class="modal-subtitle">
                    ID: ${report.id.substring(0, 12)}… &nbsp;·&nbsp; ${ts}
                </div>
            </div>
            <button class="modal-close" onclick="closeModal()" aria-label="Close">✕</button>
        </div>

        <div class="modal-body">

            <!-- Badge row -->
            <div class="flex gap-2" style="flex-wrap:wrap;align-items:center;">
                ${buildSeverityBadge(sev)}
                ${buildStatusBadge(status)}
                ${buildPriorityBadge(report.priority)}
                <span class="badge badge-confidence">AI ${conf}% confidence</span>
                ${count > 1
                    ? `<span class="badge badge-count">🔁 ${count} reports</span>`
                    : ''}
            </div>

            <!-- AI Confidence bar -->
            <div class="detail-item">
                <div class="detail-item-label">AI Confidence</div>
                <div class="conf-modal-wrap">
                    <div class="conf-modal-bar">
                        <div class="conf-modal-fill" style="width:${conf}%;"></div>
                    </div>
                    <span class="conf-modal-label">${conf}%</span>
                </div>
            </div>

            <!-- Issue details -->
            <div>
                <div class="modal-section-title">Issue Details</div>
                <div class="detail-grid">
                    <div class="detail-item">
                        <div class="detail-item-label">Impact</div>
                        <div class="detail-item-value soft">
                            ${escapeHTML(report.impact || 'Not specified')}
                        </div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-item-label">Report Count</div>
                        <div class="detail-item-value" style="color:var(--cyan);font-size:20px;">
                            ${count}
                        </div>
                    </div>
                    <div class="detail-item" style="grid-column:1/-1;">
                        <div class="detail-item-label">AI Recommendation</div>
                        <div class="detail-item-value soft">
                            ${escapeHTML(report.recommendation || 'No recommendation available')}
                        </div>
                    </div>
                </div>
            </div>

            <!-- Location details -->
            <div>
                <div class="modal-section-title">Location & Context</div>
                <div class="detail-grid">
                    <div class="detail-item">
                        <div class="detail-item-label">Coordinates</div>
                        <div class="detail-item-value" style="font-family:monospace;font-size:12px;">
                            ${report.latitude != null  ? report.latitude.toFixed(6)  : 'N/A'},
                            ${report.longitude != null ? report.longitude.toFixed(6) : 'N/A'}
                        </div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-item-label">Surroundings</div>
                        <div class="detail-item-value soft">
                            ${escapeHTML(report.surroundings || 'N/A')}
                        </div>
                    </div>
                    <div class="detail-item" style="grid-column:1/-1;">
                        <div class="detail-item-label">Nearby Places</div>
                        <div class="detail-item-value soft">
                            ${escapeHTML(nearbyPlaces)}
                        </div>
                    </div>
                </div>
            </div>

            <!-- Status workflow -->
            <div>
                <div class="modal-section-title">Update Status</div>
                <div class="status-controls">${statusBtns}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
                    Updating status writes directly to Firestore and reflects instantly for all operators.
                </div>
            </div>

        </div>
    `;

    document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
    state.selectedReport = null;
}


/* ============================================================
   SECTION 15 — STATUS UPDATE (Firestore write)
   ============================================================ */

async function updateReportStatus(reportId, newStatus) {
    if (!state.firebase.db) {
        showToast('Firebase is not connected.', 'error');
        return;
    }

    try {
        await state.firebase.db
            .collection(COLLECTION)
            .doc(reportId)
            .update({ status: newStatus });

        showToast(`Status updated → ${STATUS_LABELS[newStatus]}`, 'success');

        // Update modal buttons immediately without waiting for listener
        document.querySelectorAll('.status-btn').forEach((btn) => {
            const s = btn.dataset.status;
            btn.className = 'status-btn';
            if (s === newStatus) {
                btn.classList.add(`active-${s.toLowerCase().replace('_', '-')}`);
            }
        });

    } catch (err) {
        console.error('[CiviSense] Status update failed:', err);
        showToast('Failed to update status. Check Firestore permissions.', 'error');
    }
}


/* ============================================================
   SECTION 16 — MAP HELPERS
   ============================================================ */

function addDarkTileLayer(map) {
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
        maxZoom: 16
    }).addTo(map);
}

function placeReportMarkers(mapKey) {
    const map   = state.maps[mapKey];
    const layer = state.markerLayers[mapKey];
    if (!map || !layer) return;

    layer.clearLayers();

    const geoReports = state.reports.filter((r) => r.latitude && r.longitude);
    if (geoReports.length === 0) return;

    const bounds = [];

    geoReports.forEach((report) => {
        const sev   = (report.severity || 'LOW').toUpperCase();
        const color = severityColour(sev);
        const count = report.reportCount || report.report_count || 1;

        const icon = L.divIcon({
            html: `
                <div style="
                    width:18px; height:18px;
                    border-radius:50% 50% 50% 0;
                    background:${color};
                    transform:rotate(-45deg);
                    border:2px solid rgba(255,255,255,0.22);
                    box-shadow:0 2px 8px rgba(0,0,0,0.55);
                "></div>
            `,
            iconSize:    [18, 18],
            iconAnchor:  [9, 18],
            popupAnchor: [0, -20],
            className:   ''
        });

        const marker = L.marker([report.latitude, report.longitude], { icon });

        marker.bindPopup(`
            <div class="map-popup-issue">
                ${issueIcon(report.issue)} ${escapeHTML(report.issue || 'Unknown Issue')}
            </div>
            <div class="map-popup-row">
                <span class="popup-label">Severity</span>
                <span class="popup-value">${sev}</span>
            </div>
            <div class="map-popup-row">
                <span class="popup-label">Priority</span>
                <span class="popup-value">${report.priority || 'N/A'}</span>
            </div>
            <div class="map-popup-row">
                <span class="popup-label">Status</span>
                <span class="popup-value">${STATUS_LABELS[(report.status || 'NEW').toUpperCase()] || 'New'}</span>
            </div>
            <div class="map-popup-row">
                <span class="popup-label">Reports</span>
                <span class="popup-value">${count}</span>
            </div>
            <button class="map-popup-btn" onclick="openReportModal('${report.id}')">
                View full report →
            </button>
        `);

        layer.addLayer(marker);
        bounds.push([report.latitude, report.longitude]);
    });

    if (bounds.length > 0) {
        try {
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
        } catch (_) {}
    }
}

function severityColour(sev) {
    switch (sev) {
        case 'LOW':      return '#10b981';
        case 'MEDIUM':   return '#f59e0b';
        case 'HIGH':     return '#f97316';
        case 'CRITICAL': return '#ef4444';
        default:         return '#3b82f6';
    }
}


/* ============================================================
   SECTION 17 — FORMATTING & BADGE UTILITIES
   ============================================================ */

function issueIcon(issue) {
    if (!issue) return '📍';
    const lc = issue.toLowerCase();

    if (lc.includes('pothole') || lc.includes('road damage'))        return '🕳️';
    if (lc.includes('garbage') || lc.includes('waste'))              return '🗑️';
    if (lc.includes('streetlight') || lc.includes('light'))          return '💡';
    if (lc.includes('drain') || lc.includes('flood') || lc.includes('water')) return '🌊';
    if (lc.includes('footpath') || lc.includes('pavement') || lc.includes('sidewalk')) return '🚶';
    if (lc.includes('sign'))                                          return '🪧';
    return '📍';
}

function getLocationLabel(report) {
    if (report.nearbyPlaces) {
        let first = '';
        if (Array.isArray(report.nearbyPlaces) && report.nearbyPlaces.length > 0) {
            const item = report.nearbyPlaces[0];
            first = (typeof item === 'object' && item !== null) 
                ? (item.name || item.place || item.vicinity || JSON.stringify(item)) 
                : String(item || '');
        } else if (typeof report.nearbyPlaces === 'string') {
            first = report.nearbyPlaces.split(',')[0];
        } else if (typeof report.nearbyPlaces === 'object' && report.nearbyPlaces !== null) {
            first = report.nearbyPlaces.name || Object.values(report.nearbyPlaces)[0] || '';
        } else {
            first = String(report.nearbyPlaces || '');
        }

        first = String(first || '').trim();
        if (first) return first;
    }

    if (report.latitude != null && report.longitude != null) {
        const lat = parseFloat(report.latitude);
        const lng = parseFloat(report.longitude);
        if (!isNaN(lat) && !isNaN(lng)) {
            return `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E`;
        }
    }

    return 'Location unavailable';
}

function formatTimestamp(ts) {
    if (!ts) return 'Unknown time';

    let date;
    if (ts && typeof ts.toDate === 'function') {
        date = ts.toDate();
    } else if (ts && ts.seconds) {
        date = new Date(ts.seconds * 1000);
    } else {
        date = new Date(ts);
    }

    if (isNaN(date.getTime())) return 'Unknown time';

    const now  = new Date();
    const diff = now - date;
    const secs = Math.floor(diff / 1000);
    const mins = Math.floor(secs  / 60);
    const hrs  = Math.floor(mins  / 60);
    const days = Math.floor(hrs   / 24);

    if (secs < 60)  return 'Just now';
    if (mins < 60)  return `${mins}m ago`;
    if (hrs  < 24)  return `${hrs}h ago`;
    if (days < 7)   return `${days}d ago`;

    return date.toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric'
    });
}

function getTimestampMs(ts) {
    if (!ts)                           return 0;
    if (ts && ts.seconds)              return ts.seconds * 1000;
    if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
    return new Date(ts).getTime() || 0;
}

function buildSeverityBadge(sev) {
    const s = (sev || 'LOW').toUpperCase();
    return `<span class="badge badge-severity-${s.toLowerCase()}">${s}</span>`;
}

function buildStatusBadge(status) {
    const s   = (status || 'NEW').toUpperCase();
    const cls = s === 'IN_PROGRESS' ? 'progress' : s.toLowerCase();
    return `<span class="badge badge-status-${cls}">${STATUS_LABELS[s] || s}</span>`;
}

function buildPriorityBadge(priority) {
    if (priority == null || priority === '') return '';
    const p = String(priority).toUpperCase();
    return `<span class="badge badge-priority-${p.toLowerCase()}">↑ ${p}</span>`;
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#039;');
}


/* ============================================================
   SECTION 18 — TOAST NOTIFICATIONS
   ============================================================ */

let _toastTimer = null;

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    const icons = { success: '✓', error: '✕', info: 'i' };

    toast.className = type;  // sets border colour via CSS
    toast.innerHTML = `
        <div class="toast-icon ${type}">${icons[type] || icons.info}</div>
        <div class="toast-message">${escapeHTML(message)}</div>
    `;

    // Force reflow to restart transition
    toast.classList.remove('show');
    void toast.offsetHeight;
    toast.classList.add('show');

    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 3600);
}


/* ============================================================
   SECTION 19 — MOBILE SIDEBAR
   ============================================================ */

function openMobileSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('active');
}

function closeMobileSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('active');
}


/* ============================================================
   SECTION 20 — APP INITIALISATION
   ============================================================ */

function init() {
    // Load persisted accessibility settings
    loadSettings();

    // Initialise Firebase + start Firestore listener
    initFirebase();

    // Wire up sidebar navigation click events
    document.querySelectorAll('.nav-item').forEach((item) => {
        item.addEventListener('click', () => {
            const pageId = item.dataset.page;
            if (pageId) navigateTo(pageId);
        });

        // Keyboard accessibility
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                item.click();
            }
        });
    });

    // Close modal on overlay background click
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('modal-overlay')) {
            closeModal();
        }
    });

    // ESC key closes modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    // Mobile menu toggle
    const menuBtn = document.getElementById('menu-toggle');
    if (menuBtn) menuBtn.addEventListener('click', openMobileSidebar);

    const overlay = document.getElementById('sidebar-overlay');
    if (overlay) overlay.addEventListener('click', closeMobileSidebar);

    // Bind accessibility setting toggles
    SETTINGS_KEYS.forEach((key) => {
        const toggle = document.getElementById(`toggle-${key}`);
        if (!toggle) return;

        toggle.addEventListener('change', () => {
            state.settings[key] = toggle.checked;
            applySettings();
        });
    });

    // Start on Command Center
    navigateTo('command-center');
}

// Boot
document.addEventListener('DOMContentLoaded', init);

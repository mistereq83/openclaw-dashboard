// OpenClaw Dashboard — Frontend App

const app = {
  currentView: 'overview',
  currentAgent: null,
  overviewData: null,
  agentData: null,
  charts: {},
  token: localStorage.getItem('dashboard_token') || '',
  refreshInterval: null,
  countdown: 60,

  // --- API ---
  async api(endpoint) {
    const headers = {};
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    const res = await fetch(`/api${endpoint}`, { headers });
    if (res.status === 401) {
      this.logout();
      throw new Error('Unauthorized');
    }
    return res.json();
  },

  // --- Navigation ---
  navigate(view, params = {}) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    const navEl = document.querySelector(`[data-view="${view}"]`) ||
                  document.querySelector(`[data-agent="${params.agentId}"]`);
    if (navEl) navEl.classList.add('active');

    this.currentView = view;

    switch (view) {
      case 'overview': this.loadOverview(); break;
      case 'agent': this.loadAgent(params.agentId); break;
      case 'compare': this.loadCompare(); break;
      case 'sessions': this.loadSessions(params.agentId); break;
      case 'session-detail': this.loadSessionDetail(params.agentId, params.sessionId); break;
    }
  },

  // --- Overview ---
  async loadOverview() {
    try {
      const data = await this.api('/stats/overview');
      this.overviewData = data;

      document.getElementById('stat-agents-online').textContent = data.agentsOnline;
      document.getElementById('stat-agents-offline').textContent = data.agentsOffline;
      document.getElementById('stat-today-messages').textContent = data.totalMessagesToday;
      document.getElementById('stat-total-agents').textContent = data.agentCount;

      this.renderActivityChart(data);
      this.renderTopDaysChart(data);
      this.buildAgentNav(data.agents);
    } catch (e) {
      console.error('Failed to load overview:', e);
    }
  },

  renderActivityChart(data) {
    const ctx = document.getElementById('chart-activity-7d');
    if (this.charts.activity7d) this.charts.activity7d.destroy();

    const colors = ['#6366f1', '#22c55e', '#eab308', '#ef4444', '#ec4899', '#06b6d4', '#f97316'];
    const datasets = Object.entries(data.last7DaysActivity).map(([agentId, values], i) => ({
      label: this.getAgentName(agentId, data.agents),
      data: values,
      backgroundColor: colors[i % colors.length] + '99',
      borderColor: colors[i % colors.length],
      borderWidth: 1,
    }));

    this.charts.activity7d = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.last7DaysLabels.map(d => d.slice(5)),
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { labels: { color: '#8b8fa3', font: { size: 11 } } } },
        scales: {
          x: { stacked: true, ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' } },
          y: { stacked: true, ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' } },
        },
      },
    });
  },

  renderTopDaysChart(data) {
    const ctx = document.getElementById('chart-top-days');
    if (this.charts.topDays) this.charts.topDays.destroy();

    this.charts.topDays = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.topDays.map(d => d.date),
        datasets: [{
          label: 'Wiadomości',
          data: data.topDays.map(d => d.count),
          backgroundColor: '#6366f199',
          borderColor: '#6366f1',
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' } },
          y: { ticks: { color: '#8b8fa3' }, grid: { color: '#2a2f42' } },
        },
      },
    });
  },

  // --- Agent Detail ---
  async loadAgent(agentId) {
    this.currentAgent = agentId;
    try {
      const data = await this.api(`/agents/${agentId}`);
      this.agentData = data;

      document.getElementById('agent-title').textContent = data.name;
      document.getElementById('agent-sessions-total').textContent = data.sessionsTotal;
      document.getElementById('agent-sessions-week').textContent = data.sessionsWeek;
      document.getElementById('agent-sessions-today').textContent = data.sessionsToday;
      document.getElementById('agent-messages-total').textContent = data.userMessagesTotal;
      document.getElementById('agent-messages-week').textContent = data.messagesWeek;
      document.getElementById('agent-messages-today').textContent = data.messagesToday;

      this.renderTimeline(data);
      this.renderHeatmap(data);
    } catch (e) {
      console.error('Failed to load agent:', e);
    }
  },

  renderTimeline(data) {
    const ctx = document.getElementById('chart-agent-timeline');
    if (this.charts.timeline) this.charts.timeline.destroy();

    this.charts.timeline = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.timeline.map(d => d.date.slice(5)),
        datasets: [{
          label: 'Wiadomości',
          data: data.timeline.map(d => d.count),
          borderColor: '#6366f1',
          backgroundColor: '#6366f133',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#5a5e72', maxTicksLimit: 10 }, grid: { color: '#2a2f42' } },
          y: { ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' }, beginAtZero: true },
        },
      },
    });
  },

  renderHeatmap(data) {
    const ctx = document.getElementById('chart-agent-heatmap');
    if (this.charts.heatmap) this.charts.heatmap.destroy();

    const days = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd'];
    const heatData = [];
    let maxVal = 0;

    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const val = data.heatmap[d][h];
        if (val > maxVal) maxVal = val;
        heatData.push({ x: h, y: d, v: val });
      }
    }

    // Use bubble chart to simulate heatmap
    this.charts.heatmap = new Chart(ctx, {
      type: 'bubble',
      data: {
        datasets: [{
          data: heatData.filter(p => p.v > 0).map(p => ({
            x: p.x,
            y: p.y,
            r: Math.max(2, (p.v / (maxVal || 1)) * 12),
          })),
          backgroundColor: '#6366f1aa',
          borderColor: '#6366f1',
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: {
          callbacks: {
            label: (ctx) => {
              const point = heatData.find(p => p.x === ctx.raw.x && p.y === ctx.raw.y);
              return `${days[ctx.raw.y]} ${ctx.raw.x}:00 — ${point ? point.v : 0} wiadomości`;
            },
          },
        }},
        scales: {
          x: {
            min: -0.5, max: 23.5,
            ticks: { color: '#5a5e72', callback: v => `${v}:00`, stepSize: 3 },
            grid: { color: '#2a2f4233' },
          },
          y: {
            min: -0.5, max: 6.5,
            ticks: { color: '#8b8fa3', callback: v => days[v] || '' },
            grid: { color: '#2a2f4233' },
            reverse: true,
          },
        },
      },
    });
  },

  // --- Compare ---
  async loadCompare() {
    try {
      const data = await this.api('/stats/overview');
      const tbody = document.getElementById('compare-tbody');
      tbody.innerHTML = '';

      this.compareData = data.agents;
      this.renderCompareTable(data.agents);
    } catch (e) {
      console.error('Failed to load compare:', e);
    }
  },

  renderCompareTable(agents, sortKey = 'userMessagesTotal', sortDir = 'desc') {
    const sorted = [...agents].sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'name') { va = a.id; vb = b.id; }
      if (sortKey === 'lastActivity') { va = va ? new Date(va).getTime() : 0; vb = vb ? new Date(vb).getTime() : 0; }
      return sortDir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });

    const tbody = document.getElementById('compare-tbody');
    tbody.innerHTML = sorted.map(a => `
      <tr onclick="app.navigate('agent', { agentId: '${a.agentId}' })" style="cursor:pointer">
        <td><strong>${this.getAgentName(a.agentId, agents)}</strong><br><small style="color:var(--text-muted)">${a.agentId}</small></td>
        <td>${a.sessionsTotal}</td>
        <td>${a.userMessagesTotal}</td>
        <td>${a.avgPerDay}</td>
        <td>${a.lastActivity ? this.formatDate(a.lastActivity) : 'Brak'}</td>
      </tr>
    `).join('');
  },

  // --- Sessions ---
  async loadSessions(agentId) {
    this.currentAgent = agentId || this.currentAgent;
    document.getElementById('sessions-title').textContent =
      `Sesje — ${this.getAgentName(this.currentAgent)}`;

    try {
      const params = new URLSearchParams();
      const dateFrom = document.getElementById('filter-date-from').value;
      const dateTo = document.getElementById('filter-date-to').value;
      const minMsg = document.getElementById('filter-min-messages').value;
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (minMsg) params.set('minMessages', minMsg);

      const qs = params.toString() ? '?' + params.toString() : '';
      const sessions = await this.api(`/agents/${this.currentAgent}/sessions${qs}`);
      this.renderSessionsList(sessions);
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  },

  renderSessionsList(sessions) {
    const container = document.getElementById('sessions-list');
    if (sessions.length === 0) {
      container.innerHTML = '<div class="empty-state">Brak sesji</div>';
      return;
    }

    container.innerHTML = sessions.map(s => `
      <div class="session-item" onclick="app.navigate('session-detail', { agentId: '${this.currentAgent}', sessionId: '${s.id}' })">
        <div class="session-meta">
          <span>${this.formatDate(s.lastMessage)}</span>
          <span>${s.messageCount} wiadomości (${s.userMessageCount} user)</span>
          <span>${this.formatBytes(s.sizeBytes)}</span>
        </div>
        <div class="session-preview">${this.escapeHtml(s.preview)}</div>
      </div>
    `).join('');
  },

  // --- Session Detail ---
  async loadSessionDetail(agentId, sessionId) {
    this.currentAgent = agentId || this.currentAgent;
    document.getElementById('session-detail-title').textContent = `Sesja: ${sessionId}`;

    try {
      const data = await this.api(`/agents/${this.currentAgent}/sessions/${sessionId}`);
      const container = document.getElementById('session-messages');

      if (data.messages.length === 0) {
        container.innerHTML = '<div class="empty-state">Pusta sesja</div>';
        return;
      }

      container.innerHTML = data.messages.map(m => `
        <div class="message ${m.role}">
          <div class="message-role">
            ${m.role}
            ${m.timestamp ? `<span class="message-time">${this.formatDateTime(m.timestamp)}</span>` : ''}
          </div>
          ${this.escapeHtml(m.content)}
        </div>
      `).join('');
    } catch (e) {
      console.error('Failed to load session detail:', e);
    }
  },

  // --- Search ---
  async searchInSessions() {
    const query = document.getElementById('search-query').value.trim();
    if (!query) return;

    try {
      const params = new URLSearchParams({ q: query });
      const dateFrom = document.getElementById('filter-date-from').value;
      const dateTo = document.getElementById('filter-date-to').value;
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);

      const results = await this.api(`/agents/${this.currentAgent}/search?${params.toString()}`);
      const container = document.getElementById('sessions-list');

      if (results.length === 0) {
        container.innerHTML = '<div class="empty-state">Brak wyników</div>';
        return;
      }

      container.innerHTML = results.map(r => `
        <div class="search-result" onclick="app.navigate('session-detail', { agentId: '${this.currentAgent}', sessionId: '${r.sessionId}' })">
          <div class="session-meta">
            <span>${this.formatDate(r.sessionDate)}</span>
            <span class="match-count">${r.matchCount} trafień</span>
          </div>
          <div class="session-preview">${this.escapeHtml(r.preview)}</div>
        </div>
      `).join('');
    } catch (e) {
      console.error('Search failed:', e);
    }
  },

  filterSessions() {
    this.loadSessions(this.currentAgent);
  },

  // --- Actions ---
  showSessions() {
    this.navigate('sessions', { agentId: this.currentAgent });
  },

  backToAgent() {
    this.navigate('agent', { agentId: this.currentAgent });
  },

  exportCsv() {
    if (!this.currentAgent) return;
    const url = `/api/stats/export?agent=${this.currentAgent}&token=${encodeURIComponent(this.token)}`;
    window.open(url, '_blank');
  },

  // --- Agent Nav ---
  buildAgentNav(agents) {
    const nav = document.getElementById('agent-nav');
    if (!agents) return;

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    nav.innerHTML = agents.map(a => {
      const isOnline = a.lastActivity && new Date(a.lastActivity) >= oneDayAgo;
      const name = this.getAgentName(a.agentId, agents);
      return `
        <a href="#" class="nav-item${this.currentAgent === a.agentId ? ' active' : ''}"
           data-view="agent" data-agent="${a.agentId}"
           onclick="event.preventDefault(); app.navigate('agent', { agentId: '${a.agentId}' })">
          <span class="nav-icon">&#9679;</span>
          ${name}
          <span class="agent-status ${isOnline ? 'online' : 'offline'}"></span>
        </a>
      `;
    }).join('');
  },

  // --- Sorting ---
  setupTableSort() {
    document.querySelectorAll('#compare-table th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const currentDir = th.dataset.dir || 'desc';
        const newDir = currentDir === 'desc' ? 'asc' : 'desc';
        th.dataset.dir = newDir;
        if (this.compareData) this.renderCompareTable(this.compareData, key, newDir);
      });
    });
  },

  // --- Helpers ---
  getAgentName(agentId, agents) {
    const names = {
      patrykg: 'Patryk Gocek',
      annag: 'Anna Gnatowska',
      paulinag: 'Paulina Grunau',
      katarzynag: 'Katarzyna Goll',
      katarzynac: 'Katarzyna Chrzanowska',
    };
    return names[agentId] || agentId;
  },

  formatDate(d) {
    if (!d) return '—';
    const date = new Date(d);
    return date.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  },

  formatDateTime(d) {
    if (!d) return '';
    const date = new Date(d);
    return date.toLocaleString('pl-PL', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  },

  formatBytes(b) {
    if (!b) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // --- Refresh ---
  startAutoRefresh() {
    this.countdown = 60;
    clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => {
      this.countdown--;
      const el = document.getElementById('refresh-countdown');
      if (el) el.textContent = this.countdown;
      if (this.countdown <= 0) {
        this.refresh();
        this.countdown = 60;
      }
    }, 1000);
  },

  refresh() {
    this.countdown = 60;
    switch (this.currentView) {
      case 'overview': this.loadOverview(); break;
      case 'agent': if (this.currentAgent) this.loadAgent(this.currentAgent); break;
      case 'compare': this.loadCompare(); break;
      case 'sessions': if (this.currentAgent) this.loadSessions(this.currentAgent); break;
    }
  },

  // --- Auth ---
  handleLogin(e) {
    e.preventDefault();
    const token = document.getElementById('login-token').value.trim();
    if (!token) return false;
    localStorage.setItem('dashboard_token', token);
    location.reload();
    return false;
  },

  logout() {
    localStorage.removeItem('dashboard_token');
    location.reload();
  },

  checkAuth() {
    const loginScreen = document.getElementById('login-screen');
    const appEl = document.getElementById('app');
    if (!this.token) {
      loginScreen.style.display = 'flex';
      appEl.style.display = 'none';
      return false;
    }
    loginScreen.style.display = 'none';
    appEl.style.display = '';
    return true;
  },

  // --- Init ---
  init() {
    if (!this.checkAuth()) return;

    // Nav click handlers
    document.querySelectorAll('.nav-item[data-view]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const view = el.dataset.view;
        if (view === 'agent' && el.dataset.agent) {
          this.navigate('agent', { agentId: el.dataset.agent });
        } else {
          this.navigate(view);
        }
      });
    });

    this.setupTableSort();
    this.startAutoRefresh();
    this.navigate('overview');
  },
};

document.addEventListener('DOMContentLoaded', () => app.init());

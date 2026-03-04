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
      case 'analysis': this.loadAnalysis(); break;
      case 'sessions': this.loadSessions(params.agentId); break;
      case 'session-detail': this.loadSessionDetail(params.agentId, params.sessionId); break;
    }
  },

  // --- Month State ---
  currentMonth: new Date().toISOString().slice(0, 7),

  monthNames: ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'],

  formatMonth(ym) {
    const [y, m] = ym.split('-');
    return this.monthNames[parseInt(m, 10) - 1] + ' ' + y;
  },

  prevMonth() {
    let [y, m] = this.currentMonth.split('-').map(Number);
    m--;
    if (m < 1) { m = 12; y--; }
    this.currentMonth = y + '-' + String(m).padStart(2, '0');
    this.loadMonthlyOverview();
  },

  nextMonth() {
    let [y, m] = this.currentMonth.split('-').map(Number);
    m++;
    if (m > 12) { m = 1; y++; }
    this.currentMonth = y + '-' + String(m).padStart(2, '0');
    this.loadMonthlyOverview();
  },

  // --- Overview ---
  async loadOverview() {
    this.loadMonthlyOverview();
    // Also load old overview for agent nav
    try {
      const data = await this.api('/stats/overview');
      this.overviewData = data;
      this.buildAgentNav(data.agents);
      // Populate agent filter
      const select = document.getElementById('overview-agent-filter');
      if (select && data.agents) {
        select.innerHTML = '<option value="">Wszyscy agenci</option>';
        for (const a of data.agents) {
          select.innerHTML += '<option value="' + a.agentId + '">' + this.getAgentName(a.agentId, data.agents) + '</option>';
        }
      }
    } catch {}
  },

  async loadMonthlyOverview() {
    document.getElementById('month-label').textContent = this.formatMonth(this.currentMonth);
    const agentFilter = document.getElementById('overview-agent-filter')?.value || '';
    const qs = agentFilter ? '&agent=' + agentFilter : '';

    try {
      const data = await this.api('/stats/monthly?month=' + this.currentMonth + qs);

      document.getElementById('stat-sessions').textContent = data.totals.sessions || 0;
      document.getElementById('stat-messages').textContent = data.totals.messages || 0;
      document.getElementById('stat-user-messages').textContent = data.totals.user_messages || 0;
      document.getElementById('stat-total-agents').textContent = data.totals.agents || 0;
      document.getElementById('stat-total-cost').textContent = '$' + (data.totals.cost || 0).toFixed(4);

      this.renderDailyActivityChart(data);
      this.renderAgentBarsChart(data);
    } catch (e) {
      console.error('Failed to load monthly overview:', e);
    }
  },

  renderDailyActivityChart(data) {
    const ctx = document.getElementById('chart-activity-daily');
    if (this.charts.activityDaily) this.charts.activityDaily.destroy();

    const dailyData = data.dailyTotals || [];

    this.charts.activityDaily = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: dailyData.map(d => d.date.slice(8)),
        datasets: [{
          label: 'Zapytania',
          data: dailyData.map(d => d.user_messages),
          backgroundColor: '#6366f199',
          borderColor: '#6366f1',
          borderWidth: 1,
        }, {
          label: 'Wszystkie',
          data: dailyData.map(d => d.messages),
          backgroundColor: '#22c55e44',
          borderColor: '#22c55e',
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#8b8fa3', font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' } },
          y: { ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' }, beginAtZero: true },
        },
      },
    });
  },

  renderAgentBarsChart(data) {
    const ctx = document.getElementById('chart-agent-bars');
    if (this.charts.agentBars) this.charts.agentBars.destroy();

    const agents = data.agents || [];
    if (agents.length === 0) return;

    const colors = ['#6366f1', '#22c55e', '#eab308', '#ef4444', '#ec4899', '#06b6d4', '#f97316'];

    this.charts.agentBars = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: agents.map(a => a.agent_name || a.agent_id),
        datasets: [{
          label: 'Zapytania',
          data: agents.map(a => a.user_messages),
          backgroundColor: agents.map((_, i) => colors[i % colors.length] + '99'),
          borderColor: agents.map((_, i) => colors[i % colors.length]),
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
      if (document.getElementById('agent-total-cost')) {
        document.getElementById('agent-total-cost').textContent = '$' + (data.totalCost || 0).toFixed(4);
      }
      if (document.getElementById('agent-total-cost-pln')) {
        document.getElementById('agent-total-cost-pln').textContent = (data.totalCostPLN || 0).toFixed(2) + ' PLN';
      }

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
      patryk: 'Patryk Gocek',
      patrykg: 'Patryk Gocek',
      anna: 'Anna Gnatowska',
      annag: 'Anna Gnatowska',
      paulina: 'Paulina Grunau',
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
      case 'overview': this.loadMonthlyOverview(); break;
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

  // --- Analysis ---
  async loadAnalysis() {
    this.checkOllamaStatus();

    // Set date picker to today
    const datePicker = document.getElementById('analysis-date');
    if (!datePicker.value) {
      datePicker.value = new Date().toISOString().split('T')[0];
    }

    // Populate agent filter
    this.populateAgentFilter();

    // Load available days list
    this.loadAvailableDays();

    // Try to load today's report if it exists
    this.loadDayReport(true);
  },

  async populateAgentFilter() {
    try {
      const agents = await this.api('/agents');
      const select = document.getElementById('analysis-agent-filter');
      select.innerHTML = '<option value="">Wszyscy agenci</option>';
      for (const agent of agents) {
        select.innerHTML += '<option value="' + agent.id + '">' + this.escapeHtml(agent.name) + '</option>';
      }
    } catch {}
  },

  async loadAvailableDays() {
    try {
      const days = await this.api('/analysis/days');
      const container = document.getElementById('analysis-days-list');
      if (days.length === 0) {
        container.innerHTML = '<div class="empty-state">Brak zapisanych analiz. Kliknij "⚡ Analizuj na żywo" aby uruchomić pierwszą analizę.</div>';
        return;
      }
      container.innerHTML = '<h3 style="margin-bottom:12px; color:var(--text-muted); font-size:12px; text-transform:uppercase; letter-spacing:1px;">Dostępne raporty</h3>';
      for (const day of days.slice(0, 14)) {
        container.innerHTML += '<div class="day-card" onclick="document.getElementById(\'analysis-date\').value=\'' + day + '\'; app.loadDayReport();">' +
          '<span class="day-card-date">' + day + '</span>' +
          '<span style="font-size:12px; color:var(--text-muted);">Kliknij aby otworzyć →</span>' +
          '</div>';
      }
    } catch {}
  },

  async loadDayReport(silent) {
    const dateStr = document.getElementById('analysis-date').value;
    const agentFilter = document.getElementById('analysis-agent-filter').value;
    if (!dateStr) return;

    try {
      const url = '/analysis/day/' + dateStr + (agentFilter ? '?agent=' + agentFilter : '');
      const report = await this.api(url);
      this.analysisReport = report;
      document.getElementById('analysis-days-list').innerHTML = '';
      this.renderAnalysisReport(report);
    } catch (e) {
      if (!silent) {
        document.getElementById('analysis-overview').style.display = 'none';
        document.getElementById('analysis-details').innerHTML = '<div class="empty-state">Brak raportu dla ' + dateStr + '. Kliknij "⚡ Analizuj na żywo" aby wygenerować.</div>';
      }
    }
  },

  async checkOllamaStatus() {
    try {
      const status = await this.api('/analysis/status');
      const badge = document.getElementById('ollama-status');
      if (status.online && status.modelAvailable) {
        badge.textContent = `● ${status.model}`;
        badge.className = 'ollama-badge online';
      } else if (status.online) {
        badge.textContent = `⚠ Model ${status.model} niedostępny`;
        badge.className = 'ollama-badge offline';
      } else {
        badge.textContent = '● Ollama offline';
        badge.className = 'ollama-badge offline';
      }
      // Scheduler status
      const schedEl = document.getElementById('scheduler-status');
      if (status.scheduler) {
        const s = status.scheduler;
        if (s.enabled) {
          schedEl.textContent = '🕐 Auto-analiza: ' + s.cronTime + (s.isRunning ? ' (w trakcie...)' : '');
        } else {
          schedEl.textContent = '⏸ Auto-analiza wyłączona';
        }
      }
    } catch {
      const badge = document.getElementById('ollama-status');
      badge.textContent = '● Błąd połączenia';
      badge.className = 'ollama-badge offline';
    }
  },

  async generateReport() {
    const statusBar = document.getElementById('analysis-status-bar');
    const progressText = document.getElementById('analysis-progress-text');
    const progressBar = document.getElementById('analysis-progress-bar');
    const overview = document.getElementById('analysis-overview');
    const details = document.getElementById('analysis-details');

    statusBar.style.display = 'block';
    overview.style.display = 'none';
    details.innerHTML = '<h3 style="margin-bottom:16px; color:var(--text-muted); font-size:12px; text-transform:uppercase; letter-spacing:1px;">Wyniki na żywo</h3>';
    progressText.textContent = 'Łączę z Ollama...';
    progressBar.style.width = '2%';

    const dateStr = document.getElementById('analysis-date').value || new Date().toISOString().split('T')[0];
    const tokenParam = this.token ? `&token=${encodeURIComponent(this.token)}` : '';
    const es = new EventSource(`/api/analysis/stream?date=${dateStr}${tokenParam}`);

    this.streamResults = { agents: [], model: '' };

    es.addEventListener('init', (e) => {
      const data = JSON.parse(e.data);
      this.streamResults.model = data.model;
      progressText.textContent = `Znaleziono ${data.totalSessions} sesji do analizy (${data.totalAgents} agentów) — model: ${data.model}`;
      progressBar.style.width = '5%';
    });

    es.addEventListener('agent-start', (e) => {
      const data = JSON.parse(e.data);
      const sessionsInfo = data.sessionsCount > 0 ? `${data.sessionsCount} sesji` : 'brak sesji';
      progressText.textContent = `🔍 ${data.agentName} (${data.agentIndex}/${data.totalAgents}) — ${sessionsInfo}...`;
    });

    es.addEventListener('session-start', (e) => {
      const data = JSON.parse(e.data);
      progressText.textContent = `🔍 ${data.agentName} — sesja ${data.sessionIndex}/${data.sessionsCount} (${data.messageCount} wiadomości)...`;
      progressBar.style.width = data.progress + '%';
    });

    es.addEventListener('session-done', (e) => {
      const data = JSON.parse(e.data);
      progressBar.style.width = data.progress + '%';

      if (!data.error) {
        progressText.textContent = `✅ ${data.agentName} — sesja gotowa (jakość: ${data.agentQuality}/10)`;
        this.appendSessionCard(data, details);
      } else {
        progressText.textContent = `⚠️ ${data.agentName} — ${data.error}`;
        this.appendErrorCard(data, details);
      }
    });

    es.addEventListener('agent-done', (e) => {
      const data = JSON.parse(e.data);
      this.streamResults.agents.push(data);
    });

    es.addEventListener('complete', (e) => {
      const report = JSON.parse(e.data);
      es.close();
      this.analysisReport = report;
      progressBar.style.width = '100%';
      progressText.textContent = '✅ Analiza zakończona!';
      setTimeout(() => {
        statusBar.style.display = 'none';
        this.renderAnalysisReport(report);
      }, 1500);
    });

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data);
        progressText.textContent = '❌ Błąd: ' + data.message;
      } catch {
        progressText.textContent = '❌ Połączenie przerwane';
      }
      es.close();
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      progressText.textContent = '❌ Połączenie z serwerem przerwane';
      es.close();
    };
  },

  appendSessionCard(data, container) {
    const qualityClass = data.agentQuality >= 7 ? '' : data.agentQuality >= 5 ? 'mid' : 'low';
    const sentimentClass = data.sentiment === 'negative' ? 'negative' : '';

    const card = document.createElement('div');
    card.className = 'analysis-card';
    card.style.animation = 'fadeSlideIn 0.4s ease';
    card.innerHTML = `
      <div class="analysis-card-header">
        <h4>${this.escapeHtml(data.agentName)} — sesja ${data.sessionId.substring(0, 8)}...</h4>
        <div class="analysis-badges">
          <span class="badge badge-quality ${qualityClass}">Jakość: ${data.agentQuality}/10</span>
          <span class="badge badge-sentiment ${sentimentClass}">${this.sentimentLabel(data.sentiment)}</span>
          ${data.taskCompleted ? '<span class="badge badge-quality">✓ Ukończone</span>' : '<span class="badge badge-quality low">✗ Nieukończone</span>'}
          ${data.escalationNeeded ? '<span class="badge badge-escalation">⚠ Eskalacja!</span>' : ''}
        </div>
      </div>
      <div class="analysis-summary">${this.escapeHtml(data.summary || '')}</div>
      <div class="analysis-topics-list" style="margin-bottom:8px;">
        ${(data.topics || []).map(t => `<span class="topic-tag">${this.escapeHtml(t)}</span>`).join('')}
      </div>
      ${data.keyInsights && data.keyInsights.length > 0 ? `
        <div class="analysis-insights">
          <ul>${data.keyInsights.map(i => `<li>${this.escapeHtml(i)}</li>`).join('')}</ul>
        </div>
      ` : ''}
      ${data.agentQualityReason ? `<div style="margin-top:8px; font-size:12px; color:var(--text-muted);">💡 ${this.escapeHtml(data.agentQualityReason)}</div>` : ''}
      <div style="margin-top:8px; font-size:11px; color:var(--text-muted); font-family:'Fira Code',monospace;">
        ${data.messageCount || '?'} wiadomości · ${data.processingTime ? (data.processingTime / 1000).toFixed(1) + 's' : '?'}
      </div>
    `;
    container.appendChild(card);
  },

  appendErrorCard(data, container) {
    const card = document.createElement('div');
    card.className = 'analysis-card';
    card.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    card.innerHTML = `
      <div class="analysis-card-header">
        <h4>${this.escapeHtml(data.agentName)} — sesja ${data.sessionId.substring(0, 8)}...</h4>
        <span class="badge badge-quality low">❌ Błąd</span>
      </div>
      <div class="analysis-summary" style="color:#f87171;">${this.escapeHtml(data.error)}</div>
    `;
    container.appendChild(card);
  },

  renderAnalysisReport(report) {
    const overview = document.getElementById('analysis-overview');
    overview.style.display = 'block';

    // Stats
    const totalSessions = report.agents.reduce((s, a) => s + a.sessionsAnalyzed, 0);
    const avgQuality = report.agents.filter(a => a.avgAgentQuality).length > 0
      ? (report.agents.reduce((s, a) => s + (a.avgAgentQuality || 0), 0) / report.agents.filter(a => a.avgAgentQuality).length).toFixed(1)
      : '-';
    const totalIssues = report.agents.reduce((s, a) => s + (a.issues || []).length, 0);
    const totalEscalations = report.agents.reduce((s, a) => s + a.escalationsNeeded, 0);

    document.getElementById('analysis-stats').innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${totalSessions}</div>
        <div class="stat-label">Sesji przeanalizowanych</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${avgQuality}</div>
        <div class="stat-label">Śr. jakość agenta</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${totalIssues}</div>
        <div class="stat-label">Wykrytych problemów</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="${totalEscalations > 0 ? 'color:#f87171' : ''}">${totalEscalations}</div>
        <div class="stat-label">Wymaga eskalacji</div>
      </div>
    `;

    // Agent quality chart
    this.renderAgentQualityChart(report);

    // Trend chart
    this.loadTrendChart();

    // Topics
    const allTopics = {};
    for (const agent of report.agents) {
      for (const t of (agent.topTopics || [])) {
        allTopics[t.topic] = (allTopics[t.topic] || 0) + t.count;
      }
    }
    const sortedTopics = Object.entries(allTopics).sort((a, b) => b[1] - a[1]).slice(0, 10);
    document.getElementById('analysis-topics').innerHTML = sortedTopics.length > 0
      ? '<div class="analysis-topics-list">' + sortedTopics.map(([t, c]) =>
        `<span class="topic-tag">${this.escapeHtml(t)} (${c})</span>`
      ).join('') + '</div>'
      : '<div class="empty-state" style="padding:20px">Brak danych</div>';

    // Issues
    const allIssues = report.agents.flatMap(a => (a.issues || []).map(i => ({
      ...i,
      agentName: a.agentName,
    })));
    document.getElementById('analysis-issues').innerHTML = allIssues.length > 0
      ? allIssues.map(i => `
        <div style="padding:8px 0; border-bottom:1px solid var(--border); font-size:13px;">
          <span style="color:var(--red)">⚠</span>
          <strong>${this.escapeHtml(i.agentName)}</strong>:
          ${this.escapeHtml(i.issue)}
        </div>
      `).join('')
      : '<div class="empty-state" style="padding:20px">Brak problemów 🎉</div>';

    // Detailed per-agent cards
    const details = document.getElementById('analysis-details');
    details.innerHTML = '<h3 style="margin-bottom:16px; color:var(--text-muted); font-size:12px; text-transform:uppercase; letter-spacing:1px;">Szczegóły per agent</h3>';

    for (const agent of report.agents) {
      for (const session of (agent.sessions || [])) {
        if (session.error) continue;

        const qualityClass = session.agentQuality >= 7 ? '' : session.agentQuality >= 5 ? 'mid' : 'low';
        const sentimentClass = session.sentiment === 'negative' ? 'negative' : '';
        const scoreDots = this.renderScoreDots(session.agentQuality || 0);

        details.innerHTML += `
          <div class="analysis-card">
            <div class="analysis-card-header">
              <h4>${this.escapeHtml(agent.agentName)} — sesja ${session.sessionId.substring(0, 8)}...</h4>
              <div class="analysis-badges">
                <span class="badge badge-quality ${qualityClass}">Jakość: ${session.agentQuality}/10</span>
                <span class="badge badge-sentiment ${sentimentClass}">${this.sentimentLabel(session.sentiment)}</span>
                ${session.taskCompleted ? '<span class="badge badge-quality">✓ Zadanie ukończone</span>' : '<span class="badge badge-quality low">✗ Nieukończone</span>'}
                ${session.escalationNeeded ? '<span class="badge badge-escalation">⚠ Eskalacja!</span>' : ''}
              </div>
            </div>
            <div class="analysis-summary">${this.escapeHtml(session.summary || '')}</div>
            <div class="analysis-topics-list" style="margin-bottom:8px;">
              ${(session.topics || []).map(t => `<span class="topic-tag">${this.escapeHtml(t)}</span>`).join('')}
            </div>
            ${session.keyInsights && session.keyInsights.length > 0 ? `
              <div class="analysis-insights">
                <ul>${session.keyInsights.map(i => `<li>${this.escapeHtml(i)}</li>`).join('')}</ul>
              </div>
            ` : ''}
            ${session.agentQualityReason ? `<div style="margin-top:8px; font-size:12px; color:var(--text-muted);">💡 ${this.escapeHtml(session.agentQualityReason)}</div>` : ''}
            <div style="margin-top:8px; font-size:11px; color:var(--text-muted); font-family:'Fira Code',monospace;">
              ${session.messageCount || '?'} wiadomości · ${session.processingTime ? (session.processingTime / 1000).toFixed(1) + 's' : '?'}
            </div>
          </div>
        `;
      }
    }
  },

  renderAgentQualityChart(report) {
    const ctx = document.getElementById('chart-agent-quality');
    if (this.charts.agentQuality) this.charts.agentQuality.destroy();

    const agents = report.agents.filter(a => a.avgAgentQuality !== null);
    if (agents.length === 0) return;

    this.charts.agentQuality = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: agents.map(a => a.agentName),
        datasets: [
          {
            label: 'Jakość agenta',
            data: agents.map(a => a.avgAgentQuality),
            backgroundColor: agents.map(a =>
              a.avgAgentQuality >= 7 ? '#22c55e99' : a.avgAgentQuality >= 5 ? '#eab30899' : '#ef444499'
            ),
            borderColor: agents.map(a =>
              a.avgAgentQuality >= 7 ? '#22c55e' : a.avgAgentQuality >= 5 ? '#eab308' : '#ef4444'
            ),
            borderWidth: 1,
          },
          {
            label: 'Sentiment',
            data: agents.map(a => (a.avgSentimentScore || 0) * 10),
            backgroundColor: '#3b82f699',
            borderColor: '#3b82f6',
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#8b8fa3', font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' } },
          y: { min: 0, max: 10, ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' } },
        },
      },
    });
  },

  async loadTrendChart() {
    try {
      const trend = await this.api('/analysis/trend?days=14');
      if (trend.length < 2) return;

      const ctx = document.getElementById('chart-quality-trend');
      if (this.charts.qualityTrend) this.charts.qualityTrend.destroy();

      this.charts.qualityTrend = new Chart(ctx, {
        type: 'line',
        data: {
          labels: trend.map(d => d.date.slice(5)),
          datasets: [
            {
              label: 'Jakość agenta',
              data: trend.map(d => d.avgQuality),
              borderColor: '#22c55e',
              backgroundColor: '#22c55e33',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
            },
            {
              label: 'Sentiment ×10',
              data: trend.map(d => d.avgSentiment ? d.avgSentiment * 10 : null),
              borderColor: '#3b82f6',
              backgroundColor: '#3b82f633',
              fill: false,
              tension: 0.3,
              pointRadius: 3,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { labels: { color: '#8b8fa3', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' } },
            y: { min: 0, max: 10, ticks: { color: '#5a5e72' }, grid: { color: '#2a2f42' } },
          },
        },
      });
    } catch {}
  },

  renderScoreDots(score) {
    let html = '<div class="score-dots">';
    for (let i = 1; i <= 10; i++) {
      const filled = i <= score;
      const cls = filled ? (score >= 7 ? 'filled' : score >= 5 ? 'filled mid' : 'filled low') : '';
      html += `<div class="score-dot ${cls}"></div>`;
    }
    return html + '</div>';
  },

  sentimentLabel(s) {
    switch (s) {
      case 'positive': return '😊 Pozytywny';
      case 'negative': return '😞 Negatywny';
      default: return '😐 Neutralny';
    }
  },

  async analyzeCurrentSession() {
    if (!this.currentAgent) return;
    // Get current session from detail view
    const title = document.getElementById('session-detail-title').textContent;
    const sessionId = title.replace('Sesja: ', '');
    if (!sessionId) return;

    try {
      const analysis = await this.api(`/agents/${this.currentAgent}/sessions/${sessionId}/analyze`, {
        method: 'POST',
      });
      alert(JSON.stringify(analysis, null, 2));
    } catch (e) {
      alert('Błąd: ' + e.message);
    }
  },

  // Override api to support POST
  async apiPost(endpoint) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    const res = await fetch(`/api${endpoint}`, { method: 'POST', headers });
    if (res.status === 401) { this.logout(); throw new Error('Unauthorized'); }
    return res.json();
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

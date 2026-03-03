const { listSessions, getSessionMessages } = require('./parser');

function getAgentStats(stateDir, agentId) {
  const sessions = listSessions(stateDir, agentId);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
  if (weekStart > todayStart) weekStart.setDate(weekStart.getDate() - 7);

  let totalMessages = 0;
  let totalUserMessages = 0;
  let todayMessages = 0;
  let weekMessages = 0;
  let todaySessions = 0;
  let weekSessions = 0;
  let lastActivity = null;

  // For heatmap: hours (0-23) x days (0-6, Mon=0)
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  // For timeline: last 30 days
  const timelineMap = {};
  // For daily activity (last 7 days per-agent)
  const dailyMap = {};

  for (const session of sessions) {
    totalMessages += session.messageCount;
    totalUserMessages += session.userMessageCount;

    if (!lastActivity || session.lastMessage > lastActivity) {
      lastActivity = session.lastMessage;
    }

    if (session.lastMessage >= todayStart) {
      todaySessions++;
      todayMessages += session.userMessageCount;
    }
    if (session.lastMessage >= weekStart) {
      weekSessions++;
      weekMessages += session.userMessageCount;
    }

    // Build heatmap and timeline from individual messages
    const messages = getSessionMessages(stateDir, agentId, session.id);
    for (const msg of messages) {
      if (!msg.timestamp) continue;
      const ts = new Date(msg.timestamp);
      if (isNaN(ts.getTime())) continue;

      // Heatmap
      let day = ts.getDay() - 1; // 0=Mon
      if (day < 0) day = 6; // Sunday
      const hour = ts.getHours();
      heatmap[day][hour]++;

      // Timeline (last 30 days)
      const dateKey = ts.toISOString().split('T')[0];
      timelineMap[dateKey] = (timelineMap[dateKey] || 0) + 1;

      // Daily map
      dailyMap[dateKey] = (dailyMap[dateKey] || 0) + 1;
    }
  }

  // Build timeline array for last 30 days
  const timeline = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    timeline.push({ date: key, count: timelineMap[key] || 0 });
  }

  // Top 5 most active days
  const topDays = Object.entries(dailyMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([date, count]) => ({ date, count }));

  // Average per day (based on days with activity)
  const activeDays = Object.keys(dailyMap).length || 1;
  const avgPerDay = Math.round((totalUserMessages / activeDays) * 10) / 10;

  return {
    sessionsTotal: sessions.length,
    sessionsWeek: weekSessions,
    sessionsToday: todaySessions,
    messagesTotal: totalMessages,
    userMessagesTotal: totalUserMessages,
    messagesToday: todayMessages,
    messagesWeek: weekMessages,
    avgPerDay,
    lastActivity,
    heatmap,
    timeline,
    topDays,
    dailyMap,
  };
}

function getOverviewStats(stateDir, agentIds) {
  const agents = [];
  let totalMessagesToday = 0;
  const globalDailyMap = {};
  const last7DaysActivity = {};

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const agentId of agentIds) {
    const stats = getAgentStats(stateDir, agentId);
    agents.push({ agentId, ...stats });
    totalMessagesToday += stats.messagesToday;

    // Merge daily maps
    for (const [date, count] of Object.entries(stats.dailyMap)) {
      globalDailyMap[date] = (globalDailyMap[date] || 0) + count;
    }

    // Last 7 days per agent
    const agentLast7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      agentLast7.push(stats.dailyMap[key] || 0);
    }
    last7DaysActivity[agentId] = agentLast7;
  }

  // Top 5 most active days globally
  const topDays = Object.entries(globalDailyMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([date, count]) => ({ date, count }));

  // Labels for last 7 days
  const last7DaysLabels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    last7DaysLabels.push(d.toISOString().split('T')[0]);
  }

  // Determine online/offline (active in last 24h = online)
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const agentsOnline = agents.filter(a => a.lastActivity && a.lastActivity >= oneDayAgo).length;

  return {
    agentCount: agentIds.length,
    agentsOnline,
    agentsOffline: agentIds.length - agentsOnline,
    totalMessagesToday,
    topDays,
    last7DaysLabels,
    last7DaysActivity,
    agents,
  };
}

function generateCsvExport(stateDir, agentId, dateFrom, dateTo) {
  const stats = getAgentStats(stateDir, agentId);
  const from = dateFrom ? new Date(dateFrom) : new Date(0);
  const to = dateTo ? new Date(dateTo) : new Date();

  const rows = [['Date', 'Messages']];
  for (const [date, count] of Object.entries(stats.dailyMap)) {
    const d = new Date(date);
    if (d >= from && d <= to) {
      rows.push([date, count]);
    }
  }
  rows.sort((a, b) => (a[0] > b[0] ? 1 : -1));
  return rows.map(r => r.join(',')).join('\n');
}

module.exports = { getAgentStats, getOverviewStats, generateCsvExport };

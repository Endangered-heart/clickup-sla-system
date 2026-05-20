require('dotenv').config();
const mysql = require('mysql2/promise');
const http = require('http');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'switchyard.proxy.rlwy.net',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'railway',
  port: process.env.DB_PORT || 39978,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

function generateId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

async function sendSlackAlert(message) {
  try {
    const token = process.env.SLACK_WEBHOOK;
    const channel = process.env.SLACK_CHANNEL;
    if (!token || !channel) return;

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ channel, text: message, unfurl_links: false })
    });

    const result = await response.json();
    if (result.ok) console.log('✓ Slack message sent');
    else console.error('Slack error:', result.error);
  } catch (error) {
    console.error('Slack send error:', error);
  }
}

function isReportTime() {
  const now = new Date();
  // Convert to IST (UTC+5:30)
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const hours = ist.getUTCHours();
  const minutes = ist.getUTCMinutes();
  // 9:00 AM IST or 5:00 PM IST (within a 5-min window)
  return (hours === 9 && minutes < 5) || (hours === 17 && minutes < 5);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', message: 'ClickUp SLA System running' }));
  }
  else if (req.method === 'GET' && req.url === '/debug-db') {
    try {
      const connection = await pool.getConnection();
      const [result] = await connection.query('SELECT COUNT(*) as count FROM issues');
      connection.release();
      res.writeHead(200);
      res.end(JSON.stringify({ database_status: 'connected', issues_count: result[0].count }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: error.message }));
    }
  }
  else if (req.method === 'POST' && req.url === '/sync') {
    try {
      await runSync();
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'synced' }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: error.message }));
    }
  }
  else if (req.method === 'POST' && req.url === '/report') {
    try {
      await sendReport();
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'report sent' }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: error.message }));
    }
  }
  else {
    res.writeHead(404);
    res.end(JSON.stringify({ status: 'not found' }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ClickUp SLA System running on port ${PORT}`);
});

async function runSync(withReport = false) {
  console.log(`[${new Date().toISOString()}] Starting sync...`);

  try {
    const clickupResponse = await fetch('https://api.clickup.com/api/v2/list/' + process.env.CLICKUP_LIST_ID + '/task', {
      headers: { 'Authorization': process.env.CLICKUP_API_KEY }
    });

    if (!clickupResponse.ok) throw new Error(`ClickUp API error: ${clickupResponse.status}`);

    const data = await clickupResponse.json();
    console.log(`✓ Received ${data.tasks.length} tasks from ClickUp`);

    const connection = await pool.getConnection();

    try {
      const [existingIssues] = await connection.query('SELECT id, clickup_task_id FROM issues');
      const existingIds = new Map(existingIssues.map(i => [i.clickup_task_id, i.id]));

      let insertCount = 0;
      let updateCount = 0;

      for (const task of data.tasks) {
        try {
          const clickupId = task.id;
          const title = task.name || 'Untitled';
          const status = task.status?.status || 'to_do';
          const priority = task.priority?.priority || null;
          const assignee = task.assigned_by?.username || null;
          const createdAt = new Date(parseInt(task.date_created));
          const updatedAt = new Date(parseInt(task.date_updated));

          if (existingIds.has(clickupId)) {
            await connection.query(
              `UPDATE issues SET title = ?, status = ?, priority = ?, updated_at = ? WHERE clickup_task_id = ?`,
              [title, status, priority, updatedAt, clickupId]
            );
            updateCount++;
          } else {
            const id = generateId();
            await connection.query(
              `INSERT INTO issues (id, clickup_task_id, title, status, priority, assignee, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [id, clickupId, title, status, priority, assignee, createdAt, updatedAt]
            );
            insertCount++;
            existingIds.set(clickupId, id);

            const slaDeadline = new Date(createdAt.getTime() + 6 * 60 * 60 * 1000);
            await connection.query(
              `INSERT IGNORE INTO issue_sla (issue_id, created_at, sla_deadline, total_blocked_seconds, sla_status)
               VALUES (?, ?, ?, 0, 'ACTIVE')`,
              [id, createdAt, slaDeadline]
            );
          }
        } catch (taskError) {
          console.error(`Error processing task ${task.id}:`, taskError.message);
        }
      }

      console.log(`✓ Sync complete: Inserted ${insertCount}, Updated ${updateCount}`);

      // Only send Slack report if explicitly requested
      if (withReport) {
        await sendReport(connection);
      }

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Fatal sync error:', error);
    throw error;
  }
}

async function sendReport(existingConnection) {
  const connection = existingConnection || await pool.getConnection();
  const shouldRelease = !existingConnection;

  try {
    const [statusBreakdown] = await connection.query(
      `SELECT status, COUNT(*) as count FROM issues GROUP BY status ORDER BY count DESC`
    );

    const [slaBreakdown] = await connection.query(`
      SELECT 
        sla_status,
        COUNT(*) as count,
        SUM(CASE WHEN NOW() > sla_deadline AND sla_status = 'ACTIVE' THEN 1 ELSE 0 END) as at_risk
      FROM issue_sla
      GROUP BY sla_status
    `);

    const [agingBreakdown] = await connection.query(`
      SELECT 
        CASE 
          WHEN TIMESTAMPDIFF(HOUR, i.created_at, NOW()) <= 2 THEN '0-2 hrs'
          WHEN TIMESTAMPDIFF(HOUR, i.created_at, NOW()) <= 4 THEN '2-4 hrs'
          WHEN TIMESTAMPDIFF(HOUR, i.created_at, NOW()) <= 6 THEN '4-6 hrs'
          ELSE '6+ hrs'
        END as age_bracket,
        COUNT(*) as count,
        SUM(CASE WHEN NOW() > s.sla_deadline AND s.sla_status = 'ACTIVE' THEN 1 ELSE 0 END) as breached
      FROM issues i
      LEFT JOIN issue_sla s ON i.id = s.issue_id
      GROUP BY age_bracket
      ORDER BY FIELD(age_bracket, '0-2 hrs', '2-4 hrs', '4-6 hrs', '6+ hrs')
    `);

    const statusEmojis = {
      'to do': ':white_circle:',
      'in progress': ':large_blue_circle:',
      'blocked': ':red_circle:',
      'live': ':green_circle:'
    };

    let message = `:chart_with_upwards_trend: *ClickUp SLA System - Ops Issues Report*\n\n`;
    message += `📊 *Status Breakdown:*\n`;
    for (const row of statusBreakdown) {
      const emoji = statusEmojis[row.status] || ':circle:';
      message += `${emoji} *${row.status.toUpperCase()}* — ${row.count} issue${row.count > 1 ? 's' : ''}\n`;
    }

    message += `\n⏱️ *SLA Status:*\n`;
    for (const row of slaBreakdown) {
      const slaEmoji = row.sla_status === 'BREACHED' ? ':x:' : row.sla_status === 'MET' ? ':white_check_mark:' : ':hourglass_flowing_sand:';
      message += `${slaEmoji} *${row.sla_status}* — ${row.count} issue${row.count > 1 ? 's' : ''}`;
      if (row.at_risk > 0) message += ` (${row.at_risk} at risk)`;
      message += `\n`;
    }

    message += `\n📅 *Issue Age:*\n`;
    for (const row of agingBreakdown) {
      if (row.age_bracket) {
        message += `  ${row.age_bracket} — ${row.count} issue${row.count > 1 ? 's' : ''}`;
        if (row.breached > 0) message += ` (${row.breached} breached)`;
        message += `\n`;
      }
    }

    message += `\n_Last synced: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} IST_`;

    await sendSlackAlert(message);

  } finally {
    if (shouldRelease) connection.release();
  }
}

// Sync every 5 minutes — NO Slack message
setInterval(() => {
  const shouldReport = isReportTime();
  runSync(shouldReport).catch(err => console.error('Scheduled sync failed:', err));
}, 5 * 60 * 1000);

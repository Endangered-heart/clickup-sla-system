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
    
    console.log(`[SLACK] Token exists: ${!!token}, Channel: ${channel}`);
    
    if (!token || !channel) {
      console.log('Slack not configured');
      return;
    }

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        channel: channel,
        text: message,
        unfurl_links: false
      })
    });

    const result = await response.json();
    console.log(`[SLACK] Response:`, result);
    if (result.ok) {
      console.log('✓ Slack message sent');
    } else {
      console.error('Slack error:', result.error);
    }
  } catch (error) {
    console.error('Slack send error:', error);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', message: 'ClickUp SLA System running' }));
  } 
  else if (req.method === 'GET' && req.url === '/debug-clickup') {
    try {
      const clickupResponse = await fetch('https://api.clickup.com/api/v2/list/' + process.env.CLICKUP_LIST_ID + '/task', {
        headers: { 'Authorization': process.env.CLICKUP_API_KEY }
      });

      if (!clickupResponse.ok) {
        throw new Error(`ClickUp API error: ${clickupResponse.status}`);
      }

      const data = await clickupResponse.json();
      
      if (!data.tasks || data.tasks.length === 0) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'error', message: 'No tasks from ClickUp' }));
        return;
      }

      const firstTask = data.tasks[0];
      res.writeHead(200);
      res.end(JSON.stringify({
        total_tasks: data.tasks.length,
        first_task: {
          id: firstTask.id,
          name: firstTask.name,
          status: firstTask.status?.status,
          priority: firstTask.priority?.priority
        }
      }, null, 2));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: error.message }));
    }
  }
  else if (req.method === 'GET' && req.url === '/debug-db') {
    try {
      const connection = await pool.getConnection();
      const [result] = await connection.query('SELECT COUNT(*) as count FROM issues');
      connection.release();

      res.writeHead(200);
      res.end(JSON.stringify({
        database_status: 'connected',
        issues_count: result[0].count
      }, null, 2));
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
  else if (req.method === 'POST' && req.url === '/test-slack') {
    await sendSlackAlert('🧪 Test message from ClickUp SLA System');
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'test sent' }));
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

async function runSync() {
  console.log(`[${new Date().toISOString()}] Starting sync...`);

  try {
    const clickupResponse = await fetch('https://api.clickup.com/api/v2/list/' + process.env.CLICKUP_LIST_ID + '/task', {
      headers: { 'Authorization': process.env.CLICKUP_API_KEY }
    });

    if (!clickupResponse.ok) {
      throw new Error(`ClickUp API error: ${clickupResponse.status}`);
    }

    const data = await clickupResponse.json();
    console.log(`✓ Received ${data.tasks.length} tasks from ClickUp`);

    const connection = await pool.getConnection();

    try {
      const [existingIssues] = await connection.query('SELECT clickup_task_id FROM issues');
      const existingIds = new Set(existingIssues.map(i => i.clickup_task_id));
      console.log(`Found ${existingIds.size} existing issues in DB`);

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
            existingIds.add(clickupId);
          }
        } catch (taskError) {
          console.error(`Error processing task ${task.id}:`, taskError.message);
        }
      }

      console.log(`✓ Sync complete: Inserted ${insertCount}, Updated ${updateCount}`);

    } finally {
      connection.release();
    }

    console.log(`✓ Sync completed at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('Fatal sync error:', error);
    throw error;
  }
}

runSync().catch(err => console.error('Startup sync failed:', err));

setInterval(() => {
  runSync().catch(err => console.error('Scheduled sync failed:', err));
}, 5 * 60 * 1000);

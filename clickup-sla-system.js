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

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', message: 'ClickUp SLA System running' }));
  } 
  else if (req.method === 'GET' && req.url === '/debug-clickup') {
    try {
      console.log('[DEBUG] Fetching ClickUp API...');
      const clickupResponse = await fetch('https://api.clickup.com/api/v2/list/' + process.env.CLICKUP_LIST_ID + '/task', {
        headers: { 'Authorization': process.env.CLICKUP_API_KEY }
      });

      if (!clickupResponse.ok) {
        throw new Error(`ClickUp API error: ${clickupResponse.status}`);
      }

      const data = await clickupResponse.json();
      
      if (!data.tasks || data.tasks.length === 0) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'error', message: 'No tasks from ClickUp', api_response: data }));
        return;
      }

      const firstTask = data.tasks[0];
      
      const analysis = {
        total_tasks: data.tasks.length,
        first_task: {
          id: firstTask.id,
          name: firstTask.name,
          status_structure: firstTask.status,
          status_extracted: firstTask.status?.status || null,
          priority_structure: firstTask.priority,
          priority_extracted: firstTask.priority?.priority || null,
          date_created_raw: firstTask.date_created,
          date_created_type: typeof firstTask.date_created,
          date_created_parsed: firstTask.date_created ? new Date(parseInt(firstTask.date_created)).toISOString() : null,
          date_updated_raw: firstTask.date_updated,
          date_updated_parsed: firstTask.date_updated ? new Date(parseInt(firstTask.date_updated)).toISOString() : null,
          assigned_by: firstTask.assigned_by,
          creator: firstTask.creator,
          custom_fields: firstTask.custom_fields ? firstTask.custom_fields.slice(0, 3) : [],
        },
        task_keys: Object.keys(firstTask),
        sample_tasks: data.tasks.slice(0, 3).map(t => ({ id: t.id, name: t.name, status: t.status?.status }))
      };

      res.writeHead(200);
      res.end(JSON.stringify(analysis, null, 2));
    } catch (error) {
      console.error('[DEBUG ERROR]', error.message);
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: error.message }));
    }
  }
  else if (req.method === 'GET' && req.url === '/debug-db') {
    try {
      const connection = await pool.getConnection();
      const [issuesCount] = await connection.query('SELECT COUNT(*) as count FROM issues');
      const [slaCount] = await connection.query('SELECT COUNT(*) as count FROM issue_sla');
      const [recent] = await connection.query('SELECT id, clickup_id, name, status, created_at FROM issues ORDER BY created_at DESC LIMIT 5');
      connection.release();

      res.writeHead(200);
      res.end(JSON.stringify({
        database_status: 'connected',
        issues_count: issuesCount[0].count,
        sla_count: slaCount[0].count,
        recent_issues: recent
      }, null, 2));
    } catch (error) {
      console.error('[DEBUG DB ERROR]', error.message);
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: error.message, database_status: 'disconnected' }));
    }
  }
  else if (req.method === 'POST' && req.url === '/sync') {
    try {
      await runSync();
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'synced' }));
    } catch (error) {
      console.error('Sync error:', error);
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

async function runSync() {
  console.log(`[${new Date().toISOString()}] Starting sync...`);

  try {
    console.log('Fetching tasks from ClickUp...');
    const clickupResponse = await fetch('https://api.clickup.com/api/v2/list/' + process.env.CLICKUP_LIST_ID + '/task', {
      headers: { 'Authorization': process.env.CLICKUP_API_KEY }
    });

    if (!clickupResponse.ok) {
      throw new Error(`ClickUp API error: ${clickupResponse.status}`);
    }

    const data = await clickupResponse.json();
    console.log(`✓ Received ${data.tasks.length} tasks from ClickUp`);

    if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
      console.warn('⚠ No tasks returned from ClickUp API');
      return;
    }

    const connection = await pool.getConnection();

    try {
      const [existingIssues] = await connection.query('SELECT clickup_id FROM issues');
      const existingIds = new Set(existingIssues.map(i => i.clickup_id));
      console.log(`Found ${existingIds.size} existing issues in DB`);

      let insertCount = 0;
      let updateCount = 0;

      for (const task of data.tasks) {
        try {
          const clickupId = task.id;
          const name = task.name || 'Untitled';
          const status = task.status?.status || 'to_do';
          const priority = task.priority?.priority || null;
          
          let createdAt, updatedAt;
          try {
            createdAt = new Date(parseInt(task.date_created)).toISOString().slice(0, 19).replace('T', ' ');
            updatedAt = new Date(parseInt(task.date_updated)).toISOString().slice(0, 19).replace('T', ' ');
          } catch (dateErr) {
            console.warn(`Warning: Could not parse dates for task ${clickupId}`);
            createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
            updatedAt = createdAt;
          }

          const assigneeId = task.assigned_by?.id || null;
          const creatorId = task.creator?.id || null;

          let severity = null;
          if (task.custom_fields && Array.isArray(task.custom_fields)) {
            const severityField = task.custom_fields.find(f => 
              f.id === 'e5b9356d-08b0-4e70-a2f4-4ec4b44561fc' || f.name?.toLowerCase() === 'issue severity'
            );
            if (severityField && severityField.value) {
              severity = severityField.value;
            }
          }

          if (existingIds.has(clickupId)) {
            await connection.query(
              `UPDATE issues SET name = ?, status = ?, priority = ?, severity = ?, updated_at = ? WHERE clickup_id = ?`,
              [name, status, priority, severity, updatedAt, clickupId]
            );
            updateCount++;
          } else {
            await connection.query(
              `INSERT INTO issues (clickup_id, name, status, priority, severity, assignee, creator, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [clickupId, name, status, priority, severity, assigneeId, creatorId, createdAt, updatedAt]
            );
            insertCount++;
            existingIds.add(clickupId);

            const [newIssue] = await connection.query(
              `SELECT id FROM issues WHERE clickup_id = ? LIMIT 1`,
              [clickupId]
            );

            if (newIssue.length > 0) {
              const issueId = newIssue[0].id;
              const slaStart = createdAt;
              const slaDeadline = new Date(parseInt(task.date_created) + 6 * 60 * 60 * 1000)
                .toISOString().slice(0, 19).replace('T', ' ');

              await connection.query(
                `INSERT INTO issue_sla (issue_id, sla_start, sla_deadline, blocked_duration_mins, sla_status)
                 VALUES (?, ?, ?, 0, 'ACTIVE')`,
                [issueId, slaStart, slaDeadline]
              );

              await connection.query(
                `INSERT INTO issue_status_history (issue_id, old_status, new_status, changed_at)
                 VALUES (?, 'none', ?, ?)`,
                [issueId, status, slaStart]
              );
            }
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

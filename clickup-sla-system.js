#!/usr/bin/env node

const https = require('https');
const mysql = require('mysql2/promise');
require('dotenv').config();

const CONFIG = {
  CLICKUP_API_KEY: process.env.CLICKUP_API_KEY,
  CLICKUP_LIST_ID: process.env.CLICKUP_LIST_ID,
  MYSQL_URL: process.env.MYSQL_URL,
  SLACK_WEBHOOK: process.env.SLACK_WEBHOOK,
  SLACK_CHANNEL: process.env.SLACK_CHANNEL || '#ops-tech-issues',
  SLACK_MENTION_GROUP: process.env.SLACK_MENTION_GROUP || '@support-engg'
};

const SLA_SECONDS = 6 * 60 * 60;
const AT_RISK_THRESHOLD = 30 * 60;

let db;

async function initDb() {
  try {
    if (CONFIG.MYSQL_URL) {
      db = await mysql.createConnection(CONFIG.MYSQL_URL);
    } else {
      db = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '3306'),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
      });
    }
    console.log('✓ Database connected');
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    throw error;
  }
}

async function fetchClickUpTasks() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.clickup.com',
      port: 443,
      path: `/api/v2/list/${CONFIG.CLICKUP_LIST_ID}/task?include_subtasks=false`,
      method: 'GET',
      headers: { 'Authorization': CONFIG.CLICKUP_API_KEY }
    };

    https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response.tasks || []);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject).end();
  });
}

async function syncTaskToDb(task) {
  const mapStatus = (cuStatus) => {
    const map = { 'to do': 'to_do', 'in progress': 'in_progress', 'blocked': 'blocked', 'live': 'live', 'closed': 'closed' };
    return map[cuStatus?.toLowerCase()] || 'to_do';
  };

  const status = mapStatus(task.status?.status);
  const assignee = task.assignees?.[0]?.username || null;

  try {
    const [result] = await db.execute(
      `INSERT INTO issues (id, clickup_task_id, title, description, assignee, priority, status, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), status = VALUES(status), updated_at = NOW()`,
      [task.id, task.id, task.name, task.description || null, assignee, task.priority?.priority || 'medium', status, new Date(task.date_created), status === 'closed' ? new Date() : null]
    );

    if (result.affectedRows === 1) {
      const slaDeadline = new Date(Date.now() + SLA_SECONDS * 1000);
      await db.execute(`INSERT INTO issue_sla (issue_id, created_at, sla_deadline, sla_status) VALUES (?, NOW(), ?, 'OPEN')`, [task.id, slaDeadline]);
    }
  } catch (error) {
    console.error(`✗ Failed to sync task ${task.id}:`, error.message);
  }
}

async function checkSLAsAndAlert() {
  try {
    const [issues] = await db.execute(
      `SELECT i.id, i.clickup_task_id, i.title, i.assignee, i.status, TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining
       FROM issues i JOIN issue_sla s ON i.id = s.issue_id
       WHERE i.status IN ('to_do', 'in_progress', 'live') AND TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < ? AND NOT EXISTS (SELECT 1 FROM slack_notifications sn WHERE sn.issue_id = i.id AND DATE(sn.sent_at) = CURDATE())`,
      [AT_RISK_THRESHOLD]
    );

    for (const issue of issues) {
      const notificationType = issue.seconds_remaining < 0 ? 'sla_breached' : 'sla_warning';
      const message = {
        channel: CONFIG.SLACK_CHANNEL,
        text: `${CONFIG.SLACK_MENTION_GROUP} ${notificationType === 'sla_breached' ? 'SLA BREACHED ⚠️' : 'SLA AT RISK ⏰'}`,
        attachments: [{
          color: notificationType === 'sla_breached' ? 'danger' : 'warning',
          fields: [
            { title: 'Issue', value: `[${issue.id}] ${issue.title}`, short: false },
            { title: 'Status', value: issue.status, short: true },
            { title: 'Assignee', value: issue.assignee || 'Unassigned', short: true }
          ]
        }]
      };

      await sendSlackMessage(message, issue.id, notificationType);
    }
  } catch (error) {
    console.error('✗ Error checking SLAs:', error.message);
  }
}

async function sendSlackMessage(payload, issueId, notificationType) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const hookPath = CONFIG.SLACK_WEBHOOK.split('hooks.slack.com')[1];
    
    const options = {
      hostname: 'hooks.slack.com',
      path: hookPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };

    https.request(options, (res) => {
      res.statusCode === 200 ? resolve() : reject(new Error(`Slack returned ${res.statusCode}`));
      res.on('data', () => {});
    }).on('error', reject).end(data);
  });
}

async function main() {
  console.log('🚀 Starting ClickUp → Slack SLA System...');
  try {
    await initDb();
    const tasks = await fetchClickUpTasks();
    console.log(`✓ Syncing ${tasks.length} tasks...`);
    
    for (const task of tasks) {
      await syncTaskToDb(task);
    }

    const hour = new Date().getHours();
    if (hour === 9 || hour === 17) {
      console.log('📢 Checking SLAs...');
      await checkSLAsAndAlert();
    }

    console.log('✓ Complete');
    process.exit(0);
  } catch (error) {
    console.error('Fatal:', error.message);
    process.exit(1);
  } finally {
    if (db) await db.end();
  }
}

if (require.main === module) {
  main();
}

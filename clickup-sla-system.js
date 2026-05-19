#!/usr/bin/env node

/**
 * ClickUp Issues Management System
 * - Syncs ClickUp tasks as source of truth
 * - Tracks SLA (6 hours per issue)
 * - Pauses SLA when blocked
 * - Sends Slack alerts at 9 AM & 5 PM for at-risk/breached SLAs
 */

const https = require('https');
const mysql = require('mysql2/promise');
require('dotenv').config();

const CONFIG = {
  CLICKUP_API_KEY: process.env.CLICKUP_API_KEY,
  CLICKUP_LIST_ID: process.env.CLICKUP_LIST_ID,
  
  DB_HOST: process.env.DB_HOST,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_NAME: process.env.DB_NAME,
  DB_PORT: parseInt(process.env.DB_PORT || '3306'),
  
  SLACK_WEBHOOK: process.env.SLACK_WEBHOOK,
  SLACK_CHANNEL: process.env.SLACK_CHANNEL || '#incidents',
  SLACK_MENTION_GROUP: process.env.SLACK_MENTION_GROUP || '@support-engg'
};

const SLA_SECONDS = 6 * 60 * 60;
const AT_RISK_THRESHOLD = 30 * 60;

let db;

async function initDb() {
  try {
    db = await mysql.createConnection({
      host: CONFIG.DB_HOST,
      port: CONFIG.DB_PORT,
      user: CONFIG.DB_USER,
      password: CONFIG.DB_PASSWORD,
      database: CONFIG.DB_NAME,
      waitForConnections: true,
      connectionLimit: 1,
      queueLimit: 0,
      timeout: 30000,
      enableKeepAlive: true,
      keepAliveInitialDelayMs: 0
    });
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
      path: `/api/v2/list/${CONFIG.CLICKUP_LIST_ID}/task?include_subtasks=false&include_archived=false`,
      method: 'GET',
      headers: { 'Authorization': CONFIG.CLICKUP_API_KEY }
    };

    https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log(`✓ Fetched ${response.tasks.length} tasks from ClickUp`);
          resolve(response.tasks);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject).end();
  });
}

async function syncTaskToDb(task) {
  const mapStatus = (cuStatus) => {
    const statusMap = {
      'to do': 'to_do',
      'in progress': 'in_progress',
      'blocked': 'blocked',
      'live': 'live',
      'closed': 'closed'
    };
    return statusMap[cuStatus?.toLowerCase()] || 'to_do';
  };

  const status = mapStatus(task.status?.status);
  const assignee = task.assignees?.[0]?.username || null;

  try {
    const [result] = await db.execute(
      `INSERT INTO issues 
       (id, clickup_task_id, title, description, assignee, priority, status, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE
       title = VALUES(title),
       description = VALUES(description),
       assignee = VALUES(assignee),
       priority = VALUES(priority),
       status = VALUES(status),
       updated_at = NOW(),
       closed_at = IF(VALUES(status) = 'closed', NOW(), closed_at)`,
      [
        task.id,
        task.id,
        task.name,
        task.description || null,
        assignee,
        task.priority?.priority || 'medium',
        status,
        new Date(task.date_created),
        status === 'closed' ? new Date() : null
      ]
    );

    if (result.affectedRows === 1) {
      const slaDeadline = new Date(Date.now() + SLA_SECONDS * 1000);
      await db.execute(
        `INSERT INTO issue_sla (issue_id, created_at, sla_deadline, sla_status)
         VALUES (?, NOW(), ?, 'OPEN')`,
        [task.id, slaDeadline]
      );
      console.log(`✓ Created new issue: ${task.id}`);
    }

    return task.id;
  } catch (error) {
    console.error(`✗ Failed to sync task ${task.id}:`, error);
  }
}

async function checkSLAsAndAlert() {
  try {
    const [issues] = await db.execute(
      `SELECT 
        i.id, i.clickup_task_id, i.title, i.assignee, i.status,
        s.sla_deadline, s.total_blocked_seconds, i.created_at,
        TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining,
        CASE 
          WHEN i.status = 'blocked' THEN 'PAUSED'
          WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 0 THEN 'BREACHED'
          WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < ? THEN 'AT_RISK'
          ELSE 'OPEN'
        END as sla_status
      FROM issues i
      JOIN issue_sla s ON i.id = s.issue_id
      WHERE i.status IN ('to_do', 'in_progress', 'live')
        AND (
          TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 0
          OR TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM slack_notifications sn
          WHERE sn.issue_id = i.id
          AND DATE(sn.sent_at) = CURDATE()
          AND sn.notification_type IN ('sla_warning', 'sla_breached')
        )`,
      [AT_RISK_THRESHOLD, AT_RISK_THRESHOLD]
    );

    console.log(`Found ${issues.length} issues needing alerts`);

    for (const issue of issues) {
      const timeRemaining = formatSeconds(Math.max(0, issue.seconds_remaining));
      const notificationType = issue.seconds_remaining < 0 ? 'sla_breached' : 'sla_warning';

      const message = {
        channel: CONFIG.SLACK_CHANNEL,
        text: notificationType === 'sla_breached' ? 'SLA BREACHED ⚠️' : 'SLA AT RISK ⏰',
        attachments: [
          {
            color: notificationType === 'sla_breached' ? 'danger' : 'warning',
            fields: [
              {
                title: 'Issue',
                value: `[${issue.id}] ${issue.title}`,
                short: false
              },
              {
                title: 'Status',
                value: issue.status,
                short: true
              },
              {
                title: 'Assignee',
                value: issue.assignee || 'Unassigned',
                short: true
              },
              {
                title: notificationType === 'sla_breached' ? 'Breached by' : 'Time Remaining',
                value: timeRemaining,
                short: true
              },
              {
                title: 'SLA',
                value: '6 hours',
                short: true
              }
            ]
          }
        ]
      };

      message.text = `${CONFIG.SLACK_MENTION_GROUP} ${message.text}`;
      await sendSlackMessage(message, issue.id, notificationType);
    }

  } catch (error) {
    console.error('✗ Error checking SLAs:', error);
  }
}

async function sendSlackMessage(payload, issueId, notificationType) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'hooks.slack.com',
      path: CONFIG.SLACK_WEBHOOK.split('hooks.slack.com')[1],
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', async () => {
        if (res.statusCode === 200) {
          try {
            await db.execute(
              `INSERT INTO slack_notifications 
               (issue_id, notification_type, slack_channel, message_content)
               VALUES (?, ?, ?, ?)`,
              [issueId, notificationType, CONFIG.SLACK_CHANNEL, JSON.stringify(payload)]
            );
            console.log(`✓ Slack alert sent for ${issueId}`);
          } catch (e) {
            console.error(`✗ Failed to log Slack notification:`, e);
          }
          resolve();
        } else {
          reject(new Error(`Slack API returned ${res.statusCode}`));
        }
      });
    }).on('error', reject).end(data);
  });
}

function formatSeconds(seconds) {
  if (seconds < 0) {
    const absSeconds = Math.abs(seconds);
    const hours = Math.floor(absSeconds / 3600);
    const mins = Math.floor((absSeconds % 3600) / 60);
    return `${hours}h ${mins}m ago`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function isAlertTime() {
  const hour = new Date().getHours();
  return hour === 9 || hour === 17;
}

async function main() {
  console.log('🚀 Starting ClickUp → Slack SLA System...');
  
  try {
    await initDb();
    const tasks = await fetchClickUpTasks();

    for (const task of tasks) {
      await syncTaskToDb(task);
    }

    if (isAlertTime()) {
      console.log('📢 Alert time detected (9 AM or 5 PM), checking SLAs...');
      await checkSLAsAndAlert();
    } else {
      console.log('⏭ Not alert time yet (checking at 9 AM & 5 PM IST)');
    }

    console.log('✓ System check complete');
    process.exit(0);

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    if (db) await db.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkSLAsAndAlert, syncTaskToDb };

# ClickUp SLA System - Quick Reference & SQL Queries

## System Status

```sql
-- Count of all issues by status
SELECT status, COUNT(*) as count FROM issues GROUP BY status;

-- Issues that are at risk or breached (RIGHT NOW)
SELECT 
  i.title,
  i.assignee,
  i.status,
  TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining,
  CASE 
    WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 0 THEN '⚠️ BREACHED'
    WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 1800 THEN '⏰ AT RISK'
    ELSE '✓ OK'
  END as alert_status
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE i.status IN ('to_do', 'in_progress', 'live')
ORDER BY s.sla_deadline ASC;
```

## Issue Operations

### Get a specific issue with full SLA info
```sql
SELECT 
  i.id,
  i.title,
  i.assignee,
  i.status,
  i.created_at,
  s.sla_deadline,
  s.total_blocked_seconds,
  TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining,
  ROUND((TIMESTAMPDIFF(SECOND, i.created_at, NOW()) - s.total_blocked_seconds) / 21600 * 100, 2) as sla_used_percent
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE i.id = '[ISSUE_ID]';
```

### Find all issues for an assignee
```sql
SELECT 
  i.title,
  i.status,
  s.sla_deadline,
  TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE i.assignee = 'john.doe'
  AND i.status IN ('to_do', 'in_progress', 'blocked', 'live')
ORDER BY s.sla_deadline ASC;
```

### List all currently blocked issues (and how long they've been blocked)
```sql
SELECT 
  i.id,
  i.title,
  i.assignee,
  sh.blocked_start_time,
  TIMESTAMPDIFF(HOUR, sh.blocked_start_time, NOW()) as blocked_hours,
  i.created_at,
  s.sla_deadline
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
JOIN issue_status_history sh ON i.id = sh.issue_id 
  AND sh.new_status = 'blocked'
  AND sh.blocked_duration_seconds IS NULL
WHERE i.status = 'blocked'
ORDER BY sh.blocked_start_time ASC;
```

### Get the issue with the least time remaining
```sql
SELECT 
  i.id,
  i.title,
  i.assignee,
  i.status,
  TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining,
  ROUND((TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) / 60), 1) as minutes_remaining
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE i.status IN ('to_do', 'in_progress', 'live')
  AND TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) > 0
ORDER BY seconds_remaining ASC
LIMIT 1;
```

## SLA Metrics

### Daily SLA performance
```sql
SELECT 
  DATE(i.closed_at) as date,
  COUNT(*) as total_closed,
  SUM(CASE WHEN s.sla_status = 'MET' THEN 1 ELSE 0 END) as met,
  SUM(CASE WHEN s.sla_status = 'BREACHED' THEN 1 ELSE 0 END) as breached,
  ROUND(
    (SUM(CASE WHEN s.sla_status = 'MET' THEN 1 ELSE 0 END) / COUNT(*)) * 100,
    1
  ) as sla_met_percentage
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE i.status = 'closed'
  AND i.closed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY DATE(i.closed_at)
ORDER BY DATE(i.closed_at) DESC;
```

### SLA performance per assignee
```sql
SELECT 
  i.assignee,
  COUNT(*) as total_closed,
  SUM(CASE WHEN s.sla_status = 'MET' THEN 1 ELSE 0 END) as met,
  SUM(CASE WHEN s.sla_status = 'BREACHED' THEN 1 ELSE 0 END) as breached,
  ROUND(
    (SUM(CASE WHEN s.sla_status = 'MET' THEN 1 ELSE 0 END) / COUNT(*)) * 100,
    1
  ) as sla_met_percentage,
  ROUND(AVG(TIMESTAMPDIFF(HOUR, i.created_at, i.closed_at)), 1) as avg_resolution_hours
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE i.status = 'closed'
  AND i.closed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY i.assignee
ORDER BY sla_met_percentage DESC;
```

### Blocked time analysis
```sql
SELECT 
  i.id,
  i.title,
  i.assignee,
  ROUND(s.total_blocked_seconds / 3600, 1) as blocked_hours,
  ROUND((s.total_blocked_seconds / (TIMESTAMPDIFF(SECOND, i.created_at, COALESCE(i.closed_at, NOW())))) * 100, 1) as blocked_percentage
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE s.total_blocked_seconds > 0
  AND i.closed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
ORDER BY s.total_blocked_seconds DESC;
```

## Manual Operations

### Manually extend SLA for an issue (e.g., add 2 more hours)
```sql
UPDATE issue_sla
SET sla_deadline = DATE_ADD(sla_deadline, INTERVAL 2 HOUR)
WHERE issue_id = '[ISSUE_ID]';
```

### Manually mark issue as SLA met (even if not closed yet)
```sql
UPDATE issue_sla
SET sla_status = 'MET'
WHERE issue_id = '[ISSUE_ID]';
```

### Manually add blocked time (if tracking was missed)
```sql
UPDATE issue_sla
SET total_blocked_seconds = total_blocked_seconds + 3600 -- Add 1 hour
WHERE issue_id = '[ISSUE_ID]';
```

### Reset an issue's SLA (start over)
```sql
UPDATE issue_sla
SET 
  sla_deadline = DATE_ADD(NOW(), INTERVAL 6 HOUR),
  total_blocked_seconds = 0,
  sla_status = 'OPEN'
WHERE issue_id = '[ISSUE_ID]';
```

## Slack Notifications

### View all Slack notifications sent
```sql
SELECT 
  sn.issue_id,
  sn.notification_type,
  sn.sent_at,
  i.title
FROM slack_notifications sn
JOIN issues i ON sn.issue_id = i.id
ORDER BY sn.sent_at DESC
LIMIT 20;
```

### Issues that were alerted today
```sql
SELECT 
  DISTINCT i.id,
  i.title,
  i.assignee,
  sn.notification_type,
  sn.sent_at
FROM slack_notifications sn
JOIN issues i ON sn.issue_id = i.id
WHERE DATE(sn.sent_at) = CURDATE()
ORDER BY sn.sent_at DESC;
```

## Debugging

### Check last sync time
```sql
SELECT 
  MAX(updated_at) as last_sync,
  COUNT(*) as total_issues
FROM issues;
```

### Issues with incomplete SLA records
```sql
SELECT 
  i.id,
  i.title,
  i.status
FROM issues i
LEFT JOIN issue_sla s ON i.id = s.issue_id
WHERE s.id IS NULL;
```

### Status changes for a specific issue
```sql
SELECT 
  previous_status,
  new_status,
  changed_at
FROM issue_status_history
WHERE issue_id = '[ISSUE_ID]'
ORDER BY changed_at DESC;
```

## Alerts & Monitoring

### Check if system is running (last update)
```sql
SELECT 
  MAX(updated_at) as last_updated,
  NOW() as current_time,
  TIMESTAMPDIFF(MINUTE, MAX(updated_at), NOW()) as minutes_since_update
FROM issues;
```

### Verify Slack webhook is working
```sql
SELECT 
  COUNT(*) as notifications_sent_today,
  MAX(sent_at) as last_notification
FROM slack_notifications
WHERE DATE(sent_at) = CURDATE();
```

### Issues due to breach in next 30 minutes
```sql
SELECT 
  i.id,
  i.title,
  i.assignee,
  ROUND(TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) / 60, 1) as minutes_remaining
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE i.status IN ('to_do', 'in_progress', 'live')
  AND TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) BETWEEN 0 AND 1800
ORDER BY s.sla_deadline ASC;
```

## Export Data

### Export all issues (last 7 days)
```sql
SELECT 
  i.id,
  i.title,
  i.assignee,
  i.status,
  i.created_at,
  i.closed_at,
  s.sla_deadline,
  ROUND(s.total_blocked_seconds / 3600, 2) as blocked_hours,
  s.sla_status
FROM issues i
JOIN issue_sla s ON i.id = s.issue_id
WHERE i.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
ORDER BY i.created_at DESC
INTO OUTFILE '/tmp/issues_export.csv'
FIELDS TERMINATED BY ','
ENCLOSED BY '"'
LINES TERMINATED BY '\n';
```

## Quick Commands

```bash
# Test the system
npm run test

# Run sync manually
npm run sync

# Check SLAs manually
npm run check-sla

# View Docker logs
docker logs [container_id] -f

# SSH into Cloud Run
gcloud run services describe clickup-sla-system --format='value(status.url)'
```

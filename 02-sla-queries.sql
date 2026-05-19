-- ============================================
-- SLA CALCULATION QUERIES
-- ============================================

-- 1. Calculate current SLA status for an issue
-- Run this to get real-time SLA info
SELECT 
  i.id,
  i.clickup_task_id,
  i.title,
  i.assignee,
  i.status,
  i.created_at,
  s.sla_deadline,
  s.total_blocked_seconds,
  
  -- Calculate effective time elapsed (excluding blocked time)
  TIMESTAMPDIFF(SECOND, i.created_at, NOW()) as total_seconds_elapsed,
  TIMESTAMPDIFF(SECOND, i.created_at, NOW()) - s.total_blocked_seconds as effective_seconds_used,
  
  -- Remaining time
  TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining,
  
  -- SLA Status
  CASE 
    WHEN i.status = 'closed' THEN 'MET' -- Closed = SLA met
    WHEN i.status = 'blocked' THEN 'PAUSED' -- Blocked = SLA paused
    WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 0 THEN 'BREACHED' -- Past deadline
    WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 1800 THEN 'AT_RISK' -- Less than 30 mins
    ELSE 'OPEN'
  END as sla_status,
  
  -- Time remaining in human readable format
  SEC_TO_TIME(GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline))) as time_remaining,
  
  -- Percentage of SLA used
  ROUND(
    ((TIMESTAMPDIFF(SECOND, i.created_at, NOW()) - s.total_blocked_seconds) / 21600) * 100, 
    2
  ) as sla_percentage_used
FROM 
  issues i
LEFT JOIN 
  issue_sla s ON i.id = s.issue_id
WHERE 
  i.status IN ('to_do', 'in_progress', 'blocked', 'live')
ORDER BY 
  CASE 
    WHEN i.status = 'blocked' THEN 1
    WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 1800 THEN 2
    ELSE 3
  END,
  s.sla_deadline ASC;

-- ============================================
-- 2. Find issues that need Slack alerts (9 AM / 5 PM)
-- ============================================
-- Check every day at 9 AM and 5 PM
-- Alert if: AT_RISK or BREACHED and not already notified today

SELECT 
  i.id,
  i.clickup_task_id,
  i.title,
  i.assignee,
  i.status,
  s.sla_deadline,
  TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining,
  CASE 
    WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 0 THEN 'BREACHED'
    WHEN TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 1800 THEN 'AT_RISK'
    ELSE 'OK'
  END as alert_status,
  COALESCE(
    (SELECT sent_at FROM slack_notifications 
     WHERE issue_id = i.id 
     AND notification_type IN ('sla_warning', 'sla_breached')
     AND DATE(sent_at) = CURDATE()
     ORDER BY sent_at DESC LIMIT 1),
    NULL
  ) as last_alert_today
FROM 
  issues i
JOIN 
  issue_sla s ON i.id = s.issue_id
WHERE 
  i.status IN ('to_do', 'in_progress', 'live') -- Exclude blocked and closed
  AND (
    TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 0 -- BREACHED
    OR TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) < 1800 -- AT_RISK (30 mins)
  )
  AND (
    -- Only alert if not already alerted today
    NOT EXISTS (
      SELECT 1 FROM slack_notifications sn
      WHERE sn.issue_id = i.id
      AND DATE(sn.sent_at) = CURDATE()
      AND sn.notification_type IN ('sla_warning', 'sla_breached')
    )
    OR EXISTS (
      SELECT 1 FROM slack_notifications sn
      WHERE sn.issue_id = i.id
      AND TIMESTAMPDIFF(HOUR, sn.sent_at, NOW()) >= 12 -- Re-alert if not notified in last 12 hours
      AND sn.notification_type IN ('sla_warning', 'sla_breached')
    )
  )
ORDER BY 
  s.sla_deadline ASC;

-- ============================================
-- 3. When issue status changes to BLOCKED
-- ============================================
-- Triggered on status update: record blocked start time
INSERT INTO issue_status_history (issue_id, previous_status, new_status, blocked_start_time)
VALUES (?, ?, 'blocked', NOW());

-- ============================================
-- 4. When issue status changes FROM BLOCKED
-- ============================================
-- Calculate blocked duration and add to total
UPDATE issue_status_history
SET blocked_duration_seconds = TIMESTAMPDIFF(SECOND, blocked_start_time, NOW())
WHERE issue_id = ? AND new_status = 'blocked' AND blocked_duration_seconds = 0;

UPDATE issue_sla
SET total_blocked_seconds = total_blocked_seconds + (
  SELECT COALESCE(blocked_duration_seconds, 0)
  FROM issue_status_history
  WHERE issue_id = ? AND new_status = 'blocked' AND blocked_duration_seconds > 0
  ORDER BY changed_at DESC LIMIT 1
)
WHERE issue_id = ?;

-- ============================================
-- 5. When issue is closed
-- ============================================
-- Mark SLA as met if closed before deadline
UPDATE issue_sla
SET 
  closed_at = NOW(),
  sla_status = CASE 
    WHEN TIMESTAMPDIFF(SECOND, created_at, NOW()) - total_blocked_seconds <= 21600 THEN 'MET'
    ELSE 'BREACHED'
  END
WHERE issue_id = ?;

-- ============================================
-- 6. Dashboard query: SLA metrics
-- ============================================
SELECT 
  COUNT(*) as total_issues,
  SUM(CASE WHEN s.sla_status = 'BREACHED' THEN 1 ELSE 0 END) as breached_count,
  SUM(CASE WHEN s.sla_status = 'AT_RISK' THEN 1 ELSE 0 END) as at_risk_count,
  SUM(CASE WHEN s.sla_status = 'PAUSED' THEN 1 ELSE 0 END) as paused_count,
  SUM(CASE WHEN i.status = 'closed' THEN 1 ELSE 0 END) as closed_count,
  ROUND(
    (SUM(CASE WHEN s.sla_status = 'MET' THEN 1 ELSE 0 END) / COUNT(*)) * 100,
    2
  ) as sla_met_percentage
FROM 
  issues i
LEFT JOIN 
  issue_sla s ON i.id = s.issue_id
WHERE 
  i.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY); -- Last 7 days

-- ============================================
-- 7. Find issues to unblock (moved out of blocked state)
-- ============================================
SELECT 
  h.issue_id,
  h.previous_status,
  h.new_status,
  h.changed_at,
  h.blocked_start_time,
  TIMESTAMPDIFF(SECOND, h.blocked_start_time, h.changed_at) as blocked_duration_seconds,
  i.title,
  s.sla_deadline,
  TIMESTAMPDIFF(SECOND, NOW(), s.sla_deadline) as seconds_remaining
FROM 
  issue_status_history h
JOIN 
  issues i ON h.issue_id = i.id
JOIN 
  issue_sla s ON i.id = s.issue_id
WHERE 
  h.new_status = 'blocked'
  AND h.blocked_duration_seconds IS NULL -- Duration not yet calculated
ORDER BY 
  h.changed_at DESC;

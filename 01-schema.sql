-- ClickUp Issues Management System with SLA Tracking
-- Source of truth for all issues, SLA calculation, and monitoring

-- Main issues table (synced from ClickUp)
CREATE TABLE IF NOT EXISTS issues (
  id VARCHAR(100) PRIMARY KEY,
  clickup_task_id VARCHAR(100) UNIQUE NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  assignee VARCHAR(255),
  priority VARCHAR(20),
  status VARCHAR(50) NOT NULL, -- to_do, in_progress, blocked, live, closed
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL,
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  INDEX idx_closed_at (closed_at)
);

-- SLA tracking table
CREATE TABLE IF NOT EXISTS issue_sla (
  id INT AUTO_INCREMENT PRIMARY KEY,
  issue_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  sla_deadline TIMESTAMP NOT NULL, -- created_at + 6 hours
  closed_at TIMESTAMP NULL,
  total_blocked_seconds INT DEFAULT 0, -- accumulated time spent in blocked status
  sla_status VARCHAR(50), -- open, breached, met
  last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  UNIQUE KEY unique_issue (issue_id)
);

-- Status change log (for pausing/resuming SLA)
CREATE TABLE IF NOT EXISTS issue_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  issue_id VARCHAR(100) NOT NULL,
  previous_status VARCHAR(50),
  new_status VARCHAR(50) NOT NULL,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  blocked_start_time TIMESTAMP NULL, -- when issue moved to blocked
  blocked_duration_seconds INT DEFAULT 0, -- how long it stayed blocked
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  INDEX idx_issue_id (issue_id),
  INDEX idx_changed_at (changed_at)
);

-- Slack notification log
CREATE TABLE IF NOT EXISTS slack_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  issue_id VARCHAR(100) NOT NULL,
  notification_type VARCHAR(50), -- sla_warning, sla_breached, status_change, new_issue
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  slack_channel VARCHAR(100),
  slack_timestamp VARCHAR(100), -- For updating messages
  message_content TEXT,
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  INDEX idx_issue_id (issue_id),
  INDEX idx_sent_at (sent_at)
);

-- Create indexes for SLA calculations
CREATE INDEX idx_sla_status ON issue_sla(sla_status);
CREATE INDEX idx_sla_deadline ON issue_sla(sla_deadline);

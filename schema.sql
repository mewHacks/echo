-- Idempotent schema for Echo bot
-- This file is safe to re-run: it creates the database and tables if missing

CREATE DATABASE IF NOT EXISTS `echo` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `echo`;

-- Channels table for storing channel summaries
CREATE TABLE IF NOT EXISTS channels (
    id VARCHAR(32) PRIMARY KEY,
    summary TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Messages table for storing message history
CREATE TABLE IF NOT EXISTS messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    guild_id VARCHAR(32) NOT NULL, -- Which server this message belongs to
    channel_id VARCHAR(32) NOT NULL,
    user_id VARCHAR(32),
    username VARCHAR(64), -- Username at message time
    channel_name VARCHAR(64), -- Channel name at message time
    role ENUM('user', 'assistant') NOT NULL,
    content MEDIUMTEXT NOT NULL,
    event_type ENUM('create', 'edit', 'delete') NOT NULL DEFAULT 'create', -- Type of message event
    previous_content TEXT NULL, -- Original content before edit (for 'edit' events)
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_guild_id (guild_id),
    INDEX idx_event_type (event_type)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Create index if it does not exist (safe to rerun)
SELECT COUNT(*) INTO @cnt
FROM information_schema.statistics
WHERE
    table_schema = DATABASE()
    AND table_name = 'messages'
    AND index_name = 'idx_messages_channel_created_at';

SET
    @create_stmt = IF(
        @cnt = 0,
        'CREATE INDEX idx_messages_channel_created_at ON messages (channel_id, created_at)',
        'SELECT "index already exists"'
    );

PREPARE s FROM @create_stmt;

EXECUTE s;

DEALLOCATE PREPARE s;

-- Guilds table for storing guild summaries
CREATE TABLE IF NOT EXISTS guilds (
    id VARCHAR(32) PRIMARY KEY,
    summary TEXT,
    users_json MEDIUMTEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Observations table for storing discrete events
CREATE TABLE IF NOT EXISTS observations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    type VARCHAR(50) NOT NULL, -- e.g., 'TOPIC_SPIKE', 'SENTIMENT_DIP'
    data JSON, -- abstracted payload
    confidence FLOAT DEFAULT 0.0,
    channel_id VARCHAR(32),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_observations_created (created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Daily stats table for storing long term trends
CREATE TABLE IF NOT EXISTS daily_stats (
    date DATE NOT NULL,
    guild_id VARCHAR(32) NOT NULL,
    message_count INT DEFAULT 0,
    active_users INT DEFAULT 0,
    sentiment_avg FLOAT DEFAULT 0.0,
    sentiment_min FLOAT DEFAULT 0.0, -- Lowest sentiment recorded
    negative_ratio FLOAT DEFAULT 0.0, -- % of negative messages
    top_topics JSON,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (date, guild_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Emerging topics for trend tracking
CREATE TABLE IF NOT EXISTS emerging_topics (
    topic VARCHAR(64) NOT NULL,
    guild_id VARCHAR(32) NOT NULL,
    score FLOAT DEFAULT 0.0, -- Heat score with decay
    first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, topic),
    INDEX idx_topics_score (score)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Analysis cursor table to track last analyzed message ID per guild
CREATE TABLE IF NOT EXISTS analysis_cursor (
    guild_id VARCHAR(32) PRIMARY KEY,
    last_message_id BIGINT UNSIGNED DEFAULT 0,
    target_threshold INT DEFAULT 20, -- Dynamic batch size
    msg_rate_avg FLOAT DEFAULT 1.0, -- Messages per minute (Moving Avg)
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Server state table that aggregates data from both text (analyzer.js) and voice (voiceSessionManager.js)
CREATE TABLE IF NOT EXISTS server_state (
    guild_id VARCHAR(32) PRIMARY KEY,
    mood_score FLOAT DEFAULT 0.0, -- -1.0 to 1.0, aggregated sentiment
    mood_trend ENUM('rising', 'falling', 'stable') DEFAULT 'stable', -- Direction of sentiment change
    dominant_topics JSON, -- Top 5 topics as JSON array: ["topic1", "topic2", ...]
    open_commitments JSON, -- Future: tracked commitments [{who, what, confidence}]
    context_markers JSON, -- Invisible context markers [{type, since, confidence, topic?, expiresAt?}]
    last_voice_summary TEXT, -- Most recent voice summary (max 400 chars)
    last_voice_timestamp TIMESTAMP NULL, -- When the voice summary was captured
    source ENUM('text', 'voice') DEFAULT 'text', -- Last update source
    dominant_signal ENUM('text', 'voice', 'mixed') DEFAULT 'text', -- Computed from last 3 sources
    confidence FLOAT DEFAULT 0.0, -- Confidence in current state (0.0 to 1.0)
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Guild-level feature toggles for analysis and notifications
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id VARCHAR(32) PRIMARY KEY,
    passive_logging TINYINT(1) DEFAULT 1, -- Track and store messages for analysis
    background_analysis TINYINT(1) DEFAULT 1, -- Allow scheduler-driven analysis jobs
    admin_dm TINYINT(1) DEFAULT 0, -- Allow DM alerts to admins/moderators
    channel_message TINYINT(1) DEFAULT 0, -- Allow public intervention posts
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Intervention history table for tracking automated interventions
-- Records all decisions made by intervention-planner.js
CREATE TABLE IF NOT EXISTS intervention_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL,
    trigger_type VARCHAR(255), -- e.g., 'mood_negative', 'voice_activity'
    action_taken VARCHAR(50), -- e.g., 'POST_SUMMARY', 'DO_NOTHING'
    reasoning TEXT, -- Gemini's explanation for the decision
    confidence FLOAT, -- Gemini's confidence in the decision (0.0 to 1.0)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_intervention_guild (guild_id, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ALTER TABLE server_state
-- ADD COLUMN context_markers JSON AFTER open_commitments;

-- ALTER TABLE messages
-- ADD COLUMN event_type ENUM('create', 'edit', 'delete') NOT NULL DEFAULT 'create',
-- ADD COLUMN previous_content TEXT NULL,
-- ADD INDEX idx_event_type (event_type);
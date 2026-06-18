-- ============================================================
-- CallCoach Supabase PostgreSQL 建表 SQL
-- 在 Supabase SQL Editor 中执行此文件
-- ============================================================

-- 启用 uuid 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. 通话记录表 (calls)
-- ============================================================
CREATE TABLE IF NOT EXISTS calls (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id     TEXT UNIQUE NOT NULL,
    consultant_id    TEXT NOT NULL,
    consultant_name  TEXT NOT NULL DEFAULT '未知顾问',
    call_date        DATE,
    audio_url        TEXT,
    transcript_raw      TEXT,
    transcript_cleaned  TEXT,
    key_segments        JSONB,
    analysis_json       JSONB,
    processing_status   TEXT NOT NULL DEFAULT 'PENDING_UPLOAD',
    error_message       TEXT,
    original_filename   TEXT,
    uploaded_by         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);

-- 索引：顾问查询、日期排序、状态筛选
CREATE INDEX IF NOT EXISTS idx_calls_consultant  ON calls (consultant_id);
CREATE INDEX IF NOT EXISTS idx_calls_date        ON calls (call_date DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status      ON calls (processing_status);
CREATE INDEX IF NOT EXISTS idx_calls_deleted     ON calls (deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================================
-- 2. 顾问诊断表 (consultants)
-- ============================================================
CREATE TABLE IF NOT EXISTS consultants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    consultant_id   TEXT UNIQUE NOT NULL,
    consultant_name TEXT NOT NULL DEFAULT '未知顾问',
    diagnosis_json  JSONB,
    coaching_tasks  JSONB,
    processing_status TEXT NOT NULL DEFAULT 'PENDING_DIAGNOSE',
    small_group_id  TEXT DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_consultants_status ON consultants (processing_status);

-- ============================================================
-- 3. 自定义话术表 (custom_scripts)
-- ============================================================
CREATE TABLE IF NOT EXISTS custom_scripts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    script_id       TEXT UNIQUE NOT NULL,
    content         TEXT NOT NULL,
    scene           TEXT DEFAULT '',
    score           INTEGER DEFAULT 80,
    parent_type     JSONB DEFAULT '[]'::jsonb,
    problem_type    JSONB DEFAULT '[]'::jsonb,
    problem_category TEXT DEFAULT '',
    problem_subtype  TEXT DEFAULT '',
    tags            JSONB DEFAULT '[]'::jsonb,
    why_good        TEXT DEFAULT '',
    consultant_name TEXT DEFAULT '手动上传',
    call_date       DATE DEFAULT CURRENT_DATE,
    audio_url       TEXT DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_scripts_score ON custom_scripts (score DESC);

-- ============================================================
-- 4. 报告表 (reports)
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename        TEXT UNIQUE NOT NULL,
    consultant_id   TEXT NOT NULL,
    consultant_name TEXT NOT NULL,
    file_size       BIGINT DEFAULT 0,
    report_html     TEXT,
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reports_consultant ON reports (consultant_id);

-- ============================================================
-- 5. 已删除话术黑名单 (deleted_script_ids)
-- ============================================================
CREATE TABLE IF NOT EXISTS deleted_script_ids (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    script_id   TEXT UNIQUE NOT NULL,
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 自动更新 updated_at 的触发器
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为 calls 和 consultants 表添加触发器
DROP TRIGGER IF EXISTS trg_calls_updated_at ON calls;
CREATE TRIGGER trg_calls_updated_at
    BEFORE UPDATE ON calls
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_consultants_updated_at ON consultants;
CREATE TRIGGER trg_consultants_updated_at
    BEFORE UPDATE ON consultants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- RLS (Row Level Security) — 先关闭，多用户共享数据
-- ============================================================
ALTER TABLE calls            DISABLE ROW LEVEL SECURITY;
ALTER TABLE consultants      DISABLE ROW LEVEL SECURITY;
ALTER TABLE custom_scripts   DISABLE ROW LEVEL SECURITY;
ALTER TABLE reports          DISABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_script_ids DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- 存储桶创建提示（需在 Supabase Dashboard 手动创建）
-- ============================================================
-- Storage Buckets 需要在 Supabase Dashboard → Storage 中手动创建：
--   1. "audio"  — 通话录音文件 (public read)
--   2. "reports" — HTML 报告文件 (public read)
--   3. "scripts" — 话术库音频 (public read)

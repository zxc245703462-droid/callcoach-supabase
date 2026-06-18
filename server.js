// ============================================================
// CallCoach Server v2 — Node.js + Express + Supabase
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 配置 ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 缺少 SUPABASE_URL 或 SUPABASE_KEY 环境变量');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== 中间件 ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 文件上传配置
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${uuidv4().slice(0, 8)}_${file.originalname}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// 频率限制 (简单实现)
const rateLimitMap = new Map();
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < 60000);
  if (timestamps.length >= 60) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  next();
});

// ==================== 静态文件服务 ====================
// 用 process.cwd() 确保在任何环境都能找到 public/ 目录
const publicDir = path.join(process.cwd(), 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  console.log('Serving static files from:', publicDir);
} else {
  console.warn('Warning: public/ directory not found at', publicDir);
}

// ==================== 工具函数 ====================

/** 安全解析 JSON */
function safeJsonParse(str) {
  if (!str) return null;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch { return null; }
}

/** 获取分析数据的简写 */
function getAnalysisData(record) {
  const analysisRaw = record.analysis_json;
  return safeJsonParse(analysisRaw) || {};
}

/** 计算六维得分 (0-10 分制) */
function calcSixDim(analysis) {
  const ss = analysis.script_score || {};
  const spin = analysis.spin_analysis || {};
  const dims = ['situation', 'problem', 'implication', 'need_payoff'];
  let covered = 0;
  dims.forEach(d => { if (spin[d]?.covered) covered++; });
  return {
    opening:          Math.min(10, (ss.opening || 0) / 10),
    spin_coverage:    Math.round((covered / 4) * 10 * 10) / 10,
    needs_discovery:  Math.min(10, (ss.needs_discovery || 0) / 10),
    course_presentation: Math.min(10, (ss.course_presentation || 0) / 10),
    objection_handling:  Math.min(10, (ss.objection_handling || 0) / 10),
    closing:          Math.min(10, (ss.closing || 0) / 10),
    overall:          Math.min(10, (ss.overall || 0) / 10),
  };
}

/** 计算 SPIN 质量分 */
function calcSpinScore(analysis) {
  const spin = analysis.spin_analysis || {};
  const dims = ['situation', 'problem', 'implication', 'need_payoff'];
  let covered = 0, totalQuality = 0;
  dims.forEach(d => {
    if (spin[d]?.covered) {
      covered++;
      totalQuality += (spin[d].quality_score || 0) / 10;
    }
  });
  return covered > 0 ? Math.round((totalQuality / covered) * 100) / 10 : 0;
}

// ==================== API 路由 ====================

// ---- 系统状态 ----
app.get('/api/status', async (req, res) => {
  try {
    const { count: callCount } = await supabase.from('calls')
      .select('*', { count: 'exact', head: true }).is('deleted_at', null);
    const { count: consultantCount } = await supabase.from('consultants')
      .select('*', { count: 'exact', head: true }).is('deleted_at', null);
    res.json({
      backend: 'supabase',
      llm_backend: DEEPSEEK_API_KEY ? 'deepseek' : 'rule_based',
      llm_model: LLM_MODEL,
      call_count: callCount || 0,
      consultant_count: consultantCount || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 顾问列表 ----
app.get('/api/consultants', async (req, res) => {
  try {
    const { data: calls } = await supabase.from('calls')
      .select('consultant_id, consultant_name').is('deleted_at', null);
    const { data: diags } = await supabase.from('consultants')
      .select('consultant_id, consultant_name, diagnosis_json, processing_status')
      .is('deleted_at', null);

    const map = {};
    (calls || []).forEach(c => {
      if (!c.consultant_id) return;
      if (!map[c.consultant_id]) {
        map[c.consultant_id] = {
          consultant_id: c.consultant_id,
          consultant_name: c.consultant_name || '未知顾问',
          call_count: 0,
          has_diagnosis: false,
          diagnosis_status: 'none'
        };
      }
      map[c.consultant_id].call_count++;
    });
    (diags || []).forEach(d => {
      const c = map[d.consultant_id];
      if (c) {
        c.has_diagnosis = !!d.diagnosis_json;
        c.diagnosis_status = d.processing_status || 'none';
      }
    });
    res.json(Object.values(map));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 添加顾问 ----
app.post('/api/consultant', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: '顾问姓名不能为空' });
    }
    const consultantName = name.trim();
    const consultantId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const { data, error } = await supabase.from('consultants').insert({
      consultant_id: consultantId,
      consultant_name: consultantName,
      processing_status: 'PENDING',
      deleted_at: null
    }).select('id').single();

    if (error) throw error;

    res.json({
      success: true,
      consultant_id: consultantId,
      consultant_name: consultantName,
      message: `顾问「${consultantName}」添加成功`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 通话列表 ----
app.get('/api/calls', async (req, res) => {
  try {
    const { consultant } = req.query;
    let query = supabase.from('calls').select('*')
      .is('deleted_at', null).order('call_date', { ascending: false });

    if (consultant) {
      query = query.eq('consultant_id', consultant);
    }

    const { data: records } = await query.limit(10000);
    const result = (records || []).map(r => {
      const analysis = getAnalysisData(r);
      const ss = analysis.script_score || {};
      const spin = analysis.spin_analysis || {};
      const dims = ['situation', 'problem', 'implication', 'need_payoff'];
      const spinDetail = {};
      dims.forEach(d => {
        spinDetail[d] = { covered: spin[d]?.covered || false, quality_score: spin[d]?.quality_score || 0, missing_points: spin[d]?.missing_points || [] };
      });
      return {
        record_id: r.id,
        call_id: r.call_id,
        consultant_id: r.consultant_id,
        consultant_name: r.consultant_name,
        call_date: r.call_date,
        status: r.processing_status,
        overall_score: ss.overall || 0,
        spin_score: calcSpinScore(analysis),
        spin_detail: spinDetail,
        dimension_scores: calcSixDim(analysis),
        has_analysis: !!r.analysis_json,
        transcript_length: (r.transcript_raw || '').length,
        tags: analysis.tags || [],
        cost: (analysis._cost != null) ? analysis._cost : 0
      };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 单条通话详情 ----
app.get('/api/calls/:call_id', async (req, res) => {
  try {
    const { data } = await supabase.from('calls').select('*')
      .eq('call_id', req.params.call_id).is('deleted_at', null).single();
    if (!data) return res.status(404).json({ error: '通话不存在' });

    const analysis = getAnalysisData(data);
    // PII 脱敏
    const mask = (t) => (t || '')
      .replace(/1[3-9]\d{9}/g, '[手机号]')
      .replace(/\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, '[身份证号]');

    // 确保 spark_report 递归解析（可能嵌套 JSON 字符串）
    const spark = safeJsonParse(analysis.spark_report) || {};
    // 确保 strengths/areas/priorities 是数组
    ['strengths', 'areas', 'revision_priority'].forEach(k => {
      if (spark[k] && !Array.isArray(spark[k])) spark[k] = [spark[k]];
    });

    res.json({
      record_id: data.id,
      call_id: data.call_id,
      consultant_id: data.consultant_id,
      consultant_name: data.consultant_name,
      call_date: data.call_date,
      status: data.processing_status,
      transcript: data.transcript_raw || '',
      transcript_masked: mask(data.transcript_raw),
      segments: safeJsonParse(data.key_segments) || [],
      analysis,
      highlight_spans: analysis.highlight_spans || [],
      spark_report: spark,
      golden_scripts: analysis.golden_scripts || [],
      tags: analysis.tags || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 删除通话 ----
app.delete('/api/calls/:call_id', async (req, res) => {
  try {
    const { data } = await supabase.from('calls').select('id')
      .eq('call_id', req.params.call_id).is('deleted_at', null).single();
    if (!data) return res.status(404).json({ error: '通话不存在' });

    await supabase.from('calls').update({ deleted_at: new Date().toISOString() })
      .eq('id', data.id);
    res.json({ success: true, deleted: data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 导出通话 ----
app.get('/api/export/:call_id', async (req, res) => {
  try {
    const { data } = await supabase.from('calls').select('*')
      .eq('call_id', req.params.call_id).is('deleted_at', null).single();
    if (!data) return res.status(404).json({ error: '通话不存在' });

    res.setHeader('Content-Disposition', `attachment; filename="callcoach_${req.params.call_id}.json"`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 删除顾问 ----
app.delete('/api/consultant/:consultant_id', async (req, res) => {
  try {
    const cid = req.params.consultant_id;

    // 软删除通话
    const { count: deletedCalls } = await supabase.from('calls')
      .update({ deleted_at: new Date().toISOString() })
      .eq('consultant_id', cid).is('deleted_at', null)
      .select('*', { count: 'exact', head: true });

    // 软删除诊断
    const { count: deletedDiags } = await supabase.from('consultants')
      .update({ deleted_at: new Date().toISOString() })
      .eq('consultant_id', cid).is('deleted_at', null)
      .select('*', { count: 'exact', head: true });

    // 软删除报告
    const { count: deletedReports } = await supabase.from('reports')
      .update({ deleted_at: new Date().toISOString() })
      .eq('consultant_id', cid).is('deleted_at', null)
      .select('*', { count: 'exact', head: true });

    res.json({
      success: true,
      deleted_calls: deletedCalls || 0,
      deleted_diagnosis: deletedDiags || 0,
      deleted_reports: deletedReports || 0,
      message: `已删除顾问 ${cid} 的所有数据`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 统计数据 ----
app.get('/api/stats', async (req, res) => {
  try {
    const { data: records } = await supabase.from('calls')
      .select('*').is('deleted_at', null);

    const analyzed = (records || []).filter(r => r.analysis_json);
    const total = (records || []).length;

    // 得分分布
    const scoreDist = [
      { name: '90-100分', value: 0 },
      { name: '80-89分', value: 0 },
      { name: '60-79分', value: 0 },
      { name: '0-59分', value: 0 }
    ];

    // SPIN 维度统计
    const spinDims = [
      { name: 'S-现状问题', value: 0, avgQuality: 0 },
      { name: 'P-困难挑战', value: 0, avgQuality: 0 },
      { name: 'I-影响后果', value: 0, avgQuality: 0 },
      { name: 'N-需求回报', value: 0, avgQuality: 0 }
    ];
    const dimKeys = ['situation', 'problem', 'implication', 'need_payoff'];

    let totalScore = 0;
    const consultantMap = {};
    const callDates = [];

    analyzed.forEach(r => {
      const a = getAnalysisData(r);
      const ss = a.script_score || {};
      const ov = ss.overall || 0;
      totalScore += ov;

      if (ov >= 90) scoreDist[0].value++;
      else if (ov >= 80) scoreDist[1].value++;
      else if (ov >= 60) scoreDist[2].value++;
      else scoreDist[3].value++;

      const spin = a.spin_analysis || {};
      dimKeys.forEach((dk, i) => {
        if (spin[dk]?.covered) {
          spinDims[i].value++;
          spinDims[i].avgQuality += (spin[dk].quality_score || 0) / 10;
        }
      });

      // 顾问聚合
      const cid = r.consultant_id;
      if (!consultantMap[cid]) {
        consultantMap[cid] = {
          consultant_id: cid,
          consultant_name: r.consultant_name,
          call_count: 0, total_score: 0, max_score: 0, min_score: 100
        };
      }
      const cm = consultantMap[cid];
      cm.call_count++;
      cm.total_score += ov;
      cm.max_score = Math.max(cm.max_score, ov);
      cm.min_score = Math.min(cm.min_score, ov);

      if (r.call_date) callDates.push({ date: r.call_date, score: ov, consultant: r.consultant_name });
    });

    // 计算 SPIN 平均质量
    spinDims.forEach(d => {
      if (d.value > 0) d.avgQuality = Math.round((d.avgQuality / d.value) * 10) / 10;
    });

    // 顾问比较
    const consultantComparison = Object.values(consultantMap).map(c => ({
      ...c,
      avg_score: c.call_count > 0 ? Math.round((c.total_score / c.call_count) * 10) / 10 : 0
    }));

    // 日趋势 (最近30天)
    const dailyTrends = [];
    const dailyMap = {};
    callDates.forEach(cd => {
      const key = cd.date;
      if (!dailyMap[key]) dailyMap[key] = { date: key, total: 0, count: 0 };
      dailyMap[key].total += cd.score;
      dailyMap[key].count++;
    });
    Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)).forEach(d => {
      dailyTrends.push({ date: d.date, avg_score: Math.round((d.total / d.count) * 10) / 10 });
    });

    // 顾问雷达 (六维)
    const consultantRadar = consultantComparison.map(c => {
      const cCalls = (records || []).filter(r => r.consultant_id === c.consultant_id && r.analysis_json);
      const dims = { opening: [], spin_coverage: [], needs_discovery: [], course_presentation: [], objection_handling: [], closing: [] };
      cCalls.forEach(rr => {
        const ad = calcSixDim(getAnalysisData(rr));
        Object.keys(dims).forEach(dk => { dims[dk].push(ad[dk] || 0); });
      });
      const avgDims = {};
      Object.keys(dims).forEach(dk => {
        const vals = dims[dk].filter(v => v > 0);
        avgDims[dk] = vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
      });
      return { consultant_id: c.consultant_id, consultant_name: c.consultant_name, ...avgDims };
    });

    // 团队雷达均值
    const teamRadarAvg = { opening: 0, spin_coverage: 0, needs_discovery: 0, course_presentation: 0, objection_handling: 0, closing: 0 };
    if (consultantRadar.length > 0) {
      Object.keys(teamRadarAvg).forEach(k => {
        const vals = consultantRadar.map(cr => cr[k] || 0);
        teamRadarAvg[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      });
    }

    // 顾问 x 六维热力图数据
    const hmDimKeys = ['opening', 'needs_discovery', 'course_presentation', 'objection_handling', 'closing', 'overall'];
    const hmDimLabels = ['开场破冰', '需求挖掘', '课程介绍', '异议处理', '成交推进', '综合'];
    const hmConsultants = consultantComparison.map(c => c.consultant_name);
    const hmSpinData = [];

    consultantComparison.forEach((c, ci) => {
      const cCalls = (records || []).filter(r => r.consultant_id === c.consultant_id && r.analysis_json);
      const dimAvgs = {};
      hmDimKeys.forEach(dk => { dimAvgs[dk] = []; });
      cCalls.forEach(rr => {
        const ss = (getAnalysisData(rr)).script_score || {};
        hmDimKeys.forEach(dk => {
          if (ss[dk] != null && ss[dk] > 0) dimAvgs[dk].push(ss[dk] / 10);
        });
      });
      hmDimKeys.forEach((dk, di) => {
        const vals = dimAvgs[dk];
        const avg = vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
        hmSpinData.push([di, ci, avg]);
      });
    });

    res.json({
      total_calls: total,
      analyzed_calls: analyzed.length,
      avg_score: analyzed.length > 0 ? Math.round((totalScore / analyzed.length) * 10) / 10 : 0,
      spin_coverage: Math.round((spinDims.filter(d => d.value > 0).length / 4) * 100),
      spin_dimensions: spinDims,
      score_distribution: scoreDist,
      objection_types: [],
      consultant_comparison: consultantComparison,
      consultant_count: consultantComparison.length,
      daily_trends: dailyTrends,
      consultant_warnings: [],
      consultant_radar: consultantRadar,
      team_radar_avg: teamRadarAvg,
      prev_week_stats: {},
      heatmap_data: hmSpinData,
      heatmap_consultants: hmConsultants,
      heatmap_spin_data: hmSpinData,
      heatmap_dim_labels: hmDimLabels
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 文件上传 (音频/文本) ----
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (req.file) files.push(req.file);
    if (files.length === 0) return res.status(400).json({ error: '请上传至少一个文件' });

    const consultantId = req.body.consultant || `user_${Date.now()}`;
    const consultantName = req.body.consultant_name || '未知顾问';
    const callDate = req.body.call_date || new Date().toISOString().split('T')[0];

    const results = [];
    for (const file of files) {
      const isAudio = /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(file.originalname);
      const callId = `call_${uuidv4().slice(0, 8)}`;

      let audioUrl = '';
      let transcriptRaw = '';

      // 上传到 Supabase Storage
      if (isAudio) {
        const storagePath = `audio/${callId}_${file.originalname}`;
        const fileBuffer = fs.readFileSync(file.path);
        const { error: uploadErr } = await supabase.storage.from('audio').upload(storagePath, fileBuffer, {
          contentType: file.mimetype,
          upsert: true
        });
        if (uploadErr) {
          console.error('Storage upload error:', uploadErr);
        } else {
          const { data: publicUrl } = supabase.storage.from('audio').getPublicUrl(storagePath);
          audioUrl = publicUrl?.publicUrl || '';
        }
      }

      // 文本文件直接读内容
      if (/\.txt$/i.test(file.originalname)) {
        transcriptRaw = fs.readFileSync(file.path, 'utf-8');
        if (/[\x80-\xff]{3,}/.test(transcriptRaw)) {
          try { transcriptRaw = fs.readFileSync(file.path, 'gbk'); } catch {}
        }
      }

      const { data: record } = await supabase.from('calls').insert({
        call_id: callId,
        consultant_id: consultantId,
        consultant_name: consultantName,
        call_date: callDate,
        audio_url: audioUrl,
        transcript_raw: transcriptRaw,
        processing_status: 'PENDING_UPLOAD',
        original_filename: file.originalname
      }).select('id').single();

      results.push({
        original_name: file.originalname,
        saved_name: path.basename(file.path),
        path: file.path,
        call_id: callId,
        is_audio: isAudio,
        record_id: record?.id
      });

      // 清理临时文件
      try { fs.unlinkSync(file.path); } catch {}
    }

    res.json({
      success: true,
      consultant_id: consultantId,
      consultant_name: consultantName,
      file_count: files.length,
      files: results,
      call_id: results[0]?.call_id,
      call_ids: results.map(r => r.call_id)
    });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 诊断报告 ----
app.get('/api/diagnosis/:consultant_id', async (req, res) => {
  try {
    const cid = req.params.consultant_id;

    // 通话数统计
    const { count: callCount } = await supabase.from('calls')
      .select('*', { count: 'exact', head: true })
      .eq('consultant_id', cid).is('deleted_at', null);

    // 诊断数据
    const { data: diag } = await supabase.from('consultants')
      .select('*').eq('consultant_id', cid).is('deleted_at', null).maybeSingle();

    const minInitial = parseInt(process.env.MIN_CALLS_INITIAL || '3');
    const minFull = parseInt(process.env.MIN_CALLS_FULL || '5');

    let level = 'none', message = '';
    if (callCount >= minFull) {
      level = diag?.diagnosis_json ? 'full' : 'full_pending';
      message = diag?.diagnosis_json ? '已完成深度诊断' : '数据充足，可生成深度诊断报告';
    } else if (callCount >= minInitial) {
      level = diag?.diagnosis_json ? 'initial' : 'initial_pending';
      message = diag?.diagnosis_json ? '初步诊断已完成' : '可生成初步诊断（需至少5通深度诊断）';
    } else {
      message = `通话数不足（当前${callCount}通，初步诊断需≥${minInitial}通）`;
    }

    res.json({
      has_diagnosis: !!diag?.diagnosis_json,
      diagnosis_level: level,
      consultant_id: cid,
      call_count: callCount,
      diagnosis: safeJsonParse(diag?.diagnosis_json),
      coaching: safeJsonParse(diag?.coaching_tasks),
      confidence: callCount >= minFull ? 'high' : callCount >= minInitial ? 'medium' : 'low',
      message,
      remaining_to_initial: Math.max(0, minInitial - callCount),
      remaining_to_full: Math.max(0, minFull - callCount)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 教练计划 ----
app.get('/api/coaching/:consultant_id', async (req, res) => {
  try {
    const cid = req.params.consultant_id;
    const { data: diag } = await supabase.from('consultants')
      .select('*').eq('consultant_id', cid).is('deleted_at', null).maybeSingle();

    res.json({
      has_coaching: !!diag?.coaching_tasks,
      consultant_id: cid,
      consultant_name: diag?.consultant_name || cid,
      coaching: safeJsonParse(diag?.coaching_tasks),
      status: diag?.processing_status || 'none',
      message: diag?.coaching_tasks ? '' : '暂无教练计划，请先生成诊断报告'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 优秀话术库 ----
app.get('/api/library', async (req, res) => {
  try {
    const search = (req.query.search || '').trim().toLowerCase();
    const parentType = (req.query.parent_type || '').trim();
    const problemType = (req.query.problem_type || '').trim();
    const minScore = parseInt(req.query.min_score || '60') || 60;

    // 获取已分析通话的金句
    const { data: records } = await supabase.from('calls')
      .select('*').not('analysis_json', 'is', null).is('deleted_at', null);

    // 获取黑名单
    const { data: blacklist } = await supabase.from('deleted_script_ids').select('script_id');
    const blackSet = new Set((blacklist || []).map(b => b.script_id));

    const items = [];
    (records || []).forEach(r => {
      const analysis = getAnalysisData(r);
      const ss = analysis.script_score || {};
      const overall = ss.overall || 0;
      if (overall < minScore) return;

      const gs = analysis.golden_scripts || [];
      const gsTexts = gs.filter(g => g.text);
      const reasons = gs.map(g => g.reason || '');
      const parentTypes = Array.isArray(analysis.parent_type) ? analysis.parent_type
        : (typeof analysis.parent_type === 'string' ? [analysis.parent_type] : []);
      const objectionTypes = (analysis.objection_handling || []).map(o => o.objection_type).filter(Boolean);
      const tags = [
        ...(analysis.tags || []),
        ...(analysis.spin_analysis ? Object.entries(analysis.spin_analysis).filter(([,v]) => v?.covered).map(([k]) => k) : [])
      ].slice(0, 4);

      gsTexts.forEach((g, idx) => {
        const sid = `${r.call_id}_gs${idx}`;
        if (blackSet.has(sid)) return;
        items.push({
          script_id: sid,
          score: overall,
          tags,
          parent_type: parentTypes,
          problem_type: objectionTypes,
          scene: gs[idx]?.scene || '',
          content: g.text,
          why_good: reasons[idx] || '语言亲切自然，能有效建立信任并推动沟通进展',
          consultant_name: r.consultant_name,
          call_date: r.call_date,
          audio_url: r.audio_url
        });
      });

      // 无金句但高分 → 兜底
      if (gsTexts.length === 0 && overall >= 70) {
        const sid = r.call_id;
        if (!blackSet.has(sid)) {
          items.push({
            script_id: sid,
            score: overall,
            tags,
            parent_type: parentTypes,
            problem_type: objectionTypes,
            scene: '综合高分通话',
            content: '该通话综合评分优秀，建议收听原声学习整体沟通节奏',
            why_good: '该顾问在SPIN各维度表现均衡，整体沟通质量高',
            consultant_name: r.consultant_name,
            call_date: r.call_date,
            audio_url: r.audio_url
          });
        }
      }
    });

    // 合并手动上传 scripts
    let customQuery = supabase.from('custom_scripts').select('*').gte('score', minScore);
    if (parentType) {
      // PostgreSQL jsonb contains
      customQuery = customQuery.contains('parent_type', JSON.stringify([parentType]));
    }
    const { data: customScripts } = await customQuery.order('score', { ascending: false });

    (customScripts || []).forEach(s => {
      if (search && !`${s.content} ${s.scene} ${s.why_good}`.toLowerCase().includes(search)) return;
      items.push({
        script_id: s.script_id,
        score: s.score,
        tags: s.tags || [],
        parent_type: s.parent_type || [],
        problem_type: s.problem_type || [],
        scene: s.scene,
        content: s.content,
        why_good: s.why_good,
        consultant_name: s.consultant_name,
        call_date: s.call_date,
        audio_url: s.audio_url
      });
    });

    // 排序和搜索过滤
    items.sort((a, b) => b.score - a.score);
    const filtered = search
      ? items.filter(i => (i.content + i.scene + i.why_good).toLowerCase().includes(search))
      : items;

    res.json(filtered);
  } catch (e) {
    console.error('Library error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 话术上传 ----
app.post('/api/library/upload', upload.single('audio'), async (req, res) => {
  try {
    const content = (req.body.content || '').trim();
    if (!content) return res.status(400).json({ success: false, error: '话术原文不能为空' });

    const scene = (req.body.scene || '').trim();
    const score = parseInt(req.body.score || '80') || 80;
    const parentType = (req.body.parent_type || '').trim();
    const problemType = (req.body.problem_type || '').trim();
    const whyGood = (req.body.why_good || '').trim();

    // 音频上传到 Supabase Storage
    let audioUrl = '';
    if (req.file) {
      const ext = path.extname(req.file.originalname);
      const storagePath = `scripts/library_${uuidv4().slice(0, 12)}${ext}`;
      const fileBuffer = fs.readFileSync(req.file.path);
      const { error: uploadErr } = await supabase.storage.from('scripts').upload(storagePath, fileBuffer, {
        contentType: req.file.mimetype, upsert: true
      });
      if (!uploadErr) {
        const { data: publicUrl } = supabase.storage.from('scripts').getPublicUrl(storagePath);
        audioUrl = publicUrl?.publicUrl || '';
      }
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    const scriptId = 'custom_' + uuidv4().slice(0, 12);
    const item = {
      script_id: scriptId,
      content,
      scene: scene || '手动上传话术',
      score,
      parent_type: parentType ? [parentType] : [],
      problem_type: problemType ? [problemType] : [],
      tags: [],
      why_good: whyGood || '优质话术，建议多加练习',
      consultant_name: '手动上传',
      call_date: new Date().toISOString().split('T')[0],
      audio_url: audioUrl
    };

    await supabase.from('custom_scripts').insert(item);

    res.json({ success: true, item });
  } catch (e) {
    console.error('Library upload error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 删除话术 ----
app.delete('/api/library/:script_id', async (req, res) => {
  try {
    const sid = req.params.script_id;
    let deleted = false;

    // 自定义上传的话术 → 直接删除
    if (sid.startsWith('custom_')) {
      const { error } = await supabase.from('custom_scripts').delete().eq('script_id', sid);
      if (!error) deleted = true;
    }

    // 自动生成的话术 → 加入黑名单
    if (!deleted) {
      const { data: existing } = await supabase.from('deleted_script_ids')
        .select('script_id').eq('script_id', sid).maybeSingle();
      if (!existing) {
        await supabase.from('deleted_script_ids').insert({ script_id: sid });
        deleted = true;
      }
    }

    if (deleted) {
      res.json({ success: true, message: '话术已删除' });
    } else {
      res.status(404).json({ success: false, error: '话术不存在' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 报告列表 ----
app.get('/api/reports', async (req, res) => {
  try {
    const { data } = await supabase.from('reports')
      .select('*').is('deleted_at', null).order('generated_at', { ascending: false });
    res.json((data || []).map(r => ({
      filename: r.filename,
      size: r.file_size,
      generated_at: r.generated_at,
      consultant_name: r.consultant_name
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 删除报告 ----
app.delete('/api/reports/:filename', async (req, res) => {
  try {
    const fname = req.params.filename;
    if (fname.includes('..')) return res.status(400).json({ error: '非法文件名' });

    const { data } = await supabase.from('reports').select('id')
      .eq('filename', fname).is('deleted_at', null).single();

    if (!data) return res.status(404).json({ error: '报告不存在' });

    await supabase.from('reports').update({ deleted_at: new Date().toISOString() }).eq('id', data.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 下载报告 ----
app.get('/api/download-report/:filename', async (req, res) => {
  try {
    const fname = req.params.filename;
    if (fname.includes('..')) return res.status(400).json({ error: '非法文件名' });

    const { data } = await supabase.from('reports')
      .select('*').eq('filename', fname).is('deleted_at', null).single();

    if (!data) return res.status(404).json({ error: '报告不存在' });

    if (data.report_html) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(data.report_html);
    } else {
      // 尝试从 Storage 读取
      const { data: fileData, error } = await supabase.storage.from('reports').download(fname);
      if (error) return res.status(404).json({ error: '报告文件不存在' });
      const buffer = Buffer.from(await fileData.arrayBuffer());
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(buffer);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 生成报告 (简化版，内部函数) ----
async function generateReportForConsultant(cid) {
  const { data: calls } = await supabase.from('calls')
    .select('*').eq('consultant_id', cid).not('analysis_json', 'is', null).is('deleted_at', null);
  if (!calls || calls.length === 0) {
    throw new Error('该顾问暂无分析数据');
  }
  const consultantName = calls[0].consultant_name;
  const { data: diag } = await supabase.from('consultants')
    .select('*').eq('consultant_id', cid).is('deleted_at', null).maybeSingle();
  const avgScore = Math.round(calls.reduce((s, c) => s + ((safeJsonParse(c.analysis_json)?.script_score || {}).overall || 0), 0) / calls.length);
  const reportHtml = generateReportHtml(consultantName, calls, diag, avgScore);
  const filename = `${consultantName}_话术指导报告_${Date.now()}.html`;
  const { error: uploadErr } = await supabase.storage.from('reports').upload(filename, reportHtml, {
    contentType: 'text/html', upsert: true
  });
  if (uploadErr) throw new Error('报告上传失败: ' + uploadErr.message);
  const { data: publicUrl } = supabase.storage.from('reports').getPublicUrl(filename);
  await supabase.from('reports').insert({
    filename, consultant_id: cid, consultant_name: consultantName,
    file_size: Buffer.byteLength(reportHtml, 'utf-8'), report_html: reportHtml
  });
  return { success: true, report_path: filename, report_url: publicUrl?.publicUrl || '',
    consultant_name: consultantName, call_count: calls.length,
    has_diagnosis: !!diag?.diagnosis_json, has_coaching: !!diag?.coaching_tasks };
}

// ---- 生成报告 API ----
app.post('/api/generate-report/:consultant_id', async (req, res) => {
  try {
    const result = await generateReportForConsultant(req.params.consultant_id);
    res.json(result);
  } catch (e) {
    console.error('Generate report error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 批量生成报告 ----
app.post('/api/generate-all-reports', async (req, res) => {
  try {
    const { data: consultants } = await supabase.from('calls')
      .select('consultant_id').not('analysis_json', 'is', null).is('deleted_at', null);

    const unique = [...new Set((consultants || []).map(c => c.consultant_id))];
    const results = [];
    const errors = [];

    for (const cid of unique) {
      try {
        const data = await generateReportForConsultant(cid);
        results.push(data);
      } catch (e) {
        errors.push({ consultant_id: cid, error: e.message });
      }
    }

    res.json({ success: true, results, errors, total_generated: results.length, total_errors: errors.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 通话分析 ----
app.post('/api/analyze-call/:call_id', async (req, res) => {
  try {
    const { data: record } = await supabase.from('calls')
      .select('*').eq('call_id', req.params.call_id).is('deleted_at', null).single();
    if (!record) return res.status(404).json({ error: '通话不存在' });

    const transcript = record.transcript_raw || '';

    let analysis, cost, llmUsed;
    if (DEEPSEEK_API_KEY) {
      const deepseekResult = await deepseekAnalysis(transcript, record.consultant_name);
      analysis = deepseekResult.result;
      cost = deepseekResult.cost;
      llmUsed = deepseekResult.fallback ? 'rule_based(fallback)' : 'deepseek';
    } else {
      analysis = ruleBasedAnalysis(transcript, record.consultant_name);
      cost = 0;
      llmUsed = 'rule_based';
    }
    // 将 cost 存入 analysis_json 中
    analysis._cost = cost;

    await supabase.from('calls').update({
      analysis_json: analysis,
      processing_status: 'ANALYZED'
    }).eq('id', record.id);

    res.json({
      success: true,
      call_id: record.call_id,
      overall_score: analysis.script_score?.overall || 0,
      llm_used: llmUsed,
      cost
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 批量分析 ----
app.post('/api/run-pipeline', async (req, res) => {
  try {
    const { files, consultant_id } = req.body;
    const callIds = files || [];

    const results = [];
    const errors = [];

    for (const cid of callIds) {
      try {
        const { data: record } = await supabase.from('calls')
          .select('*').eq('call_id', cid).is('deleted_at', null).single();
        if (!record) {
          errors.push({ call_id: cid, error: '通话不存在' });
          continue;
        }

        const transcript = record.transcript_raw || '';
        if (!transcript) {
          errors.push({ call_id: cid, error: '无转写文本' });
          continue;
        }

        let analysis, cost, llmUsed;
        if (DEEPSEEK_API_KEY) {
          const deepseekResult = await deepseekAnalysis(transcript, record.consultant_name);
          analysis = deepseekResult.result;
          cost = deepseekResult.cost;
          llmUsed = deepseekResult.fallback ? 'rule_based(fallback)' : 'deepseek';
        } else {
          analysis = ruleBasedAnalysis(transcript, record.consultant_name);
          cost = 0;
          llmUsed = 'rule_based';
        }
        analysis._cost = cost;

        await supabase.from('calls').update({
          analysis_json: analysis,
          processing_status: 'ANALYZED'
        }).eq('id', record.id);

        results.push({
          call_id: cid,
          record_id: record.id,
          overall_score: analysis.script_score?.overall || 0,
          llm_used: llmUsed,
          cost
        });
      } catch (e) {
        errors.push({ call_id: cid, error: e.message });
      }
    }

    res.json({
      success: true,
      results,
      errors,
      total_processed: results.length,
      total_errors: errors.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- OLLAMA 状态 ----
app.get('/api/config', async (req, res) => {
  res.json({
    backend: 'supabase',
    llm_backend: DEEPSEEK_API_KEY ? 'deepseek' : 'rule_based',
    llm_base_url: DEEPSEEK_BASE_URL,
    llm_model: LLM_MODEL
  });
});

// ==================== DeepSeek LLM 分析 ====================

/** 调用 DeepSeek Chat API */
async function callDeepSeek(systemPrompt, userMessage, maxTokens = 4096) {
  const url = `${DEEPSEEK_BASE_URL}/v1/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};

  return {
    text: content,
    cost: (usage.prompt_tokens || 0) * 0.001 + (usage.completion_tokens || 0) * 0.002,
    usage
  };
}

/** 从 LLM 返回文本中提取 JSON（兼容 markdown 代码块包裹） */
function extractJson(text) {
  const cleaned = text.trim();
  // 尝试解析 ```json ... ``` 包裹的
  const mdMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = mdMatch ? mdMatch[1].trim() : cleaned;
  try {
    return JSON.parse(raw);
  } catch {
    // 尝试修复常见 JSON 问题：中文引号等
    const fixed = raw
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\n/g, '\\n');
    try { return JSON.parse(fixed); } catch { return null; }
  }
}

/** 使用 DeepSeek 分析通话文本 */
async function deepseekAnalysis(transcript, consultantName) {
  const systemPrompt = `你是销售话术分析专家，负责分析教育行业电话销售通话。用中文回复，仅输出 JSON，不要任何解释。

分析维度：
1. SPIN 法：检测销售是否使用 S-现状问题、P-困难挑战、I-影响后果、N-需求回报 四种提问
2. 五维评分(0-100)：开场破冰、需求挖掘、课程介绍、异议处理、成交推进、总分
3. 异议处理分析
4. 亮点与待改进总结
5. 黄金话术提炼

返回的 JSON 必须严格符合以下格式：
{
  "objection_handling": [{ "objection_type": "异议类型", "handled": true/false, "response_quality": 0-100, "suggested_response": "改进建议" }],
  "spin_analysis": {
    "situation": { "label": "S-现状问题", "covered": true/false, "quality_score": 0-100, "keywords": ["匹配到的关键词"], "missing_points": ["未覆盖的点"] },
    "problem": { "label": "P-困难挑战", "covered": true/false, "quality_score": 0-100, "keywords": [], "missing_points": [] },
    "implication": { "label": "I-影响后果", "covered": true/false, "quality_score": 0-100, "keywords": [], "missing_points": [] },
    "need_payoff": { "label": "N-需求回报", "covered": true/false, "quality_score": 0-100, "keywords": [], "missing_points": [] }
  },
  "script_score": { "opening": 0-100, "needs_discovery": 0-100, "course_presentation": 0-100, "objection_handling": 0-100, "closing": 0-100, "overall": 0-100 },
  "key_phrases_used": ["优质话术1", "优质话术2"],
  "missed_opportunities": ["错失的机会1", "错失的机会2"],
  "highlight_spans": [{ "start": 0, "end": 20, "label": "亮点标签" }],
  "spark_report": {
    "strengths": ["优势点1", "优势点2"],
    "areas": ["待提升领域1", "待提升领域2"],
    "revision_priority": ["最优先改进的领域"],
    "potential": "一句话总结潜力提升方向",
    "keep_going": "一句鼓励的话"
  },
  "golden_scripts": [{ "text": "优质话术原文", "scene": "适用场景", "reason": "为什么好" }],
  "tags": ["标签1", "标签2", "标签3"],
  "parent_type": ["理性分析型|价格敏感型|决策拖延型|信任需求型"],
  "problem_types": ["问题类型"],
  "is_excellent": true/false,
  "excellence_reason": "优秀理由",
  "best_script_moments": [{ "time": "通话阶段", "text": "话术内容", "score": 0-100, "comment": "点评" }],
  "metrics": { "push_inquiry_ratio": "60%", "push_count": 0-999, "inquiry_count": 0-999, "speaking_ratio": "55%" }
}

通话文本长度可能很长，请仔细阅读后给出客观评价。务必输出完整 JSON，不要省略任何字段。`;

  const userMessage = `请分析以下教育顾问 "${consultantName}" 的通话记录，返回 JSON：\n\n${transcript.slice(0, 15000)}`;

  let result;
  try {
    result = await callDeepSeek(systemPrompt, userMessage, 4096);
  } catch (e) {
    console.error('[DeepSeek] API 调用失败，回退规则引擎:', e.message);
    return { result: ruleBasedAnalysis(transcript, consultantName), cost: 0, fallback: true, error: e.message };
  }

  const parsed = extractJson(result.text);

  if (!parsed || !parsed.spin_analysis) {
    console.error('[DeepSeek] 无法解析 LLM 输出为有效 JSON，回退规则引擎');
    console.error('[DeepSeek] Raw:', result.text.slice(0, 500));
    return { result: ruleBasedAnalysis(transcript, consultantName), cost: 0, fallback: true, error: 'JSON parse failed' };
  }

  // 补充缺失的默认字段
  const defaults = {
    metrics: { push_inquiry_ratio: '50%', push_count: 0, inquiry_count: 0, speaking_ratio: '50%' },
    golden_scripts: [],
    tags: [],
    parent_type: [],
    problem_types: [],
    highlight_spans: [],
    best_script_moments: [],
    key_phrases_used: [],
    missed_opportunities: [],
    spark_report: { strengths: [], areas: [], revision_priority: [], potential: '', keep_going: '' }
  };
  Object.entries(defaults).forEach(([k, v]) => { if (!parsed[k]) parsed[k] = v; });

  // 确保 spark_report 子字段是数组
  ['strengths', 'areas', 'revision_priority'].forEach(k => {
    if (parsed.spark_report[k] && !Array.isArray(parsed.spark_report[k])) {
      parsed.spark_report[k] = [parsed.spark_report[k]];
    }
  });

  return { result: parsed, cost: result.cost, fallback: false };
}

// ==================== 规则引擎分析 ====================
function ruleBasedAnalysis(transcript, consultantName) {
  const text = (transcript || '').trim();
  const len = text.length;

  // SPIN 启发式检测
  const keywords = {
    situation: ['了解', '情况', '目前', '现在', '之前', '学过', '体验过'],
    problem: ['困难', '问题', '担心', '痛点', '困扰', '不足', '薄弱'],
    implication: ['影响', '后果', '导致', '如果', '长期', '未来'],
    need_payoff: ['帮助', '解决', '提升', '改善', '效果', '价值', '收获']
  };

  const dimLabels = { situation: 'S-现状问题', problem: 'P-困难挑战', implication: 'I-影响后果', need_payoff: 'N-需求回报' };

  const spinAnalysis = {};
  let coveredCount = 0, totalQuality = 0;
  Object.entries(keywords).forEach(([dim, words]) => {
    const hits = words.filter(w => text.includes(w));
    const covered = hits.length >= 1;
    const quality = covered ? Math.min(100, 40 + hits.length * 20 + Math.floor(Math.random() * 30)) : 0;
    if (covered) coveredCount++;
    totalQuality += quality;
    spinAnalysis[dim] = {
      label: dimLabels[dim],
      covered,
      quality_score: quality,
      keywords: hits,
      missing_points: covered ? [] : [`${dimLabels[dim]}维度未覆盖`]
    };
  });

  // 五维评分
  const openingScore = text.length > 100 ? 55 + Math.floor(Math.random() * 40) : 30;
  const ndScore = 40 + Math.floor(Math.random() * 50);
  const cpScore = 40 + Math.floor(Math.random() * 50);
  const ohScore = coveredCount >= 3 ? 55 + Math.floor(Math.random() * 40) : 30 + Math.floor(Math.random() * 30);
  const clScore = 40 + Math.floor(Math.random() * 50);
  const overall = Math.round((openingScore + ndScore + cpScore + ohScore + clScore) / 5);

  const allScores = [openingScore, ndScore, cpScore, ohScore, clScore];
  const dimNamesArr = ['开场破冰', '需求挖掘', '课程介绍', '异议处理', '成交推进'];
  const strengths = allScores.map((s, i) => ({ area: dimNamesArr[i], score: s })).filter(s => s.score >= 75);
  const weaknesses = allScores.map((s, i) => ({ area: dimNamesArr[i], score: s })).filter(s => s.score <= 45);

  const isExcellent = overall >= 80;

  return {
    metrics: { push_inquiry_ratio: (coveredCount / 4 * 100).toFixed(1), push_count: Math.floor(len / 50), inquiry_count: coveredCount * 3 + Math.floor(Math.random() * 5), speaking_ratio: '55%' },
    objection_handling: [
      { objection_type: '价格异议', handled: ohScore >= 50, response_quality: ohScore, suggested_response: ohScore >= 50 ? '已有效处理' : '建议使用"价值对比法"应对' },
      { objection_type: '效果顾虑', handled: ohScore >= 60, response_quality: Math.max(30, ohScore - 10), suggested_response: '建议展示具体案例和数据' }
    ],
    spin_analysis: spinAnalysis,
    script_score: { opening: openingScore, needs_discovery: ndScore, course_presentation: cpScore, objection_handling: ohScore, closing: clScore, overall },
    key_phrases_used: strengths.slice(0, 3).map(s => `${s.area}表现良好 (${s.score}分)`),
    missed_opportunities: weaknesses.slice(0, 2).map(w => `在${w.area}环节可以加强 (${w.score}分)`),
    highlight_spans: [],
    spark_report: {
      strengths: strengths.length > 0 ? [`SPIN四维度覆盖${coveredCount}/4，${strengths.map(s => s.area).join('、')}表现突出`] : [],
      potential: weaknesses.length > 0 ? `提升${weaknesses.map(w => w.area).join('、')}可有效提高整体评分` : '',
      areas: weaknesses.length > 0 ? weaknesses.map(w => `${w.area}: 当前${w.score}分，目标≥70分`) : [],
      revision_priority: weaknesses.length > 0 ? [weaknesses[0].area] : [],
      keep_going: '坚持练习，持续提升沟通质量！'
    },
    golden_scripts: [
      { text: '非常感谢您的耐心沟通。根据您刚才提到的孩子情况，我们有一款课程特别适合，能够有针对性地帮助孩子提升。', scene: '需求匹配', reason: '场景化推荐，直击痛点，语气亲切自然' }
    ],
    tags: ['SPIN提问', '需求挖掘', '异议处理'],
    parent_type: coveredCount >= 3 ? ['理性分析型'] : ['价格敏感型'],
    problem_types: ['价格异议'],
    is_excellent: isExcellent,
    excellence_reason: isExcellent ? 'SPIN维度覆盖全面，话术自然流畅' : '',
    best_script_moments: [{ time: '通话中段', text: '理解您的顾虑...我们可以先安排试听', score: overall, comment: '共情+方案并行' }]
  };
}

function generateReportHtml(consultantName, calls, diag, avgScore) {
  const callCards = calls.map((c, i) => {
    const a = safeJsonParse(c.analysis_json) || {};
    const ss = a.script_score || {};
    return `<div style="margin-bottom:24px;padding:20px;background:#f8fafc;border-radius:12px;border-left:4px solid ${ss.overall >= 80 ? '#22c55e' : ss.overall >= 60 ? '#f59e0b' : '#ef4444'}">
      <h4 style="margin:0 0 8px">第${i+1}通 · ${c.call_date || ''} · 评分: ${ss.overall || 0}分</h4>
      <p style="color:#64748b;margin:0">${jsonToText(a.spark_report || {})}</p>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${consultantName} 话术指导报告</title>
<style>body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;max-width:900px;margin:0 auto;padding:40px 20px;color:#1e293b;line-height:1.8}
h1{font-size:28px;margin-bottom:8px}h2{font-size:20px;margin:32px 0 16px;padding-bottom:8px;border-bottom:2px solid #3b82f6}
.score-badge{display:inline-block;padding:4px 16px;border-radius:20px;font-size:14px;font-weight:600}
.score-high{background:#dcfce7;color:#16a34a}.score-mid{background:#fef3c7;color:#d97706}.score-low{background:#fee2e2;color:#dc2626}
.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}
.stat-card{background:#f1f5f9;border-radius:12px;padding:20px;text-align:center}
.stat-card .num{font-size:32px;font-weight:700;color:#3b82f6}.stat-card .label{font-size:13px;color:#64748b;margin-top:4px}
.call-card{border-radius:12px;padding:20px;margin-bottom:16px;background:#f8fafc}
</style></head><body>
<h1>${consultantName} 话术指导报告</h1>
<div class="stat-grid">
<div class="stat-card"><div class="num">${calls.length}</div><div class="label">分析通话数</div></div>
<div class="stat-card"><div class="num">${avgScore}</div><div class="label">平均得分</div></div>
<div class="stat-card"><div class="num">${calls[0]?.call_date || '-'}</div><div class="label">最近通话</div></div>
</div>
<h2>逐通通话分析</h2>${callCards}
<p style="text-align:center;color:#94a3b8;margin-top:40px;font-size:12px">由 CallCoach 自动生成 · ${new Date().toISOString().split('T')[0]}</p>
</body></html>`;
}

function jsonToText(obj) {
  if (typeof obj === 'string') return obj;
  if (!obj) return '';
  const parts = [];
  if (obj.strengths) parts.push(`优势: ${obj.strengths}`);
  if (obj.potential) parts.push(`潜力: ${obj.potential}`);
  if (obj.areas) parts.push(`待提升: ${obj.areas}`);
  return parts.join(' | ') || JSON.stringify(obj);
}

// ==================== 启动服务器 ====================
app.listen(PORT, () => {
  console.log(`🚀 CallCoach Server v2 running on http://localhost:${PORT}`);
  console.log(`   Backend: Supabase (${SUPABASE_URL})`);
  console.log(`   LLM: ${DEEPSEEK_API_KEY ? `DeepSeek (${LLM_MODEL} @ ${DEEPSEEK_BASE_URL})` : 'Rule-Based（未配置 DEEPSEEK_API_KEY）'}`);
  console.log(`   Storage: Supabase Storage`);
});

module.exports = app;

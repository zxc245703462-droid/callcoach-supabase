# CallCoach v2 部署指南

## 架构概览

```
用户浏览器
    ↓
Vercel (前端静态 HTML)
    ↓  API 调用
Render (Node.js Express 后端)
    ↓  pg + storage
Supabase (PostgreSQL + 文件存储)
```

**核心特性**：所有人数据汇总到同一 Supabase 数据库，用户 A 上传的话术用户 B 可见。

---

## 第一步：创建 Supabase 项目

1. 打开 [supabase.com](https://supabase.com)，注册/登录
2. 点击 **New project**
3. 输入项目名 `callcoach`，设置数据库密码
4. Region 选 **Northeast Asia (Tokyo)** 或 **Southeast Asia (Singapore)**
5. 等待项目创建完成（约 2 分钟）

## 第二步：建表

1. 进入 Supabase Dashboard → **SQL Editor**
2. 点击 **New query**
3. 复制 `supabase-schema.sql` 的全部内容粘贴进去
4. 点击 **Run** 执行

## 第三步：创建 Storage Buckets

1. 进入 Supabase Dashboard → **Storage**
2. 创建以下 3 个 bucket（均为 **Public** 权限）：
   - `audio` — 通话录音
   - `reports` — HTML 报告
   - `scripts` — 话术库音频

## 第四步：获取 API 密钥

1. 进入 Supabase Dashboard → **Settings** → **API**
2. 复制以下两个值：
   - **Project URL** (格式: `https://xxxxx.supabase.co`)
   - **service_role key** (以 `eyJ...` 开头)

## 第五步：部署后端 (Render)

### 方式 A：Render Blueprint (推荐)

1. 把整个 `deploy/supabase/` 目录推送到 GitHub 仓库
2. 打开 [render.com](https://render.com)，注册/登录
3. 点击 **New** → **Blueprint**
4. 连接 GitHub 仓库，Render 自动识别 `render.yaml`
5. 在环境变量中填入：
   - `SUPABASE_URL` = 你的 Supabase Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = 你的 service_role key
   - `DEEPSEEK_API_KEY` = DeepSeek API 密钥（可选）
6. 点击 **Apply**，等待部署完成
7. 记下后端地址：`https://callcoach-api.onrender.com`

### 方式 B：手动部署

```bash
cd deploy/supabase
npm install
cp .env.example .env
# 编辑 .env 填入真实值
node server.js
```

## 第六步：部署前端 (Vercel)

1. 修改 `public/index.html` 中的 `API_BASE`：
   ```javascript
   const API_BASE = 'https://callcoach-api.onrender.com';
   ```
2. 把整个 `deploy/supabase/` 目录推送到 GitHub
3. 打开 [vercel.com](https://vercel.com)，注册/登录
4. 点击 **New Project**，导入 GitHub 仓库
5. Root Directory 设为 `deploy/supabase`
6. 点击 **Deploy**
7. 记下前端地址：`https://callcoach.vercel.app`

## 第七步：验证数据汇总

1. 打开前端地址，上传一个音频文件
2. 切换到话术库，确认语音分析结果可见
3. 换另一台设备/浏览器打开同一网址
4. 话术库应显示相同的分析结果 → 数据汇总成功 ✓

---

## 环境变量参考

| 变量 | 说明 | 必须 |
|------|------|------|
| `SUPABASE_URL` | Supabase 项目 URL | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key | ✅ |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | ❌ 不配则用规则引擎 |
| `DEEPSEEK_BASE_URL` | LLM API 地址 | ❌ 默认 DeepSeek |
| `LLM_MODEL` | 模型名称 | ❌ 默认 deepseek-chat |
| `MIN_CALLS_INITIAL` | 初步诊断最低通话数 | ❌ 默认 3 |
| `MIN_CALLS_FULL` | 深度诊断最低通话数 | ❌ 默认 5 |
| `PORT` | 服务端口 | ❌ 默认 3000 |

---

## API 端点速查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 系统状态 |
| GET | `/api/consultants` | 顾问列表 |
| GET | `/api/calls?consultant=X` | 通话列表 |
| GET | `/api/calls/:id` | 通话详情 |
| DELETE | `/api/calls/:id` | 删除通话 |
| GET | `/api/stats` | 统计面板 |
| POST | `/api/upload` | 上传音频/文本 |
| POST | `/api/run-pipeline` | 批量分析 |
| POST | `/api/analyze-call/:id` | 单条分析 |
| GET | `/api/diagnosis/:id` | 诊断报告 |
| GET | `/api/coaching/:id` | 教练计划 |
| GET | `/api/library` | 话术库列表 |
| POST | `/api/library/upload` | 上传话术 |
| DELETE | `/api/library/:id` | 删除话术 |
| GET | `/api/reports` | 报告列表 |
| DELETE | `/api/reports/:name` | 删除报告 |
| GET | `/api/download-report/:name` | 下载报告 |
| POST | `/api/generate-report/:id` | 生成报告 |
| DELETE | `/api/consultant/:id` | 删除顾问 |

---

## 常见问题

**Q: 前端一直显示"加载中..."**
A: 检查 `API_BASE` 是否指向正确的后端地址，确认后端已部署且 CORS 已启用。

**Q: 上传音频后无分析结果**
A: 当前版本使用规则引擎分析，上传后需点击"运行分析"。DeepSeek API 密钥配置后可使用 AI 分析。

**Q: 数据没汇总？**
A: 确认前后端都连接同一个 Supabase 项目。检查 Supabase Dashboard → Table Editor 确认数据已写入。

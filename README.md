# CallCoach 线上部署指南

## 方案 A：GitHub Pages 静态演示版（推荐用于展示）

**特点**：无需后端，数据内嵌，开箱即用。适合给客户/团队看演示。

### 部署步骤

1. 将 `deploy/gh-pages/index.html` 提交到 GitHub 仓库
2. 在仓库 Settings → Pages 中：
   - Source: **Deploy from a branch**
   - Branch: `main`，文件夹: `/deploy/gh-pages`
3. 保存后等1-2分钟，访问 `https://你的用户名.github.io/仓库名/`

> **提示**：想更新数据？重新运行 `python deploy/build_ghpages.py`（需要本地服务器运行中）

---

## 方案 B：Render 完整后端版（用于实际使用）

**特点**：完整的 Flask 后端，支持上传音频、运行分析流水线、生成报告。

### 一键部署（推荐）

1. 将整个项目推送到 GitHub
2. 打开 [Render Dashboard](https://dashboard.render.com/)
3. 点 **New +** → **Blueprint**
4. 连接你的 GitHub 仓库
5. Render 自动读取 `deploy/render/render.yaml` 完成部署

### 手动部署

如果不用 Blueprint，在 Render 中手动创建 Web Service：

| 配置项 | 值 |
|--------|-----|
| Runtime | Python 3 |
| Build Command | `pip install -r deploy/render/requirements.txt` |
| Start Command | `gunicorn gunicorn_entry:app --bind 0.0.0.0:$PORT --workers 2 --timeout 120` |

环境变量：

```
STORAGE_BACKEND=local
LLM_BACKEND=rule_based
```

### 启用完整功能

如需使用 AI 分析和飞书存储，修改环境变量：

```
STORAGE_BACKEND=feishu
LLM_BACKEND=openai_compatible
FEISHU_APP_ID=你的飞书AppID
FEISHU_APP_SECRET=你的飞书密钥
FEISHU_BITABLE_APP_TOKEN=你的多维表格Token
LLM_API_KEY=你的API Key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL_NAME=gpt-4o
```

---

## 方案 C：本地运行

```bash
cd callcoach
pip install -r deploy/render/requirements.txt
cp .env.example .env  # 按需修改
python web_app.py
# 访问 http://localhost:5000
```

# B站财经评论情绪分析（油猴脚本）

通过自定义接口获取 B 站视频评论（含子评论），利用 AI 大模型进行加权情绪分析，生成情绪分布图表与关键摘要。

## 功能特性

- 🔌 **接口驱动**：不依赖 DOM 抓取，通过你自建的后端接口获取评论数据
- 🧠 **AI 情绪分析**：支持 OpenAI / Claude / 国产大模型等任意兼容端点
- ⚖️ **加权分析**：评论权重 = 点赞数 + 回复数 × 因子 + 子评论点赞 × 0.3，热度越高影响力越大
- 📊 **可视化图表**：Chart.js 饼图展示情绪分布，仪表盘展示情绪指数
- 📝 **关键引用**：AI 自动提取 3-5 条最具代表性的高权重评论
- ⚙️ **高度可配置**：接口地址、AI 模型、情绪标签、权重因子等全部可在设置中调整

## 安装方法

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey / Greasemonkey）
2. 点击 Tampermonkey 图标 → "添加新脚本"
3. 删除编辑器中的默认内容，将 `bili-comment-emotion.user.js` 的全部代码粘贴进去
4. 按 `Ctrl+S`（或点击文件 → 保存）保存脚本
5. 打开任意 B 站视频页面（`https://www.bilibili.com/video/BVxxxxx`），右下角会出现"情绪分析"按钮

## 首次使用配置

点击按钮后，如果未配置会提示前往设置。必须填写以下两项：

### 1. AI 配置
- **API Key**：你的大模型 API Key（如 OpenAI 的 `sk-xxx`）
- **API 基础地址**：
  - OpenAI: `https://api.openai.com/v1`
  - Claude: `https://api.anthropic.com/v1`
  - 国产代理（如 DeepSeek）: `https://api.deepseek.com/v1`
- **模型名称**：如 `gpt-4o-mini`、`claude-3-haiku-20240307`、`deepseek-chat`

### 2. 评论接口配置
- **接口地址**：你的后端评论抓取接口，**可用 `{bvid}` 占位符**，如：
  ```
  https://your-api.com/api/comments?bvid={bvid}
  ```
- **请求方法**：GET 或 POST
- **数据路径**：接口返回 JSON 中评论数组的路径，如 `data`、`data.list`、`result.comments`
- **请求 Headers**：如有鉴权，填写 JSON，如 `{"Authorization":"Bearer xxx"}`
- **请求 Body**：POST 时使用，同样支持 `{bvid}` 占位符，如 `{"bvid":"{bvid}"}`

### 3. 分析配置
- **最大评论数**：传给 AI 的评论数量上限（默认 150，建议 100-300）
- **回复权重因子**：1 条回复等效于多少个赞（默认 1.0）
- **情绪标签**：可自定义分析维度，默认是投资情绪九分类

## 接口数据格式约定

你的后端接口返回的 JSON 中，每条评论对象应包含以下字段（字段名不敏感，脚本会自动适配）：

```json
{
  "code": 0,
  "data": [
    {
      "content": "这条评论的内容",
      "likes": 128,
      "replies": 12,
      "subComments": [
        { "content": "子评论内容", "likes": 3 }
      ]
    }
  ]
}
```

### 支持的字段映射

脚本会自动尝试以下字段名，所以你无需严格对齐：

| 含义 | 支持的字段名 |
|------|-------------|
| 评论内容 | `content`, `text`, `message`, `desc` |
| 点赞数 | `likes`, `like`, `thumbs`, `up_count` |
| 回复数 | `replies`, `reply_count`, `reply`, `rcount` |
| 子评论数组 | `subComments`, `sub_comments`, `replies_list`, `children` |
| 子评论点赞 | `likes`, `like` |

如果数据结构差异较大，可修改 `normalizeComments` 函数适配。

## 权重计算逻辑

单条评论的权重公式：

```
权重 = 点赞数 + 回复数 × 回复权重因子 + Σ(子评论点赞) × 0.3
```

- 高赞、高回复、子评论活跃的主评论会被优先传给 AI
- AI Prompt 中会标注每条评论的权重，引导模型在统计占比时更重视高热度评论

## 后端接口参考实现（Node.js）

如果你还没有后端接口，以下是一个基于 B 站官方 API 的最小实现：

```javascript
const express = require('express');
const axios = require('axios');
const app = express();

// B站评论接口
async function fetchBilibiliComments(bvid) {
    // 1. 先获取 oid (avid)
    const viewRes = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    const oid = viewRes.data.data.aid;

    // 2. 获取评论
    const comments = [];
    let next = 1;
    while (next) {
        const url = `https://api.bilibili.com/x/v2/reply?type=1&oid=${oid}&pn=${next}&ps=20&sort=2`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const replies = res.data.data.replies || [];
        if (replies.length === 0) break;

        for (const r of replies) {
            comments.push({
                content: r.content.message,
                likes: r.like,
                replies: r.rcount,
                subComments: (r.replies || []).map(s => ({
                    content: s.content.message,
                    likes: s.like,
                })),
            });
        }
        next = res.data.data.cursor.next;
        if (!next || next > 5) break; // 限制页数防止被封
    }
    return comments;
}

app.get('/api/comments', async (req, res) => {
    const { bvid } = req.query;
    if (!bvid) return res.status(400).json({ error: '缺少 bvid' });
    try {
        const data = await fetchBilibiliComments(bvid);
        res.json({ code: 0, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(3000, () => console.log('接口运行在 http://localhost:3000'));
```

**注意**：实际部署时建议加上缓存、限流、IP 代理，避免被 B 站风控。

## 常见问题

### 点击按钮后提示"接口请求失败"
- 检查接口地址是否正确，是否包含 `http://` 或 `https://`
- 如果你的接口和后端不在同域，需要开启 CORS（`Access-Control-Allow-Origin: *`）
- 检查 Tampermonkey 的 `@connect` 元数据是否包含你的接口域名，或在设置里添加

### AI 返回"解析失败"
- 检查 API Key 和基础地址是否正确
- 某些国产模型返回格式与 OpenAI 不完全兼容，可尝试调整 `apiBase` 到兼容端点
- 在浏览器 F12 → Network 中查看实际返回内容

### 情绪图表不显示
- 检查网络是否能访问 `cdn.jsdelivr.net`（Chart.js CDN）
- 若无法访问，可将 `@require` 替换为可访问的 CDN 地址

## 文件说明

```
bili-comment-emotion/
├── bili-comment-emotion.user.js   # 主油猴脚本（全部逻辑）
└── README.md                       # 本文件
```

## 自定义开发

如需调整情绪标签或权重算法，直接修改脚本中的以下部分：
- `EMOTION_LIST()`：默认情绪分类
- `calcWeight()`：权重计算公式
- `normalizeComments()`：接口数据字段映射
- Prompt 模板：`prepareCommentsForAI()` 中的 `prompt` 字符串

## License

MIT

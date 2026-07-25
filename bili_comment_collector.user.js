// ==UserScript==
// @name         B站评论区-评论收集器
// @namespace    https://github.com/liudewa
// @version      1.0
// @description  通过fetch劫持收集滚动过的评论，点击按钮在控制台输出
// @author       liudewa
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/opus/*
// @match        https://www.bilibili.com/player/web_comment/*
// @match        https://comment.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";
  function _formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function _formatPostTime(pt = new Date()) {
    if (!pt) return "";
    // 数字时间戳（秒）
    if (typeof pt === "number") {
      const d = new Date(pt * 1000);
      return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    // 已是格式化字符串
    if (/\d{4}年/.test(pt)) return pt;
    // 尝试解析
    const d = new Date(pt);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    return pt;
  }
  // 评论热度打分
  function calcScoreFCHI(comment, nowTs = 0) {
    // 1. 基础交互分（对数压缩）
    const likeScore = Math.log2(comment.likes + 2);
    const replyScore = 1.3 * Math.log2(comment.replyCount + 2);
    const baseScore = likeScore + replyScore;

    // 2. UP主背书系数
    let upWeight = 1.0;
    if (comment.upReply) {
      upWeight = 3.0;
    } else if (comment.upLike) {
      upWeight = 1.8;
    }

    // 3. 用户等级权重
    function getLevelScope(l) {
      switch (true) {
        case l < 5:
          return 0.1;
          break;
        case l < 10:
          return 0.3;
          break;
        case l < 15:
          return 0.5;
          break;
        case l < 25:
          return 0.7;
          break;
        case l >= 25:
          return 1;
          break;
        default:
          return 0;
      }
    }
    // const levelMap = { 5: 0.1, 10: 0.3, 15: 0.5, 25: 0.7, 30: 1.0 };
    const levelWeight = getLevelScope(comment.userLevel);

    // 4. 时效衰减
    // const deltaHours = Math.max(0, (nowTs - comment.timestamp) / 3600);
    // const lambda = 0.05; // MVP统一衰减系数
    // const timeDecay = Math.exp(-lambda * deltaHours);

    // 5. 综合热度
    // const fchi = baseScore * upWeight * levelWeight * timeDecay;
    const fchi = baseScore * upWeight * levelWeight;

    return Math.round(fchi * 100) / 100;
  }

  /* ===== 评论缓存 ===== */
  const commentStore = {
    comments: [], // 所有评论（含子评论展平）
    seenIds: new Set(), // rpid 去重
    onUpdate: null, // 更新回调
    // 手动填写的帖子数据（getOpusData 返回 null 时的降级方案）
    manualPostData: null,

    /** 一级评论数量 */
    mainCount() {
      let c = 0;
      for (const cm of this.comments) {
        if (cm.type === "main") c++;
      }
      return c;
    },

    /** 添加一条主评论及其子评论，返回新增条数 */
    addReply(r) {
      if (!r || !r.content) return 0;
      const rpid = r.rpid || r.rpid_str;
      if (this.seenIds.has(rpid)) return 0;
      this.seenIds.add(rpid);

      const main = {
        type: "main", // 一级评论
        rpid, // 评论id
        user: r.member?.uname || "匿名", // 评论用户名
        userLevel: r.member?.level_info?.current_level || 0, // 评论用户等级
        content: r.content.message || "", // 评论内容
        likes: r.like || 0, // 评论点赞
        replyCount: r.rcount || 0, // 评论回复数量
        upLike: r.reply_control?.up_like, // UP主是否点赞
        upReply: r.reply_control?.up_reply, // UP主是否回复
        ipAddress: r.reply_control?.location, // 评论用户IP地方(省)
        time: _formatTime(r.ctime), // 评论时间
        timestamp: r.ctime, // 评论时间戳
      };
      main.scope = calcScoreFCHI(main);
      this.comments.push(main);
      let added = 1;

      // 处理子评论
      if (Array.isArray(r.replies)) {
        r.replies.forEach((sr) => {
          const srpid = sr.rpid || sr.rpid_str;
          if (!srpid || this.seenIds.has(srpid)) return;
          this.seenIds.add(srpid);
          this.comments.push({
            type: "sub",
            rpid: srpid,
            parentRpid: rpid,
            user: sr.member?.uname || "匿名",
            content: sr.content.message || "",
            likes: sr.like || 0,
            replyCount: 0,
            time: _formatTime(sr.ctime),
            timestamp: sr.ctime,
          });
          added++;
        });
      }

      if (this.onUpdate) this.onUpdate();
      return added;
    },

    /** 统计信息 */
    stats() {
      const mains = this.comments.filter((c) => c.type === "main");
      const subs = this.comments.filter((c) => c.type === "sub");
      return {
        total: this.comments.length,
        mains: mains.length,
        subs: subs.length,
      };
    },

    /** 生成 Markdown（帖子 + 评论区 + 分析任务） */
    toMarkdown() {
      const mains = this.comments.filter((c) => c.type === "main");
      const subs = this.comments.filter((c) => c.type === "sub");
      const path = location.pathname;
      const now = _formatPostTime();

      let md = "";

      // ── # 帖子 ──
      try {
        const opus = getOpusData() || this.manualPostData;
        if (opus) {
          md += `# 帖子\n\n`;
          md += `## 帖子数据\n\n`;
          md += `【标题】${opus.title || ""}\n`;
          md += `【发布时间】${_formatPostTime(opus.post_time)}\n`;
          const s = opus.stats || {};
          md += `【效果】点赞数量: ${s.like ?? 0};收藏数量: ${s.favorite ?? 0};转发数量: ${s.forward ?? 0};评论数量: ${s.comment ?? 0};投币数量: ${s.coin ?? 0}\n`;
          md += `【UP主】${opus.up_master || ""}\n`;
          if (opus.content) {
            md += `\n## 帖子内容\n\n---\n\n${opus.content}\n\n---\n`;
          }
          md += `\n`;
        }
      } catch (_) {}

      // ── # 评论区 ──
      md += `# 评论区\n\n`;
      md += `## 评论区数据\n\n`;
      md += `> 共 **${mains.length}** 条主评论，**${subs.length}** 条子评论\n`;
      md += `> 视频: \`${path}\` | 抓取时间: ${now}\n`;
      md += `> 按综合热度降序排列\n\n`;
      md += `---\n\n`;
      md += `## 评论列表\n\n`;

      const sortedMains = [...mains].sort((a, b) => b.scope - a.scope);
      sortedMains.forEach((m, idx) => {
        const subsOfThis = subs.filter((s) => s.parentRpid === m.rpid);
        md += `### ${idx + 1}. ${m.user} [🔥${m.likes} 💬${m.replyCount} 📊${m.scope}]\n`;
        md += `> ${m.time} | IP属地：${m.ipAddress || "未知"}\n\n`;
        md += `${m.content}\n\n`;
        if (subsOfThis.length > 0) {
          subsOfThis.forEach((s) => {
            md += `- ${s.user}: ${s.content} (👍${s.likes})\n`;
          });
          md += `\n`;
        }
        md += `---\n\n`;
      });

      // ── 注意 + 分析任务 ──
      md += `# 注意\n\n`;
      md += `- 评论格式\n\n`;
      md += `\`\`\`md\n`;
      md += `### 序号1. 用户名 [点赞数量 评论数量 分数权重]\n\n`;
      md += `> 评论见时间 | 用户名IP属地\n\n`;
      md += `评论内容\n\n`;
      md += `- 用户名: 子评论内容\n`;
      md += `- 用户名: 子评论内容\n\n`;
      md += `---\n\n`;
      md += `### 序号2.\n`;
      md += `\`\`\`\n\n`;
      md += `- {'[微笑]'} 帖子和评论区中为B站表情包,对分析也重要\n\n`;
      md += `# 分析任务\n\n`;
      md += `你是一个A股散户心理情绪观察舆情助手。请综合正文立场与评论区高热度反馈（按FCHI降序排列），输出【散户情绪阶段报告】。你的核心目标是识别当前市场处于情绪轮动链条的哪个位置，并给出对应的交易操作建议。\n\n`;
      md += `## 情绪轮动模型（建仓视角：底部→中途→顶部）\n\n`;
      md += `### 第一阶段：冰点（底部｜无人问津，适合买入/抄底）\n\n`;
      md += `- 核心心理：麻木、绝望、丧失信心\n`;
      md += `- 评论区特征：评论稀少或死气沉沉；大量求安慰/求按摩内容/诉苦；充斥销户、摆烂、躺平言论、爆仓、卖房、家人、量化；对利好消息完全脱敏甚至解读为利空\n`;
      md += `- B站典型语料："跌麻/嘛了"、"抄底抄在半山腰"、"做家务"、"不玩了准备销户"、"再怎么反弹也是诱多"、"懒得看盘了"、"谁还敢进场"、"利好出尽就是利空"、"分析的再多都是跌"、"这市场已经彻底没救了"、"对不起家人"、"终于收盘了"、"*家跌停"、"保卫战"、"UP救我"\n\n`;
      md += `### 第二阶段：观望（中途｜震荡拉锯，适合观望）\n\n`;
      md += `- 核心心理：怀疑、犹豫、摇摆不定\n`;
      md += `- 评论区特征：评论量逐步回升但分歧巨大；刚回本就急于跑路；频繁询问是反弹还是反转；想进场又怕追高；老股民PTSD发作反复提及上次被套经历\n`;
      md += `- B站典型语料："反弹还是反转"、"不敢加仓怕冲高回落"、"涨这么多随时要回调"、"有点想进但怕追在半山腰"、"先观望确认趋势再说"、"垃圾盘面浪费时间"、"垃圾行情没意思"、"看盘不如出去旅游"\n\n`;
      md += `### 第三阶段：沸腾（顶部｜人声鼎沸，适合减仓/卖出）\n\n`;
      md += `- 核心心理：狂热、贪婪、亢奋\n`;
      md += `- 评论区特征：评论刷屏爆满；大量晒收益/晒截图/晒消费/夸赞UP；低于8级账号密集涌入;新手求代码求带；询问目标点位；出现踏空/借钱/梭哈/卖房/开户/杠杆等言论\n`;
      md += `- B站典型语料："还能买吗"、"家庭地位"、"开香槟"、"要消费"、"UP牛逼"、"膜拜UP"、"赢嘛/麻了"、"今天就这样吧"、"收盘吧"、"翻倍"\n\n`;
      md += `## 分析规则\n\n`;
      md += `### 内容\n\n`;
      md += `- UP主观点仅作参考锚点，当UP主立场与高热度评论共识严重背离时，以评论区共识为准（散户情绪指标反映的是群体心理而非个体观点）\n\n`;
      md += `### 表情包\n\n`;
      md += `- [doge]/[狗头]：搭配赞美或极端口号时，视为绝望期反讽或怀疑期自嘲，严禁归入狂热期。仅在有具体数据论证时才可能为中性。\n`;
      md += `- [吃瓜]/[瓜子]：代表观望、质疑或看戏，对应怀疑犹豫期，绝非认同或狂热信号。\n`;
      md += `- [笑哭]/[捂脸]：搭配亏损内容为绝望期自嘲；搭配UP主看多观点为无奈不认可，对应怀疑期，非看多信号。\n`;
      md += `- [微笑]/[呵呵]：B站语境下几乎100%为负面反讽，代表彻底失望，对应麻木绝望期。\n`;
      md += `- 空洞表情刷屏：无具体论据的[打call][赞]且集中在低等级账号，视为水军或反串，不作为狂热依据。\n`;
      md += `- 楼中楼联动：主评表情积极但楼中楼出现≥3条反讽表情或反驳，以楼中楼共识为准，主评情绪强制降级。\n`;
      md += `- 语义冲突：文本与表情情绪相反时，优先以表情为准；连续重复相同表情≥3个，置信度下调0.3并标记异常\n\n`;
      md += `## 操作建议映射\n\n`;
      md += `- 第一阶段（冰点）→ 抄底 / 分批建仓\n`;
      md += `- 第二阶段（观望）→ 观望 / 轻仓试探\n`;
      md += `- 第三阶段（沸腾）→ 减仓 / 分批卖出\n`;
      md += `- 数据不可靠时 → 观望（禁止给出方向性建议）\n\n`;
      md += `## 输出格式\n\n`;
      md += `仅返回以下JSON结构，不包含任何解释性文字、markdown标记或额外说明：\n\n`;
      md += `{\n`;
      md += `"stage": "麻木绝望期|怀疑犹豫期|狂热贪婪期|数据不可靠",\n`;
      md += `"operation": "抄底|建仓|观望|减仓|卖出",\n`;
      md += `"confidence": 0.0至1.0之间的浮点数,\n`;
      md += `"core_evidence": "≤40字的核心判定依据，引用最具代表性的评论关键词",\n`;
      md += `"up_crowd_relation": "一致|弱背离|强背离|UP主缺位",\n`;
      md += `"risk_note": "水军干扰|反讽密集|样本过少|情绪极端化|null"\n`;
      md += `}\n`;

      return md;
    },

    /** 复制到剪贴板 */
    async copyToClipboard() {
      const md = this.toMarkdown();
      // 尝试现代 API
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
        return true;
      }
      // 降级方案
      const ta = document.createElement("textarea");
      ta.value = md;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    },

    /** 清空 */
    clear() {
      this.comments = [];
      this.seenIds.clear();
      if (this.onUpdate) this.onUpdate();
    },
  };
  /* 获取帖子信息 */
  function getOpusData() {
    const state = window.__INITIAL_STATE__;

    if (!state || !state.detail) {
      console.warn("[Opus提取] 未找到有效的 __INITIAL_STATE__");
      return null;
    }

    const modules = state.detail.modules || [];
    const getModule = (type) => modules.find((m) => m.module_type === type);

    const authorMod = getModule("MODULE_TYPE_AUTHOR")?.module_author;
    const contentMod = getModule("MODULE_TYPE_CONTENT")?.module_content;
    const statMod = getModule("MODULE_TYPE_STAT")?.module_stat;

    // 提取纯文本内容（含表情文字标识）
    let content = "";
    if (contentMod?.paragraphs) {
      content = contentMod.paragraphs
        .filter((p) => p.para_type === 1 && p.text?.nodes)
        .map((p) =>
          p.text.nodes
            .map((node) => node.word?.words || node.rich?.orig_text || "")
            .join(""),
        )
        .join("\n");
    }

    // 提取图片列表
    const images = [];
    if (contentMod?.paragraphs) {
      contentMod.paragraphs
        .filter((p) => p.para_type === 2 && p.pic?.pics)
        .forEach((p) => {
          p.pic.pics.forEach((pic) => {
            if (pic.url) images.push(pic.url.replace(/^http:/, "https:"));
          });
        });
    }

    return {
      title: state.detail.basic?.title || "", // 标题
      content, // 内容
      images, // 内容图片
      up_master: authorMod?.name || "", // UP主名字
      up_mid: authorMod?.mid || 0, // UP主ID
      post_time: authorMod?.pub_time || "", // 发帖时间
      stats: {
        like: statMod?.like?.count ?? 0, // 帖子点赞数量
        favorite: statMod?.favorite?.count ?? 0, // 帖子收藏数量
        forward: statMod?.forward?.count ?? 0, // 帖子转发数量
        comment: statMod?.comment?.count ?? 0, // 帖子评论数量
        coin: statMod?.coin?.count ?? 0, // 帖子投币数量
      },
    };
  }

  /* ===== fetch 劫持 获取评论区 ===== */
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const [url] = args;
    return nativeFetch.apply(this, args).then((resp) => {
      if (
        typeof url === "string" &&
        url.includes("/x/v2/reply") &&
        url.includes("mode=2")
      ) {
        const clone = resp.clone();
        clone.text().then((body) => {
          try {
            const j = JSON.parse(body);
            const replies = j.data?.replies || [];
            replies.forEach((r) => commentStore.addReply(r));
          } catch (_) {}
        });
      }
      return resp;
    });
  };

  /* ===== 样式注入 ===== */
  const injectStyles = () => {
    if (document.getElementById("bili-collect-styles")) return;
    const style = document.createElement("style");
    style.id = "bili-collect-styles";
    style.textContent = `
      #bili-post-panel {
        position: fixed; top: 0; right: -400px; width: 380px; height: 100vh;
        background: #fff; box-shadow: -4px 0 20px rgba(0,0,0,0.15);
        z-index: 100001; transition: right 0.35s cubic-bezier(0.4,0,0.2,1);
        display: flex; flex-direction: column;
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      }
      #bili-post-panel.open { right: 0; }
      .bpp-header {
        padding: 14px 16px; border-bottom: 1px solid #eee;
        display: flex; align-items: center; justify-content: space-between;
        background: #fafafa; font-size: 14px; font-weight: bold; color: #222;
      }
      .bpp-close { cursor: pointer; font-size: 20px; color: #888; line-height: 1; }
      .bpp-close:hover { color: #333; }
      .bpp-body { flex: 1; overflow-y: auto; padding: 16px; }
      .bpp-group { margin-bottom: 12px; }
      .bpp-group label {
        display: block; font-size: 11px; color: #888; margin-bottom: 3px; font-weight: 500;
      }
      .bpp-group input, .bpp-group textarea {
        width: 100%; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px;
        font-size: 12px; box-sizing: border-box; font-family: inherit;
      }
      .bpp-group textarea { resize: vertical; min-height: 60px; }
      .bpp-group input:focus, .bpp-group textarea:focus { outline: none; border-color: #00aeec; }
      .bpp-stats-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
      .bpp-stats-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .bpp-stats-row input, .bpp-stats-row2 input { text-align: center; }
      .bpp-footer {
        padding: 12px 16px; border-top: 1px solid #eee; display: flex; gap: 8px;
      }
      .bpp-btn {
        flex: 1; padding: 8px 0; border-radius: 6px; font-size: 13px; cursor: pointer;
        border: none; font-weight: 500;
      }
      .bpp-btn.primary { background: #00aeec; color: #fff; }
      .bpp-btn.primary:hover { background: #0095c7; }
      .bpp-btn.secondary { background: #f5f5f5; color: #555; border: 1px solid #ddd; }
      #bili-post-edit-btn {
        position: fixed; right: 24px; bottom: 236px; width: 28px; height: 28px;
        border-radius: 50%; background: #fff; border: 1px solid #e0e0e0;
        color: #888; font-size: 13px; cursor: pointer; z-index: 99999;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      }
      #bili-post-edit-btn:hover { color: #00aeec; border-color: #00aeec; }
      #bili-post-panel .hint { font-size: 10px; color: #bbb; margin-top: 2px; }
    `;
    document.head.appendChild(style);
  };

  /* ===== UI：浮动按钮 + 侧边面板 ===== */
  const injectButton = () => {
    if (document.getElementById("bili-collect-btn")) return;
    injectStyles();

    // ── 帖子信息面板 ──
    const panel = document.createElement("div");
    panel.id = "bili-post-panel";
    panel.innerHTML = `
      <div class="bpp-header">
        ✏️ 帖子信息
        <span class="bpp-close">&times;</span>
      </div>
      <div class="bpp-body">
        <div class="bpp-group">
          <label>标题</label>
          <input id="bpp-title" placeholder="帖子标题">
        </div>
        <div class="bpp-group">
          <label>发布时间</label>
          <input id="bpp-time" placeholder="">
        </div>
        <div class="bpp-group">
          <label>UP主</label>
          <input id="bpp-up" placeholder="UP主用户名">
        </div>
        <div class="bpp-group">
          <label>效果数据</label>
          <div class="bpp-stats-row">
            <div><input id="bpp-like" placeholder="点赞" type="number"></div>
            <div><input id="bpp-fav" placeholder="收藏" type="number"></div>
            <div><input id="bpp-fwd" placeholder="转发" type="number"></div>
          </div>
          <div class="bpp-stats-row2" style="margin-top:6px">
            <div><input id="bpp-cmt" placeholder="评论数" type="number"></div>
            <div><input id="bpp-coin" placeholder="投币" type="number"></div>
          </div>
        </div>
        <div class="bpp-group">
          <label>帖子内容</label>
          <textarea id="bpp-content" placeholder="帖子正文..."></textarea>
          <div class="hint">从页面复制粘贴帖子正文</div>
        </div>
      </div>
      <div class="bpp-footer">
        <button class="bpp-btn secondary" id="bpp-clear">清空</button>
        <button class="bpp-btn primary" id="bpp-copy">保存</button>
      </div>
    `;
    document.body.appendChild(panel);

    // 面板事件
    const openPanel = () => {
      // 从 manualPostData 回填（如果有）
      const d = commentStore.manualPostData;
      if (d) {
        document.getElementById("bpp-title").value = d.title || "";
        document.getElementById("bpp-time").value = d.post_time || "";
        document.getElementById("bpp-up").value = d.up_master || "";
        document.getElementById("bpp-content").value = d.content || "";
        document.getElementById("bpp-like").value = d.stats?.like || "";
        document.getElementById("bpp-fav").value = d.stats?.favorite || "";
        document.getElementById("bpp-fwd").value = d.stats?.forward || "";
        document.getElementById("bpp-cmt").value = d.stats?.comment || "";
        document.getElementById("bpp-coin").value = d.stats?.coin || "";
      }
      panel.classList.add("open");
    };
    const closePanel = () => panel.classList.remove("open");
    const collectForm = () => ({
      title: document.getElementById("bpp-title").value.trim(),
      content: document.getElementById("bpp-content").value.trim(),
      post_time:
        document.getElementById("bpp-time").value.trim() || _formatPostTime(),
      up_master: document.getElementById("bpp-up").value.trim(),
      stats: {
        like: parseInt(document.getElementById("bpp-like").value, 10) || 0,
        favorite: parseInt(document.getElementById("bpp-fav").value, 10) || 0,
        forward: parseInt(document.getElementById("bpp-fwd").value, 10) || 0,
        comment: parseInt(document.getElementById("bpp-cmt").value, 10) || 0,
        coin: parseInt(document.getElementById("bpp-coin").value, 10) || 0,
      },
    });

    panel.querySelector(".bpp-close").onclick = closePanel;
    document.getElementById("bpp-clear").onclick = () => {
      [
        "bpp-title",
        "bpp-time",
        "bpp-up",
        "bpp-content",
        "bpp-like",
        "bpp-fav",
        "bpp-fwd",
        "bpp-cmt",
        "bpp-coin",
      ].forEach((id) => {
        document.getElementById(id).value = "";
      });
      commentStore.manualPostData = null;
    };
    document.getElementById("bpp-copy").onclick = async () => {
      commentStore.manualPostData = collectForm();
      closePanel();
      // await doCopy();
    };

    // ── 主按钮 ──
    const btn = document.createElement("div");
    btn.id = "bili-collect-btn";
    btn.title = "点击复制评论为 Markdown\n右键清空缓存";
    Object.assign(btn.style, {
      position: "fixed",
      right: "24px",
      bottom: "180px",
      minWidth: "44px",
      height: "44px",
      padding: "0 14px",
      borderRadius: "22px",
      background: "#fff",
      border: "2px solid #00aeec",
      color: "#00aeec",
      fontSize: "16px",
      fontWeight: "bold",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "6px",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      zIndex: "99999",
      userSelect: "none",
      transition: "transform 0.15s",
      lineHeight: "1",
    });

    // 编辑按钮（手动填写帖子信息）
    const editBtn = document.createElement("div");
    editBtn.id = "bili-post-edit-btn";
    editBtn.title = "手动填写帖子信息";
    editBtn.textContent = "✏️";
    editBtn.onclick = openPanel;
    document.body.appendChild(editBtn);

    // 更新按钮数字
    const refreshBtn = () => {
      const n = commentStore.mainCount() || 0;
      btn.innerHTML = `📋<span style="color:#fb7299;font-size:16px">${n}</span>`;
    };
    commentStore.onUpdate = refreshBtn;
    refreshBtn();

    btn.onmouseenter = () => {
      btn.style.transform = "scale(1.1)";
      editBtn.style.transform = "scale(1.1)";
    };
    btn.onmouseleave = () => {
      btn.style.transform = "scale(1)";
      editBtn.style.transform = "scale(1)";
    };

    const doCopy = async () => {
      const s = commentStore.stats();
      if (s.mains === 0) return;
      try {
        await commentStore.copyToClipboard();
        btn.innerHTML = `📋<span style="color:#52c41a;font-size:14px">已复制</span>`;
        setTimeout(refreshBtn, 1200);
        console.log(
          `%c✅ 已复制 ${s.total} 条评论为 Markdown`,
          "color:#52c41a",
        );
      } catch (e) {
        console.log("失败原因: ", e);
        btn.innerHTML = `📋<span style="color:#ff4d4f;font-size:12px">失败</span>`;
        setTimeout(refreshBtn, 1200);
      }
    };

    // 左键：若无帖子数据则打开面板，否则直接复制
    btn.onclick = async () => {
      const s = commentStore.stats();
      if (s.mains === 0) return;
      const auto = getOpusData();
      if (!auto && !commentStore.manualPostData) {
        openPanel();
        return;
      }
      await doCopy();
    };

    // 右键：清空缓存
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      commentStore.clear();
    };

    document.body.appendChild(btn);
  };

  /* ===== 初始化 ===== */
  const init = () => {
    if (document.body) {
      injectButton();
    } else {
      // document-start 时 body 可能尚未就绪
      new MutationObserver(() => {
        if (document.body) {
          injectButton();
        }
      }).observe(document.documentElement, { childList: true });
    }
  };

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();

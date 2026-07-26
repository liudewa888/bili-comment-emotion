// ==UserScript==
// @name         B站评论区-评论收集器
// @namespace    https://github.com/liudewa
// @version      2.2
// @description  通过fetch劫持收集滚动过的评论，一键复制Markdown提示词，支持多套大模型API自动分析
// @author       liudewa
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/opus/*
// @match        https://www.bilibili.com/player/web_comment/*
// @match        https://comment.bilibili.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      *
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
    if (typeof pt === "number") {
      const d = new Date(pt * 1000);
      return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    if (/\d{4}年/.test(pt)) return pt;
    const d = new Date(pt);
    if (!isNaN(d.getTime())) {
      return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    return pt;
  }

  function calcScoreFCHI(comment) {
    const likeScore = Math.log2(comment.likes + 2);
    const replyScore = 1.3 * Math.log2(comment.replyCount + 2);
    const baseScore = likeScore + replyScore;
    let upWeight = 1.0;
    if (comment.upReply) upWeight = 3.0;
    else if (comment.upLike) upWeight = 1.8;
    function getLevelScope(l) {
      switch (true) {
        case l < 5:
          return 0.1;
        case l < 10:
          return 0.3;
        case l < 15:
          return 0.5;
        case l < 25:
          return 0.7;
        case l >= 25:
          return 1;
        default:
          return 0;
      }
    }
    const fchi = baseScore * upWeight * getLevelScope(comment.userLevel);
    return Math.round(fchi * 100) / 100;
  }

  /* ===== LLM API 配置（多套profile持久化） ===== */
  // 存储结构：
  //   bili_llm_profiles    → JSON数组 [{name, apiKey, apiBase, model, temperature}, ...]
  //   bili_llm_active_names → JSON数组 ["DeepSeek", "Kimi"]  多选激活
  const llmConfig = {
    get profiles() {
      try {
        return JSON.parse(GM_getValue("bili_llm_profiles", "[]"));
      } catch (e) {
        return [];
      }
    },
    set profiles(v) {
      GM_setValue("bili_llm_profiles", JSON.stringify(v));
    },

    get activeNames() {
      try {
        return JSON.parse(GM_getValue("bili_llm_active_names", "[]"));
      } catch (e) {
        return [];
      }
    },
    set activeNames(v) {
      GM_setValue("bili_llm_active_names", JSON.stringify(v));
    },

    // 所有激活的profile
    get actives() {
      const names = this.activeNames;
      return this.profiles.filter((p) => names.includes(p.name));
    },
    // 首个激活（兼容旧逻辑）
    get active() {
      return this.actives[0] || null;
    },

    // 便捷属性（从首个active读取）
    get apiKey() {
      return this.active?.apiKey || "";
    },
    get apiBase() {
      return this.active?.apiBase || "";
    },
    get model() {
      return this.active?.model || "";
    },
    get temperature() {
      const t = this.active?.temperature;
      return t != null ? t : 1;
    },

    get isConfigured() {
      return (
        this.actives.length > 0 &&
        this.actives.every((a) => a.apiKey && a.apiBase && a.model)
      );
    },
  };

  /* ===== 评论缓存 ===== */
  const commentStore = {
    comments: [],
    seenIds: new Set(),
    onUpdate: null,
    manualPostData: null,
    aiResult: null,

    mainCount() {
      let c = 0;
      for (const cm of this.comments) if (cm.type === "main") c++;
      return c;
    },

    addReply(r) {
      if (!r || !r.content) return 0;
      const rpid = r.rpid || r.rpid_str;
      if (this.seenIds.has(rpid)) return 0;
      this.seenIds.add(rpid);
      const main = {
        type: "main",
        rpid,
        user: r.member?.uname || "匿名",
        userLevel: r.member?.level_info?.current_level || 0,
        content: r.content.message || "",
        likes: r.like || 0,
        replyCount: r.rcount || 0,
        upLike: r.reply_control?.up_like,
        upReply: r.reply_control?.up_reply,
        ipAddress: r.reply_control?.location,
        time: _formatTime(r.ctime),
        timestamp: r.ctime,
      };
      main.scope = calcScoreFCHI(main);
      this.comments.push(main);
      let added = 1;
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

    stats() {
      const mains = this.comments.filter((c) => c.type === "main");
      const subs = this.comments.filter((c) => c.type === "sub");
      return {
        total: this.comments.length,
        mains: mains.length,
        subs: subs.length,
      };
    },

    toMarkdown() {
      const mains = this.comments.filter((c) => c.type === "main");
      const subs = this.comments.filter((c) => c.type === "sub");
      const path = location.pathname;
      const now = _formatPostTime();
      let md = "";
      try {
        const opus = getOpusData() || this.manualPostData;
        if (opus) {
          md += `# 帖子\n\n## 帖子数据\n\n`;
          md += `【标题】${opus.title || ""}\n`;
          md += `【发布时间】${_formatPostTime(opus.post_time)}\n`;
          const s = opus.stats || {};
          md += `【效果】点赞数量: ${s.like ?? 0};收藏数量: ${s.favorite ?? 0};转发数量: ${s.forward ?? 0};评论数量: ${s.comment ?? 0};投币数量: ${s.coin ?? 0}\n`;
          md += `【UP主】${opus.up_master || ""}\n`;
          if (opus.content)
            md += `\n## 帖子内容\n\n---\n\n${opus.content}\n\n---\n`;
          md += `\n`;
        }
      } catch (_) {}
      md += `# 评论区\n\n## 评论区数据\n\n`;
      md += `> 共 **${mains.length}** 条主评论，**${subs.length}** 条子评论\n`;
      md += `> 视频: \`${path}\` | 抓取时间: ${now}\n`;
      md += `> 按综合热度降序排列\n\n---\n\n## 评论列表\n\n`;
      const sortedMains = [...mains].sort((a, b) => b.scope - a.scope);
      sortedMains.forEach((m, idx) => {
        const subsOfThis = subs.filter((s) => s.parentRpid === m.rpid);
        md += `### ${idx + 1}. ${m.user} [🔥${m.likes} 💬${m.replyCount} 📊${m.scope}]\n`;
        md += `> ${m.time} | IP属地：${m.ipAddress || "未知"}\n\n${m.content}\n\n`;
        if (subsOfThis.length > 0) {
          subsOfThis.forEach((s) => {
            md += `- ${s.user}: ${s.content} (👍${s.likes})\n`;
          });
          md += `\n`;
        }
        md += `---\n\n`;
      });
      md += `# 注意\n\n- 评论格式\n\n\`\`\`md\n`;
      md += `### 序号1. 用户名 [点赞数量 评论数量 分数权重]\n\n> 评论见时间 | 用户名IP属地\n\n评论内容\n\n`;
      md += `- 用户名: 子评论内容\n- 用户名: 子评论内容\n\n---\n\n### 序号2.\n\`\`\`\n\n`;
      md += `- {'[微笑]'} 帖子和评论区中为B站表情包,对分析也重要\n\n`;
      md += `# 分析任务\n\n`;
      md += `你是一个A股散户心理情绪观察舆情助手。请综合正文立场与评论区高热度反馈（按FCHI降序排列），输出【散户情绪阶段报告】。你的核心目标是识别当前市场处于情绪轮动链条的哪个位置，并给出对应的交易操作建议。\n\n`;
      md += `## 情绪轮动模型（建仓视角：底部→中途→顶部）\n\n`;
      md += `### 第一阶段：冰点（底部｜无人问津，适合买入/抄底）\n\n`;
      md += `- 核心心理：麻木、绝望、丧失信心\n`;
      md += `- 评论区特征：评论稀少或死气沉沉；大量求安慰/求按摩内容/诉苦；充斥销户、摆烂、躺平言论、爆仓、卖房、家人、量化、空仓、死抗、抄底、梭哈、加杠杆；对利好消息完全脱敏甚至解读为利空\n`;
      md += `- B站典型语料："跌麻/嘛了"、"抄底抄在半山腰"、"做家务"、"不玩了准备销户"、"再怎么反弹也是诱多"、"懒得看盘了"、"谁还敢进场"、"利好出尽就是利空"、"分析的再多都是跌"、"这市场已经彻底没救了"、"对不起家人"、"终于收盘了"、"*家跌停"、"保卫战"、"UP救我"、"被套了"、"头皮发麻"、"毁灭吧"、"狗庄"、"死磕"、"牛走了"、"老乡别走"\n\n`;
      md += `### 第二阶段：观望（中途｜震荡拉锯，适合观望）\n\n`;
      md += `- 核心心理：怀疑、犹豫、摇摆不定\n`;
      md += `- 评论区特征：评论量逐步回升但分歧巨大；刚回本就急于跑路；频繁询问是反弹还是反转；想进场又怕追高\n`;
      md += `- B站典型语料："反弹还是反转"、"不敢加仓怕冲高回落"、"涨这么多随时要回调"、"有点想进但怕追在半山腰"、"先观望确认趋势再说"、"垃圾盘面浪费时间"、"垃圾行情没意思"、"看盘不如出去旅游"、"半仓观望"\n\n`;
      md += `### 第三阶段：沸腾（顶部｜人声鼎沸，适合减仓/清仓）\n\n`;
      md += `- 核心心理：狂热、贪婪、亢奋\n`;
      md += `- 评论区特征：评论刷屏爆满；大量晒收益/晒截图/晒消费/夸赞UP；低于8级账号密集涌入;新手求代码求带；询问目标点位；出现踏空/借钱/梭哈/卖房/开户/卸杠杆等言论\n`;
      md += `- B站典型语料："还能买吗"、"家庭地位"、"开香槟"、"要消费"、"UP牛逼"、"膜拜UP"、"赢嘛/麻了"、"今天就这样吧"、"收盘吧"、"翻倍"、"爆赚"、"啥时间跑"、"头晕目眩"、"服了UP/佩服UP"、"牛回"、"又涨停了"、"恐高"\n\n`;
      md += `## 分析规则\n\n### 内容\n\n`;
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
      md += `- 样本过少 → 观望（禁止给出方向性建议）\n\n`;
      md += `## 输出格式\n\n`;
      md += `仅返回以下JSON结构，不包含任何解释性文字、markdown标记或额外说明：\n\n`;
      md += `{\n"stage": "冰点|观望|沸腾|样本过少",\n"operation": "抄底|加仓|观望|减仓|清仓",\n`;
      md += `"confidence": 0.0至1.0之间的浮点数,\n"core_evidence": "≤200字的核心判定依据，引用最具代表性的评论关键词",\n`;
      md += `"up_crowd_relation": "一致|弱背离|强背离",\n"risk_note": "水军干扰|反讽密集|样本过少|情绪极端化|null"\n}\n`;
      return md;
    },

    async copyToClipboard() {
      const md = this.toMarkdown();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
        return true;
      }
      const ta = document.createElement("textarea");
      ta.value = md;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    },

    /** 调用单个大模型，pf: {name, apiKey, apiBase, model, temperature} */
    analyzeWithLLM(pf) {
      const prompt = this.toMarkdown();
      const temp = pf.temperature != null ? pf.temperature : 1;
      return new Promise((resolve, reject) => {
        console.log(
          `%c🚀 AI分析 [${pf.name}] %c→ ${pf.apiBase} %c| ${pf.model} temp:${temp}`,
          "color:#fa8c16;font-weight:bold;",
          "color:#888;",
          "color:#888;",
        );

        GM_xmlhttpRequest({
          method: "POST",
          url: pf.apiBase,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + pf.apiKey,
          },
          data: JSON.stringify({
            model: pf.model,
            // result_format: "message",
            messages: [
              {
                role: "system",
                content:
                  "你是一个A股散户心理情绪观察舆情助手。请严格按照JSON格式返回分析结果，不要包含markdown代码块标记。",
              },
              { role: "user", content: prompt },
            ],
            temperature: temp,
          }),
          timeout: 1200000,
          onload: (res) => {
            console.log(
              `%c📡 [${pf.name}] 响应 %cstatus: ${res.status}`,
              "color:#888;", "color:#888;",
            );
            // console.log(`%c📡 [${pf.name}] 原始响应:%c`, "color:#888;", "color:#aaa;", res.responseText);
            try {
              if (!res.responseText || !res.responseText.trim()) {
                return reject(new Error("[" + pf.name + "] API 返回空响应（status=" + res.status + "），请检查 API 地址"));
              }
              const data = JSON.parse(res.responseText);
              if (data.error) {
                const msg = data.error.message || JSON.stringify(data.error);
                return reject(
                  new Error("[" + pf.name + "] API 返回错误: " + msg),
                );
              }
              const content = data.choices?.[0]?.message?.content;
              if (!content)
                return reject(
                  new Error(
                    "[" +
                      pf.name +
                      "] API 返回内容为空（status=" +
                      res.status +
                      "）",
                  ),
                );
              let jsonStr = content.trim();
              const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
              if (m) jsonStr = m[1].trim();
              const jm = jsonStr.match(/\{[\s\S]*\}/);
              if (!jm)
                return reject(
                  new Error("[" + pf.name + "] 未能从响应中解析JSON"),
                );
              const result = JSON.parse(jm[0]);
              if (!result.stage && !result.operation)
                return reject(new Error("[" + pf.name + "] 返回缺少必要字段"));
              result._pfName = pf.name;
              result._model = pf.model;
              resolve(result);
            } catch (e) {
              reject(new Error("[" + pf.name + "] 响应解析失败: " + e.message));
            }
          },
          onerror: () =>
            reject(new Error("[" + pf.name + "] 网络请求失败: " + pf.apiBase)),
          ontimeout: () =>
            reject(new Error("[" + pf.name + "] 请求超时（20min）")),
        });
      });
    },

    clear() {
      this.comments = [];
      this.seenIds.clear();
      this.aiResult = null;
      if (this.onUpdate) this.onUpdate();
    },
  };

  function getOpusData() {
    const pw = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const state = pw.__INITIAL_STATE__;
    if (!state || !state.detail) return null;
    const modules = state.detail.modules || [];
    const getModule = (type) => modules.find((m) => m.module_type === type);
    const authorMod = getModule("MODULE_TYPE_AUTHOR")?.module_author;
    const contentMod = getModule("MODULE_TYPE_CONTENT")?.module_content;
    const statMod = getModule("MODULE_TYPE_STAT")?.module_stat;
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
      title: state.detail.basic?.title || "",
      content,
      images,
      up_master: authorMod?.name || "",
      up_mid: authorMod?.mid || 0,
      post_time: authorMod?.pub_time || "",
      stats: {
        like: statMod?.like?.count ?? 0,
        favorite: statMod?.favorite?.count ?? 0,
        forward: statMod?.forward?.count ?? 0,
        comment: statMod?.comment?.count ?? 0,
        coin: statMod?.coin?.count ?? 0,
      },
    };
  }

  /* ===== fetch 劫持 ===== */
  // 用 unsafeWindow 才能劫持到页面的真实 fetch（GM沙箱下 window 是隔离的）
  const pageFetch = (
    typeof unsafeWindow !== "undefined" ? unsafeWindow : window
  ).fetch;
  const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  pageWin.fetch = function (...args) {
    // B站可能传 string 或 Request 对象，统一提取 URL 字符串
    const arg0 = args[0];
    const url = typeof arg0 === "string" ? arg0 : arg0?.url || "";
    return pageFetch.apply(this, args).then((resp) => {
      if (url.includes("/x/v2/reply") && url.includes("mode=2")) {
        const clone = resp.clone();
        clone.text().then((body) => {
          try {
            const j = JSON.parse(body);
            (j.data?.replies || []).forEach((r) => commentStore.addReply(r));
          } catch (_) {}
        });
      }
      return resp;
    });
  };

  /* ===== 样式 ===== */
  const injectStyles = () => {
    if (document.getElementById("bili-collect-styles")) return;
    const style = document.createElement("style");
    style.id = "bili-collect-styles";
    style.textContent = `
#bili-post-panel{position:fixed;top:0;right:-420px;width:400px;height:100vh;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,.15);z-index:100001;transition:right .35s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
#bili-post-panel.open{right:0}
.bpp-header{padding:12px 16px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between;background:#fafafa;font-size:14px;font-weight:bold;color:#222}
.bpp-close{cursor:pointer;font-size:20px;color:#888;line-height:1;padding:0 4px}.bpp-close:hover{color:#333}
.bpp-body{flex:1;overflow-y:auto;padding:14px 16px}
.bpp-section{background:#fff;border:1px solid #eee;border-radius:8px;padding:14px;margin-bottom:12px}
.bpp-section-title{font-size:13px;font-weight:600;color:#222;margin:0 0 10px;display:flex;align-items:center;gap:6px}
.bpp-group{margin-bottom:10px}.bpp-group:last-child{margin-bottom:0}
.bpp-group label{display:block;font-size:11px;color:#888;margin-bottom:3px;font-weight:500}
.bpp-group input,.bpp-group textarea{width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;font-family:inherit}
.bpp-group textarea{resize:vertical;min-height:56px}
.bpp-group input:focus,.bpp-group textarea:focus{outline:none;border-color:#00aeec}
.bpp-stats-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.bpp-stats-row2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.bpp-stats-row input,.bpp-stats-row2 input{text-align:center}
.bpp-section .hint{font-size:10px;color:#bbb;margin-top:2px}
.bpp-section-actions{display:flex;gap:8px;margin-top:12px;padding-top:10px;border-top:1px dashed #eee}
.bpp-btn-sm{flex:1;padding:6px 0;border-radius:4px;font-size:11px;cursor:pointer;border:none;font-weight:500}
.bpp-btn-sm.outline{background:#fff;color:#888;border:1px solid #ddd}.bpp-btn-sm.outline:hover{background:#f5f5f5}
.bpp-btn-sm.primary{background:#00aeec;color:#fff}.bpp-btn-sm.primary:hover{background:#0095c7}

/* profile 标签 */
.bpp-profile-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;min-height:28px;align-items:center;padding:4px;border:1px dashed #e0e0e0;border-radius:4px;background:#fafafa}
.bpp-profile-list:empty::after{content:"暂无API配置，请在下方添加";color:#ccc;font-size:11px}
.bpp-profile-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:14px;font-size:11px;border:1px solid #ddd;background:#fff;cursor:pointer;user-select:none;transition:all .15s}
.bpp-profile-chip:hover{border-color:#fa8c16}
.bpp-profile-chip.active{background:#fff7e6;border-color:#fa8c16;color:#d46b08;font-weight:600}
.bpp-profile-chip .pf-del{margin-left:2px;color:#bbb;font-weight:bold;font-size:14px;line-height:1;cursor:pointer}
.bpp-profile-chip .pf-del:hover{color:#ff4d4f}

#bili-post-edit-btn:hover{color:#00aeec;border-color:#00aeec}
#bili-ai-analyze-btn:hover{background:#fff7e6}

.bpp-result{display:none}.bpp-result.show{display:block}
.bpp-result-card{background:#f8fafb;border-radius:8px;padding:14px;border:1px solid #e8ecf0}
.bpp-result-title{font-size:13px;color:#333;font-weight:600;margin-bottom:4px;line-height:1.4}
.bpp-result-summary{font-size:11px;color:#999;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #f0f0f0}
.bpp-result-stage{display:inline-block;padding:3px 12px;border-radius:20px;font-size:14px;font-weight:bold;margin-bottom:10px}
.bpp-result-stage.ice{background:#e6f7ff;color:#1890ff}
.bpp-result-stage.wait{background:#fffbe6;color:#faad14}
.bpp-result-stage.boil{background:#fff1f0;color:#ff4d4f}
.bpp-result-stage.few{background:#f5f5f5;color:#8c8c8c}
.bpp-result-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:12px}
.bpp-result-row:last-child{border-bottom:none}
.bpp-result-label{color:#888}
.bpp-result-value{color:#222;font-weight:500;text-align:right;max-width:60%}
.bpp-result-conf-bar{height:6px;background:#eee;border-radius:3px;margin-top:2px;overflow:hidden}
.bpp-result-conf-fill{height:100%;border-radius:3px;transition:width .5s}
.bpp-result-evidence{margin-top:10px;padding:10px;background:#fff;border-radius:6px;font-size:12px;color:#555;line-height:1.6;border-left:3px solid #00aeec}
.bpp-result-meta{font-size:11px;color:#999;margin-top:8px;text-align:right}

.bpp-loading{display:none;text-align:center;padding:20px 0;color:#888;font-size:12px}
.bpp-loading.show{display:block}
.bpp-loading-spinner{width:24px;height:24px;border:3px solid #eee;border-top-color:#00aeec;border-radius:50%;animation:bpp-spin .8s linear infinite;margin:0 auto 8px}
@keyframes bpp-spin{to{transform:rotate(360deg)}}
.bpp-error{display:none;color:#ff4d4f;font-size:12px;padding:10px;background:#fff1f0;border-radius:6px;margin-top:8px}
.bpp-error.show{display:block}
.bpp-config-error{display:none;color:#ff4d4f;font-size:11px;padding:6px 10px;background:#fff1f0;border-radius:4px;margin-top:8px}
.bpp-config-error.show{display:block}

/* 独立 AI 结果面板（右上角，半屏高，不遮挡操作按钮） */
#bili-ai-result-panel{position:fixed;top:0;right:-440px;width:420px;max-height:55vh;background:#fff;box-shadow:-4px 4px 20px rgba(0,0,0,.15);z-index:100002;transition:right .35s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border-radius:0 0 0 12px}
#bili-ai-result-panel.open{right:0}
.bar-header{padding:12px 16px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between;background:#fff7e6;font-size:14px;font-weight:bold;color:#222;border-radius:0 0 0 0;flex-shrink:0}
.bar-close{cursor:pointer;font-size:20px;color:#888;line-height:1;padding:0 4px}.bar-close:hover{color:#333}
.bar-body{flex:1;overflow-y:auto;padding:16px}
`;
    document.head.appendChild(style);
  };

  /* ===== UI ===== */
  const injectButton = () => {
    if (document.getElementById("bili-collect-btn")) return;
    injectStyles();

    const panel = document.createElement("div");
    panel.id = "bili-post-panel";
    panel.innerHTML = `
<div class="bpp-header">⚙️ 配置面板<span class="bpp-close">&times;</span></div>
<div class="bpp-body">

  <!-- 📝 帖子信息 -->
  <div class="bpp-section">
    <div class="bpp-section-title">📝 帖子信息</div>
    <div class="bpp-group"><label>标题</label><input id="bpp-title" placeholder="帖子标题"></div>
    <div class="bpp-group"><label>发布时间</label><input id="bpp-time" placeholder="如：2026年07月24日 21:18"></div>
    <div class="bpp-group"><label>UP主</label><input id="bpp-up" placeholder="UP主用户名"></div>
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
    <div class="bpp-group"><label>帖子内容</label><textarea id="bpp-content" placeholder="从页面复制粘贴帖子正文..."></textarea></div>
    <div class="bpp-section-actions">
      <button class="bpp-btn-sm outline" id="bpp-clear-post">🗑 清空帖子</button>
      <button class="bpp-btn-sm primary" id="bpp-save-post">💾 保存帖子</button>
    </div>
  </div>

  <!-- 🤖 大模型 API 配置 -->
  <div class="bpp-section">
    <div class="bpp-section-title">🤖 大模型 API 配置</div>
    <div class="bpp-group">
      <label>已保存的 API（点击多选，× 删除）</label>
      <div class="bpp-profile-list" id="bpp-profile-list"></div>
    </div>
    <div class="bpp-group"><label>名称</label><input id="bpp-pf-name" placeholder="如：DeepSeek / OpenAI / 硅基流动"></div>
    <div class="bpp-group"><label>API Key</label><input type="password" id="bpp-pf-key" placeholder="sk-..."></div>
    <div class="bpp-group"><label>API 地址</label><input id="bpp-pf-base" placeholder="https://api.moonshot.cn/v1/chat/completions"></div>
    <div class="hint" style="margin-top:2px">Kimi: https://api.moonshot.cn/v1/chat/completions</div>
    <div class="hint">DeepSeek: https://api.deepseek.com/chat/completions</div>
    <div class="hint">OpenAI: https://api.openai.com/v1/chat/completions</div>
    <div class="hint">硅基流动: https://api.siliconflow.cn/v1/chat/completions</div>
    <div class="hint" style="margin-bottom:8px">阿里百炼(Qwen): https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions</div>
    <div class="bpp-group"><label>模型</label><input id="bpp-pf-model" placeholder="kimi-k2.6"></div>
    <div class="bpp-group"><label>Temperature</label><input id="bpp-pf-temp" type="number" min="0" max="1" step="0.1" placeholder="1"></div>
    <div class="hint">0~1，越大越随机（默认1）</div>
    <div class="bpp-section-actions">
      <button class="bpp-btn-sm outline" id="bpp-pf-delete">🗑 删除</button>
      <button class="bpp-btn-sm primary" id="bpp-pf-save">💾 保存此API</button>
    </div>
    <div class="bpp-config-error" id="bpp-config-error"></div>
    <div class="bpp-section-actions" style="border-top-style:solid;margin-top:8px">
      <button class="bpp-btn-sm outline" id="bpp-clear-config">🗑 清空全部</button>
    </div>
  </div>

</div>
`;
    document.body.appendChild(panel);

    // ========== AI 分析结果面板（独立面板） ==========
    const resultPanel = document.createElement("div");
    resultPanel.id = "bili-ai-result-panel";
    resultPanel.innerHTML = `
<div class="bar-header">🤖 AI 分析结果<span class="bar-close">&times;</span></div>
<div class="bar-body">
  <div class="bpp-loading" id="bpp-loading"><div class="bpp-loading-spinner"></div><div id="bpp-loading-text">大模型分析中，请稍候...</div></div>
  <div class="bpp-error" id="bpp-error"></div>
  <div class="bpp-result" id="bpp-result"><div class="bpp-result-card" id="bpp-result-card"></div></div>
</div>
`;
    document.body.appendChild(resultPanel);

    const openResultPanel = () => {
      resultPanel.classList.add("open");
    };
    const closeResultPanel = () => {
      resultPanel.classList.remove("open");
    };
    resultPanel.querySelector(".bar-close").onclick = closeResultPanel;

    // ========== profile 标签渲染（多选） ==========
    const renderProfiles = () => {
      const container = document.getElementById("bpp-profile-list");
      const profiles = llmConfig.profiles;
      const actives = llmConfig.activeNames;
      container.innerHTML = "";
      profiles.forEach((p) => {
        const isActive = actives.includes(p.name);
        const chip = document.createElement("span");
        chip.className = "bpp-profile-chip" + (isActive ? " active" : "");
        chip.title =
          `${p.model}\n${p.apiBase}\n` +
          (isActive ? "已选中（点击取消）" : "点击选中");
        chip.innerHTML = `${p.name}<span class="pf-del" data-name="${p.name}">&times;</span>`;
        chip.addEventListener("click", (e) => {
          if (e.target.classList.contains("pf-del")) return;
          // 点击 = 切换选中
          let names = llmConfig.activeNames;
          if (names.includes(p.name)) {
            names = names.filter((n) => n !== p.name);
          } else {
            names = [...names, p.name];
          }
          llmConfig.activeNames = names;
          renderProfiles();
          fillProfileForm(p);
        });
        container.appendChild(chip);
      });
      // 删除事件
      container.querySelectorAll(".pf-del").forEach((del) => {
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          const name = del.dataset.name;
          let profiles = llmConfig.profiles.filter((p) => p.name !== name);
          llmConfig.profiles = profiles;
          let names = llmConfig.activeNames.filter((n) => n !== name);
          llmConfig.activeNames = names;
          renderProfiles();
          clearProfileForm();
          if (names.length > 0) {
            const first = profiles.find((p) => p.name === names[0]);
            if (first) fillProfileForm(first);
          }
        });
      });
    };

    const fillProfileForm = (p) => {
      document.getElementById("bpp-pf-name").value = p.name || "";
      document.getElementById("bpp-pf-key").value = p.apiKey || "";
      document.getElementById("bpp-pf-base").value = p.apiBase || "";
      document.getElementById("bpp-pf-model").value = p.model || "";
      document.getElementById("bpp-pf-temp").value =
        p.temperature != null ? p.temperature : 1;
    };
    const clearProfileForm = () => {
      document.getElementById("bpp-pf-name").value = "";
      document.getElementById("bpp-pf-key").value = "";
      document.getElementById("bpp-pf-base").value = "";
      document.getElementById("bpp-pf-model").value = "";
      document.getElementById("bpp-pf-temp").value = "";
    };
    const collectProfileForm = () => {
      const t = parseFloat(document.getElementById("bpp-pf-temp").value);
      return {
        name: document.getElementById("bpp-pf-name").value.trim(),
        apiKey: document.getElementById("bpp-pf-key").value.trim(),
        apiBase: document.getElementById("bpp-pf-base").value.trim(),
        model: document.getElementById("bpp-pf-model").value.trim(),
        temperature: isNaN(t) ? 1 : Math.max(0, Math.min(1, t)),
      };
    };

    // ========== 帖子表单 ==========
    const loadPostForm = () => {
      const d = commentStore.manualPostData;
      if (!d) return;
      document.getElementById("bpp-title").value = d.title || "";
      document.getElementById("bpp-time").value = d.post_time || "";
      document.getElementById("bpp-up").value = d.up_master || "";
      document.getElementById("bpp-content").value = d.content || "";
      document.getElementById("bpp-like").value = d.stats?.like || "";
      document.getElementById("bpp-fav").value = d.stats?.favorite || "";
      document.getElementById("bpp-fwd").value = d.stats?.forward || "";
      document.getElementById("bpp-cmt").value = d.stats?.comment || "";
      document.getElementById("bpp-coin").value = d.stats?.coin || "";
    };
    const collectPostForm = () => ({
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

    const showError = (msg) => {
      const el = document.getElementById("bpp-error");
      el.textContent = "❌ " + msg;
      el.classList.add("show");
      document.getElementById("bpp-loading").classList.remove("show");
    };
    const hideError = () =>
      document.getElementById("bpp-error").classList.remove("show");

    // 渲染单个模型结果卡片
    const renderOneCard = (r) => {
      const stageClassMap = {
        冰点: "ice",
        观望: "wait",
        沸腾: "boil",
        样本过少: "few",
      };
      if (r._error) {
        return `<div class="bpp-result-card" style="border-left:3px solid #ff4d4f;margin-bottom:10px">
<div style="font-size:12px;font-weight:600;color:#ff4d4f;margin-bottom:4px">❌ ${r._pfName} / ${r._model}</div>
<div style="font-size:11px;color:#888">${r._error}</div></div>`;
      }
      const sc = stageClassMap[r.stage] || "few";
      const cp = Math.round((r.confidence || 0) * 100);
      const cc = cp >= 70 ? "#52c41a" : cp >= 40 ? "#faad14" : "#ff4d4f";
      return `<div class="bpp-result-card" style="margin-bottom:10px">
<div style="font-size:12px;font-weight:600;color:#fa8c16;margin-bottom:6px">🤖 ${r._pfName} / ${r._model}</div>
<div class="bpp-result-stage ${sc}">📊 ${r.stage || "未知"}</div>
<div class="bpp-result-row"><span class="bpp-result-label">操作建议</span><span class="bpp-result-value" style="font-size:14px;font-weight:bold;color:#00aeec">${r.operation || "—"}</span></div>
<div class="bpp-result-row"><span class="bpp-result-label">置信度</span><span class="bpp-result-value">${cp}%</span></div>
<div class="bpp-result-conf-bar"><div class="bpp-result-conf-fill" style="width:${cp}%;background:${cc}"></div></div>
<div class="bpp-result-row"><span class="bpp-result-label">UP主与评论区关系</span><span class="bpp-result-value">${r.up_crowd_relation || "—"}</span></div>
<div class="bpp-result-row"><span class="bpp-result-label">风险提示</span><span class="bpp-result-value" style="color:${r.risk_note && r.risk_note !== "null" ? "#ff4d4f" : "#52c41a"}">${r.risk_note && r.risk_note !== "null" ? r.risk_note : "无"}</span></div>
<div class="bpp-result-evidence">${r.core_evidence || "无"}</div></div>`;
    };

    const showResults = (results, elapsed) => {
      const opus = getOpusData() || commentStore.manualPostData;
      const title = opus?.title || "未知主题";
      const s = commentStore.stats();
      const cards = results.map(renderOneCard).join("");
      const container = document.getElementById("bpp-result");
      container.innerHTML = `
<div class="bpp-result-title">📌 ${title}</div>
<div class="bpp-result-summary">已分析 ${s.mains} 条主评论 + ${s.subs} 条子评论，共 ${s.total} 条 | 耗时 ${elapsed}s</div>
${cards}
<div class="bpp-result-meta">${_formatPostTime()}</div>`;
      container.classList.add("show");
      document.getElementById("bpp-loading").classList.remove("show");
      console.log(
        "%c🤖 多模型分析结果 %c(可与手动分析对比)",
        "font-size:16px;font-weight:bold;color:#00aeec;",
        "color:#888;",
      );
      results.forEach((r) => {
        console.log(`--- ${r._pfName} / ${r._model} ---`);
        console.log(JSON.stringify(r, null, 2));
      });
    };

    // ========== 事件 ==========
    const openPanel = () => {
      loadPostForm();
      renderProfiles();
      const actives = llmConfig.actives;
      if (actives.length > 0) fillProfileForm(actives[0]);
      else clearProfileForm();
      panel.classList.add("open");
    };
    const closePanel = () => panel.classList.remove("open");
    panel.querySelector(".bpp-close").onclick = closePanel;

    // 📝 清空帖子
    document.getElementById("bpp-clear-post").onclick = () => {
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
      console.log("%c✅ 帖子信息已清空", "color:#888;");
    };
    // 📝 保存帖子
    document.getElementById("bpp-save-post").onclick = () => {
      commentStore.manualPostData = collectPostForm();
      console.log("%c✅ 帖子信息已保存", "color:#52c41a;");
    };

    // 🤖 保存此API（新增或更新）
    document.getElementById("bpp-pf-save").onclick = () => {
      const pf = collectProfileForm();
      const cfgErr = (msg) => {
        const el = document.getElementById("bpp-config-error");
        el.textContent = "❌ " + msg;
        el.classList.add("show");
      };
      document.getElementById("bpp-config-error").classList.remove("show");
      if (!pf.name) {
        cfgErr("请输入API名称");
        return;
      }
      if (!pf.apiKey) {
        cfgErr("请输入API Key");
        return;
      }
      if (!pf.apiBase) {
        cfgErr("请输入API地址");
        return;
      }
      if (!pf.model) {
        cfgErr("请输入模型名");
        return;
      }

      let profiles = llmConfig.profiles;
      const idx = profiles.findIndex((p) => p.name === pf.name);
      if (idx >= 0) {
        profiles[idx] = pf; // 更新同名profile
      } else {
        profiles.push(pf); // 新增
      }
      llmConfig.profiles = profiles;
      llmConfig.activeNames = [...new Set([...llmConfig.activeNames, pf.name])]; // 自动加入选中
      renderProfiles();
      fillProfileForm(pf);
      document.getElementById("bpp-config-error").classList.remove("show");
      console.log(`%c✅ API "${pf.name}" 已保存并加入选中`, "color:#52c41a;");
    };

    // 🤖 删除当前表单对应的profile
    document.getElementById("bpp-pf-delete").onclick = () => {
      const name = document.getElementById("bpp-pf-name").value.trim();
      if (!name) return;
      let profiles = llmConfig.profiles.filter((p) => p.name !== name);
      llmConfig.profiles = profiles;
      llmConfig.activeNames = llmConfig.activeNames.filter((n) => n !== name);
      renderProfiles();
      clearProfileForm();
      const actives = llmConfig.activeNames;
      if (actives.length > 0) {
        const first = profiles.find((p) => p.name === actives[0]);
        if (first) fillProfileForm(first);
      }
      document.getElementById("bpp-result").classList.remove("show");
      hideError();
      console.log(`%c✅ API "${name}" 已删除`, "color:#888;");
    };

    // 🤖 清空全部
    document.getElementById("bpp-clear-config").onclick = () => {
      llmConfig.profiles = [];
      llmConfig.activeNames = [];
      renderProfiles();
      clearProfileForm();
      document.getElementById("bpp-result").classList.remove("show");
      hideError();
      console.log("%c✅ 全部API配置已清空", "color:#888;");
    };

    // ========== 复制 & AI分析（供浮动按钮调用） ==========
    const doCopy = async () => {
      const manual = collectPostForm();
      if (manual.title || manual.content) commentStore.manualPostData = manual;
      const s = commentStore.stats();
      if (s.mains === 0) {
        console.log("%c⚠️ 暂无评论数据，请先滚动加载评论", "color:#faad14");
        return false;
      }
      try {
        await commentStore.copyToClipboard();
        console.log(
          `%c✅ 已复制 ${s.total} 条评论为 Markdown（可粘贴到任意大模型手动对比）`,
          "color:#52c41a",
        );
        return true;
      } catch (e) {
        console.log("复制失败: ", e);
        return false;
      }
    };

    const doAiAnalyze = async () => {
      const manual = collectPostForm();
      if (manual.title || manual.content) commentStore.manualPostData = manual;
      const s = commentStore.stats();
      if (s.mains === 0) {
        openResultPanel();
        showError("暂无评论数据，请先滚动加载评论");
        return;
      }
      const profiles = llmConfig.actives;
      if (profiles.length === 0) {
        openPanel();
        showError("请先选中至少一套 API 配置");
        return;
      }

      openResultPanel();
      hideError();
      const modelList = profiles.map((p) => p.name + "/" + p.model).join(", ");
      document.getElementById("bpp-loading-text").textContent =
        `正在使用 ${profiles.length} 个模型同时分析: ${modelList}`;
      document.getElementById("bpp-result").classList.remove("show");
      document.getElementById("bpp-loading").classList.add("show");
      const aiFloatBtn = document.getElementById("bili-ai-analyze-btn");
      if (aiFloatBtn) {
        aiFloatBtn.style.pointerEvents = "none";
        aiFloatBtn.style.opacity = "0.6";
      }

      const startTime = Date.now();
      // 并行调用所有选中的模型
      const promises = profiles.map((pf) =>
        commentStore
          .analyzeWithLLM(pf)
          .catch((e) => ({
            _error: e.message,
            _pfName: pf.name,
            _model: pf.model,
          })),
      );
      const results = await Promise.all(promises);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      showResults(results, elapsed);
      const ok = results.filter((r) => !r._error).length;
      const fail = results.filter((r) => r._error).length;
      console.log(
        `%c✅ 全部完成 %c(${elapsed}s) %c| 成功:${ok} 失败:${fail}`,
        "color:#52c41a;font-weight:bold;",
        "color:#888;",
        "color:#888;",
      );

      if (aiFloatBtn) {
        aiFloatBtn.style.pointerEvents = "";
        aiFloatBtn.style.opacity = "";
      }
    };

    // ── 浮动按钮（3个：复制 / AI分析 / 设置） ──
    const makeFloatBtn = (id, html, title, bottom, borderColor, color) => {
      const el = document.createElement("div");
      el.id = id;
      el.title = title;
      el.innerHTML = html;
      Object.assign(el.style, {
        position: "fixed",
        right: "24px",
        bottom: bottom,
        minWidth: "44px",
        height: "44px",
        padding: "0 14px",
        borderRadius: "22px",
        background: "#fff",
        border: `2px solid ${borderColor}`,
        color: color,
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
      el.onmouseenter = () => {
        el.style.transform = "scale(1.1)";
      };
      el.onmouseleave = () => {
        el.style.transform = "scale(1)";
      };
      return el;
    };

    // 复制按钮
    const copyBtn = makeFloatBtn(
      "bili-collect-btn",
      "",
      "复制提示词到剪贴板<br>右键：清空缓存",
      "180px",
      "#00aeec",
      "#00aeec",
    );
    // AI分析按钮
    const aiBtn = makeFloatBtn(
      "bili-ai-analyze-btn",
      "🤖",
      "大模型 AI 分析评论情绪",
      "238px",
      "#fa8c16",
      "#fa8c16",
    );
    // 设置按钮
    const setBtn = makeFloatBtn(
      "bili-post-edit-btn",
      "⚙",
      "配置帖子信息 & 大模型API",
      "238px",
      "#e0e0e0",
      "#888",
    );
    // 调整设置按钮位置 (再往上)
    setBtn.style.bottom = "296px";
    setBtn.style.minWidth = "28px";
    setBtn.style.width = "28px";
    setBtn.style.padding = "0";
    setBtn.style.borderRadius = "50%";
    setBtn.style.fontSize = "14px";
    setBtn.style.boxShadow = "0 1px 4px rgba(0,0,0,0.08)";
    setBtn.style.border = "1px solid #e0e0e0";

    setBtn.onclick = openPanel;
    aiBtn.onclick = doAiAnalyze;

    document.body.appendChild(setBtn);
    document.body.appendChild(aiBtn);

    const refreshBtn = () => {
      const n = commentStore.mainCount() || 0;
      copyBtn.innerHTML = `📋<span style="color:#fb7299;font-size:16px">${n}</span>`;
    };
    commentStore.onUpdate = refreshBtn;
    refreshBtn();

    copyBtn.onclick = async (e) => {
      if (commentStore.mainCount() === 0) return;
      if (e.shiftKey) {
        openPanel();
        return;
      }
      const auto = getOpusData();
      if (!auto && !commentStore.manualPostData) {
        openPanel();
        return;
      }
      const ok = await doCopy();
      if (ok) {
        copyBtn.innerHTML = `📋<span style="color:#52c41a;font-size:14px">已复制</span>`;
        setTimeout(refreshBtn, 1200);
      }
    };
    copyBtn.oncontextmenu = (e) => {
      e.preventDefault();
      commentStore.clear();
      document.getElementById("bpp-result")?.classList.remove("show");
      hideError();
    };
    document.body.appendChild(copyBtn);
  };

  const init = () => {
    if (document.body) injectButton();
    else
      new MutationObserver(() => {
        if (document.body) injectButton();
      }).observe(document.documentElement, { childList: true });
  };
  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  )
    init();
  else document.addEventListener("DOMContentLoaded", init);
})();

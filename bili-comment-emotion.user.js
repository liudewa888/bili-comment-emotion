// ==UserScript==
// @name         B站财经评论情绪分析
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  通过接口抓取B站财经视频评论（含子评论），AI加权分析投资情绪，生成情绪分布图表
// @author       You
// @match        https://www.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.openai.com
// @connect      api.anthropic.com
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置管理 ====================
    const CONFIG = {
        // AI 配置
        get apiKey() { return GM_getValue('api_key', ''); },
        set apiKey(v) { GM_setValue('api_key', v); },
        get apiBase() { return GM_getValue('api_base', 'https://api.openai.com/v1'); },
        set apiBase(v) { GM_setValue('api_base', v); },
        get model() { return GM_getValue('model', 'gpt-4o-mini'); },
        set model(v) { GM_setValue('model', v); },

        // 评论接口配置
        get commentApiUrl() { return GM_getValue('comment_api_url', ''); },
        set commentApiUrl(v) { GM_setValue('comment_api_url', v); },
        get commentApiMethod() { return GM_getValue('comment_api_method', 'GET'); },
        set commentApiMethod(v) { GM_setValue('comment_api_method', v); },
        get commentApiHeaders() { return GM_getValue('comment_api_headers', '{}'); },
        set commentApiHeaders(v) { GM_setValue('comment_api_headers', v); },
        get commentApiBody() { return GM_getValue('comment_api_body', ''); },
        set commentApiBody(v) { GM_setValue('comment_api_body', v); },
        get responsePath() { return GM_getValue('response_path', 'data'); },
        set responsePath(v) { GM_setValue('response_path', v); },

        // 分析配置
        get maxComments() { return parseInt(GM_getValue('max_comments', '150'), 10); },
        set maxComments(v) { GM_setValue('max_comments', String(v)); },
        get replyWeightFactor() { return parseFloat(GM_getValue('reply_weight_factor', '1.0')); },
        set replyWeightFactor(v) { GM_setValue('reply_weight_factor', String(v)); },
        get emotions() {
            return GM_getValue('emotions', '贪婪,恐惧,犹豫,兴奋,淡定,愤怒,乐观,悲观,中性');
        },
        set emotions(v) { GM_setValue('emotions', v); },
    };

    const EMOTION_LIST = () => CONFIG.emotions.split(',').map(s => s.trim()).filter(Boolean);

    // ==================== 工具函数 ====================
    const $ = (sel, el = document) => el.querySelector(sel);
    const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const getBvid = () => {
        const m = location.pathname.match(/\/video\/(BV[\w]+)/i);
        return m ? m[1] : '';
    };
    const escapeHtml = (str) => {
        if (!str) return '';
        return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    };

    // 模板替换：{bvid} → 实际值
    const renderTemplate = (tpl, vars) => {
        return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
    };

    // 从 JSON 按路径取值，如 "data.comments"
    const getPath = (obj, path) => {
        if (!path) return obj;
        return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
    };

    // ==================== UI 样式注入 ====================
    const injectStyles = () => {
        if ($('#bili-emotion-style')) return;
        const style = document.createElement('style');
        style.id = 'bili-emotion-style';
        style.textContent = `
            #bili-emotion-btn {
                position: fixed;
                right: 24px;
                bottom: 100px;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: linear-gradient(135deg, #00aeec, #00c6ff);
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(0,174,236,0.4);
                z-index: 99999;
                font-size: 12px;
                font-weight: bold;
                text-align: center;
                line-height: 1.2;
                user-select: none;
                transition: transform 0.2s, box-shadow 0.2s;
            }
            #bili-emotion-btn:hover {
                transform: scale(1.08);
                box-shadow: 0 6px 20px rgba(0,174,236,0.55);
            }
            #bili-emotion-btn.analyzing {
                background: linear-gradient(135deg, #ff8c00, #ffb700);
                pointer-events: none;
            }
            #bili-emotion-panel {
                position: fixed;
                top: 0;
                right: -460px;
                width: 440px;
                height: 100vh;
                background: #fff;
                box-shadow: -4px 0 20px rgba(0,0,0,0.15);
                z-index: 100000;
                transition: right 0.35s cubic-bezier(0.4, 0, 0.2, 1);
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            }
            #bili-emotion-panel.open { right: 0; }
            .bili-emo-header {
                padding: 16px 20px;
                border-bottom: 1px solid #eee;
                display: flex;
                align-items: center;
                justify-content: space-between;
                background: #fafafa;
            }
            .bili-emo-header h2 { margin: 0; font-size: 16px; color: #222; }
            .bili-emo-close {
                cursor: pointer;
                font-size: 20px;
                color: #888;
                line-height: 1;
                padding: 4px;
            }
            .bili-emo-close:hover { color: #333; }
            .bili-emo-body {
                flex: 1;
                overflow-y: auto;
                padding: 20px;
            }
            .bili-emo-section { margin-bottom: 24px; }
            .bili-emo-section-title {
                font-size: 13px;
                color: #888;
                margin-bottom: 10px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .bili-emo-score-wrap {
                display: flex;
                align-items: center;
                gap: 16px;
            }
            .bili-emo-score-circle {
                width: 90px;
                height: 90px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                flex-shrink: 0;
            }
            .bili-emo-score-circle::before {
                content: '';
                position: absolute;
                width: 74px;
                height: 74px;
                border-radius: 50%;
                background: #fff;
            }
            .bili-emo-score-num {
                position: relative;
                font-size: 22px;
                font-weight: bold;
                color: #222;
            }
            .bili-emo-score-label {
                font-size: 12px;
                color: #666;
                line-height: 1.6;
            }
            .bili-emo-score-label strong {
                color: #222;
                font-size: 14px;
            }
            .bili-emo-chart-wrap {
                position: relative;
                height: 220px;
            }
            .bili-emo-quotes {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .bili-emo-quote {
                padding: 10px 12px;
                background: #f8f9fa;
                border-radius: 8px;
                font-size: 13px;
                color: #333;
                line-height: 1.5;
                border-left: 3px solid #00aeec;
            }
            .bili-emo-quote-meta {
                font-size: 11px;
                color: #888;
                margin-top: 6px;
                display: flex;
                justify-content: space-between;
            }
            .bili-emo-loading {
                text-align: center;
                padding: 40px 20px;
                color: #888;
            }
            .bili-emo-loading-spinner {
                width: 32px;
                height: 32px;
                border: 3px solid #eee;
                border-top-color: #00aeec;
                border-radius: 50%;
                animation: bili-emo-spin 0.8s linear infinite;
                margin: 0 auto 12px;
            }
            @keyframes bili-emo-spin { to { transform: rotate(360deg); } }
            .bili-emo-error {
                color: #c00;
                font-size: 13px;
                padding: 20px;
                text-align: center;
            }
            .bili-emo-settings-btn {
                margin-top: 8px;
                padding: 8px 16px;
                border: 1px solid #ddd;
                border-radius: 6px;
                background: #fff;
                cursor: pointer;
                font-size: 13px;
                color: #555;
                width: 100%;
            }
            .bili-emo-settings-btn:hover { background: #f5f5f5; }
            .bili-emo-progress {
                width: 100%;
                height: 4px;
                background: #eee;
                border-radius: 2px;
                margin-top: 12px;
                overflow: hidden;
            }
            .bili-emo-progress-bar {
                height: 100%;
                background: #00aeec;
                width: 0%;
                transition: width 0.3s;
            }

            /* 设置弹窗 */
            #bili-emo-modal-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.45);
                z-index: 100001;
                display: none;
                align-items: center;
                justify-content: center;
            }
            #bili-emo-modal-overlay.open { display: flex; }
            #bili-emo-modal {
                background: #fff;
                border-radius: 12px;
                width: 520px;
                max-width: 92vw;
                max-height: 90vh;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                box-shadow: 0 20px 60px rgba(0,0,0,0.25);
            }
            .bili-emo-modal-header {
                padding: 16px 20px;
                border-bottom: 1px solid #eee;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .bili-emo-modal-header h3 { margin: 0; font-size: 15px; color: #222; }
            .bili-emo-modal-body {
                padding: 20px;
                overflow-y: auto;
            }
            .bili-emo-form-group {
                margin-bottom: 14px;
            }
            .bili-emo-form-group label {
                display: block;
                font-size: 12px;
                color: #555;
                margin-bottom: 5px;
                font-weight: 500;
            }
            .bili-emo-form-group input,
            .bili-emo-form-group select,
            .bili-emo-form-group textarea {
                width: 100%;
                padding: 7px 10px;
                border: 1px solid #ddd;
                border-radius: 6px;
                font-size: 13px;
                box-sizing: border-box;
                font-family: inherit;
            }
            .bili-emo-form-group input:focus,
            .bili-emo-form-group select:focus,
            .bili-emo-form-group textarea:focus {
                outline: none;
                border-color: #00aeec;
            }
            .bili-emo-form-group .hint {
                font-size: 11px;
                color: #999;
                margin-top: 3px;
            }
            .bili-emo-modal-footer {
                padding: 12px 20px;
                border-top: 1px solid #eee;
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }
            .bili-emo-btn {
                padding: 8px 16px;
                border-radius: 6px;
                font-size: 13px;
                cursor: pointer;
                border: none;
            }
            .bili-emo-btn.primary {
                background: #00aeec;
                color: #fff;
            }
            .bili-emo-btn.primary:hover { background: #0095c7; }
            .bili-emo-btn.secondary {
                background: #f5f5f5;
                color: #555;
                border: 1px solid #ddd;
            }
            .bili-emo-btn.secondary:hover { background: #eee; }
            .bili-emo-form-row {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 12px;
            }
        `;
        document.head.appendChild(style);
    };

    // ==================== UI 创建 ====================
    let panelEl = null;
    let chartInstance = null;

    const createUI = () => {
        injectStyles();

        // 浮动按钮
        const btn = document.createElement('div');
        btn.id = 'bili-emotion-btn';
        btn.innerHTML = '情绪<br>分析';
        btn.title = '点击分析评论区情绪';
        btn.onclick = onAnalyzeClick;
        document.body.appendChild(btn);

        // 侧边面板
        panelEl = document.createElement('div');
        panelEl.id = 'bili-emotion-panel';
        panelEl.innerHTML = `
            <div class="bili-emo-header">
                <h2>🎯 评论区情绪分析</h2>
                <span class="bili-emo-close">&times;</span>
            </div>
            <div class="bili-emo-body">
                <div class="bili-emo-loading">
                    <div class="bili-emo-loading-spinner"></div>
                    <div>点击右下角按钮开始分析</div>
                </div>
            </div>
        `;
        panelEl.querySelector('.bili-emo-close').onclick = () => togglePanel(false);
        document.body.appendChild(panelEl);

        // 设置弹窗
        const overlay = document.createElement('div');
        overlay.id = 'bili-emo-modal-overlay';
        overlay.innerHTML = `
            <div id="bili-emo-modal">
                <div class="bili-emo-modal-header">
                    <h3>⚙️ 设置</h3>
                    <span class="bili-emo-close" onclick="document.getElementById('bili-emo-modal-overlay').classList.remove('open')">&times;</span>
                </div>
                <div class="bili-emo-modal-body">
                    <div style="font-size:12px;color:#888;margin-bottom:12px;border-bottom:1px solid #eee;padding-bottom:8px;">AI 配置</div>
                    <div class="bili-emo-form-group">
                        <label>API Key</label>
                        <input type="password" id="bili-emo-api-key" placeholder="sk-...">
                        <div class="hint">OpenAI / Claude / 国产大模型 API Key</div>
                    </div>
                    <div class="bili-emo-form-row">
                        <div class="bili-emo-form-group">
                            <label>API 基础地址</label>
                            <input type="text" id="bili-emo-api-base" placeholder="https://api.openai.com/v1">
                        </div>
                        <div class="bili-emo-form-group">
                            <label>模型名称</label>
                            <input type="text" id="bili-emo-model" placeholder="gpt-4o-mini">
                        </div>
                    </div>

                    <div style="font-size:12px;color:#888;margin:16px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px;">评论接口配置</div>
                    <div class="bili-emo-form-group">
                        <label>接口地址（可用 {bvid} 占位符）</label>
                        <input type="text" id="bili-emo-api-url" placeholder="https://your-api.com/comments?bvid={bvid}">
                        <div class="hint">你的后端评论抓取接口地址</div>
                    </div>
                    <div class="bili-emo-form-row">
                        <div class="bili-emo-form-group">
                            <label>请求方法</label>
                            <select id="bili-emo-api-method">
                                <option value="GET">GET</option>
                                <option value="POST">POST</option>
                            </select>
                        </div>
                        <div class="bili-emo-form-group">
                            <label>数据路径</label>
                            <input type="text" id="bili-emo-res-path" placeholder="data">
                            <div class="hint">JSON 中评论数组的路径，如 data.list</div>
                        </div>
                    </div>
                    <div class="bili-emo-form-group">
                        <label>请求 Headers（JSON）</label>
                        <textarea id="bili-emo-api-headers" rows="2" placeholder='{"Authorization":"Bearer xxx"}'></textarea>
                    </div>
                    <div class="bili-emo-form-group">
                        <label>请求 Body（POST 时有效，可用 {bvid}）</label>
                        <textarea id="bili-emo-api-body" rows="2" placeholder='{"bvid":"{bvid}"}'></textarea>
                    </div>

                    <div style="font-size:12px;color:#888;margin:16px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px;">分析配置</div>
                    <div class="bili-emo-form-row">
                        <div class="bili-emo-form-group">
                            <label>最大评论数</label>
                            <input type="number" id="bili-emo-max-comments" min="10" max="1000">
                        </div>
                        <div class="bili-emo-form-group">
                            <label>回复权重因子</label>
                            <input type="number" id="bili-emo-reply-weight" min="0" max="10" step="0.1">
                            <div class="hint">1条回复 = ? 个赞</div>
                        </div>
                    </div>
                    <div class="bili-emo-form-group">
                        <label>情绪标签（用英文逗号分隔）</label>
                        <textarea id="bili-emo-emotions" rows="2"></textarea>
                    </div>
                </div>
                <div class="bili-emo-modal-footer">
                    <button class="bili-emo-btn secondary" onclick="document.getElementById('bili-emo-modal-overlay').classList.remove('open')">取消</button>
                    <button class="bili-emo-btn primary" id="bili-emo-save-settings">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        $('#bili-emo-save-settings').onclick = saveSettings;
        overlay.onclick = e => { if (e.target === overlay) overlay.classList.remove('open'); };

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('⚙️ 打开设置', openSettings);
        }
    };

    const togglePanel = (show) => {
        if (!panelEl) return;
        panelEl.classList.toggle('open', show);
    };

    const openSettings = () => {
        $('#bili-emo-api-key').value = CONFIG.apiKey;
        $('#bili-emo-api-base').value = CONFIG.apiBase;
        $('#bili-emo-model').value = CONFIG.model;
        $('#bili-emo-api-url').value = CONFIG.commentApiUrl;
        $('#bili-emo-api-method').value = CONFIG.commentApiMethod;
        $('#bili-emo-res-path').value = CONFIG.responsePath;
        $('#bili-emo-api-headers').value = CONFIG.commentApiHeaders;
        $('#bili-emo-api-body').value = CONFIG.commentApiBody;
        $('#bili-emo-max-comments').value = CONFIG.maxComments;
        $('#bili-emo-reply-weight').value = CONFIG.replyWeightFactor;
        $('#bili-emo-emotions').value = CONFIG.emotions;
        $('#bili-emo-modal-overlay').classList.add('open');
    };

    const saveSettings = () => {
        CONFIG.apiKey = $('#bili-emo-api-key').value.trim();
        CONFIG.apiBase = $('#bili-emo-api-base').value.trim() || 'https://api.openai.com/v1';
        CONFIG.model = $('#bili-emo-model').value.trim() || 'gpt-4o-mini';
        CONFIG.commentApiUrl = $('#bili-emo-api-url').value.trim();
        CONFIG.commentApiMethod = $('#bili-emo-api-method').value;
        CONFIG.responsePath = $('#bili-emo-res-path').value.trim();
        CONFIG.commentApiHeaders = $('#bili-emo-api-headers').value.trim();
        CONFIG.commentApiBody = $('#bili-emo-api-body').value.trim();
        CONFIG.maxComments = parseInt($('#bili-emo-max-comments').value, 10) || 150;
        CONFIG.replyWeightFactor = parseFloat($('#bili-emo-reply-weight').value) || 1.0;
        CONFIG.emotions = $('#bili-emo-emotions').value.trim() || '贪婪,恐惧,犹豫,兴奋,淡定,愤怒,乐观,悲观,中性';
        $('#bili-emo-modal-overlay').classList.remove('open');
    };

    // ==================== 评论接口获取 ====================
    const fetchCommentsViaApi = () => {
        return new Promise((resolve, reject) => {
            const bvid = getBvid();
            if (!bvid) return reject(new Error('无法从当前 URL 提取 BV 号'));
            if (!CONFIG.commentApiUrl) return reject(new Error('请先配置评论接口地址'));

            const url = renderTemplate(CONFIG.commentApiUrl, { bvid });
            const method = CONFIG.commentApiMethod || 'GET';
            let headers = {};
            try {
                headers = JSON.parse(CONFIG.commentApiHeaders || '{}');
            } catch (e) { /* ignore invalid json */ }

            let body = null;
            if (method === 'POST' && CONFIG.commentApiBody) {
                body = renderTemplate(CONFIG.commentApiBody, { bvid });
                if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
            }

            GM_xmlhttpRequest({
                method,
                url,
                headers,
                data: body,
                timeout: 30000,
                onload: res => {
                    try {
                        const json = JSON.parse(res.responseText);
                        const rawList = getPath(json, CONFIG.responsePath);
                        if (!Array.isArray(rawList)) {
                            throw new Error('响应中未找到评论数组，请检查数据路径');
                        }
                        const comments = normalizeComments(rawList);
                        resolve(comments);
                    } catch (e) {
                        reject(new Error('接口解析失败: ' + e.message));
                    }
                },
                onerror: () => reject(new Error('评论接口请求失败，请检查地址和跨域配置')),
                ontimeout: () => reject(new Error('评论接口请求超时')),
            });
        });
    };

    // 规范化评论数据：支持多种字段名
    const normalizeComments = (rawList) => {
        const comments = [];
        for (const item of rawList) {
            if (!item || typeof item !== 'object') continue;
            const content = item.content || item.text || item.message || item.desc || '';
            if (!content) continue;
            const likes = parseInt(item.likes || item.like || item.thumbs || item.up_count || 0, 10) || 0;
            const replies = parseInt(item.replies || item.reply_count || item.reply || item.rcount || 0, 10) || 0;

            const subComments = [];
            const subs = item.subComments || item.sub_comments || item.replies_list || item.children || [];
            if (Array.isArray(subs)) {
                for (const s of subs) {
                    if (!s || typeof s !== 'object') continue;
                    const sc = s.content || s.text || s.message || '';
                    if (!sc) continue;
                    subComments.push({
                        content: sc,
                        likes: parseInt(s.likes || s.like || 0, 10) || 0,
                    });
                }
            }

            comments.push({ content, likes, replies, subComments });
        }
        return comments;
    };

    // ==================== 权重计算 ====================
    const calcWeight = (c) => {
        const subWeight = c.subComments.reduce((sum, s) => sum + (s.likes || 0), 0) * 0.3;
        return c.likes + c.replies * CONFIG.replyWeightFactor + subWeight;
    };

    const prepareCommentsForAI = (comments) => {
        // 计算权重并排序
        const weighted = comments.map(c => ({
            ...c,
            weight: calcWeight(c),
        }));
        weighted.sort((a, b) => b.weight - a.weight);

        const max = CONFIG.maxComments;
        const selected = weighted.slice(0, max);

        // 构造文本，包含子评论
        let text = '';
        let count = 0;
        for (const c of selected) {
            let line = `${count + 1}. [${c.likes}赞/${c.replies}回复/权重${c.weight.toFixed(1)}] ${c.content}`;
            if (c.subComments.length > 0) {
                const subText = c.subComments.map(s => `└ ${s.content}(${s.likes}赞)`).join(' | ');
                line += ` > 子评论: ${subText}`;
            }
            line += '\n';
            if ((text + line).length > 8000) break;
            text += line;
            count++;
        }
        return { text, count, selected };
    };

    // ==================== AI 分析 ====================
    const analyzeComments = async (comments) => {
        const emotions = EMOTION_LIST();
        const emotionTags = emotions.map(e => `[${e}]`).join('');
        const { text: commentsText, count } = prepareCommentsForAI(comments);

        const prompt = `你是一位资深投资情绪分析专家。请对以下B站财经视频评论区内容进行情绪分类与分析。

每条记录格式为：[点赞数/回复数/权重] 评论内容 > 子评论: xxx(赞数)
权重已综合考虑点赞和回复热度，权重越高代表该评论越受关注。

## 评论内容（共 ${count} 条，已按权重排序）：
${commentsText}

## 分析要求
1. 逐条判断情绪，只能从以下标签中选择：${emotionTags}
2. 统计各情绪占比（%），高权重评论应占更大影响力
3. 给出整体情绪倾向（1句话总结）
4. 挑选3-5条最具代表性的评论作为"关键引用"（优先高权重）
5. 计算情绪指数：范围 -100（极度悲观/恐惧）到 +100（极度乐观/贪婪），0为中性

## 输出格式
必须严格返回以下JSON格式，不要包含任何其他文字：
{
  "overall": "整体情绪一句话总结",
  "index": 整数(-100到100),
  "dominant": "主导情绪标签",
  "distribution": {
    "标签1": 占比数字,
    "标签2": 占比数字
  },
  "key_quotes": [
    {"text": "评论原文", "user": "", "emotion": "情绪标签"}
  ]
}`;

        return new Promise((resolve, reject) => {
            const apiUrl = CONFIG.apiBase.replace(/\/$/, '') + '/chat/completions';
            const isAnthropic = CONFIG.apiBase.includes('anthropic');

            let body, headers;
            if (isAnthropic) {
                headers = {
                    'Content-Type': 'application/json',
                    'x-api-key': CONFIG.apiKey,
                    'anthropic-version': '2023-06-01',
                };
                body = JSON.stringify({
                    model: CONFIG.model,
                    max_tokens: 2500,
                    messages: [{ role: 'user', content: prompt }],
                });
            } else {
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + CONFIG.apiKey,
                };
                body = JSON.stringify({
                    model: CONFIG.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.3,
                });
            }

            GM_xmlhttpRequest({
                method: 'POST',
                url: apiUrl,
                headers,
                data: body,
                timeout: 90000,
                onload: res => {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
                        const content = isAnthropic
                            ? data.content?.[0]?.text
                            : data.choices?.[0]?.message?.content;
                        if (!content) throw new Error('API 返回内容为空');
                        const jsonMatch = content.match(/\{[\s\S]*\}/);
                        if (!jsonMatch) throw new Error('无法从响应中解析 JSON');
                        const result = JSON.parse(jsonMatch[0]);
                        resolve(result);
                    } catch (e) {
                        reject(new Error('AI 解析失败: ' + e.message));
                    }
                },
                onerror: () => reject(new Error('AI API 网络请求失败')),
                ontimeout: () => reject(new Error('AI API 请求超时')),
            });
        });
    };

    // ==================== 结果渲染 ====================
    const renderResult = (result, totalComments) => {
        const emotions = EMOTION_LIST();
        const body = $('.bili-emo-body', panelEl);
        const dist = result.distribution || {};
        const labels = emotions.filter(e => dist[e] !== undefined);
        const data = labels.map(e => dist[e] || 0);

        const colorMap = {
            '贪婪': '#ff4d4f', '恐惧': '#722ed1', '犹豫': '#faad14', '兴奋': '#52c41a',
            '淡定': '#13c2c2', '愤怒': '#cf1322', '乐观': '#1890ff', '悲观': '#595959', '中性': '#8c8c8c',
        };
        const bgColors = labels.map(l => colorMap[l] || '#999');

        const index = Math.max(-100, Math.min(100, result.index || 0));
        const deg = ((index + 100) / 200) * 360;
        const indexColor = index > 30 ? '#52c41a' : index < -30 ? '#ff4d4f' : '#faad14';

        body.innerHTML = `
            <div class="bili-emo-section">
                <div class="bili-emo-section-title">情绪指数</div>
                <div class="bili-emo-score-wrap">
                    <div class="bili-emo-score-circle" style="background: conic-gradient(${indexColor} ${deg}deg, #eee 0);">
                        <span class="bili-emo-score-num">${index > 0 ? '+' : ''}${index}</span>
                    </div>
                    <div class="bili-emo-score-label">
                        <strong>${result.dominant || '未知'}</strong><br>
                        基于 ${totalComments} 条评论（含子评论）<br>
                        ${escapeHtml(result.overall || '')}
                    </div>
                </div>
            </div>

            <div class="bili-emo-section">
                <div class="bili-emo-section-title">情绪分布</div>
                <div class="bili-emo-chart-wrap">
                    <canvas id="bili-emo-chart"></canvas>
                </div>
            </div>

            <div class="bili-emo-section">
                <div class="bili-emo-section-title">关键引用</div>
                <div class="bili-emo-quotes">
                    ${(result.key_quotes || []).map(q => `
                        <div class="bili-emo-quote">
                            ${escapeHtml(q.text)}
                            <div class="bili-emo-quote-meta">
                                <span>[${q.emotion || ''}]</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <button class="bili-emo-settings-btn" onclick="document.getElementById('bili-emo-modal-overlay').classList.add('open')">⚙️ 设置</button>
        `;

        const ctx = $('#bili-emo-chart');
        if (ctx && typeof Chart !== 'undefined') {
            if (chartInstance) chartInstance.destroy();
            chartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels,
                    datasets: [{
                        data,
                        backgroundColor: bgColors,
                        borderWidth: 2,
                        borderColor: '#fff',
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'right',
                            labels: { boxWidth: 12, font: { size: 11 } },
                        },
                    },
                },
            });
        }
    };

    const renderLoading = (text) => {
        const body = $('.bili-emo-body', panelEl);
        body.innerHTML = `
            <div class="bili-emo-loading">
                <div class="bili-emo-loading-spinner"></div>
                <div>${text}</div>
            </div>
        `;
    };

    const renderError = (msg) => {
        const body = $('.bili-emo-body', panelEl);
        body.innerHTML = `
            <div class="bili-emo-error">
                <div>❌ ${escapeHtml(msg)}</div>
                <button class="bili-emo-settings-btn" style="margin-top:16px" onclick="document.getElementById('bili-emo-modal-overlay').classList.add('open')">前往设置</button>
            </div>
        `;
    };

    // ==================== 主流程 ====================
    const onAnalyzeClick = async () => {
        const btn = $('#bili-emotion-btn');

        if (!CONFIG.apiKey) {
            togglePanel(true);
            renderError('请先配置 AI API Key');
            openSettings();
            return;
        }
        if (!CONFIG.commentApiUrl) {
            togglePanel(true);
            renderError('请先配置评论接口地址');
            openSettings();
            return;
        }

        btn.classList.add('analyzing');
        btn.innerHTML = '分析中<br>...';
        togglePanel(true);
        renderLoading('正在从接口获取评论数据...');

        try {
            const comments = await fetchCommentsViaApi();
            if (!comments.length) {
                renderError('接口返回的评论为空');
                return;
            }
            renderLoading(`已获取 ${comments.length} 条主评论（含子评论），正在调用 AI 加权分析...`);
            const result = await analyzeComments(comments);
            renderResult(result, comments.length);
            GM_setValue('cache_' + getBvid(), JSON.stringify({ time: Date.now(), result, total: comments.length }));
        } catch (e) {
            renderError(e.message || '分析失败');
        } finally {
            btn.classList.remove('analyzing');
            btn.innerHTML = '情绪<br>分析';
        }
    };

    // ==================== 初始化 ====================
    const init = () => {
        if ($('#bili-emotion-btn')) return;
        createUI();
    };

    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

    // SPA 路由兼容
    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            $('#bili-emotion-btn')?.remove();
            $('#bili-emotion-panel')?.remove();
            $('#bili-emo-modal-overlay')?.remove();
            $('#bili-emotion-style')?.remove();
            setTimeout(init, 1500);
        }
    }).observe(document, { subtree: true, childList: true });
})();

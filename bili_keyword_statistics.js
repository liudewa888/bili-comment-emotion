// ==UserScript==
// @name         B站评论区-关键词统计
// @namespace    https://github.com/liudewa
// @updateURL   http://liudewa.cc/test/bili_keyword_statistics.user.js
// @version      0.2
// @description  支持同义词,单fetch劫持
// @author       liudewa
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/opus/*
// @match        https://www.bilibili.com/player/web_comment/*
// @match        https://comment.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* ===== 用户可配置：同义词表格 ===== */
(() => {
  'use strict';

  /* ---------- 1. 存储读写 ---------- */
  const LS_KEY = 'bili_kw_synonyms';
// 第一次运行才写默认配置，以后完全尊重用户
const initOnce = () => {
  if (!localStorage.getItem(LS_KEY)) {
    const defaultGroups = [['华子'], ['藏矿'], ['六子'], ['华大', '大华'], ['医疗']];
    localStorage.setItem(LS_KEY, JSON.stringify(defaultGroups));
  }
};
initOnce();

const loadSynonyms = () => JSON.parse(localStorage.getItem(LS_KEY));
const saveSynonyms = arr => localStorage.setItem(LS_KEY, JSON.stringify(arr));

  /* ---------- 2. 根据同义词生成统计 Map ---------- */
  let synonymTable = loadSynonyms();   // 二维数组
  const refreshStatMap = () => {
    const m = new Map();
    synonymTable.forEach(group => {
      const key = group.join(',');
      m.set(key, 0);
    });
    return m;
  };
  let stat = refreshStatMap();         // 初始空统计

  /* ---------- 3. 创建面板 DOM ---------- */
  const cfgBox = document.createElement('div');
  cfgBox.id = 'kw-cfg-box';
  document.documentElement.appendChild(cfgBox);

  const style = document.createElement('style');
  style.textContent = `
    #kw-cfg-box{position:fixed;right:12px;top:80px;width:300px;max-height:400px;overflow:auto;background:#fff;border:1px solid #e0e0e0;border-radius:4px;padding:10px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.15);z-index:9999}
    #kw-cfg-box table{width:100%;border-collapse:collapse;margin-top:6px}
    #kw-cfg-box th,#kw-cfg-box td{border:1px solid #ddd;padding:4px 6px}
    #kw-cfg-box input{width:100%;box-sizing:border-box;border:1px solid #ccc;padding:2px}
    #kw-cfg-box button{margin:6px 2px 0 0;padding:4px 8px;font-size:12px;cursor:pointer}
    #kw-cfg-box .del{color:#fff;background:#fb7299;border:none;border-radius:3px}
    #kw-cfg-box .add{background:#00a1d6;color:#fff;border:none;border-radius:3px}
  `;
  document.head.appendChild(style);

  /* ---------- 4. 渲染表格（同义词|次数|操作 三列） ---------- */
  const renderTable = () => {
    cfgBox.innerHTML = `
      <div><b>关键词配置(支持同义词,逗号分割)</b></div>
      <table>
        <thead><tr><th>同义词</th><th>次数</th><th>操作</th></tr></thead>
        <tbody>
          ${synonymTable.map((group, idx) => {
            const key = group.join(',');
            return `
              <tr>
                <td><input data-idx="${idx}" value="${group.join('，')}"></td>
                <td style="text-align:center;color:#fb7299;font-weight:bold">${stat.get(key) || 0}</td>
                <td><button class="del" data-del="${idx}">删</button></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    <div style="margin-top:6px;">
      <button class="add" id="kw-add-row">+ 新增一行</button>
      <button id="kw-reset" style="background:#ff4d4f;color:#fff;border:none;border-radius:3px;padding:4px 8px;font-size:12px;cursor:pointer">清零</button>
    </div>
    `;

    /* ---- 绑定事件 ---- */
    cfgBox.querySelectorAll('input').forEach(inp => {
      inp.onchange = e => {
        const idx = +e.target.dataset.idx;
        synonymTable[idx] = e.target.value.split(/，|,/).map(s => s.trim()).filter(Boolean);
        saveSynonyms(synonymTable);
        stat = refreshStatMap();
        renderTable();
      };
    });
    cfgBox.querySelectorAll('button.del').forEach(btn => {
      btn.onclick = e => {
        synonymTable.splice(+e.target.dataset.del, 1);
        saveSynonyms(synonymTable);
        stat = refreshStatMap();
        renderTable();
      };
    });
    cfgBox.querySelector('#kw-add-row').onclick = () => {
      synonymTable.push(['新关键词']);
      saveSynonyms(synonymTable);
      stat = refreshStatMap();
      renderTable();
    };
        /* ---- 清零 ---- */
  cfgBox.querySelector('#kw-reset').onclick = () => {
    stat = refreshStatMap(); // 全部归 0
    renderTable();
  };
  };

  /* ---------- 5. 统计核心 ---------- */
  const count = text => {
    synonymTable.forEach(group => {
      const hit = group.some(k => text.includes(k));
      if (hit) {
        const key = group.join(',');
        stat.set(key, stat.get(key) + 1);
      }
    });
  };
  const walk = (replies = []) => {
    replies.forEach(r => {
      if (r.content?.message) count(r.content.message);
      if (r.replies) walk(r.replies);
    });
  };
  const handleBody = body => {
    try {
      const j = JSON.parse(body);
      walk(j.data?.replies || []);
      renderTable();   // 刷新表格即可
    } catch (_) {}
  };

  /* ---------- 6. fetch 劫持 ---------- */
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const [url] = args;
    return nativeFetch.apply(this, args).then(resp => {
      if (typeof url === 'string' && url.includes('/x/v2/reply')) {
        const clone = resp.clone();
        clone.text().then(handleBody);
      }
      return resp;
    });
  };

  /* ---------- 7. 初始化 ---------- */
  renderTable();
})();
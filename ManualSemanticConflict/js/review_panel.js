/**
 * SpecAudit — 右侧审查结果面板
 * 统计总览 + 筛选 + 问题卡片 + 证据定位
 */
(function() {
  'use strict';

  // ============ DOM 引用 ============
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  var panelEmpty = $('#panelEmpty');
  var panelContent = $('#panelContent');
  var statsBar = $('#statsBar');
  var issueList = $('#issueList');
  var sortCount = $('#sortCount');
  var sortSelect = $('#sortSelect');
  var filterTabs = $('#filterTabs');
  var filterLevels = $('#filterLevels');

  // ============ 状态 ============
  var allIssues = [];
  var filteredIssues = [];
  var activeType = 'all';
  var activeLevel = 'all';
  var activeSort = 'level';
  var expandedCards = {};
  var evidenceStatusCache = {};

  // ============ 证据解析 ============
  function parseEvidence(raw) {
    var pathMatch = raw.match(/^\[([^\]]+)\]/);
    var path = pathMatch ? pathMatch[1] : '';
    var text = pathMatch ? raw.substring(pathMatch[0].length).trim() : raw;
    return { path: path, text: text, raw: raw };
  }

  // ============ 数据加载 ============
  function loadData(data) {
    allIssues = data || [];
    expandedCards = {};

    // 默认展开高和中的卡片
    allIssues.forEach(function(issue, idx) {
      if (issue.level === 'high' || issue.level === 'medium') {
        expandedCards[issue.id] = true;
      }
    });

    // 先预检证据可定位性，再渲染
    precheckEvidence();
    applyFilters();
    panelEmpty.style.display = 'none';
    panelContent.style.display = 'flex';
  }

  function showEmpty() {
    panelContent.style.display = 'none';
    panelEmpty.style.display = 'flex';
    var title = panelEmpty.querySelector('.empty-title');
    var desc = panelEmpty.querySelector('.empty-desc');
    if (title) title.textContent = '暂无审查结果';
    if (desc) desc.textContent = '当前 PDF 文档尚未生成审查报告';
  }

  // ============ 证据预检 ============
  function precheckEvidence() {
    evidenceStatusCache = {};

    allIssues.forEach(function(issue) {
      if (!issue.evidence) return;
      issue.evidence.forEach(function(evRaw, ei) {
        var key = issue.id + '_' + ei;
        var parsed = parseEvidence(evRaw);

        // 路径可解析 → 可定位（有章节兜底导航）
        if (parsed.path) {
          var sectionInfo = window.PDF_VIEWER.resolveEvidencePath(parsed.path);
          if (sectionInfo) {
            evidenceStatusCache[key] = 'found';
            return;
          }
        }

        // 原文可全文搜索（≥10字符 且 包含英文/数字内容）
        var rawText = (parsed.text || '').trim();
        var hasAscii = /[a-zA-Z0-9]{2,}/.test(rawText);
        var textSearchable = rawText.length >= 10 && hasAscii;
        evidenceStatusCache[key] = textSearchable ? 'found' : 'miss';
      });
    });
  }

  // ============ 筛选 ============
  function applyFilters() {
    var typeFiltered = allIssues;
    if (activeType !== 'all') {
      typeFiltered = allIssues.filter(function(issue) {
        return issue.id.indexOf(activeType) === 0;
      });
    }

    var levelFiltered = typeFiltered;
    if (activeLevel !== 'all') {
      levelFiltered = typeFiltered.filter(function(issue) {
        return issue.level === activeLevel;
      });
    }

    filteredIssues = levelFiltered;
    sortIssues();
    renderStats(typeFiltered);
    renderIssueList();
  }

  function sortIssues() {
    var levelOrder = { high: 0, medium: 1, low: 2 };

    if (activeSort === 'level') {
      filteredIssues.sort(function(a, b) {
        var la = levelOrder[a.level] || 3;
        var lb = levelOrder[b.level] || 3;
        if (la !== lb) return la - lb;
        return (b.conf || 0) - (a.conf || 0);
      });
    } else {
      filteredIssues.sort(function(a, b) {
        return (b.conf || 0) - (a.conf || 0);
      });
    }
  }

  // ============ 统计渲染 ============
  function renderStats(source) {
    var counts = { total: 0, high: 0, medium: 0, low: 0 };
    source.forEach(function(issue) {
      counts.total++;
      if (issue.level === 'high') counts.high++;
      else if (issue.level === 'medium') counts.medium++;
      else counts.low++;
    });

    var cards = [
      { cls: 'total',  label: '总计',   value: counts.total },
      { cls: 'high',   label: '高风险', value: counts.high },
      { cls: 'medium', label: '中风险', value: counts.medium },
      { cls: 'low',    label: '低风险', value: counts.low }
    ];

    statsBar.innerHTML = cards.map(function(c) {
      return '<div class="stat-card' + (c.cls === activeLevel ? ' active' : '') + '" data-level="' + c.cls + '">' +
        '<div class="stat-num ' + c.cls + '">' + c.value + '</div>' +
        '<div class="stat-label">' + c.label + '</div>' +
      '</div>';
    }).join('');

    statsBar.querySelectorAll('.stat-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var lv = card.dataset.level;
        if (lv === 'total') lv = 'all';
        setLevelFilter(lv);
      });
    });
  }

  // ============ 筛选事件 ============
  function setTypeFilter(type) {
    activeType = type;
    filterTabs.querySelectorAll('.filter-tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.type === type);
    });
    applyFilters();
  }

  function setLevelFilter(level) {
    activeLevel = level;
    filterLevels.querySelectorAll('.level-chip').forEach(function(c) {
      c.classList.toggle('active', c.dataset.level === level);
    });
    applyFilters();
  }

  filterTabs.addEventListener('click', function(e) {
    var tab = e.target.closest('.filter-tab');
    if (!tab) return;
    setTypeFilter(tab.dataset.type);
  });

  filterLevels.addEventListener('click', function(e) {
    var chip = e.target.closest('.level-chip');
    if (!chip) return;
    setLevelFilter(chip.dataset.level);
  });

  sortSelect.addEventListener('change', function() {
    activeSort = sortSelect.value;
    sortIssues();
    renderIssueList();
  });

  // ============ 问题列表渲染 ============
  function renderIssueList() {
    issueList.innerHTML = '';
    sortCount.textContent = filteredIssues.length + ' 条结果';

    if (filteredIssues.length === 0) {
      issueList.innerHTML = '<div class="issue-empty">' +
        '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" stroke-width="1.5">' +
          '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
        '</svg>' +
        '<p>当前筛选条件下无匹配问题</p>' +
      '</div>';
      return;
    }

    filteredIssues.forEach(function(issue, fi) {
      issueList.appendChild(buildCard(issue, fi));
    });
  }

  // ============ 卡片构建 ============
  function buildCard(issue, animIdx) {
    var isExpanded = expandedCards[issue.id] || false;
    var typeTag = issue.id.split('_')[0];
    var typeName = typeTag === 'Risk' ? '充分性' : (typeTag === 'Clarity' ? '清晰性' : '一致性');
    var typeBadgeCls = typeTag === 'Risk' ? 'badge-risk' : (typeTag === 'Clarity' ? 'badge-clarity' : 'badge-consistency');

    var card = document.createElement('div');
    card.className = 'issue-card ' + issue.level;
    card.style.animationDelay = (animIdx * 40) + 'ms';
    card.dataset.issueId = issue.id;

    var confPct = Math.round((issue.conf || 0) * 100);
    var confCls = confPct >= 80 ? 'high-conf' : (confPct >= 60 ? 'medium-conf' : 'low-conf');

    card.innerHTML =
      '<div class="card-header">' +
        '<span class="card-id">' + issue.id + '</span>' +
        '<span class="card-badge badge-' + issue.level + '">' + issue.level + '</span>' +
        '<span class="card-badge ' + typeBadgeCls + '">' + typeName + '</span>' +
        '<span class="card-title">' + issue.problem + '</span>' +
        '<svg class="card-chevron' + (isExpanded ? ' open' : '') + '" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
          '<polyline points="6 9 12 15 18 9"/>' +
        '</svg>' +
      '</div>' +
      '<div class="card-body' + (isExpanded ? ' open' : '') + '">' +
        '<div class="card-desc">' + escapeHtml(issue.desc) + '</div>' +
        buildEvidenceSection(issue) +
        (issue.reason ? '<div class="card-section">' +
          '<div class="card-section-label">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
            '充分性分析' +
          '</div>' +
          '<div class="card-reason">' + escapeHtml(issue.reason) + '</div>' +
        '</div>' : '') +
        (issue.suggestion ? '<div class="card-section">' +
          '<div class="card-section-label">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' +
            '修改建议' +
          '</div>' +
          '<div class="card-suggestion">' + escapeHtml(issue.suggestion) + '</div>' +
        '</div>' : '') +
        '<div class="card-confidence">' +
          '<span class="conf-label">置信度</span>' +
          '<div class="conf-bar"><div class="conf-fill ' + confCls + '" style="width:' + confPct + '%"></div></div>' +
          '<span class="conf-value">' + confPct + '%</span>' +
        '</div>' +
        (issue.search_result ? buildSearchEvidenceBtn() : '') +
      '</div>';

    // 点击头部切换展开
    var header = card.querySelector('.card-header');
    header.addEventListener('click', function(e) {
      // 不拦截 evidence 跳转按钮的点击
      if (e.target.closest('.evidence-item')) return;
      var body = card.querySelector('.card-body');
      var chevron = card.querySelector('.card-chevron');
      var newState = !body.classList.contains('open');
      body.classList.toggle('open', newState);
      chevron.classList.toggle('open', newState);
      expandedCards[issue.id] = newState;
    });

    // 绑定证据点击
    card.querySelectorAll('.evidence-item').forEach(function(item) {
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        onEvidenceClick(issue, item);
      });
    });

    // 绑定搜索证据按钮
    var searchBtn = card.querySelector('.search-evidence-btn');
    if (searchBtn) {
      searchBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        openSearchModal(issue);
      });
    }

    return card;
  }

  function buildEvidenceSection(issue) {
    if (!issue.evidence || issue.evidence.length === 0) return '';

    var items = issue.evidence.map(function(evRaw, ei) {
      var parsed = parseEvidence(evRaw);
      var key = issue.id + '_' + ei;
      var status = evidenceStatusCache[key] || 'unknown';
      var statusLabel = status === 'found' ? '可定位' : '不可定位';
      var statusCls = status === 'found' ? 'found' : 'miss';

      return '<div class="evidence-item' + (status === 'miss' ? ' not-found' : '') + '" data-evidence-idx="' + ei + '">' +
        (parsed.path ? '<span class="evidence-path" title="' + escapeAttr(parsed.path) + '">' + escapeHtml(truncatePath(parsed.path)) + '</span>' : '') +
        '<span class="evidence-text">' + escapeHtml(parsed.text) + '</span>' +
        '<span class="evidence-status ' + statusCls + '">' + statusLabel + '</span>' +
        '<span class="evidence-goto">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
            '<polyline points="15 3 21 3 21 9"/>' +
            '<line x1="10" y1="14" x2="21" y2="3"/>' +
          '</svg>' +
        '</span>' +
      '</div>';
    }).join('');

    return '<div class="card-section">' +
      '<div class="card-section-label">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' +
        '证据引用 (' + issue.evidence.length + ')' +
      '</div>' +
      items +
    '</div>';
  }

  function buildSearchEvidenceBtn() {
    return '<button class="search-evidence-btn" data-action="search-evidence">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
        '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
        '<rect x="3" y="14" width="7" height="7" rx="1"/>' +
        '<rect x="14" y="14" width="7" height="7" rx="1"/>' +
      '</svg>' +
      '查看搜索证据' +
      '<svg class="btn-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
        '<polyline points="9 18 15 12 9 6"/>' +
      '</svg>' +
    '</button>';
  }

  // ============ 搜索证据模态弹窗 ============
  function openSearchModal(issue) {
    var raw = issue.search_result || '';

    // 去掉 markdown 代码块包裹
    var html = raw
      .replace(/^```html?\s*\n?/i, '')
      .replace(/\n?```\s*$/, '')
      .trim();

    // 如果不是完整 HTML 文档，包装为最小 HTML
    if (!/<!DOCTYPE/i.test(html) && !/<html/i.test(html)) {
      html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
        'body{font-family:Lato,-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;color:#0F172A;line-height:1.6;margin:16px;}' +
        'table{width:100%;border-collapse:collapse;margin-bottom:16px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.08);}' +
        'th{background:#1E3A8A;color:#fff;font-weight:600;padding:10px 14px;text-align:left;font-size:13px;}' +
        'td{padding:10px 14px;border-bottom:1px solid #E2E8F0;vertical-align:top;line-height:1.6;}' +
        'tr:last-child td{border-bottom:none;}' +
        'a{color:#B45309;text-decoration:none;}' +
        'a:hover{text-decoration:underline;}' +
        '.evidence-en{color:#2d4059;font-style:italic;background:#f8fafc;padding:8px 12px;border-left:3px solid #e94560;border-radius:4px;display:block;margin:6px 0;}' +
        '</style></head><body>' + html + '</body></html>';
    }

    // 构建弹窗 DOM
    var overlay = document.createElement('div');
    overlay.className = 'search-modal-overlay';
    overlay.innerHTML =
      '<div class="search-modal">' +
        '<div class="search-modal-header">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
            '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
            '<rect x="3" y="14" width="7" height="7" rx="1"/>' +
            '<rect x="14" y="14" width="7" height="7" rx="1"/>' +
          '</svg>' +
          '<span class="search-modal-title" title="' + escapeAttr(issue.id + ' ' + issue.problem) + '">' +
            escapeHtml(issue.id) + ' — ' + escapeHtml(issue.problem) +
          '</span>' +
          '<button class="search-modal-close" data-action="close-search-modal" title="关闭">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
              '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
            '</svg>' +
          '</button>' +
        '</div>' +
        '<div class="search-modal-body">' +
          '<iframe srcdoc="' + escapeAttr(html) + '" sandbox="" loading="lazy"></iframe>' +
        '</div>' +
        '<div class="search-modal-footer">' +
          '<button class="tool-btn" data-action="close-search-modal">关闭 (Esc)</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // 绑定关闭事件
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay || e.target.closest('[data-action="close-search-modal"]')) {
        closeSearchModal(overlay);
      }
    });

    // ESC 关闭
    function onKey(e) {
      if (e.key === 'Escape') {
        closeSearchModal(overlay);
        document.removeEventListener('keydown', onKey);
      }
    }
    document.addEventListener('keydown', onKey);

    // 保存清理引用
    overlay._onKey = onKey;
  }

  function closeSearchModal(overlay) {
    if (!overlay) {
      overlay = document.querySelector('.search-modal-overlay');
    }
    if (!overlay) return;

    document.removeEventListener('keydown', overlay._onKey);
    document.body.style.overflow = '';
    overlay.classList.add('closing');
    setTimeout(function() {
      if (overlay.parentNode) overlay.remove();
    }, 200);
  }

  // ============ 证据点击 → PDF 定位 ============
  function onEvidenceClick(issue, itemEl) {
    var ei = parseInt(itemEl.dataset.evidenceIdx, 10);
    var evRaw = issue.evidence[ei];
    var parsed = parseEvidence(evRaw);
    var key = issue.id + '_' + ei;
    var status = evidenceStatusCache[key] || 'unknown';

    if (status === 'miss') {
      showToast('无法定位：原文不可搜索且路径无法解析');
      return;
    }

    // 高亮当前卡片
    $$('.issue-card.evidence-active').forEach(function(c) {
      c.classList.remove('evidence-active');
    });
    itemEl.closest('.issue-card').classList.add('evidence-active');

    // 调用 PDF 查看器搜索并导航
    var result = window.PDF_VIEWER.navigateToEvidence(parsed.text, parsed.path);

    if (result.success) {
      if (result.method === 'section') {
        var heading = (result.sectionInfo && result.sectionInfo.matchedHeading) || parsed.path;
        showToast('无法精确匹配原文，已导航至章节：' + truncatePath(heading));
      } else {
        var methodLabels = {
          exact: '精确匹配',
          prefix_80: '前缀匹配(80%)',
          prefix_60: '前缀匹配(60%)',
          prefix_40: '前缀匹配(40%)',
          prefix_20: '前缀匹配(20%)',
          suffix_80: '后缀匹配(80%)',
          suffix_60: '后缀匹配(60%)',
          suffix_40: '后缀匹配(40%)',
          suffix_20: '后缀匹配(20%)'
        };
        var methodLabel = methodLabels[result.method] || result.method;
        showToast('已定位到证据位置：' + methodLabel);
      }
    } else {
      showToast('无法定位：原文搜索与路径导航均失败');
    }
  }

  // ============ Toast ============
  function showToast(msg) {
    var existing = $('.panel-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'panel-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);

    setTimeout(function() {
      if (toast.parentNode) toast.remove();
    }, 3000);
  }

  // ============ 工具函数 ============
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function truncatePath(path) {
    var parts = path.split('>');
    if (parts.length <= 2) return path;
    return parts[parts.length - 2].trim() + ' > ' + parts[parts.length - 1].trim();
  }

  // ============ 导出 API ============
  window.REVIEW_PANEL = {
    loadData: loadData,
    showEmpty: showEmpty,
    refresh: function() { if (allIssues.length > 0) loadData(allIssues); }
  };

  // ============ 初始化：统计折叠按钮 ============
  var statsToggleBtn = $('#statsToggle');
  if (statsToggleBtn) {
    statsToggleBtn.addEventListener('click', function() {
      var collapsed = statsBar.classList.toggle('collapsed');
      statsToggleBtn.classList.toggle('collapsed', collapsed);
      statsToggleBtn.title = collapsed ? '展开统计' : '折叠统计';
    });
  }

  // ============ 初始化：注册数据回调 ============
  window.PDF_VIEWER.onDataLoaded = function(data) {
    if (data && data.length > 0) {
      loadData(data);
    } else {
      showEmpty();
    }
  };

  // 检查是否已有加载完成的数据
  var existingData = window.PDF_VIEWER.getMergedResult();
  if (existingData && existingData.length > 0) {
    loadData(existingData);
  }
})();

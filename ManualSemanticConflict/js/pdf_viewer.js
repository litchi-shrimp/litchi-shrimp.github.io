/**
 * SpecAudit — PDF 说明书查看器
 * 三层结构：Canvas（渲染）+ 文字层（行级、透明可选）+ 高亮层（行级搜索匹配）
 */
(function() {
  'use strict';

  // ============ 配置 ============
  var PDF_LIST_PATH = 'static/pdf_list.json';
  var ZOOM_STEP = 0.25;
  var MIN_ZOOM = 0.25;
  var MAX_ZOOM = 4.0;
  var MIN_PANEL_W = 400;
  var MAX_PANEL_RATIO = 0.82;

  // ============ DOM 引用 ============
  function $(sel) { return document.querySelector(sel); }

  var canvas = $('#pdfCanvas');
  var textLayer = $('#textLayer');
  var highlightLayer = $('#highlightLayer');
  var viewport = $('#pdfViewport');
  var container = $('#pdfContainer');
  var pdfPanel = $('#pdfPanel');
  var splitDivider = $('#splitDivider');
  var mainLayout = $('#mainLayout');
  var pageInput = $('#pageInput');
  var pageTotal = $('#pageTotal');
  var zoomLabel = $('#zoomLevel');
  var searchInput = $('#searchInput');
  var searchStats = $('#searchStats');
  var fileSelect = $('#fileSelect');

  // ============ 状态 ============
  var pdfList = [];
  var currentPdfIdx = 0;
  var pdfDoc = null;
  var blockData = null;
  var totalPages = 0;
  var currentPage = 1;
  var currentZoom = 1.0;
  var baseScale = 1.0;
  var searchResults = [];
  var activeSearchIdx = -1;
  var pageSizePts = null;
  var isRendering = false;
  var eventsBound = false;

  // ============ Layout 数据归一化 ============
  // 适配 layout_new.json 扁平格式：
  //   [{page_no, width, height, elements: [{label, text, bbox, html, image_path}, ...]}, ...]
  // bbox 坐标单位：PDF points，原点在页面左下角
  function extractTextFromLayout(layoutArray, totalPdfPages) {
    var result = [];

    // 初始化：保证 pdfData 长度 === totalPdfPages，缺失页为空数组
    for (var i = 0; i < totalPdfPages; i++) {
      result.push([]);
    }

    for (var pi = 0; pi < layoutArray.length; pi++) {
      var page = layoutArray[pi];
      var pageIdx = (page.page_no || (pi + 1)) - 1; // page_no 1-based → 0-based 下标
      var elements = page.elements || [];
      var pageBlocks = [];

      for (var j = 0; j < elements.length; j++) {
        var el = elements[j];

        // 跳过无文本元素的图片/表格
        if (el.label === 'picture' || el.label === 'table') continue;
        if (!el.text || el.text.trim().length === 0) continue;

        var lines = el.text.split('\n');
        var lineBboxes = estimateLineBboxes(el.bbox, lines.length);

        pageBlocks.push({
          bbox: el.bbox,
          type: (el.label === 'section_header') ? 'title' : 'text',
          text: el.text,
          lineBboxes: lineBboxes
        });
      }

      if (pageIdx >= 0 && pageIdx < result.length) {
        result[pageIdx] = pageBlocks;
      }
    }

    return result;
  }

  // 行级 bbox 估算：新格式只有元素级 bbox，按行数均分垂直空间
  function estimateLineBboxes(bbox, lineCount) {
    var result = [];
    var x0 = bbox[0], y0 = bbox[1], x1 = bbox[2], y1 = bbox[3];
    var totalH = y1 - y0;
    var lineH = totalH / lineCount;

    for (var i = 0; i < lineCount; i++) {
      result.push([
        x0,
        y0 + i * lineH,
        x1,
        y0 + (i + 1) * lineH
      ]);
    }
    return result;
  }

  // ============ 初始化 ============
  async function init() {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/pdfjs/pdf.worker.min.js';

    try {
      // 先获取 PDF 清单
      var listResp = await fetch(PDF_LIST_PATH);
      if (!listResp.ok) throw new Error('无法加载 PDF 清单 (HTTP ' + listResp.status + ')');
      pdfList = await listResp.json();
      if (!pdfList.length) throw new Error('没有可用的 PDF 文档');

      // 填充下拉框
      populateFileSelect();

      // 绑定事件（只绑一次）
      if (!eventsBound) {
        bindEvents();
        bindDividerEvents();
        eventsBound = true;
      }

      // 加载第一个文档
      await loadDocument(0);
    } catch (err) {
      console.error('初始化失败:', err.message || err);
      showError('加载失败: ' + (err.message || err));
    }
  }

  function populateFileSelect() {
    fileSelect.innerHTML = '';
    for (var i = 0; i < pdfList.length; i++) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = pdfList[i].name;
      fileSelect.appendChild(opt);
    }
    fileSelect.addEventListener('change', function() {
      var idx = parseInt(fileSelect.value, 10);
      if (idx !== currentPdfIdx) {
        loadDocument(idx);
      }
    });
  }

  async function loadDocument(idx) {
    if (isRendering) return;
    isRendering = true;

    var info = pdfList[idx];
    if (!info) { isRendering = false; return; }

    // 重置状态
    pdfDoc = null;
    blockData = null;
    mergedResult = null;
    headingList = [];
    headingIndex = {};
    sectionHighlight = null;
    currentPdfIdx = idx;
    currentPage = 1;
    currentZoom = 1.0;
    searchResults = [];
    activeSearchIdx = -1;
    evidenceMatches = [];
    searchInput.value = '';
    searchStats.textContent = '';
    highlightLayer.innerHTML = '';
    evidenceLayer.innerHTML = '';
    textLayer.innerHTML = '';
    canvas.style.display = 'block';

    fileSelect.value = idx;
    pageInput.value = 1;

    var pdfPath = 'static/' + info.folder + '/' + info.pdf;
    var layoutPath = 'static/' + info.folder + '/' + (info.layout || 'layout.json');
    var resultPath = 'static/' + info.folder + '/' + (info.result || 'merged_result.json');
    var fullMdPath = 'static/' + info.folder + '/full.md';

    try {
      var fetchPromises = [
        pdfjsLib.getDocument(pdfPath).promise,
        fetch(layoutPath).then(function(r) {
          if (!r.ok) throw new Error('Layout JSON HTTP ' + r.status);
          return r.json();
        }),
        fetch(resultPath).then(function(r) {
          if (!r.ok) return null;
          return r.json();
        }).catch(function() { return null; }),
        fetch(fullMdPath).then(function(r) {
          if (!r.ok) return null;
          return r.text();
        }).catch(function() { return null; })
      ];

      var results = await Promise.all(fetchPromises);

      pdfDoc = results[0];
      var layoutRaw = results[1];
      mergedResult = results[2];
      var fullMdText = results[3];
      totalPages = pdfDoc.numPages;
      blockData = { pdfData: extractTextFromLayout(layoutRaw, totalPages) };

      // 解析 full.md 标题索引
      if (fullMdText) {
        headingIndex = parseFullMdHeadings(fullMdText);
      }

      pageTotal.textContent = '/ ' + totalPages;
      pageInput.max = totalPages;

      initPanelWidth();
      isRendering = false;
      await renderPage(1);

      // 通知审查面板数据已加载（回调模式）
      if (_onDataLoaded) {
        _onDataLoaded(mergedResult);
      }
    } catch (err) {
      isRendering = false;
      console.error('文档加载失败:', err.message || err);
      showError('文档加载失败: ' + (err.message || err));
    }
  }

  // ============ 面板宽度初始化 ============
  function initPanelWidth() {
    var w = mainLayout.clientWidth;
    var defaultW = Math.round(w * 0.58);
    setPanelWidth(defaultW);
  }

  function setPanelWidth(w) {
    var maxW = Math.floor(mainLayout.clientWidth * MAX_PANEL_RATIO);
    w = Math.max(MIN_PANEL_W, Math.min(w, maxW));
    pdfPanel.style.width = w + 'px';
  }

  // ============ 分隔条拖拽 ============
  function bindDividerEvents() {
    var startX = 0;
    var startW = 0;

    splitDivider.addEventListener('mousedown', function(e) {
      e.preventDefault();
      startX = e.clientX;
      startW = pdfPanel.clientWidth;
      document.body.classList.add('dragging');
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', onDrop);
    });

    function onDrag(e) {
      var dx = e.clientX - startX;
      var newW = startW + dx;
      setPanelWidth(newW);
      scheduleResizeRender();
    }

    function onDrop() {
      document.body.classList.remove('dragging');
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onDrop);
      // 拖拽结束时立即渲染
      recalcBaseScale();
      renderPage(currentPage);
    }
  }

  var resizeTimer = null;
  function scheduleResizeRender() {
    if (resizeTimer) cancelAnimationFrame(resizeTimer);
    resizeTimer = requestAnimationFrame(function() {
      recalcBaseScale();
      renderPage(currentPage);
      resizeTimer = null;
    });
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    $('#btnZoomIn').addEventListener('click', zoomIn);
    $('#btnZoomOut').addEventListener('click', zoomOut);
    $('#btnFitWidth').addEventListener('click', zoomFitWidth);
    $('#btnFitPage').addEventListener('click', zoomFitPage);
    $('#btnPrev').addEventListener('click', function() { goToPage(currentPage - 1); });
    $('#btnNext').addEventListener('click', function() { goToPage(currentPage + 1); });

    pageInput.addEventListener('change', function() {
      var p = parseInt(pageInput.value, 10);
      if (p >= 1 && p <= totalPages) goToPage(p);
      else pageInput.value = currentPage;
    });

    searchInput.addEventListener('input', debounce(onSearch, 250));
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) searchPrev();
        else searchNext();
      }
    });

    $('#btnSearchPrev').addEventListener('click', searchPrev);
    $('#btnSearchNext').addEventListener('click', searchNext);

    window.addEventListener('resize', debounce(function() {
      if (pdfDoc) {
        recalcBaseScale();
        renderPage(currentPage);
      }
    }, 200));

    container.addEventListener('wheel', function(e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
      }
    }, { passive: false });

    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT') return;
      if (e.ctrlKey || e.metaKey) return;
      switch (e.key) {
        case 'ArrowLeft': goToPage(currentPage - 1); break;
        case 'ArrowRight': goToPage(currentPage + 1); break;
        case '+': case '=': zoomIn(); break;
        case '-': zoomOut(); break;
        case '0': zoomFitWidth(); break;
      }
    });
  }

  // ============ 页面渲染 ============
  async function renderPage(pageNum) {
    if (!pdfDoc || isRendering) return;
    isRendering = true;

    try {
      currentPage = Math.max(1, Math.min(pageNum, totalPages));
      pageInput.value = currentPage;

      var page = await pdfDoc.getPage(currentPage);
      var vp = page.getViewport({ scale: 1 });
      pageSizePts = [vp.width, vp.height];

      recalcBaseScale();
      var scale = baseScale * currentZoom;

      // Canvas 渲染
      var renderVp = page.getViewport({ scale: scale });
      canvas.width = renderVp.width;
      canvas.height = renderVp.height;
      canvas.style.width = renderVp.width + 'px';
      canvas.style.height = renderVp.height + 'px';

      var ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: renderVp }).promise;

      viewport.style.width = renderVp.width + 'px';
      viewport.style.height = renderVp.height + 'px';

      // 文字层 + 搜索高亮层
      renderTextLayer(scale);
      highlightLayer.innerHTML = '';
      renderHighlights(scale);

      // 证据层：每次换页先清掉蓝框，仅当章节兜底激活时重绘绿框
      evidenceLayer.innerHTML = '';
      if (sectionHighlight &&
          currentPage >= sectionHighlight.startPage &&
          currentPage <= sectionHighlight.endPage) {
        renderSectionHighlight();
      }

      zoomLabel.textContent = Math.round(currentZoom * 100) + '%';
    } finally {
      isRendering = false;
    }
  }

  // ============ 文字层（行级拆分，使用 layout.json 精确行 bbox）============
  function renderTextLayer(scale) {
    textLayer.innerHTML = '';
    textLayer.style.width = viewport.style.width;
    textLayer.style.height = viewport.style.height;

    if (!blockData || !blockData.pdfData) return;
    var pageBlocks = blockData.pdfData[currentPage - 1];
    if (!pageBlocks) return;

    for (var i = 0; i < pageBlocks.length; i++) {
      var block = pageBlocks[i];
      if (!block.text) continue;

      var lines = block.text.split('\n');
      var lineBboxes = block.lineBboxes;

      for (var li = 0; li < lines.length; li++) {
        var lineText = lines[li];
        if (lineText.length === 0) continue;

        var lb, lx, ly, lw, lh;
        if (lineBboxes && lineBboxes[li]) {
          lb = lineBboxes[li];
          lx = lb[0] * scale;
          ly = lb[1] * scale;
          lw = (lb[2] - lb[0]) * scale;
          lh = (lb[3] - lb[1]) * scale;
        } else {
          // fallback: 按 block bbox 比例拆分
          var bbox = block.bbox;
          lx = bbox[0] * scale;
          lw = (bbox[2] - bbox[0]) * scale;
          lh = (bbox[3] - bbox[1]) / lines.length * scale;
          ly = bbox[1] * scale + li * lh;
        }
        if (lw <= 0 || lh <= 0) continue;

        var fontSize = Math.max(8, Math.min(lh * 0.85, lw * 0.22));

        var el = document.createElement('span');
        el.className = 'text-line';
        el.textContent = lineText;
        el.dataset.blockIdx = i;
        el.dataset.lineIdx = li;
        el.style.left = lx + 'px';
        el.style.top = ly + 'px';
        el.style.width = (lw + 1) + 'px';
        el.style.height = lh + 'px';
        el.style.fontSize = fontSize + 'px';
        el.style.lineHeight = lh + 'px';
        textLayer.appendChild(el);
      }
    }
  }

  // ============ Zoom ============
  function recalcBaseScale() {
    var w = container.clientWidth - 40;
    if (pageSizePts && w > 0) {
      baseScale = w / pageSizePts[0];
      baseScale = Math.max(0.25, Math.min(baseScale, 3.0));
    }
  }

  function zoomIn() {
    currentZoom = Math.min(MAX_ZOOM, currentZoom + ZOOM_STEP);
    renderPage(currentPage);
  }

  function zoomOut() {
    currentZoom = Math.max(MIN_ZOOM, currentZoom - ZOOM_STEP);
    renderPage(currentPage);
  }

  function zoomFitWidth() {
    currentZoom = 1.0;
    renderPage(currentPage);
  }

  function zoomFitPage() {
    if (!pageSizePts) return;
    var ch = container.clientHeight - 40;
    var cw = container.clientWidth - 40;
    var sH = ch / pageSizePts[1];
    var sW = cw / pageSizePts[0];
    currentZoom = Math.min(sH, sW) / baseScale;
    currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom));
    renderPage(currentPage);
  }

  function goToPage(p) {
    if (p >= 1 && p <= totalPages && p !== currentPage) {
      renderPage(p);
      container.scrollTop = 0;
    }
  }

  // ============ 搜索（行级匹配 + 行级高亮）============
  function onSearch() {
    var query = searchInput.value.trim().toLowerCase();
    searchResults = [];
    activeSearchIdx = -1;
    highlightLayer.innerHTML = '';

    if (!query || query.length < 1 || !blockData || !blockData.pdfData) {
      searchStats.textContent = '';
      return;
    }

    for (var pi = 0; pi < blockData.pdfData.length; pi++) {
      var pageBlocks = blockData.pdfData[pi];
      if (!pageBlocks) continue;
      for (var i = 0; i < pageBlocks.length; i++) {
        var block = pageBlocks[i];
        if (!block.text) continue;
        if (block.text.toLowerCase().indexOf(query) === -1) continue;

        var lines = block.text.split('\n');
        var lineBboxes = block.lineBboxes;
        var bbox = block.bbox;

        for (var li = 0; li < lines.length; li++) {
          if (lines[li].toLowerCase().indexOf(query) !== -1) {
            var srBbox;
            if (lineBboxes && lineBboxes[li]) {
              srBbox = lineBboxes[li];
            } else {
              // fallback: 按 block bbox 比例拆分
              var bh = bbox[3] - bbox[1];
              var lineH = bh / lines.length;
              srBbox = [bbox[0], bbox[1] + li * lineH, bbox[2], bbox[1] + (li + 1) * lineH];
            }
            searchResults.push({
              page_idx: pi,
              blockIdx: i,
              lineIdx: li,
              text: lines[li],
              lineBbox: srBbox
            });
          }
        }
      }
    }

    if (searchResults.length > 0) {
      searchStats.textContent = searchResults.length + ' 个匹配';
      var onCurrent = searchResults.filter(function(r) { return r.page_idx === currentPage - 1; });
      if (onCurrent.length > 0) {
        activeSearchIdx = searchResults.indexOf(onCurrent[0]);
      } else {
        activeSearchIdx = 0;
        goToPage(searchResults[0].page_idx + 1);
      }
      renderHighlights(baseScale * currentZoom);
    } else {
      searchStats.textContent = '0 个匹配';
    }
  }

  function searchNext() {
    if (searchResults.length === 0) return;
    activeSearchIdx = (activeSearchIdx + 1) % searchResults.length;
    navigateToSearchResult();
  }

  function searchPrev() {
    if (searchResults.length === 0) return;
    activeSearchIdx = (activeSearchIdx - 1 + searchResults.length) % searchResults.length;
    navigateToSearchResult();
  }

  function navigateToSearchResult() {
    var r = searchResults[activeSearchIdx];
    if (!r) return;
    if (r.page_idx !== currentPage - 1) {
      goToPage(r.page_idx + 1);
    }
    updateSearchHighlight();
    scrollToHighlight();
  }

  function renderHighlights(scale) {
    highlightLayer.innerHTML = '';
    highlightLayer.style.width = viewport.style.width;
    highlightLayer.style.height = viewport.style.height;

    for (var i = 0; i < searchResults.length; i++) {
      var r = searchResults[i];
      if (r.page_idx !== currentPage - 1) continue;

      var lb = r.lineBbox;
      var hw = (lb[2] - lb[0]) * scale;
      var hh = (lb[3] - lb[1]) * scale;
      if (hw <= 0 || hh <= 0) continue;

      var isActive = i === activeSearchIdx;
      var el = document.createElement('div');
      el.className = 'highlight-rect' + (isActive ? ' active' : '');
      el.dataset.searchIdx = i;
      el.style.left = (lb[0] * scale) + 'px';
      el.style.top = (lb[1] * scale) + 'px';
      el.style.width = hw + 'px';
      el.style.height = hh + 'px';
      highlightLayer.appendChild(el);
    }
  }

  function updateSearchHighlight() {
    var rects = highlightLayer.querySelectorAll('.highlight-rect');
    for (var i = 0; i < rects.length; i++) {
      var idx = parseInt(rects[i].dataset.searchIdx, 10);
      rects[i].classList.toggle('active', idx === activeSearchIdx);
    }
  }

  function scrollToHighlight() {
    var active = highlightLayer.querySelector('.highlight-rect.active');
    if (!active) return;
    var hlRect = active.getBoundingClientRect();
    var containerTop = container.getBoundingClientRect().top;
    var offset = hlRect.top - containerTop - viewport.getBoundingClientRect().height / 3;
    container.scrollBy({ top: offset, behavior: 'smooth' });
  }

  // ============ 证据搜索（模糊匹配，处理换行/OCR误差）============
  var evidenceLayer = $('#evidenceLayer');
  var evidenceMatches = [];

  function normalizeText(str) {
    return str.replace(/\s+/g, ' ').replace(/[‐\-‐—]/g, '-').replace(/['']/g, "'").replace(/[""]/g, '"').trim().toLowerCase();
  }

  function getPageFlatText(pageIdx) {
    if (!blockData || !blockData.pdfData) return { lines: [], starts: [], lineSrc: [] };
    var blocks = blockData.pdfData[pageIdx];
    if (!blocks) return { lines: [], starts: [], lineSrc: [] };

    var lines = [];
    var starts = [];
    var lineSrc = [];

    for (var i = 0; i < blocks.length; i++) {
      var blockLines = blocks[i].text ? blocks[i].text.split('\n') : [];
      for (var li = 0; li < blockLines.length; li++) {
        if (blockLines[li].length === 0) continue;
        lines.push(normalizeText(blockLines[li]));
        starts.push(0);
        lineSrc.push({ blockIdx: i, lineIdx: li, text: blockLines[li], bbox: blocks[i].lineBboxes ? blocks[i].lineBboxes[li] : null, blockBbox: blocks[i].bbox, totalLines: blockLines.length });
      }
    }

    // 计算累积偏移量
    var acc = 0;
    for (var j = 0; j < lines.length; j++) {
      starts[j] = acc;
      acc += lines[j].length + 1;
    }

    return { lines: lines, starts: starts, lineSrc: lineSrc, flatText: lines.join(' ') };
  }

  function searchEvidence(queryText) {
    evidenceLayer.innerHTML = '';
    evidenceMatches = [];

    if (!queryText || queryText.length < 2 || !blockData || !blockData.pdfData) {
      return { found: false, matches: [], reason: 'no_data' };
    }

    var clean = normalizeText(queryText);
    if (clean.length < 2) return { found: false, matches: [], reason: 'too_short' };

    // 全量页面搜索
    var pagesToSearch = [];
    for (var ai = 0; ai < blockData.pdfData.length; ai++) {
      pagesToSearch.push(ai);
    }

    function trySearch(searchStr, minLen) {
      if (!searchStr || searchStr.length < (minLen || 3)) return null;
      for (var si = 0; si < pagesToSearch.length; si++) {
        var pi = pagesToSearch[si];
        var flat = getPageFlatText(pi);
        var idx = flat.flatText.indexOf(searchStr);
        if (idx !== -1) {
          var m = mapToLines(idx, searchStr.length, flat);
          if (m.length > 0) {
            return { matches: m, page: pi };
          }
        }
      }
      return null;
    }

    var result;
    var ratios = [0.8, 0.6, 0.4, 0.2];

    // 策略1：精确匹配
    result = trySearch(clean, 2);
    if (result) {
      evidenceMatches = result.matches.map(function(m) { m.page_idx = result.page; return m; });
      return { found: true, matches: evidenceMatches, method: 'exact' };
    }

    // 策略2：前缀匹配（80% → 60% → 40% → 20%）
    for (var ri = 0; ri < ratios.length; ri++) {
      var prefixLen = Math.floor(clean.length * ratios[ri]);
      if (prefixLen < 3) continue;
      var prefix = clean.substring(0, prefixLen);
      result = trySearch(prefix, 3);
      if (result) {
        evidenceMatches = result.matches.map(function(m) { m.page_idx = result.page; return m; });
        return { found: true, matches: evidenceMatches, method: 'prefix_' + Math.round(ratios[ri] * 100) };
      }
    }

    // 策略3：后缀匹配（80% → 60% → 40% → 20%）
    for (var rj = 0; rj < ratios.length; rj++) {
      var suffixLen = Math.floor(clean.length * ratios[rj]);
      if (suffixLen < 3) continue;
      var suffix = clean.substring(clean.length - suffixLen);
      result = trySearch(suffix, 3);
      if (result) {
        evidenceMatches = result.matches.map(function(m) { m.page_idx = result.page; return m; });
        return { found: true, matches: evidenceMatches, method: 'suffix_' + Math.round(ratios[rj] * 100) };
      }
    }

    return { found: false, matches: [], reason: 'no_match' };
  }

  function mapToLines(charIdx, charLen, flat) {
    var result = [];
    var endIdx = charIdx + charLen;

    for (var i = 0; i < flat.starts.length; i++) {
      var lineStart = flat.starts[i];
      var lineEnd = lineStart + flat.lines[i].length;
      if (lineStart < endIdx && lineEnd > charIdx) {
        result.push({
          blockIdx: flat.lineSrc[i].blockIdx,
          lineIdx: flat.lineSrc[i].lineIdx,
          text: flat.lineSrc[i].text,
          bbox: flat.lineSrc[i].bbox,
          blockBbox: flat.lineSrc[i].blockBbox,
          totalLines: flat.lineSrc[i].totalLines
        });
      }
    }
    return result;
  }

  function highlightEvidence(matches) {
    evidenceLayer.innerHTML = '';
    evidenceLayer.style.width = viewport.style.width;
    evidenceLayer.style.height = viewport.style.height;

    var scale = baseScale * currentZoom;

    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (m.page_idx !== currentPage - 1) continue;

      var lb = m.bbox;
      var hw, hh, lx, ly;

      if (lb) {
        lx = lb[0] * scale;
        ly = lb[1] * scale;
        hw = (lb[2] - lb[0]) * scale;
        hh = (lb[3] - lb[1]) * scale;
      } else {
        var bb = m.blockBbox;
        var lineH = (bb[3] - bb[1]) / m.totalLines;
        lx = bb[0] * scale;
        ly = (bb[1] + m.lineIdx * lineH) * scale;
        hw = (bb[2] - bb[0]) * scale;
        hh = lineH * scale;
      }

      if (hw <= 0 || hh <= 0) continue;

      var el = document.createElement('div');
      el.className = 'evidence-rect';
      el.style.left = lx + 'px';
      el.style.top = ly + 'px';
      el.style.width = hw + 'px';
      el.style.height = hh + 'px';
      el.dataset.evidenceIdx = i;
      evidenceLayer.appendChild(el);
    }

    // 滚动到第一个高亮位置
    if (matches.length > 0 && matches[0].page_idx === currentPage - 1) {
      scrollToEvidence(matches[0]);
    }
  }

  function scrollToEvidence(match) {
    var rects = evidenceLayer.querySelectorAll('.evidence-rect');
    if (rects.length === 0) return;
    var first = rects[0];
    var rect = first.getBoundingClientRect();
    var containerTop = container.getBoundingClientRect().top;
    var offset = rect.top - containerTop - viewport.getBoundingClientRect().height / 3;
    container.scrollBy({ top: offset, behavior: 'smooth' });
  }

  // 章节级高亮：在当前页渲染章节范围的所有文本块
  function renderSectionHighlight() {
    evidenceLayer.innerHTML = '';
    evidenceLayer.style.width = viewport.style.width;
    evidenceLayer.style.height = viewport.style.height;

    if (!sectionHighlight || !blockData || !blockData.pdfData) return;
    if (currentPage < sectionHighlight.startPage || currentPage > sectionHighlight.endPage) return;

    var blocks = blockData.pdfData[currentPage - 1];
    if (!blocks) return;

    var scale = baseScale * currentZoom;

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (!block.text || !block.bbox) continue;

      var bb = block.bbox;
      var el = document.createElement('div');
      el.className = 'section-rect';
      el.style.left = (bb[0] * scale) + 'px';
      el.style.top = (bb[1] * scale) + 'px';
      el.style.width = ((bb[2] - bb[0]) * scale) + 'px';
      el.style.height = ((bb[3] - bb[1]) * scale) + 'px';
      evidenceLayer.appendChild(el);
    }
  }

  function navigateToEvidence(queryText, evidencePath) {
    evidenceLayer.innerHTML = '';
    evidenceMatches = [];
    sectionHighlight = null;

    var cleanText = queryText ? normalizeText(queryText) : '';
    var isDescriptive = cleanText.length < 3 || /^[一-鿿]/.test(queryText.trim());

    // 1. 全文搜索原文（精确 → 前缀 → 后缀）
    if (!isDescriptive) {
      var result = searchEvidence(queryText);

      if (result.found && result.matches.length > 0) {
        var targetPage = result.matches[0].page_idx;
        if (targetPage !== currentPage - 1) {
          goToPage(targetPage + 1);
          setTimeout(function() {
            highlightEvidence(result.matches);
          }, 200);
        } else {
          highlightEvidence(result.matches);
        }
        return {
          success: true,
          method: result.method,
          matchCount: result.matches.length
        };
      }
    }

    // 2. 兜底：路径导航到最小级别标题位置
    var sectionInfo = resolveEvidencePath(evidencePath);
    if (sectionInfo) {
      sectionHighlight = { startPage: sectionInfo.startPage, endPage: sectionInfo.endPage };
      if (sectionInfo.startPage !== currentPage) {
        goToPage(sectionInfo.startPage);
      } else {
        renderSectionHighlight();
        container.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return {
        success: true,
        method: 'section',
        matchCount: 0,
        sectionInfo: sectionInfo
      };
    }

    return { success: false, reason: 'no_match' };
  }

  function clearEvidenceHighlight() {
    evidenceLayer.innerHTML = '';
    evidenceMatches = [];
    sectionHighlight = null;
  }

  // ============ full.md 标题→页码索引 ============
  var headingList = [];     // [{heading, normalizedHeading, level, page, lineNumber, index}]
  var headingIndex = {};    // { normalized_heading: page_number } (legacy, kept for quick lookup)
  var sectionHighlight = null;  // {startPage, endPage} for persistent section-level highlight

  function parseFullMdHeadings(mdText) {
    headingList = [];
    headingIndex = {};
    var currentPage = 0;
    var lines = mdText.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 页码标记 # Page N — 作为 level 1 兜底节点
      var pageMatch = line.match(/^# Page (\d+)/i);
      if (pageMatch) {
        currentPage = parseInt(pageMatch[1], 10);
        var ph = 'Page ' + currentPage;
        headingList.push({
          heading: ph,
          normalizedHeading: ph.toLowerCase(),
          level: 1,
          page: currentPage,
          lineNumber: i,
          index: headingList.length
        });
        headingIndex[ph.toLowerCase()] = currentPage;
        continue;
      }

      // 提取标题 (## 或 ###)
      var hMatch = line.match(/^(#{1,3})\s+(.+)/);
      if (!hMatch) continue;

      var level = hMatch[1].length;
      var title = hMatch[2].trim();

      if (title.length === 0 || title.length > 120) continue;

      var key = title.toLowerCase().replace(/\s+/g, ' ').trim();

      headingList.push({
        heading: title,
        normalizedHeading: key,
        level: level,
        page: currentPage,
        lineNumber: i,
        index: headingList.length
      });

      headingIndex[key] = currentPage;

      // 同时存储去除 ":" 后缀的版本
      var noSuffix = key.replace(/:\s*$/, '').trim();
      if (noSuffix !== key && !(noSuffix in headingIndex)) {
        headingIndex[noSuffix] = currentPage;
      }
    }
  }

  // 从证据路径解析章节信息（支持逐级回退）
  function resolveEvidencePath(evidencePath) {
    if (!evidencePath || evidencePath.length === 0) return null;
    if (headingList.length === 0) return null;

    var segments = evidencePath.split(/\s*>\s*/);

    // 从最长前缀开始尝试匹配
    for (var len = segments.length; len >= 1; len--) {
      var tryPath = segments.slice(0, len).join(' > ').toLowerCase().replace(/\s+/g, ' ').trim();

      var match = null;
      for (var i = 0; i < headingList.length; i++) {
        if (headingList[i].normalizedHeading === tryPath) {
          match = headingList[i];
          break;
        }
      }

      if (match) {
        // 找到章节结束位置：下一个同级或更高级标题之前
        var endPage = totalPages;
        for (var j = match.index + 1; j < headingList.length; j++) {
          if (headingList[j].level <= match.level) {
            endPage = headingList[j].page - 1;
            if (endPage < match.page) endPage = match.page;
            break;
          }
        }

        var pages = [];
        for (var p = match.page; p <= endPage; p++) {
          pages.push(p);
        }

        return {
          pages: pages,
          startPage: match.page,
          endPage: endPage,
          level: match.level,
          matchedHeading: match.heading,
          method: len === segments.length ? 'full_match' : 'partial_match'
        };
      }
    }

    return null;
  }

  // ============ 审查结果加载 ============
  var mergedResult = null;
  var _onDataLoaded = null;

  function getMergedResult() {
    return mergedResult;
  }

  // ============ 工具函数 ============
  function debounce(fn, delay) {
    var timer;
    return function() {
      var ctx = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function() { fn.apply(ctx, args); }, delay);
    };
  }

  function showError(msg) {
    canvas.style.display = 'none';
    textLayer.innerHTML = '';
    var errEl = document.createElement('div');
    errEl.style.cssText = 'padding:40px;text-align:center;color:#DC2626;font-size:16px;font-family:sans-serif;';
    errEl.textContent = msg;
    viewport.appendChild(errEl);
  }

  // ============ 启动 ============
  init().catch(function(err) {
    console.error('Init error:', err);
  });

  // 导出 API
  window.PDF_VIEWER = {
    goToPage: goToPage,
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    zoomFitWidth: zoomFitWidth,
    zoomFitPage: zoomFitPage,
    navigateToEvidence: navigateToEvidence,
    clearEvidenceHighlight: clearEvidenceHighlight,
    resolveEvidencePath: resolveEvidencePath,
    getMergedResult: getMergedResult,
    getCurrentPage: function() { return currentPage; },
    getTotalPages: function() { return totalPages; },
    getBlockData: function() { return blockData; },
    set onDataLoaded(cb) { _onDataLoaded = cb; }
  };
})();

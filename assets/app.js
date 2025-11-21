(() => {
  const STORAGE_KEY = "equipments";
  const state = {
    equipments: [],
    selectedId: null,
    filter: { q: "", type: "all", period: "all" },
    autosaveTimer: null,
    isDirty: false,
    edit: false,
    accessoriesSort: { column: null, direction: 'asc' }, // column: 'category', 'assetCode', 'name', 'code', 'serial', 'qty', 'note'
    historySort: { column: 'date', direction: 'desc' }, // column: 'date', 'type', 'desc', 'user'
    currentUser: null, // 현재 편집 중인 사용자
    pendingPhoto: null, // { dataURL, index }
    hydratedScope: 'unknown', // 'single' | 'all'
    prevSerialMap: new Map(), // id -> previous serial
    lastSavedMap: new Map(), // id -> serialized snapshot for change detection
    accAssetsCache: null, // 자산 검색용 전체 자산 캐시
    pendingUnlink: null, // { rowId, assetNo }
    pendingStatusChange: null, // { oldStatus, newStatus } - 상태 변경 대기 중인 정보
    linkedAssetsLoading: false,
    linkedAssetsSort: { column: 'name', direction: 'asc' },
  };
  let manualSaveInProgress = false;
  // 썸네일 캐시 (메모리): eq.id -> { photoCode, dataURL, desc }
  const thumbCache = new Map();
  // users 캐시 (메모리): email -> name
  const usersCache = new Map();
  // name -> email 역방향 매핑 (기존 데이터 호환성을 위해)
  const nameToEmailCache = new Map();
  // users 컬렉션 접근 권한 여부 (권한 오류 발생 시 false로 설정)
  let usersAccessAllowed = true;
  
  // 비밀번호 매핑
  // Password map removed for security - Firebase Authentication is used instead
  const passwordMap = {};

  const els = {};
  const $ = (sel) => document.querySelector(sel);

  // Utils
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const today = () => {
    // 한국 시간(KST, UTC+9) 기준으로 오늘 날짜 반환
    const now = new Date();
    // 한국 시간대(Asia/Seoul) 기준으로 날짜 가져오기
    const kstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const year = kstDate.getFullYear();
    const month = String(kstDate.getMonth() + 1).padStart(2, '0');
    const day = String(kstDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  // 위치 문자열 파서/빌더
  const parseLocation = (s) => {
    if (!s) return { major: "", middle: "", minor: "" };
    const parts = String(s).split('/').map(p => p.trim());
    return { major: parts[0] || "", middle: parts[1] || "", minor: parts[2] || "" };
  };
  const buildLocation = (major, middle, minor) => {
    const mj = String(major || '').trim();
    const md = String(middle || '').trim();
    const mn = String(minor || '').trim();
    return [mj, md, mn].filter((v, idx) => v && (idx === 0 || v !== '')).join('/');
  };
  const normalizeSerial = (serial) => (serial || '').trim().toUpperCase();
  // 유형 필터 동기화/조회 (신규 토글 버튼 + 레거시 라디오 지원)
  function syncFilterTypeRadios(type) {
    const toggles = document.querySelectorAll('.type-toggle-group .type-toggle');
    if (toggles && toggles.length) {
      let matched = false;
      toggles.forEach(btn => {
        const isTarget = btn.dataset.filter === type;
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-pressed', isTarget ? 'true' : 'false');
        if (isTarget) matched = true;
      });
      if (!matched) {
        toggles.forEach(btn => {
          const isAll = btn.dataset.filter === 'all';
          btn.classList.toggle('active', isAll);
          btn.setAttribute('aria-pressed', isAll ? 'true' : 'false');
        });
      }
      return;
    }
    // Fallback: 기존 라디오 지원
    const radios = document.querySelectorAll('input[name="filterType"]');
    if (!radios || !radios.length) return;
    let matched = false;
    radios.forEach(r => {
      const isChecked = r.value === type;
      r.checked = isChecked;
      if (isChecked) matched = true;
    });
    if (!matched) {
      const all = Array.from(radios).find(r => r.value === 'all');
      if (all) all.checked = true;
    }
  }
  function getSelectedFilterType() {
    const activeToggle = document.querySelector('.type-toggle-group .type-toggle.active');
    if (activeToggle) return activeToggle.dataset.filter || 'all';
    const sel = document.querySelector('input[name="filterType"]:checked');
    return sel ? sel.value : 'all';
  }
  // 시리얼 번호 기반 고유 ID 생성
  const generateIdFromSerial = (serialNo) => {
    if (!serialNo || !serialNo.trim()) return uid(); // 시리얼 번호가 없으면 임시 ID
    return `SERIAL_${serialNo.trim().toUpperCase().replace(/\s+/g, '_')}`;
  };
  // Firestore 문서 ID용 시리얼 번호 변환 (Firestore 문서 ID 제한 문자 제거)
  const sanitizeForDocId = (serialNo) => {
    if (!serialNo || !serialNo.trim()) return null;
    // Firestore 문서 ID는 영문, 숫자, 하이픈, 언더스코어만 허용
    return serialNo.trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  };
  function ensureEquipmentIds(list = state.equipments) {
    if (!Array.isArray(list)) return new Map();
    const replacements = new Map();
    const used = new Set();
    const uniqueUid = () => {
      let candidate = uid();
      while (used.has(candidate)) candidate = uid();
      return candidate;
    };
    const buildSerialId = (serial) => {
      const baseId = generateIdFromSerial(serial);
      let candidate = baseId;
      let suffix = 1;
      while (used.has(candidate)) {
        suffix += 1;
        candidate = `${baseId}_${suffix}`;
      }
      return candidate;
    };
    list.forEach((eq) => {
      if (!eq) return;
      const prevId = typeof eq.id === "string" ? eq.id.trim() : "";
      const hasSerial = !!(eq.serialNo && eq.serialNo.trim());
      let candidate = prevId;
      if (!candidate) {
        candidate = hasSerial ? buildSerialId(eq.serialNo) : uniqueUid();
      } else if (used.has(candidate)) {
        candidate = hasSerial ? buildSerialId(eq.serialNo) : uniqueUid();
      }
      if (prevId && candidate !== prevId) {
        replacements.set(prevId, candidate);
      }
      eq.id = candidate;
      used.add(candidate);
    });
    return replacements;
  }

  // Serialize equipment for change detection (stable field order)
  function serializeEqForCompare(eq) {
    if (!eq) return '';
    const pick = {
      id: eq.id || '',
      model: eq.model || '',
      serialNo: eq.serialNo || '',
      codeNo: eq.codeNo || '',
      category: eq.category || '',
      installDate: eq.installDate || '',
      calibrationDate: eq.calibrationDate || '',
      note: eq.note || '',
      manufacturer: eq.manufacturer || '',
      location: eq.location || '',
      status: eq.status || '',
      photoCode: eq.photoCode || '',
      representativePhoto: eq.representativePhoto ?? null,
      tags: Array.isArray(eq.tags) ? eq.tags : [],
      photos: Array.isArray(eq.photos) ? eq.photos : [],
      specs: Array.isArray(eq.specs) ? eq.specs : [],
      accessories: Array.isArray(eq.accessories) ? eq.accessories : [],
      history: Array.isArray(eq.history) ? eq.history : [],
      tasks: Array.isArray(eq.tasks) ? eq.tasks : [],
    };
    try { return JSON.stringify(pick); } catch(_) { return String(Math.random()); }
  }

  // Data model
  function newEquipment() {
    return {
      id: uid(), // 초기에는 임시 ID, 시리얼 번호 입력 시 자동 업데이트
      model: "",
      serialNo: "",
      codeNo: "",
      category: "",
      installDate: "",
      calibrationDate: "",
      note: "",
      manufacturer: "",
      location: "",
      status: "", // 측정기 상태: "normal", "partial_fault", "unusable", "outbound", "sold"
      tags: [],
      photos: [],
      photoCode: "", // 사진 최신 업데이트 코드(일자+시간 ISO)
      representativePhoto: null, // 대표사진 인덱스 또는 null
      specs: [], // {id,key,value}
      accessories: [], // {id,name,code,qty,note}
      history: [], // {id,date,type,desc,user}
      tasks: [], // {id,title,periodYear,periodMonth,periodDay,lastCheck,nextCheck,note}
    };
  }

  function bindElements() {
    els.btnSave = $("#btnSave");
    els.btnToggleEdit = $("#btnToggleEdit");
    els.btnList = $("#btnList");

    els.reqModel = $("#reqModel");
    els.reqSerial = $("#reqSerial");
    els.reqCode = $("#reqCode");
    els.reqCategory = $("#reqCategory");
    els.reqInstallDate = $("#reqInstallDate");
    els.reqCalibrationDate = $("#reqCalibrationDate");
    els.reqNote = $("#reqNote");
    // 위치 입력 컨트롤
    els.reqLocationMajor = document.getElementById('reqLocationMajor');
    els.reqLocationMiddle = document.getElementById('reqLocationMiddle');
    els.reqLocationMinor = document.getElementById('reqLocationMinor');

    els.photosGrid = $("#photosGrid");
    els.photoFile = $("#photoFile");
    els.photoModal = $("#photoModal");
    els.modalImage = $("#modalImage");
    els.modalClose = $("#modalClose");
    // 저장 진행 모달 요소
    els.progressModal = document.getElementById('progressModal');
    els.progressMessage = document.getElementById('progressMessage');
    els.progressBar = document.getElementById('progressBar');
    els.progressIcon = document.getElementById('progressIcon');

    // Image preview
    els.btnImagePreview = document.getElementById('btnImagePreview');
    els.imagePreview = document.getElementById('imagePreview');
    els.imageEmptyState = document.getElementById('imageEmptyState');
    els.imageMetaDesc = document.getElementById('imageMetaDesc');
    els.imageMetaSub = document.getElementById('imageMetaSub');

    // Summary
    els.sumModel = document.querySelector('#sumModel');
    els.sumSerial = document.querySelector('#sumSerial');
    els.sumInstall = document.querySelector('#sumInstall');
    els.sumCalib = document.querySelector('#sumCalib');
    els.sumCode = document.querySelector('#sumCode');
    els.sumLocation = document.querySelector('#sumLocation');

    // 유형 필터: 라디오 그룹으로 전환됨 (name="filterType")
    els.filterType = $("#filterType"); // 과거 select 지원(없으면 null)
    els.filterPeriod = $("#filterPeriod");

    els.btnAddAcc = $("#btnAddAcc");
    els.btnAddHist = $("#btnAddHist");
    els.btnAddTask = $("#btnAddTask");
    els.btnAddSpec = $("#btnAddSpec");

    els.accBody = $("#accBody");
    // Accessories modals
    els.accAssetModal = document.getElementById('accAssetModal');
    els.accSearchInput = document.getElementById('accSearchInput');
    els.accSearchResults = document.getElementById('accSearchResults');
    els.accSearchClose = document.getElementById('accSearchClose');
    els.accUnlinkModal = document.getElementById('accUnlinkModal');
    els.accUnlinkRegion = document.getElementById('accUnlinkRegion');
    els.accUnlinkMajor = document.getElementById('accUnlinkMajor');
    els.accUnlinkMiddle = document.getElementById('accUnlinkMiddle');
    els.accUnlinkSub = document.getElementById('accUnlinkSub');
    els.accUnlinkCancel = document.getElementById('accUnlinkCancel');
    els.accUnlinkConfirm = document.getElementById('accUnlinkConfirm');
    els.histBody = $("#histBody");
    els.histBodyOverview = $("#histBodyOverview");
    els.tasksBody = $("#tasksBody");
    els.tasksBodyOverview = $("#tasksBodyOverview");
    els.linkedAssetsBody = document.getElementById('linkedAssetsBody');
    els.linkedAssetsSummary = document.getElementById('linkedAssetsSummary');
    els.linkedAssetsSortHeaders = document.querySelectorAll('.linked-assets-page th[data-sort-key]');
    els.linkedAssetsSortButtons = document.querySelectorAll('.linked-assets-page .table-sort-button[data-sort-key]');
    els.specsBody = $("#specsBody");

    els.histDate = $("#histDate");
    els.histType = $("#histType");
    els.histDesc = $("#histDesc");
    els.histUser = $("#histUser");

    // Status buttons
    els.statusButtons = document.querySelectorAll('.status-btn');
  }

  // Rendering
  function renderAll() {
    const eq = current();
    if (!eq) return;
    // Required fields
    els.reqModel.value = eq.model;
    els.reqSerial.value = eq.serialNo;
    els.reqCode.value = eq.codeNo;
    els.reqCategory.value = eq.category;
    els.reqInstallDate.value = eq.installDate;
    els.reqCalibrationDate.value = eq.calibrationDate;
    els.reqNote.value = eq.note;
    // 위치 입력값 동기화 (eq.location -> 세 필드)
    if (els.reqLocationMajor || els.reqLocationMiddle || els.reqLocationMinor) {
      const loc = parseLocation(eq.location || "");
      if (els.reqLocationMajor) els.reqLocationMajor.value = loc.major || "";
      if (els.reqLocationMiddle) els.reqLocationMiddle.value = loc.middle || "";
      if (els.reqLocationMinor) els.reqLocationMinor.value = loc.minor || "";
    }

    // 필터 초기값 동기화
    if (els.filterType) els.filterType.value = state.filter.type; // 구버전 select 대응
    syncFilterTypeRadios(state.filter.type);
    if (els.filterPeriod) els.filterPeriod.value = state.filter.period;

    // 읽기 모드용 텍스트 라벨 업데이트
    updateRequiredFieldsView();

    renderSummary();
    renderImagePanel();
    renderStatus(eq.status);
    renderPhotos(eq.photos);
    renderSpecs(eq.specs || []);
    renderHistory(eq.history);
    renderTasks(eq.tasks);
    try { renderHistoryOverview(eq.history); } catch(_) {}
    try { renderTasksOverview(eq.tasks); } catch(_) {}
    try { renderLinkedAssetsSection(); } catch(_) {}
  }

  // 읽기 모드용 필수 필드 텍스트 라벨 업데이트
  function updateRequiredFieldsView() {
    const eq = current();
    if (!eq) return;
    
    const reqModelView = document.getElementById('reqModelView');
    const reqSerialView = document.getElementById('reqSerialView');
    const reqCodeView = document.getElementById('reqCodeView');
    const reqCategoryView = document.getElementById('reqCategoryView');
    const reqInstallDateView = document.getElementById('reqInstallDateView');
    const reqCalibrationDateView = document.getElementById('reqCalibrationDateView');
    const reqNoteView = document.getElementById('reqNoteView');
    const reqLocationMajorView = document.getElementById('reqLocationMajorView');
    const reqLocationMiddleView = document.getElementById('reqLocationMiddleView');
    const reqLocationMinorView = document.getElementById('reqLocationMinorView');
    
    if (reqModelView) reqModelView.textContent = eq.model || '-';
    if (reqSerialView) reqSerialView.textContent = eq.serialNo || '-';
    if (reqCodeView) reqCodeView.textContent = eq.codeNo || '-';
    
    // 구분 값 표시
    if (reqCategoryView) {
      const categoryValue = eq.category || '';
      reqCategoryView.textContent = categoryValue || '-';
    }
    
    // 날짜 값 표시 (YYYY-MM-DD 형식 그대로 표시)
    if (reqInstallDateView) reqInstallDateView.textContent = eq.installDate || '-';
    if (reqCalibrationDateView) reqCalibrationDateView.textContent = eq.calibrationDate || '-';
    
    if (reqNoteView) reqNoteView.textContent = eq.note || '-';
    // 위치 값 표시
    const loc = parseLocation(eq.location || "");
    if (reqLocationMajorView) reqLocationMajorView.textContent = loc.major || '-';
    if (reqLocationMiddleView) reqLocationMiddleView.textContent = loc.middle || '';
    if (reqLocationMinorView) reqLocationMinorView.textContent = loc.minor || '';
  }

  function renderPhotos(arr) {
    if (!els.photosGrid) return;
    const photos = Array.isArray(arr) ? arr.filter(Boolean) : [];
    // Read mode: show only existing photos; hide grid if none
    if (!state.edit) {
      if (photos.length === 0) {
        // innerHTML 대신 기존 자식 제거 방식 사용
        while (els.photosGrid.firstChild) {
          els.photosGrid.removeChild(els.photosGrid.firstChild);
        }
        return;
      }
    }
    // Edit mode: show existing photos + one add slot at the end (only if less than 12 photos)
    const MAX_PHOTOS = 12;
    const showAddSlot = state.edit && photos.length < MAX_PHOTOS;
    const total = showAddSlot ? photos.length + 1 : photos.length;
    // DocumentFragment 사용하여 성능 최적화
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
      const raw = photos[i];
      const isObj = raw && typeof raw === 'object';
      const url = isObj ? raw.url : raw;
      const desc = isObj ? (raw.desc || '') : '';
      const createdAt = isObj ? (raw.createdAt || '') : '';
      const createdBy = isObj ? (raw.createdBy || '') : '';
      const has = !!url;
      const ariaIndex = i + 1;
      const boxClass = has ? 'photo-box' : 'photo-box empty';
      const changeLabel = has ? '사진변경' : '＋ 사진추가';
      const div = document.createElement('div');
      div.className = boxClass;
      div.dataset.index = i;
      div.tabIndex = 0;
      div.setAttribute('aria-label', `사진 ${ariaIndex}`);
      const eq = current();
      const isRepresentative = eq && eq.representativePhoto === i;
      const metaHtml = has ? `
        <div class="photo-meta">
          <div class="meta-content">
            <div class="meta-desc">${escapeHtml(desc || '')}</div>
            <div class="meta-sub">${escapeHtml(createdAt ? (new Date(createdAt).toLocaleString() || createdAt) : '')}${createdBy ? ` · ${escapeHtml(createdBy)}` : ''}</div>
          </div>
        </div>` : '';
      div.innerHTML = `
        ${isRepresentative ? '<div class="representative-badge" title="대표사진">★</div>' : ''}
        <img alt="사진 ${ariaIndex} 미리보기" ${has ? `src="${url}"` : "hidden"} />
        ${metaHtml}
        <div class="photo-overlay">
          <button class="btn-sm" data-action="change" type="button">${changeLabel}</button>
          ${has ? '<button class="btn-sm" data-action="clear" type="button">사진제거</button>' : ''}
          ${has && state.edit ? `<button class="btn-sm" data-action="setRepresentative" type="button">${isRepresentative ? '대표사진 해제' : '대표사진설정'}</button>` : ''}
        </div>`;
      fragment.appendChild(div);
    }
    // 기존 내용 제거 후 fragment 추가
    while (els.photosGrid.firstChild) {
      els.photosGrid.removeChild(els.photosGrid.firstChild);
    }
    els.photosGrid.appendChild(fragment);
    try { renderImagePanel(); } catch(_) {}
  }

  function renderSummary() {
    const eq = current();
    if (!eq) return;
    
    // Model과 Serial No 표시
    if (els.sumModel) {
      els.sumModel.textContent = eq.model || '-';
    }
    if (els.sumSerial) {
      els.sumSerial.textContent = eq.serialNo || '-';
    }
    if (els.sumCode) {
      els.sumCode.textContent = eq.codeNo || '-';
    }
    if (els.sumLocation) {
      const loc = parseLocation(eq.location || "");
      const locationText = [loc.major, loc.middle, loc.minor].filter(Boolean).join(' / ');
      els.sumLocation.textContent = locationText || '-';
    }
    
    const inst = calcElapsed(eq.installDate);
    const calib = calcElapsed(eq.calibrationDate);
    if (els.sumInstall) {
      els.sumInstall.textContent = inst ? fmtElapsed(inst) : '-';
      els.sumInstall.classList.remove('overdue');
      // 3년(36개월) 이상이면 파란색 표시
      const milestone = inst ? inst.totalMonths >= 36 : false;
      els.sumInstall.classList.toggle('milestone', !!milestone);
    }
    if (els.sumCalib) {
      els.sumCalib.textContent = calib ? fmtElapsed(calib) : '-';
      const over = calib ? calib.totalMonths >= 18 : false;
      els.sumCalib.classList.toggle('overdue', !!over);
    }
  }

  function getRepresentativePhoto(eq) {
    if (!eq || !Array.isArray(eq.photos) || eq.photos.length === 0) {
      return { item: null, url: '', desc: '', createdAt: '', createdBy: '' };
    }
    let item = null;
    if (eq.representativePhoto !== null && eq.representativePhoto !== undefined) {
      item = eq.photos[eq.representativePhoto] || null;
    }
    if (!item) item = eq.photos[0] || null;
    if (!item) return { item: null, url: '', desc: '', createdAt: '', createdBy: '' };
    if (typeof item === 'object') {
      return {
        item,
        url: item.url || '',
        desc: item.desc || '',
        createdAt: item.createdAt || '',
        createdBy: item.createdBy || ''
      };
    }
    return {
      item,
      url: String(item),
      desc: '',
      createdAt: '',
      createdBy: ''
    };
  }

  function renderImagePanel() {
    if (!els.btnImagePreview || !els.imagePreview) return;
    const eq = current();
    const { item, url, desc, createdAt, createdBy } = getRepresentativePhoto(eq);
    const hasPhoto = !!url;
    if (hasPhoto) {
      els.imagePreview.src = url;
      els.imagePreview.removeAttribute('hidden');
      if (els.imageEmptyState) els.imageEmptyState.textContent = '';
    } else {
      els.imagePreview.removeAttribute('src');
      els.imagePreview.setAttribute('hidden', 'true');
      if (els.imageEmptyState) els.imageEmptyState.textContent = '설비사진이 없습니다. 클릭하여 추가하세요.';
    }
    if (els.imageMetaDesc) {
      els.imageMetaDesc.textContent = hasPhoto ? (desc || '대표이미지') : '대표이미지를 등록해 주세요.';
    }
    if (els.imageMetaSub) {
      const timeText = createdAt ? (new Date(createdAt).toLocaleString() || createdAt) : '';
      const metaSub = hasPhoto ? [timeText, createdBy].filter(Boolean).join(' · ') : '설비사진 탭으로 이동합니다.';
      els.imageMetaSub.textContent = metaSub || '-';
    }
    els.btnImagePreview.dataset.hasPhoto = hasPhoto ? 'true' : 'false';
    els.btnImagePreview.dataset.photoUrl = url || '';
    els.imagePreviewItem = hasPhoto ? item : null;
  }
  function calcElapsed(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    // If day-of-month not yet reached, subtract 1 month
    if (now.getDate() < d.getDate()) months -= 1;
    if (months < 0) months = 0;
    const years = Math.floor(months / 12);
    const rem = months % 12;
    return { years, months: rem, totalMonths: months };
  }
  function fmtElapsed(e) {
    return `${e.years}년 ${e.months}개월`;
  }

  function renderStatus(status) {
    if (!els.statusButtons || els.statusButtons.length === 0) return;
    const statusValue = status || '';
    els.statusButtons.forEach(btn => {
      const btnStatus = btn.getAttribute('data-status');
      const isSelected = btnStatus === statusValue;
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
  }

  function renderSpecs(rows) {
    if (!els.specsBody) return;
    // 기존 내용 제거
    while (els.specsBody.firstChild) {
      els.specsBody.removeChild(els.specsBody.firstChild);
    }
    // DocumentFragment 사용하여 성능 최적화
    const fragment = document.createDocumentFragment();
    const isEditMode = !!state.edit;
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      if (isEditMode) {
        // 편집 모드: input 사용
        tr.innerHTML = `
          <td><input type="text" value="${escapeHtml(r.key || "")}" aria-label="사양 키" /></td>
          <td><input type="text" value="${escapeHtml(r.value || "")}" aria-label="사양 값" /></td>
          <td class="table-actions">
            <button class="btn-sm" data-action="del">삭제</button>
          </td>
        `;
      } else {
        // 읽기 모드: 텍스트만 표시 (완전 읽기 전용 뷰)
        tr.innerHTML = `
          <td>${escapeHtml(r.key || "")}</td>
          <td>${escapeHtml(r.value || "")}</td>
          <td></td>
        `;
      }
      fragment.appendChild(tr);
    });
    els.specsBody.appendChild(fragment);
  }

  function updateAccessoriesHeaderSort() {
    const thead = document.querySelector('.panel-accessories thead tr, .accessories-page thead tr');
    if (!thead) return;
    const headers = thead.querySelectorAll('th');
    const columnMap = ['구분', '자산코드', '이름', '코드', '시리얼번호', '비고'];
    headers.forEach((th, idx) => {
      let text = th.textContent.trim();
      // 화살표 제거
      text = text.replace(/[↑↓]\s*$/, '').trim();
      const columnIndex = columnMap.findIndex(col => text.includes(col));
      if (columnIndex === -1) return;
      const columns = ['category', 'assetCode', 'name', 'code', 'serial', 'note'];
      const column = columns[columnIndex];
      if (!column) return;
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      const { column: currentColumn, direction } = state.accessoriesSort;
      if (currentColumn === column) {
        th.setAttribute('data-sort', direction);
        th.innerHTML = `${text} ${direction === 'asc' ? '↑' : '↓'}`;
      } else {
        th.setAttribute('data-sort', '');
        th.textContent = text;
      }
    });
  }

  function renderAccessories(rows) {
    // 헤더가 제대로 있는지 확인
    try { ensureAccessoriesCategoryHeader(); } catch(_) {}
    try { ensureAccessoriesAssetCodeHeader(); } catch(_) {}
    try { ensureAccessoriesSerialHeader(); } catch(_) {}
    // 기존 내용 제거
    while (els.accBody.firstChild) {
      els.accBody.removeChild(els.accBody.firstChild);
    }
    // 정렬 적용
    const sorted = [...rows].sort((a, b) => {
      const { column, direction } = state.accessoriesSort;
      if (!column) return 0;
      let av, bv;
      switch (column) {
        case 'category':
          av = (a.category || "");
          bv = (b.category || "");
          break;
        case 'assetCode':
          av = (a.assetCode || "");
          bv = (b.assetCode || "");
          break;
        case 'name':
          av = (a.name || "");
          bv = (b.name || "");
          break;
        case 'code':
          av = (a.code || "");
          bv = (b.code || "");
          break;
        case 'serial':
          av = (a.serial || "");
          bv = (b.serial || "");
          break;
        case 'note':
          av = (a.note || "");
          bv = (b.note || "");
          break;
        default:
          return 0;
      }
      let result;
      if (typeof av === 'number' && typeof bv === 'number') {
        result = av - bv;
      } else {
        result = String(av).localeCompare(String(bv), 'ko');
      }
      return direction === 'asc' ? result : -result;
    });
    // DocumentFragment 사용하여 성능 최적화
    const fragment = document.createDocumentFragment();
    const isEditMode = !!state.edit;
    sorted.forEach((r) => {
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      const isLinked = !!r.assetNo; // 자산과 연결된 행
      if (isEditMode) {
        if (isLinked) {
          const mkc = r.assetCode || '';
          const name = r.name || '';
          const codeNo = r.code || '';
          const serial = r.serial || '';
          const note = r.note || '';
          const category = r.category || '';
          tr.innerHTML = `
            <td>${escapeHtml(category)}</td>
            <td>${escapeHtml(mkc)}</td>
            <td>${escapeHtml(name)}</td>
            <td>${escapeHtml(codeNo)}</td>
            <td>${escapeHtml(serial)}</td>
            <td><input type="text" value="${escapeHtml(note)}" aria-label="부속품 비고" /></td>
            <td class="table-actions"><button class="btn-sm" data-action="unlink" type="button">해제</button></td>
          `;
        } else {
          // 레거시 혹은 수동 항목 유지
          tr.innerHTML = `
            <td>
              <select aria-label="부속품 구분">
                <option value="">선택</option>
                <option value="케이블" ${r.category === '케이블' ? 'selected' : ''}>케이블</option>
                <option value="옵션사양" ${r.category === '옵션사양' ? 'selected' : ''}>옵션사양</option>
              </select>
            </td>
            <td><input type="text" value="${escapeHtml(r.assetCode || "")}" aria-label="부속품 자산코드" /></td>
            <td><input type="text" value="${escapeHtml(r.name || "")}" aria-label="부속품 이름" /></td>
            <td><input type="text" value="${escapeHtml(r.code || "")}" aria-label="부속품 코드" /></td>
            <td><input type="text" value="${escapeHtml(r.serial || "")}" aria-label="부속품 시리얼번호" /></td>
            <td><input type="text" value="${escapeHtml(r.note || "")}" aria-label="부속품 비고" /></td>
            <td class="table-actions"></td>
          `;
        }
      } else {
        const categoryLabel = r.category === '케이블' ? '케이블' : r.category === '옵션사양' ? '옵션사양' : (r.category || '');
        tr.innerHTML = `
          <td>${escapeHtml(categoryLabel)}</td>
          <td>${escapeHtml(r.assetCode || "")}</td>
          <td>${escapeHtml(r.name || "")}</td>
          <td>${escapeHtml(r.code || "")}</td>
          <td>${escapeHtml(r.serial || "")}</td>
          <td>${escapeHtml(r.note || "")}</td>
          <td class="table-actions">${isLinked ? '<button class="btn-sm" data-action="unlink" type="button">해제</button>' : ''}</td>
        `;
      }
      fragment.appendChild(tr);
    });
    els.accBody.appendChild(fragment);
    updateAccessoriesHeaderSort();
  }

  // 다음 점검일 계산 함수
  function calculateNextCheck(lastCheck, periodYear, periodMonth, periodDay) {
    if (!lastCheck) return '';
    const lastDate = new Date(lastCheck);
    if (isNaN(lastDate.getTime())) return '';
    
    const year = Number(periodYear) || 0;
    const month = Number(periodMonth) || 0;
    const day = Number(periodDay) || 0;
    
    // 모든 주기가 0이면 계산 불가
    if (year === 0 && month === 0 && day === 0) return '';
    
    const nextDate = new Date(lastDate);
    if (year > 0) nextDate.setFullYear(nextDate.getFullYear() + year);
    if (month > 0) nextDate.setMonth(nextDate.getMonth() + month);
    if (day > 0) nextDate.setDate(nextDate.getDate() + day);
    
    return nextDate.toISOString().slice(0, 10);
  }

  function renderTasks(rows) {
    if (!els.tasksBody) return;
    // 기존 내용 제거
    while (els.tasksBody.firstChild) {
      els.tasksBody.removeChild(els.tasksBody.firstChild);
    }
    // DocumentFragment 사용하여 성능 최적화
    const fragment = document.createDocumentFragment();
    const isEditMode = !!state.edit;
    rows.forEach((r) => {
      // 기존 데이터 마이그레이션: period, cycleUnit이 있으면 새로운 형식으로 변환
      let periodYear = r.periodYear !== undefined ? Number(r.periodYear) : 0;
      let periodMonth = r.periodMonth !== undefined ? Number(r.periodMonth) : 0;
      let periodDay = r.periodDay !== undefined ? Number(r.periodDay) : 0;
      
      // 마이그레이션: 기존 period, cycleUnit이 있으면 변환
      if (r.period && r.cycleUnit && periodYear === 0 && periodMonth === 0 && periodDay === 0) {
        const period = Number(r.period) || 0;
        switch (r.cycleUnit) {
          case 'day':
            periodDay = period;
            break;
          case 'week':
            periodDay = period * 7;
            break;
          case 'month':
            periodMonth = period;
            break;
          case 'year':
            periodYear = period;
            break;
        }
        // 마이그레이션한 값을 row 객체에 저장
        r.periodYear = periodYear;
        r.periodMonth = periodMonth;
        r.periodDay = periodDay;
        // 기존 필드 제거 (선택사항)
        try { delete r.period; delete r.cycleUnit; } catch(_) {}
      }
      
      // 다음 점검일 계산
      const nextCheck = r.nextCheck || calculateNextCheck(r.lastCheck, periodYear, periodMonth, periodDay);
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      
      // 다음 점검일이 지났는지 확인 (경고 표시용)
      const isOverdue = nextCheck && new Date(nextCheck) < new Date();
      
      if (isEditMode) {
        // 편집 모드: input 사용
        tr.innerHTML = `
          <td><input type="text" value="${escapeHtml(r.title || "")}" aria-label="작업명" /></td>
          <td><input type="text" value="${escapeHtml(r.note || "")}" aria-label="비고" /></td>
          <td><input type="number" min="0" step="1" value="${periodYear}" aria-label="주기(년)" /></td>
          <td><input type="number" min="0" step="1" value="${periodMonth}" aria-label="주기(월)" /></td>
          <td><input type="number" min="0" step="1" value="${periodDay}" aria-label="주기(일)" /></td>
          <td><input type="date" value="${escapeHtml(r.lastCheck || "")}" aria-label="마지막 점검일" /></td>
          <td class="${isOverdue ? 'overdue' : ''}">${escapeHtml(nextCheck || '-')}</td>
          <td class="table-actions">
            <button class="btn-sm" data-action="check" type="button">점검완료</button>
            <button class="btn-sm" data-action="del" type="button">삭제</button>
          </td>
        `;
      } else {
        // 읽기 모드: 텍스트만 표시
        const periodText = [];
        if (periodYear > 0) periodText.push(`${periodYear}년`);
        if (periodMonth > 0) periodText.push(`${periodMonth}월`);
        if (periodDay > 0) periodText.push(`${periodDay}일`);
        const periodDisplay = periodText.length > 0 ? periodText.join(' ') : '-';
        
        tr.innerHTML = `
          <td>${escapeHtml(r.title || "")}</td>
          <td>${escapeHtml(r.note || "")}</td>
          <td>${escapeHtml(String(periodYear))}</td>
          <td>${escapeHtml(String(periodMonth))}</td>
          <td>${escapeHtml(String(periodDay))}</td>
          <td>${escapeHtml(r.lastCheck || "-")}</td>
          <td class="${isOverdue ? 'overdue' : ''}">${escapeHtml(nextCheck || "-")}</td>
          <td></td>
        `;
      }
      fragment.appendChild(tr);
    });
    els.tasksBody.appendChild(fragment);
  }

  function updateHistoryHeaderSort() {
    const headRows = document.querySelectorAll('table.history-table thead tr');
    if (!headRows || headRows.length === 0) return;
    const columnMap = ['날짜', '유형', '내용', '작성자'];
    headRows.forEach((thead) => {
      const headers = thead.querySelectorAll('th');
      headers.forEach((th) => {
        let text = th.textContent.trim();
        text = text.replace(/[↑↓]\s*$/, '').trim();
        const columnIndex = columnMap.findIndex(col => text.includes(col));
        if (columnIndex === -1) return;
        const columns = ['date', 'type', 'desc', 'user'];
        const column = columns[columnIndex];
        if (!column) return;
        th.style.cursor = 'pointer';
        th.style.userSelect = 'none';
        const { column: currentColumn, direction } = state.historySort;
        if (currentColumn === column) {
          th.setAttribute('data-sort', direction);
          th.innerHTML = `${text} ${direction === 'asc' ? '↑' : '↓'}`;
        } else {
          th.setAttribute('data-sort', '');
          th.textContent = text;
        }
      });
    });
  }

  // users 컬렉션 전체를 로드하여 캐시에 저장하는 함수
  let usersLoadingPromise = null;
  async function loadUsersCache() {
    // 인증이 완료되지 않았으면 대기
    if (!window.currentUser) {
      await waitForAuth();
    }
    
    // 권한 오류가 발생했으면 더 이상 시도하지 않음
    if (!usersAccessAllowed) {
      return Promise.resolve();
    }
    
    // 이미 로딩 중이면 기존 Promise 반환
    if (usersLoadingPromise) {
      return usersLoadingPromise;
    }
    
    // 이전 로딩이 실패했으면 재시도하지 않음
    if (usersCache.has('__load_failed__')) {
      return Promise.resolve();
    }
    
    // 캐시가 이미 채워져 있으면 스킵 (실패 플래그가 아닌 실제 데이터가 있는 경우)
    if (usersCache.size > 0 && !usersCache.has('__load_failed__')) {
      return Promise.resolve();
    }
    
    const db = window.firebaseDb;
    if (!db || !window.firebaseLite) {
      return Promise.resolve();
    }
    
    // 인증 확인 (추가 안전장치)
    if (!window.currentUser) {
      console.debug('User not authenticated, skipping users cache load');
      usersCache.set('__load_failed__', true);
      return Promise.resolve();
    }
    
    usersLoadingPromise = (async () => {
      try {
        console.log('[Users Cache] 시작: users 컬렉션에서 데이터 로드 시작');
        console.log('[Users Cache] 인증 상태:', window.currentUser ? `인증됨 (${window.currentUser.email})` : '인증 안됨');
        
        const { collection, getDocs } = window.firebaseLite;
        const usersCollection = collection(db, 'users');
        console.log('[Users Cache] Firestore 쿼리 실행: users 컬렉션 조회');
        
        const snapshot = await getDocs(usersCollection);
        console.log('[Users Cache] 쿼리 완료: 문서 개수 =', snapshot.size);
        
        let loadedCount = 0;
        snapshot.forEach((docSnap) => {
          const userData = docSnap.data();
          const docId = docSnap.id;
          console.log(`[Users Cache] 문서 ${docId} 처리:`, userData);
          
          // 각 문서가 직접 mail과 name을 가지는 경우 (스크린샷 구조)
          if (userData && userData.mail && userData.name) {
            // mail 값을 정규화하여 저장 (소문자, 공백 제거)
            const normalizedMail = String(userData.mail).trim().toLowerCase();
            usersCache.set(normalizedMail, userData.name);
            // name -> email 역방향 매핑도 저장 (기존 데이터 호환성)
            nameToEmailCache.set(userData.name, normalizedMail);
            console.log(`[Users Cache] 사용자 추가: ${userData.mail} -> ${userData.name} (정규화: ${normalizedMail})`);
            // 원본 mail 값도 저장 (대소문자 구분이 필요한 경우 대비)
            if (normalizedMail !== userData.mail) {
              usersCache.set(userData.mail, userData.name);
              console.log(`[Users Cache] 원본 mail도 저장: ${userData.mail} -> ${userData.name}`);
            }
            loadedCount++;
          }
          // users 컬렉션이 배열 구조인 경우 처리 (문서 내부에 배열이 있는 경우)
          else if (Array.isArray(userData)) {
            console.log(`[Users Cache] 문서 ${docId}는 배열 구조입니다.`);
            userData.forEach((user) => {
              if (user && user.mail && user.name) {
                const normalizedMail = String(user.mail).trim().toLowerCase();
                usersCache.set(normalizedMail, user.name);
                console.log(`[Users Cache] 배열에서 사용자 추가: ${user.mail} -> ${user.name}`);
                if (normalizedMail !== user.mail) {
                  usersCache.set(user.mail, user.name);
                }
                loadedCount++;
              }
            });
          }
          // 문서 내부에 배열 필드가 있는 경우 (예: users 필드)
          else if (userData.users && Array.isArray(userData.users)) {
            console.log(`[Users Cache] 문서 ${docId}에 users 배열 필드가 있습니다.`);
            userData.users.forEach((user) => {
              if (user && user.mail && user.name) {
                const normalizedMail = String(user.mail).trim().toLowerCase();
                usersCache.set(normalizedMail, user.name);
                console.log(`[Users Cache] users 필드에서 사용자 추가: ${user.mail} -> ${user.name}`);
                if (normalizedMail !== user.mail) {
                  usersCache.set(user.mail, user.name);
                }
                loadedCount++;
              }
            });
          } else {
            console.warn(`[Users Cache] 문서 ${docId}의 구조를 인식할 수 없습니다:`, userData);
          }
        });
        
        console.log(`[Users Cache] 완료: ${loadedCount}명의 사용자를 캐시에 로드했습니다 (캐시 크기: ${usersCache.size})`);
        console.log('[Users Cache] 캐시 내용:', Array.from(usersCache.entries()));
      } catch (error) {
        console.error('[Users Cache] 오류 발생:', error);
        console.error('[Users Cache] 오류 코드:', error.code);
        console.error('[Users Cache] 오류 메시지:', error.message);
        
        // 권한 오류는 조용히 처리 (email을 그대로 표시하는 fallback이 있음)
        if (error.code === 'permission-denied' || error.code === 'PERMISSION_DENIED' || 
            (error.message && error.message.includes('permission')) ||
            (error.message && error.message.includes('Missing or insufficient permissions'))) {
          // 권한 오류 발생 시 더 이상 users 컬렉션 접근 시도하지 않음
          console.warn('[Users Cache] 권한 오류: users 컬렉션 접근 권한이 없습니다. email을 그대로 표시합니다.');
          usersAccessAllowed = false;
          usersCache.set('__load_failed__', true);
        } else {
          console.warn('[Users Cache] 로드 실패:', error);
          usersCache.set('__load_failed__', true);
        }
      } finally {
        usersLoadingPromise = null;
      }
    })();
    
    return usersLoadingPromise;
  }

  // users 컬렉션에서 email로 name을 조회하는 함수
  async function getUserNameByEmail(email) {
    if (!email) return email || '';
    
    // 캐시에 있으면 즉시 반환
    if (usersCache.has(email)) {
      return usersCache.get(email);
    }
    
    // 캐시가 비어있으면 users 컬렉션 로드
    await loadUsersCache();
    
    // 다시 캐시 확인
    if (usersCache.has(email)) {
      return usersCache.get(email);
    }
    
    // 여전히 없으면 email 반환
    return email;
  }

  // 여러 email을 한 번에 name으로 변환하는 함수
  async function getUserNamesByEmails(emails) {
    if (!emails || !Array.isArray(emails)) {
      console.log('[Users Cache] getUserNamesByEmails: 잘못된 입력 (emails가 배열이 아님)');
      return {};
    }
    
    console.log('[Users Cache] getUserNamesByEmails 호출: 요청된 emails =', emails);
    const result = {};
    
    // 캐시가 비어있고 실패 플래그가 없으면 users 컬렉션 로드 시도
    if (usersCache.size === 0 || (usersCache.size === 1 && usersCache.has('__load_failed__'))) {
      console.log('[Users Cache] 캐시가 비어있어서 로드 시도');
      await loadUsersCache();
    }
    
    // 로딩 실패 플래그가 있으면 모든 email을 그대로 반환
    if (usersCache.has('__load_failed__')) {
      console.log('[Users Cache] 로딩 실패 플래그가 있어서 email을 그대로 반환');
      emails.forEach(email => {
        if (email) {
          result[email] = email;
        }
      });
      console.log('[Users Cache] 반환 결과 (실패):', result);
      return result;
    }
    
    console.log('[Users Cache] 현재 캐시 상태:', Array.from(usersCache.entries()));
    
    // 캐시에서 조회 (정규화된 email로도 검색)
    emails.forEach(email => {
      if (email) {
        // 원본 email로 먼저 검색
        if (usersCache.has(email)) {
          result[email] = usersCache.get(email);
          console.log(`[Users Cache] 매칭 성공 (원본): ${email} -> ${result[email]}`);
        } else {
          // 정규화된 email로 검색 시도
          const normalizedEmail = String(email).trim().toLowerCase();
          if (usersCache.has(normalizedEmail)) {
            result[email] = usersCache.get(normalizedEmail);
            console.log(`[Users Cache] 매칭 성공 (정규화): ${email} -> ${result[email]} (정규화: ${normalizedEmail})`);
          } else {
            // 캐시에 없으면 email 그대로 사용
            result[email] = email;
            console.log(`[Users Cache] 매칭 실패: ${email} (캐시에 없음, email 그대로 사용)`);
          }
        }
      }
    });
    
    console.log('[Users Cache] 최종 반환 결과:', result);
    return result;
  }

  function renderHistory(rows) {
    // 기존 내용 제거
    while (els.histBody.firstChild) {
      els.histBody.removeChild(els.histBody.firstChild);
    }
    const { type, period } = state.filter;
    
    // 먼저 유형 필터 적용 (그룹 필터 지원)
    const groups = {
      trouble: new Set(['error','hardware_failure','software_bug','damage']),
      io: new Set(['inbound','outbound','clamp']),
      service: new Set(['calibration','repair','inspection','option_change'])
    };
    let filtered = rows.filter((r) => {
      if (type === 'all') return true;
      const set = groups[type];
      if (set) return set.has(r.type);
      // fallback: 단일 타입 문자열 지원
      return r.type === type;
    });
    
    // 기간 필터 적용
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (period === "recent1month") {
      const oneMonthAgo = new Date(today);
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      filtered = filtered.filter((r) => {
        const rDate = new Date(r.date);
        rDate.setHours(0, 0, 0, 0);
        return rDate >= oneMonthAgo;
      });
    } else if (period === "recent1year") {
      const oneYearAgo = new Date(today);
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      filtered = filtered.filter((r) => {
        const rDate = new Date(r.date);
        rDate.setHours(0, 0, 0, 0);
        return rDate >= oneYearAgo;
      });
    }
    // period === "all" 또는 "recent5"는 여기서 필터링하지 않음 (recent5는 정렬 후 처리)
    
    // 정렬 적용
    const sorted = [...filtered].sort((a, b) => {
      const { column, direction } = state.historySort;
      if (!column) return 0;
      let av, bv;
      switch (column) {
        case 'date':
          av = a.date || "";
          bv = b.date || "";
          break;
        case 'type':
          av = a.type || "";
          bv = b.type || "";
          break;
        case 'desc':
          av = (a.desc || "");
          bv = (b.desc || "");
          break;
        case 'user':
          av = (a.user || "");
          bv = (b.user || "");
          break;
        default:
          return 0;
      }
      let result;
      if (column === 'date') {
        result = av < bv ? -1 : av > bv ? 1 : 0;
      } else {
        result = String(av).localeCompare(String(bv), 'ko');
      }
      return direction === 'asc' ? result : -result;
    });
    
    // 최근 5개 필터 적용 (정렬 후 상위 5개만)
    const finalData = period === "recent5" ? sorted.slice(0, 5) : sorted;
    
    const typeLabel = (t) => {
      const labels = {
        'error': '에러발생',
        'hardware_failure': '하드웨어 고장',
        'software_bug': '소프트웨어 버그',
        'damage': '파손',
        'inbound': '입고',
        'outbound': '출고',
        'clamp': '클램프',
        'calibration': '정도검사',
        'repair': '수리',
        'inspection': '점검',
        'option_change': '옵션변경'
      };
      return labels[t] || '알 수 없음';
    };
    // 이력 데이터에는 name이 저장되어 있으므로 그대로 표시
    // (기존 데이터 호환성: email이 저장된 경우도 처리)
    const fragment = document.createDocumentFragment();
    finalData.forEach((r) => {
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      let userName = r.user || "";
      
      // email 형식이면 users 컬렉션에서 name을 찾아서 표시
      if (userName && userName.includes('@')) {
        // 비동기로 name을 찾지만, 일단 email을 표시하고 나중에 업데이트
        getUserNameByEmail(userName).then(name => {
          if (name && name !== userName) {
            const cell = tr.querySelector('td:last-child');
            if (cell) {
              cell.textContent = name;
            }
          }
        });
      }
      
      tr.innerHTML = `
        <td>${escapeHtml(r.date)}</td>
        <td>${escapeHtml(typeLabel(r.type))}</td>
        <td>${escapeHtml(r.desc || "")}</td>
        <td>${escapeHtml(userName)}</td>
      `;
      // 편집 모드일 때만 클릭 이벤트 추가
      if (state.edit) {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => {
          openHistModal(r.id);
        });
      }
      fragment.appendChild(tr);
    });
    if (els.histBody) els.histBody.appendChild(fragment);
    updateHistoryHeaderSort();
    try { renderHistoryOverview(rows); } catch(_) {}
    // applyMode() 호출 제거: 순환 호출 방지 (applyMode에서 이미 renderHistory를 호출함)
    // 읽기/편집 모드 전환은 applyMode()에서만 처리
  }

  // Overview 패널: 최근 5개 고정 렌더 (정렬기능 제거, 날짜 내림차순 고정)
  function renderHistoryOverview(rows) {
    if (!els.histBodyOverview) return;
    while (els.histBodyOverview.firstChild) {
      els.histBodyOverview.removeChild(els.histBodyOverview.firstChild);
    }
    // 날짜 기준 최신순으로만 정렬
    const sorted = [...rows].sort((a, b) => {
      const av = a.date || '';
      const bv = b.date || '';
      return av < bv ? 1 : av > bv ? -1 : 0;
    }).slice(0, 5);
    const fragment = document.createDocumentFragment();
    const typeLabel = (t) => {
      const labels = { 'error':'에러발생','hardware_failure':'하드웨어 고장','software_bug':'소프트웨어 버그','damage':'파손','inbound':'입고','outbound':'출고','clamp':'클램프','calibration':'정도검사','repair':'수리','inspection':'점검','option_change':'옵션변경' };
      return labels[t] || '알 수 없음';
    };
    // 이력 데이터에는 name이 저장되어 있으므로 그대로 표시
    // (기존 데이터 호환성: email이 저장된 경우도 처리)
    sorted.forEach((r) => {
      const tr = document.createElement('tr');
      tr.dataset.id = r.id;
      let userName = r.user || "";
      
      // email 형식이면 users 컬렉션에서 name을 찾아서 표시
      if (userName && userName.includes('@')) {
        // 비동기로 name을 찾지만, 일단 email을 표시하고 나중에 업데이트
        getUserNameByEmail(userName).then(name => {
          if (name && name !== userName) {
            const cell = tr.querySelector('td:last-child');
            if (cell) {
              cell.textContent = name;
            }
          }
        });
      }
      
      tr.innerHTML = `
        <td>${escapeHtml(r.date)}</td>
        <td>${escapeHtml(r.desc || "")}</td>
        <td>${escapeHtml(userName)}</td>
      `;
      fragment.appendChild(tr);
    });
    els.histBodyOverview.appendChild(fragment);
  }

  // 주기를 일수로 변환하는 함수
  function periodToDays(periodYear, periodMonth, periodDay) {
    const year = Number(periodYear) || 0;
    const month = Number(periodMonth) || 0;
    const day = Number(periodDay) || 0;
    
    // 대략적인 계산: 1년 = 365일, 1개월 = 30일
    return (year * 365) + (month * 30) + day;
  }

  // D-Day 계산 함수 (다음 점검일까지 남은 일수)
  function calculateDDay(nextCheckDate) {
    if (!nextCheckDate) return null;
    const nextDate = new Date(nextCheckDate);
    if (isNaN(nextDate.getTime())) return null;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    nextDate.setHours(0, 0, 0, 0);
    
    const diffTime = nextDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays;
  }

  // Overview 패널: 예정된 작업 렌더링 (D-Day 기준 정렬)
  function renderTasksOverview(rows) {
    if (!els.tasksBodyOverview) return;
    while (els.tasksBodyOverview.firstChild) {
      els.tasksBodyOverview.removeChild(els.tasksBodyOverview.firstChild);
    }
    
    // 다음 점검일이 있는 작업만 필터링
    const validTasks = rows.filter(r => {
      // 마이그레이션 처리
      let periodYear = r.periodYear !== undefined ? Number(r.periodYear) : 0;
      let periodMonth = r.periodMonth !== undefined ? Number(r.periodMonth) : 0;
      let periodDay = r.periodDay !== undefined ? Number(r.periodDay) : 0;
      
      if (r.period && r.cycleUnit && periodYear === 0 && periodMonth === 0 && periodDay === 0) {
        const period = Number(r.period) || 0;
        switch (r.cycleUnit) {
          case 'day': periodDay = period; break;
          case 'week': periodDay = period * 7; break;
          case 'month': periodMonth = period; break;
          case 'year': periodYear = period; break;
        }
      }
      
      const nextCheck = r.nextCheck || calculateNextCheck(r.lastCheck, periodYear, periodMonth, periodDay);
      return nextCheck && nextCheck.trim() !== '';
    });
    
    // D-Day 계산 및 정렬
    const tasksWithDDay = validTasks.map(r => {
      // 마이그레이션 처리
      let periodYear = r.periodYear !== undefined ? Number(r.periodYear) : 0;
      let periodMonth = r.periodMonth !== undefined ? Number(r.periodMonth) : 0;
      let periodDay = r.periodDay !== undefined ? Number(r.periodDay) : 0;
      
      if (r.period && r.cycleUnit && periodYear === 0 && periodMonth === 0 && periodDay === 0) {
        const period = Number(r.period) || 0;
        switch (r.cycleUnit) {
          case 'day': periodDay = period; break;
          case 'week': periodDay = period * 7; break;
          case 'month': periodMonth = period; break;
          case 'year': periodYear = period; break;
        }
      }
      
      const nextCheck = r.nextCheck || calculateNextCheck(r.lastCheck, periodYear, periodMonth, periodDay);
      const dDay = calculateDDay(nextCheck);
      const periodDays = periodToDays(periodYear, periodMonth, periodDay);
      
      // 주기 대비 남은기간 비율 계산
      let remainingRatio = 1.0;
      if (periodDays > 0 && dDay !== null) {
        // 남은 일수가 주기보다 크면 이미 지난 것
        if (dDay < 0) {
          remainingRatio = 0;
        } else {
          remainingRatio = dDay / periodDays;
        }
      }
      
      return {
        ...r,
        nextCheck,
        dDay,
        periodDays,
        remainingRatio
      };
    });
    
    // D-Day 가까운 순으로 정렬 (음수는 뒤로, 양수는 작은 수부터)
    tasksWithDDay.sort((a, b) => {
      if (a.dDay === null && b.dDay === null) return 0;
      if (a.dDay === null) return 1;
      if (b.dDay === null) return -1;
      return a.dDay - b.dDay;
    });
    
    const fragment = document.createDocumentFragment();
    tasksWithDDay.forEach((r) => {
      const tr = document.createElement('tr');
      
      // D-Day 표시 형식
      let dDayText = '-';
      if (r.dDay !== null) {
        if (r.dDay < 0) {
          dDayText = `D+${Math.abs(r.dDay)}`;
        } else if (r.dDay === 0) {
          dDayText = 'D-Day';
        } else {
          dDayText = `D-${r.dDay}`;
        }
      }
      
      // 주기 대비 남은기간이 15% 이하이면 빨간색 표시
      const isUrgent = r.remainingRatio <= 0.15 && r.dDay !== null && r.dDay >= 0;
      
      tr.innerHTML = `
        <td>${escapeHtml(r.title || "")}</td>
        <td>${escapeHtml(r.nextCheck || "-")}</td>
        <td class="${isUrgent ? 'urgent' : ''}">${escapeHtml(dDayText)}</td>
      `;
      fragment.appendChild(tr);
    });
    els.tasksBodyOverview.appendChild(fragment);
  }

  function formatAssetLocation(loc) {
    if (!loc) return '-';
    const segments = [
      loc.region || '',
      loc.major || '',
      loc.middle || '',
      loc.sub || ''
    ].map(part => (part || '').trim()).filter(Boolean);
    return segments.length ? segments.join(' / ') : '-';
  }

  function getAssetStatusLabel(status) {
    const labels = {
      normal: '정상',
      damage: '파손',
      fault: '고장',
      outbound: '반출',
      sold: '판매됨'
    };
    return labels[status] || (status ? status : '-');
  }

  function getLinkedAssetsBySerial(serialNo) {
    const normalized = normalizeSerial(serialNo);
    if (!normalized || !Array.isArray(state.accAssetsCache)) return [];
    return state.accAssetsCache.filter(asset => {
      const linkedSerial = asset?.linkedEquipment?.serialNo;
      return normalizeSerial(linkedSerial) === normalized;
    });
  }

  // 설비 위치 변경 시 연결자산 위치도 동기화
  async function updateLinkedAssetsLocation(equipmentSerialNo, newLocation) {
    if (!equipmentSerialNo || !newLocation) return 0;
    
    const lite = (window && window.firebaseLite) || null;
    const db = (window && window.firebaseDb) || null;
    if (!lite || !db) {
      console.warn('Firebase가 초기화되지 않아 연결자산 위치를 업데이트할 수 없습니다.');
      return 0;
    }

    // 연결된 자산 찾기
    const linkedAssets = getLinkedAssetsBySerial(equipmentSerialNo);
    if (!linkedAssets.length) return 0;

    // 위치 파싱 (설비 location은 "지역/중분류/소분류" 형식)
    // buildLocation(major, middle, minor)에서:
    // - major = 지역 (시흥, 부산, 대구, 대전)
    // - middle = 중분류
    // - minor = 소분류
    const parsed = parseLocation(newLocation);
    // 자산의 location 구조는 { region, major, middle, sub }이므로:
    // - region = parsed.major (지역)
    // - major = parsed.middle (설비의 중분류가 자산의 대분류로 사용됨)
    // - middle = parsed.minor (설비의 소분류가 자산의 중분류로 사용됨)
    const region = parsed.major || '';
    const major = parsed.middle || '';
    const middle = parsed.minor || '';

    // 설비 모델명 가져오기 (소분류에 사용)
    const eq = current();
    const model = eq?.model || '';

    // 연결자산 위치 업데이트
    const assetsCol = lite.collection(db, 'assets');
    let updatedCount = 0;

    try {
      for (const asset of linkedAssets) {
        const assetRef = lite.doc(assetsCol, asset.assetNo);
        const updatedLocation = {
          region: region,
          major: major,
          middle: middle,
          sub: model ? `'${model}' 에 설치` : (asset.location?.sub || '')
        };
        
        // Firestore 업데이트 (merge: true로 기존 데이터 유지)
        await lite.setDoc(assetRef, {
          location: updatedLocation
        }, { merge: true });
        
        // 캐시도 업데이트
        if (Array.isArray(state.accAssetsCache)) {
          const cacheIndex = state.accAssetsCache.findIndex(a => a.assetNo === asset.assetNo);
          if (cacheIndex >= 0) {
            state.accAssetsCache[cacheIndex].location = updatedLocation;
          }
        }
        
        updatedCount++;
      }
    } catch (err) {
      console.error('연결자산 위치 업데이트 실패:', err);
      throw err;
    }

    return updatedCount;
  }

  function getLinkedAssetSortValue(asset, column) {
    switch (column) {
      case 'assetType':
        return (asset.assetType || '').toLowerCase();
      case 'assetNo':
        return String(asset.assetNo || '');
      case 'assetCode':
        return (asset.mkcCode || asset.codeNo || '').toLowerCase();
      case 'status':
        return getAssetStatusLabel(asset.status).toLowerCase();
      case 'location': {
        const loc = formatAssetLocation(asset.location);
        return loc === '-' ? '' : loc.toLowerCase();
      }
      case 'name':
      default:
        return (asset.name || '').toLowerCase();
    }
  }

  function sortLinkedAssets(list) {
    if (!Array.isArray(list)) return [];
    const sort = state.linkedAssetsSort || { column: 'name', direction: 'asc' };
    const direction = sort.direction === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const valA = getLinkedAssetSortValue(a, sort.column);
      const valB = getLinkedAssetSortValue(b, sort.column);
      const localeOptions = sort.column === 'assetNo'
        ? { numeric: true, sensitivity: 'base' }
        : { sensitivity: 'base' };
      let cmp = valA.localeCompare(valB, 'ko', localeOptions);
      if (cmp === 0) {
        const fallbackA = String(a.assetNo || '');
        const fallbackB = String(b.assetNo || '');
        cmp = fallbackA.localeCompare(fallbackB, 'ko', { numeric: true, sensitivity: 'base' });
      }
      return cmp * direction;
    });
  }

  function updateLinkedAssetsSortIndicators() {
    if (!els.linkedAssetsSortHeaders || !els.linkedAssetsSortHeaders.length) return;
    const sort = state.linkedAssetsSort || { column: 'name', direction: 'asc' };
    els.linkedAssetsSortHeaders.forEach((th) => {
      const key = th.dataset.sortKey;
      const isActive = key === sort.column;
      const ariaSort = isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
      th.setAttribute('aria-sort', ariaSort);
      const btn = th.querySelector('.table-sort-button');
      if (btn) {
        btn.setAttribute('data-sort-direction', isActive ? sort.direction : 'none');
      }
    });
  }

  function applyLinkedAssetsSort(column) {
    if (!column) return;
    const sort = state.linkedAssetsSort || (state.linkedAssetsSort = { column: 'name', direction: 'asc' });
    if (sort.column === column) {
      sort.direction = sort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      sort.column = column;
      sort.direction = 'asc';
    }
    renderLinkedAssetsTable();
    updateLinkedAssetsSortIndicators();
  }

  function setupLinkedAssetsSortControls() {
    if (!els.linkedAssetsSortButtons || !els.linkedAssetsSortButtons.length) {
      updateLinkedAssetsSortIndicators();
      return;
    }
    els.linkedAssetsSortButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sortKey;
        applyLinkedAssetsSort(key);
      });
    });
    updateLinkedAssetsSortIndicators();
  }

  function setLinkedAssetsEmptyRow(message) {
    if (!els.linkedAssetsBody) return;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'empty';
    td.textContent = message;
    tr.appendChild(td);
    els.linkedAssetsBody.appendChild(tr);
  }

  function renderLinkedAssetsTable() {
    const body = els.linkedAssetsBody;
    const summary = els.linkedAssetsSummary;
    updateLinkedAssetsSortIndicators();
    if (!body && !summary) return;
    if (body) {
      while (body.firstChild) body.removeChild(body.firstChild);
    }
    const eq = current();
    if (!eq) {
      if (summary) summary.textContent = '설비가 선택되지 않았습니다.';
      if (body) setLinkedAssetsEmptyRow('표시할 설비를 선택해 주세요.');
      return;
    }
    if (!eq.serialNo) {
      if (summary) summary.textContent = '현재 설비에 시리얼번호가 없어 연결 자산을 찾을 수 없습니다.';
      if (body) setLinkedAssetsEmptyRow('시리얼번호를 입력하면 연결된 자산을 확인할 수 있습니다.');
      return;
    }
    if (!Array.isArray(state.accAssetsCache)) {
      if (summary) {
        summary.textContent = state.linkedAssetsLoading ? '연결된 자산을 불러오는 중…' : '연결된 자산 데이터를 준비 중입니다.';
      }
      if (body) setLinkedAssetsEmptyRow('자산 데이터를 불러오는 중입니다…');
      return;
    }
    const linked = getLinkedAssetsBySerial(eq.serialNo);
    if (!linked.length) {
      if (summary) summary.textContent = '연결된 자산이 없습니다.';
      if (body) setLinkedAssetsEmptyRow('연결된 자산이 없습니다.');
      return;
    }
    if (summary) summary.textContent = `총 ${linked.length}건의 연결된 자산이 있습니다.`;
    const fragment = document.createDocumentFragment();
    const sorted = sortLinkedAssets(linked);
    sorted.forEach(asset => {
      const tr = document.createElement('tr');
      const statusLabel = getAssetStatusLabel(asset.status);
      const assetCode = asset.mkcCode || asset.codeNo || '-';
      const assetTypeLabel = asset.assetType || '-';
      tr.innerHTML = `
        <td>${escapeHtml(assetTypeLabel)}</td>
        <td class="mono">${escapeHtml(asset.assetNo || '-')}</td>
        <td class="mono">${escapeHtml(assetCode)}</td>
        <td>${escapeHtml(asset.name || '-')}</td>
        <td>${escapeHtml(statusLabel)}</td>
        <td>${escapeHtml(formatAssetLocation(asset.location))}</td>
      `;
      fragment.appendChild(tr);
    });
    body.appendChild(fragment);
  }

  function renderLinkedAssetsSection(forceFetch = false) {
    if (!els.linkedAssetsBody && !els.linkedAssetsSummary) return;
    renderLinkedAssetsTable();
    const needsFetch = forceFetch || !Array.isArray(state.accAssetsCache);
    if (!needsFetch) return;
    const lite = window.firebaseLite;
    const db = window.firebaseDb;
    if (!lite || !db) {
      if (els.linkedAssetsSummary) {
        els.linkedAssetsSummary.textContent = 'Firebase 초기화를 기다리는 중입니다.';
      }
      return;
    }
    if (state.linkedAssetsLoading) return;
    state.linkedAssetsLoading = true;
    if (els.linkedAssetsSummary) els.linkedAssetsSummary.textContent = '연결된 자산을 불러오는 중…';
    fetchAccAssets(forceFetch).then(() => {
      state.linkedAssetsLoading = false;
      renderLinkedAssetsTable();
    }).catch((err) => {
      state.linkedAssetsLoading = false;
      console.error('연결된 자산 로드 실패:', err);
      if (els.linkedAssetsSummary) {
        els.linkedAssetsSummary.textContent = '연결된 자산을 불러오지 못했습니다.';
      }
      if (els.linkedAssetsBody && !els.linkedAssetsBody.hasChildNodes()) {
        setLinkedAssetsEmptyRow('연결된 자산을 불러오지 못했습니다.');
      }
    });
  }

  // Edit/Read mode helpers
  function getEditableControls() {
    const list = [];
    [els.reqModel, els.reqSerial, els.reqCode, els.reqCategory, els.reqInstallDate, els.reqCalibrationDate, els.reqNote,
     els.reqLocationMajor, els.reqLocationMiddle, els.reqLocationMinor,
     els.histDate, els.histType, els.histDesc, els.histUser].forEach(el => { if (el) list.push(el); });
    document.querySelectorAll('#specsBody input, #accBody input, #accBody select, #histBody input, #histBody select, #tasksBody input, #tasksBody select').forEach(el => list.push(el));
    return list;
  }

  function applyMode(rerender = true) {
    const on = !!state.edit;
    document.body.classList.toggle('read-mode', !on);
    if (els.btnToggleEdit) {
      els.btnToggleEdit.setAttribute('aria-pressed', String(on));
      // on 상태(편집 가능)에서는 버튼이 '로그아웃' 동작을 의미
      els.btnToggleEdit.textContent = on ? '로그아웃' : '로그인';
    }
    if (els.btnSave) els.btnSave.disabled = !on;
    getEditableControls().forEach(el => { try { el.disabled = !on; } catch(_) {} });
    // 읽기 모드용 텍스트 라벨 업데이트
    try { updateRequiredFieldsView(); } catch(_) {}
    if (rerender) {
      // 편집/읽기 전환 시, 뷰 차이가 있는 영역을 재렌더링하여 자연스럽게 전환
      // renderAccessories는 호출하지 않음: 버튼 클릭 시 직접 호출하므로 중복 방지
      try { renderPhotos(current()?.photos || []); } catch(_) {}
      try { renderSpecs(current()?.specs || []); } catch(_) {}
      try { renderHistory(current()?.history || []); } catch(_) {}
      try { renderTasks(current()?.tasks || []); } catch(_) {}
    }
  }

  // Event wiring
  function attachEvents() {
    // Top bar
    // (검색 및 새설비 기능 제거됨)

    // 저장 버튼 제거됨: 자동 저장으로 대체
    document.addEventListener('keydown', handleGlobalShortcuts);

    // 목록 버튼: 편집 중 + 변경사항 있을 때 확인 후 저장
    if (els.btnList) {
      // 설비목록 버튼 스타일: 현재 로그아웃 버튼 색상(회색)으로 변경
      els.btnList.style.background = '#4b5563';
      els.btnList.style.color = '#fff';
      els.btnList.style.border = '1px solid #4b5563';
      els.btnList.addEventListener("click", async () => {
        if (state.edit && hasUnsavedChanges()) {
          const choice = await openUnsavedModal();
          if (choice === 'cancel') return;
          if (choice === 'save') await forceSave('manual');
        }
        window.location.href = "list.html";
      });
    }

    // Toggle edit mode -> use Firebase Auth (logout if logged in)
    if (els.btnToggleEdit) {
      els.btnToggleEdit.addEventListener("click", async () => {
        if (state.edit) {
          if (hasUnsavedChanges()) {
            const choice = await openUnsavedModal();
            if (choice === 'cancel') return;
            if (choice === 'save') await forceSave('manual');
          }
          try { if (window.signOutCurrent) await window.signOutCurrent(); } catch(_) {}
          return;
        }
        const redirect = encodeURIComponent(location.pathname + location.search);
        window.location.href = `login.html?redirect=${redirect}`;
      });
    }

    // Required fields -> state binding
    [
      [els.reqModel, "model"],
      [els.reqSerial, "serialNo"],
      [els.reqCode, "codeNo"],
      [els.reqCategory, "category"],
      [els.reqInstallDate, "installDate"],
      [els.reqCalibrationDate, "calibrationDate"],
      [els.reqNote, "note"],
    ].forEach(([el, key]) => {
      if (!el) return;
      el.addEventListener("input", () => {
        const eq = current();
        if (!eq) return;
        const oldId = eq.id;
        const oldSerial = eq.serialNo;
        eq[key] = el.value;
        // 시리얼 번호 입력 시 고유 ID 자동 업데이트
        if (key === 'serialNo') {
          const newId = generateIdFromSerial(el.value);
          if (newId !== oldId) {
            // 다른 설비에 같은 ID가 있는지 확인
            const existing = state.equipments.find(e => e && e.id === newId && e !== eq);
            if (existing) {
              notify(`시리얼 번호 "${el.value}"는 이미 사용 중입니다.`, 'error');
              // 원복: 입력 필드와 데이터 동기화 유지
              eq.serialNo = oldSerial;
              el.value = oldSerial || '';
            } else {
              // id 업데이트 및 선택 상태 유지
              eq.id = newId;
              if (state.selectedId === oldId) state.selectedId = newId;
              // 이전 시리얼 스냅샷을 새 id 키로 이관하여 삭제/이력 처리 보장
              try {
                const prev = (state.prevSerialMap && state.prevSerialMap.get(oldId)) ?? oldSerial ?? '';
                if (state.prevSerialMap) {
                  state.prevSerialMap.delete(oldId);
                  state.prevSerialMap.set(newId, prev);
                }
              } catch(_) {}
              try {
                const last = (state.lastSavedMap && state.lastSavedMap.get(oldId));
                if (state.lastSavedMap) {
                  state.lastSavedMap.delete(oldId);
                  if (last !== undefined) state.lastSavedMap.set(newId, last);
                }
              } catch(_) {}
            }
          }
        }
        // Update summary live when dates or model/serial change
        if (key === 'installDate' || key === 'calibrationDate' || key === 'model' || key === 'serialNo') renderSummary();
        if (key === 'serialNo') {
          try { renderLinkedAssetsTable(); } catch(_) {}
        }
        // 읽기 모드용 텍스트 라벨 업데이트
        try { updateRequiredFieldsView(); } catch(_) {}
        // 자동 저장
        queueAutosave();
      });
    });

    // 위치(대/중/소) -> eq.location 바인딩 및 검증/자동저장
    const updateLocationFromInputs = () => {
      const eq = current();
      if (!eq) return;
      const major = els.reqLocationMajor ? els.reqLocationMajor.value : '';
      const middle = els.reqLocationMiddle ? els.reqLocationMiddle.value : '';
      const minor = els.reqLocationMinor ? els.reqLocationMinor.value : '';
      eq.location = buildLocation(major, middle, minor);
      // 읽기 모드 텍스트 갱신 및 에러 표시
      try { updateRequiredFieldsView(); } catch(_) {}
      const errEl = document.getElementById('errLocation');
      const valid = !!String(major || '').trim();
      if (els.reqLocationMajor) els.reqLocationMajor.setAttribute('aria-invalid', valid ? 'false' : 'true');
      if (errEl) errEl.textContent = valid ? '' : '위치(대분류)를 선택해 주세요.';
      queueAutosave();
    };
    if (els.reqLocationMajor) {
      els.reqLocationMajor.addEventListener('change', updateLocationFromInputs);
      els.reqLocationMajor.addEventListener('input', updateLocationFromInputs);
    }
    if (els.reqLocationMiddle) els.reqLocationMiddle.addEventListener('input', updateLocationFromInputs);
    if (els.reqLocationMinor) els.reqLocationMinor.addEventListener('input', updateLocationFromInputs);

    // Status buttons handlers
    if (els.statusButtons && els.statusButtons.length > 0) {
      els.statusButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          if (!state.edit) {
            notify('로그인 후 상태를 변경할 수 있습니다.', 'error');
            return;
          }
          const eq = current();
          if (!eq) return;
          const newStatus = btn.getAttribute('data-status');
          const currentStatus = eq.status || '';
          // 같은 버튼을 다시 클릭해도 선택 상태 유지 (해제 불가)
          if (currentStatus === newStatus) {
            return;
          }
          // 상태 변경 시 이력추가 모달 열기
          state.pendingStatusChange = {
            oldStatus: currentStatus,
            newStatus: newStatus
          };
          openHistModal();
        });
      });
    }

    if (els.btnImagePreview) {
      els.btnImagePreview.addEventListener('click', () => {
        const hasPhoto = els.btnImagePreview.dataset.hasPhoto === 'true';
        if (hasPhoto && els.imagePreviewItem) {
          openPhotoModal(els.imagePreviewItem);
          return;
        }
        activateTab('photo');
        notify('설비사진 탭에서 이미지를 등록해 주세요.', 'info');
      });
    }

    // Photos grid handlers
    if (els.photosGrid) {
      els.photosGrid.addEventListener('click', (e) => {
        const box = e.target.closest('.photo-box');
        if (!box) return;
        const idx = Number(box.dataset.index || 0);
        const eq = current();
        if (!eq) return;
        if (!Array.isArray(eq.photos)) eq.photos = [];
        // normalize to compact array (no null gaps)
        eq.photos = eq.photos.filter(Boolean);
        const item = eq.photos[idx];
        const viewUrl = item && typeof item === 'object' ? item.url : item;
        const btn = e.target.closest('button[data-action]');
        // If not clicking a button, always open viewer when image exists
        if (!btn) {
          if (item) openPhotoModal(item);
          return;
        }
        // If read-mode, ignore edit buttons and just view
        if (!state.edit) {
          if (url) openPhotoModal(url);
          return;
        }
        // Edit-mode button actions
        const action = btn.getAttribute('data-action');
        if (action === 'clear') {
          // remove the photo and its slot
          eq.photos.splice(idx, 1);
          // 대표사진 인덱스 업데이트
          if (eq.representativePhoto !== null) {
            if (eq.representativePhoto === idx) {
              // 삭제된 사진이 대표사진이었으면 해제
              eq.representativePhoto = null;
            } else if (eq.representativePhoto > idx) {
              // 삭제된 사진보다 뒤에 있던 대표사진 인덱스 조정
              eq.representativePhoto -= 1;
            }
          }
          // 사진 변경 코드 업데이트 (일자+시간)
          eq.photoCode = new Date().toISOString();
          renderPhotos(eq.photos);
          queueAutosave();
        } else if (action === 'change') {
          // 새 사진 추가 시 12개 제한 체크
          const MAX_PHOTOS = 12;
          const isNewPhoto = idx >= eq.photos.length;
          if (isNewPhoto && eq.photos.length >= MAX_PHOTOS) {
            notify(`사진은 최대 ${MAX_PHOTOS}개까지 추가할 수 있습니다.`, 'error');
            return;
          }
          // if clicking on the add slot (idx === photos.length), it will append
          state.photoEditingIndex = idx;
          els.photoFile && els.photoFile.click();
        } else if (action === 'setRepresentative') {
          // 대표사진 설정/해제
          if (eq.representativePhoto === idx) {
            // 대표사진 해제
            eq.representativePhoto = null;
            notify('대표사진이 해제되었습니다.', 'success');
          } else {
            // 대표사진 설정
            eq.representativePhoto = idx;
            notify('대표사진이 설정되었습니다.', 'success');
          }
          renderPhotos(eq.photos);
          queueAutosave();
        }
      });
    }
    if (els.photoFile) {
      els.photoFile.addEventListener('change', async () => {
        const file = els.photoFile.files?.[0];
        if (!file) return;
        try {
          // 사진 저장 용량을 500KB 이하로 제한
          const dataURL = await loadAndMaybeResizeImage(file, { maxBytes: 500 * 1024, maxW: 1600, maxH: 1200 });
          const eq = current();
          if (!eq) return;
          // 보류 데이터 저장 후 설명 입력 모달 열기
          const idx = Number.isInteger(state.photoEditingIndex) ? state.photoEditingIndex : null;
          state.pendingPhoto = { dataURL, index: idx };
          let prefill = '';
          if (idx !== null && Array.isArray(eq.photos) && eq.photos[idx] && typeof eq.photos[idx] === 'object') {
            prefill = eq.photos[idx].desc || '';
          }
          openPhotoMetaModal(prefill);
        } catch (e) {
          alert(String(e));
        } finally {
          state.photoEditingIndex = null;
          els.photoFile.value = '';
        }
      });
    }

    // Specs CRUD
    if (els.btnAddSpec) {
      els.btnAddSpec.addEventListener("click", () => {
        if (!state.edit) return; // 편집모드에서만 추가 가능
        const eq = current();
        if (!eq) return;
        if (!Array.isArray(eq.specs)) eq.specs = [];
        eq.specs.push({ id: uid(), key: "", value: "" });
        renderSpecs(eq.specs);
        queueAutosave();
      });
    }
    if (els.specsBody) {
      els.specsBody.addEventListener("input", (e) => {
        if (!state.edit) return; // 편집모드에서만 수정 가능
        const tr = e.target.closest("tr");
        if (!tr) return;
        const id = tr.dataset.id;
        const eq = current();
        const row = eq?.specs.find((r) => r.id === id);
        if (!row) return;
        const inputs = tr.querySelectorAll("input");
        row.key = inputs[0]?.value || "";
        row.value = inputs[1]?.value || "";
        queueAutosave();
      });
      els.specsBody.addEventListener("click", (e) => {
        if (!state.edit) return; // 편집모드에서만 동작
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const tr = btn.closest("tr");
        if (!tr) return;
        const id = tr.dataset.id;
        const eq = current();
        if (!eq) return;
        const action = btn.getAttribute("data-action");
        if (action === "del") {
          const idx = eq.specs.findIndex((r) => r.id === id);
          if (idx >= 0) {
            eq.specs.splice(idx, 1);
            renderSpecs(eq.specs);
            queueAutosave();
          }
        }
      });
    }

    // Accessories: 연결/해제
    if (els.btnAddAcc) {
      els.btnAddAcc.addEventListener("click", async () => {
        if (!state.edit) return;
        openAccAssetModal();
      });
    }
    if (els.accBody) els.accBody.addEventListener("input", (e) => {
      if (!state.edit) return; // 편집모드에서만 수정 가능
      const tr = e.target.closest("tr");
      if (!tr) return;
      const id = tr.dataset.id;
      const eq = current();
      const row = eq?.accessories.find((r) => r.id === id);
      if (!row) return;
      const sel = tr.querySelector('select');
      const inputs = tr.querySelectorAll("input");
      // category는 change 이벤트에서 처리하므로 여기서는 제외
      if (!e.target.matches('select')) {
        row.assetCode = inputs[0]?.value || row.assetCode;
        row.name = inputs[1]?.value || row.name;
        row.code = inputs[2]?.value || row.code;
        row.serial = inputs[3]?.value || row.serial;
        row.note = inputs[4]?.value || row.note;
      }
      // input 이벤트에서는 재렌더링하지 않음: 성능 최적화 (정렬에 영향 없음)
      queueAutosave();
    });
    if (els.accBody) els.accBody.addEventListener("change", (e) => {
      if (!state.edit) return; // 편집모드에서만 수정 가능
      const tr = e.target.closest("tr");
      if (!tr) return;
      const id = tr.dataset.id;
      const eq = current();
      const row = eq?.accessories.find((r) => r.id === id);
      if (!row) return;
      if (e.target.matches('select')) {
        // category 변경 시에만 재렌더링 (정렬 기준이 변경되므로)
        const oldCategory = row.category;
        row.category = e.target.value;
        // category가 실제로 변경된 경우에만 재렌더링
        if (oldCategory !== row.category) {
          renderAccessories(eq.accessories);
        }
        queueAutosave();
      } else if (e.target.matches('input[type="text"]')) {
        // 비고 변경 반영 (연결 항목)
        row.note = e.target.value || '';
        queueAutosave();
      }
    });
    if (els.accBody) els.accBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const tr = btn.closest('tr');
      if (!tr) return;
      const id = tr.dataset.id;
      const eq = current();
      const row = eq?.accessories.find((r) => r.id === id);
      if (!row) return;
      if (btn.getAttribute('data-action') === 'unlink') {
        // 해제 모달 오픈
        openAccUnlinkModal({ rowId: id, assetNo: row.assetNo });
      }
    });

    // Tasks CRUD
    els.btnAddTask.addEventListener("click", () => {
      if (!state.edit) return; // 편집모드에서만 추가 가능
      const eq = current();
      if (!eq) return;
      if (!Array.isArray(eq.tasks)) eq.tasks = [];
      eq.tasks.push({ 
        id: uid(), 
        title: "", 
        periodYear: 0, 
        periodMonth: 0, 
        periodDay: 0, 
        lastCheck: "", 
        nextCheck: "", 
        note: "" 
      });
      renderTasks(eq.tasks);
      try { renderTasksOverview(eq.tasks); } catch(_) {}
      queueAutosave();
    });
    
    els.tasksBody.addEventListener("input", (e) => {
      if (!state.edit) return; // 편집모드에서만 수정 가능
      const tr = e.target.closest("tr");
      if (!tr) return;
      const id = tr.dataset.id;
      const eq = current();
      const row = eq?.tasks.find((r) => r.id === id);
      if (!row) return;
      const inputs = tr.querySelectorAll("input");
      const target = e.target;
      
      // 입력 필드에 따라 데이터 업데이트
      // inputs[0]: 작업명, inputs[1]: 비고, inputs[2]: 주기(년), inputs[3]: 주기(월), inputs[4]: 주기(일), inputs[5]: 마지막 점검일
      if (target === inputs[0]) {
        row.title = target.value || "";
        // 작업명 변경 시에도 대시보드 업데이트
        try { renderTasksOverview(eq.tasks); } catch(_) {}
      } else if (target === inputs[1]) {
        row.note = target.value || "";
      } else if (target === inputs[2]) {
        row.periodYear = Math.max(0, parseInt(target.value || "0", 10));
      } else if (target === inputs[3]) {
        row.periodMonth = Math.max(0, parseInt(target.value || "0", 10));
      } else if (target === inputs[4]) {
        row.periodDay = Math.max(0, parseInt(target.value || "0", 10));
      } else if (target === inputs[5]) {
        row.lastCheck = target.value || "";
      }
      
      // 마지막 점검일이나 주기가 변경되면 다음 점검일 재계산 및 해당 셀만 업데이트
      if (target === inputs[2] || target === inputs[3] || target === inputs[4] || target === inputs[5]) {
        if (row.lastCheck) {
          row.nextCheck = calculateNextCheck(row.lastCheck, row.periodYear, row.periodMonth, row.periodDay);
          // 다음 점검일 셀만 업데이트 (6번째 td, 인덱스 6)
          const nextCheckCell = tr.querySelectorAll("td")[6];
          if (nextCheckCell) {
            const isOverdue = row.nextCheck && new Date(row.nextCheck) < new Date();
            nextCheckCell.textContent = row.nextCheck || '-';
            nextCheckCell.className = isOverdue ? 'overdue' : '';
          }
        } else {
          // 마지막 점검일이 없으면 다음 점검일 초기화
          row.nextCheck = "";
        }
        // 주기나 마지막 점검일 변경 시 대시보드 업데이트 (lastCheck가 없어도)
        try { renderTasksOverview(eq.tasks); } catch(_) {}
      }
      
      // input 이벤트에서는 재렌더링하지 않음: 포커스 유지 및 성능 최적화
      queueAutosave();
    });
    
    // change 이벤트는 date input에서만 필요 (날짜 선택 완료 시)
    els.tasksBody.addEventListener("change", (e) => {
      if (!state.edit) return; // 편집모드에서만 수정 가능
      const tr = e.target.closest("tr");
      if (!tr) return;
      const id = tr.dataset.id;
      const eq = current();
      const row = eq?.tasks.find((r) => r.id === id);
      if (!row) return;
      
      // date input의 change 이벤트 처리
      if (e.target.type === 'date') {
        row.lastCheck = e.target.value || "";
        // 마지막 점검일 변경 시 다음 점검일 재계산
        if (row.lastCheck) {
          row.nextCheck = calculateNextCheck(row.lastCheck, row.periodYear, row.periodMonth, row.periodDay);
          // 다음 점검일 셀만 업데이트 (6번째 td, 인덱스 6)
          const nextCheckCell = tr.querySelectorAll("td")[6];
          if (nextCheckCell) {
            const isOverdue = row.nextCheck && new Date(row.nextCheck) < new Date();
            nextCheckCell.textContent = row.nextCheck || '-';
            nextCheckCell.className = isOverdue ? 'overdue' : '';
          }
          // 대시보드도 업데이트
          try { renderTasksOverview(eq.tasks); } catch(_) {}
        }
        queueAutosave();
      }
    });
    
    els.tasksBody.addEventListener("click", (e) => {
      if (!state.edit) return; // 편집모드에서만 동작
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const tr = btn.closest("tr");
      if (!tr) return;
      const id = tr.dataset.id;
      const eq = current();
      if (!eq) return;
      const action = btn.getAttribute("data-action");
      
      if (action === "del") {
        const idx = eq.tasks.findIndex((r) => r.id === id);
        if (idx >= 0) {
          eq.tasks.splice(idx, 1);
          renderTasks(eq.tasks);
          try { renderTasksOverview(eq.tasks); } catch(_) {}
          queueAutosave();
        }
      } else if (action === "check") {
        // 점검완료: 이력추가 모달을 열고 task ID를 저장
        const row = eq.tasks.find((r) => r.id === id);
        if (row) {
          // 이력추가 모달 열기 (task ID 저장)
          ensureHistoryAddUI();
          const modal = document.getElementById('histModal');
          if (modal) {
            modal.dataset.taskId = id;
            // 작업명에 따라 유형 자동 선택
            let typeValue = 'inspection'; // 기본값: 점검
            if (row.name && row.name.trim() === '정도검사') {
              typeValue = 'calibration'; // 작업명이 '정도검사'이면 유형을 '정도검사'로 선택
            }
            const typeRadio = document.querySelector(`input[name="histModalType"][value="${typeValue}"]`);
            if (typeRadio) {
              typeRadio.checked = true;
            }
            // 작업명을 내용에 기본값으로 설정
            const descEl = document.getElementById('histModalDesc');
            if (descEl && row.name) {
              descEl.value = row.name;
            }
            openHistModal();
          }
        }
      }
    });

    // History 추가/입력: 팝업에서 처리 (테이블 입력 제거)
    // 이력 삭제 버튼 제거됨: 클릭 삭제 핸들러 비활성화

    // History filters
    // 기간(select)
    if (els.filterPeriod) {
      els.filterPeriod.addEventListener('change', () => {
        state.filter.period = els.filterPeriod.value;
        renderHistory(current()?.history || []);
      });
    }
    // 유형 토글 버튼 (신규 UI) 또는 레거시 select
    const typeToggles = document.querySelectorAll('.type-toggle-group .type-toggle');
    if (typeToggles.length) {
      typeToggles.forEach(btn => {
        btn.addEventListener('click', () => {
          const sel = btn.dataset.filter || 'all';
          state.filter.type = sel;
          syncFilterTypeRadios(sel);
          renderHistory(current()?.history || []);
        });
      });
    } else if (els.filterType) {
      // 구버전 select 호환
      els.filterType.addEventListener('change', () => {
        state.filter.type = els.filterType.value;
        renderHistory(current()?.history || []);
      });
    }

    // 테이블 헤더 클릭 정렬 이벤트
    // 설치옵션·부속품 테이블 헤더
    const accThead = document.querySelector('.panel-accessories thead tr, .accessories-page thead tr');
    if (accThead) {
      accThead.addEventListener('click', (e) => {
        const th = e.target.closest('th');
        if (!th) return;
        let text = th.textContent.trim();
        // 화살표 제거
        text = text.replace(/[↑↓]\s*$/, '').trim();
        const columnMap = ['구분', '자산코드', '이름', '코드', '시리얼번호', '수량', '비고'];
        const columnIndex = columnMap.findIndex(col => text.includes(col));
        if (columnIndex === -1) return;
        const columns = ['category', 'assetCode', 'name', 'code', 'serial', 'qty', 'note'];
        const column = columns[columnIndex];
        if (!column) return;
        
        if (state.accessoriesSort.column === column) {
          // 같은 컬럼 클릭 시 방향 토글
          state.accessoriesSort.direction = state.accessoriesSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          // 다른 컬럼 클릭 시 해당 컬럼으로 변경하고 오름차순으로 시작
          state.accessoriesSort.column = column;
          state.accessoriesSort.direction = 'asc';
        }
        renderAccessories(current()?.accessories || []);
      });
    }

    // 설비이력 테이블 헤더 (개요 + 전용 탭 모두 적용)
    const histTheads = document.querySelectorAll('table.history-table thead tr');
    histTheads.forEach((histThead) => {
      histThead.addEventListener('click', (e) => {
        const th = e.target.closest('th');
        if (!th) return;
        let text = th.textContent.trim();
        text = text.replace(/[↑↓]\s*$/, '').trim();
        const columnMap = ['날짜', '유형', '내용', '작성자'];
        const columnIndex = columnMap.findIndex(col => text.includes(col));
        if (columnIndex === -1) return;
        const columns = ['date', 'type', 'desc', 'user'];
        const column = columns[columnIndex];
        if (!column) return;
        if (state.historySort.column === column) {
          state.historySort.direction = state.historySort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          state.historySort.column = column;
          state.historySort.direction = 'asc';
        }
        renderHistory(current()?.history || []);
      });
    });

    // 전용 탭의 이력추가 버튼
    const btnOpenHist = document.getElementById('btnOpenHistModal');
    if (btnOpenHist) btnOpenHist.addEventListener('click', openHistModal);
  }

  // Persistence
  async function persist() {
    const replacements = ensureEquipmentIds();
    if (state.selectedId && replacements.has(state.selectedId)) {
      state.selectedId = replacements.get(state.selectedId);
    }
    const db = window.firebaseDb;
    if (!db) {
      // 온라인 전용: Firebase가 없으면 저장 불가
      notify('저장 백엔드 연결 실패', 'error');
      return;
    }
    try {
      const { collection, doc, setDoc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-lite.js');
      const equipmentsCollection = collection(db, 'equipments');
      const metaCollection = collection(db, 'equipment_meta');
      const prevSerialSnapshot = new Map(state.prevSerialMap || new Map());

      // 저장 대상: 단일 로드면 현재 선택만, 전체 로드면 모두
      const targets = state.hydratedScope === 'single' ? [current()].filter(Boolean) : state.equipments;
      for (const eq of targets) {
        if (!eq || !eq.serialNo || !eq.serialNo.trim()) {
          // 필수값 없으면 원격 저장 생략
          continue;
        }
        // 변경 감지 및 시리얼 변경 처리
        const prevSerial = prevSerialSnapshot.get(eq.id) ?? '';
        const snap = serializeEqForCompare(eq);
        const last = state.lastSavedMap ? state.lastSavedMap.get(eq.id) : undefined;
        const serialChanged = (prevSerial || '') !== (eq.serialNo || '');
        const contentChanged = snap !== last;
        if (!serialChanged && !contentChanged) {
          continue; // 변경 없음
        }
        const docId = sanitizeForDocId(eq.serialNo);
        if (!docId) continue;
        const eqRef = doc(equipmentsCollection, docId);
        await setDoc(eqRef, eq, { merge: true });
        const metaRef = doc(metaCollection, docId);
        const metaPayload = await buildEquipmentMeta(eq);
        await setDoc(metaRef, metaPayload, { merge: true });

        // 이전 시리얼 문서 정리 (단일 항목만)
        if (serialChanged && prevSerial) {
          const oldId = sanitizeForDocId(prevSerial);
          if (oldId && oldId !== docId) {
            try { await deleteDoc(doc(equipmentsCollection, oldId)); } catch(_) {}
            try { await deleteDoc(doc(metaCollection, oldId)); } catch(_) {}
          }
        }

        // 맵 업데이트
        try {
          state.prevSerialMap.set(eq.id, eq.serialNo || '');
          state.lastSavedMap.set(eq.id, snap);
        } catch(_) {}

        // 위치가 변경된 경우 연결자산 위치도 동기화
        if (contentChanged && eq.location) {
          updateLinkedAssetsLocation(eq.serialNo, eq.location).then(count => {
            if (count > 0) {
              notify(`연결된 자산 ${count}건의 위치가 함께 변경되었습니다.`, 'success');
              // 연결자산 테이블 갱신
              renderLinkedAssetsTable();
            }
          }).catch(err => {
            console.error('연결자산 위치 업데이트 실패:', err);
            // 에러 발생 시에도 조용히 실패 (설비 저장은 이미 완료됨)
          });
        }
      }

      // 온라인 저장 성공 시 로컬에도 백업
      try {
        if (state.hydratedScope === 'single') {
          const raw = localStorage.getItem(STORAGE_KEY);
          let list = [];
          try { if (raw) list = JSON.parse(raw); } catch(_) { list = []; }
          const cur = current();
          if (cur) {
            // id -> 새 serial -> 이전 serial 순으로 매칭
            const prevSerial = prevSerialSnapshot.get(cur.id) ?? '';
            let idx = list.findIndex(e => e && e.id === cur.id);
            if (idx < 0 && cur.serialNo) idx = list.findIndex(e => e && e.serialNo === cur.serialNo);
            if (idx < 0 && prevSerial) idx = list.findIndex(e => e && e.serialNo === prevSerial);
            if (idx >= 0) list[idx] = cur; else list.push(cur);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
          }
        } else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state.equipments));
        }
      } catch(_) {}
    } catch (e) {
      console.error("Firebase 저장 실패:", e);
      notify('저장 실패: 네트워크 또는 서버 오류', 'error');
    }
  }
  async function buildEquipmentMeta(eq) {
    let src = null;
    let desc = '';
    if (eq && Array.isArray(eq.photos) && eq.photos.length > 0) {
      let photo = null;
      if (eq.representativePhoto !== null && eq.representativePhoto !== undefined) {
        photo = eq.photos[eq.representativePhoto] || null;
      }
      if (!photo) photo = eq.photos[0];
      if (photo) {
        if (typeof photo === 'object') { src = photo.url || ''; desc = photo.desc || ''; }
        else if (typeof photo === 'string') { src = photo; desc = ''; }
      }
    }
    let thumbUrl = src || '';
    // 생성/캐시: 사진 코드가 같으면 캐시된 썸네일 사용
    const cacheKey = eq.id || (eq.serialNo || '');
    const pCode = eq.photoCode || '';
    if (src) {
      const cached = thumbCache.get(cacheKey);
      if (cached && cached.photoCode === pCode && cached.dataURL) {
        thumbUrl = cached.dataURL;
      } else {
        try {
          const t = await createThumbnailFromUrl(src, 240, 180, 0.75);
          if (t) {
            thumbUrl = t;
            thumbCache.set(cacheKey, { photoCode: pCode, dataURL: t, desc });
          }
        } catch (_) {
          // 실패 시 원본 사용
        }
      }
    }
    return {
      id: eq.id,
      internalId: eq.id,
      serialNo: eq.serialNo || "",
      model: eq.model || "",
      codeNo: eq.codeNo || "",
      category: eq.category || "",
      installDate: eq.installDate || "",
      calibrationDate: eq.calibrationDate || "",
      location: eq.location || "",
      status: eq.status || "",
      photoCode: pCode,
      thumbUrl,
      thumbDesc: desc,
      updatedAt: new Date().toISOString(),
    };
  }
  async function hydrate() {
    // 인증이 완료되지 않았으면 대기
    if (!window.currentUser) {
      await waitForAuth();
    }
    
    const db = window.firebaseDb;
    
    if (!db) {
      // Firebase가 아직 로드되지 않았으면 localStorage에서 로드
      state.hydratedScope = 'all';
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state.equipments = JSON.parse(raw);
      } catch (e) {
        console.warn("Failed to parse storage", e);
        state.equipments = [];
      }
    } else {
      // 온라인 상태: Firebase 서버 데이터를 우선으로 로드
      try {
        const { collection, getDocs, doc, getDoc, query, where, limit } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-lite.js');
        const equipmentsCollection = collection(db, 'equipments');

        // URL 파라미터로 특정 설비만 요청하여 데이터 절약
        const urlParams = new URLSearchParams(window.location.search);
        const equipmentIdParam = urlParams.get('id');
        if (equipmentIdParam) {
          state.hydratedScope = 'single';
          const q = query(equipmentsCollection, where('id', '==', equipmentIdParam), limit(1));
          const oneSnap = await getDocs(q);
          if (!oneSnap.empty) {
            state.equipments = [oneSnap.docs[0].data()];
          } else {
            // 백업: 전체 로드 (희귀 케이스)
            const snapshot = await getDocs(equipmentsCollection);
            const serverEquipments = [];
            snapshot.forEach(docSnap => serverEquipments.push(docSnap.data()));
            state.equipments = serverEquipments;
            state.hydratedScope = 'all';
          }
        } else {
          state.hydratedScope = 'all';
          // 전체 로드 (직접 접속 등)
          const snapshot = await getDocs(equipmentsCollection);
          const serverEquipments = [];
          snapshot.forEach(docSnap => serverEquipments.push(docSnap.data()));
          state.equipments = serverEquipments;
        }

        // 서버 데이터가 없으면 기존 구조(data/equipments) 마이그레이션 처리 (최초 1회용)
        if (!(state.equipments && state.equipments.length)) {
          const oldRef = doc(db, 'data', 'equipments');
          const oldSnapshot = await getDoc(oldRef);
          if (oldSnapshot.exists()) {
            const oldData = oldSnapshot.data();
            if (oldData.equipments && Array.isArray(oldData.equipments)) {
              state.equipments = oldData.equipments;
              await persist();
              const { deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
              await deleteDoc(oldRef);
            }
          } else if (!state.equipments || state.equipments.length === 0) {
            // 서버에도 없으면 localStorage에서 시도
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
              state.equipments = JSON.parse(raw);
              await persist();
            }
          }
        }

        // 서버 데이터를 localStorage에 백업
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state.equipments));
        } catch (e) {
          console.warn("localStorage 백업 실패:", e);
        }
        
        // users 컬렉션 캐시 미리 로드 (권한 오류 시 조용히 실패)
        // 오류가 발생해도 애플리케이션은 정상 작동 (email을 그대로 표시)
        loadUsersCache().catch(() => {
          // 조용히 실패 처리 (이미 loadUsersCache 내부에서 처리됨)
        });
      } catch (e) {
        console.warn("Firebase 로드 실패, localStorage에서 시도:", e);
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) state.equipments = JSON.parse(raw);
        } catch (e2) {
          console.warn("Failed to parse storage", e2);
          state.equipments = [];
        }
      }
    }
    // migrate photos: ensure compact array of strings, and accessories serial field
    // 시리얼 번호 기반 ID 마이그레이션
    // 성능 최적화: 필요한 경우에만 마이그레이션 수행
    const replacementMap = ensureEquipmentIds(state.equipments);
    if (state.selectedId && replacementMap.has(state.selectedId)) {
      state.selectedId = replacementMap.get(state.selectedId);
    }
    const needsMigration = state.equipments.some(eq => 
      eq.photo || !Array.isArray(eq.photos) || 
      (Array.isArray(eq.accessories) && eq.accessories.some(a => a && (typeof a.serial === 'undefined' || typeof a.assetCode === 'undefined'))) ||
      (eq.serialNo && !eq.id.startsWith('SERIAL_')) ||
      eq.representativePhoto === undefined
    );
    if (needsMigration) {
      state.equipments.forEach(eq => {
        // 시리얼 번호 기반 ID로 마이그레이션
        if (eq.serialNo && eq.serialNo.trim() && !eq.id.startsWith('SERIAL_')) {
          const newId = generateIdFromSerial(eq.serialNo);
          // 중복 체크: 같은 시리얼 번호가 이미 있으면 기존 것 유지
          const duplicate = state.equipments.find(e => e.id === newId && e.id !== eq.id);
          if (!duplicate) {
            eq.id = newId;
          }
        }
        // move legacy single photo
        if (eq.photo && (!Array.isArray(eq.photos) || eq.photos.length === 0)) {
          eq.photos = [eq.photo];
          try { delete eq.photo; } catch(_) {}
        }
        if (!Array.isArray(eq.photos)) eq.photos = [];
        // drop null/empty entries
        eq.photos = eq.photos.filter(Boolean);
        // ensure photoCode exists if photos exist
        if (!eq.photoCode) {
          eq.photoCode = eq.photos.length ? new Date().toISOString() : '';
        }
        // ensure representativePhoto field exists
        if (eq.representativePhoto === undefined) {
          eq.representativePhoto = null;
        }
        // ensure accessories entries have serial and assetCode
        if (Array.isArray(eq.accessories)) {
          eq.accessories.forEach(a => { 
            if (a && typeof a.serial === 'undefined') a.serial = ""; 
            if (a && typeof a.assetCode === 'undefined') a.assetCode = ""; 
          });
        }
        // ensure tasks array exists
        if (!Array.isArray(eq.tasks)) {
          eq.tasks = [];
        }
      });
      // 마이그레이션 후 저장
      if (needsMigration) {
        await persist();
      }
    }
    if (state.equipments.length === 0) {
      const eq = newEquipment();
      state.equipments.push(eq);
      state.selectedId = eq.id;
    } else {
      // URL 파라미터에서 설비 ID 확인
      const urlParams = new URLSearchParams(window.location.search);
      const equipmentId = urlParams.get('id');
      if (equipmentId) {
        // URL에서 전달된 ID로 설비 찾기
        const found = state.equipments.find(e => e.id === equipmentId);
        if (found) {
          state.selectedId = equipmentId;
        } else {
          // ID로 찾지 못하면 시리얼 번호로 시도 (문서 ID가 시리얼 번호인 경우)
          const foundBySerial = state.equipments.find(e => {
            const serialId = generateIdFromSerial(e.serialNo);
            return serialId === equipmentId || e.serialNo === equipmentId;
          });
          if (foundBySerial) {
            state.selectedId = foundBySerial.id;
          } else {
            state.selectedId = state.equipments[0].id;
          }
        }
      } else {
        state.selectedId = state.equipments[0].id;
      }
    }
    // Initialize previous serial and last-saved snapshots for safety
    try {
      state.prevSerialMap = new Map();
      state.lastSavedMap = new Map();
      (state.equipments || []).forEach(eq => {
        if (!eq) return;
        state.prevSerialMap.set(eq.id, eq.serialNo || '');
        state.lastSavedMap.set(eq.id, serializeEqForCompare(eq));
      });
    } catch(_) {}
    if (els.histDate) els.histDate.value = today();
  }
  function current() {
    return state.equipments.find((e) => e.id === state.selectedId) || null;
  }
  function hasUnsavedChanges() {
    try {
      // Prefer precise snapshot comparison over flag to avoid false positives
      const targets = state.hydratedScope === 'single' ? [current()].filter(Boolean) : (state.equipments || []);
      for (const eq of targets) {
        if (!eq) continue;
        const snap = serializeEqForCompare(eq);
        const last = state.lastSavedMap ? state.lastSavedMap.get(eq.id) : undefined;
        if (snap !== last) return true;
      }
      return false;
    } catch(_) {
      return !!state.isDirty;
    }
  }
  function queueAutosave() {
    // Autosave disabled: mark dirty only
    try { if (state.autosaveTimer) { clearTimeout(state.autosaveTimer); state.autosaveTimer = null; } } catch(_) {}
    state.isDirty = true;
  }
  async function forceSave(trigger = "manual") {
    if (!state.edit) {
      notify('로그인 후에만 저장할 수 있습니다.', 'error');
      return;
    }
    if (manualSaveInProgress) {
      notify('저장을 진행 중입니다...', 'info');
      return;
    }
    if (state.autosaveTimer) {
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = null;
    }
    manualSaveInProgress = true;
    try {
      if (trigger === 'shortcut') showProgress('저장 중…');
      else notify('저장 중입니다...', 'info');
      await persist();
      state.isDirty = false;
      if (trigger === 'shortcut') {
        showProgressDone();
        hideProgressSoon(900);
      } else {
        notify('저장이 완료되었습니다.', 'success');
      }
    } catch (e) {
      console.error('강제 저장 실패:', e);
      if (trigger === 'shortcut') {
        showProgressError('저장 실패');
        hideProgressSoon(1300);
      } else {
        notify('저장 중 오류가 발생했습니다.', 'error');
      }
    } finally {
      manualSaveInProgress = false;
    }
  }
  function handleGlobalShortcuts(e) {
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 's') {
      e.preventDefault();
      if (!state.edit) { notify('로그인 후에만 저장할 수 있습니다.', 'error'); return; }
      if (!hasUnsavedChanges()) { notify('변경사항이 없습니다.', 'info'); return; }
      // 단축키 저장: 확인 없이 즉시 저장
      forceSave('shortcut');
    }
  }

  // Validation
  function validateRequired() {
    const eq = current();
    if (!eq) return false;
    const missing = [];
    if (!eq.model) missing.push("Model");
    if (!eq.serialNo) missing.push("Serial No.");
    if (!eq.codeNo) missing.push("Code No.");
    if (!eq.category) missing.push("구분");
    if (!eq.installDate) missing.push("설치일");
    if (!eq.calibrationDate) missing.push("정도검사일");
    // 비고는 선택 사항입니다.
    // 위치 대분류 필수
    const loc = parseLocation(eq.location || "");
    if (!loc.major) missing.push("위치(대분류)");
    if (missing.length) {
      alert("필수 항목 누락: " + missing.join(", "));
      return false;
    }
    return true;
  }

  // Escaping
  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  }

  function activateTab(tabName, buttons, contentEl) {
    const tabButtons = buttons || document.querySelectorAll('.tab-button');
    const tabsContent = contentEl || document.querySelector('.tabs-content');
    tabButtons.forEach(btn => {
      const isTarget = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', isTarget);
    });
    if (tabsContent) {
      tabsContent.setAttribute('data-active-tab', tabName);
    }
  }

  function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabsContent = document.querySelector('.tabs-content');
    
    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        const tabName = button.getAttribute('data-tab');
        activateTab(tabName, tabButtons, tabsContent);
      });
    });
    
    activateTab('overview', tabButtons, tabsContent);
  }

  // 인증 완료를 기다리는 함수
  async function waitForAuth() {
    // 이미 인증된 경우 즉시 반환
    if (window.currentUser) {
      return Promise.resolve();
    }
    
    // 인증 상태 변경 이벤트를 기다림
    return new Promise((resolve) => {
      // 이미 인증된 경우
      if (window.currentUser) {
        resolve();
        return;
      }
      
      // 인증 상태 변경 이벤트 리스너
      const checkAuth = () => {
        if (window.currentUser) {
          resolve();
        }
      };
      
      // 즉시 한 번 확인
      checkAuth();
      
      // 이벤트 리스너 등록
      window.addEventListener('auth-state-changed', function handler(e) {
        if (e?.detail?.user) {
          window.removeEventListener('auth-state-changed', handler);
          resolve();
        }
      });
      
      // 최대 5초 대기 (타임아웃)
      setTimeout(() => {
        resolve(); // 타임아웃 시에도 진행
      }, 5000);
    });
  }

  async function init() {
    bindElements();
    
    // 인증 완료를 기다린 후 데이터 로드
    await waitForAuth();
    await hydrate();
    
    // 창 닫기/새로고침 시 변경사항 확인
    window.addEventListener('beforeunload', (e) => {
      try {
        if (state.edit && hasUnsavedChanges()) {
          e.preventDefault();
          e.returnValue = '';
          return '';
        }
      } catch(_) {}
      return undefined;
    });
    // DOM 구조 설정을 먼저 수행
    try { setupTabs(); } catch(_) {}
    try { adjustSpecsPanel(); } catch(_) {}
    try { ensureAccessoriesSerialHeader(); } catch(_) {}
    try { ensureAccessoriesCategoryHeader(); } catch(_) {}
    try { ensureAccessoriesAssetCodeHeader(); } catch(_) {}
    try { ensureHistoryAddUI(); } catch(_) {}
    // Password modal removed: Firebase Authentication is used instead
    try { setupLinkedAssetsSortControls(); } catch(_) {}
    attachEvents();
    // 렌더링을 requestAnimationFrame으로 지연시켜 초기 렌더링 블로킹 방지
    requestAnimationFrame(() => {
      renderAll();
      applyMode();
    });
    // Reflect Firebase Auth state in UI/editing mode
    try {
      const u = window.currentUser;
      if (u) {
        state.edit = true;
        // currentUser는 email로 저장 (users 컬렉션에서 name을 찾기 위해)
        state.currentUser = (u.email || '').trim() || null;
        applyMode(false);
      }
      window.addEventListener('auth-state-changed', (e) => {
        const user = e?.detail?.user || null;
        state.edit = !!user;
        // currentUser는 email로 저장 (users 컬렉션에서 name을 찾기 위해)
        state.currentUser = user ? ((user.email || '').trim() || null) : null;
        applyMode();
      });
    } catch(_) {}
    // Modal close events
    if (els.photoModal) {
      els.photoModal.addEventListener('click', (e) => {
        if (e.target === els.modalClose || e.target.classList.contains('modal-backdrop') || e.target.dataset.close === '1') {
          closePhotoModal();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePhotoModal();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
  // Photo description modal
  function ensurePhotoMetaModal() {
    if (!document.getElementById('photoMetaModal')) {
      const modal = document.createElement('div');
      modal.id = 'photoMetaModal';
      modal.className = 'modal';
      modal.setAttribute('aria-hidden','true');
      modal.innerHTML = `
        <div class="modal-backdrop" data-close="1"></div>
        <div class="modal-content" role="dialog" aria-modal="true" aria-label="사진 설명 입력">
          <div class="form-grid" style="width:min(90vw,480px)">
            <h2>사진 설명</h2>
            <p class="helper">사진에 대한 설명을 입력해 주세요.</p>
            <label class="full required">사진설명
              <input id="photoDescInput" type="text" aria-describedby="errPhotoDesc" placeholder="예) 설치 전면 사진" />
              <small id="errPhotoDesc" class="error-text" aria-live="polite"></small>
            </label>
            <div class="form-actions">
              <button id="photoMetaCancel" class="btn-sm" type="button">취소</button>
              <button id="photoMetaConfirm" class="btn-sm btn-primary" type="button">저장</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target.dataset.close === '1') closePhotoMetaModal(); });
      document.addEventListener('keydown', (e) => {
        if (modal.classList.contains('show') && e.key === 'Escape') closePhotoMetaModal();
        if (modal.classList.contains('show') && e.key === 'Enter') document.getElementById('photoMetaConfirm')?.click();
      });
      document.getElementById('photoMetaCancel').addEventListener('click', closePhotoMetaModal);
      document.getElementById('photoMetaConfirm').addEventListener('click', handlePhotoMetaConfirm);
    }
  }
  function openPhotoMetaModal(prefill = '') {
    ensurePhotoMetaModal();
    const modal = document.getElementById('photoMetaModal');
    const input = document.getElementById('photoDescInput');
    const err = document.getElementById('errPhotoDesc');
    if (!modal || !input) return;
    input.value = prefill || '';
    input.setAttribute('aria-invalid', 'false');
    if (err) err.textContent = '';
    modal.setAttribute('aria-hidden','false');
    modal.classList.add('show');
    setTimeout(() => input.focus(), 100);
  }
  function closePhotoMetaModal() {
    const modal = document.getElementById('photoMetaModal');
    if (!modal) return;
    modal.setAttribute('aria-hidden','true');
    modal.classList.remove('show');
    // clear pending on cancel
    if (state && state.pendingPhoto) state.pendingPhoto = null;
  }
  function handlePhotoMetaConfirm() {
    const input = document.getElementById('photoDescInput');
    const err = document.getElementById('errPhotoDesc');
    const desc = (input?.value || '').trim();
    if (!desc) {
      if (input) input.setAttribute('aria-invalid','true');
      if (err) err.textContent = '사진설명을 입력해 주세요.';
      notify('사진설명은 필수입니다.', 'error');
      return;
    }
    if (input) input.setAttribute('aria-invalid','false');
    if (err) err.textContent = '';
    const eq = current(); if (!eq) { closePhotoMetaModal(); return; }
    if (!Array.isArray(eq.photos)) eq.photos = [];
    eq.photos = eq.photos.filter(Boolean);
    const MAX_PHOTOS = 12;
    const idx = Number.isInteger(state.pendingPhoto?.index) ? state.pendingPhoto.index : eq.photos.length;
    // 새 사진 추가 시 12개 제한 체크
    if (idx >= eq.photos.length && eq.photos.length >= MAX_PHOTOS) {
      notify(`사진은 최대 ${MAX_PHOTOS}개까지 추가할 수 있습니다.`, 'error');
      closePhotoMetaModal();
      return;
    }
    const now = new Date().toISOString();
    const by = state.currentUser || '';
    const payload = { url: state.pendingPhoto?.dataURL || '', desc, createdAt: now, createdBy: by };
    if (idx >= eq.photos.length) eq.photos.push(payload); else eq.photos[idx] = payload;
    eq.photoCode = now;
    state.pendingPhoto = null;
    renderPhotos(eq.photos);
    queueAutosave();
    closePhotoMetaModal();
  }
  function ensureAccessoriesSerialHeader() {
    const row = document.querySelector('.panel-accessories thead tr, .accessories-page thead tr');
    if (!row) return;
    const ths = row.querySelectorAll('th');
    const hasSerial = Array.from(ths).some(th => /시리얼/.test(th.textContent));
    if (!hasSerial) {
      const th = document.createElement('th');
      th.setAttribute('scope','col');
      th.textContent = '시리얼번호';
      const afterCode = ths[1];
      if (afterCode && ths[2]) row.insertBefore(th, ths[2]);
      else row.appendChild(th);
    }
  }
  function ensureAccessoriesCategoryHeader() {
    const row = document.querySelector('.panel-accessories thead tr, .accessories-page thead tr');
    if (!row) return;
    const ths = row.querySelectorAll('th');
    const hasCat = Array.from(ths).some(th => /구분/.test(th.textContent));
    if (!hasCat) {
      const th = document.createElement('th');
      th.setAttribute('scope','col');
      th.textContent = '구분';
      if (ths[0]) row.insertBefore(th, ths[0]); else row.appendChild(th);
    }
  }
  function ensureAccessoriesAssetCodeHeader() {
    const row = document.querySelector('.panel-accessories thead tr, .accessories-page thead tr');
    if (!row) return;
    const ths = row.querySelectorAll('th');
    const hasAssetCode = Array.from(ths).some(th => /자산코드/.test(th.textContent));
    if (!hasAssetCode) {
      // 구분 헤더 찾기
      let categoryIndex = -1;
      ths.forEach((th, idx) => {
        if (/구분/.test(th.textContent)) {
          categoryIndex = idx;
        }
      });
      const th = document.createElement('th');
      th.setAttribute('scope','col');
      th.textContent = '자산코드';
      if (categoryIndex >= 0 && ths[categoryIndex + 1]) {
        // 구분 다음에 삽입
        row.insertBefore(th, ths[categoryIndex + 1]);
      } else if (categoryIndex >= 0) {
        // 구분이 마지막이면 그 다음에 추가
        row.appendChild(th);
      } else if (ths[0]) {
        // 구분이 없으면 첫 번째에 추가 (구분이 나중에 추가될 수 있으므로)
        row.insertBefore(th, ths[0]);
      } else {
        row.appendChild(th);
      }
    }
  }

  // === Accessories: Asset search/select & unlink ===
  async function fetchAccAssets(force = false) {
    if (!force && Array.isArray(state.accAssetsCache)) return state.accAssetsCache;
    const lite = (window && window.firebaseLite) || null;
    const db = (window && window.firebaseDb) || null;
    if (!lite || !db) {
      throw new Error('자산 검색 기능 초기화 실패(Firebase 미로딩)');
    }
    const assetsCol = lite.collection(db, 'assets');
    const snapshot = await lite.getDocs(assetsCol);
    const all = [];
    snapshot.forEach(docSnap => {
      const a = docSnap.data();
      // 정규화 (assets.html과 동일 형태 일부만 사용)
      const loc = a.location || {};
      all.push({
        assetNo: a.assetNo || docSnap.id,
        name: a.name || '',
        codeNo: a.codeNo || '',
        serialNo: a.serialNo || '',
        mkcCode: a.mkcCode || '',
        status: a.status || 'normal',
        assetType: a.assetType || '',
        linkedEquipment: a.linkedEquipment || null,
        location: { region: loc.region || '', major: loc.major || '', middle: loc.middle || '', sub: loc.sub || '' }
      });
    });
    state.accAssetsCache = all;
    return all;
  }
  function openAccAssetModal() {
    if (!els.accAssetModal) return;
    els.accAssetModal.classList.add('show');
    els.accAssetModal.setAttribute('aria-hidden','false');
    // 초기 로드 및 결과 렌더
    (async () => {
      try {
        const list = await fetchAccAssets();
        renderAccSearchResults(list, '');
      } catch (e) {
        notify(String(e), 'error');
      }
    })();
    if (els.accSearchInput && !els.accSearchInput._wired) {
      els.accSearchInput._wired = true;
      els.accSearchInput.addEventListener('input', () => {
        const q = els.accSearchInput.value || '';
        renderAccSearchResults(state.accAssetsCache || [], q);
      });
    }
    if (els.accSearchClose && !els.accSearchClose._wired) {
      els.accSearchClose._wired = true;
      els.accSearchClose.addEventListener('click', closeAccAssetModal);
    }
    els.accAssetModal.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.close === '1') closeAccAssetModal();
    });
  }
  function closeAccAssetModal() {
    if (!els.accAssetModal) return;
    els.accAssetModal.classList.remove('show');
    els.accAssetModal.setAttribute('aria-hidden','true');
    if (els.accSearchInput) els.accSearchInput.value = '';
    if (els.accSearchResults) els.accSearchResults.innerHTML = '';
  }
  function filterAssetByQuery(list, q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return list;
    return list.filter(a => {
      return (a.assetNo || '').toLowerCase().includes(s)
        || (a.mkcCode || '').toLowerCase().includes(s)
        || (a.name || '').toLowerCase().includes(s)
        || (a.codeNo || '').toLowerCase().includes(s)
        || (a.serialNo || '').toLowerCase().includes(s);
    });
  }
  function renderAccSearchResults(list, q) {
    if (!els.accSearchResults) return;
    const filtered = filterAssetByQuery(list || [], q);
    // 기본 정렬: 자산명 -> 자산코드
    const sorted = [...filtered].sort((a, b) => {
      const an = (a.name || '').toLowerCase();
      const bn = (b.name || '').toLowerCase();
      if (an !== bn) return an.localeCompare(bn, 'ko');
      return String(a.assetNo || '').localeCompare(String(b.assetNo || ''), 'ko', { numeric: true });
    });
    // build rows
    const frag = document.createDocumentFragment();
    if (!sorted.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = '검색 결과가 없습니다.';
      tr.appendChild(td);
      frag.appendChild(tr);
    } else {
      sorted.forEach(a => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td title="${escapeHtml(a.name)}" class="truncate">${escapeHtml(a.name)}</td>
          <td title="${escapeHtml(a.codeNo)}" class="truncate">${escapeHtml(a.codeNo)}</td>
          <td title="${escapeHtml(a.serialNo)}" class="truncate">${escapeHtml(a.serialNo)}</td>
          <td title="${escapeHtml(a.assetNo)}" class="truncate mono">${escapeHtml(a.assetNo)}</td>
          <td title="${escapeHtml(a.mkcCode)}" class="truncate mono">${escapeHtml(a.mkcCode)}</td>
          <td class="table-actions"><button class="btn-sm" data-action="pickAsset" data-asset-no="${escapeHtml(a.assetNo)}" type="button">선택</button></td>
        `;
        frag.appendChild(tr);
      });
    }
    els.accSearchResults.innerHTML = '';
    els.accSearchResults.appendChild(frag);
    els.accSearchResults.onclick = async (e) => {
      const btn = e.target.closest('button[data-action="pickAsset"]');
      if (!btn) return;
      const assetNo = btn.getAttribute('data-asset-no');
      try {
        await linkAssetToEquipment(assetNo);
        closeAccAssetModal();
      } catch (err) {
        notify(String(err), 'error');
      }
    };
  }
  function getAssetFromCache(assetNo) {
    const list = state.accAssetsCache || [];
    return list.find(a => a.assetNo === assetNo) || null;
  }
  async function linkAssetToEquipment(assetNo) {
    const eq = current();
    if (!eq) throw new Error('설비가 선택되지 않았습니다.');
    if (!assetNo) throw new Error('자산번호가 유효하지 않습니다.');
    if (!Array.isArray(eq.accessories)) eq.accessories = [];
    if (eq.accessories.some(r => r && r.assetNo === assetNo)) {
      throw new Error('이미 연결된 자산입니다.');
    }
    // 자산 정보 조회
    const a = getAssetFromCache(assetNo) || (await (async () => {
      const all = await fetchAccAssets(true);
      return all.find(x => x.assetNo === assetNo) || null;
    })());
    if (!a) throw new Error('자산 정보를 찾을 수 없습니다.');
    // 설비 위치를 자산 위치에 반영 (매핑 규칙):
    // 설비 대분류 -> 자산 지역, 설비 중분류 -> 자산 대분류, 설비 소분류 -> 자산 중분류, 자산 소분류 -> '설비이름 에 설치'
    const eqLoc = parseLocation(eq.location || '');
    const subInstall = `${eq.model || '설비'} 에 설치`;
    const newLoc = {
      region: eqLoc.major || '',
      major: eqLoc.middle || '',
      middle: eqLoc.minor || '',
      sub: subInstall
    };
    // Firestore 업데이트
    const lite = window.firebaseLite;
    const db = window.firebaseDb;
    if (!lite || !db) throw new Error('Firebase 미초기화');
    const assetsCol = lite.collection(db, 'assets');
    await lite.setDoc(lite.doc(assetsCol, assetNo), { location: newLoc }, { merge: true });
    // 설비 부속품 목록에 추가 (스냅샷 보관)
    eq.accessories.push({
      id: uid(),
      assetNo,
      category: '옵션사양',
      assetCode: a.mkcCode || '',
      name: a.name || '',
      code: a.codeNo || '',
      serial: a.serialNo || '',
      qty: 1,
      note: ''
    });
    renderAccessories(eq.accessories);
    queueAutosave();
    notify('자산이 연결되었습니다.', 'success');
    try { await forceSave('shortcut'); } catch(_) {}
  }
  function openAccUnlinkModal(ctx) {
    if (!els.accUnlinkModal) return;
    state.pendingUnlink = ctx; // { rowId, assetNo }
    // 프리필: 기존 자산 위치가 캐시에 있으면 넣기
    const a = ctx && ctx.assetNo ? getAssetFromCache(ctx.assetNo) : null;
    if (a && a.location) {
      if (els.accUnlinkRegion) els.accUnlinkRegion.value = a.location.region || '';
      if (els.accUnlinkMajor) els.accUnlinkMajor.value = a.location.major || '';
      if (els.accUnlinkMiddle) els.accUnlinkMiddle.value = a.location.middle || '';
      if (els.accUnlinkSub) els.accUnlinkSub.value = a.location.sub || '';
    } else {
      if (els.accUnlinkRegion) els.accUnlinkRegion.value = '';
      if (els.accUnlinkMajor) els.accUnlinkMajor.value = '';
      if (els.accUnlinkMiddle) els.accUnlinkMiddle.value = '';
      if (els.accUnlinkSub) els.accUnlinkSub.value = '';
    }
    els.accUnlinkModal.classList.add('show');
    els.accUnlinkModal.setAttribute('aria-hidden','false');
    if (els.accUnlinkCancel && !els.accUnlinkCancel._wired) {
      els.accUnlinkCancel._wired = true;
      els.accUnlinkCancel.addEventListener('click', closeAccUnlinkModal);
    }
    if (els.accUnlinkConfirm && !els.accUnlinkConfirm._wired) {
      els.accUnlinkConfirm._wired = true;
      els.accUnlinkConfirm.addEventListener('click', confirmAccUnlink);
    }
    els.accUnlinkModal.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.close === '1') closeAccUnlinkModal();
    });
  }
  function closeAccUnlinkModal() {
    if (!els.accUnlinkModal) return;
    els.accUnlinkModal.classList.remove('show');
    els.accUnlinkModal.setAttribute('aria-hidden','true');
    state.pendingUnlink = null;
  }
  async function confirmAccUnlink() {
    const ctx = state.pendingUnlink;
    if (!ctx) { closeAccUnlinkModal(); return; }
    const region = (els.accUnlinkRegion?.value || '').trim();
    const major = (els.accUnlinkMajor?.value || '').trim();
    const middle = (els.accUnlinkMiddle?.value || '').trim();
    const sub = (els.accUnlinkSub?.value || '').trim();
    // Firestore 자산 위치 업데이트
    try {
      const lite = window.firebaseLite;
      const db = window.firebaseDb;
      if (!lite || !db) throw new Error('Firebase 미초기화');
      const assetsCol = lite.collection(db, 'assets');
      await lite.setDoc(lite.doc(assetsCol, ctx.assetNo), { location: { region, major, middle, sub } }, { merge: true });
    } catch (e) {
      notify('자산 위치 업데이트 실패: ' + String(e), 'error');
      // 계속 진행 여부는 요구사항에 따라 다를 수 있음. 여기서는 실패 시 중단.
      return;
    }
    // 설비 부속품 목록에서 제거
    const eq = current();
    if (eq && Array.isArray(eq.accessories)) {
      const idx = eq.accessories.findIndex(r => r && r.id === ctx.rowId);
      if (idx >= 0) {
        eq.accessories.splice(idx, 1);
        renderAccessories(eq.accessories);
        queueAutosave();
      }
    }
    notify('자산 연결이 해제되었습니다.', 'success');
    try { await forceSave('shortcut'); } catch(_) {}
    closeAccUnlinkModal();
  }
  function ensureHistoryAddUI() {
    const histPanel = document.querySelector('.panel-history');
    if (!histPanel) return;
    const header = histPanel.querySelector('h2');
    // 대시보드용 버튼 ID는 별도로 사용 (전용 탭 버튼과 구분)
    if (header && !header.querySelector('#btnOpenHistModalOverview')) {
      const btn = document.createElement('button');
      btn.id = 'btnOpenHistModalOverview';
      btn.className = 'btn-sm btn-primary';
      btn.type = 'button';
      btn.textContent = '이력추가';
      header.appendChild(btn);
      btn.addEventListener('click', openHistModal);
    }
    if (!document.getElementById('histModal')) {
      const modal = document.createElement('div');
      modal.id = 'histModal';
      modal.className = 'modal';
      modal.setAttribute('aria-hidden','true');
      modal.innerHTML = `
        <div class="modal-backdrop" data-close="1"></div>
        <div class="modal-content" role="dialog" aria-modal="true" aria-label="이력 추가">
          <div class="form-grid">
            <h2>이력 추가</h2>
            <p class="helper">날짜, 유형, 내용, 작성자를 모두 입력해 주세요.</p>
            <label class="required">날짜
              <div style="display:flex; gap:8px; align-items:center;">
                <input id="histModalDate" type="date" aria-describedby="errHistDate" style="flex:1;" />
                <button id="histModalDateToday" class="btn-sm" type="button">오늘</button>
              </div>
              <small id="errHistDate" class="error-text" aria-live="polite"></small>
            </label>
            <label class="required full" style="display:block;">
              <div style="font-weight:600; margin-bottom:6px;">유형</div>
              <div role="radiogroup" aria-label="이력 유형 선택" id="histModalTypeGroup" class="toggle-table">
                <div class="toggle-row">
                  <div class="toggle-head">트러블</div>
                  <div class="toggle-cell">
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="error" /><span>에러발생</span></label>
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="hardware_failure" /><span>하드웨어 고장</span></label>
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="software_bug" /><span>소프트웨어 버그</span></label>
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="damage" /><span>파손</span></label>
                  </div>
                </div>
                <div class="toggle-row">
                  <div class="toggle-head">입출고</div>
                  <div class="toggle-cell">
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="inbound" /><span>입고</span></label>
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="outbound" /><span>출고</span></label>
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="clamp" /><span>클램프</span></label>
                  </div>
                </div>
                <div class="toggle-row">
                  <div class="toggle-head">서비스</div>
                  <div class="toggle-cell">
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="calibration" /><span>정도검사</span></label>
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="repair" /><span>수리</span></label>
                    <label class="toggle-pill"><input type="radio" name="histModalType" value="inspection" /><span>점검</span></label>
                  <label class="toggle-pill"><input type="radio" name="histModalType" value="option_change" /><span>옵션변경</span></label>
                  </div>
                </div>
              </div>
              <small id="errHistType" class="error-text" aria-live="polite"></small>
            </label>
            <label class="full required">내용
              <input id="histModalDesc" type="text" placeholder="무엇이 있었는지 간단히 입력" aria-describedby="errHistDesc" />
              <small id="errHistDesc" class="error-text" aria-live="polite"></small>
            </label>
            <label class="required">작성자
              <input id="histModalUser" type="text" placeholder="이름" aria-describedby="errHistUser" />
              <small id="errHistUser" class="error-text" aria-live="polite"></small>
            </label>
            <div class="form-actions">
              <button id="histModalDelete" class="btn-sm btn-danger" type="button" style="display:none;">삭제</button>
              <div style="flex:1;"></div>
              <button id="histModalCancel" class="btn-sm" type="button">취소</button>
              <button id="histModalConfirm" class="btn-sm btn-primary" type="button">추가</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modal);
      // Wire up modal actions
      modal.addEventListener('click', (e) => {
        if (e.target.dataset.close === '1') closeHistModal();
      });
      document.addEventListener('keydown', (e) => {
        if (modal.classList.contains('show') && e.key === 'Escape') closeHistModal();
        if (modal.classList.contains('show') && e.key === 'Enter') {
          const active = document.activeElement;
          if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) {
            e.preventDefault();
            document.getElementById('histModalConfirm')?.click();
          }
        }
      });
      const cancel = document.getElementById('histModalCancel');
      const confirmBtn = document.getElementById('histModalConfirm');
      const deleteBtn = document.getElementById('histModalDelete');
      const dateTodayBtn = document.getElementById('histModalDateToday');
      cancel && cancel.addEventListener('click', closeHistModal);
      dateTodayBtn && dateTodayBtn.addEventListener('click', () => {
        const dateEl = document.getElementById('histModalDate');
        if (dateEl) {
          dateEl.value = today();
          dateEl.setAttribute('aria-invalid','false');
          const e = document.getElementById('errHistDate');
          if (e) e.textContent = '';
        }
      });
      confirmBtn && confirmBtn.addEventListener('click', async () => {
        const eq = current(); if (!eq) return;
        const modal = document.getElementById('histModal');
        const historyId = modal?.dataset.historyId;
        const isEditMode = !!historyId;
        
        const dateEl = document.getElementById('histModalDate');
        const typeEl = document.querySelector('input[name="histModalType"]:checked');
        const descEl = document.getElementById('histModalDesc');
        const userEl = document.getElementById('histModalUser');
        const date = (dateEl.value || '').trim();
        const type = typeEl ? (typeEl.value || '').trim() : '';
        const desc = (descEl.value || '').trim();
        let user = (userEl.value || '').trim();
        const errDate = document.getElementById('errHistDate');
        const errType = document.getElementById('errHistType');
        const errDesc = document.getElementById('errHistDesc');
        const errUser = document.getElementById('errHistUser');
        let ok = true;
        if (!date) { dateEl.setAttribute('aria-invalid','true'); if (errDate) errDate.textContent = '날짜를 입력해 주세요.'; ok = false; } else { dateEl.setAttribute('aria-invalid','false'); if (errDate) errDate.textContent = ''; }
        if (!type) { if (errType) errType.textContent = '유형을 선택해 주세요.'; ok = false; } else { if (errType) errType.textContent = ''; }
        if (!desc) { descEl.setAttribute('aria-invalid','true'); if (errDesc) errDesc.textContent = '내용을 입력해 주세요.'; ok = false; } else { descEl.setAttribute('aria-invalid','false'); if (errDesc) errDesc.textContent = ''; }
        if (!user) { userEl.setAttribute('aria-invalid','true'); if (errUser) errUser.textContent = '작성자를 입력해 주세요.'; ok = false; } else { userEl.setAttribute('aria-invalid','false'); if (errUser) errUser.textContent = ''; }
        if (!ok) { notify('필수 항목을 확인해 주세요.', 'error'); return; }
        
        // user 값이 email 형식이면 users 컬렉션에서 name을 찾아서 저장
        // user 값이 name이면 그대로 저장
        if (user && user.includes('@')) {
          // email인 경우, users 컬렉션에서 name을 찾아서 저장
          const name = await getUserNameByEmail(user);
          if (name && name !== user) {
            console.log(`[History ${isEditMode ? 'Edit' : 'Add'}] email "${user}"을 name "${name}"으로 변환하여 저장`);
            user = name;
          } else {
            console.warn(`[History ${isEditMode ? 'Edit' : 'Add'}] email "${user}"에 해당하는 name을 찾을 수 없습니다. email을 그대로 저장합니다.`);
          }
        }
        
        if (isEditMode) {
          // 수정 모드: 기존 이력 업데이트
          const historyItem = eq.history.find(h => h.id === historyId);
          if (historyItem) {
            historyItem.date = date;
            historyItem.type = type;
            historyItem.desc = desc;
            historyItem.user = user;
            console.log(`[History Edit] 이력 수정: id = "${historyId}", user = "${user}" (name으로 저장됨)`);
          }
        } else {
          // 추가 모드: 새 이력 추가
          eq.history.push({ id: uid(), date, type, desc, user });
          console.log(`[History Add] 이력 추가: user = "${user}" (name으로 저장됨)`);
        }
        
        // 점검완료로 인한 이력 추가인 경우 마지막 점검일 갱신
        const taskId = modal?.dataset.taskId;
        if (taskId) {
          const taskRow = eq.tasks.find((r) => r.id === taskId);
          if (taskRow) {
            taskRow.lastCheck = date;
            taskRow.nextCheck = calculateNextCheck(taskRow.lastCheck, taskRow.periodYear, taskRow.periodMonth, taskRow.periodDay);
            renderTasks(eq.tasks);
            try { renderTasksOverview(eq.tasks); } catch(_) {}
            console.log(`[Task Check] 점검완료: task id = "${taskId}", lastCheck = "${date}"`);
            delete modal.dataset.taskId;
          }
        }
        
        // 정도검사 이력인 경우 마지막 정도검사 날짜 및 정기점검 업데이트
        if (type === 'calibration' && date) {
          const currentCalibDate = eq.calibrationDate || '';
          // 날짜 비교: date가 현재 calibrationDate보다 최근이거나 calibrationDate가 없는 경우
          if (!currentCalibDate || date > currentCalibDate) {
            eq.calibrationDate = date;

            // 설비정보 탭의 마지막 정도검사 필드 업데이트
            if (els.reqCalibrationDate) {
              els.reqCalibrationDate.value = date;
            }
            const reqCalibrationDateView = document.getElementById('reqCalibrationDateView');
            if (reqCalibrationDateView) {
              reqCalibrationDateView.textContent = date || '-';
            }

            // 정기점검 리스트에서 '정도검사' 작업 찾아서 마지막 점검일 갱신
            if (Array.isArray(eq.tasks)) {
              eq.tasks.forEach(task => {
                if (task.title === '정도검사') {
                  task.lastCheck = date;
                  // 다음 점검일 재계산
                  if (task.periodYear || task.periodMonth || task.periodDay) {
                    task.nextCheck = calculateNextCheck(date, task.periodYear || 0, task.periodMonth || 0, task.periodDay || 0);
                  }
                }
              });
            }

            // UI 업데이트 (요약 정보 갱신)
            try { renderSummary(); } catch (_) { }
            try { renderTasks(eq.tasks); } catch (_) { }
            try { renderTasksOverview(eq.tasks); } catch (_) { }
          }
        }
        
        renderHistory(eq.history);
        // 상태 변경이 대기 중이면 함께 적용
        if (state.pendingStatusChange) {
          eq.status = state.pendingStatusChange.newStatus;
          renderStatus(eq.status);
          state.pendingStatusChange = null;
        }
        closeHistModal();
        // 즉시 저장
        try {
          showProgress('저장 중…');
          await persist();
          state.isDirty = false;
          showProgressDone();
          hideProgressSoon(900);
        } catch(_) {
          queueAutosave();
          showProgressError('저장 실패');
          hideProgressSoon(1300);
        }
      });
      deleteBtn && deleteBtn.addEventListener('click', async () => {
        const eq = current(); if (!eq) return;
        const modal = document.getElementById('histModal');
        const historyId = modal?.dataset.historyId;
        if (!historyId) return;
        
        if (!window.confirm('이 이력을 삭제하시겠습니까?')) return;
        
        const index = eq.history.findIndex(h => h.id === historyId);
        if (index !== -1) {
          eq.history.splice(index, 1);
          console.log(`[History Delete] 이력 삭제: id = "${historyId}"`);
          renderHistory(eq.history);
          closeHistModal();
          // 즉시 저장
          try {
            showProgress('저장 중…');
            await persist();
            state.isDirty = false;
            showProgressDone();
            hideProgressSoon(900);
          } catch(_) {
            queueAutosave();
            showProgressError('저장 실패');
            hideProgressSoon(1300);
          }
        }
      });
    }
  }
  function openHistModal(historyId) {
    const modal = document.getElementById('histModal');
    if (!modal) return;
    const eq = current();
    if (!eq) return;
    
    const dateEl = document.getElementById('histModalDate');
    const typeEls = document.querySelectorAll('input[name="histModalType"]');
    const descEl = document.getElementById('histModalDesc');
    const userEl = document.getElementById('histModalUser');
    const titleEl = modal.querySelector('h2');
    const confirmBtn = document.getElementById('histModalConfirm');
    const deleteBtn = document.getElementById('histModalDelete');
    const modalContent = modal.querySelector('.modal-content');
    
    // 수정 모드인지 확인
    const isEditMode = historyId && eq.history;
    let historyItem = null;
    if (isEditMode) {
      historyItem = eq.history.find(h => h.id === historyId);
    }
    
    // 모달 타이틀 및 버튼 텍스트 변경
    if (isEditMode && historyItem) {
      if (titleEl) titleEl.textContent = '이력 수정';
      if (confirmBtn) confirmBtn.textContent = '수정';
      if (deleteBtn) deleteBtn.style.display = 'block';
      if (modalContent) modalContent.setAttribute('aria-label', '이력 수정');
      modal.dataset.historyId = historyId;
      
      // 기존 데이터로 폼 채우기
      if (dateEl) { dateEl.value = historyItem.date || today(); dateEl.setAttribute('aria-invalid','false'); const e = document.getElementById('errHistDate'); if (e) e.textContent=''; }
      if (typeEls && typeEls.length) { 
        typeEls.forEach(r => r.checked = (r.value === historyItem.type)); 
        const e = document.getElementById('errHistType'); 
        if (e) e.textContent=''; 
      }
      if (descEl) { descEl.value = historyItem.desc || ''; descEl.setAttribute('aria-invalid','false'); const e = document.getElementById('errHistDesc'); if (e) e.textContent=''; }
      if (userEl) { 
        userEl.value = historyItem.user || ''; 
        userEl.setAttribute('aria-invalid','false'); 
        const e = document.getElementById('errHistUser'); 
        if (e) e.textContent=''; 
      }
    } else {
      // 추가 모드
      if (titleEl) titleEl.textContent = '이력 추가';
      if (confirmBtn) confirmBtn.textContent = '추가';
      if (deleteBtn) deleteBtn.style.display = 'none';
      if (modalContent) modalContent.setAttribute('aria-label', '이력 추가');
      delete modal.dataset.historyId;
      
      // 폼 초기화
      if (dateEl) { dateEl.value = ''; dateEl.setAttribute('aria-invalid','false'); const e = document.getElementById('errHistDate'); if (e) e.textContent=''; }
      if (typeEls && typeEls.length) { typeEls.forEach(r => r.checked = false); const e = document.getElementById('errHistType'); if (e) e.textContent=''; }
      if (descEl) { descEl.value = ''; descEl.setAttribute('aria-invalid','false'); const e = document.getElementById('errHistDesc'); if (e) e.textContent=''; }
      // 작성자는 로그인한 경우에만 자동 설정 (users 컬렉션에서 name을 찾아서 설정)
      if (userEl) {
        if (state.edit && state.currentUser) {
          // state.currentUser는 email이므로, users 컬렉션에서 name을 찾아서 표시
          getUserNameByEmail(state.currentUser).then(name => {
            if (userEl) {
              userEl.value = name || state.currentUser;
            }
          });
        } else {
          userEl.value = '';
        }
        userEl.setAttribute('aria-invalid','false'); 
        const e = document.getElementById('errHistUser'); 
        if (e) e.textContent=''; 
      }
    }
    // aria-hidden을 먼저 false로 설정하여 접근성 문제 방지
    modal.setAttribute('aria-hidden','false');
    modal.classList.add('show');
  }
  
  // 비밀번호 입력 모달
  function ensurePasswordModal() {
    if (!document.getElementById('passwordModal')) {
      const modal = document.createElement('div');
      modal.id = 'passwordModal';
      modal.className = 'modal';
      modal.setAttribute('aria-hidden','true');
      modal.innerHTML = `
        <div class="modal-backdrop" data-close="1"></div>
        <div class="modal-content" role="dialog" aria-modal="true" aria-label="비밀번호 입력">
          <div style="display:flex; flex-direction:column; gap:16px; width:min(90vw,400px)">
            <h2 style="margin:0; font-size:18px; font-weight:bold;">로그인</h2>
            <p style="margin:0; color:#666; font-size:14px;">비밀번호를 입력해주세요.</p>
            <label style="display:flex; flex-direction:column; gap:4px; font-size:12px">
              비밀번호
              <input id="passwordInput" type="password" autocomplete="off" style="padding:8px; border:1px solid #ddd; border-radius:4px; font-size:14px;" />
            </label>
            <div id="passwordError" style="color:red; font-size:12px; display:none;">올바른 비밀번호를 입력해주세요.</div>
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px">
              <button id="passwordCancel" class="btn-sm" type="button">취소</button>
              <button id="passwordConfirm" class="btn-sm btn-primary" type="button">확인</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modal);
      
      // 이벤트 리스너
      modal.addEventListener('click', (e) => {
        if (e.target.dataset.close === '1') closePasswordModal();
      });
      
      document.addEventListener('keydown', (e) => {
        if (modal.classList.contains('show') && e.key === 'Escape') closePasswordModal();
        if (modal.classList.contains('show') && e.key === 'Enter') {
          const input = document.getElementById('passwordInput');
          if (document.activeElement === input) {
            e.preventDefault();
            handlePasswordConfirm();
          }
        }
      });
      
      const cancel = document.getElementById('passwordCancel');
      const confirm = document.getElementById('passwordConfirm');
      const input = document.getElementById('passwordInput');
      
      cancel && cancel.addEventListener('click', closePasswordModal);
      confirm && confirm.addEventListener('click', handlePasswordConfirm);
      
      // 입력 필드 포커스
      input && input.addEventListener('focus', () => {
        document.getElementById('passwordError').style.display = 'none';
      });
    }
  }
  
  function openPasswordModal() {
    ensurePasswordModal();
    const modal = document.getElementById('passwordModal');
    const input = document.getElementById('passwordInput');
    const errorEl = document.getElementById('passwordError');
    if (!modal || !input) return;
    
    input.value = '';
    errorEl.style.display = 'none';
    // aria-hidden을 먼저 false로 설정하여 접근성 문제 방지
    modal.setAttribute('aria-hidden','false');
    modal.classList.add('show');
    // 모달이 표시된 후 입력 필드에 포커스
    setTimeout(() => input.focus(), 100);
  }
  
  function closePasswordModal() {
    const modal = document.getElementById('passwordModal');
    if (!modal) return;
    // aria-hidden을 먼저 true로 설정하여 접근성 문제 방지
    modal.setAttribute('aria-hidden','true');
    modal.classList.remove('show');
    const input = document.getElementById('passwordInput');
    if (input) {
      input.value = '';
      input.blur(); // 포커스 제거
    }
  }
  
  function handlePasswordConfirm() {
    const input = document.getElementById('passwordInput');
    const errorEl = document.getElementById('passwordError');
    if (!input || !errorEl) return;
    
    const password = input.value.trim();
    const user = passwordMap[password];
    
    if (!user) {
      errorEl.style.display = 'block';
      input.focus();
      input.select();
      return;
    }
    
    // 비밀번호가 맞으면 사용자 설정하고 로그인
    state.currentUser = user;
    state.edit = true;
    closePasswordModal();
    applyMode();
    // 전환 시 액세서리/사진/작업을 즉시 재렌더
    try { renderAccessories(current()?.accessories || []); } catch(_) {}
    try { renderPhotos(current()?.photos || []); } catch(_) {}
    try { renderTasks(current()?.tasks || []); } catch(_) {}
    notify(`${user}님으로 로그인했습니다.`, "success");
  }
  function closeHistModal() {
    const modal = document.getElementById('histModal');
    if (!modal) return;
    // 모달이 취소되면 대기 중인 상태 변경 정보 초기화
    if (state.pendingStatusChange) {
      state.pendingStatusChange = null;
    }
    // aria-hidden을 먼저 true로 설정하여 접근성 문제 방지
    modal.setAttribute('aria-hidden','true');
    modal.classList.remove('show');
  }
  function adjustSpecsPanel() {
    const panel = document.querySelector('.panel-specs');
    if (!panel) return;
    const h2 = panel.querySelector('h2');
    if (h2) h2.textContent = '설비정보';
    const tbl = panel.querySelector('.table-wrap');
    if (tbl) tbl.remove();
    const btn = panel.querySelector('#btnAddSpec');
    if (btn) btn.remove();
  }
  function setupTwoColumnLayout() {
    const main = document.querySelector('main.grid');
    if (!main) return;
    if (main.querySelector('.col-left') || main.querySelector('.col-right')) return;
    const panelSpecs = document.querySelector('.panel-specs');
    const panelPhoto = document.querySelector('.panel-photo');
    const panelSummary = document.querySelector('.panel-summary');
    const panelHistory = document.querySelector('.panel-history');
    const panelAccessories = document.querySelector('.panel-accessories');
    const left = document.createElement('div'); left.className = 'col-left';
    const right = document.createElement('div'); right.className = 'col-right';
    // Keep any unknown nodes temporarily
    const rest = [];
    for (const node of Array.from(main.children)) {
      if (node.tagName === 'SECTION') rest.push(node);
    }
    // innerHTML 대신 직접 이동하여 성능 최적화
    while (main.firstChild) {
      main.removeChild(main.firstChild);
    }
    main.appendChild(left);
    main.appendChild(right);
    // Left column: SUMMARY -> 설비정보(사양) -> 설비사진
    if (panelSummary) left.appendChild(panelSummary);
    if (panelSpecs) left.appendChild(panelSpecs);
    if (panelPhoto) left.appendChild(panelPhoto);
    // Right column: 이력 -> 설치옵션·부속품
    if (panelHistory) right.appendChild(panelHistory);
    if (panelAccessories) right.appendChild(panelAccessories);
    // Append any remaining section panels to right as fallback
    rest.forEach(n => {
      if (n.isConnected) return;
      right.appendChild(n);
    });
  }
  function openPhotoModal(item) {
    if (!els.photoModal || !els.modalImage) return;
    let url = '';
    let desc = '';
    let createdAt = '';
    let createdBy = '';
    if (item && typeof item === 'object') {
      url = item.url || '';
      desc = item.desc || '';
      createdAt = item.createdAt || '';
      createdBy = item.createdBy || '';
    } else {
      url = String(item || '');
    }
    els.modalImage.src = url;
    const capDesc = document.getElementById('modalCapDesc');
    const capSub = document.getElementById('modalCapSub');
    if (capDesc) capDesc.textContent = desc || '';
    if (capSub) {
      const timeText = createdAt ? (new Date(createdAt).toLocaleString() || createdAt) : '';
      capSub.textContent = [timeText, createdBy].filter(Boolean).join(' · ');
    }
    // aria-hidden을 먼저 false로 설정하여 접근성 문제 방지
    els.photoModal.setAttribute('aria-hidden','false');
    els.photoModal.classList.add('show');
  }
  function closePhotoModal() {
    if (!els.photoModal || !els.modalImage) return;
    els.modalImage.removeAttribute('src');
    const capDesc = document.getElementById('modalCapDesc');
    const capSub = document.getElementById('modalCapSub');
    if (capDesc) capDesc.textContent = '';
    if (capSub) capSub.textContent = '';
    // aria-hidden을 먼저 true로 설정하여 접근성 문제 방지
    els.photoModal.setAttribute('aria-hidden','true');
    els.photoModal.classList.remove('show');
  }
  // Image helpers
  async function loadAndMaybeResizeImage(file, { maxBytes = 500 * 1024, maxW = 1600, maxH = 1200 } = {}) {
    // 원본을 불러오고, 목표 해상도 내로 축소하며 용량이 maxBytes 이하가 되도록 품질/해상도를 조정한다.
    const dataURL = await fileToDataURL(file);
    const img = await dataURLToImage(dataURL);
    const { w: baseW, h: baseH } = fitWithin(img.width, img.height, maxW, maxH);

    // 시도 전략: 품질을 단계적으로 낮추고, 그래도 초과 시 해상도를 점진적으로 낮춤
    const qualities = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];
    let scale = 1.0;
    let best = null; // { dataURL, size }
    while (true) {
      const w = Math.max(1, Math.round(baseW * scale));
      const h = Math.max(1, Math.round(baseH * scale));
      for (const q of qualities) {
        const { dataURL: out, size } = await resizeImageWithSize(img, w, h, q);
        if (!best || size < best.size) best = { dataURL: out, size };
        if (size <= maxBytes) return out;
      }
      // 해상도를 15%씩 낮추며 재시도
      scale *= 0.85;
      if (w < 480 || h < 360) break; // 지나친 열화를 방지하는 최소 해상도 가드
    }
    // 최적 결과(가장 작은 용량)를 반환
    return best ? best.dataURL : dataURL;
  }
  function fileToDataURL(file) {
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onerror = () => rej(new Error("이미지 읽기 실패"));
      reader.onload = () => res(String(reader.result));
      reader.readAsDataURL(file);
    });
  }
  function dataURLToImage(dataURL) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("이미지 로드 실패"));
      img.src = dataURL;
    });
  }
  function fitWithin(w, h, maxW, maxH) {
    const ratio = Math.min(maxW / w, maxH / h);
    return { w: Math.round(w * ratio), h: Math.round(h * ratio) };
  }
  function resizeImage(img, w, h, quality = 0.9) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return new Promise((res) => {
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onload = () => res(String(reader.result));
        reader.readAsDataURL(blob);
      }, "image/jpeg", quality);
    });
  }
  function resizeImageWithSize(img, w, h, quality = 0.9) {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return new Promise((res) => {
      canvas.toBlob((blob) => {
        const size = blob ? blob.size : 0;
        const reader = new FileReader();
        reader.onload = () => res({ dataURL: String(reader.result), size });
        if (blob) reader.readAsDataURL(blob); else res({ dataURL: "", size: 0 });
      }, "image/jpeg", quality);
    });
  }
  async function createThumbnailFromUrl(url, maxW = 240, maxH = 180, quality = 0.75) {
    try {
      let img;
      if (String(url).startsWith('data:')) {
        img = await dataURLToImage(url);
      } else {
        // 외부 URL일 경우 CORS로 canvas가 막힐 수 있음 → 실패 시 원본 URL 반환
        img = await new Promise((res, rej) => {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = () => res(im);
          im.onerror = (e) => rej(e);
          im.src = url;
        });
      }
      const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      const { dataURL } = await resizeImageWithSize(img, w, h, quality);
      return dataURL || url;
    } catch (_) {
      return url; // 실패 시 원본 유지
    }
  }
  // A11y/validation enhancements appended
  try { window.alert = (msg) => notify(String(msg)); } catch(_) {}
  try {
    validateRequired = function(showToast = true) {
      const eq = current();
      if (!eq) return false;
      const checks = [
        [els.reqModel, eq.model, "errModel", "Model은 필수입니다."],
        [els.reqSerial, eq.serialNo, "errSerial", "Serial No.는 필수입니다."],
        [els.reqCode, eq.codeNo, "errCode", "Code No.는 필수입니다."],
        [els.reqCategory, eq.category, "errCategory", "구분을 선택해 주세요."],
        [els.reqInstallDate, eq.installDate, "errInstall", "설치일을 입력해 주세요."],
        [els.reqCalibrationDate, eq.calibrationDate, "errCalib", "정도검사일을 입력해 주세요."],
      ];
      // 위치(대분류) 체크 추가
      const loc = parseLocation(eq.location || "");
      checks.push([els.reqLocationMajor, loc.major, "errLocation", "위치(대분류)를 선택해 주세요."]);
      let ok = true;
      for (const [el, val, errId, msg] of checks) {
        const valid = !!String(val || "").trim();
        if (el) el.setAttribute("aria-invalid", valid ? "false" : "true");
        const errEl = document.getElementById(errId);
        if (errEl) errEl.textContent = valid ? "" : msg;
        if (!valid) ok = false;
      }
      if (!ok && showToast) notify("필수 항목을 확인해 주세요.", "error");
      return ok;
    };
  } catch(_) {}
  function notify(message, type = "success") {
    const box = document.getElementById("toast");
    if (!box) return;
    box.textContent = message;
    box.className = `toast show ${type}`;
    clearTimeout(notify._t);
    notify._t = setTimeout(() => { box.className = "toast"; }, 2000);
  }
  // Unsaved changes confirm modal
  function ensureUnsavedModal() {
    if (document.getElementById('unsavedModal')) return;
    const modal = document.createElement('div');
    modal.id = 'unsavedModal';
    modal.className = 'modal';
    modal.setAttribute('aria-hidden','true');
    modal.innerHTML = `
      <div class="modal-backdrop" data-close="1"></div>
      <div class="modal-content" role="dialog" aria-modal="true" aria-label="변경사항 저장">
        <div class="form-grid" style="width:min(90vw,440px)">
          <h2>변경사항 저장</h2>
          <p class="helper">변경사항이 있습니다. 저장하시겠습니까?</p>
          <div class="form-actions" style="justify-content:flex-end; gap:8px">
            <button id="unsavedCancel" class="btn-sm" type="button">취소</button>
            <button id="unsavedDiscard" class="btn-sm" type="button">저장 안 함</button>
            <button id="unsavedSave" class="btn-sm btn-primary" type="button">저장</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    // base interactions
    modal.addEventListener('click', (e) => {
      if (e.target.dataset.close === '1') closeUnsavedModal('cancel');
    });
    document.addEventListener('keydown', (e) => {
      if (!modal.classList.contains('show')) return;
      if (e.key === 'Escape') closeUnsavedModal('cancel');
    });
  }
  let _unsavedResolver = null;
  function openUnsavedModal(opts = {}) {
    ensureUnsavedModal();
    const modal = document.getElementById('unsavedModal');
    const discardBtn = document.getElementById('unsavedDiscard');
    const saveBtn = document.getElementById('unsavedSave');
    const cancelBtn = document.getElementById('unsavedCancel');
    if (!modal || !discardBtn || !saveBtn || !cancelBtn) return Promise.resolve('cancel');
    // toggle discard visibility based on context (e.g., shortcut can hide discard)
    const showDiscard = opts && opts.allowDiscard !== false; // default true
    discardBtn.style.display = showDiscard ? '' : 'none';
    modal.setAttribute('aria-hidden','false');
    modal.classList.add('show');
    // attach one-off listeners
    return new Promise((resolve) => {
      _unsavedResolver = (choice) => {
        try { resolve(choice); } catch(_) {}
      };
      const onSave = () => closeUnsavedModal('save');
      const onDiscard = () => closeUnsavedModal('discard');
      const onCancel = () => closeUnsavedModal('cancel');
      saveBtn.addEventListener('click', onSave, { once: true });
      discardBtn.addEventListener('click', onDiscard, { once: true });
      cancelBtn.addEventListener('click', onCancel, { once: true });
      // focus the primary action
      setTimeout(() => { try { saveBtn.focus(); } catch(_) {} }, 60);
    });
  }
  function closeUnsavedModal(result = 'cancel') {
    const modal = document.getElementById('unsavedModal');
    if (!modal) return;
    modal.setAttribute('aria-hidden','true');
    modal.classList.remove('show');
    const cb = _unsavedResolver; _unsavedResolver = null;
    if (cb) cb(result);
  }

  // Progress modal helpers
  function showProgress(message = '저장 중…') {
    if (!els.progressModal) return;
    try {
      els.progressMessage && (els.progressMessage.textContent = message);
      els.progressIcon && els.progressIcon.classList.remove('done');
      els.progressModal.classList.remove('done', 'error');
      els.progressModal.setAttribute('aria-hidden', 'false');
      els.progressModal.classList.add('show');
    } catch(_) {}
  }
  function showProgressDone() {
    if (!els.progressModal) return;
    try {
      if (els.progressMessage) els.progressMessage.textContent = '저장 완료';
      if (els.progressIcon) els.progressIcon.classList.add('done');
      els.progressModal.classList.add('done');
      els.progressModal.classList.remove('error');
    } catch(_) {}
  }
  function showProgressError(msg = '저장 실패') {
    if (!els.progressModal) return;
    try {
      if (els.progressMessage) els.progressMessage.textContent = msg;
      els.progressModal.classList.add('error');
      els.progressModal.classList.remove('done');
    } catch(_) {}
  }
  function hideProgress() {
    if (!els.progressModal) return;
    try {
      els.progressModal.classList.remove('show', 'done', 'error');
      els.progressModal.setAttribute('aria-hidden', 'true');
    } catch(_) {}
  }
  function hideProgressSoon(delay = 900) {
    try { clearTimeout(hideProgressSoon._t); } catch(_) {}
    hideProgressSoon._t = setTimeout(hideProgress, delay);
  }
  window.addEventListener('load', () => { try { validateRequired(false); } catch(_) {} });
})();

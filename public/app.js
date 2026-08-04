(function startAttendanceApp() {
  'use strict';

  const WORK_TYPES = Object.freeze({
    office: '出社',
    remote: '在宅',
    paid_leave: '有給',
    holiday: '休日',
    absent: '欠勤',
  });
  const TRIP_TYPES = Object.freeze({ one_way: '片道', round_trip: '往復' });
  const TRANSPORT_MODES = Object.freeze({
    rail: '鉄道',
    bus: 'バス',
    taxi: 'タクシー',
    other: 'その他',
  });
  const WEEKDAYS = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);
  const DEFAULT_CONFIG = Object.freeze({
    timezone: 'Asia/Tokyo',
    default_break_minutes: 60,
    default_one_way_fare: 210,
    default_trip_type: 'round_trip',
    default_clock_in: '10:00',
    default_clock_out: '19:00',
    overtime_threshold_hours: 180,
  });

  const state = {
    config: { ...DEFAULT_CONFIG },
    user: null,
    today: null,
    page: 'today',
    calendarMonth: currentMonthValue(),
    summaryMonth: currentMonthValue(),
    adminMonth: currentMonthValue(),
    monthCache: new Map(),
    calendarSummary: null,
    summary: null,
    editorRecord: null,
    clockTimer: null,
  };

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.data = data;
    }
  }

  const byId = (id) => document.getElementById(id);

  void initialize();

  async function initialize() {
    applyStoredTheme();
    bindEvents();
    startClock();
    byId('calendar-month').value = state.calendarMonth;
    byId('summary-month').value = state.summaryMonth;
    byId('admin-month').value = state.adminMonth;

    try {
      await loadConfig();
      applyConfigDefaults();
      const status = await loadAuthStatus();
      if (status.authenticated && status.user) {
        await enterApplication(status.user);
      } else {
        showAuthentication(Boolean(status.setup_required));
      }
    } catch (error) {
      showAuthentication(false);
      toast(errorMessage(error, '初期化に失敗しました。'), 'error');
    } finally {
      byId('loading-view').hidden = true;
    }
  }

  function bindEvents() {
    byId('login-form').addEventListener('submit', handleLogin);
    byId('setup-form').addEventListener('submit', handleSetup);
    byId('logout-button').addEventListener('click', handleLogout);
    byId('theme-button').addEventListener('click', toggleTheme);

    document.querySelectorAll('[data-page]').forEach((button) => {
      button.addEventListener('click', () => void navigate(button.dataset.page));
    });

    document.querySelectorAll('[data-month-delta]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.monthTarget;
        const delta = Number(button.dataset.monthDelta);
        changeMonth(target, Number.isFinite(delta) ? delta : 0);
      });
    });

    byId('calendar-month').addEventListener('change', () => {
      const value = validMonthValue(byId('calendar-month').value);
      if (!value) return;
      state.calendarMonth = value;
      void loadCalendar(true);
    });
    byId('summary-month').addEventListener('change', () => {
      const value = validMonthValue(byId('summary-month').value);
      if (!value) return;
      state.summaryMonth = value;
      updateExcelFilenamePreview();
      void loadSummary(true);
    });
    byId('admin-month').addEventListener('change', () => {
      const value = validMonthValue(byId('admin-month').value);
      if (!value) return;
      state.adminMonth = value;
      void loadAdminOverview();
    });

    byId('clock-work-type').addEventListener('change', updateClockForm);
    byId('clock-in-form').addEventListener('submit', handleClockIn);
    byId('clock-out-button').addEventListener('click', handleClockOut);
    byId('edit-today-button').addEventListener('click', () => {
      const date = state.today?.date || todayIso();
      void openRecordEditor(date);
    });

    byId('download-excel-button').addEventListener('click', handleExcelDownload);
    byId('profile-form').addEventListener('submit', handleProfileUpdate);
    byId('profile-display-name').addEventListener('input', updateExcelFilenamePreview);
    byId('work-defaults-form').addEventListener('submit', handleWorkDefaultsUpdate);
    byId('commute-form').addEventListener('submit', handleCommuteUpdate);
    byId('password-form').addEventListener('submit', handlePasswordUpdate);

    byId('close-record-dialog').addEventListener('click', closeRecordDialog);
    byId('cancel-record-button').addEventListener('click', closeRecordDialog);
    byId('record-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      closeRecordDialog();
    });
    byId('record-work-type').addEventListener('change', updateRecordForm);
    byId('record-one-way-fare').addEventListener('input', updateRecordFarePreview);
    byId('record-trip-type').addEventListener('change', updateRecordFarePreview);
    byId('record-form').addEventListener('submit', handleRecordSave);
    byId('delete-record-button').addEventListener('click', handleRecordDelete);

    byId('admin-add-user-form').addEventListener('submit', handleAdminAddUser);
    document.addEventListener('click', handleTimeStepper);
  }

  function handleTimeStepper(event) {
    const btn = event.target.closest('[data-time-target]');
    if (!btn) return;
    const targetId = btn.dataset.timeTarget;
    const step = Number(btn.dataset.step) || 15;
    const input = byId(targetId);
    if (!input || input.disabled) return;

    const time = validTime(input.value) || nowTime();
    const parts = time.split(':').map(Number);
    let totalMinutes = parts[0] * 60 + parts[1] + step;
    if (totalMinutes < 0) totalMinutes += 1440;
    totalMinutes = totalMinutes % 1440;

    const newHours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const newMinutes = String(totalMinutes % 60).padStart(2, '0');
    input.value = `${newHours}:${newMinutes}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function loadConfig() {
    try {
      const raw = await api('/api/config');
      const source = unwrap(raw);
      state.config = {
        timezone: safeString(source.timezone, DEFAULT_CONFIG.timezone),
        default_break_minutes: boundedInteger(source.default_break_minutes, DEFAULT_CONFIG.default_break_minutes, 0, 480),
        default_one_way_fare: boundedInteger(source.default_one_way_fare, DEFAULT_CONFIG.default_one_way_fare, 0, 100000),
        default_trip_type: normalizeTripType(source.default_trip_type) || DEFAULT_CONFIG.default_trip_type,
        default_clock_in: validTime(source.default_clock_in) || DEFAULT_CONFIG.default_clock_in,
        default_clock_out: validTime(source.default_clock_out) || DEFAULT_CONFIG.default_clock_out,
        overtime_threshold_hours: boundedInteger(source.overtime_threshold_hours, DEFAULT_CONFIG.overtime_threshold_hours, 0, 744),
      };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      state.config = { ...DEFAULT_CONFIG };
    }
  }

  async function loadAuthStatus() {
    try {
      const raw = await api('/api/auth/status');
      const status = unwrap(raw);
      return {
        setup_required: Boolean(status.setup_required),
        authenticated: Boolean(status.authenticated),
        user: status.user ? normalizeUser(status.user) : null,
      };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      try {
        const user = await api('/api/auth/me');
        return { setup_required: false, authenticated: true, user: normalizeUser(user) };
      } catch (meError) {
        if (meError instanceof ApiError && meError.status === 401) {
          return { setup_required: false, authenticated: false, user: null };
        }
        throw meError;
      }
    }
  }

  function showAuthentication(setupRequired) {
    byId('app-view').hidden = true;
    byId('auth-view').hidden = false;
    byId('login-form').hidden = setupRequired;
    byId('setup-form').hidden = !setupRequired;
    byId('auth-description').textContent = setupRequired
      ? '最初の管理者アカウントを安全に作成します。'
      : 'ログインして勤務時間を記録します。';
    requestAnimationFrame(() => {
      const target = setupRequired ? byId('setup-token') : byId('login-username');
      target?.focus();
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    const username = byId('login-username').value.trim();
    const password = byId('login-password').value;
    if (!username || !password) {
      toast('ログイン名とパスワードを入力してください。', 'error');
      return;
    }

    await withBusy(event.submitter, 'ログイン中…', async () => {
      try {
        const response = await api('/api/auth/login', {
          method: 'POST',
          body: { username, password },
        });
        byId('login-password').value = '';
        await enterApplication(response.user || response.data?.user || response);
        toast('ログインしました。', 'success');
      } catch (error) {
        toast(errorMessage(error, 'ログインできませんでした。'), 'error');
      }
    });
  }

  async function handleSetup(event) {
    event.preventDefault();
    const password = byId('setup-password').value;
    const confirmation = byId('setup-password-confirm').value;
    if (password !== confirmation) {
      toast('確認用パスワードが一致しません。', 'error');
      return;
    }
    if (password.length < 12 || password.length > 128) {
      toast('パスワードは12〜128文字にしてください。', 'error');
      return;
    }

    const username = normalizeNewUsername(byId('setup-username').value);
    if (!username) {
      toast('ログイン名は3〜64文字の英数字・ドット・下線・ハイフンで入力してください。', 'error');
      return;
    }

    const payload = {
      setup_token: byId('setup-token').value,
      username,
      display_name: byId('setup-display-name').value.trim(),
      password,
      default_one_way_fare: integerInput(byId('setup-fare'), state.config.default_one_way_fare, 0, 100000),
      default_trip_type: normalizeTripType(byId('setup-trip-type').value) || 'round_trip',
    };
    if (!payload.setup_token || !payload.username || !payload.display_name) {
      toast('セットアップトークン、ログイン名、氏名を入力してください。', 'error');
      return;
    }

    await withBusy(event.submitter, '作成中…', async () => {
      try {
        const response = await api('/api/auth/setup', { method: 'POST', body: payload });
        byId('setup-token').value = '';
        byId('setup-password').value = '';
        byId('setup-password-confirm').value = '';
        await enterApplication(response.user || response.data?.user || response);
        toast('初期セットアップが完了しました。', 'success');
      } catch (error) {
        toast(errorMessage(error, '初期セットアップに失敗しました。'), 'error');
      }
    });
  }

  async function enterApplication(rawUser) {
    state.user = normalizeUser(rawUser);
    state.monthCache.clear();
    byId('auth-view').hidden = true;
    byId('app-view').hidden = false;
    renderUserIdentity();
    applyUserDefaults();
    await navigate('today');
  }

  async function handleLogout() {
    await withBusy(byId('logout-button'), '処理中…', async () => {
      let remoteFailed = false;
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          remoteFailed = true;
        }
      }
      state.user = null;
      state.today = null;
      state.monthCache.clear();
      showAuthentication(false);
      toast(
        remoteFailed
          ? '画面をロックしました。サーバー側のログアウトは完了していない可能性があります。'
          : 'ログアウトしました。',
        remoteFailed ? 'error' : 'success',
      );
    });
  }

  function renderUserIdentity() {
    byId('header-user-name').textContent = state.user.display_name || state.user.username;
    byId('header-user-role').textContent = state.user.is_admin ? '管理者' : '一般';
    byId('admin-nav-button').hidden = !state.user.is_admin;
    byId('profile-username').value = state.user.username;
    byId('profile-display-name').value = state.user.display_name;
    byId('profile-one-way-fare').value = String(userOneWayFare());
    byId('profile-trip-type').value = userTripType();
    byId('profile-clock-in').value = userClockIn();
    byId('profile-clock-out').value = userClockOut();
    byId('profile-break').value = String(userBreakMinutes());
    byId('profile-work-type').value = userWorkType();
    byId('profile-transport-mode').value = userTransportMode();
    byId('profile-transport-origin').value = userTransportOrigin();
    byId('profile-transport-destination').value = userTransportDestination();
    updateExcelFilenamePreview();
  }

  function applyConfigDefaults() {
    byId('setup-fare').value = String(state.config.default_one_way_fare);
    byId('setup-trip-type').value = state.config.default_trip_type;
    byId('admin-new-fare').value = String(state.config.default_one_way_fare);
  }

  function applyUserDefaults() {
    byId('clock-break').value = String(userBreakMinutes());
    byId('clock-in-time').value = nowTime();
    byId('clock-work-type').value = userWorkType();
    updateClockForm();
  }

  async function navigate(page) {
    const allowed = new Set(['today', 'calendar', 'summary', 'settings', 'admin']);
    const nextPage = allowed.has(page) ? page : 'today';
    if (nextPage === 'admin' && !state.user?.is_admin) return;
    state.page = nextPage;

    document.querySelectorAll('[data-page-panel]').forEach((panel) => {
      const active = panel.dataset.pagePanel === nextPage;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    document.querySelectorAll('[data-page]').forEach((button) => {
      const active = button.dataset.page === nextPage;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

    if (nextPage === 'today') await loadToday();
    if (nextPage === 'calendar') await loadCalendar(false);
    if (nextPage === 'summary') await loadSummary(false);
    if (nextPage === 'admin') await loadAdminPage();
    byId('main-content').focus({ preventScroll: true });
  }

  async function loadToday() {
    try {
      const raw = await api('/api/attendance/today');
      state.today = normalizeToday(raw);
      renderToday();
    } catch (error) {
      handleAuthenticatedError(error, '今日の記録を取得できませんでした。');
    }
  }

  function normalizeToday(raw) {
    const source = unwrap(raw);
    const date = validDate(source.date) || todayIso();
    const defaults = unwrap(source.defaults || {});
    const oneWayFare = boundedInteger(
      defaults.one_way_fare ?? defaults.transport_one_way_fee,
      userOneWayFare(),
      0,
      100000,
    );
    const tripType = normalizeTripType(defaults.trip_type ?? defaults.transport_trip_type) || userTripType();
    return {
      date,
      day_of_week: boundedInteger(source.day_of_week, weekdayIndex(date), 0, 6),
      is_holiday: Boolean(source.is_holiday),
      is_weekend: Boolean(source.is_weekend),
      holiday_name: safeString(source.holiday_name, ''),
      record: source.record ? normalizeRecord(source.record, {
        date,
        day_of_week: source.day_of_week,
        is_holiday: source.is_holiday,
        holiday_name: source.holiday_name,
      }) : null,
      defaults: {
        break_minutes: boundedInteger(defaults.break_minutes, state.config.default_break_minutes, 0, 480),
        work_type: workingType(defaults.work_type) || userWorkType(),
        one_way_fare: oneWayFare,
        trip_type: tripType,
        transport_mode: normalizeTransportMode(defaults.transport_mode) || userTransportMode(),
        transport_origin: safeString(defaults.transport_origin, userTransportOrigin()).slice(0, 120),
        transport_destination: safeString(defaults.transport_destination, userTransportDestination()).slice(0, 120),
      },
    };
  }

  function renderToday() {
    const today = state.today;
    const record = today.record;
    byId('today-date').textContent = formatJapaneseDate(today.date);
    byId('today-weekday').textContent = `${WEEKDAYS[today.day_of_week] || ''}曜日`;
    byId('today-holiday').textContent = today.holiday_name || (today.is_weekend ? '週末' : '');

    byId('today-record-type').textContent = record?.persisted ? workTypeLabel(record.work_type) : '未設定';
    byId('today-record-in').textContent = record?.clock_in || '--:--';
    byId('today-record-out').textContent = record?.clock_out || '--:--';
    byId('today-record-break').textContent = record?.persisted && isWorking(record.work_type)
      ? `${record.break_minutes}分`
      : '0分';
    byId('today-record-fare').textContent = money(record?.transport_fee || 0);
    byId('today-record-work').textContent = formatMinutes(record?.work_minutes || 0);
    byId('today-record-transport-mode').textContent = record?.persisted && record.work_type === 'office'
      ? transportModeLabel(record.transport_mode)
      : '—';
    byId('today-record-route').textContent = record?.persisted && record.work_type === 'office'
      ? commuteRouteLabel(record.transport_origin, record.transport_destination)
      : '—';

    const badge = byId('today-record-badge');
    let status = 'empty';
    let label = '未打刻';
    if (record?.persisted && record.clock_in && !record.clock_out) {
      status = 'working';
      label = '勤務中';
    } else if (record?.persisted) {
      status = 'done';
      label = record.clock_out || !isWorking(record.work_type) ? '記録済み' : '未完了';
    }
    badge.dataset.status = status;
    badge.textContent = label;

    byId('clock-out-button').disabled = !(record?.clock_in && !record.clock_out);
    byId('clock-in-button').disabled = Boolean(record?.clock_in || (record?.persisted && !isWorking(record.work_type)));
    byId('clock-break').value = String(today.defaults.break_minutes);
    if (!record?.persisted) byId('clock-work-type').value = today.defaults.work_type;
    updateClockForm();
  }

  function updateClockForm() {
    const type = normalizeWorkType(byId('clock-work-type').value) || 'office';
    const working = isWorking(type);
    document.querySelectorAll('[data-working-field]').forEach((field) => {
      field.hidden = !working;
      field.querySelectorAll('input, select').forEach((input) => { input.disabled = !working; });
    });
    byId('clock-in-button').textContent = working ? '出勤' : `${workTypeLabel(type)}として記録`;
  }

  function updateRecordFarePreview() {
    const type = normalizeWorkType(byId('record-work-type').value);
    const fare = type === 'office' ? integerInput(byId('record-one-way-fare'), 0, 0, 100000) : 0;
    const tripVal = byId('record-trip-type').value;
    const multiplier = tripVal === 'round_trip' ? 2 : (tripVal === 'one_way' ? 1 : 0);
    byId('record-fare-preview').textContent = money(fare * multiplier);
  }

  async function handleClockIn(event) {
    event.preventDefault();
    const type = normalizeWorkType(byId('clock-work-type').value);
    if (!type) {
      toast('勤務区分が不正です。', 'error');
      return;
    }

    const date = state.today?.date || todayIso();
    await withBusy(event.submitter, '記録中…', async () => {
      try {
        if (!isWorking(type)) {
          await api(`/api/attendance/${encodeURIComponent(date)}`, {
            method: 'PUT',
            body: clearedNonWorkingRecord(type, ''),
          });
        } else {
          const clockIn = validTime(byId('clock-in-time').value) || nowTime();
          const body = {
            work_type: type,
            clock_in: clockIn,
            break_minutes: integerInput(byId('clock-break'), userBreakMinutes(), 0, 480),
            transport_one_way_fee: type === 'office' ? userOneWayFare() : 0,
            transport_trip_type: type === 'office' ? userTripType() : 'one_way',
            transport_mode: type === 'office' ? userTransportMode() : 'rail',
            transport_origin: type === 'office' ? userTransportOrigin() : '',
            transport_destination: type === 'office' ? userTransportDestination() : '',
          };
          await api('/api/attendance/clock-in', { method: 'POST', body });
        }
        invalidateMonth(date.slice(0, 7));
        await loadToday();
        toast('勤務を記録しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, '勤務を記録できませんでした。');
      }
    });
  }

  async function handleClockOut() {
    if (!window.confirm('現在時刻で退勤を記録しますか？')) return;
    await withBusy(byId('clock-out-button'), '記録中…', async () => {
      try {
        await api('/api/attendance/clock-out', {
          method: 'POST',
          body: { clock_out: nowTime() },
        });
        invalidateMonth((state.today?.date || todayIso()).slice(0, 7));
        await loadToday();
        toast('退勤を記録しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, '退勤を記録できませんでした。');
      }
    });
  }

  async function loadCalendar(force) {
    try {
      state.calendarSummary = await loadMonthData(state.calendarMonth, force);
      renderCalendar(state.calendarSummary);
    } catch (error) {
      handleAuthenticatedError(error, 'カレンダーを取得できませんでした。');
    }
  }

  function renderCalendar(summary) {
    const grid = byId('calendar-grid');
    grid.replaceChildren();
    WEEKDAYS.forEach((day) => grid.append(createElement('div', { className: 'calendar-header', text: day })));
    const firstDay = new Date(Date.UTC(summary.year, summary.month - 1, 1)).getUTCDay();
    for (let index = 0; index < firstDay; index += 1) {
      grid.append(createElement('div', { className: 'calendar-empty', ariaHidden: 'true' }));
    }

    const recordMap = new Map(summary.records.map((record) => [record.work_date, record]));
    const days = new Date(Date.UTC(summary.year, summary.month, 0)).getUTCDate();
    for (let day = 1; day <= days; day += 1) {
      const date = `${summary.year}-${String(summary.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const record = recordMap.get(date) || normalizeRecord({}, { date });
      const button = createElement('button', {
        className: 'calendar-day',
        type: 'button',
        ariaLabel: `${formatJapaneseDate(date)}の勤務を編集`,
      });
      if (date === todayIso()) button.classList.add('is-today');
      if (record.is_holiday) button.classList.add('is-holiday');
      if (record.day_of_week === 0) button.classList.add('is-sunday');
      if (record.day_of_week === 6) button.classList.add('is-saturday');
      button.append(createElement('span', { className: 'calendar-date', text: String(day) }));
      if (record.persisted) {
        const badge = createElement('span', { className: 'type-badge', text: workTypeLabel(record.work_type) });
        badge.dataset.type = record.work_type || 'unknown';
        button.append(badge);
      } else if (record.is_holiday || record.day_of_week === 0 || record.day_of_week === 6) {
        const badge = createElement('span', { className: 'type-badge', text: '休日' });
        badge.dataset.type = 'holiday';
        button.append(badge);
      }
      const note = record.persisted && record.clock_in
        ? `${record.clock_in}–${record.clock_out || '未退勤'}`
        : record.holiday_name;
      if (note) button.append(createElement('span', { className: 'calendar-note', text: note }));
      button.addEventListener('click', () => void openRecordEditor(date, summary));
      grid.append(button);
    }
  }

  async function loadSummary(force) {
    try {
      state.summary = await loadMonthData(state.summaryMonth, force);
      renderSummary(state.summary);
    } catch (error) {
      handleAuthenticatedError(error, '月次集計を取得できませんでした。');
    }
  }

  function renderSummary(summary) {
    const metrics = [
      ['出社', `${summary.office_days}日`],
      ['在宅', `${summary.remote_days}日`],
      ['有給', `${summary.paid_leave_days}日`],
      ['欠勤', `${summary.absent_days}日`],
      ['総実働', formatMinutes(summary.total_work_minutes)],
      ['会社基準超過', formatMinutes(summary.overtime_minutes)],
      ['交通費', money(summary.total_transport_fee)],
      ['未完了', `${summary.incomplete_days}件`],
    ];
    const container = byId('summary-metrics');
    container.replaceChildren(...metrics.map(([label, value]) => {
      const card = createElement('div', { className: 'metric-card' });
      card.append(createElement('span', { text: label }), createElement('strong', { text: value }));
      return card;
    }));

    const body = byId('summary-table-body');
    body.replaceChildren();
    for (const record of summary.records) {
      const row = document.createElement('tr');
      const typeLabel = record.persisted
        ? workTypeLabel(record.work_type)
        : (record.is_holiday || record.day_of_week === 0 || record.day_of_week === 6 ? '休日' : '');
      const values = [
        `${Number(record.work_date.slice(8))}日（${WEEKDAYS[record.day_of_week] || ''}）`,
        typeLabel,
        record.persisted ? (record.clock_in || '') : '',
        record.persisted ? (record.clock_out || '') : '',
        record.persisted && isWorking(record.work_type) ? `${record.break_minutes}分` : '',
        record.persisted && record.work_minutes !== null ? formatMinutes(record.work_minutes) : '',
        record.persisted && record.work_type === 'office' ? transportModeLabel(record.transport_mode) : '',
        record.persisted && record.work_type === 'office'
          ? commuteRouteLabel(record.transport_origin, record.transport_destination, '')
          : '',
        record.persisted && record.work_type === 'office' ? money(record.transport_one_way_fee) : '',
        record.persisted && record.work_type === 'office' ? tripTypeLabel(record.transport_trip_type) : '',
        record.persisted && record.work_type === 'office' ? money(record.transport_fee) : '',
      ];
      values.forEach((value) => row.append(createElement('td', { text: value })));
      body.append(row);
    }
    if (!summary.records.length) {
      const row = document.createElement('tr');
      const cell = createElement('td', { className: 'empty-table-cell', text: '記録がありません。' });
      cell.colSpan = 11;
      row.append(cell);
      body.append(row);
    }

    const holiday = summary.holiday_data || {};
    const sourceLabels = {
      cache: '保存済みの祝日データ',
      'official-csv': '内閣府の祝日CSV',
      'bundled-official': '同梱した公式祝日データ',
      unavailable: '祝日データを取得できませんでした',
    };
    const note = byId('holiday-source-note');
    note.textContent = `祝日情報：${sourceLabels[holiday.source] || '取得元不明'}${holiday.synced_at ? `（同期：${formatDateTime(holiday.synced_at)}）` : ''}`;
    note.dataset.incomplete = holiday.complete === false ? 'true' : 'false';
  }

  async function handleExcelDownload() {
    const button = byId('download-excel-button');
    await withBusy(button, '作成中…', async () => {
      try {
        const [year, month] = splitMonth(state.summaryMonth);
        const raw = await api(`/api/export/${year}/${month}`);
        const source = { ...unwrap(raw) };
        if (!source.username) source.username = state.user.username;
        if (!source.employee_name) source.employee_name = state.user.display_name;
        if (source.default_one_way_fare === undefined) source.default_one_way_fare = userOneWayFare();
        if (!source.default_trip_type) source.default_trip_type = userTripType();
        if (!source.default_transport_mode) source.default_transport_mode = userTransportMode();
        if (source.default_transport_origin === undefined) source.default_transport_origin = userTransportOrigin();
        if (source.default_transport_destination === undefined) source.default_transport_destination = userTransportDestination();
        const blob = window.KintaiExcel.createWorkbookBlob(source, { config: state.config });
        const filename = window.KintaiExcel.filenameFor(source);
        downloadBlob(blob, filename);
        toast('Excelを作成しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, 'Excelを作成できませんでした。');
      }
    });
  }

  async function handleProfileUpdate(event) {
    event.preventDefault();
    const displayName = byId('profile-display-name').value.trim();
    if (!displayName) {
      toast('氏名を入力してください。', 'error');
      return;
    }
    const body = {
      display_name: displayName,
    };
    await saveProfileChanges(event.submitter, body, 'プロフィールを保存しました。');
  }

  async function handleWorkDefaultsUpdate(event) {
    event.preventDefault();
    const body = {
      default_clock_in: validTime(byId('profile-clock-in').value) || null,
      default_clock_out: validTime(byId('profile-clock-out').value) || null,
      default_break_minutes: integerInput(byId('profile-break'), userBreakMinutes(), 0, 480),
      default_work_type: workingType(byId('profile-work-type').value) || 'office',
    };
    await saveProfileChanges(event.submitter, body, '勤務の既定値を保存しました。');
  }

  async function handleCommuteUpdate(event) {
    event.preventDefault();
    const body = {
      default_one_way_fare: integerInput(byId('profile-one-way-fare'), state.config.default_one_way_fare, 0, 100000),
      default_trip_type: normalizeTripType(byId('profile-trip-type').value) || 'round_trip',
      default_transport_mode: normalizeTransportMode(byId('profile-transport-mode').value) || 'rail',
      default_transport_origin: commuteLocationInput(byId('profile-transport-origin')),
      default_transport_destination: commuteLocationInput(byId('profile-transport-destination')),
    };
    await saveProfileChanges(event.submitter, body, '通勤設定を保存しました。');
  }

  async function saveProfileChanges(button, body, successMessage) {
    await withBusy(button, '保存中…', async () => {
      try {
        const response = await api('/api/auth/profile', { method: 'PATCH', body });
        state.user = normalizeUser(response.user || response.data?.user || response);
        renderUserIdentity();
        applyUserDefaults();
        state.monthCache.clear();
        toast(successMessage, 'success');
      } catch (error) {
        handleAuthenticatedError(error, '個人設定を保存できませんでした。');
      }
    });
  }

  async function handlePasswordUpdate(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const currentPassword = byId('current-password').value;
    const newPassword = byId('new-password').value;
    const confirmation = byId('new-password-confirm').value;
    if (currentPassword.length < 1 || currentPassword.length > 128) {
      toast('現在のパスワードを正しく入力してください。', 'error');
      return;
    }
    if (newPassword.length < 12 || newPassword.length > 128) {
      toast('新しいパスワードは12〜128文字にしてください。', 'error');
      return;
    }
    if (newPassword !== confirmation) {
      toast('確認用パスワードが一致しません。', 'error');
      return;
    }
    if (currentPassword === newPassword) {
      toast('新しいパスワードは現在と異なるものにしてください。', 'error');
      return;
    }
    await withBusy(event.submitter, '変更中…', async () => {
      try {
        const verification = await api('/api/auth/profile/password/verify', {
          method: 'POST',
          body: { current_password: currentPassword },
        });
        const reauthToken = verification.reauth_token || verification.data?.reauth_token;
        if (!reauthToken) throw new Error('Password reauthentication token is missing');
        const response = await api('/api/auth/profile/password', {
          method: 'POST',
          body: { new_password: newPassword, reauth_token: reauthToken },
        });
        if (response.user || response.data?.user) {
          state.user = normalizeUser(response.user || response.data.user);
          renderUserIdentity();
        }
        form.reset();
        toast('パスワードを変更し、ほかのセッションを無効にしました。', 'success');
      } catch (error) {
        toast(errorMessage(error, 'パスワードを変更できませんでした。'), 'error');
      }
    });
  }

  async function openRecordEditor(date, providedSummary) {
    const valid = validDate(date);
    if (!valid) {
      toast('日付が不正です。', 'error');
      return;
    }
    try {
      const monthValue = valid.slice(0, 7);
      const summary = providedSummary || await loadMonthData(monthValue, false);
      const record = summary.records.find((item) => item.work_date === valid) || normalizeRecord({}, { date: valid });
      state.editorRecord = record;
      fillRecordDialog(record);
      byId('record-dialog').showModal();
    } catch (error) {
      handleAuthenticatedError(error, '記録を開けませんでした。');
    }
  }

  function fillRecordDialog(record) {
    const defaultType = record.persisted
      ? (normalizeWorkType(record.work_type) || 'office')
      : (record.is_holiday || record.day_of_week === 0 || record.day_of_week === 6 ? 'holiday' : userWorkType());
    byId('record-date').value = record.work_date;
    byId('record-date-context').textContent = `${formatJapaneseDate(record.work_date)}（${WEEKDAYS[record.day_of_week] || ''}）${record.holiday_name ? `　${record.holiday_name}` : ''}`;
    byId('record-work-type').value = defaultType;
    byId('record-clock-in').value = record.persisted ? (record.clock_in || '') : userClockIn();
    byId('record-clock-out').value = record.persisted ? (record.clock_out || '') : userClockOut();
    byId('record-break').value = String(record.persisted ? record.break_minutes : userBreakMinutes());
    byId('record-one-way-fare').value = String(record.persisted ? record.transport_one_way_fee : userOneWayFare());
    byId('record-trip-type').value = record.persisted
      ? (normalizeTripType(record.transport_trip_type) || userTripType())
      : userTripType();
    byId('record-transport-mode').value = record.persisted
      ? (normalizeTransportMode(record.transport_mode) || userTransportMode())
      : userTransportMode();
    byId('record-transport-origin').value = record.persisted
      ? record.transport_origin
      : userTransportOrigin();
    byId('record-transport-destination').value = record.persisted
      ? record.transport_destination
      : userTransportDestination();
    byId('record-memo').value = record.persisted ? record.memo : '';
    byId('delete-record-button').hidden = !record.persisted;
    byId('record-form').dataset.workType = defaultType;
    updateRecordForm();
  }

  function updateRecordForm() {
    const type = normalizeWorkType(byId('record-work-type').value) || 'office';
    const previousType = normalizeWorkType(byId('record-form').dataset.workType);
    const originalRecord = state.editorRecord;
    const working = isWorking(type);
    const office = type === 'office';
    document.querySelectorAll('[data-record-working-field]').forEach((field) => {
      field.hidden = !working;
      field.querySelectorAll('input, select').forEach((input) => { input.disabled = !working; });
    });
    document.querySelectorAll('[data-record-office-field]').forEach((field) => {
      field.hidden = !office;
      field.querySelectorAll('input, select').forEach((input) => { input.disabled = !office; });
    });
    if (!working) {
      byId('record-clock-in').value = '';
      byId('record-clock-out').value = '';
      byId('record-break').value = '0';
      byId('record-one-way-fare').value = '0';
      byId('record-transport-origin').value = '';
      byId('record-transport-destination').value = '';
    } else {
      if (previousType && !isWorking(previousType)) {
        const restoreOriginalWorkingRecord = originalRecord?.persisted && isWorking(originalRecord.work_type);
        byId('record-break').value = String(
          restoreOriginalWorkingRecord ? originalRecord.break_minutes : userBreakMinutes(),
        );
        byId('record-clock-in').value = restoreOriginalWorkingRecord
          ? (originalRecord.clock_in || '')
          : userClockIn();
        byId('record-clock-out').value = restoreOriginalWorkingRecord
          ? (originalRecord.clock_out || '')
          : userClockOut();
      }
      if (office && previousType && previousType !== 'office') {
        const restoreOriginalCommute = originalRecord?.persisted && originalRecord.work_type === 'office';
        byId('record-one-way-fare').value = String(
          restoreOriginalCommute ? originalRecord.transport_one_way_fee : userOneWayFare(),
        );
        byId('record-trip-type').value = restoreOriginalCommute
          ? (normalizeTripType(originalRecord.transport_trip_type) || userTripType())
          : userTripType();
        byId('record-transport-mode').value = restoreOriginalCommute
          ? (normalizeTransportMode(originalRecord.transport_mode) || userTransportMode())
          : userTransportMode();
        byId('record-transport-origin').value = restoreOriginalCommute
          ? originalRecord.transport_origin
          : userTransportOrigin();
        byId('record-transport-destination').value = restoreOriginalCommute
          ? originalRecord.transport_destination
          : userTransportDestination();
      } else if (!office) {
        byId('record-one-way-fare').value = '0';
        byId('record-transport-origin').value = '';
        byId('record-transport-destination').value = '';
      }
    }
    byId('record-form').dataset.workType = type;
    updateRecordFarePreview();
  }

  async function handleRecordSave(event) {
    event.preventDefault();
    const date = validDate(byId('record-date').value);
    const type = normalizeWorkType(byId('record-work-type').value);
    if (!date || !type) {
      toast('日付または勤務区分が不正です。', 'error');
      return;
    }
    const memo = byId('record-memo').value.slice(0, 500);
    let body;
    if (!isWorking(type)) {
      body = clearedNonWorkingRecord(type, memo);
    } else {
      const clockIn = byId('record-clock-in').value ? validTime(byId('record-clock-in').value) : null;
      const clockOut = byId('record-clock-out').value ? validTime(byId('record-clock-out').value) : null;
      if ((byId('record-clock-in').value && !clockIn) || (byId('record-clock-out').value && !clockOut)) {
        toast('時刻を HH:MM 形式で入力してください。', 'error');
        return;
      }
      body = {
        work_type: type,
        clock_in: clockIn,
        clock_out: clockOut,
        break_minutes: integerInput(byId('record-break'), state.config.default_break_minutes, 0, 480),
        transport_one_way_fee: type === 'office'
          ? integerInput(byId('record-one-way-fare'), userOneWayFare(), 0, 100000)
          : 0,
        transport_trip_type: type === 'office'
          ? (normalizeTripType(byId('record-trip-type').value) || userTripType())
          : 'one_way',
        transport_mode: type === 'office'
          ? (normalizeTransportMode(byId('record-transport-mode').value) || userTransportMode())
          : 'rail',
        transport_origin: type === 'office'
          ? commuteLocationInput(byId('record-transport-origin'))
          : '',
        transport_destination: type === 'office'
          ? commuteLocationInput(byId('record-transport-destination'))
          : '',
        memo,
      };
    }

    await withBusy(event.submitter, '保存中…', async () => {
      try {
        await api(`/api/attendance/${encodeURIComponent(date)}`, { method: 'PUT', body });
        closeRecordDialog();
        invalidateMonth(date.slice(0, 7));
        await refreshVisibleData(date);
        toast('勤務記録を保存しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, '勤務記録を保存できませんでした。');
      }
    });
  }

  async function handleRecordDelete() {
    const date = validDate(byId('record-date').value);
    if (!date || !state.editorRecord?.persisted) return;
    if (!window.confirm(`${formatJapaneseDate(date)}の勤務記録を削除しますか？`)) return;
    await withBusy(byId('delete-record-button'), '削除中…', async () => {
      try {
        await api(`/api/attendance/${encodeURIComponent(date)}`, { method: 'DELETE' });
        closeRecordDialog();
        invalidateMonth(date.slice(0, 7));
        await refreshVisibleData(date);
        toast('勤務記録を削除しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, '勤務記録を削除できませんでした。');
      }
    });
  }

  function closeRecordDialog() {
    const dialog = byId('record-dialog');
    if (dialog.open) dialog.close();
    state.editorRecord = null;
  }

  function clearedNonWorkingRecord(type, memo) {
    return {
      work_type: type,
      clock_in: null,
      clock_out: null,
      break_minutes: 0,
      transport_one_way_fee: 0,
      transport_trip_type: 'one_way',
      transport_mode: 'rail',
      transport_origin: '',
      transport_destination: '',
      memo,
    };
  }

  async function refreshVisibleData(date) {
    const tasks = [];
    if (date === (state.today?.date || todayIso())) tasks.push(loadToday());
    if (state.page === 'calendar') tasks.push(loadCalendar(true));
    if (state.page === 'summary') tasks.push(loadSummary(true));
    await Promise.all(tasks);
  }

  async function loadAdminPage() {
    await Promise.all([loadAdminUsers(), loadAdminOverview()]);
  }

  async function loadAdminUsers() {
    try {
      const raw = await api('/api/admin/users');
      const users = Array.isArray(raw.users) ? raw.users : (Array.isArray(raw.data?.users) ? raw.data.users : []);
      renderAdminUsers(users.map(normalizeUser));
    } catch (error) {
      handleAuthenticatedError(error, 'ユーザー一覧を取得できませんでした。');
    }
  }

  function renderAdminUsers(users) {
    const body = byId('admin-user-list');
    body.replaceChildren();
    for (const user of users) {
      const row = document.createElement('tr');
      row.append(
        createElement('td', { text: user.display_name }),
        createElement('td', { text: user.username }),
        createElement('td', { text: user.is_admin ? '管理者' : '一般' }),
      );
      const actionCell = document.createElement('td');
      const button = createElement('button', {
        className: 'button button-danger',
        type: 'button',
        text: '削除',
      });
      button.disabled = user.id === state.user.id;
      button.addEventListener('click', () => void deleteAdminUser(user, button));
      actionCell.append(button);
      row.append(actionCell);
      body.append(row);
    }
  }

  async function deleteAdminUser(user, button) {
    if (!window.confirm(`${user.display_name || user.username} を削除しますか？関連する勤怠記録も削除されます。`)) return;
    await withBusy(button, '削除中…', async () => {
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
        await Promise.all([loadAdminUsers(), loadAdminOverview()]);
        toast('ユーザーを削除しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, 'ユーザーを削除できませんでした。');
      }
    });
  }

  async function handleAdminAddUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const username = normalizeNewUsername(byId('admin-new-username').value);
    const body = {
      username: username || '',
      display_name: byId('admin-new-name').value.trim(),
      password: byId('admin-new-password').value,
      is_admin: byId('admin-new-is-admin').checked ? 1 : 0,
      default_one_way_fare: integerInput(byId('admin-new-fare'), state.config.default_one_way_fare, 0, 100000),
      default_trip_type: byId('admin-new-round-trip').checked ? 'round_trip' : 'one_way',
    };
    if (!username) {
      toast('ログイン名は3〜64文字の英数字・ドット・下線・ハイフンで入力してください。', 'error');
      return;
    }
    if (!body.display_name || body.password.length < 12 || body.password.length > 128) {
      toast('氏名と12〜128文字の初期パスワードを入力してください。', 'error');
      return;
    }
    await withBusy(event.submitter, '追加中…', async () => {
      try {
        await api('/api/admin/users', { method: 'POST', body });
        form.reset();
        byId('admin-new-fare').value = String(state.config.default_one_way_fare);
        byId('admin-new-round-trip').checked = true;
        await Promise.all([loadAdminUsers(), loadAdminOverview()]);
        toast('ユーザーを追加しました。', 'success');
      } catch (error) {
        handleAuthenticatedError(error, 'ユーザーを追加できませんでした。');
      }
    });
  }

  async function loadAdminOverview() {
    try {
      const [year, month] = splitMonth(state.adminMonth);
      const raw = await api(`/api/admin/overview/${year}/${month}`);
      const users = Array.isArray(raw.users) ? raw.users : (Array.isArray(raw.data?.users) ? raw.data.users : []);
      renderAdminOverview(users);
    } catch (error) {
      handleAuthenticatedError(error, '月次勤務概要を取得できませんでした。');
    }
  }

  function renderAdminOverview(users) {
    const body = byId('admin-overview-body');
    body.replaceChildren();
    for (const item of users) {
      const summary = unwrap(item.summary || {});
      const row = document.createElement('tr');
      [
        safeString(item.display_name || item.username, '（名称なし）'),
        `${numberOrZero(summary.office_days)}日`,
        `${numberOrZero(summary.remote_days)}日`,
        `${numberOrZero(summary.paid_leave_days)}日`,
        formatMinutes(numberOrZero(summary.total_work_minutes)),
        money(numberOrZero(summary.total_transport_fee)),
      ].forEach((value) => row.append(createElement('td', { text: value })));
      body.append(row);
    }
    if (!users.length) {
      const row = document.createElement('tr');
      const cell = createElement('td', { className: 'empty-table-cell', text: 'ユーザーがいません。' });
      cell.colSpan = 6;
      row.append(cell);
      body.append(row);
    }
  }

  async function loadMonthData(monthValue, force) {
    const valid = validMonthValue(monthValue);
    if (!valid) throw new Error('年月が不正です。');
    if (!force && state.monthCache.has(valid)) return state.monthCache.get(valid);
    const [year, month] = splitMonth(valid);
    const raw = await api(`/api/attendance/${year}/${month}`);
    const summary = normalizeMonthlySummary(raw, year, month);
    state.monthCache.set(valid, summary);
    return summary;
  }

  function normalizeMonthlySummary(raw, year, month) {
    const source = unwrap(raw);
    let recordsSource = source.records;
    let summarySource = source;
    if (!Array.isArray(recordsSource) && Array.isArray(source.days)) {
      recordsSource = source.days.map((day) => ({
        ...(day.record || {}),
        work_date: day.date,
        day_of_week: day.day_of_week,
        is_holiday: day.is_holiday,
        holiday_name: day.holiday_name,
        work_minutes: day.work_minutes,
      }));
      summarySource = { ...source, ...unwrap(source.summary || {}) };
    }
    const records = Array.isArray(recordsSource)
      ? recordsSource.map((record) => normalizeRecord(record)).filter((record) => record.work_date)
      : [];
    const derived = deriveSummary(records, year, month);
    return {
      year: boundedInteger(source.year, year, 1955, 2100),
      month: boundedInteger(source.month, month, 1, 12),
      username: safeString(source.username, state.user?.username || ''),
      employee_name: safeString(source.employee_name, state.user?.display_name || ''),
      office_days: finiteOr(summarySource.office_days, derived.office_days),
      remote_days: finiteOr(summarySource.remote_days, derived.remote_days),
      paid_leave_days: finiteOr(summarySource.paid_leave_days, derived.paid_leave_days),
      absent_days: finiteOr(summarySource.absent_days, derived.absent_days),
      scheduled_work_days: finiteOr(summarySource.scheduled_work_days, derived.scheduled_work_days),
      incomplete_days: finiteOr(summarySource.incomplete_days, derived.incomplete_days),
      total_work_minutes: finiteOr(summarySource.total_work_minutes, derived.total_work_minutes),
      total_transport_fee: finiteOr(summarySource.total_transport_fee, derived.total_transport_fee),
      overtime_minutes: finiteOr(summarySource.overtime_minutes, Math.max(0, derived.total_work_minutes - state.config.overtime_threshold_hours * 60)),
      overtime_threshold_minutes: finiteOr(summarySource.overtime_threshold_minutes, state.config.overtime_threshold_hours * 60),
      records,
      holiday_data: unwrap(source.holiday_data || {}),
    };
  }

  function normalizeRecord(raw, context) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const extra = context || {};
    const date = validDate(source.work_date || source.date || extra.date) || '';
    const type = normalizeWorkType(source.work_type);
    const trip = normalizeTripType(source.transport_trip_type);
    const totalFare = boundedInteger(source.transport_fee, 0, 0, 200000);
    const oneWayFare = boundedInteger(
      source.transport_one_way_fee,
      trip === 'round_trip' ? Math.round(totalFare / 2) : totalFare,
      0,
      100000,
    );
    const clockIn = validTime(source.clock_in);
    const clockOut = validTime(source.clock_out);
    const breakMinutes = boundedInteger(source.break_minutes, 0, 0, 480);
    const computedMinutes = clockIn && clockOut ? calculateWorkMinutes(clockIn, clockOut, breakMinutes) : null;
    return {
      id: boundedInteger(source.id, 0, 0, Number.MAX_SAFE_INTEGER),
      work_date: date,
      work_type: type,
      clock_in: clockIn,
      clock_out: clockOut,
      break_minutes: breakMinutes,
      transport_one_way_fee: oneWayFare,
      transport_trip_type: trip,
      transport_fee: totalFare,
      transport_mode: normalizeTransportMode(source.transport_mode),
      transport_origin: safeString(source.transport_origin, '').slice(0, 120),
      transport_destination: safeString(source.transport_destination, '').slice(0, 120),
      memo: safeString(source.memo, ''),
      day_of_week: boundedInteger(source.day_of_week ?? extra.day_of_week, date ? weekdayIndex(date) : 0, 0, 6),
      is_holiday: Boolean(source.is_holiday ?? extra.is_holiday),
      holiday_name: safeString(source.holiday_name ?? extra.holiday_name, ''),
      work_minutes: nullableFinite(source.work_minutes, computedMinutes),
      persisted: isPersistedRecord(source),
    };
  }

  function deriveSummary(records, year, month) {
    const result = {
      office_days: 0,
      remote_days: 0,
      paid_leave_days: 0,
      absent_days: 0,
      scheduled_work_days: 0,
      incomplete_days: 0,
      total_work_minutes: 0,
      total_transport_fee: 0,
    };
    records.forEach((record) => {
      if (record.day_of_week !== 0 && record.day_of_week !== 6 && !record.is_holiday) result.scheduled_work_days += 1;
      if (!record.persisted) return;
      if (record.work_type === 'office') result.office_days += 1;
      if (record.work_type === 'remote') result.remote_days += 1;
      if (record.work_type === 'paid_leave') result.paid_leave_days += 1;
      if (record.work_type === 'absent') result.absent_days += 1;
      if (isWorking(record.work_type) && (!record.clock_in || !record.clock_out)) result.incomplete_days += 1;
      result.total_work_minutes += record.work_minutes || 0;
      result.total_transport_fee += record.transport_fee || 0;
    });
    if (records.length < 20) {
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      result.scheduled_work_days = 0;
      for (let day = 1; day <= days; day += 1) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const record = records.find((item) => item.work_date === date);
        const dow = weekdayIndex(date);
        if (dow !== 0 && dow !== 6 && !record?.is_holiday) result.scheduled_work_days += 1;
      }
    }
    return result;
  }

  function changeMonth(target, delta) {
    if (!['calendar', 'summary', 'admin'].includes(target)) return;
    const stateKey = `${target}Month`;
    state[stateKey] = offsetMonth(state[stateKey], delta);
    byId(`${target}-month`).value = state[stateKey];
    if (target === 'calendar') void loadCalendar(false);
    if (target === 'summary') {
      updateExcelFilenamePreview();
      void loadSummary(false);
    }
    if (target === 'admin') void loadAdminOverview();
  }

  function invalidateMonth(monthValue) {
    state.monthCache.delete(monthValue);
  }

  async function api(path, options) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('不正なAPIパスです。');
    const config = options || {};
    const headers = new Headers(config.headers || {});
    headers.set('Accept', 'application/json');
    let body;
    if (config.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(config.body);
    }
    const response = await fetch(path, {
      method: config.method || 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers,
      body,
    });
    const contentType = response.headers.get('content-type') || '';
    let data = null;
    if (response.status !== 204) {
      if (contentType.includes('application/json')) {
        data = await response.json().catch(() => null);
      } else {
        data = await response.text().catch(() => '');
      }
    }
    if (!response.ok) {
      const message = typeof data === 'object' && data
        ? safeString(data.error || data.message, `HTTP ${response.status}`)
        : safeString(data, `HTTP ${response.status}`);
      throw new ApiError(message, response.status, data);
    }
    return data || {};
  }

  function handleAuthenticatedError(error, fallback) {
    if (error instanceof ApiError && error.status === 401) {
      state.user = null;
      showAuthentication(false);
      toast('セッションの有効期限が切れました。もう一度ログインしてください。', 'error');
      return;
    }
    toast(errorMessage(error, fallback), 'error');
  }

  async function withBusy(button, label, operation) {
    if (!button || button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      return await operation();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function toast(message, kind) {
    const region = byId('toast-region');
    const item = createElement('div', { className: 'toast', text: safeString(message, 'エラーが発生しました。') });
    item.dataset.kind = kind === 'success' ? 'success' : (kind === 'error' ? 'error' : 'info');
    region.append(item);
    while (region.children.length > 3) region.firstElementChild.remove();
    window.setTimeout(() => item.remove(), 5000);
  }

  function createElement(tagName, options) {
    const element = document.createElement(tagName);
    const config = options || {};
    if (config.className) element.className = config.className;
    if (config.text !== undefined) element.textContent = safeString(config.text, '');
    if (config.type) element.type = config.type;
    if (config.ariaLabel) element.setAttribute('aria-label', config.ariaLabel);
    if (config.ariaHidden) element.setAttribute('aria-hidden', config.ariaHidden);
    return element;
  }

  function normalizeUser(raw) {
    const source = unwrap(raw);
    return {
      id: boundedInteger(source.id, 0, 0, Number.MAX_SAFE_INTEGER),
      username: safeString(source.username, ''),
      display_name: safeString(source.display_name, source.username || ''),
      is_admin: source.is_admin === true || Number(source.is_admin) === 1,
      default_one_way_fare: source.default_one_way_fare === null || source.default_one_way_fare === undefined
        ? null
        : boundedInteger(source.default_one_way_fare, state.config.default_one_way_fare, 0, 100000),
      default_trip_type: normalizeTripType(source.default_trip_type) || state.config.default_trip_type,
      default_clock_in: validTime(source.default_clock_in) || null,
      default_clock_out: validTime(source.default_clock_out) || null,
      default_break_minutes: boundedInteger(
        source.default_break_minutes,
        state.config.default_break_minutes,
        0,
        480,
      ),
      default_work_type: workingType(source.default_work_type) || 'office',
      default_transport_mode: normalizeTransportMode(source.default_transport_mode) || 'rail',
      default_transport_origin: safeString(source.default_transport_origin, '').slice(0, 120),
      default_transport_destination: safeString(source.default_transport_destination, '').slice(0, 120),
    };
  }

  function userOneWayFare() {
    return state.user?.default_one_way_fare ?? state.config.default_one_way_fare;
  }

  function userTripType() {
    return normalizeTripType(state.user?.default_trip_type) || state.config.default_trip_type;
  }

  function userClockIn() {
    return state.user?.default_clock_in || state.config.default_clock_in || '';
  }

  function userClockOut() {
    return state.user?.default_clock_out || state.config.default_clock_out || '';
  }

  function userBreakMinutes() {
    return boundedInteger(
      state.user?.default_break_minutes,
      state.config.default_break_minutes,
      0,
      480,
    );
  }

  function userWorkType() {
    return workingType(state.user?.default_work_type) || 'office';
  }

  function userTransportMode() {
    return normalizeTransportMode(state.user?.default_transport_mode) || 'rail';
  }

  function userTransportOrigin() {
    return safeString(state.user?.default_transport_origin, '').slice(0, 120);
  }

  function userTransportDestination() {
    return safeString(state.user?.default_transport_destination, '').slice(0, 120);
  }

  function normalizeWorkType(value) {
    return Object.prototype.hasOwnProperty.call(WORK_TYPES, value) ? value : null;
  }

  function workingType(value) {
    const type = normalizeWorkType(value);
    return isWorking(type) ? type : null;
  }

  function normalizeTripType(value) {
    return Object.prototype.hasOwnProperty.call(TRIP_TYPES, value) ? value : null;
  }

  function normalizeTransportMode(value) {
    return Object.prototype.hasOwnProperty.call(TRANSPORT_MODES, value) ? value : null;
  }

  function workTypeLabel(value) {
    return WORK_TYPES[value] || '不明';
  }

  function tripTypeLabel(value) {
    return TRIP_TYPES[value] || '不明';
  }

  function transportModeLabel(value) {
    return TRANSPORT_MODES[value] || '未設定';
  }

  function commuteRouteLabel(origin, destination, fallback = '未設定') {
    const from = safeString(origin, '').trim();
    const to = safeString(destination, '').trim();
    if (from && to) return `${from} → ${to}`;
    return from || to || fallback;
  }

  function isWorking(value) {
    return value === 'office' || value === 'remote';
  }

  function isPersistedRecord(record) {
    return Number(record.id) > 0 || Boolean(record.created_at) || Boolean(record.updated_at) ||
      Boolean(record.clock_in) || Boolean(record.clock_out) || Boolean(record.memo);
  }

  function calculateWorkMinutes(clockIn, clockOut, breakMinutes) {
    const start = timeToMinutes(clockIn);
    let end = timeToMinutes(clockOut);
    if (start === null || end === null) return 0;
    if (end < start) end += 1440;
    return Math.max(0, end - start - breakMinutes);
  }

  function timeToMinutes(value) {
    const time = validTime(value);
    if (!time) return null;
    const parts = time.split(':').map(Number);
    return parts[0] * 60 + parts[1];
  }

  function validTime(value) {
    const text = String(value || '');
    const match = /^(\d{2}):(\d{2})$/.exec(text);
    return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? text : null;
  }

  function validDate(value) {
    const text = String(value || '');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1955 || year > 2100) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? text : null;
  }

  function validMonthValue(value) {
    const text = String(value || '');
    const match = /^(\d{4})-(\d{2})$/.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return year >= 1955 && year <= 2100 && month >= 1 && month <= 12 ? text : null;
  }

  function splitMonth(value) {
    const valid = validMonthValue(value) || currentMonthValue();
    return valid.split('-').map(Number);
  }

  function offsetMonth(value, delta) {
    const [year, month] = splitMonth(value);
    const date = new Date(Date.UTC(year, month - 1 + delta, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function weekdayIndex(value) {
    const date = validDate(value);
    if (!date) return 0;
    const parts = date.split('-').map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
  }

  function dateTimeParts() {
    const formatter = new Intl.DateTimeFormat('ja-JP', {
      timeZone: state.config.timezone || 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    return Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  }

  function todayIso() {
    const parts = dateTimeParts();
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function currentMonthValue() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}`;
  }

  function nowTime() {
    const parts = dateTimeParts();
    return `${parts.hour}:${parts.minute}`;
  }

  function startClock() {
    const tick = () => {
      const parts = dateTimeParts();
      byId('current-time').textContent = `${parts.hour}:${parts.minute}:${parts.second}`;
    };
    tick();
    if (state.clockTimer) window.clearInterval(state.clockTimer);
    state.clockTimer = window.setInterval(tick, 1000);
  }

  function formatJapaneseDate(value) {
    const valid = validDate(value);
    if (!valid) return '日付不明';
    const [year, month, day] = valid.split('-').map(Number);
    return `${year}年${month}月${day}日`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: state.config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function formatMinutes(value) {
    const minutes = Math.max(0, Math.round(Number(value) || 0));
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function money(value) {
    const amount = Math.max(0, Math.round(Number(value) || 0));
    return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(amount);
  }

  function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function integerInput(input, fallback, min, max) {
    if (!input || String(input.value).trim() === '') return fallback;
    return boundedInteger(input.value, fallback, min, max);
  }

  function commuteLocationInput(input) {
    return String(input?.value || '').normalize('NFKC').trim().slice(0, 120);
  }

  function updateExcelFilenamePreview() {
    const preview = byId('excel-filename-preview');
    if (!preview) return;
    const [year, month] = splitMonth(state.summaryMonth || currentMonthValue());
    const employeeName = byId('profile-display-name')?.value.trim()
      || state.user?.display_name
      || '氏名未設定';
    preview.textContent = window.KintaiExcel?.filenameFor
      ? window.KintaiExcel.filenameFor({ year, month, employee_name: employeeName })
      : `勤怠表_${employeeName}_${year}${String(month).padStart(2, '0')}.xlsx`;
  }

  function normalizeNewUsername(value) {
    const username = String(value || '').normalize('NFKC').trim();
    return /^[A-Za-z0-9._-]{3,64}$/.test(username) ? username : null;
  }

  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nullableFinite(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function safeString(value, fallback) {
    if (value === null || value === undefined) return String(fallback || '');
    return String(value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .slice(0, 1000);
  }

  function unwrap(value) {
    if (!value || typeof value !== 'object') return {};
    if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) return value.data;
    return value;
  }

  function errorMessage(error, fallback) {
    return error instanceof Error && error.message ? safeString(error.message, fallback) : fallback;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function applyStoredTheme() {
    let theme = '';
    try { theme = localStorage.getItem('kintai-theme') || ''; } catch { theme = ''; }
    if (theme !== 'light' && theme !== 'dark') {
      theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = theme;
    byId('theme-button').textContent = theme === 'light' ? '☾' : '☀';
  }

  function toggleTheme() {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    byId('theme-button').textContent = theme === 'light' ? '☾' : '☀';
    try { localStorage.setItem('kintai-theme', theme); } catch { /* storage can be unavailable */ }
  }
})();

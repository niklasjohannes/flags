// Home screen (spec #4, PLAN decisions 1-2): continent filter, quiz mode,
// the number of flags waiting, Start and Test. Nothing else, apart from the
// quiet "Backup" link in the footer (spec #8, owner decision on GitHub #9),
// which opens js/backup-sheet.js.

import { createBackupSheet } from '../backup-sheet.js';
import { REGIONS, countDue } from '../srs.js';
import { loadMode, loadStates, localToday, saveMode } from '../storage.js';
import { ALL_REGIONS_LABEL, MODE_LABELS, REGION_LABELS, createChoiceGroup, el } from '../ui.js';

// Radio value of "All"; maps to `region: null` everywhere else.
const ALL_VALUE = 'all';

const REGION_CHOICES = Object.freeze([
  { value: ALL_VALUE, label: ALL_REGIONS_LABEL },
  ...REGIONS.map((region) => ({ value: region, label: REGION_LABELS[region] }))
]);

const MODE_CHOICES = Object.freeze(
  Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))
);

/**
 * Time away from the app (ms) after which coming back to home counts as a
 * fresh open. A change of local date always does.
 */
export const RESUME_RESET_MS = 30 * 60_000;

// Module state lives for one page load: the filter survives a trip to
// practice and back, but every reload starts at "All" because it is never
// stored (PLAN decision 2). The mode is also kept here, so it survives a trip
// even when storage is blocked; it is loaded from storage on first mount.
let selectedRegion = null;
let selectedMode = null;
let controller = null;

// Selector for the focused control inside `container`, to focus the same
// control after a re-render (the router would otherwise focus the section).
function describeFocus(container) {
  const active = document.activeElement;
  if (active === null || active === container || !container.contains(active)) {
    return null;
  }
  if (active instanceof HTMLInputElement) {
    return `input[name="${CSS.escape(active.name)}"][value="${CSS.escape(active.value)}"]`;
  }
  if (active.dataset.action !== undefined) {
    return `[data-action="${CSS.escape(active.dataset.action)}"]`;
  }
  return null;
}

/**
 * Render the home screen.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ countries: object[], navigate: Function }} context See `js/app.js`.
 * @returns {void}
 */
export function mount(container, context) {
  controller = new AbortController();
  const { signal } = controller;
  const { countries, navigate } = context;

  // Read once per visit, so the count reflects answers saved by practice.
  const today = localToday();
  const states = loadStates(today);
  selectedMode ??= loadMode();

  // iOS resumes an installed app from the background without reloading. If
  // the date changed or the user was away for `RESUME_RESET_MS`, treat the
  // return like a fresh open: new `today`, filter back to All. A quick glance
  // at another app keeps the filter. These listeners only exist while home is
  // mounted, so a round or test in progress is never interrupted.
  let hiddenAt = null;
  const reopenIfStale = () => {
    const isStale = localToday() !== today ||
      (hiddenAt !== null && Date.now() - hiddenAt >= RESUME_RESET_MS);
    hiddenAt = null;
    if (!isStale) {
      return;
    }
    const focusSelector = describeFocus(container);
    selectedRegion = null;
    // Through the router, so a failing mount gets its error state.
    navigate('home');
    if (focusSelector !== null) {
      container.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else {
      reopenIfStale();
    }
  }, { signal });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      reopenIfStale();
    }
  }, { signal });

  const countNumber = el('span', { class: 'due-number' });
  const countLabel = el('span', { class: 'due-label' });
  const updateCount = () => {
    const { due, new: fresh } = countDue({ states, countries, today, region: selectedRegion });
    const waiting = due + fresh;
    countNumber.textContent = String(waiting);
    countLabel.textContent = waiting === 1 ? 'flag waiting' : 'flags waiting';
  };

  const regionGroup = createChoiceGroup({
    name: 'home-region',
    legend: 'Continent',
    choices: REGION_CHOICES,
    selected: selectedRegion ?? ALL_VALUE,
    signal,
    onChange: (value) => {
      selectedRegion = value === ALL_VALUE ? null : value;
      updateCount();
    }
  });

  const modeGroup = createChoiceGroup({
    name: 'home-mode',
    legend: 'Mode',
    choices: MODE_CHOICES,
    selected: selectedMode,
    variant: 'segmented',
    signal,
    onChange: (value) => {
      selectedMode = value;
      saveMode(selectedMode);
    }
  });

  const startButton = el('button', { type: 'button', class: 'button button-primary', 'data-action': 'start' }, ['Start']);
  const testButton = el('button', { type: 'button', class: 'button button-secondary', 'data-action': 'test' }, ['Test']);
  startButton.addEventListener('click', () => navigate('practice', { region: selectedRegion, mode: selectedMode }), { signal });
  testButton.addEventListener('click', () => navigate('test', { region: selectedRegion, mode: selectedMode }), { signal });

  // A restore re-renders home, so the count reflects the imported progress.
  const backupSheet = createBackupSheet({ onRestored: () => navigate('home'), signal });
  const backupButton = el('button', {
    type: 'button',
    class: 'button-quiet home-backup',
    'aria-haspopup': 'dialog',
    'data-action': 'backup'
  }, ['Backup']);
  backupButton.addEventListener('click', backupSheet.open, { signal });

  updateCount();
  container.replaceChildren(
    el('h1', { class: 'home-title' }, ['Flags']),
    regionGroup,
    modeGroup,
    el('p', { class: 'due-count', 'aria-live': 'polite' }, [countNumber, ' ', countLabel]),
    el('div', { class: 'view-actions home-actions' }, [startButton, testButton]),
    el('div', { class: 'home-footer' }, [backupButton]),
    backupSheet.dialog
  );
}

/**
 * Remove the home screen's listeners.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}

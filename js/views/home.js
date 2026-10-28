// Home screen (spec #4, PLAN decisions 1-2): continent filter, quiz mode,
// the number of flags waiting, Start and Test. Nothing else.

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

// Module state lives for one page load: the filter survives a trip to
// practice and back, but every reload starts at "All" because it is never
// stored (PLAN decision 2). The mode is also kept here, so it survives a trip
// even when storage is blocked; it is loaded from storage on first mount.
let selectedRegion = null;
let selectedMode = null;
let controller = null;

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

  // iOS resumes an installed app from the background without reloading. Treat
  // a resume on home like a fresh open: new `today`, filter back to All. This
  // listener only exists while home is mounted, so a round or test in
  // progress is never interrupted.
  const reopen = () => {
    selectedRegion = null;
    unmount();
    mount(container, context);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reopen();
    }
  }, { signal });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      reopen();
    }
  }, { signal });

  // Read once per visit, so the count reflects answers saved by practice.
  const today = localToday();
  const states = loadStates(today);
  selectedMode ??= loadMode();

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
    signal,
    onChange: (value) => {
      selectedMode = value;
      saveMode(selectedMode);
    }
  });

  const startButton = el('button', { type: 'button', class: 'button button-primary' }, ['Start']);
  const testButton = el('button', { type: 'button', class: 'button button-secondary' }, ['Test']);
  startButton.addEventListener('click', () => navigate('practice', { region: selectedRegion, mode: selectedMode }), { signal });
  testButton.addEventListener('click', () => navigate('test', { region: selectedRegion, mode: selectedMode }), { signal });

  updateCount();
  container.replaceChildren(
    el('h1', { class: 'home-title' }, ['Flags']),
    regionGroup,
    modeGroup,
    el('p', { class: 'due-count', 'aria-live': 'polite' }, [countNumber, ' ', countLabel]),
    el('div', { class: 'home-actions' }, [startButton, testButton])
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

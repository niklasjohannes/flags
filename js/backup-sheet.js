// Backup sheet (spec #8, owner decision on GitHub #9): opened from the quiet
// "Backup" link in the home footer. Export saves the SRS progress as a JSON
// file; Import reads one back, after an in-app confirm. The file format and
// its validation are in js/backup.js.
//
// Same pattern as the test's exit sheet (js/views/test.js): a modal
// `<dialog class="sheet">`, closed by Close, Escape or a tap on the
// backdrop. Never `window.confirm` (see there for why).
//
// Export prefers the share sheet (`navigator.share` with a file): in an
// installed iOS app that is the reliable way to "Save to Files"; a download
// link there can open the file with no way back. Where sharing files is not
// supported it uses a download link (`downloadFile`). If sharing is
// supported but fails, it says so rather than trying a download that may
// strand the user the same way.

import { BACKUP_ERRORS, MAX_BACKUP_LENGTH, getBackupFilename, parseBackup, serializeBackup } from './backup.js';
import { loadStates, localToday, saveStates } from './storage.js';
import { el } from './ui.js';

const BACKUP_MIME_TYPE = 'application/json';

/** How long (ms) a download's `blob:` URL stays valid after the click. */
export const DOWNLOAD_URL_LIFETIME_MS = 60_000;

const INTRO_TEXT = 'Progress is saved only on this device. Export it to a file to keep a copy, or import a file to restore it.';
const READ_ERROR = 'This file could not be read.';
const SAVE_ERROR = 'Could not save: this browser is blocking storage for the app.';
const SHARE_ERROR = 'Could not share the backup. Try again.';

function countFlags(count) {
  return `${count} ${count === 1 ? 'flag' : 'flags'}`;
}

// Start a download of `blob` as `filename`.
//
// The one element the app builds outside `el` (js/ui.js): a download link
// needs a `blob:` URL, a scheme `el` rightly refuses. The URL points at a
// Blob this module just made from the user's own progress, never at
// anything from outside; the link is in the document only for the click
// (some browsers ignore clicks on detached links) and is never in markup.
function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking straight away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

function canShareFile(file) {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Build the backup sheet.
 *
 * @param {object} options
 * @param {() => void} options.onRestored Called after an import was saved and
 *   the sheet closed; re-render home so it shows the restored progress.
 * @param {AbortSignal} options.signal Removes every listener when aborted.
 * @returns {{ dialog: HTMLDialogElement, open: () => void }} Put `dialog` in
 *   the view; `open` shows it.
 */
export function createBackupSheet({ onRestored, signal } = {}) {
  if (typeof onRestored !== 'function') {
    throw new TypeError('`onRestored` must be a function.');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('`signal` must be an `AbortSignal`.');
  }

  const title = el('h2', { id: 'backup-title', class: 'sheet-title' });
  const text = el('p', { id: 'backup-text', class: 'sheet-text' });
  const status = el('p', { class: 'sheet-status', role: 'status' });
  const actions = el('div', { class: 'sheet-actions' });
  const fileInput = el('input', {
    type: 'file',
    accept: `${BACKUP_MIME_TYPE},.json`,
    hidden: true,
    'data-action': 'import-file'
  });
  const dialog = el('dialog', {
    class: 'sheet backup-sheet',
    'aria-labelledby': 'backup-title',
    'aria-describedby': 'backup-text'
  }, [
    el('div', { class: 'sheet-body' }, [title, text, status, actions, fileInput])
  ]);

  const button = (label, action, variant, onClick) => {
    const node = el('button', { type: 'button', class: `button button-${variant}`, 'data-action': action }, [label]);
    node.addEventListener('click', onClick, { signal });
    return node;
  };
  const setStatus = (message) => {
    status.textContent = message;
    status.hidden = message === '';
  };
  // Swap the sheet's content; focus the first action, since the buttons that
  // had focus are gone.
  const show = ({ heading, body, message = '', buttons }) => {
    title.textContent = heading;
    text.textContent = body;
    setStatus(message);
    actions.replaceChildren(...buttons);
    if (dialog.open) {
      buttons[0].focus({ preventScroll: true });
    }
  };

  const close = () => {
    if (dialog.open) {
      dialog.close();
    }
  };

  const showMain = (message = '') => show({
    heading: 'Backup',
    body: INTRO_TEXT,
    message,
    buttons: [
      button('Export', 'export', 'primary', exportBackup),
      button('Import', 'import', 'secondary', () => fileInput.click()),
      button('Close', 'close', 'secondary', close)
    ]
  });

  const showConfirm = (result) => {
    const existing = Object.keys(loadStates(localToday())).length;
    const savedOn = result.exportedAt === null
      ? ''
      : `, saved on ${new Date(result.exportedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
    const replaces = existing === 0
      ? 'There is no progress on this device yet.'
      : `It replaces the progress on this device (${countFlags(existing)}).`;
    const skipped = result.dropped === 0
      ? ''
      : ` ${result.dropped} unreadable ${result.dropped === 1 ? 'entry is' : 'entries are'} skipped.`;
    show({
      heading: 'Restore this backup?',
      body: `It has progress for ${countFlags(result.count)}${savedOn}. ${replaces}${skipped}`,
      buttons: [
        button('Restore', 'restore', 'primary', () => {
          if (!saveStates(result.states)) {
            showMain(SAVE_ERROR);
            return;
          }
          close();
          onRestored();
        }),
        button('Cancel', 'cancel', 'secondary', () => showMain())
      ]
    });
  };

  // One export at a time: a second tap while the share sheet is opening
  // would reject with `InvalidStateError`.
  let isExporting = false;
  async function exportBackup(event) {
    if (isExporting) {
      return;
    }
    isExporting = true;
    const exportButton = event.currentTarget;
    exportButton.disabled = true;
    try {
      const today = localToday();
      const states = loadStates(today);
      const filename = getBackupFilename(today);
      const file = new File([serializeBackup(states, new Date())], filename, { type: BACKUP_MIME_TYPE });
      const done = `Exported ${countFlags(Object.keys(states).length)}.`;
      if (!canShareFile(file)) {
        downloadFile(file, filename);
        setStatus(`${done} Saved as ${filename}.`);
        return;
      }
      try {
        await navigator.share({ files: [file], title: 'Flags backup' });
        setStatus(done);
      } catch (error) {
        // AbortError: the user closed the share sheet; nothing to say.
        if (error?.name !== 'AbortError') {
          setStatus(SHARE_ERROR);
        }
      }
    } finally {
      isExporting = false;
      exportButton.disabled = false;
    }
  }

  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files ?? [];
    // Cleared so picking the same file again still fires `change`.
    fileInput.value = '';
    if (file === undefined) {
      return;
    }
    if (file.size > MAX_BACKUP_LENGTH) {
      setStatus(BACKUP_ERRORS.tooLarge);
      return;
    }
    let contents;
    try {
      contents = await file.text();
    } catch {
      setStatus(READ_ERROR);
      return;
    }
    if (signal.aborted || !dialog.open) {
      return;
    }
    const result = parseBackup(contents, localToday());
    if (result.ok) {
      showConfirm(result);
    } else {
      setStatus(result.error);
    }
  }, { signal });

  // `.sheet-body` fills the dialog, so a click on the dialog itself is a
  // click on the backdrop.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  }, { signal });

  const open = () => {
    if (dialog.open) {
      return;
    }
    showMain();
    dialog.showModal();
    actions.querySelector('button')?.focus({ preventScroll: true });
  };
  showMain();
  return { dialog, open };
}

// exportSeat.ts — the kit's `saveFile` seat (TASK-20260905-binding-a-artifacts AC6). The
// playground's ONE download dispatch (`downloadBlob`) prefers the platform's `saveFile`
// seat, so every export button reaches this without changing: the Settings user-file
// export and the share sheet's bundle download.
//
// A USER FILE (SQLite or SNUGENC1) leaves as `snug-user.snug.json` — the artifact
// `downloads` allowlist has no `.snug`, so the bytes ride in the `snug-user-file/1` wrapper
// the db package writes and re-sniffs on the way back in. A BUNDLE (already JSON) leaves
// as `<stem>.snug.json`. With the `downloads` namespace the viewer confirms the save
// (declined is silent — the viewer said no); a second click while a prompt is open is
// refused by name; every other code is a note. Without it (a chat artifact: the download
// link is inert, the async clipboard blocked — T1 S10) the text is COPIED with the one
// primitive that works, `execCommand('copy')`, and the note says so with the size. The
// seat owns every outcome: `downloadBlob` fires it with `void`.

import { USER_FILE_WRAPPER_FILE_NAME, sniffSnugFile, wrapUserFile } from '@snugprotocol/db';

import type { DownloadsNamespace } from './probe.js';
import type { CustodyStore } from './storage/custodyStore.js';

export interface ExportSeatOptions {
  downloads: DownloadsNamespace | undefined;
  store: CustodyStore;
  /** The copy primitive — a textarea + `execCommand('copy')` on the page; injectable. */
  copyText?: (text: string) => boolean;
}

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

function copyViaExecCommand(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** The bundle's file name for the artifact: `<stem>.snug` → `<stem>.snug.json`; anything already `.json` stays. */
export function artifactBundleName(suggestedName: string): string {
  if (/\.json$/i.test(suggestedName)) return suggestedName;
  return `${suggestedName.replace(/\.snug$/i, '')}.snug.json`;
}

export function createExportSeat(options: ExportSeatOptions): (bytes: Uint8Array, suggestedName: string) => Promise<void> {
  const { downloads, store } = options;
  const copyText = options.copyText ?? copyViaExecCommand;
  let inFlight = false;
  const note = (text: string): void => store.patch({ note: text });

  return async (bytes, suggestedName) => {
    let text: string;
    let filename: string;
    // The seat owns EVERY outcome — the caller fires it with `void` (correctness review 12).
    try {
      const kind = sniffSnugFile(bytes);
      if (kind === 'user-file') {
        text = await wrapUserFile(bytes);
        filename = USER_FILE_WRAPPER_FILE_NAME;
      } else if (kind === 'app-bundle' || kind === 'user-file-wrapper') {
        text = new TextDecoder().decode(bytes);
        filename = artifactBundleName(suggestedName);
      } else {
        note('that is not a Snug file — nothing was exported');
        return;
      }
    } catch (error) {
      note(`the export could not be prepared (${error instanceof Error ? error.message : String(error)}) — nothing was written`);
      return;
    }

    if (downloads === undefined) {
      const ok = copyText(text);
      note(ok ? `copied ${kb(text.length)} to the clipboard — paste it into a file named ${filename} to keep it` : 'the copy failed — select the export text and copy it by hand');
      return;
    }
    if (inFlight) {
      note('a save is already open — answer it first');
      return;
    }
    inFlight = true;
    try {
      await downloads.save({ filename, data: text });
      note(`saved ${filename} (${kb(text.length)})`);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      switch (code) {
        case 'declined':
          break; // the viewer said no — silent
        case 'rate_limited':
          note('a save is already open — answer it first');
          break;
        case 'rejected_extension':
        case 'extension_not_enabled':
          note(`this host does not allow saving ${filename} — copy the export instead`);
          break;
        default:
          note(`the save failed${typeof code === 'string' ? ` (${code})` : ''} — nothing was written`);
      }
    } finally {
      inFlight = false;
    }
  };
}

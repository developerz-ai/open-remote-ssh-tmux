import * as vscode from 'vscode';

// Last-resort local clipboard reader: a webview.
//
// The native readers in `clipboardImage.ts` are the fast, invisible path, but every one of
// them is an optional binary and each covers only part of a platform — `pngpaste` and
// `xclip`/`wl-paste` are separate installs, and Windows needs a PowerShell that can reach
// an STA clipboard. When they all miss there is still one clipboard reader guaranteed to be
// present on the user's machine: the editor itself.
//
// A webview runs in the LOCAL Electron renderer even when the workspace is remote, so
// `navigator.clipboard.read()` there sees the user's real clipboard and hands back image
// blobs directly — no external tool, no X11/Wayland split, no PowerShell edition problem.
// If the renderer refuses the read without a user gesture, the same page falls back to a
// focused paste target and the user presses Ctrl+V once.
//
// Kept in its own module because it is a different mechanism with a different failure mode
// from the pure command builders next door, and because it is the only part of the
// clipboard bridge that touches VS Code UI.

/** How long to wait for the page to answer before giving up, including the time a user
 * needs to press Ctrl+V on the fallback paste target. */
const READ_TIMEOUT_MS = 30_000;

/** Refuse anything absurd rather than streaming it over the SSH channel. A screenshot is
 * a few hundred KB; this is a guard against a clipboard holding something else entirely. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The narrow logger slice this module uses. */
interface WebviewLog {
    trace(message: string): void;
}

/**
 * Read an image from the local clipboard through a webview. Resolves `undefined` when the
 * clipboard holds no image, the user dismissed the panel, or the read timed out — all of
 * which are "no image", never an error the caller has to handle.
 *
 * The panel takes focus: `navigator.clipboard.read()` rejects on an unfocused document, and
 * the manual paste fallback obviously needs the keystroke. Focus is handed back to
 * `restoreFocus` afterwards so the user is left where they started.
 */
export function readClipboardImageViaWebview(log: WebviewLog, restoreFocus?: vscode.Terminal): Promise<Uint8Array | undefined> {
    return new Promise<Uint8Array | undefined>(resolve => {
        const panel = vscode.window.createWebviewPanel(
            'openremotessh.clipboardImage',
            'Paste image',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            // No local resources are referenced, so nothing needs to be reachable — the
            // narrowest root list the API accepts.
            { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] },
        );

        let settled = false;
        const finish = (bytes: Uint8Array | undefined, why: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            log.trace(`clipboard webview: ${why}`);
            panel.dispose();
            // Put the caret back in the terminal the paste was aimed at, so the fallback
            // path does not leave the user in a disposed editor group.
            restoreFocus?.show(false);
            resolve(bytes);
        };

        const timer = setTimeout(() => finish(undefined, 'timed out waiting for the clipboard'), READ_TIMEOUT_MS);

        panel.onDidDispose(() => finish(undefined, 'dismissed'));

        panel.webview.onDidReceiveMessage((message: { type?: string; base64?: string }) => {
            if (message?.type !== 'image' || typeof message.base64 !== 'string') {
                finish(undefined, `no image (${message?.type ?? 'unknown'})`);
                return;
            }
            const bytes = Buffer.from(message.base64, 'base64');
            if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
                finish(undefined, `rejected image of ${bytes.byteLength} bytes`);
                return;
            }
            finish(new Uint8Array(bytes), `read ${bytes.byteLength} bytes`);
        });

        panel.webview.html = PAGE;
    });
}

/** The page runs locally in the editor's renderer. It reports exactly one message and then
 * waits to be disposed; the extension side owns every timeout and every decision. */
const PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
             font-family:var(--vscode-font-family);color:var(--vscode-foreground)">
  <div id="zone" tabindex="0" style="padding:32px 48px;border-radius:12px;text-align:center;
       border:2px dashed var(--vscode-focusBorder);outline:none">
    <div id="msg">Reading clipboard…</div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const zone = document.getElementById('zone');
  const msg = document.getElementById('msg');
  let done = false;

  function send(type, base64) {
    if (done) { return; }
    done = true;
    vscode.postMessage({ type: type, base64: base64 });
  }

  function sendBlob(blob) {
    const reader = new FileReader();
    // readAsDataURL gives "data:<mime>;base64,<payload>" — take everything after the comma.
    reader.onload = () => send('image', String(reader.result).split(',')[1]);
    reader.onerror = () => send('none');
    reader.readAsDataURL(blob);
  }

  async function auto() {
    try {
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            msg.textContent = 'Got it';
            sendBlob(await item.getType(type));
            return;
          }
        }
      }
      send('none');
    } catch (err) {
      // Read blocked without a user gesture (the usual reason) — ask for the gesture.
      manual();
    }
  }

  function manual() {
    msg.innerHTML = 'Press <b>Ctrl+V</b> (<b>Cmd+V</b> on macOS) to paste your image';
    zone.focus();
    document.addEventListener('paste', e => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          // getAsFile() is specified to return null when the item is not a file, and it
          // does so in practice for some synthetic clipboard payloads. Passing that null on
          // made readAsDataURL(null) throw inside this listener, so no message was ever
          // posted and the panel sat on "Got it" for the full read timeout before the
          // extension gave up — a 30-second freeze for what is simply "no image here".
          // (No backticks in this comment: it lives inside a template literal.)
          const file = item.getAsFile();
          if (!file) {
            send('none');
            return;
          }
          msg.textContent = 'Got it';
          sendBlob(file);
          return;
        }
      }
      send('none');
    });
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') { send('none'); } });
  auto();
</script>
</body>
</html>`;

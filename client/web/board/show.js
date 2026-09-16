/**
 * Putting the open project on a projector.
 *
 * Two buttons in the header rather than a tab, because starting a show is not
 * a stage of the work — it is a thing you do to whatever is open, from
 * wherever you happen to be. The tab that drives a running show comes next;
 * this is the part without which none of it is reachable at all.
 *
 * The stage is a separate **window**, not a tab and not an iframe. That is the
 * whole point: the operator drags it onto the projector, presses F11, and
 * `fitStage` letterboxes the 1920x1080 surface onto whatever the venue turned
 * up with — while the board stays in front of them on the laptop panel. A tab
 * could not be in two places, and an iframe could not be fullscreened on the
 * second display.
 *
 * There is no token on that URL and no room code in it. Both existed because
 * the display was one of three surfaces on a public server; it is now a window
 * opened by the process it talks to, over loopback.
 */

import { $ } from './dom.js';

const state = {
  /** What `/api/show` last said. Null before the first answer. */
  status: null,
  /** The stage window we opened, so Stop can take it away with the show. */
  stage: null,
  getProject: () => null,
  onStatus: () => {},
};

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

function render() {
  const running = state.status?.running === true;
  const project = state.getProject();

  $('show-play').hidden = running;
  $('show-stop').hidden = !running;
  $('show-stage').hidden = !running;
  $('show-play').disabled = !project;

  const label = $('show-state');
  if (!running) {
    label.hidden = true;
    label.textContent = '';
    return;
  }
  label.hidden = false;
  // Names the project rather than saying "running", because the thing worth
  // knowing while three folders are open in three windows is *which* one is on
  // the wall — that is also what the edit refusals will name.
  label.textContent = `${state.status.project} on the projector`;
  label.dataset.linked = state.status.room ? 'yes' : 'no';
}

export async function refreshShow() {
  try {
    state.status = await api('/api/show');
  } catch {
    // The show routes live in this same process, so a failure here means the
    // process is gone and every other control is about to fail too. Nothing
    // useful to say that the next click will not say better.
    state.status = null;
  }
  render();
}

/** Opens the projector window, or brings the one we already opened forward. */
function openStage() {
  // Named, so pressing this twice focuses the window rather than opening a
  // second projector showing the same show.
  state.stage = window.open('/stage/', 'is-stage', 'popup,width=1280,height=720');
  state.stage?.focus();
}

export function initShow({ getProject, onStatus }) {
  state.getProject = getProject;
  state.onStatus = onStatus;

  $('show-play').addEventListener('click', async () => {
    const project = state.getProject();
    if (!project) return;
    try {
      state.status = await api('/api/show/start', {
        method: 'POST',
        body: JSON.stringify({ project }),
      });
      render();
      openStage();
      // Said out loud, because the warnings are the checker's and this is the
      // last moment anybody reads them before an audience does.
      const warnings = state.status.warnings?.length ?? 0;
      onStatus(
        warnings > 0 ? 'warn' : 'ok',
        warnings > 0
          ? `${state.status.scenario.title} is running — ${warnings} warning${warnings === 1 ? '' : 's'} from the checker`
          : `${state.status.scenario.title} is running`,
      );
    } catch (err) {
      onStatus('error', err.message);
    }
  });

  $('show-stage').addEventListener('click', openStage);

  $('show-stop').addEventListener('click', async () => {
    try {
      const result = await api('/api/show/stop', { method: 'POST' });
      state.status = result;
      render();
      // The window goes with the show. A projector left showing the last frame
      // of something that has ended is worse than a black screen, because it
      // reads as a show that is still running.
      state.stage?.close();
      state.stage = null;
      onStatus('ok', result.stopped ? 'show stopped' : 'no show was running');
    } catch (err) {
      onStatus('error', err.message);
    }
  });

  void refreshShow();
}

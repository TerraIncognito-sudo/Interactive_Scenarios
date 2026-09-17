/**
 * The gate both console pages sit behind, and the fetch helper they share.
 *
 * One shared module rather than two copies, because the two pages are one
 * decision — who may look at this relay — and a second copy of it is a second
 * answer waiting to disagree. The password itself is `auth.ts`'s business;
 * this is only the part that runs in a browser.
 */

export const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      // Only when there is something to declare. Fastify refuses a POST that
      // announces a JSON body and sends none, which is every button on these
      // pages — Revoke and End take no arguments at all.
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * Resolves once the browser is signed in, showing the form until it is.
 *
 * The cookie is checked first rather than assumed absent: a signed-in operator
 * reloading the page should land on what they came to look at, and a relay is
 * looked at in a hurry.
 */
export async function requireSignIn(): Promise<void> {
  const gate = el('gate');
  const shell = el('shell');

  const { authenticated } = await api<{ authenticated: boolean }>('/api/session');
  if (authenticated) {
    gate.hidden = true;
    shell.hidden = false;
    return;
  }

  gate.hidden = false;
  shell.hidden = true;

  return new Promise<void>((resolve) => {
    const form = el<HTMLFormElement>('sign-in');
    const error = el('sign-in-error');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      try {
        await api('/api/login', {
          method: 'POST',
          body: JSON.stringify({ password: el<HTMLInputElement>('password').value }),
        });
      } catch (err) {
        error.textContent = (err as Error).message;
        return;
      }
      gate.hidden = true;
      shell.hidden = false;
      resolve();
    });
  });
}

/** "4 minutes ago", for a list read at a glance while something is going wrong. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

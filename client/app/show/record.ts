/**
 * Writing down how a room voted.
 *
 * The Room keeps the record while the show runs and drops it when the show
 * ends, which is right for a rehearsal and wrong for the one evening it
 * mattered: an audience answered six questions, the laptop was closed, and the
 * only account of it was whatever the operator remembered on the drive home.
 *
 * So this is a deliberate act with a button in front of it, and it is offered
 * only once a poll has been taken in a real room. `VoteLog` says why, and the
 * reasoning is unchanged: a rehearsal's ballots are imaginary people who can
 * be asked again by pressing the button again, and writing a file for every
 * afternoon of them would leave a folder of records nobody can cite, in a
 * directory that syncs to somebody's cloud drive. A record is evidence or it
 * is litter.
 *
 * Markdown, because the reader is a person. The counts are in it, so the
 * numbers survive; the shape is a page, so it can be pasted into an email
 * about what the room decided.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PollRecord } from '../../../shared/show/protocol.ts';

/** `2026-09-16 19:42`, and `2026-09-16-1942` for the filename. */
function stamp(at: number): { readable: string; slug: string } {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { readable: `${date} ${time}`, slug: `${date}-${time.replace(':', '')}` };
}

/** `78%`, or `—` for a poll nobody answered. Whole numbers; this is prose. */
function share(count: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((count / total) * 100)}%`;
}

/**
 * What to say about a decision that was not simply the most votes winning.
 *
 * Every one of these is a thing somebody will ask about afterwards, and the
 * answer is not recoverable from the counts alone — a forced branch and a
 * landslide look identical in a table.
 */
function caveatFor(poll: PollRecord): string | undefined {
  if (poll.forced) {
    return `Decided by the operator rather than by the vote${
      poll.total > 0 ? ', against the counts below' : ''
    }.`;
  }
  if (poll.usedDefault) return "Nobody voted, so the poll's declared default was used.";
  if (poll.usedTiebreak) return "The top count was shared, and the poll's tie-break rule decided it.";
  return undefined;
}

export function renderRecord(options: {
  title: string;
  project: string;
  polls: readonly PollRecord[];
  at: number;
}): string {
  const { readable } = stamp(options.at);
  // Named off the polls rather than off the link, because the link is a
  // *current* fact and this is a past one: a show that went live for the
  // second half and was unlinked by the time somebody pressed Export still
  // took four of its votes in a room.
  const rooms = [...new Set(options.polls.map((poll) => poll.room).filter(Boolean))];
  const live = options.polls.filter((poll) => poll.room !== undefined).length;

  const lines: string[] = [
    `# ${options.title}`,
    '',
    `${readable} · ${options.project}`,
    '',
    rooms.length > 0
      ? `${options.polls.length} poll${options.polls.length === 1 ? '' : 's'}, ` +
        `${live} of them in ${rooms.length === 1 ? `room ${rooms[0]}` : `rooms ${rooms.join(', ')}`}.`
      : `${options.polls.length} poll${options.polls.length === 1 ? '' : 's'}, all rehearsed — ` +
        `no room was linked, so these are simulated votes.`,
    '',
  ];

  options.polls.forEach((poll, index) => {
    lines.push(`## ${index + 1}. ${poll.question}`);
    lines.push('');
    lines.push(
      `**${poll.winnerLabel}** wins · ${poll.total} vote${poll.total === 1 ? '' : 's'} from ` +
        `${poll.voters} ${poll.voters === 1 ? 'device' : 'devices'} · ` +
        (poll.room !== undefined ? `room ${poll.room}` : 'rehearsal') +
        ` · \`${poll.nodeId}\``,
    );
    lines.push('');

    const caveat = caveatFor(poll);
    if (caveat) {
      lines.push(`> ${caveat}`);
      lines.push('');
    }

    lines.push('| Option | Votes | Share |');
    lines.push('| --- | ---: | ---: |');
    for (const option of poll.options) {
      const count = poll.counts[option.key] ?? 0;
      const label = option.key === poll.winner ? `**${option.label}**` : option.label;
      lines.push(`| ${label} | ${count} | ${share(count, poll.total)} |`);
    }
    lines.push('');
  });

  return `${lines.join('\n')}`;
}

/**
 * Writes the record into the project it belongs to.
 *
 * Into `records/` beside the scenario rather than somewhere central, because a
 * show's results belong with the show: a project folder moved to another
 * machine or opened next year should carry what its audiences decided.
 *
 * Not guarded by `assertNotShowing`, deliberately. That refusal exists for
 * edits that move bytes under `assets/`, which the projector reads off disk as
 * it asks for them; this writes a new file in a folder nothing in the show has
 * ever opened, and the only moment anybody wants it is while the show is still
 * running.
 */
export async function writeRecord(options: {
  dir: string;
  title: string;
  project: string;
  polls: readonly PollRecord[];
  at?: number;
}): Promise<{ file: string; polls: number }> {
  const at = options.at ?? Date.now();
  const { slug } = stamp(at);
  const dir = join(options.dir, 'records');
  await mkdir(dir, { recursive: true });

  const file = join(dir, `${slug}.md`);
  await writeFile(file, renderRecord({ ...options, at }), 'utf8');
  return { file, polls: options.polls.length };
}

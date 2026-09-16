/**
 * Where a rehearsal's ballots go, which is nowhere.
 *
 * The public server kept a Room's votes in SQLite because a container restart
 * must not end a live session: forty phones are the part you cannot ask to do
 * it again. None of that is true here, and none of it is lost — a real
 * audience's ballots live in the relay's database, several hops away, which is
 * exactly what `roomResumed` hands back to a link that dropped. What is left
 * on this side is simulated voters, and a simulated voter can be asked to do
 * it again by pressing the button again.
 *
 * So this writes no file. That is not merely cheaper. A database here would
 * mean every rehearsal left a record on somebody's disk of which way it
 * branched and how many imaginary people picked what, in a folder they back up
 * to OneDrive, for no reader.
 *
 * It exists at all because a `BallotBox` is built when a poll opens and
 * dropped when it closes, while the ballots have to outlive it: stepping back
 * into a poll has to find the split that was there, or trying a second split
 * costs a restart and nobody tries one.
 */

export type Ballot = { deviceId: string; optionKey: string; at: number };

export class VoteLog {
  /** Keyed by node, because a show can put two polls on one screen's worth of story. */
  private readonly polls = new Map<string, Map<string, Ballot>>();

  record(nodeId: string, deviceId: string, optionKey: string, at: number): void {
    let poll = this.polls.get(nodeId);
    if (!poll) {
      poll = new Map();
      this.polls.set(nodeId, poll);
    }
    // Keyed by device, the way the old table's primary key was: a voter may
    // change their mind until the poll closes, and the second choice replaces
    // the first rather than counting twice.
    poll.set(deviceId, { deviceId, optionKey, at });
  }

  /**
   * Takes one voter back out.
   *
   * Only a simulated voter is ever withdrawn — see `BallotBox.withdraw`. It has
   * to reach here rather than only the box, or stepping back into a poll
   * replays the ballots the operator has just cleared.
   */
  forget(nodeId: string, deviceId: string): void {
    this.polls.get(nodeId)?.delete(deviceId);
  }

  votesFor(nodeId: string): Ballot[] {
    return [...(this.polls.get(nodeId)?.values() ?? [])];
  }
}

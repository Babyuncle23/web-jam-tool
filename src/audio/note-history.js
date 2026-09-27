/**
 * Undo stack for one player's note loop.
 * Snapshots are plain event lists from PerformanceRecorder.exportEvents.
 * They are not audio buffers and not drum or effect state.
 */
export function createNoteHistory(limit = 40) {
  const past = [];
  const future = [];

  return {
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    push(snapshot) {
      past.push(snapshot);
      if (past.length > limit) past.shift();
      future.length = 0;
    },
    undo(current) {
      if (!past.length) return null;
      const previous = past.pop();
      future.push(current);
      return previous;
    },
    redo(current) {
      if (!future.length) return null;
      const next = future.pop();
      past.push(current);
      return next;
    },
  };
}

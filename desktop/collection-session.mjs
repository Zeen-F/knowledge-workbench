// Session-only desktop choice; an explicit panel request never changes it.
// Validate before screen access and cancel pending validation on navigation.
export function createCollectionSession({ validate, choose, capture }) {
  let active = null,
    pending = false,
    generation = 0;
  return {
    clear() {
      generation++;
      active = null;
      pending = false;
    },
    async select(id) {
      const current = ++generation;
      await validate(id);
      if (current !== generation) throw new Error("收集任务选择已取消");
      active = id;
      const captureRequested = pending;
      pending = false;
      return { captureRequested };
    },
    async start(explicit) {
      const id = explicit || active,
        current = generation;
      if (!id) {
        pending = true;
        choose();
        return { needsTask: true };
      }
      await validate(id);
      if (current !== generation) return { cancelled: true };
      return capture(id);
    },
  };
}

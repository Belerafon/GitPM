export interface HierarchyTask {
  readonly id: string;
  readonly parent?: string;
}

export interface TaskHierarchyEntry<T extends HierarchyTask> {
  readonly task: T;
  readonly depth: number;
  readonly parentId?: string;
  readonly hasChildren: boolean;
}

export interface TaskHierarchy<T extends HierarchyTask> {
  readonly tasks: ReadonlyMap<string, T>;
  childrenOf(parentId?: string): readonly T[];
  ancestorsOf(id: string): readonly T[];
  descendantsOf(id: string): readonly T[];
  depthOf(id: string): number;
  flatten(): readonly TaskHierarchyEntry<T>[];
  pathTo(id: string): readonly T[];
}

export interface TaskHierarchyOptions<T extends HierarchyTask> {
  readonly order?: readonly string[];
  readonly compare?: (left: T, right: T) => number;
}

export function buildTaskHierarchy<T extends HierarchyTask>(
  input: readonly T[],
  options: TaskHierarchyOptions<T> = {},
): TaskHierarchy<T> {
  const tasks = new Map(input.map((task) => [task.id, task]));
  const inputOrder = new Map(input.map((task, index) => [task.id, index]));
  const explicitOrder = new Map((options.order ?? []).map((id, index) => [id, index]));
  const compare = (left: T, right: T): number => {
    const leftOrder = explicitOrder.get(left.id);
    const rightOrder = explicitOrder.get(right.id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
    return options.compare?.(left, right)
      ?? (inputOrder.get(left.id) ?? 0) - (inputOrder.get(right.id) ?? 0);
  };

  const children = new Map<string | undefined, T[]>();
  for (const task of input) {
    const parentId = task.parent;
    const validParent = parentId !== undefined && parentId !== task.id && tasks.has(parentId);
    const key = validParent ? parentId : undefined;
    const peers = children.get(key) ?? [];
    peers.push(task);
    children.set(key, peers);
  }
  for (const peers of children.values()) peers.sort(compare);

  const childrenOf = (parentId?: string): readonly T[] => children.get(parentId) ?? [];
  const ancestorsOf = (id: string): readonly T[] => {
    const ancestors: T[] = [];
    const seen = new Set([id]);
    let current = tasks.get(id);
    while (current?.parent !== undefined && !seen.has(current.parent)) {
      const parent = tasks.get(current.parent);
      if (parent === undefined) break;
      ancestors.unshift(parent);
      seen.add(parent.id);
      current = parent;
    }
    return ancestors;
  };
  const descendantsOf = (id: string): readonly T[] => {
    const descendants: T[] = [];
    const seen = new Set([id]);
    const visit = (parentId: string) => {
      for (const child of childrenOf(parentId)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        descendants.push(child);
        visit(child.id);
      }
    };
    visit(id);
    return descendants;
  };
  const depthOf = (id: string): number => ancestorsOf(id).length;
  const flatten = (): readonly TaskHierarchyEntry<T>[] => {
    const entries: TaskHierarchyEntry<T>[] = [];
    const visited = new Set<string>();
    const visit = (task: T, depth: number) => {
      if (visited.has(task.id)) return;
      visited.add(task.id);
      entries.push({
        task,
        depth,
        ...(task.parent !== undefined && tasks.has(task.parent) ? { parentId: task.parent } : {}),
        hasChildren: childrenOf(task.id).length > 0,
      });
      for (const child of childrenOf(task.id)) visit(child, depth + 1);
    };
    for (const root of childrenOf()) visit(root, 0);
    for (const task of [...input].sort(compare)) visit(task, 0);
    return entries;
  };

  return {
    tasks,
    childrenOf,
    ancestorsOf,
    descendantsOf,
    depthOf,
    flatten,
    pathTo: (id) => {
      const task = tasks.get(id);
      return task === undefined ? [] : [...ancestorsOf(id), task];
    },
  };
}

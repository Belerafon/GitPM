import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type AsyncLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly error: string };

interface LoadOptions {
  readonly keepData?: boolean;
}

/**
 * Runs only the latest load to completion. This keeps "not loaded" distinct from
 * genuinely empty data and prevents a slow, stale response from replacing a newer one.
 */
export function useAsyncLoad() {
  const [state, setState] = useState<AsyncLoadState>({ status: "loading" });
  const request = useRef(0);

  const run = useCallback(async <T,>(loader: () => Promise<T>, apply: (data: T) => void, { keepData = false }: LoadOptions = {}): Promise<T | undefined> => {
    const currentRequest = ++request.current;
    if (!keepData) setState({ status: "loading" });
    try {
      const data = await loader();
      if (request.current === currentRequest) {
        apply(data);
        setState({ status: "ready" });
      }
      return data;
    } catch (caught) {
      if (request.current === currentRequest) setState({ status: "error", error: caught instanceof Error ? caught.message : String(caught) });
      return undefined;
    }
  }, []);

  useEffect(() => () => { request.current += 1; }, []);
  return { state, run } as const;
}

export function AsyncBoundary({ state, loading, retry, error, children }: {
  readonly state: AsyncLoadState;
  readonly loading: string;
  readonly retry: () => void;
  readonly error: (message: string, retry: () => void) => ReactNode;
  readonly children: ReactNode;
}) {
  if (state.status === "loading") return <div className="card workspace-loading" role="status"><span className="loading-indicator" aria-hidden="true" />{loading}</div>;
  if (state.status === "error") return <>{error(state.error, retry)}</>;
  return <>{children}</>;
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type AsyncLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly refreshError?: string }
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
  const hasData = useRef(false);

  const run = useCallback(async <T,>(loader: () => Promise<T>, apply: (data: T) => void, { keepData = true }: LoadOptions = {}): Promise<T | undefined> => {
    const currentRequest = ++request.current;
    const preservesData = keepData && hasData.current;
    if (preservesData) setState({ status: "ready" });
    else setState({ status: "loading" });
    try {
      const data = await loader();
      if (request.current === currentRequest) {
        apply(data);
        hasData.current = true;
        setState({ status: "ready" });
      }
      return data;
    } catch (caught) {
      if (request.current === currentRequest) {
        const error = caught instanceof Error ? caught.message : String(caught);
        setState(preservesData ? { status: "ready", refreshError: error } : { status: "error", error });
      }
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
  return <>{state.refreshError === undefined ? null : error(state.refreshError, retry)}{children}</>;
}

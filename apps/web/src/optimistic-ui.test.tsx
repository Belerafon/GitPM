// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlipList } from "./optimistic-ui.js";

interface TestItem {
  readonly key: string;
  readonly rect: string;
}

interface FlipHostProps {
  readonly items: readonly TestItem[];
  readonly hostRect?: string;
  readonly reducedMotion?: boolean;
}

function FlipHost({ items, hostRect = "0,0", reducedMotion = false }: FlipHostProps) {
  const ref = useFlipList<HTMLDivElement>(reducedMotion);
  return (
    <div ref={ref} data-rect={hostRect}>
      {items.map((item) => <div data-flip-key={item.key} data-rect={item.rect} key={item.key} />)}
    </div>
  );
}

function parseRect(value: string): { readonly left: number; readonly top: number } {
  const parts = value.split(",").map((part) => Number(part.trim()));
  const left = parts[0];
  const top = parts[1];
  return { left: left !== undefined && Number.isFinite(left) ? left : 0, top: top !== undefined && Number.isFinite(top) ? top : 0 };
}

function installRectMock() {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const marker = this.dataset?.rect;
    if (marker !== undefined) {
      const { left, top } = parseRect(marker);
      return { left, top, x: left, y: top, right: left + 100, bottom: top + 20, width: 100, height: 20, toJSON: () => ({}) } as DOMRect;
    }
    return { left: 0, top: 0, x: 0, y: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

type AnimateProperty = ((this: HTMLElement, keyframes: unknown, options?: unknown) => unknown) | undefined;

describe("useFlipList", () => {
  const animateMock = vi.fn();
  let rectSpy: ReturnType<typeof installRectMock>;
  let originalAnimate: AnimateProperty;

  beforeEach(() => {
    originalAnimate = (Element.prototype as { animate?: AnimateProperty }).animate;
    (Element.prototype as { animate?: AnimateProperty }).animate = animateMock as unknown as NonNullable<AnimateProperty>;
    animateMock.mockReset();
    rectSpy = installRectMock();
  });

  afterEach(() => {
    rectSpy.mockRestore();
    if (originalAnimate === undefined) delete (Element.prototype as { animate?: AnimateProperty }).animate;
    else (Element.prototype as { animate?: AnimateProperty }).animate = originalAnimate;
    cleanup();
  });

  it("does not animate when only a scroll ancestor shifts between renders", () => {
    const { rerender } = render(<FlipHost items={[{ key: "A", rect: "0,0" }, { key: "B", rect: "0,40" }]} hostRect="0,0" />);
    expect(animateMock).not.toHaveBeenCalled();
    // The user scrolled: the scrollable ancestor (and therefore the host and every item) shifts up by 50px.
    rerender(<FlipHost items={[{ key: "A", rect: "0,-50" }, { key: "B", rect: "0,-10" }]} hostRect="0,-50" />);
    expect(animateMock).not.toHaveBeenCalled();
  });

  it("does not animate when the container scrolls itself", () => {
    const { container, rerender } = render(<FlipHost items={[{ key: "A", rect: "0,0" }, { key: "B", rect: "0,40" }]} hostRect="0,0" />);
    const host = container.firstElementChild as HTMLElement;
    // The host scrolled down by 50: items move up visually by 50, host.scrollTop tracks the offset.
    host.scrollTop = 50;
    rerender(<FlipHost items={[{ key: "A", rect: "0,-50" }, { key: "B", rect: "0,-10" }]} hostRect="0,0" />);
    expect(animateMock).not.toHaveBeenCalled();
  });

  it("animates elements that swap positions", () => {
    const { rerender } = render(<FlipHost items={[{ key: "A", rect: "0,0" }, { key: "B", rect: "0,40" }]} hostRect="0,0" />);
    animateMock.mockClear();
    rerender(<FlipHost items={[{ key: "A", rect: "0,40" }, { key: "B", rect: "0,0" }]} hostRect="0,0" />);
    expect(animateMock).toHaveBeenCalled();
    // A moved from y=0 to y=40 → it starts at translate(0, -40) and eases to 0.
    const movingA = animateMock.mock.calls.find((call) => {
      const keyframes = call[0] as ReadonlyArray<{ readonly transform?: string }>;
      return keyframes[0]?.transform === "translate(0px, -40px)" && keyframes[1]?.transform === "translate(0, 0)";
    });
    expect(movingA).toBeDefined();
  });

  it("does not animate while reduced motion is enabled", () => {
    const { rerender } = render(<FlipHost items={[{ key: "A", rect: "0,0" }]} hostRect="0,0" reducedMotion={true} />);
    animateMock.mockClear();
    rerender(<FlipHost items={[{ key: "A", rect: "0,60" }]} hostRect="0,0" reducedMotion={true} />);
    expect(animateMock).not.toHaveBeenCalled();
  });

  it("does not animate when keys are added or removed without repositioning survivors", () => {
    const { rerender } = render(<FlipHost items={[{ key: "A", rect: "0,0" }, { key: "B", rect: "0,40" }]} hostRect="0,0" />);
    animateMock.mockClear();
    rerender(<FlipHost items={[{ key: "B", rect: "0,40" }, { key: "C", rect: "0,80" }]} hostRect="0,0" />);
    expect(animateMock).not.toHaveBeenCalled();
  });
});

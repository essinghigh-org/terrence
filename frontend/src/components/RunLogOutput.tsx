import { useLayoutEffect, useRef } from "react";

export function RunLogOutput({ active, children, className }: Readonly<{
  active: boolean;
  children: string;
  className: string;
}>): React.JSX.Element {
  const element = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const previousTop = useRef(0);
  const positioned = useRef(false);

  useLayoutEffect(() => {
    const pane = element.current;
    if (pane === null) return;
    const follow = (): void => {
      if ((!active && !positioned.current) || !following.current || pane.clientHeight === 0) return;
      const smooth = positioned.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      pane.scrollTo({ top: pane.scrollHeight, behavior: smooth ? "smooth" : "instant" });
      positioned.current = true;
    };
    follow();
    // A log may mount inside a closed disclosure; follow when it becomes visible.
    const observer = new ResizeObserver(follow);
    observer.observe(pane);
    return () => { observer.disconnect(); };
  }, [active, children]);

  return <pre ref={element} className={className} onScroll={(event) => {
    const pane = event.currentTarget;
    if (pane.scrollTop < previousTop.current) following.current = false;
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 24) following.current = true;
    previousTop.current = pane.scrollTop;
  }}>{children}</pre>;
}

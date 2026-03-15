import { useRef, useEffect, useCallback } from 'react';

export function useCanvas(draw, deps) {
  const ref     = useRef(null);
  const drawRef = useRef(draw);
  const rafRef  = useRef(null);

  // Always keep the latest draw function so ResizeObserver uses fresh data
  useEffect(() => { drawRef.current = draw; });

  const doDraw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.offsetWidth;
    const H   = canvas.offsetHeight;
    if (!W || !H) return;
    // Only update pixel buffer when size changed to avoid unnecessary realloc
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRef.current(ctx, W, H);
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      doDraw();
    });
  }, [doDraw]);

  // Repaint when deps change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scheduleDraw(); return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } }; }, deps);

  // Also repaint when the canvas element itself resizes
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => scheduleDraw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [scheduleDraw]);

  // Cleanup on unmount
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return ref;
}

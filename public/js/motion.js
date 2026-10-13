// True when the visitor's device asks for reduced motion; animations are skipped or shortened.
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** CL-01: the elapsed time an AI wait shows. Whole seconds, "12 s", and "1 min 5 s" from one minute on. A bad or negative value reads "0 s". Presentation only. */
export function elapsedLabel(totalSeconds: number): string {
  const whole = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  if (whole < 60) return `${whole} s`;
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

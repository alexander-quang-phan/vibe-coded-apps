// The bar colour and copy for how much of a budget is used. Amber into rose, never
// red. Shared by the Budgets page and the trip bars.
export function progressTone(percent) {
  if (percent >= 1)
    return {
      bar: 'from-rose-400 to-rose-500',
      copy: "You've gone over — want to adjust next month?",
    };
  if (percent >= 0.9)
    return {
      bar: 'from-amber-300 to-amber-500',
      copy: 'Getting close — tread lightly.',
    };
  if (percent >= 0.75)
    return {
      bar: 'from-amber-200 to-amber-400',
      copy: 'On track, but watch the last stretch.',
    };
  return {
    bar: 'from-emerald-400 to-primary',
    copy: 'You have room to breathe.',
  };
}

import confetti from 'canvas-confetti';

// Trim's signature celebrations. Three flavours, each tied to a product event.

export function celebrateLevelUp() {
  const end = Date.now() + 1200;
  const colors = ['#22c55e', '#10b981', '#facc15', '#fde68a'];
  (function frame() {
    confetti({
      particleCount: 3,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.7 },
      colors,
    });
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.7 },
      colors,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

export function celebrateStreakMilestone() {
  confetti({
    particleCount: 80,
    spread: 90,
    startVelocity: 35,
    origin: { y: 0.6 },
    colors: ['#f97316', '#facc15', '#ef4444'],
  });
}

export function celebrateShieldEarned() {
  confetti({
    particleCount: 60,
    spread: 70,
    startVelocity: 30,
    origin: { y: 0.55 },
    colors: ['#38bdf8', '#60a5fa', '#e0f2fe'],
  });
}

export function celebrateGoalMilestone() {
  confetti({
    particleCount: 100,
    spread: 100,
    startVelocity: 40,
    origin: { y: 0.6 },
    colors: ['#22c55e', '#10b981', '#34d399', '#fde68a'],
  });
}

export function celebrateGoalCompleted() {
  const end = Date.now() + 1800;
  const colors = ['#22c55e', '#10b981', '#fde68a', '#facc15', '#34d399'];
  (function frame() {
    confetti({
      particleCount: 5,
      angle: 60,
      spread: 70,
      origin: { x: 0, y: 0.8 },
      colors,
    });
    confetti({
      particleCount: 5,
      angle: 120,
      spread: 70,
      origin: { x: 1, y: 0.8 },
      colors,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

// Streak / shield / XP / level logic for Trim.
// Pure functions — no DB access. Call from route handlers after a user logs a
// transaction. Given the user's current stats and today's date, return the
// next stats plus a delta object the API can hand back to the client for
// toasts and celebrations.

const XP_PER_LOG = 10;
const XP_PER_LEVEL = 100;
const SHIELD_MILESTONE = 7;   // earn a shield every 7 consecutive days
const SHIELD_CAP = 2;

const LEVEL_TITLES = [
  { min: 1,   title: 'Budget Beginner' },
  { min: 5,   title: 'Penny Pincher' },
  { min: 10,  title: 'Coin Collector' },
  { min: 15,  title: 'Savvy Spender' },
  { min: 20,  title: 'Money Monk' },
  { min: 30,  title: 'Budget Ninja' },
  { min: 50,  title: 'Trim Master' },
  { min: 75,  title: 'Finance Sage' },
  { min: 100, title: 'Legend' },
];

export function titleForLevel(level) {
  let title = LEVEL_TITLES[0].title;
  for (const entry of LEVEL_TITLES) {
    if (level >= entry.min) title = entry.title;
  }
  return title;
}

export function levelProgress(xpPoints) {
  const level = Math.floor(xpPoints / XP_PER_LEVEL) + 1;
  const xpIntoLevel = xpPoints % XP_PER_LEVEL;
  return {
    level,
    title: titleForLevel(level),
    xpIntoLevel,
    xpForNextLevel: XP_PER_LEVEL,
    xpToNextLevel: XP_PER_LEVEL - xpIntoLevel,
  };
}

function diffDays(laterISO, earlierISO) {
  // Both are 'YYYY-MM-DD'. UTC-midnight subtraction avoids DST drift.
  const a = new Date(`${laterISO}T00:00:00Z`).getTime();
  const b = new Date(`${earlierISO}T00:00:00Z`).getTime();
  return Math.round((a - b) / 86_400_000);
}

/**
 * @param {object} stats  existing user_stats row
 * @param {string} todayISO  'YYYY-MM-DD' (server's date, UTC)
 * @returns {{ next: object, delta: object }}
 *   next  = new values to write back to user_stats
 *   delta = things the client should celebrate (xp, levelUp, shieldEarned, streakExtended, shieldUsed)
 */
export function applyLogEvent(stats, todayISO) {
  const prev = {
    currentStreak: stats.current_streak ?? 0,
    longestStreak: stats.longest_streak ?? 0,
    shields: stats.shields ?? 0,
    xpPoints: stats.xp_points ?? 0,
    level: stats.level ?? 1,
    lastLoggedDate: stats.last_logged_date,
  };

  let currentStreak = prev.currentStreak;
  let shields = prev.shields;
  let shieldUsed = false;
  let streakExtended = false;

  if (!prev.lastLoggedDate) {
    currentStreak = 1;
    streakExtended = true;
  } else {
    const days = diffDays(todayISO, prev.lastLoggedDate);
    if (days <= 0) {
      // Same day (or server clock weirdness) — no streak change.
    } else if (days === 1) {
      currentStreak += 1;
      streakExtended = true;
    } else if (days === 2 && shields > 0) {
      shields -= 1;
      currentStreak += 1;
      streakExtended = true;
      shieldUsed = true;
    } else {
      currentStreak = 1;
      streakExtended = true;
    }
  }

  // Earn a shield at every SHIELD_MILESTONE crossing, capped.
  let shieldEarned = false;
  if (
    streakExtended &&
    currentStreak > prev.currentStreak &&
    currentStreak % SHIELD_MILESTONE === 0 &&
    shields < SHIELD_CAP
  ) {
    shields += 1;
    shieldEarned = true;
  }

  const longestStreak = Math.max(prev.longestStreak, currentStreak);
  const xpPoints = prev.xpPoints + XP_PER_LOG;
  const { level } = levelProgress(xpPoints);
  const levelUp = level > prev.level;

  return {
    next: {
      current_streak: currentStreak,
      longest_streak: longestStreak,
      shields,
      xp_points: xpPoints,
      level,
      last_logged_date: todayISO,
    },
    delta: {
      awardedXp: XP_PER_LOG,
      streakExtended,
      shieldUsed,
      shieldEarned,
      levelUp,
      newLevel: level,
      newTitle: titleForLevel(level),
      currentStreak,
      shields,
    },
  };
}

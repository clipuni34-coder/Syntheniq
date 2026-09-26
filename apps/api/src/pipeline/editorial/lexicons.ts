// Syntheniq — editorial cue lexicons (plain data; tunable per-niche,
// replaceable by a learned model later without touching scoring code).

export const HOOK_OPENERS = [
  'stop', 'never', 'always', 'nobody', 'everybody', 'everyone',
  'secret', 'truth', 'lie', 'myth', 'mistake', 'warning',
  'why', 'how', 'what', 'imagine', 'listen', 'look',
  'here', 'this', 'pov', 'watch', 'nobody talks', 'no one',
  'i learned', 'i tried', 'i stopped', 'i started', 'i wish',
  'day one', 'day 1', 'in 30 days', 'free', 'proven',
];

export const CURIOSITY_MARKERS = [
  'but', 'however', 'although', 'though', 'until', 'unless',
  'suddenly', 'unexpected', 'plot twist', 'turns out',
  'what happened', 'what happens', 'next', 'then i',
  'because', 'reason', 'why', 'secret', 'hidden',
  'nobody knows', 'no one knows', 'wait', 'stay',
  'here is the thing', "here's the thing", 'the catch',
  'part one', 'part 1', 'to be continued', 'first',
  'you will not believe', "you won't believe", 'shocking',
];

export const PAYOFF_MARKERS = [
  'finally', 'in the end', 'as a result', 'the result',
  'here is how', "here's how", 'this is how', 'the key',
  'the lesson', 'what i learned', 'takeaway', 'answer',
  'solution', 'works', 'proof', '100', 'step one', 'step 1',
  'first step', 'do this', 'try this', 'remember',
  'pro tip', 'the trick', 'bottom line', 'moral',
  'changed everything', 'game changer', 'breakthrough',
];

export const EMOTION_POSITIVE = [
  'love', 'amazing', 'incredible', 'beautiful', 'happy', 'excited',
  'grateful', 'proud', 'win', 'won', 'success', 'freedom',
  'dream', 'hope', 'inspired', 'fun', 'best', 'perfect',
  'brilliant', 'genius', 'unstoppable', 'blessed', 'celebrate',
];

export const EMOTION_NEGATIVE = [
  'hate', 'angry', 'furious', 'sad', 'cry', 'crying', 'tears',
  'fear', 'afraid', 'scared', 'worst', 'terrible', 'awful',
  'pain', 'painful', 'fail', 'failed', 'failure', 'mistake',
  'regret', 'sorry', 'broke', 'lost', 'alone', 'stress',
  'anxiety', 'kill', 'die', 'death', 'nightmare', 'stupid',
];

export const INTENSIFIERS = [
  'very', 'so', 'really', 'extremely', 'insanely', 'crazy',
  'literally', 'absolutely', 'completely', 'totally', 'never',
  'always', 'everyone', 'nobody', 'nothing', 'everything',
];

export const LEADING_PRONOUNS = ['it', 'this', 'that', 'these', 'those', 'they', 'he', 'she', 'there'];

export const CTA_PHRASES = [
  'subscribe', 'smash that', 'hit the bell', 'notification bell',
  'link in bio', 'link in the description', 'check out my',
  'follow for', 'follow me', 'like and subscribe', 'comment below',
  'sponsored', 'use code', 'discount code', 'affiliate',
];

export const FILLERS = ['um', 'uh', 'uhm', 'erm', 'like', 'you know', 'i mean', 'basically', 'actually'];

export const EMOTION_CRISIS = [
  'problem', 'struggle', 'challenge', 'obstacle', 'difficulty', 'issue',
  'mistake', 'error', 'failure', 'failed', 'fall', 'fallen', 'lose', 'lost',
  'pain', 'painful', 'hurt', 'suffer', 'suffering', 'struggle', 'battle',
  'fight', 'fighting', 'war', 'conflict', 'tension', 'stress', 'crisis',
  'breakdown', 'breaking', 'hard', 'harder', 'hardest', 'tough', 'tougher',
  'struggling', 'blew up', 'blew', 'explode', 'crashed', 'crash',
];

export const EMOTION_REVELATION = [
  'realize', 'realised', 'realize', 'realized', 'discovery', 'discovered',
  'reveal', 'revealed', 'revealing', 'truth', 'secret', 'secrets',
  'unveil', 'unveiled', 'uncover', 'uncovered', 'hidden', 'find', 'found',
  'aha', 'moment', 'epiphany', 'insight', 'understand', 'understood',
  'suddenly', 'unexpected', 'shocking', 'surprising', 'revelation',
  'breakthrough', 'eureka', 'clarity', 'enlighten', 'enlightened',
];

export const EMOTION_RECOVERY = [
  'recover', 'recovered', 'recovery', 'heal', 'healed', 'healing',
  'move on', 'moving on', 'overcome', 'overcame', 'conquer', 'conquered',
  'rise', 'rose', 'rising', 'resilience', 'resilient', 'strength',
  'strong', 'stronger', 'strongest', 'better', 'improve', 'improved',
  'growth', 'grow', 'grew', 'journey', 'progress', 'progressed',
  'forward', 'ahead', 'optimism', 'hope', 'hoping', 'positive',
];

export const EMOTION_TAGS: Record<string, { keywords: string[] }> = {
  crisis: { keywords: EMOTION_CRISIS },
  revelation: { keywords: EMOTION_REVELATION },
  recovery: { keywords: EMOTION_RECOVERY },
  positive: { keywords: EMOTION_POSITIVE },
  negative: { keywords: EMOTION_NEGATIVE },
};

export const TRAJECTORY_KEYWORDS: Record<string, string[]> = {
  escalating: ['build', 'escalate', 'intensify', 'increase', 'grow', 'rising', 'tension', 'climax'],
  declining: ['wind', 'down', 'decline', 'decrease', 'fade', 'diminish', 'settle', 'calm'],
  volatile: ['volatile', 'emotional', 'rollercoaster', 'ups', 'downs', 'wild', 'intense'],
  flat: ['flat', 'consistent', 'steady', 'stable', 'constant'],
};

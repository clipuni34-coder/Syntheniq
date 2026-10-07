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

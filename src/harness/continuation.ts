// ── harness/continuation.ts ───────────────────────────────────────────────
// A model that stops in the middle of the work. Some are cut off (the output
// limit, a dropped connection) and say so; some stop on their own after
// announcing the next step ("first the middle sections:"), after writing
// "part 1 of 3", or after asking whether to go on. The person asked for the
// whole job, so the harness tells them to go on instead of waiting for it to
// be typed. What is read here is only the end of the answer: a model that
// finished is left alone, and so is one that asked something it needs
// answered.
// ─────────────────────────────────────────────────────────────────────────────

export type UnfinishedReason = "open-fence" | "cut-off" | "colon" | "announced" | "asks-to-continue" | "part-marker";

export interface Unfinished {
  reason: UnfinishedReason;
  /** What joins the next piece to this one on screen: nothing when the answer broke off in the middle of a word or a block of code. */
  joiner: string;
  /** What to tell the person, in a few words. */
  label: string;
}

export interface AssessOptions {
  /** The model used (nearly) all the output it was allowed, whatever it said about why it stopped. */
  hitOutputLimit?: boolean;
  /** Tools have already run for this request: a bare "I will now…" is then the model stopping in the middle of its work. */
  midWork?: boolean;
}

/** An answer this long that ends on an announcement is a delivery that is not finished: it was only the announcement. */
const SHORT_ANSWER = 700;

const ASKS_TO_CONTINUE = [
  /\b(shall|should|can|may|do) i\s+(now\s+)?(continue|go on|proceed|keep going|carry on|send|give|provide|write)\b/i,
  /\b(do you want|would you like|want|do you need|are you ready for)( me)?( to)?\s+(me\s+)?(to\s+)?(continue|go on|proceed|keep going|carry on|send|give|provide|the next (part|section|one))\b/i,
  /\b(say|type|reply|tell me|send|write|answer|respond)\s+(with\s+)?["'“‘«]?(continue|go on|next|more|yes)\b/i,
  /\bto be continued\b/i,
  /\b(in|with) (the )?next (message|part|reply|response|one)\b/i,
  /\bI('| wi)ll (send|give|provide|post|write|share|add) (you )?the (rest|remaining|next|following)\b/i,
  /\b(the )?rest (of it )?(follows|is coming|comes) (in|next)\b/i,
  /(ادامه\s*(را\s*)?(بدهم|دهم|می‌?دهم|خواهم\s*داد|می‌?نویسم|را\s*ارسال|را\s*می‌?فرستم)|بگویید\s*[«"]?ادامه|بنویسید\s*[«"]?ادامه|[«"]ادامه[»"]\s*(بنویسید|بگویید|بفرستید)|در\s*پیام\s*(بعدی|بعد)|پیام\s*بعدی|ادامه\s*مطلب|ادامه\s*در\s*)/,
  /(بخش|قسمت|مرحله)\s*(بعدی|بعد|دوم|سوم|چهارم)\s*(را|رو)?\s*(می‌?(نویسم|فرستم|دهم)|ارسال|ارائه)/,
];

const PART_MARKER = /(\bpart|\bsection|\bchunk|بخش|قسمت)\s*\d+\s*(of|\/|از)\s*\d+\s*[).\]»]?\s*$|[(\[]\s*\d+\s*\/\s*\d+\s*[)\]]\s*$/i;

const ANNOUNCE_EN =
  /\b(let me|let's|let us|i('| wi)ll|i shall|i am going to|i'm going to|going to|now,? i('| wi)ll|next,? i('| wi)ll|first,? i('| wi)ll|then,? i('| wi)ll)\s+(now\s+|first\s+|next\s+|begin\s+by\s+|start\s+by\s+|start\s+with\s+|proceed\s+(to|with)\s+)?(read|write|provide|prepare|create|produce|generate|fetch|go through|go on|compile|output|give|show|present|list|summari[sz]e|translate|extract|rewrite|complete|continue|begin|start|proceed|look|check|search|open|run|call|use|deliver|send|break|split|cover|do|take|work|go)\b/i;

const ANNOUNCE_FA =
  /(ابتدا|اول|سپس|بعد|در\s*ادامه|حالا|اکنون|الان|ادامه)[^.؟!?\n]{0,200}?(می‌?(کنم|دهم|نویسم|پردازم|خوانم|گیرم|آورم|سازم|فرستم|دهیم|کنیم|پردازیم)|خواهم\s*(کرد|داد|نوشت|پرداخت|فرستاد)|آماده\s*می‌?کنم|ارائه\s*می‌?دهم|را\s*می‌?نویسم)\s*[.:؛…]*$/;

/** Words that make "I will…" a step in a sequence rather than a remark. */
const SEQUENCE =
  /\b(first|next|then|now|one by one|step by step|in (several |a few |multiple )?(parts|pieces|chunks|sections|steps|batches)|part \d|section \d|step \d|the (middle|first|second|third|next|remaining|rest|other))\b|(ابتدا|اول|سپس|ادامه|حالا|اکنون|الان|بخش|قسمت|مرحله|تکتک|یکی\s*یکی|میانی|باقی)/i;

const LET_ME_KNOW = /\b(let me know|let us know|feel free|happy to help|hope this helps)\b/i;
const FA_CLOSING = /(اگر\s*(سؤال|سوال|نیاز)|در\s*صورت\s*نیاز|خوشحال\s*می‌?شوم)/;

const DANGLING_END =
  /(?<![\p{L}\p{N}])(and|or|but|the|a|an|of|to|in|for|with|that|which|as|by|at|from|is|are|was|were|be|will|would|can|could|should|than|then|so|if|because|when|while|که|و|یا|با|از|در|به|را|تا|اما|ولی|زیرا|چون|اگر|هر|این|آن|یک)\s*$/iu;

function lastParagraph(text: string): string {
  const paragraphs = text.trimEnd().split(/\n\s*\n/);
  return (paragraphs[paragraphs.length - 1] ?? "").trim();
}

function openFence(text: string): boolean {
  const fences = text.match(/^[ \t]*(```|~~~)/gm);
  return !!fences && fences.length % 2 === 1;
}

/** Whether an answer is the end of the work, or the end of a piece of it. */
export function assessAnswer(text: string, opts: AssessOptions = {}): Unfinished | null {
  const trimmed = text.trimEnd();
  if (trimmed.length < 3) return null;

  if (openFence(trimmed)) return { reason: "open-fence", joiner: "", label: "the answer stopped inside a block of code" };

  const tail = lastParagraph(trimmed).slice(-500);
  const closing = LET_ME_KNOW.test(tail) || FA_CLOSING.test(tail);

  for (const pattern of ASKS_TO_CONTINUE) {
    if (pattern.test(tail)) return { reason: "asks-to-continue", joiner: "\n\n", label: "the model asked whether to go on" };
  }
  if (PART_MARKER.test(trimmed.slice(-120))) return { reason: "part-marker", joiner: "\n\n", label: "the model sent one part of several" };

  if (/[:：]\s*$/.test(trimmed) && !closing) return { reason: "colon", joiner: "\n\n", label: "the answer ends where its content should begin" };

  if (!closing) {
    const finalSentence = lastSentence(tail);
    const announces = ANNOUNCE_EN.test(finalSentence) || ANNOUNCE_FA.test(finalSentence);
    const sequenced = !!opts.midWork || SEQUENCE.test(finalSentence) || /[:：…]\s*$|\.\.\.\s*$/.test(trimmed);
    if (announces && sequenced && (trimmed.length <= SHORT_ANSWER || finalSentence.length >= tail.length * 0.4 || !!opts.midWork)) {
      return { reason: "announced", joiner: "\n\n", label: "the model announced the next step and stopped" };
    }
  }

  if (opts.hitOutputLimit) return { reason: "cut-off", joiner: "", label: "the answer used the whole output limit" };
  if (DANGLING_END.test(trimmed) && !/[.!?؟…。」»)\]}"'`]\s*$/.test(trimmed)) return { reason: "cut-off", joiner: "", label: "the answer stops in the middle of a sentence" };
  return null;
}

function lastSentence(paragraph: string): string {
  const parts = paragraph.split(/(?<=[.!?؟…])\s+|\n/).map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? paragraph;
}

/** What is said to a model to make it go on, for each way it stopped. */
export function continuationPrompt(reason: UnfinishedReason): string {
  switch (reason) {
    case "cut-off":
    case "open-fence":
      return "Continue exactly where you stopped. Do not repeat anything and do not start over.";
    case "asks-to-continue":
    case "part-marker":
      return "Yes, go on. Write the next part now, in full, in this reply. Do not ask whether to continue and do not announce what comes next: just write it. If everything that was asked for is already done, say so in one short sentence and stop.";
    case "colon":
    case "announced":
      return "Do it now, in this reply: carry out what you just said you would do, and give the result in full. Do not announce it again. If everything that was asked for is already done, say so in one short sentence and stop.";
  }
}

/** A continuation that adds almost nothing means the work was finished; it is not worth asking again. */
export function addedLittle(text: string): boolean {
  return text.trim().length < 80;
}

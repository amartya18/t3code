import type { VoiceVocabularyTerm } from "../../../modules/t3-voice-mode";

/** Close enough for "T three" or "P stack", too far for plain "laptop" or "stack". */
const STRICT = 0.85;

/** Only rare names Parakeet misses: each entry pulls recognition toward itself, so common words would be misheard. */
export const VOICE_VOCABULARY: ReadonlyArray<VoiceVocabularyTerm> = [
  { text: "T3", aliases: ["T three", "tee three"], minSimilarity: STRICT },
  { text: "laptop13", aliases: ["laptop thirteen"], minSimilarity: STRICT },
  { text: "pstack", aliases: ["P stack", "pee stack"], minSimilarity: STRICT },
];

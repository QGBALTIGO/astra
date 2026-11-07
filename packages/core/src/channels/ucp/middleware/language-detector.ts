/**
 * UCP Language Detector Middleware
 *
 * Lightweight language detection for inbound messages.
 * Uses a simple trigram-based approach for the most common languages.
 * No external dependencies required.
 */

import type { UCPMiddleware } from './types.js';

/** Detected language result stored in UCPMessage metadata. */
export interface LanguageDetection {
  /** ISO 639-1 language code (e.g., 'en', 'tr', 'de') */
  code: string;
  /** Confidence score 0-1 */
  confidence: number;
}

// Common word patterns per language (simplified trigram approach)
const LANGUAGE_PATTERNS: Record<string, RegExp> = {
  en: /\b(the|and|is|are|was|have|has|for|with|that|this|from|not|but|you|all|can|her|one|our|out)\b/gi,
  tr: /\b(bir|ve|bu|için|ile|olan|gibi|daha|çok|var|ama|ben|sen|biz|siz|değil|olarak|kadar|sonra)\b/gi,
  de: /\b(der|die|und|ist|von|den|das|mit|sich|des|auf|für|nicht|ein|eine|dem|als|auch|noch|nach)\b/gi,
  fr: /\b(les|des|est|une|que|dans|pour|pas|sur|sont|mais|avec|tout|nous|vous|leur|elle|bien)\b/gi,
  es: /\b(los|las|del|una|por|con|para|que|más|fue|son|pero|como|está|todo|esta|hay|muy|sin)\b/gi,
  pt: /\b(dos|das|uma|que|para|com|por|mais|como|foi|mas|tem|são|sua|ser|não|quando|muito)\b/gi,
  it: /\b(che|una|del|per|con|sono|non|più|suo|come|anche|questo|suo|molto|tutti|essere|stato)\b/gi,
  nl: /\b(het|een|van|dat|zijn|met|niet|voor|ook|maar|nog|bij|dit|uit|wel|worden|over|door)\b/gi,
  ru: /\b(что|это|как|так|уже|для|все|или|при|вот|его|она|они|был|мне|вас|них|ему|нас)\b/gi,
  ja: /[\u3040-\u309F\u30A0-\u30FF]/g, // Hiragana + Katakana
  zh: /[\u4E00-\u9FFF]/g, // CJK Unified Ideographs
  ko: /[\uAC00-\uD7AF\u1100-\u11FF]/g, // Hangul
  ar: /[\u0600-\u06FF]/g, // Arabic
};

/**
 * Detect the most likely language of a text string.
 */
export function detectLanguage(text: string): LanguageDetection {
  if (!text || text.length < 5) {
    return { code: 'unknown', confidence: 0 };
  }

  const scores: Record<string, number> = {};
  const wordCount = text.split(/\s+/).length;

  for (const [lang, pattern] of Object.entries(LANGUAGE_PATTERNS)) {
    const matches = text.match(pattern);
    if (matches) {
      scores[lang] = matches.length / Math.max(wordCount, 1);
    }
  }

  // Find the highest-scoring language
  let bestLang = 'unknown';
  let bestScore = 0;

  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  // Normalize confidence to 0-1 range
  const confidence = Math.min(bestScore, 1);

  // Require minimum confidence threshold
  if (confidence < 0.05) {
    return { code: 'unknown', confidence: 0 };
  }

  return { code: bestLang, confidence };
}

/**
 * Create a language detection middleware.
 *
 * Detects the language of inbound text messages and stores
 * the result in `msg.metadata.detectedLanguage`.
 */
export function languageDetector(): UCPMiddleware {
  return async (msg, next) => {
    if (msg.direction === 'inbound') {
      // Extract text content for detection
      const textContent = msg.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join(' ');

      if (textContent) {
        const detection = detectLanguage(textContent);
        if (detection.code !== 'unknown') {
          msg = {
            ...msg,
            metadata: {
              ...msg.metadata,
              detectedLanguage: detection,
            },
          };
        }
      }
    }

    return next();
  };
}

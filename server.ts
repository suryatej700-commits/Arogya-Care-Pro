import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const ALLOWED_CROPS = new Set(['Tomato', 'Chili', 'Potato', 'Rice', 'Cotton', 'Maize']);
const ALLOWED_LANGUAGES = new Set(['en', 'te', 'hi']);

const SUPPORTED_DISEASES_BY_CROP: Record<string, string[]> = {
  Tomato: ['Early Blight', 'Late Blight', 'Leaf Mold'],
  Chili: ['Leaf Curl', 'Powdery Mildew', 'Anthracnose'],
  Potato: ['Early Blight', 'Late Blight', 'Leaf Roll'],
  Rice: ['Rice Blast', 'Bacterial Leaf Blight', 'Brown Spot'],
  Cotton: ['Cotton Leaf Curl', 'Bacterial Blight', 'Alternaria Leaf Spot'],
  Maize: ['Northern Corn Leaf Blight', 'Common Rust', 'Gray Leaf Spot'],
};

const ALL_DISEASE_TERMS = Array.from(
  new Set(Object.values(SUPPORTED_DISEASES_BY_CROP).flat())
).map((d) => d.toLowerCase());

const OTHER_CROP_NAMES_BY_CROP: Record<string, string[]> = {
  Tomato: ['chili', 'chilli', 'potato', 'rice', 'paddy', 'cotton', 'maize', 'corn'],
  Chili: ['tomato', 'potato', 'rice', 'paddy', 'cotton', 'maize', 'corn'],
  Potato: ['tomato', 'chili', 'chilli', 'rice', 'paddy', 'cotton', 'maize', 'corn'],
  Rice: ['tomato', 'chili', 'chilli', 'potato', 'cotton', 'maize', 'corn'],
  Cotton: ['tomato', 'chili', 'chilli', 'potato', 'rice', 'paddy', 'maize', 'corn'],
  Maize: ['tomato', 'chili', 'chilli', 'potato', 'rice', 'paddy', 'cotton'],
};

function containsWholeTerm(text: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  return new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`, 'i').test(text);
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  te: 'Telugu',
  hi: 'Hindi',
};

function buildAnalysisResponseSchema(allowedDiseases: string[]) {
  return {
    type: Type.OBJECT,
    properties: {
      matchesSelectedCrop: {
        type: Type.BOOLEAN,
        description:
          'Set to false ONLY when the uploaded photo clearly shows a different crop species than the selected crop (or a clearly unrelated non-plant object). Set to true when the leaf matches the selected crop.',
      },
      suggestedCrop: {
        type: Type.STRING,
        enum: ['Tomato', 'Chili', 'Potato', 'Rice', 'Cotton', 'Maize', 'Unsupported'],
        description:
          'If matchesSelectedCrop is false, identify which of the 6 supported crops the leaf appears to be, or "Unsupported". If matchesSelectedCrop is true, return the selected crop.',
      },
      possibleDisease: {
        type: Type.STRING,
        enum: [...allowedDiseases, 'Unable to assess reliably'],
        description:
          'Must be one of the exact canonical supported diseases for the selected crop or "Unable to assess reliably".',
      },
      confidence: {
        type: Type.INTEGER,
        description: 'Estimated visual confidence score between 0 and 100.',
      },
      severity: {
        type: Type.STRING,
        enum: ['Low', 'Medium', 'High'],
        description: 'Risk severity level: exactly "Low", "Medium", or "High".',
      },
      imageQuality: {
        type: Type.STRING,
        description:
          'Brief assessment of photo clarity, lighting, and leaf visibility in the requested farmer language.',
      },
      symptomsObserved: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description:
          'List of 2 to 4 visible leaf symptoms observed in the photo, written in the requested farmer language.',
      },
      likelyCause: {
        type: Type.STRING,
        description:
          'Plain-language explanation of the likely biological or environmental factor, written in the requested farmer language.',
      },
      immediateActions: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description:
          'List of 3 to 4 safe, low-risk cultural/sanitation actions (NO pesticide brand names, NO chemical dosages), written in the requested farmer language.',
      },
      preventionSteps: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description:
          'List of 3 practical prevention steps for future crops, written in the requested farmer language.',
      },
      expertHelpAdvice: {
        type: Type.STRING,
        description:
          'Clear guidance on when to consult a local agriculture officer or qualified expert, written in the requested farmer language.',
      },
      disclaimer: {
        type: Type.STRING,
        description:
          'Informational screening disclaimer stating this is not a confirmed diagnosis and serious crop issues should be verified with a qualified agriculture expert, in the requested farmer language.',
      },
    },
    required: [
      'matchesSelectedCrop',
      'suggestedCrop',
      'possibleDisease',
      'confidence',
      'severity',
      'imageQuality',
      'symptomsObserved',
      'likelyCause',
      'immediateActions',
      'preventionSteps',
      'expertHelpAdvice',
      'disclaimer',
    ],
  };
}

const CROP_DETECTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    suggestedCrop: {
      type: Type.STRING,
      enum: ['Tomato', 'Chili', 'Potato', 'Rice', 'Cotton', 'Maize', 'Unsupported'],
      description:
        'Must be one of the 6 supported crops (Tomato, Chili, Potato, Rice, Cotton, Maize) or "Unsupported" if the leaf belongs to another plant or cannot be identified as one of these 6 crops.',
    },
    reason: {
      type: Type.STRING,
      description:
        'Short 1-sentence visual note explaining why this crop leaf was suggested (e.g., leaf shape or venation), written in the requested farmer language. NEVER mention any disease diagnosis.',
    },
  },
  required: ['suggestedCrop', 'reason'],
};

function normalizeDiseaseName(raw: string, allowedDiseases: string[]): string {
  const cleaned = raw.trim();
  if (!cleaned) return '';
  if (cleaned.toLowerCase() === 'unable to assess reliably') {
    return 'Unable to assess reliably';
  }
  const exact = allowedDiseases.find((d) => d.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;
  const contained = allowedDiseases.find((d) => cleaned.toLowerCase().includes(d.toLowerCase()));
  return contained ?? cleaned;
}

function normalizeSeverity(raw: string): 'Low' | 'Medium' | 'High' {
  const lower = raw.trim().toLowerCase();
  if (lower === 'high') return 'High';
  if (lower === 'medium') return 'Medium';
  if (lower === 'low') return 'Low';
  return 'Medium';
}

const TRANSLATION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    imageQuality: { type: Type.STRING },
    symptomsObserved: { type: Type.ARRAY, items: { type: Type.STRING } },
    likelyCause: { type: Type.STRING },
    immediateActions: { type: Type.ARRAY, items: { type: Type.STRING } },
    preventionSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
    expertHelpAdvice: { type: Type.STRING },
    disclaimer: { type: Type.STRING },
  },
  required: [
    'imageQuality',
    'symptomsObserved',
    'likelyCause',
    'immediateActions',
    'preventionSteps',
    'expertHelpAdvice',
    'disclaimer',
  ],
};

function hasCrossCropContradiction(crop: string, disease: string, texts: string[], diagnosisTexts: string[]): boolean {
  const allowedDiseases = SUPPORTED_DISEASES_BY_CROP[crop] ?? [];
  const allowedLower = new Set(allowedDiseases.map((d) => d.toLowerCase()));
  const currentDiseaseLower = disease.toLowerCase();
  const maskCurrent = (text: string) => text.split(currentDiseaseLower).join(' ');

  const joinedAllMasked = maskCurrent(texts.join(' ').toLowerCase());
  const joinedDiagnosisMasked = maskCurrent(diagnosisTexts.join(' ').toLowerCase());

  const forbiddenDiseases = ALL_DISEASE_TERMS.filter((term) => !allowedLower.has(term));
  for (const term of forbiddenDiseases) {
    if (containsWholeTerm(joinedAllMasked, term)) {
      return true;
    }
  }

  const forbiddenCropTerms = OTHER_CROP_NAMES_BY_CROP[crop] ?? [];
  for (const cropTerm of forbiddenCropTerms) {
    if (containsWholeTerm(joinedDiagnosisMasked, cropTerm)) {
      return true;
    }
  }

  const otherDiseases = allowedDiseases.filter((d) => d !== disease);
  for (const other of otherDiseases) {
    if (containsWholeTerm(joinedDiagnosisMasked, other.toLowerCase())) {
      return true;
    }
  }
  return false;
}

async function callGeminiWithRetry(ai: GoogleGenAI, payload: Parameters<typeof ai.models.generateContent>[0]) {
  const modelsToTry = [payload.model, ...(payload.model === 'gemini-4-hydrogen' ? ['gemini-3.1-flash-lite'] : [])];
  let lastError: unknown;

  for (const modelName of modelsToTry) {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await ai.models.generateContent({
          ...payload,
          model: modelName,
        });
      } catch (err: unknown) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isPerDayQuota = msg.includes('PerDay') || msg.includes('GenerateRequestsPerDay');
        const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const isUnavailable = msg.includes('503') || msg.includes('UNAVAILABLE');

        if (isRateLimit) {
          if (isPerDayQuota || attempt === maxAttempts) {
            break; // try next fallback model if any
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }

        if (isUnavailable && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 900));
          continue;
        }

        throw err;
      }
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '16mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0),
    });
  });

  app.post('/api/detect-crop', async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        res.status(503).json({
          error: 'GEMINI_API_KEY_MISSING',
          message: 'Gemini Vision crop suggestion is currently unavailable because no API key is configured on the server.',
        });
        return;
      }

      const body = req.body ?? {};
      const mimeTypeRaw = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase() : '';
      const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
      const language = typeof body.language === 'string' && ALLOWED_LANGUAGES.has(body.language) ? body.language : 'en';

      if (!ALLOWED_MIME_TYPES.has(mimeTypeRaw)) {
        res.status(400).json({ error: 'INVALID_FILE_TYPE', message: 'Only JPG, JPEG, and PNG images are supported.' });
        return;
      }

      if (!imageBase64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(imageBase64)) {
        res.status(400).json({ error: 'INVALID_IMAGE_DATA', message: 'Invalid image payload.' });
        return;
      }

      const cleanBase64 = imageBase64.replace(/\s+/g, '');
      const decodedBytes = Buffer.byteLength(cleanBase64, 'base64');
      if (decodedBytes <= 0 || decodedBytes > MAX_IMAGE_BYTES) {
        res.status(400).json({ error: 'IMAGE_TOO_LARGE', message: 'Image must be 10 MB or smaller.' });
        return;
      }

      const normalizedMimeType = mimeTypeRaw === 'image/jpg' ? 'image/jpeg' : mimeTypeRaw;
      const targetLanguageName = LANGUAGE_NAMES[language] || 'English';

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemInstruction = [
        'You are an agricultural crop-identification helper for Arogya Care Pro (Beta auto-detect feature).',
        'Your ONLY task is to look at the uploaded leaf photograph and suggest which of the 6 supported crops it most likely belongs to:',
        'Tomato, Chili, Potato, Rice, Cotton, Maize.',
        'STRICT RULES:',
        '1. If the photo clearly shows another plant/crop not in those 6, or is not a crop leaf, set "suggestedCrop" to "Unsupported".',
        '2. Do NOT diagnose or mention any plant disease in your response.',
        `3. Write "reason" briefly (one clear sentence) in ${targetLanguageName}. Keep "suggestedCrop" as the exact English enum value.`,
      ].join('\n');

      const response = await callGeminiWithRetry(ai, {
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: normalizedMimeType,
                data: cleanBase64,
              },
            },
            {
              text: `Identify only whether this leaf belongs to Tomato, Chili, Potato, Rice, Cotton, Maize, or Unsupported. Write reason in ${targetLanguageName}.`,
            },
          ],
        },
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: CROP_DETECTION_SCHEMA,
        },
      });

      const rawText = response.text?.trim();
      if (!rawText) {
        res.status(502).json({
          error: 'EMPTY_AI_RESPONSE',
          message: 'Could not suggest a crop from this photo. Please select your crop manually.',
        });
        return;
      }

      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      const rawCrop = typeof parsed.suggestedCrop === 'string' ? parsed.suggestedCrop.trim() : 'Unsupported';
      const suggestedCrop = ALLOWED_CROPS.has(rawCrop) ? rawCrop : 'Unsupported';
      const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';

      res.json({
        suggestedCrop,
        reason,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unexpected server error during crop detection.';
      if (process.env.NODE_ENV !== 'production') {
        console.error('[POST /api/detect-crop] Error:', err);
      } else {
        console.error('[POST /api/detect-crop] Error:', message);
      }
      const status =
        message.includes('RESOURCE_EXHAUSTED') || message.includes('429')
          ? 429
          : message.includes('API_KEY_INVALID') || message.includes('PERMISSION_DENIED') || message.includes('403')
          ? 403
          : 500;
      res.status(status).json({
        error: 'CROP_DETECTION_FAILED',
        message: 'Could not suggest a crop from this photo right now. Please select your crop manually.',
        ...(process.env.NODE_ENV !== 'production' ? { details: message } : {}),
      });
    }
  });

  app.post('/api/analyze', async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        res.status(503).json({
          error: 'GEMINI_API_KEY_MISSING',
          message: 'Gemini Vision analysis is currently unavailable because no API key is configured on the server.',
        });
        return;
      }

      const body = req.body ?? {};
      const crop = typeof body.crop === 'string' ? body.crop : '';
      const mimeTypeRaw = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase() : '';
      const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
      const leafAge = typeof body.leafAge === 'string' ? body.leafAge.slice(0, 40) : 'unknown';
      const visibleSymptom = typeof body.visibleSymptom === 'string' ? body.visibleSymptom.slice(0, 60) : 'unknown';
      const notes = typeof body.notes === 'string' ? body.notes.slice(0, 500) : '';
      const language = typeof body.language === 'string' && ALLOWED_LANGUAGES.has(body.language) ? body.language : 'en';

      if (!ALLOWED_CROPS.has(crop)) {
        res.status(400).json({
          error: 'INVALID_CROP',
          message: 'Crop must be one of: Tomato, Chili, Potato, Rice, Cotton, or Maize.',
        });
        return;
      }

      if (!ALLOWED_MIME_TYPES.has(mimeTypeRaw)) {
        res.status(400).json({ error: 'INVALID_FILE_TYPE', message: 'Only JPG, JPEG, and PNG images are supported.' });
        return;
      }

      if (!imageBase64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(imageBase64)) {
        res.status(400).json({ error: 'INVALID_IMAGE_DATA', message: 'Invalid image payload.' });
        return;
      }

      const cleanBase64 = imageBase64.replace(/\s+/g, '');
      const decodedBytes = Buffer.byteLength(cleanBase64, 'base64');
      if (decodedBytes <= 0 || decodedBytes > MAX_IMAGE_BYTES) {
        res.status(400).json({ error: 'IMAGE_TOO_LARGE', message: 'Image must be 10 MB or smaller.' });
        return;
      }

      const normalizedMimeType = mimeTypeRaw === 'image/jpg' ? 'image/jpeg' : mimeTypeRaw;
      const allowedDiseases = SUPPORTED_DISEASES_BY_CROP[crop];
      const targetLanguageName = LANGUAGE_NAMES[language] || 'English';

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemInstruction = [
        'You are an agricultural crop-leaf screening assistant for Arogya Care Pro.',
        'Your job is to inspect a farmer-uploaded leaf photograph and provide a cautious, informational "Possible disease prediction".',
        'STRICT RULES:',
        `1. The farmer selected crop: "${crop}". This selected crop is your PRIMARY constraint.`,
        `2. First verify whether the leaf in the image visibly matches "${crop}". If the photo clearly shows a DIFFERENT crop species (for example, Tomato leaves when Chili is selected, Rice blades when Maize is selected, or an unrelated plant), DO NOT force a diagnosis: set "matchesSelectedCrop" to false, set "suggestedCrop" to the likely crop from ["Tomato", "Chili", "Potato", "Rice", "Cotton", "Maize", "Unsupported"], set "possibleDisease" to "Unable to assess reliably", set "confidence" to 0, and set "severity" to "Low".`,
        `3. When the image matches "${crop}", you may ONLY set "possibleDisease" to one of: ${allowedDiseases.map((d) => `"${d}"`).join(', ')}, OR "Unable to assess reliably".`,
        '4. If the image is blurry, too dark, shows unrelated objects, is a healthy or ambiguous leaf with no clear disease sign, or has low confidence (< 40), set "possibleDisease" to "Unable to assess reliably", set "confidence" below 40, and set "severity" to "Low".',
        '5. ALL guidance fields (symptomsObserved, likelyCause, immediateActions, preventionSteps, expertHelpAdvice) MUST strictly refer ONLY to the chosen "possibleDisease" and the selected crop ("' + crop + '"). NEVER mention diseases of another crop or contradictory crop names.',
        '6. NEVER claim a confirmed diagnosis. Always use cautious language like "possible signs" or "may indicate".',
        '7. NEVER mention pesticide brand names, commercial chemical names, exact chemical dosages, or mixing/spraying recipes. Focus strictly on safe, low-risk cultural, sanitation, airflow, watering, and local-expert consultation guidance.',
        '8. "severity" MUST be exactly one of: "Low", "Medium", or "High".',
        `9. Write all descriptive text fields ("imageQuality", "symptomsObserved", "likelyCause", "immediateActions", "preventionSteps", "expertHelpAdvice", "disclaimer") completely in ${targetLanguageName}. Keep ONLY "suggestedCrop", "possibleDisease", and "severity" in the exact canonical English enum values specified above. Do NOT mix English words inside Telugu or Hindi prose.`,
        '10. Keep explanations practical, warm, respectful, and concise for farmers.',
      ].join('\n');

      const promptText = [
        `Crop selected by farmer: ${crop}`,
        `Reported leaf age: ${leafAge}`,
        `Reported visible symptom: ${visibleSymptom}`,
        notes ? `Farmer notes: ${notes}` : 'Farmer notes: None provided',
        `Target output language for all guidance text: ${targetLanguageName}`,
        'First verify if the photo matches the selected crop; then analyze the leaf photo carefully and return structured JSON matching the schema.',
      ].join('\n');

      const response = await callGeminiWithRetry(ai, {
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: normalizedMimeType,
                data: cleanBase64,
              },
            },
            { text: promptText },
          ],
        },
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: buildAnalysisResponseSchema(allowedDiseases),
        },
      });

      const rawText = response.text?.trim();
      if (!rawText) {
        res.status(502).json({
          error: 'EMPTY_AI_RESPONSE',
          message: 'The screening service returned an empty response. Please try again.',
        });
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawText);
      } catch (parseErr) {
        if (process.env.NODE_ENV !== 'production') {
          console.error('[POST /api/analyze] Invalid JSON from Gemini:', parseErr, rawText.slice(0, 300));
        }
        res.status(502).json({
          error: 'INVALID_AI_JSON',
          message: 'The screening service returned an unreadable format. Please retry.',
        });
        return;
      }

      const matchesSelectedCrop = parsed.matchesSelectedCrop !== false;
      const rawSuggestedCrop = typeof parsed.suggestedCrop === 'string' ? parsed.suggestedCrop.trim() : '';
      const detectedCropSuggestion =
        ALLOWED_CROPS.has(rawSuggestedCrop) && rawSuggestedCrop !== crop ? rawSuggestedCrop : null;

      if (!matchesSelectedCrop) {
        res.json({
          cropMatchStatus: 'mismatch',
          detectedCropSuggestion,
          possibleDisease: 'Unable to assess reliably',
          confidence: 0,
          severity: 'Low',
          imageQuality: typeof parsed.imageQuality === 'string' ? parsed.imageQuality : '',
          symptomsObserved: [],
          likelyCause: '',
          immediateActions: [],
          preventionSteps: [],
          expertHelpAdvice: '',
          disclaimer:
            typeof parsed.disclaimer === 'string' && parsed.disclaimer.trim().length > 0
              ? parsed.disclaimer
              : 'This screening is informational. Verify serious crop issues with a qualified agriculture expert.',
        });
        return;
      }

      const rawDiseaseInput = typeof parsed.possibleDisease === 'string' ? parsed.possibleDisease : '';
      const rawDisease = normalizeDiseaseName(rawDiseaseInput, allowedDiseases);
      const rawConfidence = typeof parsed.confidence === 'number' ? Math.round(parsed.confidence) : 30;
      const clampedConfidence = Math.max(0, Math.min(100, rawConfidence));

      const isSupportedForCrop = allowedDiseases.includes(rawDisease);
      const isLowConfidenceOrUnable =
        !isSupportedForCrop || rawDisease === 'Unable to assess reliably' || clampedConfidence < 40;

      if (isLowConfidenceOrUnable) {
        res.json({
          cropMatchStatus: 'matched',
          detectedCropSuggestion: null,
          possibleDisease: 'Unable to assess reliably',
          confidence: Math.min(clampedConfidence, 39),
          severity: 'Low',
          imageQuality: typeof parsed.imageQuality === 'string' ? parsed.imageQuality : '',
          symptomsObserved: [],
          likelyCause: '',
          immediateActions: [],
          preventionSteps: [],
          expertHelpAdvice: '',
          disclaimer:
            typeof parsed.disclaimer === 'string' && parsed.disclaimer.trim().length > 0
              ? parsed.disclaimer
              : 'This screening is informational. Verify serious crop issues with a qualified agriculture expert.',
        });
        return;
      }

      const symptomsObserved = Array.isArray(parsed.symptomsObserved)
        ? parsed.symptomsObserved.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 6)
        : [];
      const likelyCause = typeof parsed.likelyCause === 'string' ? parsed.likelyCause.trim() : '';
      const immediateActions = Array.isArray(parsed.immediateActions)
        ? parsed.immediateActions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 6)
        : [];
      const preventionSteps = Array.isArray(parsed.preventionSteps)
        ? parsed.preventionSteps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 6)
        : [];
      const expertHelpAdvice = typeof parsed.expertHelpAdvice === 'string' ? parsed.expertHelpAdvice.trim() : '';

      const allGuidanceTexts = [
        ...symptomsObserved,
        likelyCause,
        ...immediateActions,
        ...preventionSteps,
        expertHelpAdvice,
      ];

      if (hasCrossCropContradiction(crop, rawDisease, allGuidanceTexts, [...symptomsObserved, likelyCause])) {
        if (process.env.NODE_ENV !== 'production') {
          console.error('[POST /api/analyze] Inconsistent AI result rejected:', {
            crop,
            language,
            rawDisease,
          });
        }
        res.status(502).json({
          error: 'INCONSISTENT_AI_RESULT',
          message: 'The screening output had inconsistent crop details. Please try analyzing the photo again.',
        });
        return;
      }

      const rawSeverity = typeof parsed.severity === 'string' ? parsed.severity : 'Low';
      const validSeverity = normalizeSeverity(rawSeverity);

      res.json({
        cropMatchStatus: 'matched',
        detectedCropSuggestion: null,
        possibleDisease: rawDisease,
        confidence: clampedConfidence,
        severity: validSeverity,
        imageQuality: typeof parsed.imageQuality === 'string' ? parsed.imageQuality : '',
        symptomsObserved,
        likelyCause,
        immediateActions,
        preventionSteps,
        expertHelpAdvice,
        disclaimer:
          typeof parsed.disclaimer === 'string' && parsed.disclaimer.trim().length > 0
            ? parsed.disclaimer
            : 'This screening is informational. Verify serious crop issues with a qualified agriculture expert.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unexpected server error during image analysis.';
      if (process.env.NODE_ENV !== 'production') {
        console.error('[POST /api/analyze] Gemini analysis error:', err);
      } else {
        console.error('[POST /api/analyze] Gemini analysis error:', message);
      }

      if (message.includes('API_KEY_INVALID') || message.includes('PERMISSION_DENIED') || message.includes('403')) {
        res.status(403).json({
          error: 'GEMINI_AUTH_ERROR',
          message: 'Gemini API authentication failed. Please verify the configured server API key.',
          ...(process.env.NODE_ENV !== 'production' ? { details: message } : {}),
        });
        return;
      }

      if (message.includes('RESOURCE_EXHAUSTED') || message.includes('429')) {
        res.status(429).json({
          error: 'GEMINI_RATE_LIMIT',
          message: 'The screening service is temporarily busy. Please wait a moment and try again.',
          ...(process.env.NODE_ENV !== 'production' ? { details: message } : {}),
        });
        return;
      }

      res.status(500).json({
        error: 'ANALYSIS_FAILED',
        message: 'Could not complete leaf screening right now. Please check your connection and try again.',
        ...(process.env.NODE_ENV !== 'production' ? { details: message } : {}),
      });
    }
  });

  app.post('/api/translate', async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        res.status(503).json({
          error: 'GEMINI_API_KEY_MISSING',
          message: 'Translation unavailable',
        });
        return;
      }

      const body = req.body ?? {};
      const targetLanguage = typeof body.targetLanguage === 'string' && ALLOWED_LANGUAGES.has(body.targetLanguage)
        ? body.targetLanguage
        : '';
      const crop = typeof body.crop === 'string' && ALLOWED_CROPS.has(body.crop) ? body.crop : '';
      const possibleDisease = typeof body.possibleDisease === 'string' ? body.possibleDisease.slice(0, 80) : '';
      const guidance = body.guidance as Record<string, unknown> | undefined;

      if (!targetLanguage || !crop || !guidance || typeof guidance !== 'object') {
        res.status(400).json({
          error: 'INVALID_TRANSLATION_REQUEST',
          message: 'Translation unavailable',
        });
        return;
      }

      const sanitizeStringArray = (val: unknown): string[] =>
        Array.isArray(val)
          ? val.filter((item): item is string => typeof item === 'string').map((s) => s.slice(0, 400)).slice(0, 8)
          : [];

      const payloadToTranslate = {
        imageQuality: typeof guidance.imageQuality === 'string' ? guidance.imageQuality.slice(0, 400) : '',
        symptomsObserved: sanitizeStringArray(guidance.symptomsObserved),
        likelyCause: typeof guidance.likelyCause === 'string' ? guidance.likelyCause.slice(0, 600) : '',
        immediateActions: sanitizeStringArray(guidance.immediateActions),
        preventionSteps: sanitizeStringArray(guidance.preventionSteps),
        expertHelpAdvice: typeof guidance.expertHelpAdvice === 'string' ? guidance.expertHelpAdvice.slice(0, 600) : '',
        disclaimer: typeof guidance.disclaimer === 'string' ? guidance.disclaimer.slice(0, 400) : '',
      };

      const targetLanguageName = LANGUAGE_NAMES[targetLanguage];
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const response = await callGeminiWithRetry(ai, {
        model: 'gemini-4-hydrogen',
        contents: [
          `Translate the following agricultural screening guidance for ${crop} (${possibleDisease}) completely into natural, clear ${targetLanguageName} for farmers.`,
          'Preserve the exact meaning, array lengths, and cautious screening tone. Do NOT add pesticide brand names or chemical dosages. Do NOT leave untranslated English sentences when translating into Telugu or Hindi.',
          JSON.stringify(payloadToTranslate),
        ].join('\n\n'),
        config: {
          responseMimeType: 'application/json',
          responseSchema: TRANSLATION_RESPONSE_SCHEMA,
        },
      });

      const rawText = response.text?.trim();
      if (!rawText) {
        res.status(502).json({ error: 'TRANSLATION_EMPTY', message: 'Translation unavailable' });
        return;
      }

      const translated = JSON.parse(rawText) as Record<string, unknown>;
      res.json({
        imageQuality: typeof translated.imageQuality === 'string' ? translated.imageQuality : payloadToTranslate.imageQuality,
        symptomsObserved: sanitizeStringArray(translated.symptomsObserved),
        likelyCause: typeof translated.likelyCause === 'string' ? translated.likelyCause : payloadToTranslate.likelyCause,
        immediateActions: sanitizeStringArray(translated.immediateActions),
        preventionSteps: sanitizeStringArray(translated.preventionSteps),
        expertHelpAdvice: typeof translated.expertHelpAdvice === 'string' ? translated.expertHelpAdvice : payloadToTranslate.expertHelpAdvice,
        disclaimer: typeof translated.disclaimer === 'string' ? translated.disclaimer : payloadToTranslate.disclaimer,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (process.env.NODE_ENV !== 'production') {
        console.error('[POST /api/translate] Translation error:', err);
      } else {
        console.error('[POST /api/translate] Translation error:', message);
      }
      const status =
        message.includes('RESOURCE_EXHAUSTED') || message.includes('429')
          ? 429
          : message.includes('API_KEY_INVALID') || message.includes('PERMISSION_DENIED') || message.includes('403')
          ? 403
          : 500;
      res.status(status).json({ error: 'TRANSLATION_FAILED', message: 'Translation unavailable' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Arogya Care Pro server listening on http://localhost:${PORT}`);
  });
}

startServer();

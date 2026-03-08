/**
 * Auto-detect the correct Gemini model + API version for BidiGenerateContent.
 */

interface DetectedModel {
  version: string;
  modelId: string;
}

export async function detectLiveModel(apiKey: string): Promise<DetectedModel | null> {
  for (const version of ['v1beta', 'v1alpha'] as const) {
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/${version}/models?key=${apiKey}&pageSize=100`,
      );
    } catch {
      continue;
    }

    if (!res.ok) continue;

    const json = (await res.json()) as {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
    };

    const liveModels = (json.models ?? []).filter(
      (m) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('bidiGenerateContent'),
    );

    if (liveModels.length > 0) {
      // Prefer models with 'live' in the name, avoid image-generation models
      const preferred =
        liveModels.find((m) => m.name.includes('live')) ??
        liveModels.find((m) => !m.name.includes('image')) ??
        liveModels[0]!;

      return { version, modelId: preferred.name.replace('models/', '') };
    }
  }

  return null;
}

export function buildGeminiWsUrl(apiKey: string, apiVersion: string): string {
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContent?key=${apiKey}`;
}

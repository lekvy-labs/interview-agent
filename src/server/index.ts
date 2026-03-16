export { InterviewServer } from './interview-server.js';
export { GeminiSession } from './gemini-session.js';
export type { GeminiSessionConfig } from './gemini-session.js';

// Re-export @google/genai utilities so consumers don't need a direct dependency
// for common configuration (tool declarations, modalities, etc.)
export {
  Modality,
  Type,
  StartSensitivity,
  EndSensitivity,
} from '@google/genai';
export type { FunctionDeclaration } from '@google/genai';

// Re-export default tools for consumers who want to extend rather than replace
export { DEFAULT_TOOLS } from '../shared/types.js';

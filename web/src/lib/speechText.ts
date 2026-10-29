/**
 * Text normalisation for spoken output. Pure and dependency-free so it can be
 * unit-tested in Node and reused by both the desktop TTS queue and the mobile
 * voice pipeline.
 */
export function cleanSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[*_`#>~]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .trim();
}

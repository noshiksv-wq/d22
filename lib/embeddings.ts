import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

/**
 * Generate embedding for text using OpenAI text-embedding-3-small (1536 dimensions)
 * Matches the existing database schema vector(1536)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error("Text cannot be empty");
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text.trim(),
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length !== 1536) {
      throw new Error(`Invalid embedding: expected 1536 dimensions, got ${embedding?.length || 0}`);
    }

    return embedding;
  } catch (error) {
    console.error("[generateEmbedding] Error generating embedding:", error);
    if (error instanceof Error) {
      throw new Error(`Failed to generate embedding: ${error.message}`);
    }
    throw new Error("Failed to generate embedding: Unknown error");
  }
}

/**
 * Generate embedding with retry logic
 */
export async function generateEmbeddingWithRetry(
  text: string,
  maxRetries: number = 3
): Promise<number[]> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await generateEmbedding(text);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`[generateEmbeddingWithRetry] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      
      if (attempt < maxRetries) {
        // Exponential backoff: wait 1s, 2s, 4s
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError || new Error("Failed to generate embedding after retries");
}


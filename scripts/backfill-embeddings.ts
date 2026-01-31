/**
 * Backfill embeddings for existing dishes
 * 
 * Usage:
 *   npm run backfill-embeddings
 *   or
 *   npx tsx scripts/backfill-embeddings.ts
 * 
 * This script:
 * 1. Fetches dishes without embeddings (in batches of 100)
 * 2. Generates embeddings via OpenAI API
 * 3. Updates database in batches
 * 4. Logs progress and errors
 */

import { createClient } from "@supabase/supabase-js";
import { generateEmbeddingWithRetry } from "../lib/embeddings";

const BATCH_SIZE = 100;
const DELAY_BETWEEN_BATCHES_MS = 1000; // 1 second delay to avoid rate limits

async function backfillEmbeddings() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Error: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY must be set");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  console.log("Starting embedding backfill...");
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log("");

  let totalProcessed = 0;
  let totalErrors = 0;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    // Fetch dishes without embeddings
    const { data: dishes, error: fetchError } = await supabase
      .from("dishes")
      .select("id, name, description")
      .is("embedding", null)
      .eq("public", true)
      .range(offset, offset + BATCH_SIZE - 1);

    if (fetchError) {
      console.error(`Error fetching dishes:`, fetchError);
      break;
    }

    if (!dishes || dishes.length === 0) {
      hasMore = false;
      break;
    }

    console.log(`Processing batch: ${dishes.length} dishes (offset: ${offset})`);

    // Generate embeddings for this batch
    const updates: Array<{ id: string; embedding: number[] }> = [];

    for (const dish of dishes) {
      try {
        // Combine name and description for embedding
        const textToEmbed = [dish.name, dish.description]
          .filter(Boolean)
          .join(" ");

        if (!textToEmbed.trim()) {
          console.warn(`Skipping dish ${dish.id}: no name or description`);
          continue;
        }

        const embedding = await generateEmbeddingWithRetry(textToEmbed);
        updates.push({ id: dish.id, embedding });
        totalProcessed++;

        // Log progress every 10 dishes
        if (totalProcessed % 10 === 0) {
          console.log(`  Processed ${totalProcessed} dishes...`);
        }
      } catch (error) {
        totalErrors++;
        console.error(`Error generating embedding for dish ${dish.id}:`, error);
      }
    }

    // Update database in batch
    if (updates.length > 0) {
      for (const update of updates) {
        const { error: updateError } = await supabase
          .from("dishes")
          .update({ embedding: update.embedding })
          .eq("id", update.id);

        if (updateError) {
          console.error(`Error updating dish ${update.id}:`, updateError);
          totalErrors++;
        }
      }
    }

    console.log(`Batch complete: ${updates.length} embeddings generated, ${totalErrors} total errors`);
    console.log("");

    offset += BATCH_SIZE;

    // Delay between batches to avoid rate limits
    if (hasMore && offset < 10000) {
      // Only delay if we're not done
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  console.log("=".repeat(50));
  console.log("Backfill complete!");
  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Total errors: ${totalErrors}`);
  console.log("=".repeat(50));
}

// Run the backfill
backfillEmbeddings().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});


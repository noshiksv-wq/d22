
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

// Load .env.local manually
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, "utf8");
  envConfig.split("\n").forEach((line) => {
    // Basic parsing, might be fragile but good enough for simple .env
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, '');
        process.env[key] = value;
    }
  });
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function check() {
  console.log("Searching for 'Sandhu' in restaurants...");
  const { data: restaurants, error } = await supabase
    .from("restaurants")
    .select("*")
    .ilike("name", "%sandhu%");

  if (error) {
    console.error("Error searching restaurants:", error);
    return;
  }

  if (!restaurants || restaurants.length === 0) {
    console.log("No restaurant found matching 'Sandhu'.");
    return;
  }

  console.log(`Found ${restaurants.length} restaurants:`);
  for (const r of restaurants) {
    console.log(`- [${r.id}] ${r.name} (City: ${r.city})`);
    
    // Check dishes
    const { data: dishes, error: dishError } = await supabase
        .from("dishes")
        .select("id, name, embedding")
        .eq("restaurant_id", r.id);
        
    if (dishError) {
        console.error("Error fetching dishes:", dishError);
    } else {
        console.log(`  Dishes: ${dishes?.length || 0}`);
        const dishesWithEmbeddings = dishes?.filter(d => d.embedding).length;
        console.log(`  Dishes with embeddings: ${dishesWithEmbeddings}`);
        
        if (dishes && dishes.length > 0) {
            console.log("  Sample dishes:");
            dishes.slice(0, 5).forEach(d => {
                 console.log(`    - ${d.name} [Has Embedding: ${!!d.embedding}]`);
            });
        }
    }
  }
}

check();

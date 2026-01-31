
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

// Load .env.local manually
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, "utf8");
    envConfig.split("\n").forEach((line) => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
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

        // Check menus
        const { data: menus, error: menuError } = await supabase
            .from("menus")
            .select("id, name, restaurant_id")
            .eq("restaurant_id", r.id);

        if (menuError) {
            console.error("  Error fetching menus:", menuError);
            continue;
        }

        console.log(`  Found ${menus?.length || 0} menus.`);

        if (!menus || menus.length === 0) continue;

        const menuIds = menus.map(m => m.id);

        // Check dishes
        const { data: dishes, error: dishError } = await supabase
            .from("dishes")
            .select("id, name, embedding, menu_id")
            .in("menu_id", menuIds);

        if (dishError) {
            console.error("  Error fetching dishes:", dishError);
        } else {
            console.log(`  Total Dishes: ${dishes?.length || 0}`);
            const dishesWithEmbeddings = dishes?.filter(d => d.embedding).length || 0;
            console.log(`  Dishes with embeddings: ${dishesWithEmbeddings}`);

            if (dishesWithEmbeddings === 0) {
                console.warn("  WARNING: No dishes have embeddings! Search will likely fail.");
            }

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

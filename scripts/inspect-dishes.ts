
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
    console.log("Fetching one dish to inspect schema...");
    const { data: dishes, error } = await supabase
        .from("dishes")
        .select("*")
        .limit(1);

    if (error) {
        console.error("Error fetching dishes:", error);
        return;
    }

    if (dishes && dishes.length > 0) {
        console.log("Dish keys:", Object.keys(dishes[0]));
        console.log("Sample dish:", dishes[0]);
    } else {
        console.log("No dishes found in table.");
    }
}

check();

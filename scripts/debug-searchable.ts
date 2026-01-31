
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { parseUserIntent } from "../lib/intent-parser"; // We need to run this with tsx and access local lib

// Mock console.error to avoid noise if env vars missing in standard way (we load manually)
const originalError = console.error;
// console.error = (...args) => {};

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
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function check() {
    console.log("--- Checking Restaurant 'Sandhu' ---");
    const { data: restaurants, error } = await supabase
        .from("restaurants")
        .select("id, name, public_searchable")
        .ilike("name", "%sandhu%");

    if (restaurants && restaurants.length > 0) {
        console.log("Results:", restaurants);
    } else {
        console.log("No restaurant found or error:", error);
    }
}

// Minimal intent parser test (since importing nextjs logic in standalone script is hard,
// we might just skip the actual parser import if it has complex dependencies 
// and rely on the database check which is the main suspect).
// The parser relies on OpenAI which is configured in env.

check();

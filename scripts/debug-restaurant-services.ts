/**
 * Debug script to check restaurant service data
 * Run: npx tsx scripts/debug-restaurant-services.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";

// Load .env.local manually
const envFile = fs.readFileSync(".env.local", "utf-8");
for (const line of envFile.split("\n")) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
        process.env[match[1].trim()] = match[2].trim();
    }
}

async function debugRestaurantServices() {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    console.log("Checking restaurant service data...\n");

    const { data: restaurants, error } = await supabase
        .from("restaurants")
        .select("id, name, accepts_dine_in, accepts_takeaway, accepts_delivery, accepts_reservations, amenities, phone, email, website, opening_hours")
        .eq("public_searchable", true)
        .limit(5);

    if (error) {
        console.error("Error fetching restaurants:", error);
        return;
    }

    if (!restaurants || restaurants.length === 0) {
        console.log("No public restaurants found!");
        return;
    }

    console.log(`Found ${restaurants.length} public restaurants:\n`);

    for (const r of restaurants) {
        console.log(`📍 ${r.name}`);
        console.log(`   ID: ${r.id}`);
        console.log(`   Services:`);
        console.log(`     - Dine-in: ${r.accepts_dine_in ?? "NULL"}`);
        console.log(`     - Takeaway: ${r.accepts_takeaway ?? "NULL"}`);
        console.log(`     - Delivery: ${r.accepts_delivery ?? "NULL"}`);
        console.log(`     - Reservations: ${r.accepts_reservations ?? "NULL"}`);
        console.log(`   Amenities: ${JSON.stringify(r.amenities) || "NULL"}`);
        console.log(`   Phone: ${r.phone || "NULL"}`);
        console.log(`   Email: ${r.email || "NULL"}`);
        console.log(`   Website: ${r.website || "NULL"}`);
        console.log(`   Opening Hours: ${JSON.stringify(r.opening_hours) || "NULL"}`);
        console.log("");
    }
}

debugRestaurantServices().catch(console.error);

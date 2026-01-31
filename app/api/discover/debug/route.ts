import { NextRequest, NextResponse } from "next/server";
import { searchRestaurantsAndDishes } from "@/app/actions/discover";
import { parseUserIntent } from "@/lib/intent-parser";

/**
 * Debug endpoint to test search functionality
 * Usage: GET /api/discover/debug?q=butter+naan+in+gothenburg
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get("q") || "butter naan in gothenburg";

  try {
    // Parse intent from query
    const intent = await parseUserIntent(query);
    const results = await searchRestaurantsAndDishes(intent);
    
    return NextResponse.json({
      query,
      resultsCount: results.length,
      results: results.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city,
        cuisine_type: r.cuisine_type,
        highlight: r.highlight,
        address: r.address,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        query,
      },
      { status: 500 }
    );
  }
}

